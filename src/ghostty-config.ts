import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type GhosttyCursorStyle = "block" | "bar" | "underline";
export type GhosttyModifier = "super" | "ctrl" | "shift" | "alt";

export interface GhosttyThemeColors {
	background?: string;
	foreground?: string;
	cursor?: string;
	cursorText?: string;
	selectionBackground?: string;
	selectionForeground?: string;
	black?: string;
	red?: string;
	green?: string;
	yellow?: string;
	blue?: string;
	magenta?: string;
	cyan?: string;
	white?: string;
	brightBlack?: string;
	brightRed?: string;
	brightGreen?: string;
	brightYellow?: string;
	brightBlue?: string;
	brightMagenta?: string;
	brightCyan?: string;
	brightWhite?: string;
}

export interface GhosttyKeybind {
	mods: Set<GhosttyModifier>;
	key: string;
	action: string;
}

export interface GhosttyConfig {
	colors: GhosttyThemeColors;
	keybinds: GhosttyKeybind[];
	fontFamily?: string;
	fontSize?: number;
	cursorStyle?: GhosttyCursorStyle;
	cursorBlink?: boolean;
	scrollback?: number;
	shell?: string;
	ligatures?: boolean;
	path?: string;
}

export interface ObsidianShortcut {
	modifiers: string[];
	key: string;
}

const PALETTE_NAMES: Array<keyof GhosttyThemeColors> = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite"
];

export const GHOSTTY_BUILTIN_KEYBINDS: GhosttyKeybind[] = [
	{ mods: new Set(["super", "alt"]), key: "w", action: "close_tab:this" },
	{ mods: new Set(["super"]), key: "=", action: "increase_font_size:1" },
	{ mods: new Set(["super", "shift"]), key: "+", action: "increase_font_size:1" },
	{ mods: new Set(["super"]), key: "-", action: "decrease_font_size:1" },
	{ mods: new Set(["super"]), key: "0", action: "reset_font_size" },
	{ mods: new Set(["super"]), key: "end", action: "scroll_to_bottom" },
	{ mods: new Set(["super"]), key: "home", action: "scroll_to_top" },
	{ mods: new Set(["super"]), key: "page_down", action: "scroll_page_down" },
	{ mods: new Set(["super"]), key: "page_up", action: "scroll_page_up" },
	{ mods: new Set(["super"]), key: "backspace", action: "text:\\x15" },
	{ mods: new Set(["super"]), key: "left", action: "text:\\x01" },
	{ mods: new Set(["super"]), key: "right", action: "text:\\x05" },
	{ mods: new Set(["super"]), key: "a", action: "select_all" },
	{ mods: new Set(["super"]), key: "c", action: "copy_to_clipboard:mixed" },
	{ mods: new Set(["super"]), key: "v", action: "paste_from_clipboard" },
	{ mods: new Set(["super"]), key: "k", action: "clear_screen" },
	{ mods: new Set(["super"]), key: "d", action: "new_split:right" },
	{ mods: new Set(["super", "shift"]), key: "d", action: "new_split:down" },
	{ mods: new Set(["super", "alt"]), key: "up", action: "goto_split:up" },
	{ mods: new Set(["super", "alt"]), key: "down", action: "goto_split:down" },
	{ mods: new Set(["super", "alt"]), key: "left", action: "goto_split:left" },
	{ mods: new Set(["super", "alt"]), key: "right", action: "goto_split:right" },
	{ mods: new Set(["super"]), key: "[", action: "goto_split:previous" },
	{ mods: new Set(["super"]), key: "]", action: "goto_split:next" },
	{ mods: new Set(["ctrl", "shift"]), key: "tab", action: "previous_tab" },
	{ mods: new Set(["ctrl"]), key: "tab", action: "next_tab" },
	{ mods: new Set(["super"]), key: "1", action: "goto_tab:1" },
	{ mods: new Set(["super"]), key: "2", action: "goto_tab:2" },
	{ mods: new Set(["super"]), key: "3", action: "goto_tab:3" },
	{ mods: new Set(["super"]), key: "4", action: "goto_tab:4" },
	{ mods: new Set(["super"]), key: "5", action: "goto_tab:5" },
	{ mods: new Set(["super"]), key: "6", action: "goto_tab:6" },
	{ mods: new Set(["super"]), key: "7", action: "goto_tab:7" },
	{ mods: new Set(["super"]), key: "8", action: "goto_tab:8" },
	{ mods: new Set(["super"]), key: "9", action: "last_tab" },
	{ mods: new Set(["super", "shift"]), key: "[", action: "previous_tab" },
	{ mods: new Set(["super", "shift"]), key: "]", action: "next_tab" },
	{ mods: new Set(["super"]), key: "t", action: "new_tab" },
	{ mods: new Set(["super"]), key: "w", action: "close_surface" },
	{ mods: new Set(["alt"]), key: "left", action: "esc:b" },
	{ mods: new Set(["alt"]), key: "right", action: "esc:f" },
	{ mods: new Set([]), key: "copy", action: "copy_to_clipboard:mixed" },
	{ mods: new Set([]), key: "paste", action: "paste_from_clipboard" },
	{ mods: new Set(["shift"]), key: "enter", action: "text:\\e[13;2u" },
	{ mods: new Set(["super"]), key: "enter", action: "text:\\e[13;9u" }
];

export function emptyGhosttyConfig(): GhosttyConfig {
	return {
		colors: {},
		keybinds: []
	};
}

export function ghosttyConfigCandidatePaths(overridePath?: string): string[] {
	if (overridePath?.trim()) {
		return [expandHome(overridePath.trim())];
	}

	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	const candidates = [join(xdgConfigHome, "ghostty", "config")];
	if (process.platform === "darwin") {
		candidates.push(join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty", "config"));
	}
	return candidates;
}

export function parseGhosttyConfig(overridePath?: string): GhosttyConfig {
	for (const candidate of ghosttyConfigCandidatePaths(overridePath)) {
		try {
			if (existsSync(candidate)) {
				return parseGhosttyConfigContent(readFileSync(candidate, "utf8"), candidate);
			}
		} catch {
			// Config loading should not block terminal startup.
		}
	}
	return emptyGhosttyConfig();
}

export function parseGhosttyConfigContent(content: string, sourcePath?: string): GhosttyConfig {
	const config = emptyGhosttyConfig();
	config.path = sourcePath;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || /^\[[^\]]+\]$/.test(line)) {
			continue;
		}

		const eqIndex = rawLine.indexOf("=");
		if (eqIndex === -1) {
			continue;
		}

		const key = rawLine.slice(0, eqIndex).trim().toLowerCase();
		const value = stripInlineComment(rawLine.slice(eqIndex + 1).trim());
		if (!key || !value) {
			continue;
		}

		applyConfigKey(config, key, value);
	}

	return config;
}

export function buildEffectiveKeybinds(userKeybinds: GhosttyKeybind[]): GhosttyKeybind[] {
	const result = GHOSTTY_BUILTIN_KEYBINDS.map(cloneKeybind);
	for (const keybind of userKeybinds) {
		const index = result.findIndex((candidate) => (
			candidate.key === keybind.key && setsEqual(candidate.mods, keybind.mods)
		));
		if (index === -1) {
			result.push(cloneKeybind(keybind));
		} else {
			result[index] = cloneKeybind(keybind);
		}
	}
	return result;
}

export function findGhosttyKeybind(event: KeyboardEvent, keybinds: GhosttyKeybind[]): GhosttyKeybind | undefined {
	const eventMods = new Set<GhosttyModifier>();
	if (event.metaKey) {
		eventMods.add("super");
	}
	if (event.ctrlKey) {
		eventMods.add("ctrl");
	}
	if (event.shiftKey) {
		eventMods.add("shift");
	}
	if (event.altKey) {
		eventMods.add("alt");
	}

	const key = domKeyToGhostty(event.key);
	return keybinds.find((keybind) => keybind.key === key && setsEqual(keybind.mods, eventMods));
}

export function keybindToObsidianShortcut(keybind: GhosttyKeybind): ObsidianShortcut | null {
	const modifiers: string[] = [];
	for (const mod of ["super", "ctrl", "alt", "shift"] as GhosttyModifier[]) {
		if (!keybind.mods.has(mod)) {
			continue;
		}
		if (mod === "super") {
			modifiers.push("Mod");
		} else if (mod === "ctrl") {
			modifiers.push("Ctrl");
		} else if (mod === "alt") {
			modifiers.push("Alt");
		} else {
			modifiers.push("Shift");
		}
	}

	const key = ghosttyKeyToObsidianKey(keybind.key);
	return key ? { modifiers, key } : null;
}

export function unescapeGhosttyText(value: string): string {
	return value
		.replace(/\\x\{([0-9a-fA-F]+)\}/g, (_, hex: string) => codePointFromHex(hex))
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => codePointFromHex(hex))
		.replace(/\\e/g, "\x1b")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\\/g, "\\");
}

function applyConfigKey(config: GhosttyConfig, key: string, value: string): void {
	switch (key) {
		case "font-family":
			config.fontFamily = value;
			break;
		case "font-size":
			config.fontSize = parsePositiveNumber(value);
			break;
		case "font-feature":
			config.ligatures = parseFontFeatureLigature(value, config.ligatures);
			break;
		case "cursor-style":
			if (isGhosttyCursorStyle(value)) {
				config.cursorStyle = value;
			}
			break;
		case "cursor-style-blink":
			config.cursorBlink = parseGhosttyBoolean(value);
			break;
		case "background":
			config.colors.background = normalizeColor(value);
			break;
		case "foreground":
			config.colors.foreground = normalizeColor(value);
			break;
		case "cursor-color":
			config.colors.cursor = normalizeColor(value);
			break;
		case "cursor-text":
			config.colors.cursorText = normalizeColor(value);
			break;
		case "selection-background":
			config.colors.selectionBackground = normalizeColor(value);
			break;
		case "selection-foreground":
			config.colors.selectionForeground = normalizeColor(value);
			break;
		case "palette":
			applyPaletteColor(config.colors, value);
			break;
		case "scrollback-limit":
			config.scrollback = parsePositiveInteger(value);
			break;
		case "command":
		case "shell":
			config.shell = shellExecutableFromCommand(value);
			break;
		case "keybind":
			parseKeybind(value)?.forEach((keybind) => config.keybinds.push(keybind));
			break;
		default:
			break;
	}
}

function parseKeybind(value: string): GhosttyKeybind[] | null {
	const eqIndex = value.lastIndexOf("=");
	if (eqIndex === -1) {
		return null;
	}
	const combo = value.slice(0, eqIndex).trim();
	const action = value.slice(eqIndex + 1).trim();
	if (!combo || !action) {
		return null;
	}

	const parts = combo.split("+").map((part) => part.trim());
	let keyPart = parts.pop();
	while (keyPart === "" && parts.at(-1) === "") {
		parts.pop();
	}
	if (keyPart === "" && combo.endsWith("+")) {
		keyPart = "+";
	}
	if (!keyPart) {
		return null;
	}

	const mods = new Set<GhosttyModifier>();
	for (const mod of parts.filter(Boolean)) {
		const normalized = normalizeGhosttyModifier(mod);
		if (!normalized) {
			return null;
		}
		mods.add(normalized);
	}

	return [{
		mods,
		key: normalizeGhosttyKey(keyPart),
		action
	}];
}

function normalizeGhosttyModifier(value: string): GhosttyModifier | null {
	switch (value.trim().toLowerCase()) {
		case "super":
		case "cmd":
		case "command":
		case "meta":
			return "super";
		case "ctrl":
		case "control":
			return "ctrl";
		case "shift":
			return "shift";
		case "alt":
		case "option":
			return "alt";
		default:
			return null;
	}
}

function normalizeGhosttyKey(value: string): string {
	const key = value.trim().toLowerCase().replace(/\s+/g, "_");
	const aliases: Record<string, string> = {
		arrowup: "up",
		arrow_up: "up",
		up_arrow: "up",
		arrowdown: "down",
		arrow_down: "down",
		down_arrow: "down",
		arrowleft: "left",
		arrow_left: "left",
		left_arrow: "left",
		arrowright: "right",
		arrow_right: "right",
		right_arrow: "right",
		return: "enter",
		esc: "escape",
		equal: "=",
		equals: "=",
		plus: "+",
		minus: "-",
		digit_0: "0",
		digit_1: "1",
		digit_2: "2",
		digit_3: "3",
		digit_4: "4",
		digit_5: "5",
		digit_6: "6",
		digit_7: "7",
		digit_8: "8",
		digit_9: "9",
		pgup: "page_up",
		pgdn: "page_down",
		spacebar: "space"
	};
	return aliases[key] ?? key;
}

function domKeyToGhostty(domKey: string): string {
	const map: Record<string, string> = {
		Enter: "enter",
		Tab: "tab",
		Backspace: "backspace",
		Escape: "escape",
		Delete: "delete",
		Insert: "insert",
		Home: "home",
		End: "end",
		PageUp: "page_up",
		PageDown: "page_down",
		ArrowUp: "up",
		ArrowDown: "down",
		ArrowLeft: "left",
		ArrowRight: "right",
		Copy: "copy",
		Paste: "paste",
		" ": "space"
	};
	if (map[domKey]) {
		return map[domKey];
	}
	if (/^F\d+$/i.test(domKey)) {
		return domKey.toLowerCase();
	}
	return domKey.length === 1 ? domKey.toLowerCase() : domKey.toLowerCase();
}

function ghosttyKeyToObsidianKey(key: string): string | null {
	const map: Record<string, string> = {
		enter: "Enter",
		tab: "Tab",
		backspace: "Backspace",
		escape: "Escape",
		delete: "Delete",
		insert: "Insert",
		home: "Home",
		end: "End",
		page_up: "PageUp",
		page_down: "PageDown",
		up: "ArrowUp",
		down: "ArrowDown",
		left: "ArrowLeft",
		right: "ArrowRight",
		copy: "Copy",
		paste: "Paste",
		space: " "
	};
	return map[key] ?? (key.length === 1 || /^f\d+$/i.test(key) ? key : null);
}

function shellExecutableFromCommand(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return trimmed;
	}
	if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
		const quote = trimmed[0];
		const end = trimmed.indexOf(quote, 1);
		return expandHome(end === -1 ? trimmed.slice(1) : trimmed.slice(1, end));
	}
	const command = trimmed.split(/\s+/)[0] ?? trimmed;
	return expandHome(command);
}

function expandHome(value: string): string {
	if (value === "~") {
		return homedir();
	}
	if (value.startsWith("~/")) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

function stripInlineComment(value: string): string {
	return value.replace(/\s+#.*$/, "").trim();
}

function normalizeColor(value: string): string {
	const color = value.trim();
	if (/^[0-9a-fA-F]{6}$/.test(color)) {
		return `#${color}`;
	}
	return color;
}

function applyPaletteColor(colors: GhosttyThemeColors, value: string): void {
	const eqIndex = value.indexOf("=");
	if (eqIndex === -1) {
		return;
	}
	const index = Number.parseInt(value.slice(0, eqIndex).trim(), 10);
	const color = normalizeColor(value.slice(eqIndex + 1).trim());
	const name = PALETTE_NAMES[index];
	if (name && color) {
		colors[name] = color;
	}
}

function parsePositiveInteger(value: string): number | undefined {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumber(value: string): number | undefined {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseGhosttyBoolean(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "true":
		case "yes":
		case "1":
		case "on":
			return true;
		case "false":
		case "no":
		case "0":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function parseFontFeatureLigature(value: string, existing: boolean | undefined): boolean | undefined {
	const lower = value.toLowerCase();
	if (lower.includes("-calt") || lower.includes("-liga")) {
		return false;
	}
	if (lower.includes("calt") || lower.includes("liga")) {
		return true;
	}
	return existing;
}

function isGhosttyCursorStyle(value: string): value is GhosttyCursorStyle {
	return value === "block" || value === "bar" || value === "underline";
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const value of a) {
		if (!b.has(value)) {
			return false;
		}
	}
	return true;
}

function cloneKeybind(keybind: GhosttyKeybind): GhosttyKeybind {
	return {
		mods: new Set(keybind.mods),
		key: keybind.key,
		action: keybind.action
	};
}

function codePointFromHex(hex: string): string {
	const codePoint = Number.parseInt(hex, 16);
	if (!Number.isFinite(codePoint)) {
		return "";
	}
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return "";
	}
}
