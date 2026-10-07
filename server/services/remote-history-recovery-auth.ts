import { AsyncLocalStorage } from "node:async_hooks";
import { SESSION_VERSION_CLAIM } from "@shared/session-auth";
import { eq } from "drizzle-orm";
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
