import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

type ClipboardImage = {
	bytes: Buffer;
	extension: string;
};

type NativeImageLike = {
	isEmpty?: () => boolean;
	toPNG?: () => Buffer;
};

type ElectronClipboardLike = {
	readImage?: () => NativeImageLike;
	readText?: () => string;
};

type ElectronModuleLike = {
	clipboard?: ElectronClipboardLike;
};

type RuntimeRequire = (id: string) => unknown;

const maxClipboardImageBytes = 10 * 1024 * 1024;
const shellEscapeCharacters = new Set("\\ ~()[]{}<>\"'`!#$&;|*?\t");
const ownedClipboardImagePaths = new Set<string>();

export class ClipboardPasteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClipboardPasteError";
	}
}

export async function readClipboardForTerminalPaste(): Promise<string | null> {
	const text = await readClipboardText();
	if (text) {
		return text;
	}

	const image = await readClipboardImage();
	if (!image) {
		return null;
	}

	const filePath = await materializeClipboardImage(image);
	return escapeForShell(filePath);
}

export async function cleanupClipboardImageFiles(): Promise<void> {
	const paths = [...ownedClipboardImagePaths];
	ownedClipboardImagePaths.clear();
	await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
}

export function escapeForShell(value: string): string {
	if (value.includes("\n") || value.includes("\r")) {
		return `'${value.replaceAll("'", "'\\''")}'`;
	}
	return Array.from(value, (char) => shellEscapeCharacters.has(char) ? `\\${char}` : char).join("");
}

async function readClipboardText(): Promise<string | null> {
	const electronText = readElectronClipboardText();
	if (electronText) {
		return electronText;
	}

	const browserText = await readBrowserClipboardText();
	if (browserText) {
		return browserText;
	}

	return null;
}

async function readBrowserClipboardText(): Promise<string | null> {
	try {
		return await navigator.clipboard?.readText() || null;
	} catch {
		return null;
	}
}

function readElectronClipboardText(): string | null {
	try {
		return electronClipboard()?.readText?.() || null;
	} catch {
		return null;
	}
}

async function readClipboardImage(): Promise<ClipboardImage | null> {
	const electronImage = readElectronClipboardImage();
	if (electronImage) {
		return electronImage;
	}

	try {
		const image = await readBrowserClipboardImage();
		if (image) {
			return image;
		}
	} catch (error) {
		if (error instanceof ClipboardPasteError) {
			throw error;
		}
	}

	return null;
}

async function readBrowserClipboardImage(): Promise<ClipboardImage | null> {
	if (!navigator.clipboard?.read) {
		return null;
	}

	const items = await navigator.clipboard.read();
	for (const item of items) {
		const type = item.types.find((candidate) => candidate.startsWith("image/"));
		if (!type) {
			continue;
		}
		const blob = await item.getType(type);
		const bytes = Buffer.from(await blob.arrayBuffer());
		if (!bytes.byteLength) {
			continue;
		}
		return {
			bytes,
			extension: extensionForMimeType(type)
		};
	}

	return null;
}

function readElectronClipboardImage(): ClipboardImage | null {
	const nativeImage = electronClipboard()?.readImage?.();
	if (!nativeImage || nativeImage.isEmpty?.()) {
		return null;
	}

	const bytes = nativeImage.toPNG?.();
	if (!bytes?.byteLength) {
		return null;
	}

	return { bytes, extension: "png" };
}

async function materializeClipboardImage(image: ClipboardImage): Promise<string> {
	if (image.bytes.byteLength > maxClipboardImageBytes) {
		throw new ClipboardPasteError("clipboard image is larger than 10 MB");
	}

	const directory = join(tmpdir(), "ghostterm-clipboard");
	await mkdir(directory, { recursive: true });
	const filePath = join(directory, `clipboard-${timestampForFilename()}-${randomUUID().slice(0, 8)}.${image.extension}`);
	try {
		await writeFile(filePath, image.bytes);
	} catch (error) {
		await unlink(filePath).catch(() => undefined);
		throw new ClipboardPasteError(error instanceof Error ? error.message : "could not save clipboard image");
	}

	ownedClipboardImagePaths.add(filePath);
	return filePath;
}

function extensionForMimeType(type: string): string {
	switch (type.toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/svg+xml":
			return "svg";
		case "image/tiff":
			return "tiff";
		case "image/webp":
			return "webp";
		case "image/png":
		default:
			return "png";
	}
}

function timestampForFilename(date = new Date()): string {
	const parts = [
		date.getFullYear(),
		pad2(date.getMonth() + 1),
		pad2(date.getDate())
	];
	return `${parts.join("-")}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

function electronClipboard(): ElectronClipboardLike | null {
	const runtimeRequire = runtimeRequireFunction();
	if (!runtimeRequire) {
		return null;
	}

	try {
		const electron = runtimeRequire("electron") as ElectronModuleLike;
		return electron.clipboard ?? null;
	} catch {
		return null;
	}
}

function runtimeRequireFunction(): RuntimeRequire | null {
	if (typeof require === "function") {
		return require;
	}
	const globalRequire = (window as Window & { require?: RuntimeRequire }).require;
	return typeof globalRequire === "function" ? globalRequire : null;
}
