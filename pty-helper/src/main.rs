use ghostterm_pty::{
    build_env, clamp_dimension, decode_resize_frame, parse_args, resolve_shell, HelperConfig,
};
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use portable_pty::{native_pty_system, CommandBuilder, ExitStatus, MasterPty, PtySize};
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

type DynError = Box<dyn std::error::Error + Send + Sync + 'static>;

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

    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut killer = child.clone_killer();
    let mut shutdown_killer = child.clone_killer();
    let process_group = pair.master.process_group_leader();
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let master = Arc::new(Mutex::new(pair.master));

    thread::spawn(move || {
        let _ = copy_chunks(reader, io::stdout());
    });

    thread::spawn(move || {
        let _ = copy_chunks(io::stdin(), writer);
    });

    spawn_resize_thread(Arc::clone(&master));

    let (wait_tx, wait_rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = wait_tx.send(child.wait());
    });

    let (signal_tx, signal_rx) = mpsc::channel();
    let mut signals = Signals::new([SIGHUP, SIGINT, SIGTERM])?;
    thread::spawn(move || {
        for signal in signals.forever() {
            if signal_tx.send(signal).is_err() {
                break;
            }
        }
    });

    loop {
        match wait_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(wait_result) => return normalize_wait_result(wait_result),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if let Ok(signal) = signal_rx.try_recv() {
            forward_signal(process_group, signal, &mut killer);
            drop(master);
            match wait_rx.recv_timeout(SHUTDOWN_GRACE_PERIOD) {
                Ok(wait_result) => return normalize_wait_result(wait_result),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = shutdown_killer.kill();
                    return normalize_wait_result(wait_rx.recv()?);
                }
            }
        }
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

fn spawn_resize_thread(master: Arc<Mutex<Box<dyn MasterPty + Send>>>) {
    thread::spawn(move || {
        let Some(mut resize_pipe) = resize_pipe_from_fd3() else {
            return;
        };

        let mut frame = [0_u8; 4];
        loop {
            if resize_pipe.read_exact(&mut frame).is_err() {
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

fn forward_signal(
    process_group: Option<i32>,
    signal: i32,
    killer: &mut Box<dyn portable_pty::ChildKiller + Send + Sync>,
) {
    if let (Some(process_group), Ok(signal)) = (
        process_group.filter(|pid| *pid > 0),
        Signal::try_from(signal),
    ) {
        if killpg(Pid::from_raw(process_group), signal).is_ok() {
            return;
        }
    }
    let _ = killer.kill();
}

fn normalize_wait_result(result: io::Result<ExitStatus>) -> Result<(), DynError> {
    match result {
        Ok(_) => Ok(()),
        Err(error) => Err(Box::new(error)),
    }
}
