import { createHash } from "crypto";
import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { helperBase64, helperSha256, helperSize } from "ghostterm-embedded-helper";

let helperBytes: Buffer | null = null;

export async function ensureBundledHelper(helperPath: string): Promise<void> {
	const bytes = embeddedHelperBytes();
	if (bytes.byteLength !== helperSize) {
		throw new Error("embedded helper size mismatch");
	}
	const currentHash = await fileSha256(helperPath).catch(() => null);
	if (currentHash !== helperSha256) {
		await mkdir(dirname(helperPath), { recursive: true });
		await writeFile(helperPath, bytes, { mode: 0o755 });
	}
	await chmod(helperPath, 0o755);
}

function embeddedHelperBytes(): Buffer {
	helperBytes ??= Buffer.from(helperBase64, "base64");
	return helperBytes;
}

async function fileSha256(path: string): Promise<string> {
	const content = await readFile(path);
	return createHash("sha256").update(content).digest("hex");
}
