import { AsyncLocalStorage } from "node:async_hooks";
import { SESSION_VERSION_CLAIM } from "@shared/session-auth";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { oauthAccessTokens, users } from "../db/schema";
import type { AuthPrincipal } from "../middleware/auth";
import type { RemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";

export type RemoteRecoveryAuthProvenance =
	import("@shared/file-change-protocol").FileChangeRecoveryAuthProvenance;
const authorityContext = new AsyncLocalStorage<Readonly<RemoteRecoveryAuthProvenance>>();
/** Only call at the already-authenticated server boundary, never with request JSON.
 * This snapshot contains identifiers/ceilings, not tokens or borrowed admin authority. */
export function captureRemoteRecoveryAuthProvenance(
	auth: AuthPrincipal,
): RemoteRecoveryAuthProvenance {
	const common = {
		version: 1 as const,
		userId: auth.user.sub,
		issuedAtSeconds: auth.user.iat,
		// OAuth middleware uses placeholder user.exp=0; its actual original
		// credential expiry is the authenticated token's OAuth context, not a new TTL.
		expiresAtSeconds:
			auth.type === "oauth" ? Math.floor(Date.parse(auth.oauth.expiresAt) / 1000) : auth.user.exp,
	};
	return auth.type === "session"
		? { ...common, authentication: "session", tokenVersion: auth.user[SESSION_VERSION_CLAIM] ?? 0 }
		: { ...common, authentication: "oauth", oauth: structuredClone(auth.oauth) };
}
export function withRemoteRecoveryAuthProvenance<Result>(
	proof: RemoteRecoveryAuthProvenance,
	body: () => Result,
): Result {
	return authorityContext.run(Object.freeze(structuredClone(proof)), body);
}
export function currentRemoteRecoveryAuthProvenance(userId: string) {
	const proof = authorityContext.getStore();
	return proof?.userId === userId ? structuredClone(proof) : undefined;
}
declare const editorSessionOriginBrand: unique symbol;
export type RemoteEditorSessionOrigin = Readonly<{ [editorSessionOriginBrand]: true }>;
export type RemoteEditorOriginReason =
	| "EDITOR_SESSION_ORIGIN_MISSING"
	| "EDITOR_SESSION_ORIGIN_UNSUPPORTED"
	| "EDITOR_SESSION_ORIGIN_INVALID"
	| "EDITOR_SESSION_ORIGIN_EXPIRED"
	| "EDITOR_SESSION_ORIGIN_REVOKED"
	| "EDITOR_SESSION_ACTOR_UNAVAILABLE";
export class RemoteEditorOriginError extends Error {
	constructor(readonly reason: RemoteEditorOriginReason) {
		super(reason);
		this.name = "RemoteEditorOriginError";
	}
}
interface EditorSessionRecord {
	readonly snapshot: Readonly<Extract<RemoteRecoveryAuthProvenance, { authentication: "session" }>>;
	readonly signal: AbortSignal;
	active: boolean;
}
interface EditorRequestContext {
	source: "session" | "unsupported" | "missing";
	origin?: RemoteEditorSessionOrigin;
}
const editorRequests = new AsyncLocalStorage<EditorRequestContext>();
const editorOrigins = new WeakMap<object, EditorSessionRecord>();
/** Only the dedicated editor middleware calls this with the actual Hono request.
 * No provenance DTO/user-id exchange API exists, and ordinary recovery ALS cannot mint a ref. */
export async function withRemoteEditorHttpSessionOrigin<Result>(
	context: Context,
	body: () => Promise<Result>,
): Promise<Result> {
	const auth = context.get("auth") as AuthPrincipal | undefined;
	if (!auth || auth.type !== "session")
		return editorRequests.run({ source: auth ? "unsupported" : "missing" }, body);
	const snapshot = captureRemoteRecoveryAuthProvenance(auth);
	if (
		snapshot.authentication !== "session" ||
		Buffer.byteLength(JSON.stringify(snapshot)) > 32 * 1024
	)
		throw new RemoteEditorOriginError("EDITOR_SESSION_ORIGIN_INVALID");
	const origin = Object.freeze({}) as RemoteEditorSessionOrigin;
	const record: EditorSessionRecord = {
		snapshot: Object.freeze(snapshot),
		signal: context.req.raw.signal,
		active: true,
	};
	editorOrigins.set(origin, record);
	try {
		return await editorRequests.run({ source: "session", origin }, body);
	} finally {
		record.active = false;
		editorOrigins.delete(origin);
	}
}
export function currentRemoteEditorSessionOrigin(
	userId: string,
): RemoteEditorSessionOrigin | undefined {
	const current = editorRequests.getStore();
	const record = current?.origin && editorOrigins.get(current.origin);
	return current?.source === "session" && record?.active && record.snapshot.userId === userId
		? current.origin
		: undefined;
}
export function requireRemoteEditorSessionOrigin(userId: string): RemoteEditorSessionOrigin {
	const current = editorRequests.getStore();
	if (current?.source === "unsupported")
		throw new RemoteEditorOriginError("EDITOR_SESSION_ORIGIN_UNSUPPORTED");
	const origin = currentRemoteEditorSessionOrigin(userId);
	if (!origin) throw new RemoteEditorOriginError("EDITOR_SESSION_ORIGIN_MISSING");
	return origin;
}
/** Fresh small indexed query against the caller's actual control database; ref identity
 * must match this live request AND actor. Original expiry/token version never refresh. */
export function assertRemoteEditorSessionOrigin(
	registry: { readonly options: Pick<RemoteWorkspaceHistoryRuntime["options"], "db"> },
	origin: unknown,
	userId: string,
	signal: AbortSignal,
): Readonly<{ userId: string; isAdmin: boolean; expiresAtSeconds: number }> {
	signal.throwIfAborted();
	const current = editorRequests.getStore();
	const record = origin && typeof origin === "object" ? editorOrigins.get(origin) : undefined;
	if (
		current?.source !== "session" ||
		current.origin !== origin ||
		!record?.active ||
		record.snapshot.userId !== userId
	)
		throw new RemoteEditorOriginError("EDITOR_SESSION_ORIGIN_INVALID");
	record.signal.throwIfAborted();
	const proof = record.snapshot;
	if (
		!Number.isSafeInteger(proof.issuedAtSeconds) ||
		!Number.isSafeInteger(proof.expiresAtSeconds) ||
		!Number.isSafeInteger(proof.tokenVersion) ||
		proof.tokenVersion < 0 ||
		proof.issuedAtSeconds > Date.now() / 1000
	)
		throw new RemoteEditorOriginError("EDITOR_SESSION_ORIGIN_INVALID");
	if (proof.expiresAtSeconds <= Date.now() / 1000)
		throw new RemoteEditorOriginError("EDITOR_SESSION_ORIGIN_EXPIRED");
	const user = registry.options.db
		.select({ tokenVersion: users.tokenVersion, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user) throw new RemoteEditorOriginError("EDITOR_SESSION_ACTOR_UNAVAILABLE");
	if (proof.tokenVersion !== user.tokenVersion)
		throw new RemoteEditorOriginError("EDITOR_SESSION_ORIGIN_REVOKED");
	signal.throwIfAborted();
	record.signal.throwIfAborted();
	return Object.freeze({
		userId,
		isAdmin: user.role === "admin",
		expiresAtSeconds: proof.expiresAtSeconds,
	});
}
/** Validate the ORIGINAL credential, then the caller still runs the real live
 * narrator/project/device/path authorization on every RPC. Legacy is not repaired. */
export async function assertRemoteRecoveryAuth(
	registry: RemoteWorkspaceHistoryRuntime,
	value: unknown,
	userId: string,
	signal: AbortSignal,
): Promise<RemoteRecoveryAuthProvenance> {
	signal.throwIfAborted();
	if (!value || typeof value !== "object")
		throw new Error("Original recovery authentication unavailable");
	const proof = value as RemoteRecoveryAuthProvenance;
	if (
		proof.version !== 1 ||
		proof.userId !== userId ||
		!Number.isSafeInteger(proof.issuedAtSeconds) ||
		!Number.isSafeInteger(proof.expiresAtSeconds) ||
		proof.issuedAtSeconds > Date.now() / 1000 ||
		proof.expiresAtSeconds <= Date.now() / 1000
	)
		throw new Error("Original recovery authentication expired or unproven");
	const user = registry.options.db
		.select({ tokenVersion: users.tokenVersion, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user) throw new Error("Original recovery user unavailable");
	if (proof.authentication === "session") {
		if (
			!Number.isSafeInteger(proof.tokenVersion) ||
			proof.tokenVersion < 0 ||
			proof.tokenVersion !== user.tokenVersion
		)
			throw new Error("Original session recovery authentication revoked");
		return proof;
	}
	if (
		proof.authentication !== "oauth" ||
		!proof.oauth?.grantId ||
		!proof.oauth.tokenId ||
		!Array.isArray(proof.oauth.scopes) ||
		proof.oauth.scopes.length > 128
	)
		throw new Error("Original OAuth recovery authentication unproven");
	const token = registry.options.db
		.select({
			userId: oauthAccessTokens.userId,
			grantId: oauthAccessTokens.grantId,
			clientId: oauthAccessTokens.clientId,
			oauthClientId: oauthAccessTokens.oauthClientId,
			expiresAt: oauthAccessTokens.expiresAt,
			revokedAt: oauthAccessTokens.revokedAt,
			familyId: oauthAccessTokens.refreshFamilyId,
			familyRevokedAt: oauthAccessTokens.refreshFamilyRevokedAt,
		})
		.from(oauthAccessTokens)
		.where(eq(oauthAccessTokens.id, proof.oauth.tokenId))
		.get();
	if (
		!token ||
		token.userId !== userId ||
		token.grantId !== proof.oauth.grantId ||
		token.clientId !== proof.oauth.clientId ||
		token.oauthClientId !== proof.oauth.oauthClientId ||
		token.familyId !== proof.oauth.refreshFamilyId ||
		token.revokedAt ||
		token.familyRevokedAt ||
		token.expiresAt !== proof.oauth.expiresAt ||
		Date.parse(token.expiresAt) <= Date.now()
	)
		throw new Error("Original OAuth recovery token revoked, expired or replaced");
	// Restore/reconcile endpoints are currently first-party. Do not turn a live
	// OAuth token into a first-party principal without the original resource ceiling.
	throw new Error("Original OAuth recovery requires explicit resource-scoped manual authorization");
}
