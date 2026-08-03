import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import type { InvocationScope } from "./plugin-capability-broker";

export type PluginUiSurfaceScope = "workspace" | "narrator" | "project" | "global";
export type PluginUiSurface = "workspace" | "director" | "focus" | "settings" | "provider-settings";

export interface PluginUiSessionBinding {
	pluginId: string;
	version: string;
	hash: string;
	principalId: string;
	contributionId: string;
	panelInstanceId: string;
	surface: PluginUiSurface;
	surfaceScope: PluginUiSurfaceScope;
	scope?: InvocationScope;
}

export interface PluginUiSession extends PluginUiSessionBinding {
	sessionId: string;
	connectNonce: string;
	generation: number;
	createdAt: string;
	expiresAt: string;
}

export interface CreatedPluginUiSession {
	session: PluginUiSession;
	/** Full-power RPC credential; never embed this in a URL. */
	sessionToken: string;
	/** Short-lived, asset-only capability used in shell/asset paths. */
	assetToken: string;
}

export type PluginUiSessionRemovalReason =
	| "revoked"
	| "expired"
	| "plugin-cleared"
	| "service-closed"
	| (string & {});

export type PluginUiSessionRemovalListener = (
	session: PluginUiSession,
	reason: PluginUiSessionRemovalReason,
) => void;

type PluginUiSessionTimer = ReturnType<typeof setTimeout>;

export interface PluginUiSessionServiceOptions {
	ttlMs?: number;
	maxSessions?: number;
	now?: () => Date;
	setTimeout?: (callback: () => void, delayMs: number) => PluginUiSessionTimer;
	clearTimeout?: (timer: PluginUiSessionTimer) => void;
}

const TOKEN_BYTES = 32;
const NONCE_BYTES = 16;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

function assertText(value: string, label: string, max = 256): void {
	if (!value || value.length > max || /[\0\r\n]/.test(value))
		throw new ValidationError(`Invalid ${label}`);
}

export class PluginUiSessionService {
	readonly ttlMs: number;
	readonly maxSessions: number;
	private readonly now: () => Date;
	private readonly setTimeoutFn: (callback: () => void, delayMs: number) => PluginUiSessionTimer;
	private readonly clearTimeoutFn: (timer: PluginUiSessionTimer) => void;
	private readonly sessions = new Map<
		string,
		{ session: PluginUiSession; tokenDigest: Buffer; assetTokenDigest: Buffer }
	>();
	private readonly removalListeners = new Set<PluginUiSessionRemovalListener>();
	private readonly keyedRemovalListeners = new Map<PropertyKey, PluginUiSessionRemovalListener>();
	private expiryTimer: PluginUiSessionTimer | undefined;
	private timerGeneration = 0;
	private closed = false;

	constructor(options: PluginUiSessionServiceOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.now = options.now ?? (() => new Date());
		this.setTimeoutFn =
			options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimeoutFn = options.clearTimeout ?? ((timer) => clearTimeout(timer));
	}

	onRemoved(listener: PluginUiSessionRemovalListener, key?: PropertyKey): () => void {
		if (key === undefined) this.removalListeners.add(listener);
		else this.keyedRemovalListeners.set(key, listener);
		let listening = true;
		return () => {
			if (!listening) return;
			listening = false;
			if (key === undefined) this.removalListeners.delete(listener);
			else if (this.keyedRemovalListeners.get(key) === listener) {
				this.keyedRemovalListeners.delete(key);
			}
		};
	}

	create(binding: PluginUiSessionBinding): CreatedPluginUiSession {
		if (this.closed) {
			throw new AppError(
				"Plugin UI session service is closed",
				503,
				"PLUGIN_UI_SESSION_SERVICE_CLOSED",
			);
		}
		for (const [key, value] of Object.entries(binding)) {
			if (key === "surfaceScope" || key === "surface" || key === "scope") continue;
			assertText(String(value), key);
		}
		if (binding.scope) {
			for (const [key, value] of Object.entries(binding.scope)) {
				if (
					!"userId projectId chapterId workspaceId narratorId deviceId providerInstanceId"
						.split(" ")
						.includes(key)
				)
					throw new ValidationError("Invalid plugin UI scope");
				assertText(String(value), `scope.${key}`, 128);
			}
		}
		if (
			!["workspace", "director", "focus", "settings", "provider-settings"].includes(binding.surface)
		) {
			throw new ValidationError("Invalid surface");
		}
		if (!["workspace", "narrator", "project", "global"].includes(binding.surfaceScope)) {
			throw new ValidationError("Invalid surfaceScope");
		}
		this.pruneExpired();
		if (this.sessions.size >= this.maxSessions)
			throw new AppError("Too many plugin UI sessions", 429, "PLUGIN_UI_SESSION_LIMIT");
		const token = randomBytes(TOKEN_BYTES).toString("base64url");
		const assetToken = randomBytes(TOKEN_BYTES).toString("base64url");
		const now = this.now();
		const session: PluginUiSession = {
			...binding,
			sessionId: `uis_${generateShortId(20)}`,
			connectNonce: randomBytes(NONCE_BYTES).toString("base64url"),
			generation: 1,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
		};
		this.sessions.set(session.sessionId, {
			session,
			tokenDigest: digest(token),
			assetTokenDigest: digest(assetToken),
		});
		this.scheduleNextExpiry();
		return { session: structuredClone(session), sessionToken: token, assetToken };
	}

	get(sessionId: string): PluginUiSession | undefined {
		this.pruneExpired();
		const session = this.sessions.get(sessionId)?.session;
		return session ? structuredClone(session) : undefined;
	}

	private authenticateToken(
		sessionId: string,
		token: string,
		expected?: Partial<PluginUiSessionBinding>,
	): PluginUiSession {
		assertText(sessionId, "sessionId");
		assertText(token, "sessionToken", 512);
		this.pruneExpired();
		const entry = this.sessions.get(sessionId);
		if (!entry || !timingSafeEqual(digest(token), entry.tokenDigest)) {
			throw new AppError("Invalid plugin UI session", 401, "PLUGIN_UI_SESSION_INVALID");
		}
		const session = entry.session;
		for (const key of [
			"pluginId",
			"version",
			"hash",
			"contributionId",
			"panelInstanceId",
			"surface",
			"surfaceScope",
		] as const) {
			if (expected?.[key] !== undefined && expected[key] !== session[key])
				throw new AppError(
					"Plugin UI session binding mismatch",
					403,
					"PLUGIN_UI_SESSION_BINDING_MISMATCH",
				);
		}
		return structuredClone(session);
	}

	authenticate(
		sessionId: string,
		token: string,
		principalId: string,
		expected?: Partial<PluginUiSessionBinding>,
	): PluginUiSession {
		assertText(principalId, "principalId");
		const session = this.authenticateToken(sessionId, token, expected);
		if (session.principalId !== principalId)
			throw new AppError(
				"Plugin UI session principal mismatch",
				403,
				"PLUGIN_UI_SESSION_BINDING_MISMATCH",
			);
		return session;
	}

	authenticateCapability(
		sessionId: string,
		token: string,
		expected?: Partial<PluginUiSessionBinding>,
	): PluginUiSession {
		return this.authenticateToken(sessionId, token, expected);
	}

	/** Authenticate the least-privilege capability used only for static UI assets. */
	authenticateAssetCapability(
		sessionId: string,
		assetToken: string,
		expected?: Partial<PluginUiSessionBinding>,
	): PluginUiSession {
		assertText(sessionId, "sessionId");
		assertText(assetToken, "assetToken", 512);
		this.pruneExpired();
		const entry = this.sessions.get(sessionId);
		if (!entry || !timingSafeEqual(digest(assetToken), entry.assetTokenDigest)) {
			throw new AppError(
				"Invalid plugin UI asset capability",
				401,
				"PLUGIN_UI_ASSET_CAPABILITY_INVALID",
			);
		}
		const session = entry.session;
		for (const key of [
			"pluginId",
			"version",
			"hash",
			"contributionId",
			"panelInstanceId",
			"surface",
			"surfaceScope",
		] as const) {
			if (expected?.[key] !== undefined && expected[key] !== session[key])
				throw new AppError(
					"Plugin UI asset capability binding mismatch",
					403,
					"PLUGIN_UI_SESSION_BINDING_MISMATCH",
				);
		}
		return structuredClone(session);
	}

	revoke(
		sessionId: string,
		principalId: string,
		reason: PluginUiSessionRemovalReason = "revoked",
	): boolean {
		const entry = this.sessions.get(sessionId);
		if (!entry) return false;
		if (entry.session.principalId !== principalId)
			throw new AppError(
				"Plugin UI session principal mismatch",
				403,
				"PLUGIN_UI_SESSION_BINDING_MISMATCH",
			);
		return this.remove(sessionId, reason);
	}

	remove(sessionId: string, reason: PluginUiSessionRemovalReason): boolean {
		const removed = this.removeStoredSession(sessionId, reason);
		if (removed) this.scheduleNextExpiry();
		return removed;
	}

	clearForPlugin(
		pluginId: string,
		reason: PluginUiSessionRemovalReason = "plugin-cleared",
	): number {
		let count = 0;
		for (const [id, entry] of [...this.sessions]) {
			if (entry.session.pluginId === pluginId && this.removeStoredSession(id, reason)) count += 1;
		}
		if (count > 0) this.scheduleNextExpiry();
		return count;
	}

	close(reason: PluginUiSessionRemovalReason = "service-closed"): void {
		if (this.closed) return;
		this.closed = true;
		this.clearExpiryTimer();
		for (const id of [...this.sessions.keys()]) this.removeStoredSession(id, reason);
		this.removalListeners.clear();
		this.keyedRemovalListeners.clear();
	}

	private removeStoredSession(sessionId: string, reason: PluginUiSessionRemovalReason): boolean {
		const entry = this.sessions.get(sessionId);
		if (!entry || !this.sessions.delete(sessionId)) return false;
		const session = structuredClone(entry.session);
		const listeners = [...this.removalListeners, ...this.keyedRemovalListeners.values()];
		for (const listener of listeners) {
			try {
				listener(structuredClone(session), reason);
			} catch {
				// Removal is authoritative; a faulty observer must not block the remaining cascade.
			}
		}
		return true;
	}

	private pruneExpired(): void {
		const now = this.now().getTime();
		let removed = false;
		for (const [id, entry] of [...this.sessions]) {
			if (Date.parse(entry.session.expiresAt) <= now) {
				removed = this.removeStoredSession(id, "expired") || removed;
			}
		}
		if (removed) this.scheduleNextExpiry();
	}

	private scheduleNextExpiry(): void {
		this.clearExpiryTimer();
		if (this.closed || this.sessions.size === 0) return;
		let expiresAt = Number.POSITIVE_INFINITY;
		for (const entry of this.sessions.values()) {
			expiresAt = Math.min(expiresAt, Date.parse(entry.session.expiresAt));
		}
		const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAt - this.now().getTime()));
		const generation = this.timerGeneration;
		const timer = this.setTimeoutFn(() => {
			if (generation !== this.timerGeneration) return;
			this.expiryTimer = undefined;
			this.pruneExpired();
			if (!this.expiryTimer) this.scheduleNextExpiry();
		}, delayMs);
		this.expiryTimer = timer;
		if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
	}

	private clearExpiryTimer(): void {
		this.timerGeneration += 1;
		if (this.expiryTimer === undefined) return;
		this.clearTimeoutFn(this.expiryTimer);
		this.expiryTimer = undefined;
	}
}

export const pluginUiSessionService = new PluginUiSessionService();
