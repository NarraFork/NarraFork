import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { settings } from "../lib/settings";
import { externalWsTicketSchema } from "../lib/validators/external";
import type { OAuthAuthPrincipal } from "../middleware/auth";

export const EXTERNAL_NARRATORS_WS_CHANNEL = "external-narrators" as const;

export type OAuthWsTicketChannel = typeof EXTERNAL_NARRATORS_WS_CHANNEL;
export type OAuthWsTicketAuthSnapshot = OAuthAuthPrincipal;

export interface IssuedOAuthWsTicket {
	ticket: string;
	expiresIn: number;
}

export interface ConsumedOAuthWsTicket {
	channel: OAuthWsTicketChannel;
	auth: OAuthWsTicketAuthSnapshot;
}

export interface OAuthWsTicketStoreEntry extends ConsumedOAuthWsTicket {
	issuedAtMs: number;
	expiresAtMs: number;
}

export interface OAuthWsTicketServiceOptions {
	ttlMs?: number;
	ttlSeconds?: number;
	maxTickets?: number;
	now?: () => number;
	randomBytes?: (size: number) => Uint8Array;
	store?: Map<string, OAuthWsTicketStoreEntry>;
}

export interface ExternalWebSocketRolloutSettings {
	ticketTtlMs: number;
	ticketTtlSeconds: number;
	maxTickets: number;
	maxFrameBytes: number;
	allowedOrigins: string[];
	maxSubscriptionsPerFrame: number;
	maxSubscriptionsPerConnection: number;
	maxGlobalConnections: number;
	maxConnectionsPerToken: number;
	maxConnectionsPerGrant: number;
	maxConnectionsPerClient: number;
	maxConnectionsPerUser: number;
	maxBufferedAmount: number;
}

const TICKET_BYTES = 32;
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 45_000;
const DEFAULT_MAX_TICKETS = 1_000;
const MAX_CONFIGURED_TICKETS = 10_000;
const SHARED_STORE_KEY = "narrafork.oauthWsTicketService.tickets";

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function cloneAuthSnapshot(auth: OAuthAuthPrincipal): OAuthWsTicketAuthSnapshot {
	return {
		type: "oauth",
		user: { ...auth.user },
		oauth: {
			tokenId: auth.oauth.tokenId,
			clientId: auth.oauth.clientId,
			oauthClientId: auth.oauth.oauthClientId,
			grantId: auth.oauth.grantId,
			refreshFamilyId: auth.oauth.refreshFamilyId,
			expiresAt: auth.oauth.expiresAt,
			scopes: [...auth.oauth.scopes],
		},
	};
}

/**
 * Read the external OAuth WebSocket operational limits. The endpoint itself is
 * always enabled; per-capability access is enforced by OAuth scopes/grants.
 * Every limit retains a bounded default.
 */
export function isExternalWebSocketOriginAllowed(
	origin: string | null,
	allowedOrigins: readonly string[],
): boolean {
	return origin === null || allowedOrigins.includes(origin);
}

export function getExternalWebSocketRolloutSettings(): ExternalWebSocketRolloutSettings {
	const config = (
		settings as unknown as {
			oauth?: {
				externalWebSocket?: {
					ticketTtlMs?: unknown;
					ticketTtlSeconds?: unknown;
					ttlSeconds?: unknown;
					maxTickets?: unknown;
					maxFrameBytes?: unknown;
					allowedOrigins?: unknown;
					maxSubscriptionsPerFrame?: unknown;
					maxSubscriptionsPerConnection?: unknown;
					maxGlobalConnections?: unknown;
					maxConnectionsPerToken?: unknown;
					maxConnectionsPerGrant?: unknown;
					maxConnectionsPerClient?: unknown;
					maxConnectionsPerUser?: unknown;
					maxBufferedAmount?: unknown;
				};
			};
		}
	).oauth?.externalWebSocket;

	const legacyTtlSeconds = config?.ticketTtlSeconds ?? config?.ttlSeconds;
	const configuredTtlMs =
		typeof config?.ticketTtlMs === "number"
			? config.ticketTtlMs
			: typeof legacyTtlSeconds === "number"
				? legacyTtlSeconds * 1_000
				: undefined;
	const ticketTtlMs = boundedInteger(configuredTtlMs, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
	const allowedOrigins = Array.isArray(config?.allowedOrigins)
		? config.allowedOrigins.filter((value): value is string => typeof value === "string")
		: [];
	return {
		ticketTtlMs,
		ticketTtlSeconds: Math.ceil(ticketTtlMs / 1_000),
		maxTickets: boundedInteger(config?.maxTickets, DEFAULT_MAX_TICKETS, 1, MAX_CONFIGURED_TICKETS),
		maxFrameBytes: boundedInteger(config?.maxFrameBytes, 65_536, 4_096, 262_144),
		allowedOrigins,
		maxSubscriptionsPerFrame: boundedInteger(config?.maxSubscriptionsPerFrame, 20, 1, 100),
		maxSubscriptionsPerConnection: boundedInteger(
			config?.maxSubscriptionsPerConnection,
			50,
			1,
			200,
		),
		maxGlobalConnections: boundedInteger(config?.maxGlobalConnections, 1_000, 1, 5_000),
		maxConnectionsPerToken: boundedInteger(config?.maxConnectionsPerToken, 8, 1, 32),
		maxConnectionsPerGrant: boundedInteger(config?.maxConnectionsPerGrant, 16, 1, 128),
		maxConnectionsPerClient: boundedInteger(config?.maxConnectionsPerClient, 256, 1, 1_000),
		maxConnectionsPerUser: boundedInteger(config?.maxConnectionsPerUser, 32, 1, 128),
		maxBufferedAmount: boundedInteger(config?.maxBufferedAmount, 1_048_576, 65_536, 8_388_608),
	};
}

export class OAuthWsTicketService {
	private readonly defaultTtlMs: number;
	private readonly defaultMaxTickets: number;
	private readonly now: () => number;
	private readonly generateRandomBytes: (size: number) => Uint8Array;
	private readonly store: Map<string, OAuthWsTicketStoreEntry>;

	constructor(options: OAuthWsTicketServiceOptions = {}) {
		this.defaultTtlMs = boundedInteger(
			options.ttlMs ?? (options.ttlSeconds === undefined ? undefined : options.ttlSeconds * 1_000),
			DEFAULT_TTL_MS,
			MIN_TTL_MS,
			MAX_TTL_MS,
		);
		this.defaultMaxTickets = boundedInteger(
			options.maxTickets,
			DEFAULT_MAX_TICKETS,
			1,
			MAX_CONFIGURED_TICKETS,
		);
		this.now = options.now ?? Date.now;
		this.generateRandomBytes = options.randomBytes ?? randomBytes;
		this.store = options.store ?? new Map();
	}

	issue(
		auth: OAuthAuthPrincipal,
		overrides: Pick<OAuthWsTicketServiceOptions, "ttlMs" | "ttlSeconds" | "maxTickets"> = {},
	): IssuedOAuthWsTicket {
		const nowMs = this.now();
		this.pruneExpired(nowMs);
		const maxTickets = boundedInteger(
			overrides.maxTickets,
			this.defaultMaxTickets,
			1,
			MAX_CONFIGURED_TICKETS,
		);
		if (this.store.size >= maxTickets) {
			throw new AppError(
				"OAuth WebSocket ticket capacity reached",
				503,
				"OAUTH_WS_TICKET_CAPACITY",
			);
		}

		const ttlMs = boundedInteger(
			overrides.ttlMs ??
				(overrides.ttlSeconds === undefined ? undefined : overrides.ttlSeconds * 1_000),
			this.defaultTtlMs,
			MIN_TTL_MS,
			MAX_TTL_MS,
		);
		const authExpiresAtMs = Date.parse(auth.oauth.expiresAt);
		if (!Number.isFinite(authExpiresAtMs) || authExpiresAtMs - nowMs < MIN_TTL_MS) {
			throw new AppError(
				"OAuth access token expires too soon for a WebSocket ticket",
				401,
				"OAUTH_WS_TICKET_AUTH_EXPIRED",
			);
		}
		const expiresAtMs = Math.min(nowMs + ttlMs, authExpiresAtMs);

		for (let attempt = 0; attempt < 8; attempt++) {
			const ticket = Buffer.from(this.generateRandomBytes(TICKET_BYTES)).toString("base64url");
			const digest = sha256(ticket);
			if (this.store.has(digest)) continue;
			this.store.set(digest, {
				channel: EXTERNAL_NARRATORS_WS_CHANNEL,
				auth: cloneAuthSnapshot(auth),
				issuedAtMs: nowMs,
				expiresAtMs,
			});
			return {
				ticket,
				expiresIn: Math.ceil((expiresAtMs - nowMs) / 1_000),
			};
		}

		throw new AppError(
			"Unable to allocate an OAuth WebSocket ticket",
			503,
			"OAUTH_WS_TICKET_ALLOCATION_FAILED",
		);
	}

	consume(
		ticket: string,
		expectedChannel: OAuthWsTicketChannel = EXTERNAL_NARRATORS_WS_CHANNEL,
	): ConsumedOAuthWsTicket | null {
		if (!externalWsTicketSchema.safeParse(ticket).success) return null;
		const digest = sha256(ticket);
		const entry = this.store.get(digest);
		if (!entry) return null;

		// Delete before checking expiry/binding so every recognized ticket has one attempt only.
		this.store.delete(digest);
		if (entry.expiresAtMs <= this.now() || entry.channel !== expectedChannel) return null;
		return {
			channel: entry.channel,
			auth: cloneAuthSnapshot(entry.auth),
		};
	}

	clear(): void {
		this.store.clear();
	}

	private pruneExpired(nowMs = this.now(), budget = 32): void {
		let checked = 0;
		for (const [digest, entry] of this.store) {
			this.store.delete(digest);
			if (entry.expiresAtMs > nowMs) this.store.set(digest, entry);
			checked++;
			if (checked >= budget) break;
		}
	}
}

const sharedTicketStore = hotSafe<Map<string, OAuthWsTicketStoreEntry>>(
	SHARED_STORE_KEY,
	() => new Map(),
);

export const oauthWsTicketService = new OAuthWsTicketService({ store: sharedTicketStore });

export function issueOAuthWsTicket(auth: OAuthAuthPrincipal): IssuedOAuthWsTicket {
	const rollout = getExternalWebSocketRolloutSettings();
	return oauthWsTicketService.issue(auth, {
		ttlMs: rollout.ticketTtlMs,
		maxTickets: rollout.maxTickets,
	});
}

export function consumeOAuthWsTicket(
	ticket: string,
	expectedChannel: OAuthWsTicketChannel = EXTERNAL_NARRATORS_WS_CHANNEL,
): ConsumedOAuthWsTicket | null {
	return oauthWsTicketService.consume(ticket, expectedChannel);
}

export function clearOAuthWsTickets(): void {
	oauthWsTicketService.clear();
}
