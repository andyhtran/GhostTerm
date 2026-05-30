import { init as initGhosttyWeb } from "ghostty-web";

let ghosttyInitPromise: Promise<void> | null = null;

export function ensureGhosttyWeb(): Promise<void> {
	ghosttyInitPromise ??= initGhosttyWeb();
	return ghosttyInitPromise;
}
