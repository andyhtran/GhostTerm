use ghostterm_pty::{
    build_env, clamp_dimension, decode_resize_frame, parse_args, resolve_shell, HelperConfig,
};
use nix::sys::signal::{kill, killpg, Signal};
use nix::unistd::Pid;
use portable_pty::{
    native_pty_system, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize,
};
use signal_hook::consts::signal::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

const MAX_CHUNK_SIZE: usize = 32 * 1024;
const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_millis(750);
const TERMINATE_GRACE_PERIOD: Duration = Duration::from_millis(500);
const KILL_GRACE_PERIOD: Duration = Duration::from_millis(750);

type DynError = Box<dyn std::error::Error + Send + Sync + 'static>;

enum RuntimeEvent {
    ChildExit(io::Result<ExitStatus>),
    Signal(i32),
    StdinClosed,
    StdoutClosed,
    ResizeClosed,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("ghostterm-pty: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), DynError> {
    let config = parse_args(env::args().skip(1))?;
    let shell = resolve_shell(config.shell.as_deref()).ok_or("could not resolve shell")?;
    let pair = open_pty(&config)?;
    let command = build_command(&config, &shell);

    let (event_tx, event_rx) = mpsc::channel();
    spawn_signal_thread(event_tx.clone())?;

    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let child_process_id = child.process_id().and_then(|pid| i32::try_from(pid).ok());
    let initial_process_group = pair.master.process_group_leader();
    let shutdown_killer = child.clone_killer();
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let master = Arc::new(Mutex::new(pair.master));

    let stdout_tx = event_tx.clone();
    thread::spawn(move || {
        let _ = copy_chunks(reader, io::stdout());
        let _ = stdout_tx.send(RuntimeEvent::StdoutClosed);
    });

    let stdin_tx = event_tx.clone();
    thread::spawn(move || {
        let _ = copy_chunks(io::stdin(), writer);
        let _ = stdin_tx.send(RuntimeEvent::StdinClosed);
    });

    spawn_resize_thread(Arc::clone(&master), event_tx.clone());

    let wait_tx = event_tx.clone();
    thread::spawn(move || {
        let _ = wait_tx.send(RuntimeEvent::ChildExit(child.wait()));
    });

    match event_rx.recv() {
        Ok(RuntimeEvent::ChildExit(wait_result)) => normalize_wait_result(wait_result),
        Ok(event) => shutdown_child(
            event,
            Arc::clone(&master),
            shutdown_killer,
            initial_process_group,
            child_process_id,
            event_rx,
        ),
        Err(_) => Ok(()),
    }
}

fn open_pty(config: &HelperConfig) -> Result<portable_pty::PtyPair, DynError> {
    let pty_system = native_pty_system();
    Ok(pty_system.openpty(PtySize {
        rows: clamp_dimension(config.rows),
        cols: clamp_dimension(config.cols),
        pixel_width: 0,
        pixel_height: 0,
    })?)
}

fn build_command(config: &HelperConfig, shell: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new_default_prog();
    if let Some(cwd) = &config.cwd {
        command.cwd(cwd);
    }
    for (key, value) in build_env(env::vars(), config.cols, config.rows) {
        command.env(key, value);
    }
    command.env("SHELL", shell);
    command
}

fn spawn_signal_thread(event_tx: mpsc::Sender<RuntimeEvent>) -> Result<(), DynError> {
    let mut signals = Signals::new([SIGHUP, SIGINT, SIGTERM])?;
    thread::spawn(move || {
        for signal in signals.forever() {
            if event_tx.send(RuntimeEvent::Signal(signal)).is_err() {
                break;
            }
        }
    });
    Ok(())
}

fn copy_chunks(mut reader: impl Read, mut writer: impl Write) -> io::Result<u64> {
    let mut buffer = [0_u8; MAX_CHUNK_SIZE];
    let mut copied = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(copied);
        }
        writer.write_all(&buffer[..read])?;
        writer.flush()?;
        copied += read as u64;
    }
}

fn spawn_resize_thread(
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    event_tx: mpsc::Sender<RuntimeEvent>,
) {
    thread::spawn(move || {
        let Some(mut resize_pipe) = resize_pipe_from_fd3() else {
            return;
        };

        let mut frame = [0_u8; 4];
        loop {
            if resize_pipe.read_exact(&mut frame).is_err() {
                let _ = event_tx.send(RuntimeEvent::ResizeClosed);
                return;
            }
            let Some((rows, cols)) = decode_resize_frame(&frame) else {
                continue;
            };
            let size = PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            };
            if let Ok(master) = master.lock() {
                let _ = master.resize(size);
            }
        }
    });
}

fn resize_pipe_from_fd3() -> Option<File> {
    File::open("/dev/fd/3").ok()
}

fn shutdown_child(
    event: RuntimeEvent,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    mut killer: Box<dyn ChildKiller + Send + Sync>,
    initial_process_group: Option<i32>,
    child_process_id: Option<i32>,
    event_rx: mpsc::Receiver<RuntimeEvent>,
) -> Result<(), DynError> {
    let first_signal = shutdown_signal(event);
    signal_child(
        &master,
        initial_process_group,
        child_process_id,
        first_signal,
        &mut killer,
    );
    if let Some(result) = wait_for_child_event(&event_rx, SHUTDOWN_GRACE_PERIOD) {
        return result;
    }

    if first_signal != Signal::SIGTERM {
        signal_child(
            &master,
            initial_process_group,
            child_process_id,
            Signal::SIGTERM,
            &mut killer,
        );
        if let Some(result) = wait_for_child_event(&event_rx, TERMINATE_GRACE_PERIOD) {
            return result;
        }
    }

    signal_child(
        &master,
        initial_process_group,
        child_process_id,
        Signal::SIGKILL,
        &mut killer,
    );
    drop(master);
    let _ = killer.kill();
    if let Some(result) = wait_for_child_event(&event_rx, KILL_GRACE_PERIOD) {
        return result;
    }

    Err("child process did not exit after shutdown escalation".into())
}

fn shutdown_signal(event: RuntimeEvent) -> Signal {
    match event {
        RuntimeEvent::Signal(signal) => Signal::try_from(signal).unwrap_or(Signal::SIGTERM),
        RuntimeEvent::StdinClosed | RuntimeEvent::StdoutClosed | RuntimeEvent::ResizeClosed => {
            Signal::SIGHUP
        }
        RuntimeEvent::ChildExit(_) => Signal::SIGTERM,
    }
}

fn wait_for_child_event(
    event_rx: &mpsc::Receiver<RuntimeEvent>,
    timeout: Duration,
) -> Option<Result<(), DynError>> {
    loop {
        match event_rx.recv_timeout(timeout) {
            Ok(RuntimeEvent::ChildExit(wait_result)) => {
                return Some(normalize_wait_result(wait_result))
            }
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Some(Ok(())),
            Err(mpsc::RecvTimeoutError::Timeout) => return None,
        }
    }
}

fn signal_child(
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
    initial_process_group: Option<i32>,
    child_process_id: Option<i32>,
    signal: Signal,
    killer: &mut Box<dyn ChildKiller + Send + Sync>,
) {
    let mut delivered = false;
    for process_group in process_groups(master, initial_process_group, child_process_id) {
        if killpg(Pid::from_raw(process_group), signal).is_ok() {
            delivered = true;
        }
    }

    if let Some(pid) = child_process_id {
        if kill(Pid::from_raw(pid), signal).is_ok() {
            delivered = true;
        }
    }

    if !delivered {
        let _ = killer.kill();
    }
}

fn process_groups(
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
    initial_process_group: Option<i32>,
    child_process_id: Option<i32>,
) -> Vec<i32> {
    let mut groups = Vec::new();
    if let Ok(master) = master.lock() {
        push_pid(&mut groups, master.process_group_leader());
    }
    push_pid(&mut groups, initial_process_group);
    push_pid(&mut groups, child_process_id);
    groups
}

fn push_pid(values: &mut Vec<i32>, pid: Option<i32>) {
    let Some(pid) = pid.filter(|pid| *pid > 0) else {
        return;
    };
    if !values.contains(&pid) {
        values.push(pid);
    }
}

fn normalize_wait_result(result: io::Result<ExitStatus>) -> Result<(), DynError> {
    match result {
        Ok(_) => Ok(()),
        Err(error) => Err(Box::new(error)),
    }
}
