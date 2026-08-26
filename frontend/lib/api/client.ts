import { apiUrl } from "@frontend/lib/base-path";
import { isSessionInvalidResponse, SESSION_RENEWAL_HEADER } from "@shared/session-auth";

/**
 * The API root, resolved against the app's mount prefix.
 *
 * A FUNCTION, not the former `export const BASE = "/api"`. The prefix is derived from
 * the document (see `lib/base-path.ts`), and a module-level constant is evaluated at
 * import time with no way to correct it afterwards — under a mount prefix every call
 * site that captured it would keep addressing the origin root, which is the proxy,
 * not us.
 *
 * Never ends in a slash, because every call site spells it `` `${apiBase()}/x` ``.
 */
export function apiBase(): string {
	return apiUrl();
}
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

/**
 * Observers of session-token changes.
 *
 * Exists for the editor-host bridge (`lib/host-bridge.ts`), which mirrors the token into
 * VS Code's SecretStorage. A one-shot injection at panel load is not enough: the server
 * re-signs the token as it nears expiry and `absorbRenewedToken` swaps it mid-session, so
 * a host copy taken at load time goes stale on its own. The staleness surfaces later and
 * somewhere else — the NEXT panel injects an expired token and the user is bounced to the
 * login screen with nothing explaining why — which is why the notification lives at the
 * storage boundary rather than at the call sites that happen to log in.
 */
type TokenChangeListener = (token: string | null) => void;
const tokenChangeListeners = new Set<TokenChangeListener>();

/** Subscribe to token changes. Returns an unsubscribe function. */
export function onTokenChange(listener: TokenChangeListener): () => void {
	tokenChangeListeners.add(listener);
	return () => tokenChangeListeners.delete(listener);
}

function notifyTokenChange(token: string | null): void {
	for (const listener of tokenChangeListeners) {
		try {
			listener(token);
		} catch {
			// A failing observer must never break authentication itself.
		}
	}
}

export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
	// Compare first so a no-op write does not announce a change: `absorbRenewedToken` and
	// hydration paths both re-assert the current value, and the bridge would otherwise
	// send a redundant message per request.
	const changed = localStorage.getItem(TOKEN_KEY) !== token;
	localStorage.setItem(TOKEN_KEY, token);
	if (changed) notifyTokenChange(token);
}

export function clearToken(): void {
	const had = localStorage.getItem(TOKEN_KEY) !== null;
	localStorage.removeItem(TOKEN_KEY);
	if (had) notifyTokenChange(null);
}

/**
 * Read a JWT's `exp` without verifying it.
 *
 * Only used to order two tokens the server already signed, so no signature check
 * is needed — but the input is still treated as untrusted: anything that is not
 * a three-part token with a numeric `exp` yields null and is refused below.
 */
function readTokenExp(token: string): number | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
		const payload = JSON.parse(atob(padded)) as unknown;
		if (!payload || typeof payload !== "object") return null;
		const exp = (payload as { exp?: unknown }).exp;
		return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
	} catch {
		return null;
	}
}

/**
 * Pick up a slid session token from any authenticated response.
 *
 * The server re-signs the session JWT when it nears expiry and returns it in
 * `SESSION_RENEWAL_HEADER`. Storing it here means every code path that talks to
 * the API — `request`, `authorizedFetch`, SSE and upload helpers — keeps the
 * session alive just by passing its response through.
 *
 * Two orderings have to be defended against, because parallel requests inside
 * the renewal window each get their own independently signed token and the
 * responses can land in any order:
 *  - a token that is not strictly newer than the stored one is discarded, so the
 *    last response to arrive cannot install the earliest-issued token;
 *  - `expectedToken` (the credential the request was actually sent with) turns
 *    the write into a compare-and-swap, so a renewal for account A cannot
 *    overwrite a session that has since been replaced by account B's.
 */
export function absorbRenewedToken(response: Response, expectedToken?: string | null): void {
	const renewed = response.headers.get(SESSION_RENEWAL_HEADER);
	if (!renewed) return;
	// A renewal only ever accompanies a successful response. The server strips the
	// header from 401s; refusing it here too keeps a "store then clear" race from
	// resurrecting a session that the same response invalidated.
	if (!response.ok) return;

	const current = getToken();
	// Only replace an existing session. A renewal arriving after the user logged
	// out in another tab must not silently resurrect the session.
	if (!current) return;
	// Compare-and-swap: the session must still be the one this request used.
	if (expectedToken !== undefined && expectedToken !== null && current !== expectedToken) return;

	const renewedExp = readTokenExp(renewed);
	if (renewedExp === null) return;
	const currentExp = readTokenExp(current);
	if (currentExp !== null && renewedExp <= currentExp) return;

	setToken(renewed);
}

/**
 * Resolve a rooted, app-relative API path against the mount prefix.
 *
 * Only a `/api…` input is rewritten, and that predicate is what makes this
 * idempotent rather than a trap:
 *   - at the root, `apiBase()` is `/api`, so an already-built URL is `/api/x` — and
 *     `apiUrl("/api/x")` returns `/api/x` unchanged;
 *   - under a prefix, an already-built URL is `/proxy/7778/api/x`, which does not
 *     match `/api` and is therefore left alone.
 *
 * Anything else (absolute URL, `URL` object, blob/data URI) passes through untouched:
 * those are not ours to reinterpret.
 */
function resolveApiInput(input: string | URL): string | URL {
	if (typeof input !== "string") return input;
	if (input !== "/api" && !input.startsWith("/api/") && !input.startsWith("/api?")) return input;
	return apiUrl(input);
}

/**
 * Authenticated `fetch` for the call sites that cannot use `request` (binary
 * bodies, SSE streams, FormData uploads, callers that need the raw `Response`).
 *
 * Centralizing the Authorization header and the renewal absorption means a new
 * call site is correct by default instead of having to remember three lines —
 * including the compare-and-swap that a hand-rolled `absorbRenewedToken(res)`
 * cannot do, since only this wrapper knows which token was sent.
 *
 * It also resolves rooted `/api/…` paths against the app's mount prefix, so the
 * dozens of existing call sites that spell the path as a literal keep working when
 * NarraFork is served from a subpath. That is a rewrite rather than a lint rule
 * because a missed call site fails only under a prefix, where it reaches the proxy's
 * own root and returns HTML — reported as a parse error, not a wrong URL.
 */
export async function authorizedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
	input = resolveApiInput(input);
	const token = getToken();
	const headers = new Headers(init?.headers);
	if (token && !headers.has("Authorization")) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	const response = await fetch(input, { ...init, headers });
	absorbRenewedToken(response, token);
	return response;
}

/**
 * Discard the stored token only when a 401 actually means the session is gone.
 *
 * Plenty of 401s are unrelated to the caller's session: a wrong TOTP code while
 * disabling two-factor auth, a failed passkey ceremony, an OAuth-only endpoint
 * rejecting a session JWT, or the consent page reporting `login_required` for a
 * different principal. Treating those as logout was what made NarraFork appear
 * to sign users out at random.
 */
function clearTokenIfSessionInvalid(data: Record<string, unknown> | null): void {
	if (isSessionInvalidResponse(data)) clearToken();
}

/**
 * 401 handling for call sites that fetch binary assets (avatars, uploaded
 * images, notification sounds) and discard the error body. They still need the
 * error code to tell a dead session apart from an unrelated authorization
 * failure, so the body is parsed here and thrown away.
 */
export async function clearTokenOnSessionFailure(response: Response): Promise<void> {
	if (response.status !== 401) return;
	const data = await readErrorData(response, "Unauthorized").catch(() => null);
	clearTokenIfSessionInvalid(data);
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
	const data = await readErrorData(response, fallback);
	// The error code lives in the body, so the session verdict has to wait until
	// the body is parsed rather than branching on the status alone.
	if (response.status === 401) {
		clearTokenIfSessionInvalid(data);
	}
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
	const response = await fetch(apiUrl(path), { ...options, headers });
	absorbRenewedToken(response, token);
	if (response.status === 401) {
		const error = await readErrorData(response, "Unauthorized");
		clearTokenIfSessionInvalid(error);
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
