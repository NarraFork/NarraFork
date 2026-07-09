export const BASE = "/api";
const TOKEN_KEY = "narrafork_token";
const MAX_RESPONSE_TEXT_PREVIEW_CHARS = 120_000;

export class ApiError extends Error {
	status: number;
	data?: Record<string, unknown>;
	constructor(message: string, status: number, data?: Record<string, unknown>) {
		super(message);
		this.status = status;
		this.data = data;
	}
}

export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
	localStorage.removeItem(TOKEN_KEY);
}

function tryParseJson(raw: string): unknown | null {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function isJsonResponse(response: Response): boolean {
	return response.headers.get("content-type")?.toLowerCase().includes("json") ?? false;
}

function toErrorData(value: unknown, fallback: string): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return { error: typeof value === "string" && value ? value : fallback };
}

export function getErrorMessage(data: Record<string, unknown>, fallback: string): string {
	for (const key of ["reason", "message", "error"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	const nestedError = data.error;
	if (nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)) {
		const nestedMessage = (nestedError as Record<string, unknown>).message;
		if (typeof nestedMessage === "string" && nestedMessage.trim()) return nestedMessage;
	}
	const code = data.code;
	if (typeof code === "string" && code.trim()) return code;
	return fallback;
}

async function readResponseTextPreview(
	response: Response,
	maxChars = MAX_RESPONSE_TEXT_PREVIEW_CHARS,
): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) {
		const text = await response.text();
		return text.length > maxChars
			? { text: text.slice(0, maxChars), truncated: true }
			: { text, truncated: false };
	}

	const decoder = new TextDecoder();
	let text = "";
	let truncated = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			if (text.length >= maxChars) {
				text = text.slice(0, maxChars);
				truncated = true;
				break;
			}
		}
		if (!truncated) text += decoder.decode();
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
	}
	return { text, truncated };
}

async function readErrorData(
	response: Response,
	fallback: string,
): Promise<Record<string, unknown>> {
	if (isJsonResponse(response)) {
		const parsed = await response.json().catch(() => null);
		return toErrorData(parsed, fallback);
	}
	const { text, truncated } = await readResponseTextPreview(response);
	const value = truncated ? `${text}\n…` : (tryParseJson(text) ?? text);
	return toErrorData(value, fallback);
}

export async function readFetchError(
	response: Response,
	fallback = response.statusText || "Request failed",
): Promise<{ message: string; data: Record<string, unknown> }> {
	if (response.status === 401) {
		clearToken();
	}
	const data = await readErrorData(response, fallback);
	return { message: getErrorMessage(data, fallback), data };
}

export async function readFetchErrorMessage(
	response: Response,
	fallback = response.statusText || "Request failed",
): Promise<string> {
	return (await readFetchError(response, fallback)).message;
}

export async function request<T>(
	path: string,
	options?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
	const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) };
	if (options?.body) {
		headers["Content-Type"] = "application/json";
	}
	const token = getToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const response = await fetch(`${BASE}${path}`, { ...options, headers });
	if (response.status === 401) {
		clearToken();
		const error = await readErrorData(response, "Unauthorized");
		throw new ApiError(getErrorMessage(error, "Unauthorized"), 401, error);
	}
	if (!response.ok) {
		const error = await readErrorData(response, response.statusText || "Request failed");
		throw new ApiError(getErrorMessage(error, "Request failed"), response.status, error);
	}
	if (isJsonResponse(response)) {
		const parsed = await response.json().catch(() => null);
		if (parsed !== null) return parsed as T;
		throw new ApiError("Invalid response", response.status, { error: "Invalid response" });
	}
	const { text, truncated } = await readResponseTextPreview(response);
	const parsed = truncated ? null : tryParseJson(text);
	if (parsed !== null) return parsed as T;
	const errorText = truncated ? `${text}\n…` : text;
	throw new ApiError(errorText || "Invalid response", response.status, { error: errorText });
}

/** HTTP statuses that must not carry a body when constructing a Response. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function parseRawHeaders(raw: string): Headers {
	const headers = new Headers();
	for (const line of raw.trim().split(/[\r\n]+/)) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key) headers.append(key, value);
	}
	return headers;
}

/**
 * POST a FormData body while reporting upload progress. `fetch` cannot surface
 * upload progress, so this uses XMLHttpRequest and rebuilds a standard
 * `Response` from the result — callers keep using `readFetchError` / `res.json()`
 * exactly as they would with `fetch`. Network errors / timeouts / aborts reject.
 *
 * The Content-Type is intentionally left unset so the browser adds the multipart
 * boundary automatically; do not pass a Content-Type header here.
 */
export function postFormDataWithProgress(
	url: string,
	formData: FormData,
	options?: {
		headers?: Record<string, string>;
		onProgress?: (fraction: number) => void;
		signal?: AbortSignal;
	},
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const signal = options?.signal;
		if (signal?.aborted) {
			reject(new ApiError("Upload cancelled", 0, { code: "UPLOAD_ABORTED" }));
			return;
		}

		const xhr = new XMLHttpRequest();
		xhr.open("POST", url);

		if (options?.headers) {
			for (const [key, value] of Object.entries(options.headers)) {
				// Skip Content-Type so the browser sets the multipart boundary.
				if (key.toLowerCase() === "content-type") continue;
				xhr.setRequestHeader(key, value);
			}
		}

		const onProgress = options?.onProgress;
		if (onProgress) {
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable && event.total > 0) {
					onProgress(event.loaded / event.total);
				}
			};
		}

		const onAbort = () => xhr.abort();
		if (signal) signal.addEventListener("abort", onAbort);
		const cleanup = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};

		xhr.onload = () => {
			cleanup();
			const status = xhr.status;
			const headers = parseRawHeaders(xhr.getAllResponseHeaders());
			const body = NULL_BODY_STATUSES.has(status) ? null : xhr.responseText;
			resolve(new Response(body, { status, statusText: xhr.statusText, headers }));
		};
		xhr.onerror = () => {
			cleanup();
			reject(new ApiError("Network request failed", 0));
		};
		xhr.ontimeout = () => {
			cleanup();
			reject(new ApiError("Request timed out", 0));
		};
		xhr.onabort = () => {
			cleanup();
			reject(new ApiError("Upload cancelled", 0, { code: "UPLOAD_ABORTED" }));
		};

		xhr.send(formData);
	});
}

/**
 * Whether an error represents a user-initiated cancellation (AbortSignal) rather
 * than a real failure. Covers both the XHR upload path (ApiError code) and
 * fetch's native `AbortError` so callers can suppress error toasts uniformly.
 */
export function isAbortError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === "AbortError") return true;
	if (err instanceof ApiError && err.data?.code === "UPLOAD_ABORTED") return true;
	return false;
}
