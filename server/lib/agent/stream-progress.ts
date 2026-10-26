/**
 * Transport-level progress of one streamed provider attempt.
 *
 * The agent loop's first-activity / idle timers only count *parsed provider events*.
 * Bytes on the wire are a separate dimension: a gateway may send response headers and
 * SSE keep-alive comments (`:\n\n`) for minutes without the model producing anything.
 * This tracker never extends a timer — heartbeats prove the connection is alive, not that
 * the model is generating — it only lets a timeout say which phase the attempt stalled in.
 *
 * Only low-sensitivity counters and timestamps are kept; no body content is retained.
 */

const COLON = 0x3a;
const LF = 0x0a;
const CR = 0x0d;

/** Where an attempt was when it stopped producing provider events. */
export type StreamStallPhase =
	/** No HTTP response headers arrived. */
	| "no_response_headers"
	/** Headers arrived, but no response body bytes. */
	| "headers_only"
	/** Body bytes arrived, but only SSE comments/keep-alives. */
	| "heartbeat_only"
	/** Non-comment body data arrived, but none of it became a provider event. */
	| "unparsed_data";

export interface StreamProgressSnapshot {
	/** Whether a provider reported transport progress for this attempt at all. */
	tracked: boolean;
	statusCode?: number;
	headersAfterMs?: number;
	firstByteAfterMs?: number;
	lastByteAfterMs?: number;
	bytes: number;
	/** SSE comment lines (keep-alive heartbeats) received in this attempt. */
	heartbeats: number;
	/** Non-comment SSE lines (`data:`, `event:`, …) received in this attempt. */
	dataLines: number;
	/** Heartbeats received since {@link StreamProgress.markEvent}. */
	heartbeatsSinceEvent: number;
	/** Bytes received since {@link StreamProgress.markEvent}. */
	bytesSinceEvent: number;
}

export class StreamProgress {
	private startedAt = 0;
	private tracked = false;
	private statusCode?: number;
	private headersAt?: number;
	private firstByteAt?: number;
	private lastByteAt?: number;
	private bytes = 0;
	private heartbeats = 0;
	private dataLines = 0;
	private heartbeatsAtEvent = 0;
	private bytesAtEvent = 0;
	/** Line classification state carried across chunk boundaries. */
	private atLineStart = true;
	private previousWasCr = false;

	constructor(private readonly now: () => number = Date.now) {}

	/** Start a fresh HTTP attempt (a provider may re-send inside one `chat()` call). */
	beginAttempt(): void {
		this.startedAt = this.now();
		this.tracked = true;
		this.statusCode = undefined;
		this.headersAt = undefined;
		this.firstByteAt = undefined;
		this.lastByteAt = undefined;
		this.bytes = 0;
		this.heartbeats = 0;
		this.dataLines = 0;
		this.heartbeatsAtEvent = 0;
		this.bytesAtEvent = 0;
		this.atLineStart = true;
		this.previousWasCr = false;
	}

	onHeaders(statusCode: number): void {
		if (!this.tracked) this.beginAttempt();
		this.statusCode = statusCode;
		this.headersAt = this.now();
	}

	/** O(n) scan of the chunk; only the first byte of each line is inspected. */
	onBytes(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		if (!this.tracked) this.beginAttempt();
		const at = this.now();
		this.firstByteAt ??= at;
		this.lastByteAt = at;
		this.bytes += chunk.byteLength;
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i];
			if (byte === LF) {
				// CRLF already ended the line at the CR.
				if (!this.previousWasCr) this.atLineStart = true;
				this.previousWasCr = false;
				continue;
			}
			this.previousWasCr = byte === CR;
			if (byte === CR) {
				this.atLineStart = true;
				continue;
			}
			if (!this.atLineStart) continue;
			this.atLineStart = false;
			if (byte === COLON) this.heartbeats++;
			else this.dataLines++;
		}
	}

	/** A provider event was parsed; later counters measure the gap since it. */
	markEvent(): void {
		this.heartbeatsAtEvent = this.heartbeats;
		this.bytesAtEvent = this.bytes;
	}

	snapshot(): StreamProgressSnapshot {
		const since = (at: number | undefined) =>
			at === undefined ? undefined : Math.max(0, at - this.startedAt);
		return {
			tracked: this.tracked,
			...(this.statusCode !== undefined ? { statusCode: this.statusCode } : {}),
			...(this.headersAt !== undefined ? { headersAfterMs: since(this.headersAt) } : {}),
			...(this.firstByteAt !== undefined ? { firstByteAfterMs: since(this.firstByteAt) } : {}),
			...(this.lastByteAt !== undefined ? { lastByteAfterMs: since(this.lastByteAt) } : {}),
			bytes: this.bytes,
			heartbeats: this.heartbeats,
			dataLines: this.dataLines,
			heartbeatsSinceEvent: this.heartbeats - this.heartbeatsAtEvent,
			bytesSinceEvent: this.bytes - this.bytesAtEvent,
		};
	}

	/** Undefined when no provider reported transport progress (WebSocket, plugins, …). */
	stallPhase(): StreamStallPhase | undefined {
		if (!this.tracked) return undefined;
		if (this.headersAt === undefined) return "no_response_headers";
		if (this.bytes === 0) return "headers_only";
		if (this.dataLines === 0) return "heartbeat_only";
		return "unparsed_data";
	}
}

/** Human-readable reason for a first-activity timeout; keeps the "First token timeout" prefix. */
export function describeFirstTokenTimeout(
	provider: string,
	timeoutMs: number,
	progress: StreamProgress | undefined,
): string {
	const prefix = `${provider}: First token timeout after ${Math.round(timeoutMs / 1000)}s`;
	const snapshot = progress?.snapshot();
	switch (progress?.stallPhase()) {
		case "no_response_headers":
			return `${prefix}: no response headers received`;
		case "headers_only":
			return `${prefix}: response headers received (HTTP ${snapshot?.statusCode}) but no response body`;
		case "heartbeat_only":
			return `${prefix}: received ${snapshot?.heartbeats} keep-alive heartbeat(s) but no model event`;
		case "unparsed_data":
			return `${prefix}: received ${snapshot?.bytes} bytes of response data but no parseable model event`;
		default:
			return `${prefix} without upstream activity`;
	}
}

/** Human-readable reason for an idle timeout after at least one provider event. */
export function describeStreamIdleTimeout(
	provider: string,
	timeoutMs: number,
	progress: StreamProgress | undefined,
): string {
	const base = `${provider}: Stream idle timeout after ${Math.round(timeoutMs / 1000)}s without a parsed stream event`;
	const snapshot = progress?.snapshot();
	if (!snapshot?.tracked) return base;
	if (snapshot.bytesSinceEvent === 0) return `${base} (no data received)`;
	if (snapshot.heartbeatsSinceEvent > 0 && snapshot.bytesSinceEvent > 0) {
		return `${base} (${snapshot.heartbeatsSinceEvent} keep-alive heartbeat(s), ${snapshot.bytesSinceEvent} bytes received)`;
	}
	return `${base} (${snapshot.bytesSinceEvent} bytes received)`;
}
