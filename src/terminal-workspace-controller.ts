import type { App } from "obsidian";
import { ClipboardPasteError, readClipboardForTerminalPaste } from "./clipboard-paste";
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
	surfaceIdsInNode,
	type SplitDirection,
	type SplitFocusTarget,
	type SplitNode,
	type TerminalTab
} from "./split-tree";
import { TerminalSurface } from "./terminal-surface";

type SurfaceRect = {
	id: string;
	rect: DOMRect;
	order: number;
	centerX: number;
	centerY: number;
};

type TabFocusTarget =
	| { type: "index"; index: number }
	| { type: "last" }
	| { type: "next" }
	| { type: "previous" };

type FontSizeAction =
	| { type: "increase"; amount: number }
	| { type: "decrease"; amount: number }
	| { type: "reset" };

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
		this.rootEl.dataset.tabCount = "0";

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

	focusSplit(target: SplitFocusTarget): void {
		const targetSurfaceId = this.findSplitFocusTarget(target);
		if (targetSurfaceId) {
			this.focusSurface(targetSurfaceId);
		}
	}

	focusTab(target: TabFocusTarget): void {
		const tab = this.findTabFocusTarget(target);
		if (!tab) {
			return;
		}
		this.activeTabId = tab.id;
		this.focusedSurfaceId = firstSurfaceId(tab.root);
		this.render();
		this.focusedSurface()?.focus();
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

	closeActiveTab(): void {
		const tab = this.activeTab();
		if (!tab) {
			return;
		}
		this.closeTab(tab.id, this.focusedSurface()?.cwd);
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
		const copyMode = copyToClipboardModeFromAction(action);
		if (copyMode) {
			event.preventDefault();
			event.stopImmediatePropagation();
			const selection = focused.getSelection();
			if (selection && navigator.clipboard) {
				void navigator.clipboard.writeText(selection).catch(() => undefined);
			} else if (copyMode === "mixed") {
				focused.writeInput("\x03");
			}
			return true;
		}
		if (action.startsWith("paste_from_clipboard")) {
			event.preventDefault();
			event.stopImmediatePropagation();
			void readClipboardForTerminalPaste().then((text) => {
				if (text) {
					focused.paste(text);
				}
			}).catch((error: unknown) => {
				if (error instanceof ClipboardPasteError) {
					this.setStatus(`${STATUS_PREFIX}: paste failed; ${error.message}`);
				}
			});
			return true;
		}
		if (action.startsWith("text:")) {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.writeInput(unescapeGhosttyText(action.slice(5)));
			return true;
		}
		if (action.startsWith("esc:")) {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.writeInput(`\x1b${unescapeGhosttyText(action.slice(4))}`);
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
		const splitTarget = splitFocusTargetFromAction(action);
		if (splitTarget) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.focusSplit(splitTarget);
			return true;
		}
		if (action === "new_tab") {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.newTab();
			return true;
		}
		if (action === "close_tab:this" || action === "close_tab") {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.closeActiveTab();
			return true;
		}
		const tabTarget = tabFocusTargetFromAction(action);
		if (tabTarget) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.focusTab(tabTarget);
			return true;
		}
		if (action === "clear_screen") {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.clearScreen();
			return true;
		}
		if (action === "select_all") {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.selectAll();
			return true;
		}
		if (action === "scroll_to_top") {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.scrollToTop();
			return true;
		}
		if (action === "scroll_to_bottom") {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.scrollToBottom();
			return true;
		}
		if (action === "scroll_page_up") {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.scrollPageUp();
			return true;
		}
		if (action === "scroll_page_down") {
			event.preventDefault();
			event.stopImmediatePropagation();
			focused.scrollPageDown();
			return true;
		}
		const fontSizeAction = fontSizeActionFromAction(action);
		if (fontSizeAction) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.applyFontSizeAction(fontSizeAction);
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

	private applyFontSizeAction(action: FontSizeAction): void {
		if (action.type === "reset") {
			for (const surface of this.surfacesById.values()) {
				surface.resetFontSize();
			}
			return;
		}
		const delta = action.type === "increase" ? action.amount : -action.amount;
		for (const surface of this.surfacesById.values()) {
			surface.adjustFontSize(delta);
		}
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
			if (this.plugin.ghostTermSettings.lastSurfaceCloseBehavior === "new-surface") {
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

	private findTabFocusTarget(target: TabFocusTarget): TerminalTab | null {
		if (this.tabs.length === 0) {
			return null;
		}
		if (target.type === "index") {
			return this.tabs[target.index] ?? null;
		}
		if (target.type === "last") {
			return this.tabs[this.tabs.length - 1] ?? null;
		}
		const activeIndex = Math.max(0, this.tabs.findIndex((tab) => tab.id === this.activeTabId));
		const offset = target.type === "next" ? 1 : -1;
		const nextIndex = (activeIndex + offset + this.tabs.length) % this.tabs.length;
		return this.tabs[nextIndex] ?? null;
	}

	private findSplitFocusTarget(target: SplitFocusTarget): string | null {
		const tab = this.activeTab();
		const focused = this.focusedSurface();
		if (!tab || !focused) {
			return null;
		}

		const surfaceIds = surfaceIdsInNode(tab.root).filter((surfaceId) => this.surfacesById.has(surfaceId));
		if (target === "next" || target === "previous") {
			return this.findSequentialSplitFocusTarget(surfaceIds, focused.id, target);
		}
		return this.findDirectionalSplitFocusTarget(surfaceIds, focused.id, target);
	}

	private findSequentialSplitFocusTarget(surfaceIds: string[], focusedSurfaceId: string, target: "next" | "previous"): string | null {
		const index = surfaceIds.indexOf(focusedSurfaceId);
		if (index === -1) {
			return null;
		}
		const nextIndex = target === "next" ? index + 1 : index - 1;
		return surfaceIds[nextIndex] ?? null;
	}

	private findDirectionalSplitFocusTarget(
		surfaceIds: string[],
		focusedSurfaceId: string,
		target: "up" | "down" | "left" | "right"
	): string | null {
		const rects = this.surfaceRects(surfaceIds);
		const focused = rects.find((entry) => entry.id === focusedSurfaceId);
		if (!focused) {
			return null;
		}

		let best: { entry: SurfaceRect; overlap: number; distance: number; centerOffset: number } | null = null;
		for (const entry of rects) {
			if (entry.id === focused.id) {
				continue;
			}
			const candidate = directionalCandidateScore(focused, entry, target);
			if (!candidate) {
				continue;
			}
			const scoredCandidate = { entry, ...candidate };
			if (!best || compareDirectionalCandidate(scoredCandidate, best) < 0) {
				best = scoredCandidate;
			}
		}
		return best?.entry.id ?? null;
	}

	private surfaceRects(surfaceIds: string[]): SurfaceRect[] {
		return surfaceIds.flatMap((surfaceId, order) => {
			const surface = this.surfacesById.get(surfaceId);
			if (!surface) {
				return [];
			}
			const rect = surface.containerEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				return [];
			}
			return [{
				id: surfaceId,
				rect,
				order,
				centerX: rect.left + rect.width / 2,
				centerY: rect.top + rect.height / 2
			}];
		});
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
		this.rootEl.dataset.tabCount = String(this.tabs.length);
		this.tabsEl.empty();
		for (const [index, tab] of this.tabs.entries()) {
			const title = this.titleForTab(tab);
			const shortcutLabel = this.shortcutLabelForTab(index);
			const tabEl = this.tabsEl.createEl("button", {
				cls: "ghostterm-tab",
				attr: {
					"aria-label": shortcutLabel
						? `${DISPLAY_NAME} tab ${title}, ${shortcutLabel}`
						: `${DISPLAY_NAME} tab ${title}`,
					"aria-selected": String(tab.id === this.activeTabId),
					role: "tab"
				}
			});
			tabEl.createEl("span", {
				cls: "ghostterm-tab-title",
				text: title
			});
			if (shortcutLabel) {
				tabEl.createEl("span", {
					cls: "ghostterm-tab-shortcut",
					text: shortcutLabel
				});
			}
			tabEl.addEventListener("click", () => {
				this.activeTabId = tab.id;
				this.focusedSurfaceId = firstSurfaceId(tab.root);
				this.render();
				this.focusedSurface()?.focus();
			});
		}
	}

	private shortcutLabelForTab(index: number): string | null {
		if (index >= 0 && index < 8) {
			return `\u2318${index + 1}`;
		}
		if (index === this.tabs.length - 1) {
			return "\u23189";
		}
		return null;
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
			splitEl.doc.body.removeClass("ghostterm-resizing");
			try {
				splitEl.releasePointerCapture(pointerId);
			} catch {
				// The pointer may already have been released by the browser.
			}
			this.scheduleFitAllSurfaces();
			this.focusedSurface()?.focus();
		};

		splitEl.doc.body.addClass("ghostterm-resizing");
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

function splitFocusTargetFromAction(action: string): SplitFocusTarget | null {
	if (!action.startsWith("goto_split:")) {
		return null;
	}
	const target = action.slice("goto_split:".length);
	if (target === "top") {
		return "up";
	}
	if (target === "bottom") {
		return "down";
	}
	return isSplitFocusTarget(target) ? target : null;
}

function isSplitFocusTarget(value: string): value is SplitFocusTarget {
	return value === "up" ||
		value === "down" ||
		value === "left" ||
		value === "right" ||
		value === "next" ||
		value === "previous";
}

function tabFocusTargetFromAction(action: string): TabFocusTarget | null {
	if (action === "last_tab") {
		return { type: "last" };
	}
	if (action === "next_tab") {
		return { type: "next" };
	}
	if (action === "previous_tab") {
		return { type: "previous" };
	}
	if (!action.startsWith("goto_tab:")) {
		return null;
	}
	const tabNumber = Number.parseInt(action.slice("goto_tab:".length), 10);
	return Number.isInteger(tabNumber) && tabNumber > 0
		? { type: "index", index: tabNumber - 1 }
		: null;
}

function copyToClipboardModeFromAction(action: string): "copy" | "mixed" | null {
	if (action === "copy_to_clipboard") {
		return "copy";
	}
	if (!action.startsWith("copy_to_clipboard:")) {
		return null;
	}
	return action.slice("copy_to_clipboard:".length) === "mixed" ? "mixed" : "copy";
}

function fontSizeActionFromAction(action: string): FontSizeAction | null {
	if (action === "reset_font_size") {
		return { type: "reset" };
	}
	if (action.startsWith("increase_font_size")) {
		return { type: "increase", amount: positiveActionAmount(action, 1) };
	}
	if (action.startsWith("decrease_font_size")) {
		return { type: "decrease", amount: positiveActionAmount(action, 1) };
	}
	return null;
}

function positiveActionAmount(action: string, fallback: number): number {
	const colonIndex = action.indexOf(":");
	if (colonIndex === -1) {
		return fallback;
	}
	const amount = Number.parseFloat(action.slice(colonIndex + 1));
	return Number.isFinite(amount) && amount > 0 ? amount : fallback;
}

function directionalCandidateScore(
	focused: SurfaceRect,
	candidate: SurfaceRect,
	target: "up" | "down" | "left" | "right"
): { overlap: number; distance: number; centerOffset: number } | null {
	const epsilon = 0.5;
	if (target === "up") {
		if (candidate.centerY >= focused.centerY - epsilon) {
			return null;
		}
		return {
			overlap: overlap(focused.rect.left, focused.rect.right, candidate.rect.left, candidate.rect.right),
			distance: Math.max(0, focused.rect.top - candidate.rect.bottom),
			centerOffset: Math.abs(candidate.centerX - focused.centerX)
		};
	}
	if (target === "down") {
		if (candidate.centerY <= focused.centerY + epsilon) {
			return null;
		}
		return {
			overlap: overlap(focused.rect.left, focused.rect.right, candidate.rect.left, candidate.rect.right),
			distance: Math.max(0, candidate.rect.top - focused.rect.bottom),
			centerOffset: Math.abs(candidate.centerX - focused.centerX)
		};
	}
	if (target === "left") {
		if (candidate.centerX >= focused.centerX - epsilon) {
			return null;
		}
		return {
			overlap: overlap(focused.rect.top, focused.rect.bottom, candidate.rect.top, candidate.rect.bottom),
			distance: Math.max(0, focused.rect.left - candidate.rect.right),
			centerOffset: Math.abs(candidate.centerY - focused.centerY)
		};
	}
	if (candidate.centerX <= focused.centerX + epsilon) {
		return null;
	}
	return {
		overlap: overlap(focused.rect.top, focused.rect.bottom, candidate.rect.top, candidate.rect.bottom),
		distance: Math.max(0, candidate.rect.left - focused.rect.right),
		centerOffset: Math.abs(candidate.centerY - focused.centerY)
	};
}

function compareDirectionalCandidate(
	a: { entry: SurfaceRect; overlap: number; distance: number; centerOffset: number },
	b: { entry: SurfaceRect; overlap: number; distance: number; centerOffset: number }
): number {
	const aHasOverlap = a.overlap > 0.5;
	const bHasOverlap = b.overlap > 0.5;
	if (aHasOverlap !== bHasOverlap) {
		return aHasOverlap ? -1 : 1;
	}
	if (a.distance !== b.distance) {
		return a.distance - b.distance;
	}
	if (a.overlap !== b.overlap) {
		return b.overlap - a.overlap;
	}
	if (a.centerOffset !== b.centerOffset) {
		return a.centerOffset - b.centerOffset;
	}
	return a.entry.order - b.entry.order;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
	return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
