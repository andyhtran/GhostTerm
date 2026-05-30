export type OutputMetadataEvent =
	| { type: "title"; title: string }
	| { type: "cwd"; payload: string }
	| { type: "osc8"; uri: string; text: string };

const MAX_PENDING_OSC_BYTES = 4096;
const MAX_OSC8_TEXT_LENGTH = 2048;
const ESCAPE = String.fromCharCode(0x1b);
const CSI_SEQUENCE_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");
const ESCAPE_SEQUENCE_PATTERN = new RegExp(`${ESCAPE}[ -/]*[@-~]`, "g");
const TERMINAL_CONTROL_PATTERN = new RegExp(`[${charRange(0x00, 0x08)}${charEscape(0x0b)}${charEscape(0x0c)}${charRange(0x0e, 0x1f)}${charEscape(0x7f)}]`, "g");

export class OutputMetadataParser {
	private pending = "";
	private activeOsc8Uri: string | null = null;
	private activeOsc8Text = "";

	feed(output: string): OutputMetadataEvent[] {
		if (!output) {
			return [];
		}

		const events: OutputMetadataEvent[] = [];
		const combined = `${this.pending}${output}`;
		this.pending = "";
		let index = 0;

		while (index < combined.length) {
			const oscStart = combined.indexOf("\x1b]", index);
			if (oscStart === -1) {
				this.consumeVisibleText(combined.slice(index));
				if (combined.endsWith("\x1b")) {
					this.pending = "\x1b";
				}
				break;
			}

			if (oscStart > index) {
				this.consumeVisibleText(combined.slice(index, oscStart));
			}

			const parsed = this.parseOsc(combined, oscStart);
			if (parsed.state === "incomplete") {
				this.pending = combined.slice(oscStart, oscStart + MAX_PENDING_OSC_BYTES);
				break;
			}
			if (parsed.state === "abandoned") {
				index = parsed.nextIndex;
				continue;
			}

			this.handleOsc(parsed.code, parsed.payload, events);
			index = parsed.nextIndex;
		}

		return events;
	}

	flush(): OutputMetadataEvent[] {
		this.pending = "";
		this.activeOsc8Uri = null;
		this.activeOsc8Text = "";
		return [];
	}

	private parseOsc(input: string, start: number):
		| { state: "complete"; code: string; payload: string; nextIndex: number }
		| { state: "incomplete" }
		| { state: "abandoned"; nextIndex: number } {
		const contentStart = start + 2;
		const nextOscStart = input.indexOf("\x1b]", contentStart);
		const belEnd = input.indexOf("\x07", contentStart);
		const stEnd = input.indexOf("\x1b\\", contentStart);
		const end = minNonNegative(belEnd, stEnd);

		if (nextOscStart !== -1 && (end === -1 || nextOscStart < end)) {
			return { state: "abandoned", nextIndex: nextOscStart };
		}
		if (end === -1) {
			return { state: "incomplete" };
		}

		const terminatorLength = stEnd === end ? 2 : 1;
		const body = input.slice(contentStart, end);
		const separator = body.indexOf(";");
		if (separator === -1) {
			return { state: "complete", code: body, payload: "", nextIndex: end + terminatorLength };
		}
		return {
			state: "complete",
			code: body.slice(0, separator),
			payload: body.slice(separator + 1),
			nextIndex: end + terminatorLength
		};
	}

	private handleOsc(code: string, payload: string, events: OutputMetadataEvent[]): void {
		if (code === "0" || code === "2") {
			events.push({ type: "title", title: payload });
			return;
		}
		if (code === "7") {
			events.push({ type: "cwd", payload });
			return;
		}
		if (code === "8") {
			this.handleOsc8(payload, events);
		}
	}

	private handleOsc8(payload: string, events: OutputMetadataEvent[]): void {
		const separator = payload.indexOf(";");
		if (separator === -1) {
			return;
		}
		const uri = payload.slice(separator + 1).trim();
		if (!uri) {
			if (this.activeOsc8Uri && this.activeOsc8Text.trim()) {
				events.push({
					type: "osc8",
					uri: this.activeOsc8Uri,
					text: normalizeVisibleText(this.activeOsc8Text)
				});
			}
			this.activeOsc8Uri = null;
			this.activeOsc8Text = "";
			return;
		}
		if (isSafeHttpUri(uri)) {
			this.activeOsc8Uri = uri;
			this.activeOsc8Text = "";
		} else {
			this.activeOsc8Uri = null;
			this.activeOsc8Text = "";
		}
	}

	private consumeVisibleText(text: string): void {
		if (!this.activeOsc8Uri || !text) {
			return;
		}
		this.activeOsc8Text = `${this.activeOsc8Text}${stripTerminalControls(text)}`.slice(0, MAX_OSC8_TEXT_LENGTH);
	}
}

export function stripTerminalControls(value: string): string {
	return value
		.replace(CSI_SEQUENCE_PATTERN, "")
		.replace(ESCAPE_SEQUENCE_PATTERN, "")
		.replace(TERMINAL_CONTROL_PATTERN, "")
		.replace(/\r\n|\r/g, "\n");
}

export function normalizeVisibleText(value: string): string {
	return stripTerminalControls(value).replace(/[ \t]+/g, " ").trim();
}

export function isSafeHttpUri(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

function minNonNegative(a: number, b: number): number {
	if (a === -1) {
		return b;
	}
	if (b === -1) {
		return a;
	}
	return Math.min(a, b);
}

function charRange(start: number, end: number): string {
	return `${charEscape(start)}-${charEscape(end)}`;
}

function charEscape(code: number): string {
	return `\\u${code.toString(16).padStart(4, "0")}`;
}
