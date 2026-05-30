import { App, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { GhostTermPluginHost } from "./plugin-host";

export type LastSurfaceCloseBehavior = "close-view" | "new-surface";
export type RestartAfterExitBehavior = "manual" | "automatic";
export type DefaultTerminalLocation = "right" | "left" | "tab" | "split";

export interface GhostTermSettings {
	defaultLocation: DefaultTerminalLocation;
	defaultShell: string;
	ghosttyConfigPath: string;
	fontFamilyOverride: string;
	fontSizeOverride: number;
	ligatures: boolean;
	scrollbackLines: number;
	lastSurfaceCloseBehavior: LastSurfaceCloseBehavior;
	restartAfterExitBehavior: RestartAfterExitBehavior;
}

export const DEFAULT_SETTINGS: GhostTermSettings = {
	defaultLocation: "right",
	defaultShell: "",
	ghosttyConfigPath: "",
	fontFamilyOverride: "",
	fontSizeOverride: 0,
	ligatures: true,
	scrollbackLines: 100000,
	lastSurfaceCloseBehavior: "close-view",
	restartAfterExitBehavior: "manual"
};

export function normalizeGhostTermSettings(value: unknown): GhostTermSettings {
	const record = value && typeof value === "object"
		? value as Partial<GhostTermSettings> & { shellOverride?: unknown }
		: {};
	return {
		defaultLocation: normalizeDefaultLocation(record.defaultLocation),
		defaultShell: stringSetting(record.defaultShell) || stringSetting(record.shellOverride),
		ghosttyConfigPath: stringSetting(record.ghosttyConfigPath),
		fontFamilyOverride: stringSetting(record.fontFamilyOverride),
		fontSizeOverride: positiveNumberSetting(record.fontSizeOverride, DEFAULT_SETTINGS.fontSizeOverride),
		ligatures: booleanSetting(record.ligatures, DEFAULT_SETTINGS.ligatures),
		scrollbackLines: positiveIntegerSetting(record.scrollbackLines, DEFAULT_SETTINGS.scrollbackLines),
		lastSurfaceCloseBehavior: record.lastSurfaceCloseBehavior === "new-surface"
			? "new-surface"
			: DEFAULT_SETTINGS.lastSurfaceCloseBehavior,
		restartAfterExitBehavior: record.restartAfterExitBehavior === "automatic"
			? "automatic"
			: DEFAULT_SETTINGS.restartAfterExitBehavior
	};
}

type GhostTermSettingsPlugin = Plugin & GhostTermPluginHost;

export class GhostTermSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: GhostTermSettingsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Display").setHeading();
		new Setting(containerEl)
			.setName("Default location")
			.setDesc("Where the Obsidian Ghostty view opens when using the default open command.")
			.addDropdown((dropdown) => dropdown
				.addOption("right", "Right sidebar")
				.addOption("left", "Left sidebar")
				.addOption("tab", "Main area tab")
				.addOption("split", "Main area split")
				.setValue(this.plugin.settings.defaultLocation)
				.onChange((value) => this.savePatch({ defaultLocation: normalizeDefaultLocation(value) })));

		new Setting(containerEl).setName("Ghostty config").setHeading();
		new Setting(containerEl)
			.setName("Config file path")
			.setDesc("Path to your Ghostty config file. Empty auto-detects ~/.config/ghostty/config and the macOS Application Support config.")
			.addText((text) => text
				.setPlaceholder("~/.config/ghostty/config")
				.setValue(this.plugin.settings.ghosttyConfigPath)
				.onChange((value) => this.savePatch({ ghosttyConfigPath: value.trim() })));

		new Setting(containerEl).setName("Shell").setHeading();
		new Setting(containerEl)
			.setName("Default shell")
			.setDesc("Path to the shell binary. Empty uses Ghostty config, then $SHELL.")
			.addText((text) => text
				.setPlaceholder("/bin/zsh")
				.setValue(this.plugin.settings.defaultShell)
				.onChange((value) => this.savePatch({ defaultShell: value.trim() })));

		new Setting(containerEl).setName("Font").setHeading();
		new Setting(containerEl)
			.setName("Font family override")
			.setDesc("Empty uses Ghostty config or the GhostTerm default stack.")
			.addText((text) => text
				.setPlaceholder("JetBrains Mono, Menlo, monospace")
				.setValue(this.plugin.settings.fontFamilyOverride)
				.onChange((value) => this.savePatch({ fontFamilyOverride: value.trim() })));

		new Setting(containerEl)
			.setName("Font size override")
			.setDesc("Set to 0 or empty to use Ghostty config.")
			.addText((text) => text
				.setPlaceholder("13")
				.setValue(this.plugin.settings.fontSizeOverride > 0 ? String(this.plugin.settings.fontSizeOverride) : "")
				.onChange((value) => this.savePatch({ fontSizeOverride: Number.parseFloat(value) || 0 })));

		new Setting(containerEl)
			.setName("Ligatures")
			.setDesc("Controls font ligatures for newly created surfaces when supported by the renderer.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.ligatures)
				.onChange((value) => this.savePatch({ ligatures: value })));

		new Setting(containerEl).setName("Terminal").setHeading();
		new Setting(containerEl)
			.setName("Scrollback lines")
			.setDesc("Default scrollback when Ghostty config does not set scrollback-limit.")
			.addText((text) => text
				.setPlaceholder("100000")
				.setValue(String(this.plugin.settings.scrollbackLines))
				.onChange((value) => this.savePatch({ scrollbackLines: Number.parseInt(value, 10) || DEFAULT_SETTINGS.scrollbackLines })));

		new Setting(containerEl)
			.setName("When closing the last surface")
			.setDesc("Choose whether Cmd-W closes the Ghostty view or starts a replacement surface.")
			.addDropdown((dropdown) => dropdown
				.addOption("close-view", "Close Ghostty view")
				.addOption("new-surface", "Start replacement surface")
				.setValue(this.plugin.settings.lastSurfaceCloseBehavior)
				.onChange((value) => this.savePatch({ lastSurfaceCloseBehavior: value === "new-surface" ? "new-surface" : "close-view" })));

		new Setting(containerEl)
			.setName("After shell exit")
			.setDesc("Manual shows a restart affordance; automatic restarts exited surfaces.")
			.addDropdown((dropdown) => dropdown
				.addOption("manual", "Show restart control")
				.addOption("automatic", "Restart automatically")
				.setValue(this.plugin.settings.restartAfterExitBehavior)
				.onChange((value) => this.savePatch({ restartAfterExitBehavior: value === "automatic" ? "automatic" : "manual" })));
	}

	private savePatch(patch: Partial<GhostTermSettings>): void {
		void this.plugin.updateSettings(patch);
	}
}

function stringSetting(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function normalizeDefaultLocation(value: unknown): DefaultTerminalLocation {
	switch (value) {
		case "right":
		case "left":
		case "tab":
		case "split":
			return value;
		default:
			return DEFAULT_SETTINGS.defaultLocation;
	}
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function positiveIntegerSetting(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveNumberSetting(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
