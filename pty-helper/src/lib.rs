use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;
pub const MIN_DIMENSION: u16 = 2;
pub const MAX_DIMENSION: u16 = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperConfig {
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

impl Default for HelperConfig {
    fn default() -> Self {
        Self {
            cwd: None,
            shell: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        }
    }
}

pub fn parse_args<I, S>(args: I) -> Result<HelperConfig, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut config = HelperConfig::default();
    let mut args = args.into_iter().map(Into::into);
    while let Some(arg) = args.next() {
        let value = match arg.as_str() {
            "-cwd" => args.next().ok_or("missing value for -cwd")?,
            "-shell" => args.next().ok_or("missing value for -shell")?,
            "-cols" => args.next().ok_or("missing value for -cols")?,
            "-rows" => args.next().ok_or("missing value for -rows")?,
            _ => return Err(format!("unknown argument {arg}")),
        };

        match arg.as_str() {
            "-cwd" => config.cwd = Some(value),
            "-shell" => config.shell = Some(value),
            "-cols" => config.cols = parse_dimension(&value, "-cols")?,
            "-rows" => config.rows = parse_dimension(&value, "-rows")?,
            _ => unreachable!(),
        }
    }
    Ok(config)
}

fn parse_dimension(value: &str, name: &str) -> Result<u16, String> {
    let parsed = value
        .parse::<u16>()
        .map_err(|_| format!("invalid value for {name}: {value}"))?;
    Ok(parsed)
}

pub fn clamp_dimension(value: u16) -> u16 {
    value.clamp(MIN_DIMENSION, MAX_DIMENSION)
}

pub fn resolve_shell(override_shell: Option<&str>) -> Option<String> {
    let shell_env = env::var("SHELL").ok();
    let candidates = [
        override_shell.unwrap_or(""),
        shell_env.as_deref().unwrap_or(""),
        "/bin/zsh",
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/sh",
    ];

    candidates
        .iter()
        .copied()
        .filter(|candidate| !candidate.trim().is_empty())
        .find(|candidate| is_executable_file(candidate))
        .map(ToOwned::to_owned)
}

fn is_executable_file(path: &str) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

pub fn build_env(
    base: impl IntoIterator<Item = (String, String)>,
    cols: u16,
    rows: u16,
) -> Vec<(String, String)> {
    let mut env: BTreeMap<String, String> = base.into_iter().collect();

    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLUMNS".to_string(), clamp_dimension(cols).to_string());
    env.insert("LINES".to_string(), clamp_dimension(rows).to_string());
    default_if_missing(&mut env, "COLORTERM", "truecolor");
    default_if_missing(&mut env, "TERM_PROGRAM", "obsidian-ghostterm");
    if !has_utf8_locale(&env) {
        env.insert("LANG".to_string(), "en_US.UTF-8".to_string());
        env.insert("LC_CTYPE".to_string(), "en_US.UTF-8".to_string());
    }

    env.into_iter().collect()
}

fn default_if_missing(env: &mut BTreeMap<String, String>, key: &str, value: &str) {
    if env
        .get(key)
        .map(|existing| existing.trim().is_empty())
        .unwrap_or(true)
    {
        env.insert(key.to_string(), value.to_string());
    }
}

fn has_utf8_locale(env: &BTreeMap<String, String>) -> bool {
    ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|key| {
        env.get(*key)
            .map(|value| {
                let upper = value.trim().to_ascii_uppercase();
                upper.contains("UTF-8") || upper.contains("UTF8")
            })
            .unwrap_or(false)
    })
}

pub fn decode_resize_frame(frame: &[u8]) -> Option<(u16, u16)> {
    if frame.len() != 4 {
        return None;
    }
    let rows = u16::from_be_bytes([frame[0], frame[1]]);
    let cols = u16::from_be_bytes([frame[2], frame[3]]);
    if rows < MIN_DIMENSION || cols < MIN_DIMENSION {
        return None;
    }
    Some((rows, cols))
}

pub fn shell_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

