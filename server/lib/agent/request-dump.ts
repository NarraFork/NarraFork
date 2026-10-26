import type {
	RecordingFrame,
	RecordingPinReason,
	RecordingRequest,
	RequestRecording,
} from "@shared/request-recording";
import { readWithTimeout } from "../stream-timeout";
import type { StreamProgress } from "./stream-progress";

/** Request metadata a provider reports at the start of each transport attempt. */
export interface RecordingAttemptRequest extends RecordingRequest {
	/** Structured body; serialized once when the provider did not pass `bodyText`. */
	body?: unknown;
}

/** Response metadata; body bytes travel separately through `appendResponseText`. */
export interface RecordingResponseMeta {
	status?: number;
	headers?: Record<string, string>;
	error?: string;
	errorTruncated?: boolean;
	bodyBytesReceived?: number;
	bodyTruncated?: boolean;
	bodyIncomplete?: boolean;
}

/** Byte cap for bounded error-body prefixes read into memory (1 MB). */
export const DEFAULT_DUMP_MAX_BYTES = 1024 * 1024;
/** Negative/unlimited settings still obey this in-memory safety ceiling. */
export const HARD_DUMP_MAX_BYTES = 32 * 1024 * 1024;
/** Request bodies above this are not parsed for the malformed-request structural summary. */
const MAX_SUMMARY_PARSE_BYTES = 32 * 1024 * 1024;

/** Retains a UTF-8 prefix, never allocates an encoding of an unbounded input string. */
export class BoundedUtf8Capture {
	private parts: Uint8Array[] = [];
	private sealed = false;
	private store(value: Uint8Array): void {
		let offset = 0;
		while (offset < value.length) {
			const position = this.kept % 65536;
			if (position === 0) this.parts.push(new Uint8Array(Math.min(65536, this.limit - this.kept)));
			const part = this.parts[this.parts.length - 1];
			const size = Math.min(part.length - position, value.length - offset);
			part.set(value.subarray(offset, offset + size), position);
			this.kept += size;
			offset += size;
		}
	}
	kept = 0;
	received = 0;
	readonly limit: number;
	constructor(limit = DEFAULT_DUMP_MAX_BYTES) {
		this.limit =
			Number.isFinite(limit) && limit >= 0
				? Math.min(Math.floor(limit), HARD_DUMP_MAX_BYTES)
				: HARD_DUMP_MAX_BYTES;
	}
	append(value: string | Uint8Array): void {
		if (typeof value === "string") {
			this.received += Buffer.byteLength(value, "utf8");
			const remaining = this.limit - this.kept;
			if (remaining <= 0 || this.sealed) return;
			const target = new Uint8Array(Math.min(remaining, value.length * 3));
			const { written } = new TextEncoder().encodeInto(value, target);
			if (written) this.store(target.subarray(0, written));
			if (this.received > this.kept) this.sealed = true;
		} else {
			this.received += value.byteLength;
			if (this.sealed) return;
			const size = Math.min(value.byteLength, this.limit - this.kept);
			if (size > 0) this.store(value.subarray(0, size));
			if (size < value.byteLength) this.sealed = true;
		}
	}
	text(): string {
		// stream:true omits a partial trailing codepoint rather than inventing U+FFFD.
		return new TextDecoder().decode(Buffer.concat(this.parts, this.kept), { stream: true });
	}
}

/** Pull-only tap: no tee, no background drain, and cleanup preserves a partial prefix. */
export function captureResponseStream(
	source: ReadableStream<Uint8Array>,
	collector?: ApiRequestDumpCollector,
	progress?: StreamProgress,
): { stream: ReadableStream<Uint8Array>; finish: () => void } {
	if (!collector && !progress) return { stream: source, finish: () => {} };
	const reader = source.getReader();
	let complete = false;
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		collector?.finishResponseCapture(complete);
		void reader.cancel().catch(() => {});
	};
	const stream = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (finished) {
						controller.close();
						return;
					}
					if (done) {
						complete = true;
						controller.close();
						finish();
					} else {
						progress?.onBytes(value);
						collector?.appendResponseText(value);
						controller.enqueue(value);
					}
				} catch (error) {
					if (finished) return;
					collector?.setResponseError(error);
					controller.error(error);
					finish();
				}
			},
			cancel: finish,
		},
		{ highWaterMark: 0 },
	);
	return { stream, finish };
}

/** Bounded error-body read; also cancels the pull tap when the prefix cap is reached. */
export async function readResponsePrefix(
	response: Response,
	maxBytes = DEFAULT_DUMP_MAX_BYTES,
): Promise<string> {
	if (!response.body) return "";
	const capture = new BoundedUtf8Capture(maxBytes);
	const reader = response.body.getReader();
	try {
		while (capture.received < capture.limit) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			capture.append(value);
		}
		return capture.text();
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

const SENSITIVE_HEADER_PATTERNS = [
	/^authorization$/i,
	/^x-api-key$/i,
	/^api-key$/i,
	/^x-goog-api-key$/i,
	/^proxy-authorization$/i,
	/^cookie$/i,
	/^set-cookie$/i,
];

function isSensitiveHeader(name: string): boolean {
	return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(name));
}

function maskHeaderValue(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	return value;
}

export function sanitizeHeaders(
	headers?: Headers | Record<string, string> | Record<string, unknown>,
): Record<string, string> | undefined {
	if (!headers) return undefined;

	const entries =
		headers instanceof Headers
			? [...headers.entries()]
			: Object.entries(headers).map(([key, value]) => [key, String(value)]);

	return Object.fromEntries(
		entries.map(([key, value]) => [key, isSensitiveHeader(key) ? maskHeaderValue(value) : value]),
	);
}

/**
 * Config keys whose string values are treated as secrets when sanitizing a
 * plugin-reported dump. The host resolves the plugin's config (credentials included)
 * and hands it to the plugin process, so these exact values are what may surface in a
 * reported URL (`?key=...`), header, or body even when the header name alone is not on
 * {@link SENSITIVE_HEADER_PATTERNS}.
 */
const SECRET_CONFIG_KEY_PATTERN = /key|token|secret|pass|credential/i;

/**
 * Values shorter than this are never masked: below it the false-positive rate on
 * ordinary config strings (regions, model aliases) outweighs the leak protection.
 */
const MIN_SECRET_VALUE_LENGTH = 8;

/**
 * Collect secret-looking string values from a plugin provider's resolved config.
 * Recursive because providers nest credentials (e.g. `{ auth: { apiKey } }`).
 */
export function collectSecretConfigValues(config: Record<string, unknown> | undefined): string[] {
	const secrets = new Set<string>();
	const walk = (value: unknown, key: string | undefined, depth: number): void => {
		if (depth > 8 || value == null) return;
		if (typeof value === "string") {
			if (key && SECRET_CONFIG_KEY_PATTERN.test(key) && value.length >= MIN_SECRET_VALUE_LENGTH) {
				secrets.add(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item, key, depth + 1);
			return;
		}
		if (typeof value === "object") {
			for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
				walk(child, childKey, depth + 1);
			}
		}
	};
	for (const [key, value] of Object.entries(config ?? {})) walk(value, key, 0);
	// Longest first so overlapping secrets never leave a recognizable fragment behind.
	return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of a known secret in plugin-reported dump text. Applied to
 * URLs and request bodies; headers go through {@link sanitizeHeaders} first, which only
 * masks by header NAME, so callers should run the result through this as well.
 */
export function maskSecretValues(text: string, secrets: readonly string[]): string {
	let masked = text;
	for (const secret of secrets) {
		if (!secret) continue;
		const replacement = maskHeaderValue(secret);
		const urlEncoded = new URLSearchParams({ value: secret }).toString().slice(6);
		const encoded = new Set([
			secret,
			JSON.stringify(secret).slice(1, -1),
			urlEncoded,
			urlEncoded.replace(/\+/g, "%20"),
			urlEncoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
			Buffer.from(secret).toString("base64"),
			Buffer.from(secret).toString("base64url"),
		]);
		for (const value of encoded) masked = masked.split(value).join(replacement);
		// JSON may escape only SOME characters. Match literal/JSON-escaped/unicode
		// representations per UTF-16 unit, without decoding or rewriting the payload.
		const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = secret
			.split("")
			.map((char) => {
				const hex = char
					.charCodeAt(0)
					.toString(16)
					.padStart(4, "0")
					.replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
				const percent = [...Buffer.from(char)]
					.map(
						(byte) =>
							`%${byte
								.toString(16)
								.padStart(2, "0")
								.replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`)}`,
					)
					.join("");
				const alternatives = new Set([
					escapeRegex(char),
					escapeRegex(JSON.stringify(char).slice(1, -1)),
					`\\\\u${hex}`,
					percent,
				]);
				return `(?:${[...alternatives].join("|")})`;
			})
			.join("");
		masked = masked.replace(new RegExp(pattern, "g"), () => replacement);
	}
	return masked;
}

/**
 * Per-attempt bridge from a provider to the request recorder.
 *
 * Request evidence lives only in the recorder (ring window + pinned saves). The collector
 * never materializes a JSON copy of the request or response on the main thread: bodies are
 * forwarded as the exact bytes sent/received, metadata as bounded records.
 */
export class ApiRequestDumpCollector {
	private recordingFinished = false;
	/** Reference (not a copy) to the latest body, only for the malformed-request summary. */
	private lastRequestBodyText?: string;

	constructor(private readonly recording?: RequestRecording) {}

	/** Diagnostics must never interrupt the provider's business stream. */
	private record(action: (recording: RequestRecording) => void): void {
		if (!this.recording || this.recordingFinished) return;
		try {
			action(this.recording);
		} catch {
			// A failed recorder is observational only.
		}
	}

	frame(frame: RecordingFrame): void {
		this.record((recording) => recording.frame(frame));
	}

	/** Keep this request's evidence after it ends, regardless of the auto-pin policy. */
	pin(reason: RecordingPinReason): void {
		if (!this.recording) return;
		try {
			this.recording.pin(reason);
		} catch {
			// Observational only.
		}
	}

	finish(result?: { error?: string; status?: string }): void {
		this.record((recording) => recording.finish(result));
		this.recordingFinished = true;
	}

	beginResponseAttempt(request: RecordingAttemptRequest, recordBody = true): void {
		this.setRequest(request, recordBody);
	}

	setRequest(request: RecordingAttemptRequest, recordBody = true): void {
		const { body, bodyText, ...meta } = request;
		// Built-in providers pass the exact string they send; keep that reference.
		const serialized =
			bodyText ?? (body === undefined ? undefined : JSON.stringify(body, jsonReplacer));
		if (recordBody) this.lastRequestBodyText = serialized;
		this.record((recording) =>
			recording.request({ ...meta, bodyText: recordBody ? serialized : undefined }),
		);
	}

	appendResponseText(value: string | Uint8Array, record = true): void {
		if (record) this.record((recording) => recording.responseChunk(value));
	}

	finishResponseCapture(complete: boolean): void {
		this.setResponseMeta({ bodyIncomplete: !complete });
	}

	setResponseMeta(response: RecordingResponseMeta & Record<string, unknown>): void {
		const { bodyText: _bodyText, events: _events, ...meta } = response;
		if (Object.keys(meta).length) this.record((recording) => recording.responseMeta(meta));
	}

	setResponseError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const capture = new BoundedUtf8Capture(8192);
		capture.append(message);
		this.setResponseMeta({
			error: capture.text(),
			errorTruncated: capture.received > capture.kept,
		});
	}

	/**
	 * Parse the last recorded request body for a structural summary. Only used on the rare
	 * upstream "malformed request body" rejection; bounded by {@link MAX_SUMMARY_PARSE_BYTES}.
	 */
	lastRequestBody(): unknown {
		const text = this.lastRequestBodyText;
		if (text === undefined || text.length > MAX_SUMMARY_PARSE_BYTES) return undefined;
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}
}
