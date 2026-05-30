import {
	App,
	ItemView,
	Menu,
	Notice,
	Plugin,
	Scope,
	TFile,
	TFolder,
	WorkspaceLeaf
} from "obsidian";
import type { EventRef, KeymapEventHandler, Modifier, ViewStateResult } from "obsidian";
import { DISPLAY_NAME, VIEW_TYPE_GHOSTTERM } from "./constants";
import {
	buildEffectiveKeybinds,
	emptyGhosttyConfig,
	keybindToObsidianShortcut,
	parseGhosttyConfig,
	type GhosttyConfig,
	type GhosttyKeybind
} from "./ghostty-config";
import {
	GhostTermSettingTab,
	normalizeGhostTermSettings,
	type DefaultTerminalLocation,
	type GhostTermSettings
} from "./settings";
import { TerminalWorkspaceController } from "./terminal-workspace-controller";

type ObsidianTerminalLocation = DefaultTerminalLocation;

function isFolderLike(value: unknown): value is TFolder {
	return value instanceof TFolder;
}

export default class GhostTermPlugin extends Plugin {
	ghostTermSettings: GhostTermSettings = normalizeGhostTermSettings(null);
	ghosttyConfig: GhosttyConfig = emptyGhosttyConfig();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.reloadGhosttyConfig();
		this.registerView(VIEW_TYPE_GHOSTTERM, (leaf) => new GhostTermView(leaf, this));
		this.addRibbonIcon("terminal", `Open ${DISPLAY_NAME} terminal`, () => {
			void this.openTerminal();
		});

		this.registerCommands();
		this.registerFileMenu();
		this.addSettingTab(new GhostTermSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.ghostTermSettings = normalizeGhostTermSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		this.ghostTermSettings = normalizeGhostTermSettings(this.ghostTermSettings);
		await this.saveData(this.ghostTermSettings);
		this.reloadGhosttyConfig();
		this.refreshOpenViews();
	}

	async updateSettings(patch: Partial<GhostTermSettings>): Promise<void> {
		this.ghostTermSettings = normalizeGhostTermSettings({ ...this.ghostTermSettings, ...patch });
		await this.saveSettings();
	}

	reloadGhosttyConfig(): void {
		this.ghosttyConfig = parseGhosttyConfig(this.ghostTermSettings.ghosttyConfigPath || undefined);
	}

	effectiveKeybinds(): GhosttyKeybind[] {
		return buildEffectiveKeybinds(this.ghosttyConfig.keybinds);
	}

	private refreshOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GHOSTTERM)) {
			if (leaf.view instanceof GhostTermView) {
				leaf.view.refreshSettings();
			}
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-terminal",
			name: "Open terminal",
			callback: () => void this.openTerminal()
		});
		this.addCommand({
			id: "open-terminal-split",
			name: "Open terminal in main area split",
			callback: () => void this.openTerminalInLocation("split")
		});
		this.addCommand({
			id: "new-terminal-tab",
			name: "New terminal tab",
			checkCallback: (checking) => this.withActiveGhostTermView(checking, (view) => view.controller.newTab())
		});
		this.addCommand({
			id: "split-terminal-right",
			name: "Split terminal right",
			checkCallback: (checking) => this.withActiveGhostTermView(checking, (view) => view.controller.splitFocused("row"))
		});
		this.addCommand({
			id: "split-terminal-down",
			name: "Split terminal down",
			checkCallback: (checking) => this.withActiveGhostTermView(checking, (view) => view.controller.splitFocused("column"))
		});
		this.addCommand({
			id: "close-terminal-surface",
			name: "Close focused terminal",
			checkCallback: (checking) => this.withActiveGhostTermView(checking, (view) => view.controller.closeFocusedSurface())
		});
		this.addCommand({
			id: "restart-terminal-surface",
			name: "Restart terminal surface",
			checkCallback: (checking) => this.withActiveGhostTermView(checking, (view) => view.controller.restartFocusedSurface())
		});
	}

	private registerFileMenu(): void {
		const workspaceOn = this.app.workspace.on.bind(this.app.workspace) as unknown as (
			name: "file-menu",
			callback: (menu: Menu, file: TFile | TFolder) => void
		) => EventRef;
		this.registerEvent(
			workspaceOn("file-menu", (menu: Menu, file: TFile | TFolder) => {
				menu.addItem((item) => {
					item
						.setTitle(`Open ${DISPLAY_NAME} here`)
						.setIcon("terminal")
						.onClick(() => {
							const cwd = isFolderLike(file) ? file.path : file.parent?.path ?? "";
							void this.openTerminal(cwd);
						});
				});
			})
		);
	}

	private withActiveGhostTermView(checking: boolean, action: (view: GhostTermView) => void): boolean {
		const view = this.app.workspace.getActiveViewOfType(GhostTermView);
		if (!view) {
			return false;
		}
		if (!checking) {
			action(view);
		}
		return true;
	}

	async openTerminal(cwd?: string): Promise<void> {
		await this.openTerminalInLocation(this.ghostTermSettings.defaultLocation, cwd);
	}

	async openTerminalInLocation(location: ObsidianTerminalLocation, cwd?: string): Promise<void> {
		const existing = this.findExistingLeaf(location);
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			if (cwd && existing.view instanceof GhostTermView) {
				existing.view.controller?.newTab(cwd);
			} else if (existing.view instanceof GhostTermView) {
				existing.view.controller?.focusActiveSurface();
			}
			return;
		}

		const leaf = this.resolveGhostTermLeaf(location);
		if (!leaf) {
			new Notice(`${DISPLAY_NAME} could not open a workspace leaf.`);
			return;
		}

		await leaf.setViewState({
			type: VIEW_TYPE_GHOSTTERM,
			active: true,
			state: { cwd }
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	private resolveGhostTermLeaf(location: ObsidianTerminalLocation): WorkspaceLeaf | null {
		const workspace = this.app.workspace as App["workspace"] & {
			createLeafBySplit?: (leaf: WorkspaceLeaf, direction?: "horizontal" | "vertical", before?: boolean) => WorkspaceLeaf;
			getLeftLeaf?: (split: boolean) => WorkspaceLeaf | null;
			getRightLeaf?: (split: boolean) => WorkspaceLeaf | null;
		};
		if (location === "left") {
			return workspace.getLeftLeaf?.(false) ?? this.app.workspace.getLeaf("split");
		}
		if (location === "right") {
			return workspace.getRightLeaf?.(false) ?? this.app.workspace.getLeaf("split");
		}
		if (location === "tab") {
			return this.app.workspace.getLeaf("tab");
		}
		if (location === "split") {
			const targetLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
			if (targetLeaf && workspace.createLeafBySplit) {
				return workspace.createLeafBySplit(targetLeaf, "vertical");
			}
			return this.app.workspace.getLeaf("tab");
		}
		return null;
	}

	private findExistingLeaf(location: ObsidianTerminalLocation): WorkspaceLeaf | null {
		const workspace = this.app.workspace as App["workspace"] & {
			leftSplit?: unknown;
			rightSplit?: unknown;
		};
		const root = location === "right"
			? workspace.rightSplit
			: location === "left"
				? workspace.leftSplit
				: workspace.rootSplit;
		if (!root) {
			return null;
		}
		return workspace.getLeavesOfType(VIEW_TYPE_GHOSTTERM)
			.find((leaf) => isWithinWorkspaceItem(leaf, root)) ?? null;
	}
}

function isWithinWorkspaceItem(item: unknown, ancestor: unknown): boolean {
	let current: unknown = item;
	while (current && typeof current === "object") {
		if (current === ancestor) {
			return true;
		}
		current = (current as { parent?: unknown }).parent;
	}
	return false;
}

class GhostTermView extends ItemView {
	controller!: TerminalWorkspaceController;
	private initialCwd?: string;
	private shortcutHandlers: KeymapEventHandler[] = [];

	constructor(leaf: WorkspaceLeaf, private readonly plugin: GhostTermPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.registerTerminalShortcutScope();
	}

	getViewType(): string {
		return VIEW_TYPE_GHOSTTERM;
	}

	getDisplayText(): string {
		return DISPLAY_NAME;
	}

	getIcon(): string {
		return "terminal";
	}

	async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
		this.initialCwd = typeof state.cwd === "string" ? state.cwd : undefined;
		return super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.containerEl.empty();
		this.containerEl.addClass("ghostterm-view");
		this.controller = new TerminalWorkspaceController(this.app, this.plugin, this.containerEl, () => this.leaf.detach());
		const state = this.leaf.getViewState().state as { cwd?: string };
		await this.controller.start(this.initialCwd ?? state.cwd);
	}

	async onClose(): Promise<void> {
		this.unregisterTerminalShortcutScope();
		this.controller?.dispose();
	}

	refreshSettings(): void {
		this.registerTerminalShortcutScope();
		this.controller?.handleSettingsChanged();
	}

	private registerTerminalShortcutScope(): void {
		this.unregisterTerminalShortcutScope();
		const shortcuts = new Map<string, { modifiers: Modifier[]; key: string }>();
		for (const keybind of this.plugin.effectiveKeybinds()) {
			const shortcut = keybindToObsidianShortcut(keybind);
			if (!shortcut) {
				continue;
			}
			const modifiers = shortcut.modifiers as Modifier[];
			const mapKey = `${modifiers.join("+")}+${shortcut.key}`;
			shortcuts.set(mapKey, { modifiers, key: shortcut.key });
		}
		for (const { modifiers, key } of shortcuts.values()) {
			const handler = this.scope?.register(modifiers, key, (event) => {
				if (this.controller?.handleShortcut(event)) {
					return false;
				}
				return undefined;
			});
			if (handler) {
				this.shortcutHandlers.push(handler);
			}
		}
	}

	private unregisterTerminalShortcutScope(): void {
		if (!this.scope) {
			return;
		}
		for (const handler of this.shortcutHandlers) {
			this.scope.unregister(handler);
		}
		this.shortcutHandlers = [];
	}
}
