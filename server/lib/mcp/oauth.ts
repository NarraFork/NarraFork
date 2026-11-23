/**
 * OAuth 2.1 client for remote MCP servers (MCP authorization spec, 2025-11-25).
 *
 * The SDK does discovery (RFC 9728 protected-resource metadata, RFC 8414 / OIDC),
 * dynamic client registration, PKCE, token exchange and refresh; this module only
 * persists its state and decides when a browser round-trip is allowed:
 * - background connections (startup, reconnect, test) may use and refresh stored
 *   tokens but never start an authorization, so they fail with
 *   `McpAuthorizationRequiredError` instead;
 * - an admin starts the interactive flow, which keeps the PKCE verifier and `state`
 *   in memory only, single-use and short-lived, until the public callback finishes it.
 * Tokens, registered clients and client secrets live in an encrypted file next to
 * settings.json, never in settings.json itself.
 */
import { randomBytes } from "node:crypto";
import {
	auth,
	extractWWWAuthenticateParams,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { logger } from "../logger";
import { getNarraforkPath } from "../narrafork-home";
import { onSecretEncryptionChange, readSecretJSON, writeSecretJSON } from "../secret-store";
import type { McpServerConfig } from "../settings";

export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
const FLOW_TTL_MS = 10 * 60_000;
const MAX_PENDING_FLOWS = 50;
/** Never used for a code exchange: keeps the SDK off its client_credentials branch. */
const BACKGROUND_REDIRECT_URL = `http://localhost${MCP_OAUTH_CALLBACK_PATH}`;

export class McpAuthorizationRequiredError extends Error {
	constructor(serverName: string) {
		super(`MCP server "${serverName}" requires OAuth authorization`);
		this.name = "McpAuthorizationRequiredError";
	}
}

export function isMcpAuthorizationError(error: unknown): boolean {
	return error instanceof McpAuthorizationRequiredError || error instanceof UnauthorizedError;
}

interface McpOAuthRecord {
	/** Server URL + client id the stored client/tokens/discovery belong to. */
	binding?: string;
	redirectUrl?: string;
	clientSecret?: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	discoveryState?: OAuthDiscoveryState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

class McpOAuthStore {
	private records = new Map<string, McpOAuthRecord>();
	private readable = true;

	constructor(private readonly path = getNarraforkPath("mcp-oauth.json")) {
		try {
			const raw = readSecretJSON(path);
			if (raw !== undefined) {
				if (!isRecord(raw)) throw new Error("Expected an MCP OAuth record map");
				for (const [id, record] of Object.entries(raw)) {
					if (isRecord(record)) this.records.set(id, record as McpOAuthRecord);
				}
			}
		} catch (error) {
			// The unreadable file may be the only copy of the tokens: keep it untouched.
			this.readable = false;
			logger.error("MCP OAuth credentials are unreadable; leaving the file untouched", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	get(serverId: string): McpOAuthRecord {
		return { ...this.records.get(serverId) };
	}

	update(serverId: string, change: (record: McpOAuthRecord) => McpOAuthRecord | undefined): void {
		if (!this.readable) throw new Error("MCP OAuth credential file is unreadable");
		const next = new Map(this.records);
		const record = change(this.get(serverId));
		const kept = record
			? Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined))
			: {};
		if (Object.keys(kept).length) next.set(serverId, kept);
		else next.delete(serverId);
		writeSecretJSON(this.path, Object.fromEntries(next));
		this.records = next;
	}

	rewrite(): void {
		if (this.readable && this.records.size)
			writeSecretJSON(this.path, Object.fromEntries(this.records));
	}
}

let store: McpOAuthStore | undefined;
let stopRewrite: (() => void) | undefined;

function getStore(): McpOAuthStore {
	if (!store) {
		const current = new McpOAuthStore();
		store = current;
		stopRewrite = onSecretEncryptionChange(() => current.rewrite());
	}
	return store;
}

/** Tests only: forget the singleton when switching the isolated home. */
export function resetMcpOAuthForTests(): void {
	stopRewrite?.();
	stopRewrite = undefined;
	store = undefined;
	pendingFlows.clear();
	revisions.clear();
	challenges.clear();
}

/** OAuth applies to remote transports unless the admin pinned a static Authorization header. */
export function supportsMcpOAuth(config: McpServerConfig): boolean {
	return (
		(config.transport === "streamable-http" || config.transport === "sse") &&
		!!config.url &&
		!Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
	);
}

function bindingOf(config: McpServerConfig): string {
	return JSON.stringify([config.url ?? "", config.oauth?.clientId ?? ""]);
}

interface PendingFlow {
	serverId: string;
	binding: string;
	redirectUrl: string;
	state: string;
	codeVerifier?: string;
	expiresAt: number;
	/** Registration and discovery written during the flow, persisted only with its tokens. */
	staged: McpOAuthRecord;
	revision: number;
}

const pendingFlows = new Map<string, PendingFlow>();
/** Latest 401/403 challenge per server: its scope and resource metadata URL, for consent. */
interface McpOAuthChallenge {
	binding: string;
	scope?: string;
	resourceMetadataUrl?: URL;
}
const challenges = new Map<string, McpOAuthChallenge>();

/** Called by the remote transports for 401/403 responses from the MCP server itself. */
export function noteMcpOAuthChallenge(
	config: McpServerConfig,
	storeKey: string,
	response: Response,
): void {
	const { scope, resourceMetadataUrl } = extractWWWAuthenticateParams(response);
	if (!scope && !resourceMetadataUrl) return;
	const binding = bindingOf(config);
	const previous = challenges.get(storeKey);
	const kept = previous?.binding === binding ? previous : undefined;
	// A challenge missing a parameter (e.g. from a discovery endpoint) keeps the one seen before.
	challenges.set(storeKey, {
		binding,
		scope: scope ?? kept?.scope,
		resourceMetadataUrl: resourceMetadataUrl ?? kept?.resourceMetadataUrl,
	});
}

function latestChallenge(config: McpServerConfig): McpOAuthChallenge | undefined {
	const challenge = challenges.get(config.id);
	return challenge?.binding === bindingOf(config) ? challenge : undefined;
}

/** Bumped by sign-out / delete so an exchange or refresh already in flight cannot write back. */
const revisions = new Map<string, number>();

function revisionOf(serverId: string): number {
	return revisions.get(serverId) ?? 0;
}

function resetCredentials(serverId: string): void {
	revisions.set(serverId, revisionOf(serverId) + 1);
	challenges.delete(serverId);
	for (const [state, flow] of pendingFlows)
		if (flow.serverId === serverId) pendingFlows.delete(state);
}

function prunePendingFlows(now = Date.now()): void {
	for (const [state, flow] of pendingFlows) if (flow.expiresAt <= now) pendingFlows.delete(state);
}

class NarraForkOAuthProvider implements OAuthClientProvider {
	authorizationUrl?: URL;
	private readonly revision: number;

	constructor(
		private readonly config: McpServerConfig,
		private readonly storeKey: string,
		private readonly flow?: PendingFlow,
	) {
		this.revision = flow?.revision ?? revisionOf(storeKey);
	}

	private stored(): McpOAuthRecord {
		const record = getStore().get(this.storeKey);
		if (record.binding === bindingOf(this.config)) return record;
		return { clientSecret: record.clientSecret };
	}

	private record(): McpOAuthRecord {
		return this.flow ? { ...this.stored(), ...this.flow.staged } : this.stored();
	}

	/**
	 * A flow stages its writes until consent yields tokens, so a re-authorization the
	 * admin abandons (or one that re-registers for a new callback URL) leaves the
	 * existing authorization intact.
	 */
	private save(change: Partial<McpOAuthRecord>): void {
		if (revisionOf(this.storeKey) !== this.revision)
			throw new Error("MCP OAuth credentials were reset while this request was running");
		if (this.flow && !change.tokens) {
			Object.assign(this.flow.staged, change);
			return;
		}
		if (this.flow) {
			change = { ...this.flow.staged, ...change };
			this.flow.staged = {};
		}
		const binding = bindingOf(this.config);
		const stored = getStore().get(this.storeKey).binding;
		// A background connection for another URL / client id (e.g. testing an unsaved
		// edit) must not replace the saved server's credentials; only a flow may rebind.
		if (!this.flow && stored !== undefined && stored !== binding) return;
		getStore().update(this.storeKey, (current) => ({
			...(current.binding === binding ? current : { clientSecret: current.clientSecret }),
			binding,
			...change,
		}));
	}

	private backgroundStop(): never {
		throw new McpAuthorizationRequiredError(this.config.name);
	}

	get redirectUrl(): string {
		return this.flow?.redirectUrl ?? this.record().redirectUrl ?? BACKGROUND_REDIRECT_URL;
	}

	get clientMetadata(): OAuthClientMetadata {
		const secret = this.record().clientSecret;
		return {
			client_name: "NarraFork",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: secret ? "client_secret_post" : "none",
			...(this.config.oauth?.scope ? { scope: this.config.oauth.scope } : {}),
		};
	}

	state(): string {
		return this.flow?.state ?? this.backgroundStop();
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const record = this.record();
		// Background: only refresh existing tokens, never register or authorize.
		if (!this.flow && !record.tokens) this.backgroundStop();
		const clientId = this.config.oauth?.clientId;
		if (clientId)
			return {
				client_id: clientId,
				...(record.clientSecret && { client_secret: record.clientSecret }),
			};
		const info = record.clientInformation;
		// A dynamically registered client is tied to the redirect URI it registered.
		if (info && this.flow && record.redirectUrl !== this.flow.redirectUrl) return undefined;
		return info;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.save({ clientInformation, redirectUrl: this.redirectUrl, tokens: undefined });
	}

	tokens(): OAuthTokens | undefined {
		// An admin-started flow always goes to consent: refreshing the old grant would
		// keep its old scope and hide a needed scope upgrade.
		return this.flow ? undefined : this.record().tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		const previous = this.flow ? undefined : this.record().tokens;
		// Refresh responses may omit the refresh token, which then stays valid (RFC 6749 §6).
		const refresh_token = tokens.refresh_token ?? previous?.refresh_token;
		this.save({
			tokens: { ...tokens, ...(refresh_token && { refresh_token }) },
			redirectUrl: this.redirectUrl,
		});
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (!this.flow) this.backgroundStop();
		this.authorizationUrl = authorizationUrl;
	}

	saveCodeVerifier(codeVerifier: string): void {
		if (!this.flow) this.backgroundStop();
		this.flow.codeVerifier = codeVerifier;
	}

	codeVerifier(): string {
		if (!this.flow?.codeVerifier) throw new Error("No PKCE code verifier for this authorization");
		return this.flow.codeVerifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "verifier") {
			if (this.flow) this.flow.codeVerifier = undefined;
			return;
		}
		this.save({
			...((scope === "all" || scope === "client") && { clientInformation: undefined }),
			...((scope === "all" || scope === "tokens") && { tokens: undefined }),
			...((scope === "all" || scope === "discovery") && { discoveryState: undefined }),
		});
	}

	saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
		this.save({ discoveryState });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.record().discoveryState;
	}
}

/**
 * Provider for a background connection. `storeKey` lets a test of an existing server
 * reuse that server's tokens.
 */
export function createMcpOAuthProvider(
	config: McpServerConfig,
	storeKey = config.id,
): OAuthClientProvider | undefined {
	return supportsMcpOAuth(config) ? new NarraForkOAuthProvider(config, storeKey) : undefined;
}

export type McpOAuthStartResult = { authorized: true } | { authorizationUrl: string };

/** Begin an interactive authorization for a configured server. */
export async function startMcpOAuth(
	config: McpServerConfig,
	redirectUrl: string,
): Promise<McpOAuthStartResult> {
	if (!supportsMcpOAuth(config) || !config.url)
		throw new Error("OAuth applies only to remote MCP servers without an Authorization header");
	prunePendingFlows();
	if (pendingFlows.size >= MAX_PENDING_FLOWS)
		throw new Error("Too many pending MCP authorizations; try again later");
	const flow: PendingFlow = {
		serverId: config.id,
		binding: bindingOf(config),
		redirectUrl,
		state: randomBytes(32).toString("base64url"),
		expiresAt: Date.now() + FLOW_TTL_MS,
		staged: {},
		revision: revisionOf(config.id),
	};
	const provider = new NarraForkOAuthProvider(config, config.id, flow);
	const challenge = latestChallenge(config);
	const scope = config.oauth?.scope ?? challenge?.scope;
	const result = await auth(provider, {
		serverUrl: config.url,
		...(scope && { scope }),
		...(challenge?.resourceMetadataUrl && { resourceMetadataUrl: challenge.resourceMetadataUrl }),
	});
	if (result === "AUTHORIZED") return { authorized: true };
	if (!provider.authorizationUrl) throw new Error("Authorization server returned no URL");
	pendingFlows.set(flow.state, flow);
	return { authorizationUrl: provider.authorizationUrl.toString() };
}

/**
 * Finish an authorization from the callback. The state is consumed before any network
 * call, so a replayed or raced callback cannot reuse the verifier.
 */
export async function finishMcpOAuth(
	state: string,
	code: string,
	findConfig: (serverId: string) => McpServerConfig | undefined,
): Promise<McpServerConfig> {
	prunePendingFlows();
	const flow = pendingFlows.get(state);
	if (!flow) throw new Error("Unknown or expired authorization request");
	pendingFlows.delete(state);
	const config = findConfig(flow.serverId);
	if (!config?.url || !supportsMcpOAuth(config) || bindingOf(config) !== flow.binding)
		throw new Error("The MCP server changed while it was being authorized");
	const provider = new NarraForkOAuthProvider(config, config.id, flow);
	const result = await auth(provider, { serverUrl: config.url, authorizationCode: code });
	if (result !== "AUTHORIZED") throw new Error("Authorization did not complete");
	return config;
}

/** Abandon a pending authorization (the user denied it at the authorization server). */
export function cancelMcpOAuth(state: string): void {
	pendingFlows.delete(state);
}

export interface McpOAuthStatus {
	supported: boolean;
	authorized: boolean;
	hasClientSecret: boolean;
}

export function getMcpOAuthStatus(config: McpServerConfig): McpOAuthStatus {
	const record = getStore().get(config.id);
	return {
		supported: supportsMcpOAuth(config),
		authorized: record.binding === bindingOf(config) && !!record.tokens,
		hasClientSecret: !!record.clientSecret,
	};
}

/** Set (string), clear (null) or keep (undefined) the admin-configured client secret. */
export function setMcpOAuthClientSecret(serverId: string, secret: string | null | undefined): void {
	if (secret === undefined) return;
	getStore().update(serverId, (record) => ({ ...record, clientSecret: secret || undefined }));
}

/** Forget tokens and registration but keep the configured client secret. */
export function signOutMcpOAuth(serverId: string): void {
	resetCredentials(serverId);
	getStore().update(serverId, (record) => ({ clientSecret: record.clientSecret }));
}

/** Remove everything stored for a deleted server. */
export function deleteMcpOAuth(serverId: string): void {
	resetCredentials(serverId);
	getStore().update(serverId, () => undefined);
}
