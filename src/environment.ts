import { execFile } from "child_process";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const SANITIZED_ENV_KEYS = new Set([
	"TMUX",
	"TMUX_PANE",
	"STY",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION"
]);

export const SANITIZED_ENV_PREFIXES = ["VSCODE_", "ZED_"];

const PATH_HELPER = "/usr/libexec/path_helper";
const DEFAULT_TERM_PROGRAM = "obsidian-ghostterm";

export interface BuildGhostTermEnvOptions {
	base?: NodeJS.ProcessEnv;
	cols: number;
	rows: number;
	shell?: string | null;
	termProgramVersion?: string;
	platform?: NodeJS.Platform;
	homeDir?: string;
	systemPathEntries?: string[];
	extraPathEntries?: string[];
}

export function parseDarwinPathHelper(output: string): string[] {
	const match = output.match(/PATH="([^"]*)"/);
	return match?.[1]?.split(":").filter(Boolean) ?? [];
}

export function mergePathEntries(current: readonly string[], additions: readonly string[], caseInsensitive = false): string[] {
	const result = [...current.filter(Boolean)];
	const seen = new Set(result.map((entry) => caseInsensitive ? entry.toLowerCase() : entry));
	for (const entry of additions) {
		if (!entry) {
			continue;
		}
		const key = caseInsensitive ? entry.toLowerCase() : entry;
		if (!seen.has(key)) {
			result.push(entry);
			seen.add(key);
		}
	}
	return result;
}

export async function buildGhostTermEnv(options: BuildGhostTermEnvOptions): Promise<NodeJS.ProcessEnv> {
	const platform = options.platform ?? process.platform;
	const env = sanitizeEnv(options.base ?? process.env);
	const pathKey = pathEnvironmentKey(env, platform);
	const separator = platform === "win32" ? ";" : ":";
	const currentPath = (env[pathKey] ?? "").split(separator).filter(Boolean);
	const systemPath = options.systemPathEntries ?? await resolveSystemPath(platform);
	const extraPath = options.extraPathEntries ?? defaultExtraPathEntries(platform, options.homeDir ?? homedir());
	const mergedPath = mergePathEntries(currentPath, [...systemPath, ...extraPath], platform === "win32");
	if (mergedPath.length > 0) {
		env[pathKey] = mergedPath.join(separator);
	}

	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	env.TERM_PROGRAM = DEFAULT_TERM_PROGRAM;
	if (options.termProgramVersion) {
		env.TERM_PROGRAM_VERSION = options.termProgramVersion;
	}
	env.COLUMNS = clampDimension(options.cols).toString();
	env.LINES = clampDimension(options.rows).toString();
	if (options.shell) {
		env.SHELL = options.shell;
	}
	if (!hasUtf8Locale(env)) {
		env.LANG = "en_US.UTF-8";
		env.LC_CTYPE = "en_US.UTF-8";
	}
	return env;
}

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) {
			continue;
		}
		if (SANITIZED_ENV_KEYS.has(key) || SANITIZED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			continue;
		}
		env[key] = value;
	}
	return env;
}

function pathEnvironmentKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (platform !== "win32") {
		return "PATH";
	}
	return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

async function resolveSystemPath(platform: NodeJS.Platform): Promise<string[]> {
	if (platform !== "darwin" || !existsSync(PATH_HELPER)) {
		return [];
	}
	return new Promise((resolve) => {
		execFile(PATH_HELPER, ["-s"], {
			env: { PATH: "" },
			encoding: "utf8",
			timeout: 1000
		}, (error, stdout) => {
			resolve(error ? [] : parseDarwinPathHelper(stdout));
		});
	});
}

function defaultExtraPathEntries(platform: NodeJS.Platform, homeDir: string): string[] {
	if (platform === "win32") {
		return [];
	}
	return [
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		join(homeDir, ".cargo", "bin")
	].filter(isUsableDirectory);
}

function isUsableDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function hasUtf8Locale(env: NodeJS.ProcessEnv): boolean {
	return ["LC_ALL", "LC_CTYPE", "LANG"].some((key) => {
		const value = env[key];
		if (!value) {
			return false;
		}
		const upper = value.trim().toUpperCase();
		return upper.includes("UTF-8") || upper.includes("UTF8");
	});
}

function clampDimension(value: number): number {
	if (!Number.isFinite(value)) {
		return 80;
	}
	return Math.max(2, Math.min(1000, Math.floor(value)));
}
