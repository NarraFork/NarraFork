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
import { logger } from "./logger";

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

function extractIdTokenInfo(tokens: TokenResponse): {
	accountId?: string;
	email?: string;
} {
	const result: { accountId?: string; email?: string } = {};
	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token);
		if (claims) {
			result.email = claims.email;
			const id =
				claims.chatgpt_account_id ||
				claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
				claims.organizations?.[0]?.id;
			if (id) result.accountId = id;
		}
	}
	if (!result.accountId && tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token);
		if (claims) {
			result.accountId =
				claims.chatgpt_account_id ||
				claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
				claims.organizations?.[0]?.id;
			if (!result.email) result.email = claims.email;
		}
	}
	return result;
}

// === Token exchange ===

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
		const text = await response.text().catch(() => "");
		throw new Error(`Token exchange failed: ${response.status} ${text}`);
	}
	const raw = await response.text();
	try {
		return JSON.parse(raw) as TokenResponse;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Token exchange returned non-JSON payload: ${message}. body preview=${raw.slice(0, 500)}`,
		);
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
<div class="error">${error}</div></div></body></html>`;

interface PendingOAuth {
	pkce: PkceCodes;
	state: string;
	proxy?: string;
	resolve: (tokens: TokenResponse) => void;
	reject: (error: Error) => void;
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined;
let pendingOAuth: PendingOAuth | undefined;

const CALLBACK_PORT = 1455;

async function ensureOAuthServer(): Promise<{ port: number; redirectUri: string }> {
	if (oauthServer) {
		const port = oauthServer.port ?? CALLBACK_PORT;
		return { port, redirectUri: `http://localhost:${port}/auth/callback` };
	}

	// Use fixed port 1455 to match Go's RedirectURI.
	// The server is kept alive across multiple OAuth flows to avoid port-release
	// race conditions when Bun.serve is stopped and immediately restarted.
	oauthServer = Bun.serve({
		port: CALLBACK_PORT,
		reusePort: true,
		fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === "/auth/callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				const errorDescription = url.searchParams.get("error_description");

				if (error) {
					const errorMsg = errorDescription || error;
					pendingOAuth?.reject(new Error(errorMsg));
					pendingOAuth = undefined;
					return new Response(HTML_ERROR(errorMsg), {
						headers: { "Content-Type": "text/html" },
					});
				}

				if (!code) {
					const errorMsg = "Missing authorization code";
					pendingOAuth?.reject(new Error(errorMsg));
					pendingOAuth = undefined;
					return new Response(HTML_ERROR(errorMsg), {
						status: 400,
						headers: { "Content-Type": "text/html" },
					});
				}

				if (!pendingOAuth || state !== pendingOAuth.state) {
					const errorMsg = pendingOAuth
						? "Invalid state - potential CSRF attack"
						: "No pending OAuth flow (expired or already completed)";
					pendingOAuth?.reject(new Error(errorMsg));
					pendingOAuth = undefined;
					return new Response(HTML_ERROR(errorMsg), {
						status: 400,
						headers: { "Content-Type": "text/html" },
					});
				}

				const current = pendingOAuth;
				pendingOAuth = undefined;
				const port = oauthServer?.port ?? 0;

				exchangeCodeForTokens(
					code,
					`http://localhost:${port}/auth/callback`,
					current.pkce,
					current.proxy,
				)
					.then((tokens) => current.resolve(tokens))
					.catch((err) => {
						// Enhance error message when proxy is not configured
						if (!current.proxy && isNetworkError(err)) {
							current.reject(
								new Error(
									`Token exchange failed (no proxy configured): ${err.message}. ` +
										`If you are behind a firewall, configure the Codex proxy first.`,
								),
							);
						} else {
							current.reject(err);
						}
					});

				return new Response(HTML_SUCCESS, {
					headers: { "Content-Type": "text/html" },
				});
			}

			return new Response("Not found", { status: 404 });
		},
	});

	const port = oauthServer.port ?? 0;
	logger.info("Codex OAuth callback server started (persistent)", { port });
	return { port, redirectUri: `http://localhost:${port}/auth/callback` };
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
}> {
	const { redirectUri } = await ensureOAuthServer();
	const pkce = generatePKCE();
	const state = generateState();

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
					reject(new Error("OAuth callback timeout"));
				}
			},
			5 * 60 * 1000,
		);

		pendingOAuth = {
			pkce,
			state,
			proxy,
			resolve: (tokens) => {
				clearTimeout(timeout);
				const info = extractIdTokenInfo(tokens);
				resolve({
					accessToken: tokens.access_token,
					refreshToken: tokens.refresh_token,
					expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
					accountId: info.accountId,
					email: info.email,
				});
			},
			reject: (error) => {
				clearTimeout(timeout);
				reject(error);
			},
		};
	});

	return { authorizeUrl, tokenPromise };
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
 * Cancel any pending browser OAuth flow.
 * The callback server is intentionally kept alive for future flows.
 */
export function cancelBrowserOAuth(): void {
	if (pendingOAuth) {
		pendingOAuth.reject(new Error("Login cancelled"));
		pendingOAuth = undefined;
	}
}
