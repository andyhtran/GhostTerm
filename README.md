# GhostTerm

An Obsidian desktop plugin for Ghostty-style terminal surfaces inside your workspace. Open a shell in the right sidebar or main area, create terminal tabs and splits, and keep terminal context close to your notes.

![Obsidian 1.8+](https://img.shields.io/badge/Obsidian-1.8%2B-7c3aed)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9%2B-blue)
![Rust](https://img.shields.io/badge/Rust-PTY%20helper-orange)

[Getting Started](#getting-started) · [Features](#features) · [Requirements](#requirements) · [Build](#build-commands) · [Limitations](#limitations)

## Getting Started

BRAT install:

1. In BRAT, add `andyhtran/GhostTerm`.
2. Enable GhostTerm in Obsidian's community plugin settings.

Manual install:

1. Build GhostTerm:

   ```bash
   npm install
   npm run build
   ```

2. Copy these files into `<vault>/.obsidian/plugins/ghostterm/`:

   ```text
   manifest.json
   styles.css
   dist/main.js -> main.js
   ```

3. Enable GhostTerm in Obsidian's community plugin settings.

## Features

- **Terminal surface in Obsidian** — open a Ghostty-style terminal in the sidebar or main workspace
- **Tabs and splits** — create terminal tabs, split right, split down, close focused surfaces, and restart exited shells
- **Focused shortcut routing** — terminal shortcuts are intercepted only while a GhostTerm terminal surface is focused
- **Ghostty config subset** — reads font, color, cursor, scrollback, shell, and basic keybind settings from Ghostty config files
- **Working-directory context** — open a terminal from the file explorer and start in the selected folder or file parent
- **Shell environment repair** — prepares a terminal-like `PATH`, locale, `TERM`, dimensions, and shell environment for GUI-launched Obsidian
- **OSC metadata support** — tracks terminal title, current working directory, and OSC 8 hyperlinks

## Requirements

- Obsidian desktop 1.8+
- macOS on Apple Silicon
- Node.js and npm for building the plugin
- Rust toolchain for building the PTY helper
- A local shell available on the system

## Security and Privacy

GhostTerm starts a local shell through a bundled helper binary. Commands run with the same permissions as Obsidian and can read, write, create, delete, or execute files that your user account can access.

Use GhostTerm only in vaults and workspaces where running a local terminal is appropriate. Treat terminal output and shell commands with the same care you would in a standalone terminal application.

GhostTerm does not collect telemetry. The plugin does not require network access at runtime.

## Build Commands

```bash
npm install
npm run check
npm run build
```

The helper is built from `pty-helper/` and embedded into `dist/main.js` during `npm run build`.

## Components

GhostTerm includes TypeScript plugin code and a Rust PTY helper. The plugin writes the helper into the installed plugin directory when a terminal starts. JavaScript dependencies are declared in `package-lock.json`; Rust dependencies are declared in `pty-helper/Cargo.lock`.

## Limitations

- macOS Apple Silicon is the supported platform.
- GhostTerm is not listed in Obsidian's community plugin directory yet.
- Ghostty config support covers font, color, cursor, scrollback, shell, and basic keybind settings.
- The plugin is desktop-only because it starts local processes.

## License

[MIT](LICENSE)
