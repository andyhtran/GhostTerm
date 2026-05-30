import type { App } from "obsidian";
import { DISPLAY_NAME, STATUS_PREFIX } from "./constants";
import { findGhosttyKeybind, unescapeGhosttyText } from "./ghostty-config";
import { ensureGhosttyWeb } from "./ghostty-runtime";
import { nextId } from "./ids";
import type { GhostTermPluginHost } from "./plugin-host";
import {
	clampRatio,
	containsSurfaceNode,
	firstSurfaceId,
	removeSurfaceNode,
	replaceSurfaceNode,
	type SplitDirection,
	type SplitNode,
	type TerminalTab
} from "./split-tree";
import { TerminalSurface } from "./terminal-surface";

export class TerminalWorkspaceController {
	private tabs: TerminalTab[] = [];
	private surfacesById = new Map<string, TerminalSurface>();
	private focusedSurfaceId: string | null = null;
	private activeTabId: string | null = null;
	private readonly toolbarEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly workspaceEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private fitFrame = 0;

	constructor(
		private readonly app: App,
		private readonly plugin: GhostTermPluginHost,
		private readonly rootEl: HTMLElement,
		private readonly onCloseView: () => void
	) {
		this.rootEl.setAttr("aria-label", `${DISPLAY_NAME} terminal workspace`);

		this.toolbarEl = this.rootEl.createDiv({ cls: "ghostterm-toolbar" });
		this.tabsEl = this.toolbarEl.createDiv({ cls: "ghostterm-tabs", attr: { role: "tablist" } });
		this.addNewTabButton();

		this.workspaceEl = this.rootEl.createDiv({
			cls: "ghostterm-workspace",
			attr: {
				"aria-label": `${DISPLAY_NAME} terminal workspace`
			}
		});
		this.statusEl = this.rootEl.createDiv({
			cls: "ghostterm-status",
			text: `${STATUS_PREFIX}: starting`,
			attr: {
				"aria-label": STATUS_PREFIX,
				role: "status"
			}
		});

		this.rootEl.addEventListener("keydown", (event) => {
			this.handleShortcut(event);
		}, { capture: true });
	}

	async start(cwd?: string): Promise<void> {
		await ensureGhosttyWeb();
		await this.createInitialTab(cwd);
	}

	newTab(cwd?: string): void {
		if (cwd) {
			void this.createInitialTab(cwd);
			return;
		}
		void this.createTabFromFocusedSurface();
	}

	focusActiveSurface(): void {
		this.focusedSurface()?.focus();
	}

	splitFocused(direction: SplitDirection): void {
		void this.createSplitFromFocusedSurface(direction);
	}

	closeFocusedSurface(): void {
		const tab = this.activeTab();
		const focused = this.focusedSurface();
		if (!tab || !focused) {
			return;
		}

		const nextRoot = removeSurfaceNode(tab.root, focused.id);
		if (!nextRoot) {
			this.closeTab(tab.id, focused.cwd);
			return;
		}

		focused.dispose();
		this.surfacesById.delete(focused.id);
		tab.root = nextRoot;
		this.focusedSurfaceId = firstSurfaceId(tab.root);
		this.render();
		this.focusedSurface()?.focus();
	}

	restartFocusedSurface(): void {
		const focused = this.focusedSurface();
		if (focused) {
			void focused.restart();
		}
	}

	dispose(): void {
		if (this.fitFrame) {
			window.cancelAnimationFrame(this.fitFrame);
			this.fitFrame = 0;
		}
		for (const surface of this.surfacesById.values()) {
			surface.dispose();
		}
		this.surfacesById.clear();
	}

	handleSettingsChanged(): void {
		for (const surface of this.surfacesById.values()) {
			surface.applySettingsChanged();
		}
		this.setStatus(`${STATUS_PREFIX}: settings updated; new surfaces use the latest config`);
	}

	handleShortcut(event: KeyboardEvent): boolean {
		const focused = this.focusedSurface();
		if (!focused || !focused.containsKeyboardTarget(event)) {
			return false;
		}
		const keybind = findGhosttyKeybind(event, this.plugin.effectiveKeybinds());
		if (!keybind) {
			return false;
		}

		const action = keybind.action;
		if (action === "copy_to_clipboard") {
			event.preventDefault();
			event.stopImmediatePropagation();
			const selection = focused.getSelection();
			if (selection && navigator.clipboard) {
				void navigator.clipboard.writeText(selection).catch(() => undefined);
			}
			return true;
		}
		if (action === "paste_from_clipboard") {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (navigator.clipboard) {
				void navigator.clipboard.readText().then((text) => {
					if (text) {
						focused.paste(text);
					}
				}).catch(() => undefined);
			}
			return true;
		}
		if (action.startsWith("text:")) {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.writeInput(unescapeGhosttyText(action.slice(5)));
			return true;
		}
		if (action === "new_split:down") {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.splitFocused("column");
			return true;
		}
		if (action === "new_split:right") {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.splitFocused("row");
			return true;
		}
		if (action === "new_tab") {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.newTab();
			return true;
		}
		if (action === "close_surface") {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.closeFocusedSurface();
			return true;
		}
		event.stopImmediatePropagation();
		return true;
	}

	private async createSplitFromFocusedSurface(direction: SplitDirection): Promise<void> {
		const tab = this.activeTab();
		const focusedSurface = this.focusedSurface();
		if (!tab || !focusedSurface) {
			return;
		}
		const cwd = await focusedSurface.refreshCurrentCwd();
		if (this.focusedSurfaceId !== focusedSurface.id || !this.surfacesById.has(focusedSurface.id)) {
			return;
		}
		const surface = this.createSurface(cwd);
		const replacement: SplitNode = {
			type: "split",
			id: nextId("split"),
			direction,
			ratio: 0.5,
			first: { type: "surface", surfaceId: focusedSurface.id },
			second: { type: "surface", surfaceId: surface.id }
		};
		tab.root = replaceSurfaceNode(tab.root, focusedSurface.id, replacement);
		this.focusSurface(surface.id);
		this.render();
	}

	private closeTab(tabId: string, replacementCwd?: string): void {
		const index = this.tabs.findIndex((tab) => tab.id === tabId);
		if (index === -1) {
			return;
		}

		const [closedTab] = this.tabs.splice(index, 1);
		this.disposeSurfacesInNode(closedTab.root);

		if (this.tabs.length === 0) {
			this.activeTabId = null;
			this.focusedSurfaceId = null;
			this.render();
			if (this.plugin.settings.lastSurfaceCloseBehavior === "new-surface") {
				void this.createInitialTab(replacementCwd);
				return;
			}
			this.onCloseView();
			return;
		}

		const nextTab = this.tabs[Math.min(index, this.tabs.length - 1)];
		this.activeTabId = nextTab.id;
		this.focusedSurfaceId = firstSurfaceId(nextTab.root);
		this.render();
		this.focusedSurface()?.focus();
	}

	private disposeSurfacesInNode(node: SplitNode): void {
		if (node.type === "surface") {
			const surface = this.surfacesById.get(node.surfaceId);
			surface?.dispose();
			this.surfacesById.delete(node.surfaceId);
			return;
		}
		this.disposeSurfacesInNode(node.first);
		this.disposeSurfacesInNode(node.second);
	}

	private async createInitialTab(cwd?: string): Promise<void> {
		await ensureGhosttyWeb();
		const surface = this.createSurface(cwd);
		const tab: TerminalTab = {
			id: nextId("tab"),
			root: { type: "surface", surfaceId: surface.id }
		};
		this.tabs.push(tab);
		this.activeTabId = tab.id;
		this.focusedSurfaceId = surface.id;
		this.render();
		surface.focus();
	}

	private async createTabFromFocusedSurface(): Promise<void> {
		const focused = this.focusedSurface();
		const cwd = focused ? await focused.refreshCurrentCwd() : undefined;
		await this.createInitialTab(cwd);
	}

	private createSurface(cwd?: string): TerminalSurface {
		const surface = new TerminalSurface(
			this.app,
			this.plugin,
			cwd,
			(surfaceId) => this.focusSurface(surfaceId, false),
			(status) => this.setStatus(status),
			(surfaceId) => this.handleSurfaceTitleChange(surfaceId)
		);
		this.surfacesById.set(surface.id, surface);
		void surface.start();
		return surface;
	}

	private activeTab(): TerminalTab | null {
		return this.tabs.find((tab) => tab.id === this.activeTabId) ?? this.tabs[0] ?? null;
	}

	private focusedSurface(): TerminalSurface | null {
		if (!this.focusedSurfaceId) {
			return null;
		}
		return this.surfacesById.get(this.focusedSurfaceId) ?? null;
	}

	private focusSurface(surfaceId: string, moveDomFocus = true): void {
		if (!this.surfacesById.has(surfaceId)) {
			return;
		}
		this.focusedSurfaceId = surfaceId;
		for (const surface of this.surfacesById.values()) {
			surface.setFocused(surface.id === surfaceId);
		}
		this.renderTabs();
		if (moveDomFocus) {
			this.focusedSurface()?.focus();
		}
		this.updateStatusSummary();
	}

	private render(): void {
		this.renderTabs();
		this.workspaceEl.empty();
		const tab = this.activeTab();
		if (tab) {
			this.workspaceEl.appendChild(this.renderNode(tab.root));
		}
		for (const surface of this.surfacesById.values()) {
			surface.setFocused(surface.id === this.focusedSurfaceId);
		}
		this.updateStatusSummary();
	}

	private renderTabs(): void {
		this.tabsEl.empty();
		for (const tab of this.tabs) {
			const title = this.titleForTab(tab);
			const tabEl = this.tabsEl.createEl("button", {
				cls: "ghostterm-tab",
				text: title,
				attr: {
					"aria-label": `${DISPLAY_NAME} tab ${title}`,
					"aria-selected": String(tab.id === this.activeTabId),
					role: "tab"
				}
			});
			tabEl.addEventListener("click", () => {
				this.activeTabId = tab.id;
				this.focusedSurfaceId = firstSurfaceId(tab.root);
				this.render();
				this.focusedSurface()?.focus();
			});
		}
	}

	private titleForTab(tab: TerminalTab): string {
		const focusedInTab = this.focusedSurfaceId && containsSurfaceNode(tab.root, this.focusedSurfaceId)
			? this.focusedSurfaceId
			: null;
		const titleSurfaceId = tab.id === this.activeTabId && focusedInTab
			? focusedInTab
			: firstSurfaceId(tab.root);
		return titleSurfaceId ? this.surfacesById.get(titleSurfaceId)?.title ?? DISPLAY_NAME : DISPLAY_NAME;
	}

	private handleSurfaceTitleChange(surfaceId: string): void {
		if (!this.tabs.some((tab) => containsSurfaceNode(tab.root, surfaceId))) {
			return;
		}
		this.renderTabs();
		this.updateStatusSummary();
	}

	private renderNode(node: SplitNode): HTMLElement {
		if (node.type === "surface") {
			const surface = this.surfacesById.get(node.surfaceId);
			if (!surface) {
				return createDiv({ text: `Missing ${DISPLAY_NAME} surface` });
			}
			return surface.containerEl;
		}
		const splitEl = createDiv({
			cls: `ghostterm-split ghostterm-split-${node.direction}`
		});
		const firstPane = createDiv({ cls: "ghostterm-split-pane" });
		const secondPane = createDiv({ cls: "ghostterm-split-pane" });
		this.applySplitRatio(node, firstPane, secondPane);
		firstPane.appendChild(this.renderNode(node.first));
		secondPane.appendChild(this.renderNode(node.second));

		const resizeHandle = createDiv({
			cls: `ghostterm-split-resizer ghostterm-split-resizer-${node.direction}`,
			attr: {
				"aria-label": node.direction === "row"
					? `${DISPLAY_NAME} resize split horizontally`
					: `${DISPLAY_NAME} resize split vertically`,
				"aria-orientation": node.direction === "row" ? "vertical" : "horizontal",
				role: "separator",
				tabindex: "0"
			}
		});
		resizeHandle.addEventListener("pointerdown", (event) => {
			this.startSplitResize(event, node, splitEl, firstPane, secondPane);
		});

		splitEl.appendChild(firstPane);
		splitEl.appendChild(resizeHandle);
		splitEl.appendChild(secondPane);
		return splitEl;
	}

	private applySplitRatio(node: Extract<SplitNode, { type: "split" }>, firstPane: HTMLElement, secondPane: HTMLElement): void {
		const ratio = clampRatio(node.ratio);
		node.ratio = ratio;
		firstPane.style.flex = `0 0 ${ratio * 100}%`;
		secondPane.style.flex = `1 1 ${(1 - ratio) * 100}%`;
	}

	private startSplitResize(
		event: PointerEvent,
		node: Extract<SplitNode, { type: "split" }>,
		splitEl: HTMLElement,
		firstPane: HTMLElement,
		secondPane: HTMLElement
	): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();

		const pointerId = event.pointerId;
		const updateRatio = (clientX: number, clientY: number) => {
			const rect = splitEl.getBoundingClientRect();
			const size = node.direction === "row" ? rect.width : rect.height;
			if (size <= 0) {
				return;
			}
			const offset = node.direction === "row" ? clientX - rect.left : clientY - rect.top;
			node.ratio = clampRatio(offset / size);
			this.applySplitRatio(node, firstPane, secondPane);
			this.scheduleFitAllSurfaces();
		};
		const onPointerMove = (moveEvent: PointerEvent) => {
			if (moveEvent.pointerId === pointerId) {
				updateRatio(moveEvent.clientX, moveEvent.clientY);
			}
		};
		const stopResize = () => {
			window.removeEventListener("pointermove", onPointerMove, { capture: true });
			window.removeEventListener("pointerup", stopResize, { capture: true });
			window.removeEventListener("pointercancel", stopResize, { capture: true });
			document.body.removeClass("ghostterm-resizing");
			try {
				splitEl.releasePointerCapture(pointerId);
			} catch {
				// The pointer may already have been released by the browser.
			}
			this.scheduleFitAllSurfaces();
			this.focusedSurface()?.focus();
		};

		document.body.addClass("ghostterm-resizing");
		try {
			splitEl.setPointerCapture(pointerId);
		} catch {
			// Window-level listeners still keep the drag working.
		}
		window.addEventListener("pointermove", onPointerMove, { capture: true });
		window.addEventListener("pointerup", stopResize, { capture: true });
		window.addEventListener("pointercancel", stopResize, { capture: true });
		updateRatio(event.clientX, event.clientY);
	}

	private scheduleFitAllSurfaces(): void {
		if (this.fitFrame) {
			return;
		}
		this.fitFrame = window.requestAnimationFrame(() => {
			this.fitFrame = 0;
			for (const surface of this.surfacesById.values()) {
				surface.fit();
			}
		});
	}

	private addNewTabButton(): void {
		const button = this.toolbarEl.createEl("button", {
			cls: "ghostterm-tab-add",
			text: "+",
			attr: {
				"aria-label": `${DISPLAY_NAME} new tab`,
				title: "New tab"
			}
		});
		button.addEventListener("click", () => this.newTab());
	}

	private setStatus(message: string): void {
		this.statusEl.setText(message);
		this.statusEl.setAttr("aria-label", message.startsWith(STATUS_PREFIX)
			? message
			: `${STATUS_PREFIX} ${message}`);
		this.rootEl.setAttr("aria-label", `${DISPLAY_NAME} terminal workspace. ${this.statusEl.getAttribute("aria-label") ?? message}`);
	}

	private updateStatusSummary(): void {
		const focused = this.focusedSurface();
		const focusedSummary = focused
			? `${focused.title} ${focused.lifecycleState}`
			: "none";
		this.setStatus(`${STATUS_PREFIX}: ${this.tabs.length} tab(s), ${this.surfacesById.size} surface(s), focused ${focusedSummary}`);
	}
}
