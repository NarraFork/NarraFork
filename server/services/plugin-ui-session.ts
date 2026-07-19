import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import type { InvocationScope } from "./plugin-capability-broker";

export type PluginUiSurfaceScope = "workspace" | "narrator" | "project" | "global";
export type PluginUiSurface = "workspace" | "director" | "focus" | "settings";

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

export interface PluginUiSessionServiceOptions {
	ttlMs?: number;
	maxSessions?: number;
	now?: () => Date;
}

const TOKEN_BYTES = 32;
const NONCE_BYTES = 16;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1_000;

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
	private readonly sessions = new Map<
		string,
		{ session: PluginUiSession; tokenDigest: Buffer; assetTokenDigest: Buffer }
	>();

	constructor(options: PluginUiSessionServiceOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.now = options.now ?? (() => new Date());
	}

	create(binding: PluginUiSessionBinding): CreatedPluginUiSession {
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
		if (!["workspace", "director", "focus", "settings"].includes(binding.surface)) {
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
		return { session: structuredClone(session), sessionToken: token, assetToken };
	}

	get(sessionId: string): PluginUiSession | undefined {
		this.pruneExpired();
		return (
			this.sessions.get(sessionId)?.session &&
			structuredClone(this.sessions.get(sessionId)?.session)
		);
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

	revoke(sessionId: string, principalId: string): boolean {
		const entry = this.sessions.get(sessionId);
		if (!entry) return false;
		if (entry.session.principalId !== principalId)
			throw new AppError(
				"Plugin UI session principal mismatch",
				403,
				"PLUGIN_UI_SESSION_BINDING_MISMATCH",
			);
		this.sessions.delete(sessionId);
		return true;
	}

	clearForPlugin(pluginId: string): number {
		let count = 0;
		for (const [id, entry] of this.sessions) {
			if (entry.session.pluginId === pluginId) {
				this.sessions.delete(id);
				count += 1;
			}
		}
		return count;
	}

	private pruneExpired(): void {
		const now = this.now().getTime();
		for (const [id, entry] of this.sessions)
			if (Date.parse(entry.session.expiresAt) <= now) this.sessions.delete(id);
	}
}

export const pluginUiSessionService = new PluginUiSessionService();
