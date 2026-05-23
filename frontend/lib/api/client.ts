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
