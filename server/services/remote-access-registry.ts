import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RemoteBackendIdentity } from "../../shared/remote-access/application";
import {
	isRemoteIpcId,
	type RemoteIpcType,
	type RemotePeerAccept,
	type RemotePeerOpen,
	type RemoteSessionProjection,
} from "../../shared/remote-access/ipc";
import { resolveLiveSession, type SessionPayload, verifyToken } from "../lib/auth";
import { AppError } from "../lib/errors";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";

export const remoteSecret = () => randomBytes(32).toString("base64url");
export function equalRemoteSecret(left: string | null, right: string): boolean {
	if (!left || left.length !== right.length) return false;
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
export interface RemoteContext {
	id: string;
	capability: string;
	peer: RemotePeerOpen;
	session?: RemoteSessionProjection;
	frozen: boolean;
	controller: AbortController;
	resources: Set<() => void>;
	loginDeadline: number;
}
export type RemoteNotification = (type: RemoteIpcType, payload: Record<string, unknown>) => void;

/** Only private IPC can allocate contexts. No HTTP header can create one. */
export class RemoteAccessRegistry {
	readonly contexts = new Map<string, RemoteContext>();
	private revision = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(
		readonly epoch: string,
		readonly identity: RemoteBackendIdentity,
		private readonly notify: RemoteNotification = () => {},
	) {
		eventBus.on("auth:changed", this.authChanged);
		eventBus.on("auth:session_extended", this.sessionExtended);
		this.timer = setInterval(() => this.revalidate(), 5000);
		this.timer.unref();
	}
	accept(peer: RemotePeerOpen): RemotePeerAccept {
		if (
			!isRemoteIpcId(peer.peerId) ||
			!isRemoteIpcId(peer.grantId) ||
			!isRemoteIpcId(peer.instanceId) ||
			typeof peer.clientPublicKey !== "string" ||
			peer.clientPublicKey.length > 256 ||
			!Number.isSafeInteger(peer.grantExpiresAt) ||
			peer.grantExpiresAt <= Date.now() / 1000 ||
			this.contexts.size >= 8
		)
			throw new Error("REMOTE_PEER_OPEN_INVALID");
		if ([...this.contexts.values()].some((context) => context.peer.peerId === peer.peerId))
			throw new Error("REMOTE_PEER_DUPLICATE");
		const context: RemoteContext = {
			id: remoteSecret(),
			capability: remoteSecret(),
			peer,
			frozen: false,
			controller: new AbortController(),
			resources: new Set(),
			loginDeadline: Date.now() + 600_000,
		};
		this.contexts.set(context.id, context);
		return {
			peerId: peer.peerId,
			contextId: context.id,
			contextCapability: context.capability,
			backendIdentity: this.identity,
		};
	}
	get(id: string | null, capability: string | null): RemoteContext | undefined {
		const context = id ? this.contexts.get(id) : undefined;
		if (
			!context ||
			!equalRemoteSecret(capability, context.capability) ||
			context.controller.signal.aborted ||
			context.peer.grantExpiresAt <= Date.now() / 1000
		)
			return;
		if (!context.session && context.loginDeadline < Date.now()) {
			this.close(context, "login_timeout");
			return;
		}
		return context;
	}
	private projection(payload: SessionPayload): RemoteSessionProjection {
		if (payload.role !== "admin")
			throw new AppError("Remote access requires an administrator", 403, "REMOTE_ADMIN_REQUIRED");
		if (!payload.sid) throw new AppError("Session required", 401, "REMOTE_SESSION_REQUIRED");
		return {
			sessionId: payload.sid,
			userId: payload.sub,
			role: "admin",
			expiresAt: payload.exp,
			authRevision: this.revision,
		};
	}
	async bind(context: RemoteContext, token: string): Promise<RemoteSessionProjection> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = this.revision;
			const payload = await verifyToken(token);
			if (before !== this.revision) continue;
			if (!this.contexts.has(context.id) || context.controller.signal.aborted)
				throw new AppError("Remote context closed", 409, "REMOTE_CONTEXT_CLOSED");
			if (context.session && context.session.sessionId !== payload.sid)
				throw new AppError(
					"Reconnect to change the bound session",
					409,
					"REMOTE_SESSION_REBIND_DENIED",
				);
			context.session = this.projection(payload);
			context.frozen = false;
			this.notify("session.updated", { peerId: context.peer.peerId, session: context.session });
			return context.session;
		}
		throw new AppError("Authorization changed; retry", 503, "REMOTE_AUTH_RETRY");
	}
	async authorize(context: RemoteContext, token: string): Promise<void> {
		if (context.frozen)
			throw new AppError("Authorization is being checked", 503, "REMOTE_AUTH_RETRY");
		const revision = this.revision;
		const payload = await verifyToken(token);
		const projection = this.projection(payload);
		if (context.frozen || revision !== this.revision || context.controller.signal.aborted)
			throw new AppError("Authorization changed; retry", 503, "REMOTE_AUTH_RETRY");
		if (!context.session || projection.sessionId !== context.session.sessionId)
			throw new AppError("Session is not bound to this peer", 401, "REMOTE_SESSION_MISMATCH");
	}
	close(context: RemoteContext, reason: string) {
		if (!this.contexts.delete(context.id)) return;
		context.frozen = true;
		context.controller.abort(new Error(reason));
		for (const cancel of context.resources) {
			try {
				cancel();
			} catch {}
		}
		context.resources.clear();
		this.notify("peer.reject", { peerId: context.peer.peerId, reason });
	}
	closePeer(peerId: string, reason = "peer_closed") {
		for (const context of this.contexts.values())
			if (context.peer.peerId === peerId) this.close(context, reason);
	}
	revokeGrant(grantId: string) {
		for (const context of this.contexts.values())
			if (context.peer.grantId === grantId) this.close(context, "grant_revoked");
	}
	private authChanged = (event: Extract<NarraForkEvent, { type: "auth:changed" }>) => {
		this.revision++;
		const contexts = [...this.contexts.values()].filter(
			(context) => context.session && (!event.userId || context.session.userId === event.userId),
		);
		// Synchronously freeze all matching peers before the first storage await.
		for (const context of contexts) context.frozen = true;
		for (const context of contexts) void this.check(context);
	};
	private sessionExtended = (event: Extract<NarraForkEvent, { type: "auth:session_extended" }>) => {
		for (const context of this.contexts.values())
			if (context.session?.sessionId === event.sessionId) void this.check(context);
	};
	private async check(context: RemoteContext) {
		const session = context.session;
		if (!session) return;
		const revision = this.revision;
		try {
			const live = await resolveLiveSession(session.sessionId);
			if (!this.contexts.has(context.id) || context.session?.sessionId !== session.sessionId)
				return;
			if (revision !== this.revision) {
				void this.check(context);
				return;
			}
			if (!live || live.role !== "admin") {
				this.notify("session.invalidated", {
					sessionId: session.sessionId,
					reason: "authorization_changed",
				});
				this.close(context, "authorization_changed");
				return;
			}
			context.session = this.projection(live);
			context.frozen = false;
			this.notify("session.updated", { peerId: context.peer.peerId, session: context.session });
		} catch {
			// Storage failure is a connection failure, not evidence to discard a credential.
			this.close(context, "storage_unavailable");
		}
	}
	private revalidate() {
		for (const context of this.contexts.values()) {
			if (
				context.peer.grantExpiresAt <= Date.now() / 1000 ||
				(!context.session && context.loginDeadline < Date.now())
			)
				this.close(context, "expired");
			else if (context.session) {
				context.frozen = true;
				void this.check(context);
			}
		}
	}
	dispose() {
		clearInterval(this.timer);
		eventBus.off("auth:changed", this.authChanged);
		eventBus.off("auth:session_extended", this.sessionExtended);
		for (const context of this.contexts.values()) this.close(context, "epoch_disposed");
	}
}
