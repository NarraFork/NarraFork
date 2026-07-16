import type { ApiRequestDiagnostics } from "./types";

export interface ApiRequestDump {
	provider?: string;
	model?: string;
	diagnostics?: ApiRequestDiagnostics;
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
	};
}

/** Default byte cap for a persisted raw dump's response body / events (1 MB). */
export const DEFAULT_DUMP_MAX_BYTES = 1024 * 1024;
/** Hard cap on the number of stored SSE events in a raw dump. */
export const MAX_DUMP_EVENT_COUNT = 2000;

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

export class ApiRequestDumpCollector {
	private dump: ApiRequestDump;

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
		if (maxSize < 0 || bodyText.length <= maxSize) {
			this.setResponseBodyText(bodyText);
			return;
		}
		const truncated = `${bodyText.slice(0, maxSize)}\n\n[... truncated ${bodyText.length - maxSize} bytes]`;
		this.setResponseBodyText(truncated);
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
		this.setResponseMeta({ error: message });
	}

	setDiagnostics(diagnostics: ApiRequestDiagnostics | undefined): void {
		if (!diagnostics) return;
		this.dump.diagnostics = toJsonSafe(diagnostics);
	}

	snapshot(): ApiRequestDump {
		return toJsonSafe(this.dump);
	}
}
