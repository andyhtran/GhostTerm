import type { App } from "obsidian";
import { statSync } from "fs";

export function getVaultBasePath(app: App): string {
	const adapter = app.vault.adapter as { getBasePath?: () => string };
	return adapter.getBasePath?.() ?? process.cwd();
}

export function isUsableDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
