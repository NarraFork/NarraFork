/**
 * Codex (ChatGPT Pro/Plus) OAuth authentication.
 *
 * Implements two OAuth flows:
 *   1. Browser-based OAuth 2.0 + PKCE — local callback server on a dynamic port
 *   2. Device code flow — headless, user enters code on OpenAI website
 *
 * Token storage is integrated into the OpenAIProviderConfig via `codexOAuth` field.
 * Token refresh is handled transparently by the OpenAI provider adapter.
 *
 * All outbound requests support an optional HTTPS proxy via Bun's native
 * `fetch({ proxy })` option.
 *
 * Reference: opencode project's plugin/codex.ts
 */

import { createHash, randomBytes } from "node:crypto";
import { readResponseTextWithLimit } from "./agent/response-body";
import { logger } from "./logger";
import { findExcludingRange, readWindowsExcludedPortRangesAsync } from "./windows-excluded-ports";

// === Constants ===

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const POLLING_SAFETY_MARGIN_MS = 3000;

// === Types ===

export interface CodexTokens {
	accessToken: string;
	refreshToken: string;
	/** Absolute expiry timestamp (ms since epoch). */
	expiresAt: number;
	/** ChatGPT account ID extracted from JWT claims. */
	accountId?: string;
	/** Email extracted from JWT claims. */
	email?: string;
	/** JWT subject claim — unique per user, used for deduplication. */
	sub?: string;
}

interface TokenResponse {
	id_token: string;
	access_token: string;
	refresh_token: string;
	expires_in?: number;
}

interface PkceCodes {
	verifier: string;
	challenge: string;
}

interface IdTokenClaims {
	sub?: string;
	chatgpt_account_id?: string;
	organizations?: Array<{ id: string }>;
	email?: string;
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
		chatgpt_plan_type?: string;
	};
}

// === Proxy-aware fetch ===

/**
 * Wrapper around global `fetch` that injects Bun's `proxy` option when provided.
 * Bun extends the Fetch API with a non-standard `proxy` property on RequestInit.
 */
function pfetch(
	input: string | URL | Request,
	init?: RequestInit,
	proxy?: string,
): Promise<Response> {
	if (proxy) {
		// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
		return fetch(input, { ...init, proxy } as any);
	}
	return fetch(input, init);
}

// === PKCE helpers ===

function generatePKCE(): PkceCodes {
	// 96 random bytes → base64url (128 chars), matching Go's generateCodeVerifier
	const verifier = randomBytes(96).toString("base64url");
	// SHA-256 of the verifier string → base64url (43 chars)
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function generateState(): string {
	// 16 random bytes → hex (32 chars), matching Go's GenerateRandomState
	return randomBytes(16).toString("hex");
}

// === JWT parsing ===

function parseJwtClaims(token: string): IdTokenClaims | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString());
	} catch {
		return undefined;
	}
}

export function extractCodexTokenInfo(tokens: { idToken?: string; accessToken?: string }): {
	accountId?: string;
	email?: string;
	sub?: string;
} {
	const result: { accountId?: string; email?: string; sub?: string } = {};
	if (tokens.idToken) {
		const claims = parseJwtClaims(tokens.idToken);
		if (claims) {
			result.email = claims.email;
			if (claims.sub) result.sub = claims.sub;
			// Prefer user-level account IDs; fall back to organizations[0].id
			// only when no user-level ID is available (needed for usage API).
			const id =
				claims.chatgpt_account_id ||
				claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
				claims.organizations?.[0]?.id;
			if (id) result.accountId = id;
		}
	}
	if (!result.accountId && tokens.accessToken) {
		const claims = parseJwtClaims(tokens.accessToken);
		if (claims) {
			result.accountId =
				claims.chatgpt_account_id ||
				claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
				claims.organizations?.[0]?.id;
			if (!result.email) result.email = claims.email;
			if (!result.sub && claims.sub) result.sub = claims.sub;
		}
	}
	return result;
}

function extractIdTokenInfo(tokens: TokenResponse): {
	accountId?: string;
	email?: string;
	sub?: string;
} {
	return extractCodexTokenInfo({
		idToken: tokens.id_token,
		accessToken: tokens.access_token,
	});
}

// === Token exchange ===

export class CodexOAuthError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly restartRequired = false,
	) {
		super(message);
	}
}

async function exchangeCodeForTokens(
	code: string,
	redirectUri: string,
	pkce: PkceCodes,
	proxy?: string,
): Promise<TokenResponse> {
	const response = await pfetch(
		`${ISSUER}/oauth/token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal: AbortSignal.timeout(30_000),
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: CLIENT_ID,
				code_verifier: pkce.verifier,
			}).toString(),
		},
		proxy,
	);
	if (!response.ok) {
		const text = await readResponseTextWithLimit(response, 64 * 1024).catch(() => "");
		let upstreamCode: string | undefined;
		try {
			upstreamCode = JSON.parse(text)?.error?.code;
		} catch {
			// Non-JSON upstream errors still terminate this exchange.
		}
		if (upstreamCode === "unsupported_country_region_territory") {
			throw new CodexOAuthError(
				"region_unsupported",
				"The server network region is not supported. Configure a usable proxy in NarraFork Codex settings, then start authorization again. Changing only the browser proxy may not affect token exchange. This flow has ended; do not resubmit the old callback URL.",
				true,
			);
		}
		throw new CodexOAuthError(
			"token_exchange_failed",
			`Token exchange failed: ${response.status} ${text.slice(0, 500)}. Start authorization again; do not resubmit the old callback URL.`,
			true,
		);
	}
	const raw = await readResponseTextWithLimit(response, 64 * 1024);
	try {
		const tokens = JSON.parse(raw) as TokenResponse;
		if (
			!tokens ||
			typeof tokens.access_token !== "string" ||
			!tokens.access_token ||
			typeof tokens.refresh_token !== "string" ||
			!tokens.refresh_token
		) {
			throw new Error("Missing access or refresh token");
		}
		return tokens;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Token exchange returned an invalid token payload: ${message}`);
	}
}

/** Refresh an expired access token using the refresh token. */
export async function refreshCodexToken(
	refreshToken: string,
	proxy?: string,
): Promise<CodexTokens> {
	const response = await pfetch(
		`${ISSUER}/oauth/token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}).toString(),
		},
		proxy,
	);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Token refresh failed: ${response.status} ${text}`);
	}
	const raw = await response.text();
	let tokens: TokenResponse;
	try {
		tokens = JSON.parse(raw) as TokenResponse;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Token refresh returned non-JSON payload: ${message}. body preview=${raw.slice(0, 500)}`,
		);
	}
	const info = extractIdTokenInfo(tokens);
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		accountId: info.accountId,
		email: info.email,
		sub: info.sub,
	};
}

// === Browser OAuth flow ===

const HTML_SUCCESS = `<!doctype html>
<html><head><title>NarraFork - Codex Authorization Successful</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1b1e;color:#c1c2c5}
.container{text-align:center;padding:2rem}h1{color:#748ffc;margin-bottom:1rem}p{color:#909296}</style></head>
<body><div class="container"><h1>Authorization Successful</h1><p>You can close this window and return to NarraFork.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;

const HTML_ERROR = (error: string) => `<!doctype html>
<html><head><title>NarraFork - Codex Authorization Failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1b1e;color:#c1c2c5}
.container{text-align:center;padding:2rem}h1{color:#ff6b6b;margin-bottom:1rem}p{color:#909296}
.error{color:#ffa8a8;font-family:monospace;margin-top:1rem;padding:1rem;background:#2c2e33;border-radius:.5rem}</style></head>
<body><div class="container"><h1>Authorization Failed</h1><p>An error occurred during authorization.</p>
<div class="error">${error.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char)}</div></div></body></html>`;

interface PendingOAuth {
	pkce: PkceCodes;
	exchanging?: boolean;
	state: string;
	proxy?: string;
	/** Exact redirect_uri sent in the authorize request — must be replayed on exchange. */
	redirectUri: string;
	resolve: (tokens: TokenResponse) => void;
	reject: (error: Error) => void;
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined;
let pendingOAuth: PendingOAuth | undefined;
let browserOAuthFailure: CodexOAuthError | undefined;

export function getBrowserOAuthStatus() {
	return {
		status: pendingOAuth
			? pendingOAuth.exchanging
				? "exchanging"
				: "waiting"
			: browserOAuthFailure
				? "failed"
				: "idle",
		errorCode: browserOAuthFailure?.code,
		error: browserOAuthFailure?.message,
	};
}

async function completeBrowserOAuthExchange(current: PendingOAuth, code: string) {
	if (current.exchanging) {
		throw new CodexOAuthError(
			"exchange_in_progress",
			"Token exchange is already in progress. Please wait.",
		);
	}
	current.exchanging = true;
	try {
		const tokens = await exchangeCodeForTokens(
			code,
			current.redirectUri,
			current.pkce,
			current.proxy,
		);
		if (pendingOAuth !== current) {
			throw new CodexOAuthError(
				"flow_expired",
				"This authorization has ended. Start authorization again.",
				true,
			);
		}
		pendingOAuth = undefined;
		current.resolve(tokens);
		return tokens;
	} catch (err) {
		const failure =
			err instanceof CodexOAuthError
				? err
				: new CodexOAuthError(
						isNetworkError(err) ? "network_error" : "token_exchange_failed",
						`Token exchange failed: ${err instanceof Error ? err.message : String(err)}. Check the server's Codex proxy configuration and start authorization again.`,
						true,
					);
		if (pendingOAuth === current) {
			pendingOAuth = undefined;
			browserOAuthFailure = failure;
			current.reject(failure);
		}
		throw failure;
	}
}
/** Last known state of the callback listener, for surfacing in the browser-auth state endpoint. */
let oauthServerRunning = false;

const CALLBACK_PORT = 1455;

async function ensureOAuthServer(): Promise<{
	port: number;
	redirectUri: string;
	/** False when the local listener could not be started (e.g. port already in use). */
	running: boolean;
}> {
	if (oauthServer) {
		const port = oauthServer.port ?? CALLBACK_PORT;
		return { port, redirectUri: `http://localhost:${port}/auth/callback`, running: true };
	}

	// Re-read before each bind attempt: Windows exclusions can change between flows.
	// Do not invoke Bun.serve for a known reservation (its failure can be asynchronous).
	const excludedRange = findExcludingRange(
		CALLBACK_PORT,
		await readWindowsExcludedPortRangesAsync(),
	);
	// Another flow may have started the persistent server while netsh was running.
	// TS retains the pre-await narrowing, so explicitly re-read the shared state.
	const startedServer = oauthServer as ReturnType<typeof Bun.serve> | undefined;
	if (startedServer) {
		const port = startedServer.port ?? CALLBACK_PORT;
		return { port, redirectUri: `http://localhost:${port}/auth/callback`, running: true };
	}
	if (excludedRange) {
		oauthServerRunning = false;
		logger.warn("Codex OAuth callback port is reserved by Windows; use manual callback", {
			port: CALLBACK_PORT,
			reservedRange: `${excludedRange.start}-${excludedRange.end}`,
		});
		return {
			port: CALLBACK_PORT,
			redirectUri: `http://localhost:${CALLBACK_PORT}/auth/callback`,
			running: false,
		};
	}

	// Use fixed port 1455 to match Go's RedirectURI.
	// The server is kept alive across multiple OAuth flows to avoid port-release
	// race conditions when Bun.serve is stopped and immediately restarted.
	try {
		oauthServer = Bun.serve({
			port: CALLBACK_PORT,
			reusePort: true,
			// Keep the browser response open for the bounded 30-second token exchange.
			idleTimeout: 35,
			async fetch(req) {
				const url = new URL(req.url);

				if (url.pathname === "/auth/callback") {
					const code = url.searchParams.get("code");
					const state = url.searchParams.get("state");
					const error = url.searchParams.get("error");
					const errorDescription = url.searchParams.get("error_description");

					if (!pendingOAuth || state !== pendingOAuth.state) {
						const errorMsg = pendingOAuth
							? "Invalid state - potential CSRF attack"
							: "No pending OAuth flow (expired or already completed)";
						return new Response(
							HTML_ERROR(`${errorMsg}. Use the latest callback URL or start authorization again.`),
							{
								status: 400,
								headers: { "Content-Type": "text/html" },
							},
						);
					}

					if (pendingOAuth.exchanging) {
						return new Response(HTML_ERROR("Token exchange is already in progress. Please wait."), {
							status: 409,
							headers: { "Content-Type": "text/html" },
						});
					}
					if (error) {
						const failure = new CodexOAuthError(
							"authorization_denied",
							`${errorDescription || error}. Start authorization again.`,
							true,
						);
						pendingOAuth.reject(failure);
						pendingOAuth = undefined;
						browserOAuthFailure = failure;
						return new Response(HTML_ERROR(failure.message), {
							status: 400,
							headers: { "Content-Type": "text/html" },
						});
					}
					if (!code) {
						return new Response(
							HTML_ERROR(
								"Missing authorization code. Use the latest callback URL or start authorization again.",
							),
							{ status: 400, headers: { "Content-Type": "text/html" } },
						);
					}
					try {
						await completeBrowserOAuthExchange(pendingOAuth, code);
						return new Response(HTML_SUCCESS, {
							headers: { "Content-Type": "text/html" },
						});
					} catch (err) {
						return new Response(HTML_ERROR(err instanceof Error ? err.message : String(err)), {
							status: 400,
							headers: { "Content-Type": "text/html" },
						});
					}
				}

				return new Response("Not found", { status: 404 });
			},
		});
	} catch (err) {
		// Port busy or otherwise unavailable: do NOT block the flow and do NOT fall
		// back to another port — the redirect_uri must stay on 1455 to match the
		// registered callback. The user can finish by pasting the callback URL.
		oauthServer = undefined;
		oauthServerRunning = false;
		logger.warn("Codex OAuth callback server failed to start; continuing without it", {
			port: CALLBACK_PORT,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			port: CALLBACK_PORT,
			redirectUri: `http://localhost:${CALLBACK_PORT}/auth/callback`,
			running: false,
		};
	}

	const port = oauthServer.port ?? CALLBACK_PORT;
	oauthServerRunning = true;
	logger.info("Codex OAuth callback server started (persistent)", { port });
	return { port, redirectUri: `http://localhost:${port}/auth/callback`, running: true };
}

/** Heuristic: treat fetch/connection errors as network issues. */
function isNetworkError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("fetch") ||
		msg.includes("econnrefused") ||
		msg.includes("enotfound") ||
		msg.includes("etimedout") ||
		msg.includes("econnreset") ||
		msg.includes("unable to connect") ||
		msg.includes("network") ||
		msg.includes("dns")
	);
}

/**
 * Start the browser-based OAuth flow.
 * Returns the authorization URL to open in the browser and a promise that resolves with tokens.
 *
 * The OAuth callback server is kept alive across flows — only the pending state is replaced.
 * If a previous flow is still pending it is silently rejected before starting the new one.
 */
export async function startBrowserOAuth(proxy?: string): Promise<{
	authorizeUrl: string;
	tokenPromise: Promise<CodexTokens>;
	/**
	 * False when the local callback listener failed to start (port busy, etc.).
	 * The flow still works: the browser will land on a dead localhost URL and the
	 * user finishes by pasting it via `completeBrowserOAuthFromCallbackUrl`.
	 */
	localCallbackServer: boolean;
}> {
	const { redirectUri, running } = await ensureOAuthServer();
	const pkce = generatePKCE();
	const state = generateState();
	browserOAuthFailure = undefined;

	// Cancel any lingering previous flow
	if (pendingOAuth) {
		pendingOAuth.reject(new Error("Superseded by a new browser OAuth flow"));
		pendingOAuth = undefined;
	}

	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: "openid email profile offline_access",
		state,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		prompt: "login",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
	});
	const authorizeUrl = `${ISSUER}/oauth/authorize?${params.toString()}`;

	const tokenPromise = new Promise<CodexTokens>((resolve, reject) => {
		const timeout = setTimeout(
			() => {
				if (pendingOAuth?.state === state) {
					pendingOAuth = undefined;
					browserOAuthFailure = new CodexOAuthError(
						"flow_expired",
						"OAuth callback timeout. Start authorization again; do not resubmit the old callback URL.",
						true,
					);
					reject(browserOAuthFailure);
				}
			},
			15 * 60 * 1000,
		);

		pendingOAuth = {
			pkce,
			state,
			proxy,
			redirectUri,
			resolve: (tokens) => {
				clearTimeout(timeout);
				const info = extractIdTokenInfo(tokens);
				resolve({
					accessToken: tokens.access_token,
					refreshToken: tokens.refresh_token,
					expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
					accountId: info.accountId,
					email: info.email,
					sub: info.sub,
				});
			},
			reject: (error) => {
				clearTimeout(timeout);
				reject(error);
			},
		};
	});

	return { authorizeUrl, tokenPromise, localCallbackServer: running };
}

// === Device code flow ===

export interface DeviceCodeInfo {
	deviceAuthId: string;
	userCode: string;
	verificationUrl: string;
	interval: number;
}

/**
 * Initiate the device code flow.
 * Returns the user code and verification URL for the user to complete authorization.
 */
export async function startDeviceCodeFlow(proxy?: string): Promise<DeviceCodeInfo> {
	const response = await pfetch(
		`${ISSUER}/api/accounts/deviceauth/usercode`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "narrafork/1.0",
			},
			body: JSON.stringify({ client_id: CLIENT_ID }),
		},
		proxy,
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Failed to initiate device authorization: ${response.status} ${text}`);
	}

	const raw = await response.text();
	let data: {
		device_auth_id: string;
		user_code: string;
		interval: string;
	};
	try {
		data = JSON.parse(raw) as {
			device_auth_id: string;
			user_code: string;
			interval: string;
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Device authorization start returned non-JSON payload: ${message}. ` +
				`body preview=${raw.slice(0, 500)}`,
		);
	}

	return {
		deviceAuthId: data.device_auth_id,
		userCode: data.user_code,
		verificationUrl: `${ISSUER}/codex/device`,
		interval: Math.max(Number.parseInt(data.interval, 10) || 5, 1) * 1000,
	};
}

/**
 * Poll for device code authorization completion.
 * Blocks until the user completes authorization or an error occurs.
 */
export async function pollDeviceCodeFlow(
	deviceAuthId: string,
	userCode: string,
	interval: number,
	signal?: AbortSignal,
	proxy?: string,
): Promise<CodexTokens> {
	while (!signal?.aborted) {
		const response = await pfetch(
			`${ISSUER}/api/accounts/deviceauth/token`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "narrafork/1.0",
				},
				body: JSON.stringify({
					device_auth_id: deviceAuthId,
					user_code: userCode,
				}),
			},
			proxy,
		);

		if (response.ok) {
			const raw = await response.text();
			let data: {
				authorization_code: string;
				code_verifier: string;
			};
			try {
				data = JSON.parse(raw) as {
					authorization_code: string;
					code_verifier: string;
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Device authorization poll returned non-JSON payload: ${message}. ` +
						`body preview=${raw.slice(0, 500)}`,
				);
			}

			// Exchange for tokens
			const tokenResponse = await pfetch(
				`${ISSUER}/oauth/token`,
				{
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: data.authorization_code,
						redirect_uri: `${ISSUER}/deviceauth/callback`,
						client_id: CLIENT_ID,
						code_verifier: data.code_verifier,
					}).toString(),
				},
				proxy,
			);

			if (!tokenResponse.ok) {
				throw new Error(`Token exchange failed: ${tokenResponse.status}`);
			}

			const tokenRaw = await tokenResponse.text();
			let tokens: TokenResponse;
			try {
				tokens = JSON.parse(tokenRaw) as TokenResponse;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Token exchange returned non-JSON payload: ${message}. ` +
						`body preview=${tokenRaw.slice(0, 500)}`,
				);
			}
			const info = extractIdTokenInfo(tokens);
			return {
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				accountId: info.accountId,
				email: info.email,
				sub: info.sub,
			};
		}

		// 403/404 = still pending, anything else = error
		if (response.status !== 403 && response.status !== 404) {
			throw new Error(`Device code authorization failed: ${response.status}`);
		}

		await Bun.sleep(interval + POLLING_SAFETY_MARGIN_MS);
	}

	throw new Error("Device code flow aborted");
}

/**
 * Complete a pending browser OAuth flow from a manually pasted callback URL.
 *
 * Needed for remote deployments: the authorize redirect targets
 * `http://localhost:1455/auth/callback`, which resolves on the *user's* machine,
 * not on the NarraFork host. The browser then fails to reach the callback server
 * and the user is left with a dead URL in the address bar. Pasting that URL here
 * feeds the same code/state pair back into the pending flow.
 *
 * Accepts a full URL, a bare query string, or just the code value.
 */
export async function completeBrowserOAuthFromCallbackUrl(input: string): Promise<CodexTokens> {
	const raw = input.trim();
	if (!raw) throw new Error("Callback URL is empty");

	const current = pendingOAuth;
	if (!current) {
		throw new CodexOAuthError(
			"flow_expired",
			"No pending browser authorization. Start authorization again; do not resubmit the old callback URL.",
			true,
		);
	}

	const params = parseCallbackParams(raw);

	// State is optional in the pasted value (some browsers truncate on copy), but
	// when present it must match — a mismatch means the URL belongs to another flow.
	const state = params.get("state");
	if (state && state !== current.state) {
		throw new CodexOAuthError(
			"state_mismatch",
			"Callback state does not match the pending authorization. Use the latest callback URL or start authorization again; do not keep submitting this URL.",
		);
	}

	if (current.exchanging) {
		throw new CodexOAuthError(
			"exchange_in_progress",
			"Token exchange is already in progress. Please wait.",
		);
	}
	const error = params.get("error");
	if (error) {
		const failure = new CodexOAuthError(
			"authorization_denied",
			`${params.get("error_description") || error}. Start authorization again.`,
			true,
		);
		pendingOAuth = undefined;
		browserOAuthFailure = failure;
		current.reject(failure);
		throw failure;
	}
	const code = params.get("code");
	if (!code)
		throw new CodexOAuthError(
			"invalid_callback",
			"No 'code' parameter found in the callback URL. Use the latest callback URL or start authorization again.",
		);

	// Both callback paths share the same exchange lock and terminal failure handling.
	const tokens = await completeBrowserOAuthExchange(current, code);
	const info = extractIdTokenInfo(tokens);
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		accountId: info.accountId,
		email: info.email,
		sub: info.sub,
	};
}

/**
 * Pull OAuth params out of whatever the user pasted: a full callback URL, a bare
 * query string (`?code=...&state=...`), or a naked authorization code.
 *
 * Exported for tests; production callers go through
 * `completeBrowserOAuthFromCallbackUrl`.
 */
export function parseCallbackParams(raw: string): URLSearchParams {
	const queryStart = raw.indexOf("?");
	if (queryStart >= 0) {
		return new URLSearchParams(raw.slice(queryStart + 1));
	}
	if (raw.includes("=") && raw.includes("code")) {
		return new URLSearchParams(raw);
	}
	return new URLSearchParams({ code: raw });
}

/** The redirect URI the authorize request uses, for surfacing in the UI. */
export function getBrowserOAuthRedirectUri(): string {
	const port = oauthServer?.port ?? CALLBACK_PORT;
	return `http://localhost:${port}/auth/callback`;
}

/** Whether a browser OAuth flow is currently awaiting its callback. */
export function hasPendingBrowserOAuth(): boolean {
	return !!pendingOAuth;
}

/** Whether the local callback listener is up (false = manual paste is required). */
export function isBrowserOAuthServerRunning(): boolean {
	return oauthServerRunning;
}

/**
 * Cancel any pending browser OAuth flow.
 * The callback server is intentionally kept alive for future flows.
 */
export function cancelBrowserOAuth(): void {
	browserOAuthFailure = undefined;
	if (pendingOAuth) {
		pendingOAuth.reject(new Error("Login cancelled"));
		pendingOAuth = undefined;
	}
}
