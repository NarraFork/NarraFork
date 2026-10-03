import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { MemoryProfileError, PROFILE_LIMITS } from "./memory-profile-constants";

export interface TraceEvent {
	name?: string;
	ph?: string;
	pid?: number;
	tid?: number;
	ts?: number;
	dur?: number;
	args?: Record<string, unknown>;
}
type Frame = {
	kind: "object" | "array";
	state: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
	key?: string;
	events?: boolean;
};

/** Validates the JSON envelope, retaining only one bounded traceEvents object at a time. */
class TraceParser {
	private frames: Frame[] = [];
	private started = false;
	private done = false;
	private foundEvents = false;
	private seenEventsKey = false;
	private eventCount = 0;
	private mode: "string" | "primitive" | null = null;
	private escaped = false;
	private unicode = 0;
	private key = false;
	private keyBytes: number[] = [];
	private keyTooLong = false;
	private primitive = "";
	private readonly eventBuffer = Buffer.allocUnsafe(PROFILE_LIMITS.traceEventBytes);
	private capture: Buffer | null = null;
	private captureLength = 0;
	private captureDepth = 0;

	private invalid(): never {
		throw new MemoryProfileError("gc_trace_invalid");
	}
	private value(): void {
		const frame = this.frames.at(-1);
		if (!frame || (frame.state !== "value" && frame.state !== "valueOrEnd")) this.invalid();
		frame.state = "commaOrEnd";
	}
	private token(token: "string" | "primitive", keyValue?: string): void {
		const frame = this.frames.at(-1);
		if (!frame) this.invalid();
		if (frame.kind === "object" && (frame.state === "key" || frame.state === "keyOrEnd")) {
			if (token !== "string") this.invalid();
			if (this.frames.length === 1 && keyValue === "traceEvents") {
				if (this.seenEventsKey) this.invalid();
				this.seenEventsKey = true;
			}
			frame.key = keyValue;
			frame.state = "colon";
		} else {
			if (frame.events) this.invalid();
			this.value();
		}
	}
	private structure(char: string): void {
		const frame = this.frames.at(-1);
		if (char === "{" || char === "[") {
			let events = false;
			if (!this.started) {
				if (char !== "{") this.invalid();
				this.started = true;
			} else {
				if (this.done) this.invalid();
				if (frame?.events && char !== "{") this.invalid();
				events = this.frames.length === 1 && frame?.key === "traceEvents";
				if (events) {
					if (this.foundEvents || char !== "[") this.invalid();
					this.foundEvents = true;
				}
				this.value();
			}
			this.frames.push({
				kind: char === "{" ? "object" : "array",
				state: char === "{" ? "keyOrEnd" : "valueOrEnd",
				events,
			});
			if (this.frames.length > PROFILE_LIMITS.traceDepth)
				throw new MemoryProfileError("gc_trace_depth_limit");
		} else if (char === "}" || char === "]") {
			if (!frame || frame.kind !== (char === "}" ? "object" : "array")) this.invalid();
			if (!["keyOrEnd", "valueOrEnd", "commaOrEnd"].includes(frame.state)) this.invalid();
			this.frames.pop();
			if (!this.frames.length) this.done = true;
		} else if (char === ":") {
			if (frame?.state !== "colon") this.invalid();
			frame.state = "value";
		} else if (char === ",") {
			if (frame?.state !== "commaOrEnd") this.invalid();
			frame.state = frame.kind === "object" ? "key" : "value";
		} else this.invalid();
	}

	*feed(chunk: Buffer): Generator<TraceEvent> {
		for (const byte of chunk) {
			const char = String.fromCharCode(byte);
			const frame = this.frames.at(-1);
			if (!this.capture && !this.mode && char === "{" && frame?.events) {
				if (++this.eventCount > PROFILE_LIMITS.traceEvents)
					throw new MemoryProfileError("gc_trace_events_limit");
				this.capture = this.eventBuffer;
				this.captureLength = 0;
				this.captureDepth = this.frames.length;
			}
			if (this.capture) {
				if (this.captureLength >= PROFILE_LIMITS.traceEventBytes)
					throw new MemoryProfileError("gc_trace_event_bytes_limit");
				this.capture[this.captureLength++] = byte;
			}
			if (this.mode === "primitive") {
				if (!/[\s,\]}]/.test(char)) {
					this.primitive += char;
					if (this.primitive.length > 128) this.invalid();
					continue;
				}
				if (
					!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.primitive)
				)
					this.invalid();
				this.mode = null;
				this.primitive = "";
				this.token("primitive");
			}
			if (this.mode === "string") {
				if (this.key && !this.keyTooLong) {
					if (this.keyBytes.length < 256) this.keyBytes.push(byte);
					else this.keyTooLong = true;
				}
				if (this.unicode) {
					if (!/[0-9a-fA-F]/.test(char)) this.invalid();
					this.unicode--;
				} else if (this.escaped) {
					this.escaped = false;
					if (char === "u") this.unicode = 4;
					else if (!'"\\/bfnrt'.includes(char)) this.invalid();
				} else if (char === "\\") this.escaped = true;
				else if (char === '"') {
					this.mode = null;
					const value =
						this.key && !this.keyTooLong
							? JSON.parse(Buffer.from(this.keyBytes).toString("utf8"))
							: undefined;
					this.token("string", value);
				} else if (byte < 32) this.invalid();
				continue;
			}
			if (/[\t\n\r ]/.test(char)) continue;
			if (this.done) this.invalid();
			if (char === '"') {
				this.mode = "string";
				this.key =
					this.frames.length === 1 && (frame?.state === "key" || frame?.state === "keyOrEnd");
				this.keyBytes = this.key ? [byte] : [];
				this.keyTooLong = false;
			} else if ("{}[]:,".includes(char)) this.structure(char);
			else {
				if (!this.started) this.invalid();
				this.mode = "primitive";
				this.primitive = char;
			}
			if (this.capture && this.frames.length === this.captureDepth) {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(
					this.capture.subarray(0, this.captureLength),
				);
				const event: TraceEvent = JSON.parse(text);
				this.capture = null;
				yield event;
			}
		}
	}
	finish(): void {
		if (!this.done || !this.foundEvents || this.mode || this.capture) this.invalid();
	}
}

export async function* readTraceEvents(
	inputPath: string,
	signal: AbortSignal,
): AsyncGenerator<TraceEvent> {
	try {
		if (signal.aborted) throw new MemoryProfileError("cancelled");
		if ((await stat(inputPath)).size > PROFILE_LIMITS.traceBytes)
			throw new MemoryProfileError("gc_trace_bytes_limit");
		const parser = new TraceParser();
		const utf8 = new TextDecoder("utf-8", { fatal: true });
		const stream = createReadStream(inputPath, { highWaterMark: 64 * 1024, signal });
		let bytes = 0;
		for await (const chunk of stream) {
			if (signal.aborted) throw new MemoryProfileError("cancelled");
			bytes += chunk.length;
			if (bytes > PROFILE_LIMITS.traceBytes) throw new MemoryProfileError("gc_trace_bytes_limit");
			utf8.decode(chunk, { stream: true });
			for (const event of parser.feed(chunk as Buffer)) {
				if (signal.aborted) throw new MemoryProfileError("cancelled");
				yield event;
			}
		}
		utf8.decode();
		parser.finish();
	} catch (error) {
		if (error instanceof MemoryProfileError) throw error;
		throw new MemoryProfileError(signal.aborted ? "cancelled" : "gc_trace_invalid");
	}
}
