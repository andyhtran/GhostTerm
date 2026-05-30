import { execFile } from "child_process";
import { isUsableDirectory } from "./vault";

export type ProcessCwd = { pid: number; cwd: string };

function execFileOutput(command: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(command, args, {
			encoding: "utf8",
			timeout: 1000
		}, (error, stdout) => {
			resolve(error ? null : stdout);
		});
	});
}

export async function currentCwdForChildProcess(parentPid: number | undefined, cachedPid: number | null): Promise<ProcessCwd | null> {
	if (!parentPid) {
		return null;
	}
	if (cachedPid) {
		const cwd = await cwdForPid(cachedPid);
		if (cwd) {
			return { pid: cachedPid, cwd };
		}
	}

	const output = await execFileOutput("/usr/bin/pgrep", ["-P", String(parentPid)]);
	const childPids = (output ?? "")
		.split(/\s+/)
		.map((value) => Number(value))
		.filter((value) => Number.isInteger(value) && value > 0);
	for (const pid of childPids) {
		const cwd = await cwdForPid(pid);
		if (cwd) {
			return { pid, cwd };
		}
	}
	return null;
}

async function cwdForPid(pid: number): Promise<string | null> {
	const output = await execFileOutput("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
	const cwd = (output ?? "")
		.split("\n")
		.find((line) => line.startsWith("n"))
		?.slice(1)
		.trim();
	return cwd && isUsableDirectory(cwd) ? cwd : null;
}
