import type { App } from "obsidian";
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { FitAddon, Terminal } from "ghostty-web";
import { buildGhostTermEnv } from "./environment";
import {
	CWD_POLL_INTERVAL_MS,
	DEFAULT_COLS,
	DEFAULT_ROWS,
	DISPLAY_NAME,
	MAX_INPUT_CHUNK_BYTES,
	MAX_INPUT_QUEUE_BYTES,
	STATUS_PREFIX
} from "./constants";
import type { GhosttyThemeColors } from "./ghostty-config";
import { ensureGhosttyWeb } from "./ghostty-runtime";
import { ensureBundledHelper } from "./helper-installer";
import { nextId } from "./ids";
import { Osc8LinkProvider, Osc8LinkRegistry } from "./osc8-hyperlinks";
import type { GhostTermPluginHost } from "./plugin-host";
import { currentPlatformSupport } from "./platform-support";
import { currentCwdForChildProcess } from "./process-cwd";
import { OutputMetadataParser } from "./output-metadata";
import { getVaultBasePath, isUsableDirectory } from "./vault";

export type LifecycleState = "starting" | "running" | "exited" | "restarting" | "closing" | "closed";
type TitleSource = "cwd" | "osc";

export class TerminalSurface {
	readonly id = nextId("surface");
	readonly containerEl: HTMLElement;
	readonly terminalHostEl: HTMLElement;
	private readonly exitOverlayEl: HTMLElement;
	private readonly exitMessageEl: HTMLElement;
	private currentCwd: string;
	private lifecycleStateValue: LifecycleState = "starting";
	private fallbackTitle: string;
	private titleValue: string;
	private titleSource: TitleSource = "cwd";
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ptyProcess: ChildProcess | null = null;
	private resizePipe: NodeJS.WritableStream | null = null;
	private titleSubscription: { dispose(): void } | null = null;
	private outputMetadataDecoder = new TextDecoder();
	private outputMetadataParser = new OutputMetadataParser();
	private osc8Links = new Osc8LinkRegistry();
	private cwdPollTimer: number | null = null;
	private cwdRefreshPromise: Promise<string> | null = null;
	private shellProcessId: number | null = null;
	private restartTimer: number | null = null;
	private inputQueue: Buffer[] = [];
	private inputQueueBytes = 0;
	private inputDrainRegistered = false;
	private spawnSequence = 0;

	constructor(
		private readonly app: App,
		private readonly plugin: GhostTermPluginHost,
		cwd: string | undefined,
		private readonly onFocus: (surfaceId: string) => void,
		private readonly onStatus: (status: string) => void,
		private readonly onTitleChange: (surfaceId: string) => void
	) {
		this.currentCwd = this.resolveCwd(cwd);
		this.fallbackTitle = defaultTitleForCwd(this.currentCwd);
		this.titleValue = this.fallbackTitle;
		this.containerEl = createDiv({
			cls: "ghostterm-surface",
			attr: {
				"aria-label": this.accessibilityLabel(),
				tabindex: "0"
			}
		});
		this.terminalHostEl = this.containerEl.createDiv({
			cls: "ghostterm-terminal-host",
			attr: {
				"aria-label": `${DISPLAY_NAME} terminal surface`
			}
		});
		this.exitOverlayEl = this.containerEl.createDiv({
			cls: "ghostterm-exit-overlay ghostterm-hidden",
			attr: {
				"aria-label": `${DISPLAY_NAME} exited terminal controls`
			}
		});
		this.exitMessageEl = this.exitOverlayEl.createDiv({
			cls: "ghostterm-exit-message",
			text: "Shell exited."
		});
		const restartButton = this.exitOverlayEl.createEl("button", {
			cls: "ghostterm-restart-button",
			text: "Restart",
			attr: {
				"aria-label": `${DISPLAY_NAME} restart terminal surface`
			}
		});
		restartButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.restart();
		});
		this.containerEl.addEventListener("focusin", () => this.onFocus(this.id));
	}

	async start(): Promise<void> {
		this.setLifecycle("starting");
		await ensureGhosttyWeb();

		const options = this.terminalOptions();
		this.terminalHostEl.style.fontVariantLigatures = options.ligatures ? "normal" : "none";
		this.terminal = new Terminal({
			cols: DEFAULT_COLS,
			rows: DEFAULT_ROWS,
			cursorBlink: options.cursorBlink,
			cursorStyle: options.cursorStyle,
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			scrollback: options.scrollback,
			theme: options.theme
		});
		this.fitAddon = new FitAddon();
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.open(this.terminalHostEl);
		this.terminal.registerLinkProvider(new Osc8LinkProvider(this.terminal, this.osc8Links));
		this.terminal.onData((data) => this.writeInput(data));
		this.titleSubscription = this.terminal.onTitleChange((title) => this.setTitle(title));
		this.terminal.onResize(({ cols, rows }) => this.sendResize(rows, cols));
		this.fitAddon.fit();
		this.fitAddon.observeResize();

		await this.spawnPty();
		window.requestAnimationFrame(() => this.fitAddon?.fit());
	}

	async restart(): Promise<void> {
		this.clearRestartTimer();
		this.setLifecycle("restarting");
		this.disposePty();
		this.terminal?.reset();
		await this.spawnPty();
		this.focus();
	}

	dispose(): void {
		this.clearRestartTimer();
		this.setLifecycle("closing");
		this.disposePty();
		this.titleSubscription?.dispose();
		this.titleSubscription = null;
		this.fitAddon?.dispose();
		this.terminal?.dispose();
		this.containerEl.detach();
		this.setLifecycle("closed");
	}

	focus(): void {
		this.containerEl.focus();
		this.terminal?.focus();
	}

	get title(): string {
		return this.titleValue;
	}

	get cwd(): string {
		return this.currentCwd;
	}

	get lifecycleState(): LifecycleState {
		return this.lifecycleStateValue;
	}

	getSelection(): string {
		return this.terminal?.getSelection() ?? "";
	}

	paste(text: string): void {
		this.terminal?.paste(text);
	}

	writeInput(text: string): void {
		if (!text) {
			return;
		}
		this.enqueueInput(Buffer.from(text, "utf8"));
	}

	applySettingsChanged(): void {
		const options = this.terminalOptions();
		this.terminalHostEl.style.fontVariantLigatures = options.ligatures ? "normal" : "none";
		if (this.terminal) {
			this.terminal.options.fontFamily = options.fontFamily;
			this.terminal.options.fontSize = options.fontSize;
			this.terminal.options.cursorBlink = options.cursorBlink;
			this.terminal.options.cursorStyle = options.cursorStyle;
		}
		this.fit();
	}

	fit(): void {
		this.fitAddon?.fit();
	}

	async refreshCurrentCwd(): Promise<string> {
		if (this.cwdRefreshPromise) {
			return this.cwdRefreshPromise;
		}
		this.cwdRefreshPromise = this.resolveCurrentCwd().finally(() => {
			this.cwdRefreshPromise = null;
		});
		return this.cwdRefreshPromise;
	}

	setFocused(isFocused: boolean): void {
		this.containerEl.dataset.focused = String(isFocused);
		this.containerEl.setAttr("aria-label", this.accessibilityLabel(isFocused));
	}

	containsActiveElement(): boolean {
		const active = document.activeElement;
		return !!active && this.containerEl.contains(active);
	}

	containsKeyboardTarget(event: KeyboardEvent): boolean {
		const target = event.target;
		return this.containsActiveElement() || target instanceof Node && this.containerEl.contains(target);
	}

	private async spawnPty(): Promise<void> {
		const spawnId = ++this.spawnSequence;
		const platformSupport = currentPlatformSupport();
		if (!platformSupport.supported) {
			this.setLifecycle("exited");
			const reason = platformSupport.reason ?? "GhostTerm is not supported on this platform.";
			const message = `${STATUS_PREFIX}: ${reason}`;
			this.onStatus(message);
			this.terminal?.writeln(`\r\n${message}\r\n`);
			this.showExitOverlay(reason);
			return;
		}

		const helperPath = this.helperPath();
		this.outputMetadataDecoder = new TextDecoder();
		this.outputMetadataParser = new OutputMetadataParser();
		this.osc8Links.clear();
		this.shellProcessId = null;
		this.inputQueue = [];
		this.inputQueueBytes = 0;
		this.inputDrainRegistered = false;
		try {
			await ensureBundledHelper(helperPath);
		} catch (error) {
			this.setLifecycle("exited");
			const message = `${STATUS_PREFIX}: failed to prepare helper ${error instanceof Error ? error.message : String(error)}`;
			this.onStatus(message);
			this.terminal?.writeln(`\r\n${message}\r\n`);
			this.showExitOverlay("Failed to prepare terminal helper. Restart after fixing the error.");
			return;
		}
		if (!isUsableDirectory(this.currentCwd)) {
			this.setLifecycle("exited");
			const message = `${STATUS_PREFIX}: cwd unavailable ${this.currentCwd}`;
			this.onStatus(message);
			this.terminal?.writeln(`\r\n${message}\r\n`);
			this.showExitOverlay("Working directory is unavailable. Restart after choosing a valid cwd.");
			return;
		}

		const cols = this.terminal?.cols ?? DEFAULT_COLS;
		const rows = this.terminal?.rows ?? DEFAULT_ROWS;
		const shell = this.effectiveShell();
		const args = [
			"-cwd", this.currentCwd,
			"-cols", String(cols),
			"-rows", String(rows)
		];
		if (shell) {
			args.push("-shell", shell);
		}
		let env: NodeJS.ProcessEnv;
		try {
			env = await buildGhostTermEnv({
				base: process.env,
				cols,
				rows,
				shell,
				termProgramVersion: this.plugin.manifest.version
			});
		} catch (error) {
			this.setLifecycle("exited");
			const message = `${STATUS_PREFIX}: failed to prepare environment ${error instanceof Error ? error.message : String(error)}`;
			this.onStatus(message);
			this.terminal?.writeln(`\r\n${message}\r\n`);
			this.showExitOverlay("Failed to prepare terminal environment. Restart after fixing the error.");
			return;
		}
		if (spawnId !== this.spawnSequence || this.lifecycleStateValue === "closing" || this.lifecycleStateValue === "closed") {
			return;
		}
		try {
			this.ptyProcess = spawn(helperPath, args, {
				cwd: this.currentCwd,
				env,
				stdio: ["pipe", "pipe", "pipe", "pipe"]
			});
		} catch (error) {
			this.setLifecycle("exited");
			const message = `${STATUS_PREFIX}: failed to spawn helper ${error instanceof Error ? error.message : String(error)}`;
			this.onStatus(message);
			this.terminal?.writeln(`\r\n${message}\r\n`);
			this.showExitOverlay("Failed to start helper. Restart after fixing the error.");
			return;
		}
		const ptyProcess = this.ptyProcess;
		this.resizePipe = ptyProcess.stdio[3] as NodeJS.WritableStream | null;

		ptyProcess.stdout?.on("data", (chunk: Buffer) => {
			const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			this.captureOutputMetadata(this.outputMetadataDecoder.decode(bytes, { stream: true }));
			this.terminal?.write(bytes, () => {
				this.terminal?.scrollToBottom();
			});
		});
		ptyProcess.stderr?.on("data", (chunk: Buffer) => {
			const message = chunk.toString("utf8").trim();
			if (message) {
				this.onStatus(`${STATUS_PREFIX}: ${message}`);
			}
		});
		ptyProcess.on("error", (error) => {
			if (this.ptyProcess !== ptyProcess || this.lifecycleStateValue === "closing" || this.lifecycleStateValue === "closed") {
				return;
			}
			this.ptyProcess = null;
			this.resizePipe = null;
			this.setLifecycle("exited");
			this.onStatus(`${STATUS_PREFIX}: helper error ${error.message}`);
			this.terminal?.writeln(`\r\n\x1b[31m[PTY error: ${error.message}]\x1b[0m\r\n`);
			this.showExitOverlay("PTY helper error. Restart this surface after fixing the error.");
		});
		ptyProcess.on("exit", (code, signal) => {
			if (this.ptyProcess !== ptyProcess || this.lifecycleStateValue === "closing" || this.lifecycleStateValue === "closed") {
				return;
			}
			this.captureOutputMetadata(this.outputMetadataDecoder.decode());
			this.stopCwdPolling();
			this.inputQueue = [];
			this.inputQueueBytes = 0;
			this.ptyProcess = null;
			this.resizePipe = null;
			this.setLifecycle("exited");
			const exitText = `surface exited code=${code ?? "none"} signal=${signal ?? "none"}`;
			this.onStatus(`${STATUS_PREFIX}: ${exitText}`);
			this.terminal?.writeln(`\r\n\x1b[31m[${exitText}]\x1b[0m\r\n`);
			this.handleExitedSurface(exitText);
		});
		this.setLifecycle("running");
		this.onStatus(`${STATUS_PREFIX}: running ${this.title} at ${this.currentCwd}`);
		this.sendResize(rows, cols);
		this.startCwdPolling();
	}

	private disposePty(): void {
		this.spawnSequence++;
		const proc = this.ptyProcess;
		this.stopCwdPolling();
		this.captureOutputMetadata(this.outputMetadataDecoder.decode());
		this.outputMetadataParser.flush();
		this.inputQueue = [];
		this.inputQueueBytes = 0;
		this.inputDrainRegistered = false;
		destroyStream(this.resizePipe);
		this.resizePipe = null;
		if (proc) {
			destroyStream(proc.stdin);
			destroyStream(proc.stdout);
			destroyStream(proc.stderr);
			try {
				proc.kill("SIGTERM");
			} catch {
				// Process may already be gone.
			}
			const pid = proc.pid;
			if (pid) {
				const killTimer = window.setTimeout(() => {
					try {
						process.kill(pid, 0);
						process.kill(pid, "SIGKILL");
					} catch {
						// Process already exited.
					}
				}, 500);
				proc.once("exit", () => window.clearTimeout(killTimer));
			}
		}
		this.ptyProcess = null;
	}

	private sendResize(rows: number, cols: number): void {
		if (!this.resizePipe?.writable) {
			return;
		}
		const frame = Buffer.alloc(4);
		frame.writeUInt16BE(Math.max(2, Math.min(1000, rows)), 0);
		frame.writeUInt16BE(Math.max(2, Math.min(1000, cols)), 2);
		this.resizePipe.write(frame);
		this.containerEl.setAttr("aria-label", this.accessibilityLabel());
	}

	private terminalOptions(): {
		cursorBlink: boolean;
		cursorStyle: "block" | "underline" | "bar";
		fontFamily: string;
		fontSize: number;
		ligatures: boolean;
		scrollback: number;
		theme: GhosttyThemeColors;
	} {
		const settings = this.plugin.settings;
		const config = this.plugin.ghosttyConfig;
		return {
			cursorBlink: config.cursorBlink ?? false,
			cursorStyle: config.cursorStyle ?? "block",
			fontFamily: settings.fontFamilyOverride || config.fontFamily || "'JetBrains Mono', 'SF Mono', Menlo, Monaco, monospace",
			fontSize: settings.fontSizeOverride > 0 ? settings.fontSizeOverride : config.fontSize ?? 13,
			ligatures: settings.ligatures && config.ligatures !== false,
			scrollback: config.scrollback ?? settings.scrollbackLines,
			theme: terminalTheme(config.colors)
		};
	}

	private effectiveShell(): string | null {
		return this.plugin.settings.defaultShell || this.plugin.ghosttyConfig.shell || null;
	}

	private enqueueInput(buffer: Buffer): void {
		if (!this.ptyProcess?.stdin?.writable || this.lifecycleStateValue !== "running") {
			return;
		}
		if (this.inputQueueBytes + buffer.byteLength > MAX_INPUT_QUEUE_BYTES) {
			this.onStatus(`${STATUS_PREFIX}: dropped oversized terminal input`);
			return;
		}
		for (let offset = 0; offset < buffer.byteLength; offset += MAX_INPUT_CHUNK_BYTES) {
			const chunk = buffer.subarray(offset, Math.min(offset + MAX_INPUT_CHUNK_BYTES, buffer.byteLength));
			this.inputQueue.push(chunk);
			this.inputQueueBytes += chunk.byteLength;
		}
		this.drainInputQueue();
	}

	private drainInputQueue(): void {
		const stdin = this.ptyProcess?.stdin;
		if (!stdin?.writable) {
			return;
		}
		this.inputDrainRegistered = false;
		while (this.inputQueue.length > 0) {
			const chunk = this.inputQueue[0];
			const accepted = stdin.write(chunk);
			this.inputQueue.shift();
			this.inputQueueBytes -= chunk.byteLength;
			if (!accepted) {
				if (!this.inputDrainRegistered) {
					this.inputDrainRegistered = true;
					stdin.once("drain", () => this.drainInputQueue());
				}
				return;
			}
		}
	}

	private handleExitedSurface(exitText: string): void {
		if (this.plugin.settings.restartAfterExitBehavior === "automatic") {
			this.showExitOverlay(`${exitText}. Restarting...`);
			this.restartTimer = window.setTimeout(() => {
				this.restartTimer = null;
				void this.restart();
			}, 400);
			return;
		}
		this.showExitOverlay(`${exitText}.`);
	}

	private showExitOverlay(message: string): void {
		this.exitMessageEl.setText(message);
		this.exitOverlayEl.removeClass("ghostterm-hidden");
		this.containerEl.addClass("ghostterm-surface-exited");
	}

	private hideExitOverlay(): void {
		this.exitOverlayEl.addClass("ghostterm-hidden");
		this.containerEl.removeClass("ghostterm-surface-exited");
	}

	private clearRestartTimer(): void {
		if (!this.restartTimer) {
			return;
		}
		window.clearTimeout(this.restartTimer);
		this.restartTimer = null;
	}

	private setLifecycle(state: LifecycleState): void {
		this.lifecycleStateValue = state;
		if (state === "starting" || state === "running" || state === "restarting") {
			this.hideExitOverlay();
		}
		this.containerEl.setAttr("aria-label", this.accessibilityLabel());
	}

	private setTitle(title: string, source: TitleSource = "osc"): void {
		const nextTitle = cleanTerminalTitle(title, this.fallbackTitle);
		this.titleSource = source;
		if (nextTitle === this.titleValue) {
			return;
		}
		this.titleValue = nextTitle;
		this.containerEl.setAttr("aria-label", this.accessibilityLabel());
		this.onTitleChange(this.id);
	}

	private async resolveCurrentCwd(): Promise<string> {
		const processCwd = await currentCwdForChildProcess(this.ptyProcess?.pid, this.shellProcessId);
		if (processCwd) {
			this.shellProcessId = processCwd.pid;
			this.setCurrentCwd(processCwd.cwd);
		}
		return this.currentCwd;
	}

	private captureOutputMetadata(output: string): void {
		for (const event of this.outputMetadataParser.feed(output)) {
			if (event.type === "cwd") {
				const cwd = cwdFromOsc7(event.payload);
				if (cwd) {
					this.setCurrentCwd(cwd);
				}
			} else if (event.type === "title") {
				this.setTitle(event.title, "osc");
			} else if (event.type === "osc8") {
				this.osc8Links.addLink(event.uri, event.text);
			}
		}
	}

	private setCurrentCwd(cwd: string): void {
		if (cwd === this.currentCwd) {
			return;
		}
		this.currentCwd = cwd;
		this.fallbackTitle = defaultTitleForCwd(cwd);
		if (this.titleSource === "cwd") {
			this.setTitle(this.fallbackTitle, "cwd");
		}
		this.containerEl.setAttr("aria-label", this.accessibilityLabel());
		this.onTitleChange(this.id);
	}

	private startCwdPolling(): void {
		if (this.cwdPollTimer) {
			return;
		}
		this.cwdPollTimer = window.setInterval(() => {
			void this.refreshCurrentCwd();
		}, CWD_POLL_INTERVAL_MS);
	}

	private stopCwdPolling(): void {
		if (!this.cwdPollTimer) {
			return;
		}
		window.clearInterval(this.cwdPollTimer);
		this.cwdPollTimer = null;
	}

	private accessibilityLabel(focused = this.containerEl?.dataset.focused === "true"): string {
		const cols = this.terminal?.cols ?? DEFAULT_COLS;
		const rows = this.terminal?.rows ?? DEFAULT_ROWS;
		return `${DISPLAY_NAME} terminal surface ${this.title} cwd ${this.currentCwd} ${this.lifecycleStateValue} ${focused ? "focused" : "unfocused"} ${cols} columns ${rows} rows`;
	}

	private resolveCwd(cwd: string | undefined): string {
		const basePath = getVaultBasePath(this.app);
		if (!cwd) {
			return basePath;
		}
		if (cwd.startsWith("/")) {
			return cwd;
		}
		return join(basePath, cwd);
	}

	private helperPath(): string {
		const basePath = getVaultBasePath(this.app);
		const pluginDir = this.plugin.manifest.dir ?? join(this.app.vault.configDir, "plugins", this.plugin.manifest.id);
		return join(basePath, pluginDir, "bin", "ghostterm-pty");
	}
}

function defaultTitleForCwd(cwd: string): string {
	return cwd.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? DISPLAY_NAME;
}

function cleanTerminalTitle(title: string, fallback: string): string {
	const cleaned = title
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || fallback;
}

function cwdFromOsc7(payload: string): string | null {
	try {
		const url = new URL(payload);
		if (url.protocol !== "file:") {
			return null;
		}
		const cwd = decodeURIComponent(url.pathname);
		return isUsableDirectory(cwd) ? cwd : null;
	} catch {
		return null;
	}
}

function terminalTheme(colors: GhosttyThemeColors): GhosttyThemeColors {
	return {
		background: colors.background ?? "#282c34",
		foreground: colors.foreground ?? "#abb2bf",
		cursor: colors.cursor ?? "#abb2bf",
		cursorText: colors.cursorText,
		selectionBackground: colors.selectionBackground ?? "#3e4451",
		selectionForeground: colors.selectionForeground,
		black: colors.black ?? "#1e222a",
		red: colors.red ?? "#e06c75",
		green: colors.green ?? "#98c379",
		yellow: colors.yellow ?? "#e5c07b",
		blue: colors.blue ?? "#61afef",
		magenta: colors.magenta ?? "#c678dd",
		cyan: colors.cyan ?? "#56b6c2",
		white: colors.white ?? "#abb2bf",
		brightBlack: colors.brightBlack ?? "#5c6370",
		brightRed: colors.brightRed ?? "#e06c75",
		brightGreen: colors.brightGreen ?? "#98c379",
		brightYellow: colors.brightYellow ?? "#e5c07b",
		brightBlue: colors.brightBlue ?? "#61afef",
		brightMagenta: colors.brightMagenta ?? "#c678dd",
		brightCyan: colors.brightCyan ?? "#56b6c2",
		brightWhite: colors.brightWhite ?? "#ffffff"
	};
}

function destroyStream(stream: unknown): void {
	const maybeStream = stream as { destroy?: () => void; end?: () => void } | null | undefined;
	try {
		if (typeof maybeStream?.destroy === "function") {
			maybeStream.destroy();
			return;
		}
		maybeStream?.end?.();
	} catch {
		// Best-effort cleanup.
	}
}
