import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger";
import { narraforkDir } from "./settings";

// === Cline-compatible request headers ===

/**
 * Cline version to report in User-Agent and headers.
 * Kept in sync with the upstream Cline extension.
 */
const CLINE_VERSION = "3.74.0";

/** Build headers that mimic the Cline VS Code extension. */
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

/** Headers for OpenRouter API requests (chat completions, models). */
export function buildOpenRouterHeaders(): Record<string, string> {
	return {
		...buildClineHeaders(),
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
	};
}

/** Headers for Cline account API requests (balance, user info, auth). */
export function buildClineAccountHeaders(accessToken?: string): Record<string, string> {
	const headers: Record<string, string> = {
		...buildClineHeaders(),
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (accessToken) {
		const token = accessToken.startsWith("workos:") ? accessToken : `workos:${accessToken}`;
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

// === Cline OAuth Credentials ===

export interface ClineCredentials {
	accessToken: string;
	refreshToken: string;
	/** Token expiry time in seconds (Unix epoch). */
	expiresAt: number;
	email: string;
	displayName: string;
	/** Cline user ID (for balance API). */
	userId?: string;
	/** When the session was first created (ms). */
	startedAt: number;
}

export interface ClineAuthStatus {
	authenticated: boolean;
	email?: string;
	displayName?: string;
	expiresAt?: number;
	userId?: string;
}

const CREDENTIALS_PATH = resolve(narraforkDir, "cline-credentials.json");

/** Default Cline API base URL. */
const DEFAULT_API_BASE_URL = "https://api.cline.bot";

/** 5-minute buffer before considering a token expired. */
const EXPIRY_BUFFER_SECONDS = 5 * 60;

/** Max refresh retries before giving up. */
const MAX_REFRESH_RETRIES = 3;

// === Credential persistence ===

function loadCredentials(): ClineCredentials | null {
	try {
		if (!existsSync(CREDENTIALS_PATH)) return null;
		const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
		return JSON.parse(raw) as ClineCredentials;
	} catch {
		return null;
	}
}

function saveCredentials(creds: ClineCredentials): void {
	mkdirSync(narraforkDir, { recursive: true });
	writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

export function clearCredentials(): void {
	try {
		if (existsSync(CREDENTIALS_PATH)) {
			unlinkSync(CREDENTIALS_PATH);
		}
	} catch {
		// non-critical
	}
}

// === Token refresh ===

async function refreshAccessToken(
	creds: ClineCredentials,
	apiBaseUrl: string,
): Promise<ClineCredentials | null> {
	const endpoint = `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/auth/refresh`;

	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_REFRESH_RETRIES; attempt++) {
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: buildClineAccountHeaders(),
				body: JSON.stringify({
					refreshToken: creds.refreshToken,
					grantType: "refresh_token",
				}),
			});

			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				// 400/401 = permanent failure (invalid/expired refresh token)
				if (response.status === 400 || response.status === 401) {
					logger.error("Cline refresh token invalid/expired, clearing credentials", {
						status: response.status,
					});
					clearCredentials();
					return null;
				}
				lastError = new Error(`Cline token refresh failed: ${response.status} ${errText}`);
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
				lastError = new Error("Cline token refresh returned invalid data");
				continue;
			}

			const updated: ClineCredentials = {
				accessToken: json.data.accessToken,
				refreshToken: json.data.refreshToken || creds.refreshToken,
				expiresAt: new Date(json.data.expiresAt).getTime() / 1000,
				email: json.data.userInfo?.email || creds.email,
				displayName: json.data.userInfo?.name || creds.displayName,
				startedAt: creds.startedAt,
			};

			saveCredentials(updated);
			logger.debug("Cline access token refreshed successfully");
			return updated;
		} catch (err) {
			lastError = err;
		}
	}

	logger.error("Cline token refresh failed after retries", { error: String(lastError) });
	return null;
}

function isTokenExpired(creds: ClineCredentials): boolean {
	const now = Date.now() / 1000;
	return creds.expiresAt < now + EXPIRY_BUFFER_SECONDS;
}

// === Public API ===

/**
 * Get valid Cline credentials, refreshing the token if needed.
 * Returns null if not authenticated or refresh fails.
 */
export async function getValidCredentials(apiBaseUrl?: string): Promise<ClineCredentials | null> {
	const creds = loadCredentials();
	if (!creds?.accessToken || !creds?.refreshToken) return null;

	if (!isTokenExpired(creds)) return creds;

	// Token expired — try to refresh
	const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
	return refreshAccessToken(creds, baseUrl);
}

/**
 * Get a valid access token for API requests.
 * Returns null if not authenticated.
 */
export async function getAccessToken(apiBaseUrl?: string): Promise<string | null> {
	const creds = await getValidCredentials(apiBaseUrl);
	return creds?.accessToken ?? null;
}

/** Get current authentication status (no refresh attempt). */
export function getAuthStatus(): ClineAuthStatus {
	const creds = loadCredentials();
	if (!creds?.accessToken) {
		return { authenticated: false };
	}
	return {
		authenticated: true,
		email: creds.email,
		displayName: creds.displayName,
		expiresAt: creds.expiresAt,
		userId: creds.userId,
	};
}

/**
 * Fetch user info from Cline API and update stored credentials with userId.
 * Called after login to populate the userId field.
 */
export async function fetchAndUpdateUserInfo(apiBaseUrl?: string): Promise<void> {
	const creds = loadCredentials();
	if (!creds?.accessToken) return;

	const baseUrl = (apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
	try {
		const response = await fetch(`${baseUrl}/api/v1/users/me`, {
			headers: buildClineAccountHeaders(creds.accessToken),
		});
		if (response.ok) {
			const data = (await response.json()) as {
				data?: {
					id?: string;
					email?: string;
					displayName?: string;
					name?: string;
				};
			};
			if (data.data) {
				creds.userId = data.data.id || creds.userId;
				creds.email = data.data.email || creds.email;
				creds.displayName = data.data.displayName || data.data.name || creds.displayName;
				saveCredentials(creds);
				logger.debug("Cline user info updated", { userId: creds.userId });
			}
		}
	} catch (err) {
		logger.warn("Failed to fetch Cline user info", { error: String(err) });
	}
}

/**
 * Fetch account balance from Cline API.
 * Returns balance in micro-dollars (1/1,000,000 USD), or null if not available.
 */
export async function fetchBalance(apiBaseUrl?: string): Promise<{
	balance: number;
	userId: string;
} | null> {
	const creds = await getValidCredentials(apiBaseUrl);
	if (!creds?.accessToken) return null;

	// Need userId for balance endpoint
	if (!creds.userId) {
		await fetchAndUpdateUserInfo(apiBaseUrl);
		const updated = loadCredentials();
		if (!updated?.userId) return null;
	}

	const freshCreds = loadCredentials();
	if (!freshCreds?.userId) return null;

	const baseUrl = (apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
	try {
		const response = await fetch(`${baseUrl}/api/v1/users/${freshCreds.userId}/balance`, {
			headers: buildClineAccountHeaders(freshCreds.accessToken),
		});
		if (!response.ok) return null;

		const json = (await response.json()) as {
			success?: boolean;
			data?: { balance: number; userId: string };
		};
		if (json.success && json.data) {
			return json.data;
		}
		return null;
	} catch (err) {
		logger.warn("Failed to fetch Cline balance", { error: String(err) });
		return null;
	}
}

// === Browser OAuth flow ===

/** Pending OAuth state for CSRF protection. */
let pendingOAuthState: {
	resolve: (code: string) => void;
	reject: (err: Error) => void;
	server: ReturnType<typeof Bun.serve> | null;
} | null = null;

/** Authorization URL of the pending OAuth flow, so the frontend can re-display/copy it. */
let pendingAuthorizeUrl: string | null = null;

/**
 * Parse a Cline OAuth callback URL and extract credentials.
 *
 * The callback URL looks like:
 *   http://localhost:19876/auth/callback?code=<base64-json>&signature
 *
 * The `code` parameter is a base64-encoded JSON containing:
 *   { accessToken, refreshToken, email, name, firstName, lastName, expiresAt }
 */
export function importFromCallbackUrl(callbackUrl: string): ClineCredentials {
	let url: URL;
	try {
		url = new URL(callbackUrl.trim());
	} catch {
		throw new Error("Invalid callback URL");
	}

	const codeParam = url.searchParams.get("code");
	if (!codeParam) {
		throw new Error("No 'code' parameter found in callback URL");
	}

	// The code is base64url-encoded JSON (may have trailing signature after the JSON)
	let decoded: string;
	try {
		// URL-decode first, then base64-decode
		const raw = decodeURIComponent(codeParam);
		// The code may contain a signature appended after the base64 payload.
		// Try to find the JSON boundary by looking for the base64 padding or end of JSON.
		decoded = Buffer.from(raw, "base64").toString("utf-8");
	} catch {
		throw new Error("Failed to decode callback code parameter");
	}

	// The decoded string may contain trailing binary (signature). Extract the JSON part.
	const jsonEnd = decoded.lastIndexOf("}");
	if (jsonEnd === -1) {
		throw new Error("No JSON found in decoded callback code");
	}
	const jsonStr = decoded.slice(0, jsonEnd + 1);

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
		data = JSON.parse(jsonStr);
	} catch {
		throw new Error("Failed to parse callback code JSON");
	}

	if (!data.accessToken) {
		throw new Error("No accessToken in callback data");
	}
	if (!data.refreshToken) {
		throw new Error("No refreshToken in callback data");
	}

	const displayName = data.name || [data.firstName, data.lastName].filter(Boolean).join(" ") || "";

	const credentials: ClineCredentials = {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresAt: data.expiresAt
			? new Date(data.expiresAt).getTime() / 1000
			: Date.now() / 1000 + 3600,
		email: data.email || "",
		displayName,
		startedAt: Date.now(),
	};

	saveCredentials(credentials);
	logger.info("Cline credentials imported from callback URL", { email: credentials.email });

	// Fetch user info in background to populate userId
	fetchAndUpdateUserInfo().catch(() => {});

	return credentials;
}

/**
 * Start browser-based OAuth flow.
 * 1. Request the authorization URL from Cline API (with a localhost callback).
 * 2. Start a local HTTP server to receive the callback.
 * 3. Return the URL for the frontend to open in a browser.
 * 4. Wait for the callback, parse the code parameter directly.
 *
 * For remote deployments, use importFromCallbackUrl() instead.
 */
export async function startBrowserAuth(
	apiBaseUrl?: string,
): Promise<{ authorizeUrl: string; waitForCompletion: () => Promise<ClineCredentials> }> {
	if (pendingOAuthState) {
		pendingOAuthState.reject(new Error("New OAuth flow started"));
		if (pendingOAuthState.server) {
			pendingOAuthState.server.stop();
		}
		pendingOAuthState = null;
		pendingAuthorizeUrl = null;
	}

	const baseUrl = (apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");

	// Find an available port for the callback server
	const callbackPort = 19876;
	const callbackUrl = `http://localhost:${callbackPort}/auth/callback`;

	// Request authorization URL from Cline API
	const authEndpoint = new URL(`${baseUrl}/api/v1/auth/authorize`);
	authEndpoint.searchParams.set("client_type", "extension");
	authEndpoint.searchParams.set("callback_url", callbackUrl);
	authEndpoint.searchParams.set("redirect_uri", callbackUrl);

	const authResponse = await fetch(authEndpoint.toString(), {
		method: "GET",
		redirect: "manual",
		headers: buildClineAccountHeaders(),
	});

	let authorizeUrl: string;
	if (authResponse.status >= 300 && authResponse.status < 400) {
		const location = authResponse.headers.get("Location");
		if (!location) throw new Error("No redirect URL in Cline auth response");
		authorizeUrl = location;
	} else if (authResponse.ok) {
		const data = (await authResponse.json()) as { redirect_url?: string };
		if (!data.redirect_url) throw new Error("No redirect_url in Cline auth response");
		authorizeUrl = data.redirect_url;
	} else {
		const errText = await authResponse.text().catch(() => "");
		throw new Error(`Cline auth request failed: ${authResponse.status} ${errText}`);
	}

	// Create a promise that resolves when the callback is received
	const codePromise = new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(
			() => {
				reject(new Error("OAuth callback timeout (5 minutes)"));
				cleanup();
			},
			5 * 60 * 1000,
		);

		const cleanup = () => {
			clearTimeout(timeout);
			if (pendingOAuthState?.server) {
				pendingOAuthState.server.stop();
			}
			pendingOAuthState = null;
			pendingAuthorizeUrl = null;
		};

		// Start local callback server
		const server = Bun.serve({
			port: callbackPort,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/auth/callback") {
					const fullUrl = req.url;
					resolve(fullUrl);
					cleanup();
					return new Response(
						"<html><body><h2>Authorization successful!</h2><p>You can close this window.</p><script>window.close()</script></body></html>",
						{ headers: { "Content-Type": "text/html" } },
					);
				}
				return new Response("Not found", { status: 404 });
			},
		});

		pendingOAuthState = { resolve, reject, server };
		pendingAuthorizeUrl = authorizeUrl;
	});

	const waitForCompletion = async (): Promise<ClineCredentials> => {
		const fullCallbackUrl = await codePromise;
		// The callback URL contains credentials directly in the code parameter
		return importFromCallbackUrl(fullCallbackUrl);
	};

	return { authorizeUrl, waitForCompletion };
}

/** Cancel any pending OAuth flow. */
export function cancelBrowserAuth(): void {
	if (pendingOAuthState) {
		pendingOAuthState.reject(new Error("OAuth flow cancelled"));
		if (pendingOAuthState.server) {
			pendingOAuthState.server.stop();
		}
		pendingOAuthState = null;
	}
	pendingAuthorizeUrl = null;
}

/** Check if there's a pending OAuth flow. */
export function hasPendingAuth(): boolean {
	return pendingOAuthState !== null;
}

/** Get the authorize URL of the pending OAuth flow (null if none). */
export function getPendingAuthorizeUrl(): string | null {
	return pendingAuthorizeUrl;
}
