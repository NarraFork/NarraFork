import { readWithTimeout, StreamSizeLimitError } from "../stream-timeout";

export interface SseFrame {
	event: string;
	data: string;
}

const MAX_EVENT_BYTES = 32 * 1024 * 1024;
const SCAN_SLICE_BYTES = 64 * 1024;
const YIELD_AFTER_BYTES = 1024 * 1024;

function checkSize(bytes: number): void {
	if (bytes > MAX_EVENT_BYTES) {
		throw new StreamSizeLimitError("SSE event", MAX_EVENT_BYTES, bytes);
	}
}

function isStandalonePayload(data: string): boolean {
	// Older relays omit the empty line between JSON events (and the final sentinel).
	// Only split independently complete values: a pretty-printed JSON object's
	// individual data lines must remain together, including whitespace-only lines.
	const trimmed = data.trim();
	if (trimmed === "[DONE]") return true;
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

class SseFrameDecoder {
	// BOM handling belongs to the stream, not each line. Flushing at a newline
	// also prevents malformed UTF-8 before it from swallowing the following line.
	private decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	private firstLine = true;
	private lineParts: string[] = [];
	private lineTail = "";
	private lineBytes = 0;
	private eventBytes = 0;
	private event = "";
	private data: string[] = [];
	private standalone: boolean | undefined;
	private eventAtData = "";
	private eventAfterData: string | undefined;
	private bytesAfterData = 0;

	private canSplit(): boolean {
		if (this.data.length !== 1) return false;
		this.standalone ??= isStandalonePayload(this.data[0]);
		return this.standalone;
	}

	append(bytes: Uint8Array): void {
		if (!bytes.length) return;
		this.lineBytes += bytes.length;
		checkSize(this.lineBytes);
		// A legacy no-blank-line stream needs one bounded line of lookahead before
		// deciding whether it belongs to this event or starts the next one.
		if (this.eventBytes + this.lineBytes > MAX_EVENT_BYTES && !this.canSplit()) {
			checkSize(this.eventBytes + this.lineBytes);
		}
		this.lineTail += this.decoder.decode(bytes, { stream: true });
		if (this.lineTail.length >= SCAN_SLICE_BYTES) {
			this.lineParts.push(this.lineTail);
			this.lineTail = "";
		}
	}

	finishLine(delimiterBytes: number): SseFrame | undefined {
		this.lineBytes += delimiterBytes;
		checkSize(this.lineBytes);
		this.lineParts.push(this.lineTail + this.decoder.decode());
		let line = this.lineParts.join("");
		const lineBytes = this.lineBytes;
		this.lineParts = [];
		this.lineTail = "";
		this.lineBytes = 0;
		if (this.firstLine) {
			this.firstLine = false;
			if (line.startsWith("\uFEFF")) line = line.slice(1);
		}
		if (!line) return this.flush();

		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		let frame: SseFrame | undefined;
		if (field === "data") {
			if (this.canSplit() && isStandalonePayload(value)) {
				frame = { event: this.eventAtData, data: this.data[0] };
				this.event = this.eventAfterData ?? "";
				this.eventBytes = this.bytesAfterData;
				this.data = [];
			}
			this.data.push(value);
			this.standalone = undefined;
			this.eventAtData = this.event;
			this.eventAfterData = undefined;
			this.bytesAfterData = 0;
		} else {
			if (field === "event") {
				this.event = value;
				if (this.data.length) this.eventAfterData = value;
			}
			if (this.data.length) this.bytesAfterData += lineBytes;
		}
		this.eventBytes += lineBytes;
		checkSize(this.eventBytes);
		return frame;
	}

	consumeLfAfterCr(): void {
		// The CR already finished the line. Do not charge the blank separator's LF
		// to the next event, but do count CRLF inside a still-open event.
		if (this.eventBytes) {
			checkSize(++this.eventBytes);
			if (this.bytesAfterData) this.bytesAfterData++;
		}
	}

	finish(): SseFrame | undefined {
		return this.lineBytes ? this.finishLine(0) : undefined;
	}

	flush(): SseFrame | undefined {
		const frame = this.data.length ? { event: this.event, data: this.data.join("\n") } : undefined;
		this.event = "";
		this.data = [];
		this.eventBytes = 0;
		this.standalone = undefined;
		this.eventAtData = "";
		this.eventAfterData = undefined;
		this.bytesAfterData = 0;
		return frame;
	}
}

/**
 * Decode bounded SSE frames without limiting the duration/total size of a stream.
 * The reader belongs to this generator: early return/consumer failure cancels it,
 * while normal EOF only releases its lock. Payload interpretation stays upstream.
 */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
	const reader = body.getReader();
	const decoder = new SseFrameDecoder();
	let eof = false;
	let skipLf = false;
	let scannedSinceYield = 0;
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) {
				eof = true;
				break;
			}
			// Do not decode/split a potentially huge upstream chunk all at once.
			for (let offset = 0; offset < value.length; offset += SCAN_SLICE_BYTES) {
				const end = Math.min(offset + SCAN_SLICE_BYTES, value.length);
				let start = offset;
				for (let i = offset; i < end; i++) {
					const byte = value[i];
					if (skipLf) {
						skipLf = false;
						if (byte === 10) {
							decoder.consumeLfAfterCr();
							start = i + 1;
							continue;
						}
					}
					if (byte !== 10 && byte !== 13) continue;
					decoder.append(value.subarray(start, i));
					const frame = decoder.finishLine(1);
					start = i + 1;
					skipLf = byte === 13;
					if (frame) yield frame;
				}
				decoder.append(value.subarray(start, end));
				scannedSinceYield += end - offset;
				if (scannedSinceYield >= YIELD_AFTER_BYTES) {
					scannedSinceYield = 0;
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
				}
			}
		}
		const finalLineFrame = decoder.finish();
		if (finalLineFrame) yield finalLineFrame;
		const finalFrame = decoder.flush();
		if (finalFrame) yield finalFrame;
	} finally {
		// A source's cancellation hook may never settle; it must not block cleanup
		// or replace a consumer error. cancel() closes the reader immediately.
		if (!eof) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
