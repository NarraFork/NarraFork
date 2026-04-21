export const BASE = "/api";
const TOKEN_KEY = "narrafork_token";

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
	const text = await response.text();
	const tryParseJson = (raw: string) => {
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	};
	if (response.status === 401) {
		clearToken();
		const error = tryParseJson(text) ?? { error: text || "Unauthorized" };
		throw new ApiError(error.error ?? "Unauthorized", 401, error);
	}
	if (!response.ok) {
		const error = tryParseJson(text) ?? { error: text || response.statusText };
		throw new ApiError(error.error ?? "Request failed", response.status, error);
	}
	const parsed = tryParseJson(text);
	if (parsed !== null) return parsed as T;
	throw new ApiError(text || "Invalid response", response.status, { error: text });
}
