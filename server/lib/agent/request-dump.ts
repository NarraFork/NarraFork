export interface ApiRequestDump {
	provider?: string;
	model?: string;
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

const SENSITIVE_HEADER_PATTERNS = [
	/^authorization$/i,
	/^x-api-key$/i,
	/^api-key$/i,
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

	setResponseError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.setResponseMeta({ error: message });
	}

	snapshot(): ApiRequestDump {
		return toJsonSafe(this.dump);
	}
}
