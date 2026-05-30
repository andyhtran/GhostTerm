import type { ILink, ILinkProvider } from "ghostty-web";
import { isSafeHttpUri, normalizeVisibleText } from "./output-metadata";

export interface Osc8HyperlinkRecord {
	id: number;
	uri: string;
	text: string;
}

interface TerminalBufferLike {
	buffer: {
		active: {
			getLine(y: number): {
				length: number;
				translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
			} | undefined;
		};
	};
}

const MAX_LINK_RECORDS = 500;

export class Osc8LinkRegistry {
	private nextId = 1;
	private records: Osc8HyperlinkRecord[] = [];

	addLink(uri: string, text: string): void {
		const normalizedText = normalizeVisibleText(text);
		if (!normalizedText || !isSafeHttpUri(uri)) {
			return;
		}
		const existing = this.records.find((record) => record.uri === uri && record.text === normalizedText);
		if (existing) {
			return;
		}
		this.records.push({ id: this.nextId++, uri, text: normalizedText });
		if (this.records.length > MAX_LINK_RECORDS) {
			this.records.splice(0, this.records.length - MAX_LINK_RECORDS);
		}
	}

	clear(): void {
		this.records = [];
	}

	all(): readonly Osc8HyperlinkRecord[] {
		return this.records;
	}
}

export class Osc8LinkProvider implements ILinkProvider {
	constructor(
		private readonly terminal: TerminalBufferLike,
		private readonly registry: Osc8LinkRegistry
	) {}

	provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
		const line = this.terminal.buffer.active.getLine(y);
		if (!line) {
			callback(undefined);
			return;
		}

		const text = line.translateToString(false);
		const links: ILink[] = [];
		for (const record of this.registry.all()) {
			for (const range of findTextRanges(text, record.text)) {
				links.push({
					text: record.uri,
					range: {
						start: { x: range.start, y },
						end: { x: range.end, y }
					},
					activate: (event) => {
						if ((event.metaKey || event.ctrlKey) && isSafeHttpUri(record.uri)) {
							window.open(record.uri, "_blank", "noopener,noreferrer");
						}
					}
				});
			}
		}

		callback(links.length > 0 ? links : undefined);
	}
}

export function findTextRanges(line: string, needle: string): Array<{ start: number; end: number }> {
	if (!needle) {
		return [];
	}
	const ranges: Array<{ start: number; end: number }> = [];
	let index = 0;
	while (index <= line.length) {
		const found = line.indexOf(needle, index);
		if (found === -1) {
			break;
		}
		ranges.push({ start: found, end: found + needle.length - 1 });
		index = found + Math.max(needle.length, 1);
	}
	return ranges;
}
