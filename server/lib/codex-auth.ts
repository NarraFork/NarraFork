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

async function generatePKCE(): Promise<PkceCodes> {
	const verifier = generateRandomString(43);
	const data = new TextEncoder().encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64UrlEncode(hash);
	return { verifier, challenge };
}

function generateRandomString(length: number): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes)
		.map((b) => chars[b % chars.length])
		.join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const binary = String.fromCharCode(...bytes);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateState(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
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

function extractAccountId(tokens: TokenResponse): string | undefined {
	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token);
		if (claims) {
			const id =
				claims.chatgpt_account_id ||
				claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
				claims.organizations?.[0]?.id;
			if (id) return id;
		}
	}
	if (tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token);
		if (claims) {
			return (
				claims.chatgpt_account_id ||
				claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
				claims.organizations?.[0]?.id
			);
		}
	}
	return undefined;
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
	return response.json();
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
	const tokens: TokenResponse = await response.json();
	const accountId = extractAccountId(tokens);
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		accountId,
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

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
	if (oauthServer) {
		const port = oauthServer.port ?? 0;
		return { port, redirectUri: `http://localhost:${port}/auth/callback` };
	}

	// Use port 0 to let the OS assign a free port
	oauthServer = Bun.serve({
		port: 0,
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
					const errorMsg = "Invalid state - potential CSRF attack";
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
					.catch((err) => current.reject(err));

				return new Response(HTML_SUCCESS, {
					headers: { "Content-Type": "text/html" },
				});
			}

			return new Response("Not found", { status: 404 });
		},
	});

	const port = oauthServer.port ?? 0;
	logger.info("Codex OAuth server started", { port });
	return { port, redirectUri: `http://localhost:${port}/auth/callback` };
}

function stopOAuthServer() {
	if (oauthServer) {
		oauthServer.stop();
		oauthServer = undefined;
		logger.info("Codex OAuth server stopped");
	}
}

/**
 * Start the browser-based OAuth flow.
 * Returns the authorization URL to open in the browser and a promise that resolves with tokens.
 */
export async function startBrowserOAuth(proxy?: string): Promise<{
	authorizeUrl: string;
	tokenPromise: Promise<CodexTokens>;
}> {
	const { redirectUri } = await startOAuthServer();
	const pkce = await generatePKCE();
	const state = generateState();

	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: redirectUri,
		scope: "openid profile email offline_access",
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state,
		originator: "narrafork",
	});
	const authorizeUrl = `${ISSUER}/oauth/authorize?${params.toString()}`;

	const tokenPromise = new Promise<CodexTokens>((resolve, reject) => {
		const timeout = setTimeout(
			() => {
				if (pendingOAuth) {
					pendingOAuth = undefined;
					stopOAuthServer();
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
				stopOAuthServer();
				const accountId = extractAccountId(tokens);
				resolve({
					accessToken: tokens.access_token,
					refreshToken: tokens.refresh_token,
					expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
					accountId,
				});
			},
			reject: (error) => {
				clearTimeout(timeout);
				stopOAuthServer();
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

	const data = (await response.json()) as {
		device_auth_id: string;
		user_code: string;
		interval: string;
	};

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
			const data = (await response.json()) as {
				authorization_code: string;
				code_verifier: string;
			};

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

			const tokens: TokenResponse = await tokenResponse.json();
			const accountId = extractAccountId(tokens);
			return {
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				accountId,
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
 */
export function cancelBrowserOAuth(): void {
	if (pendingOAuth) {
		pendingOAuth.reject(new Error("Login cancelled"));
		pendingOAuth = undefined;
	}
	stopOAuthServer();
}
