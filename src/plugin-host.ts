import type { PluginManifest } from "obsidian";
import type { GhosttyConfig, GhosttyKeybind } from "./ghostty-config";
import type { GhostTermSettings } from "./settings";

export interface GhostTermPluginHost {
	settings: GhostTermSettings;
	ghosttyConfig: GhosttyConfig;
	manifest: PluginManifest;
	effectiveKeybinds(): GhosttyKeybind[];
	updateSettings(patch: Partial<GhostTermSettings>): Promise<void>;
}
