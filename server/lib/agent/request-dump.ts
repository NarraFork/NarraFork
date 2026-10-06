import type { ApiRequestDiagnostics } from "./types";

export interface ApiRequestDump {
	provider?: string;
	model?: string;
	diagnostics?: ApiRequestDiagnostics;
	/**
	 * Annotation attached by a special-case capture (currently only the upstream
	 * "malformed request body" rejection).
	 *
	 * Deliberately an ADDITIONAL field rather than a replacement for the dump: a user who
	 * opens a dump is asking what was sent, and answering with a structural summary while
	 * dropping the request itself is the one outcome the dump exists to prevent. Size is
	 * handled downstream by spilling the whole dump to a file, not by discarding parts of it.
	 */
	capture?: unknown;
	/** Earlier transport attempts; request previews are explicitly bounded. */
	attempts?: Array<{ requestText: string; response?: ApiRequestDump["response"] }>;
	attemptsTruncated?: boolean;
	/** Never erase the original request when a reconnect/fallback changes the payload. */
	initialRequest?: ApiRequestDump["request"];
	request?: {
		transport?: string;
		url?: string;
		headers?: Record<string, string>;
		body?: unknown;
	};
	response?: {
		status?: number;
		headers?: Record<string, string>;
		bodyText?: string;
		events?: unknown[];
		error?: string;
		errorTruncated?: boolean;
		bodyBytesReceived?: number;
		bodyBytesKept?: number;
		bodyTruncated?: boolean;
		bodyIncomplete?: boolean;
	};
}

/** Default byte cap for a persisted raw dump's response body / events (1 MB). */
export const DEFAULT_DUMP_MAX_BYTES = 1024 * 1024;
/** Hard cap on the number of stored SSE events in a raw dump. */
export const MAX_DUMP_EVENT_COUNT = 2000;

/** Negative/unlimited settings still obey this in-memory safety ceiling. */
export const HARD_DUMP_MAX_BYTES = 32 * 1024 * 1024;
export function responseDumpBudget(value = DEFAULT_DUMP_MAX_BYTES): number {
	return Number.isFinite(value) && value >= 0
		? Math.min(Math.floor(value), HARD_DUMP_MAX_BYTES)
		: HARD_DUMP_MAX_BYTES;
}

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
		this.limit = responseDumpBudget(limit);
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
): { stream: ReadableStream<Uint8Array>; finish: () => void } {
	if (!collector) return { stream: source, finish: () => {} };
	const reader = source.getReader();
	let complete = false;
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		collector.finishResponseCapture(complete);
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
						collector.appendResponseText(value);
						controller.enqueue(value);
					}
				} catch (error) {
					if (finished) return;
					collector.setResponseError(error);
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

function toJsonSafe<T>(value: T): T {
	if (value == null) return value;
	try {
		return JSON.parse(JSON.stringify(value, jsonReplacer)) as T;
	} catch {
		return value;
	}
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

export class ApiRequestDumpCollector {
	private dump: ApiRequestDump;
	private responseCapture?: BoundedUtf8Capture;
	private responseBudgetUsed = 0;

	beginResponseAttempt(
		request: NonNullable<ApiRequestDump["request"]>,
		maxBytes = DEFAULT_DUMP_MAX_BYTES,
	): void {
		this.flushResponseCapture();
		if (this.dump.request) {
			this.dump.initialRequest ??= this.dump.request;
			this.dump.attempts ??= [];
			const attempts = this.dump.attempts;
			if (attempts.length < 16) {
				const preview = new BoundedUtf8Capture(64 * 1024);
				preview.append(JSON.stringify(this.dump.request));
				attempts.push({
					requestText:
						preview.text() +
						(preview.received > preview.kept ? "\n[request preview truncated]" : ""),
					response: this.dump.response,
				});
			} else this.dump.attemptsTruncated = true;
		}
		this.responseBudgetUsed += this.responseCapture?.kept ?? 0;
		this.responseCapture = new BoundedUtf8Capture(
			Math.max(0, responseDumpBudget(maxBytes) - this.responseBudgetUsed),
		);
		this.dump.response = { bodyIncomplete: true };
		this.setRequest(request);
	}

	appendResponseText(value: string | Uint8Array): void {
		this.responseCapture?.append(value);
	}

	finishResponseCapture(complete: boolean): void {
		if (this.responseCapture) this.setResponseMeta({ bodyIncomplete: !complete });
		this.flushResponseCapture();
	}

	private flushResponseCapture(): void {
		const capture = this.responseCapture;
		if (!capture) return;
		this.setResponseMeta({
			bodyText: capture.text(),
			bodyBytesReceived: capture.received,
			bodyBytesKept: capture.kept,
			bodyTruncated: capture.received > capture.kept,
		});
	}

	constructor(initial?: ApiRequestDump) {
		this.dump = toJsonSafe(initial ?? {});
	}

	setRequest(request: NonNullable<ApiRequestDump["request"]>): void {
		this.dump.request = toJsonSafe(request);
	}

	setResponseMeta(response: Partial<NonNullable<ApiRequestDump["response"]>>): void {
		this.dump.response = {
			...(this.dump.response ?? {}),
			...toJsonSafe(response),
		};
	}

	setResponseBodyText(bodyText: string): void {
		this.setResponseMeta({ bodyText });
	}

	setResponseBodyTextWithLimit(bodyText: string, maxSize: number): void {
		const capture = new BoundedUtf8Capture(maxSize);
		capture.append(bodyText);
		this.setResponseMeta({
			bodyText: capture.text(),
			bodyBytesReceived: capture.received,
			bodyBytesKept: capture.kept,
			bodyTruncated: capture.received > capture.kept,
		});
	}

	setResponseEvents(events: unknown[]): void {
		this.setResponseMeta({ events: toJsonSafe(events) });
	}

	/**
	 * Store response events with a hard cap on both element count and serialized byte
	 * size, so force-persisting a dump on leak detection cannot buffer an unbounded SSE
	 * stream (see CLAUDE.md backend memory rules). When the cap is exceeded, the head
	 * elements are kept and a truncation marker is appended.
	 */
	setResponseEventsWithLimit(events: unknown[], maxCount: number, maxBytes: number): void {
		const safe = toJsonSafe(events);
		if (!Array.isArray(safe)) {
			this.setResponseMeta({ events: safe });
			return;
		}

		let kept = maxCount >= 0 && safe.length > maxCount ? safe.slice(0, maxCount) : safe;
		let droppedForCount = safe.length - kept.length;

		// Enforce byte cap by trimming from the tail until under the limit.
		if (maxBytes >= 0) {
			while (kept.length > 0 && JSON.stringify(kept).length > maxBytes) {
				kept = kept.slice(0, -1);
				droppedForCount++;
			}
		}

		if (droppedForCount > 0) {
			this.setResponseMeta({
				events: [...kept, { _truncated: droppedForCount }],
			});
			return;
		}
		this.setResponseMeta({ events: kept });
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

	setDiagnostics(diagnostics: ApiRequestDiagnostics | undefined): void {
		if (!diagnostics) return;
		this.dump.diagnostics = toJsonSafe(diagnostics);
	}

	/**
	 * Attach a special-case capture annotation alongside the dump.
	 *
	 * Never touches `request`/`response`: the annotation is a pointer plus a structural
	 * summary, and the request it describes must remain in the dump next to it.
	 */
	setCapture(capture: unknown): void {
		if (capture == null) return;
		this.dump.capture = toJsonSafe(capture);
	}

	snapshot(): ApiRequestDump {
		this.flushResponseCapture();
		return toJsonSafe(this.dump);
	}
}
