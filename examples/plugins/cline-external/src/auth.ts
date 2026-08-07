/**
 * Cline OAuth: token refresh, callback parsing, and the loopback callback listener.
 *
 * ## Why this is not a reuse of `server/lib/cline-auth.ts`
 *
 * That module is correct for the built-in adapter and unusable here: it resolves its
 * credential file under `narraforkDir`, the host's home directory. A plugin must not read or
 * write host state — its credentials live in the host vault and arrive over RPC. Reusing it
 * would also mean the built-in module could not be deleted when this plugin replaces it,
 * which is the whole point of the migration.
 *
 * So every function here is pure with respect to storage: it takes what it needs and returns
 * what it produced. `credentials.ts` owns persistence, and it persists to the vault only.
 *
 * ## What is copied verbatim, and why that is deliberate
 *
 * The callback `code` decoding (base64 with a possible trailing signature) and the refresh
 * request shape are upstream protocol details, not design choices. They are reproduced
 * exactly, because a "cleaner" reading of them would just be a different set of assumptions
 * about a format we do not control.
 */

import { pfetch } from "./fetch";
import { log } from "./rpc";

/** Cline version reported in User-Agent and headers. Matches the built-in adapter. */
const CLINE_VERSION = "3.74.0";

/**
 * The two Cline base URLs, which are not interchangeable.
 *
 * The built-in adapter keeps these as separate constants (`DEFAULT_CLINE_API_BASE` in
 * `cline-provider.ts` versus `DEFAULT_API_BASE_URL` in `cline-auth.ts`) and so must this
 * plugin: chat completions live under `/api/v1`, while the account and auth endpoints are
 * addressed from the host root and add their own `/api/v1/...` path. Passing one where the
 * other is expected produces a `/api/v1/api/v1/...` URL and a 404 that looks like an auth
 * failure.
 *
 * `config.baseUrl` holds the *chat* base, because that is the one users have a reason to
 * override (a gateway or a mirror). `accountBaseFrom` derives the account base from it so
 * there is only one field to configure.
 */
export const DEFAULT_CHAT_BASE_URL = "https://api.cline.bot/api/v1";
export const DEFAULT_ACCOUNT_BASE_URL = "https://api.cline.bot";

/**
 * The account base implied by a chat base.
 *
 * Strips exactly one trailing `/api/v1`. A custom base without that suffix is returned
 * unchanged rather than rewritten, since we cannot know what shape it has.
 */
export function accountBaseFrom(chatBaseUrl: string | undefined): string {
	const base = trimSlashes(chatBaseUrl?.trim() || DEFAULT_CHAT_BASE_URL);
	return base.endsWith("/api/v1") ? base.slice(0, -"/api/v1".length) : base;
}

/** Treat a token as expired this long before it actually is. */
const EXPIRY_BUFFER_SECONDS = 5 * 60;

/** Refresh attempts before giving up on a transient failure. */
const MAX_REFRESH_RETRIES = 3;

/** Loopback port the browser callback is received on. Must match `callback_url`. */
export const CALLBACK_PORT = 19876;

/** How long a pending browser sign-in stays open before it is abandoned. */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClineCredentials {
	accessToken: string;
	refreshToken: string;
	/** Token expiry as a Unix timestamp in seconds. */
	expiresAt: number;
	email: string;
	displayName: string;
	/** Cline user id, needed by the balance endpoint. Populated after sign-in. */
	userId?: string;
	/** When the session was first created (ms). */
	startedAt: number;
}

/** Base headers that identify the client to Cline, mirroring the VS Code extension. */
export function buildClineHeaders(): Record<string, string> {
	return {
		"User-Agent": `Cline/${CLINE_VERSION}`,
		"X-PLATFORM": "node",
		"X-PLATFORM-VERSION": process.versions.bun ?? process.version,
		"X-CLIENT-TYPE": "extension",
		"X-CLIENT-VERSION": CLINE_VERSION,
		"X-CORE-VERSION": CLINE_VERSION,
	};
}

/** Headers for chat completions and model listing, which the gateway proxies to OpenRouter. */
export function buildOpenRouterHeaders(): Record<string, string> {
	return {
		...buildClineHeaders(),
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
	};
}

/**
 * Headers for Cline account endpoints (balance, user info, auth).
 *
 * The `workos:` prefix is what the gateway expects on a bearer token; it is added here when
 * absent so callers never have to remember it.
 */
export function buildClineAccountHeaders(accessToken?: string): Record<string, string> {
	const headers: Record<string, string> = {
		...buildClineHeaders(),
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (accessToken) {
		headers.Authorization = `Bearer ${withWorkosPrefix(accessToken)}`;
	}
	return headers;
}

/** The bearer form of an access token. */
export function withWorkosPrefix(accessToken: string): string {
	return accessToken.startsWith("workos:") ? accessToken : `workos:${accessToken}`;
}

/** Whether a token is expired, or close enough that it should be refreshed now. */
export function isTokenExpired(credentials: ClineCredentials, nowMs = Date.now()): boolean {
	return credentials.expiresAt < nowMs / 1000 + EXPIRY_BUFFER_SECONDS;
}

/**
 * Outcome of a refresh attempt.
 *
 * `invalid` is separate from `failed` because the two demand opposite responses: an invalid
 * refresh token will never succeed and the stored credential should be cleared, while a
 * transient failure must leave it alone so a later call can retry. Collapsing them would
 * either sign the user out on a network blip or retry a revoked token forever.
 */
export type RefreshOutcome =
	| { status: "refreshed"; credentials: ClineCredentials }
	| { status: "invalid"; reason: string }
	| { status: "failed"; reason: string };

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Does not persist anything: the caller decides what to do with the result, which is what
 * lets this be tested without a vault and lets the vault write be deduplicated upstream.
 */
export async function refreshAccessToken(
	credentials: ClineCredentials,
	apiBaseUrl: string,
	proxyUrl?: string,
): Promise<RefreshOutcome> {
	const endpoint = `${trimSlashes(apiBaseUrl)}/api/v1/auth/refresh`;
	let lastError = "unknown error";

	for (let attempt = 0; attempt < MAX_REFRESH_RETRIES; attempt += 1) {
		try {
			const response = await pfetch(
				endpoint,
				{
					method: "POST",
					headers: buildClineAccountHeaders(),
					body: JSON.stringify({
						refreshToken: credentials.refreshToken,
						grantType: "refresh_token",
					}),
				},
				proxyUrl,
			);

			if (!response.ok) {
				// 400/401 mean the refresh token itself is rejected. Retrying cannot help.
				if (response.status === 400 || response.status === 401) {
					return { status: "invalid", reason: `refresh rejected with ${response.status}` };
				}
				lastError = `refresh failed with ${response.status}`;
				continue;
			}

			const json = (await response.json()) as {
				success?: boolean;
				data?: {
					accessToken: string;
					refreshToken?: string;
					expiresAt: string;
					userInfo?: { email?: string; name?: string };
				};
			};

			if (!json.success || !json.data?.accessToken) {
				lastError = "refresh returned no access token";
				continue;
			}

			const expiresAt = new Date(json.data.expiresAt).getTime();
			return {
				status: "refreshed",
				credentials: {
					accessToken: json.data.accessToken,
					// Upstream may rotate the refresh token. Adopting the new one is required;
					// keeping the old one would authenticate with a value already revoked.
					refreshToken: json.data.refreshToken || credentials.refreshToken,
					expiresAt: Number.isFinite(expiresAt) ? expiresAt / 1000 : Date.now() / 1000 + 3600,
					email: json.data.userInfo?.email || credentials.email,
					displayName: json.data.userInfo?.name || credentials.displayName,
					...(credentials.userId ? { userId: credentials.userId } : {}),
					startedAt: credentials.startedAt,
				},
			};
		} catch (error) {
			lastError = error instanceof Error ? error.name : "request failed";
		}
	}

	return { status: "failed", reason: lastError };
}

/**
 * Parse the credentials out of a Cline OAuth callback URL.
 *
 * The URL looks like `http://localhost:19876/auth/callback?code=<base64-json>&signature`.
 * The `code` parameter is base64-encoded JSON that may have binary signature bytes appended
 * after the JSON, so the payload is located by its last closing brace rather than assumed to
 * fill the buffer.
 *
 * Throws with a specific message for each failure: a user pasting the wrong thing needs to
 * know whether the URL was malformed, the code was missing, or the payload was unreadable.
 */
export function parseCallbackUrl(callbackUrl: string): ClineCredentials {
	let url: URL;
	try {
		url = new URL(callbackUrl.trim());
	} catch {
		throw new AuthInputError("That does not look like a URL");
	}

	const codeParam = url.searchParams.get("code");
	if (!codeParam) {
		throw new AuthInputError("No 'code' parameter found in the callback URL");
	}

	let decoded: string;
	try {
		decoded = Buffer.from(decodeURIComponent(codeParam), "base64").toString("utf-8");
	} catch {
		throw new AuthInputError("Failed to decode the callback code parameter");
	}

	const jsonEnd = decoded.lastIndexOf("}");
	if (jsonEnd === -1) {
		throw new AuthInputError("No JSON payload found in the callback code");
	}

	let data: {
		accessToken?: string;
		refreshToken?: string;
		email?: string;
		name?: string;
		firstName?: string;
		lastName?: string;
		expiresAt?: string;
	};
	try {
		data = JSON.parse(decoded.slice(0, jsonEnd + 1));
	} catch {
		throw new AuthInputError("The callback payload is not valid JSON");
	}

	if (!data.accessToken) throw new AuthInputError("No accessToken in the callback payload");
	if (!data.refreshToken) throw new AuthInputError("No refreshToken in the callback payload");

	const expiresAtMs = data.expiresAt ? new Date(data.expiresAt).getTime() : Number.NaN;
	return {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs / 1000 : Date.now() / 1000 + 3600,
		email: data.email || "",
		displayName: data.name || [data.firstName, data.lastName].filter(Boolean).join(" ") || "",
		startedAt: Date.now(),
	};
}

export class AuthInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthInputError";
	}
}

/** Raised when the loopback callback port is already taken. */
export class PortInUseError extends Error {
	constructor(port: number) {
		super(
			`Callback port ${port} is already in use. The built-in Cline provider may be signing in; retry, or paste the callback URL instead.`,
		);
		this.name = "PortInUseError";
	}
}

/**
 * Whether the loopback callback listener can be opened right now.
 *
 * Three states rather than a boolean, because "busy" and "unsupported" call for different
 * user action: a busy port is transient and worth retrying, an unsupported environment
 * (a container without host loopback, a sandbox denying bind) never will be.
 *
 * This is a probe, so its answer is only true at the instant it ran — the built-in adapter
 * could claim the port immediately after. It therefore decides only what the settings view
 * *displays*; the authoritative answer always comes from the real bind in `startBrowserAuth`.
 */
export type BrowserAuthAvailability = "available" | "port_busy" | "unsupported";

export function probeBrowserAuth(): BrowserAuthAvailability {
	try {
		const server = Bun.serve({
			port: CALLBACK_PORT,
			hostname: "127.0.0.1",
			fetch: () => new Response("probe", { status: 404 }),
		});
		server.stop(true);
		return "available";
	} catch (error) {
		return isAddressInUse(error) ? "port_busy" : "unsupported";
	}
}

/** Whether a bind failure was "port taken" as opposed to "cannot bind at all". */
export function isAddressInUse(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && code.includes("EADDRINUSE")) return true;
	const message = error instanceof Error ? error.message : "";
	return message.includes("EADDRINUSE") || message.includes("address already in use");
}

export interface PendingBrowserAuth {
	/** URL the user must open. */
	authorizeUrl: string;
	/** Resolves with the credentials once the browser hits the callback. */
	completion: Promise<ClineCredentials>;
	/** Close the listener and reject `completion`. Idempotent. */
	cancel: (reason: string) => void;
}

/**
 * Begin a browser sign-in: ask upstream for the authorization URL, then listen for the
 * callback on loopback.
 *
 * The listener is bound to `127.0.0.1` rather than all interfaces (which is what the
 * built-in adapter does by omission). The callback only ever comes from a browser on this
 * machine, so exposing it on the network would widen the surface for no benefit.
 *
 * `callback_url` is a fixed port on purpose: it is sent to upstream and must match what is
 * actually listening, so silently falling back to another port would produce a callback that
 * arrives nowhere. A taken port is reported instead.
 */
export async function startBrowserAuth(
	apiBaseUrl: string,
	proxyUrl?: string,
): Promise<PendingBrowserAuth> {
	const baseUrl = trimSlashes(apiBaseUrl);
	const callbackUrl = `http://localhost:${CALLBACK_PORT}/auth/callback`;

	const authEndpoint = new URL(`${baseUrl}/api/v1/auth/authorize`);
	authEndpoint.searchParams.set("client_type", "extension");
	authEndpoint.searchParams.set("callback_url", callbackUrl);
	authEndpoint.searchParams.set("redirect_uri", callbackUrl);

	// Bind before asking upstream for a URL: if the port is taken there is no point starting
	// a flow the callback could never complete, and the user gets an actionable error instead
	// of an authorization page that silently leads nowhere.
	let resolveCode: (url: string) => void = () => undefined;
	let rejectCode: (error: Error) => void = () => undefined;
	const codePromise = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});

	let server: ReturnType<typeof Bun.serve>;
	try {
		server = Bun.serve({
			port: CALLBACK_PORT,
			hostname: "127.0.0.1",
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname !== "/auth/callback") {
					return new Response("Not found", { status: 404 });
				}
				resolveCode(request.url);
				return new Response(
					"<html><body><h2>Signed in.</h2><p>You can close this window.</p><script>window.close()</script></body></html>",
					{ headers: { "Content-Type": "text/html" } },
				);
			},
		});
	} catch (error) {
		if (isAddressInUse(error)) throw new PortInUseError(CALLBACK_PORT);
		throw error;
	}

	let settled = false;
	const shutdown = (): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		// `close: true` so a browser holding the connection open cannot keep the port bound
		// after the flow finished; the next sign-in must be able to bind immediately.
		server.stop(true);
	};

	const timer = setTimeout(() => {
		rejectCode(new Error("Sign-in timed out after 5 minutes"));
		shutdown();
	}, OAUTH_TIMEOUT_MS);

	const cancel = (reason: string): void => {
		rejectCode(new Error(reason));
		shutdown();
	};

	let authorizeUrl: string;
	try {
		authorizeUrl = await requestAuthorizeUrl(authEndpoint.toString(), proxyUrl);
	} catch (error) {
		// The listener is already open at this point, so it has to come back down or the port
		// stays bound for the rest of the process with no flow attached to it.
		cancel("Sign-in could not be started");
		throw error;
	}

	const completion = codePromise.then((fullUrl) => {
		shutdown();
		return parseCallbackUrl(fullUrl);
	});
	// The caller may not await `completion` immediately; without this an early rejection
	// would surface as an unhandled rejection and, in Bun, a process-level warning.
	completion.catch(() => undefined);

	return { authorizeUrl, completion, cancel };
}

/**
 * Resolve the upstream authorization URL.
 *
 * Upstream answers either with a redirect or with a JSON body depending on deployment, so
 * both are accepted. `redirect: "manual"` is required for the first case: following it would
 * consume the redirect and lose the URL the user needs to open.
 */
async function requestAuthorizeUrl(endpoint: string, proxyUrl?: string): Promise<string> {
	const response = await pfetch(
		endpoint,
		{ method: "GET", redirect: "manual", headers: buildClineAccountHeaders() },
		proxyUrl,
	);

	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get("Location");
		if (!location) throw new Error("Cline returned a redirect with no Location header");
		return location;
	}
	if (response.ok) {
		const data = (await response.json()) as { redirect_url?: string };
		if (!data.redirect_url) throw new Error("Cline returned no redirect_url");
		return data.redirect_url;
	}
	log("authorize request failed", { status: response.status });
	throw new Error(`Cline authorization request failed with ${response.status}`);
}

/** Fetch the signed-in user, used to populate the `userId` the balance endpoint needs. */
export async function fetchUserInfo(
	accessToken: string,
	apiBaseUrl: string,
	proxyUrl?: string,
): Promise<{ id?: string; email?: string; displayName?: string } | undefined> {
	const response = await pfetch(
		`${trimSlashes(apiBaseUrl)}/api/v1/users/me`,
		{ headers: buildClineAccountHeaders(accessToken) },
		proxyUrl,
	);
	if (!response.ok) return undefined;
	const json = (await response.json()) as {
		data?: { id?: string; email?: string; displayName?: string; name?: string };
	};
	if (!json.data) return undefined;
	return {
		...(json.data.id ? { id: json.data.id } : {}),
		...(json.data.email ? { email: json.data.email } : {}),
		...(json.data.displayName || json.data.name
			? { displayName: json.data.displayName || json.data.name }
			: {}),
	};
}

/** Account balance in micro-dollars, or undefined when unavailable. */
export async function fetchBalance(
	accessToken: string,
	userId: string,
	apiBaseUrl: string,
	proxyUrl?: string,
): Promise<{ balance: number; userId: string } | undefined> {
	const response = await pfetch(
		`${trimSlashes(apiBaseUrl)}/api/v1/users/${encodeURIComponent(userId)}/balance`,
		{ headers: buildClineAccountHeaders(accessToken) },
		proxyUrl,
	);
	if (!response.ok) return undefined;
	const json = (await response.json()) as {
		success?: boolean;
		data?: { balance: number; userId: string };
	};
	if (!json.success || !json.data) return undefined;
	return json.data;
}

function trimSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}
