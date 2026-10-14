import type { FileChangeIdentity } from "@shared/file-change-protocol";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq, sql } from "drizzle-orm";
import { fileChangeIdentityKey } from "./file-change-identity";
import {
	hasLegacyLinkedHistoryOrigin,
	type LegacyLinkedHistoryBinding,
	readAuthorizedLegacyLinkedHistoryBinding,
} from "./legacy-linked-history-reader";
import {
	LEGACY_RETAINED_HISTORY_LIMITS,
	type LegacyRetainedNarratorOrigin,
} from "./legacy-retained-history-contract";
import { readLegacySnapshotMembership } from "./legacy-retained-snapshot-membership";
import { assertNarratorAccess, NARRATOR_ACL_COLUMNS, type NarratorPrincipal } from "./narrator-acl";

export interface LegacyRetainedHistoryOriginProof {
	version: 1;
	origin: LegacyRetainedNarratorOrigin;
	shadowKey: string | null;
	scopeIds: string[];
	manifestDigest: string;
	linkedWorktree?: LegacyLinkedHistoryBinding;
}

/** Archived reads require current ACL, durable provenance and an unchanged claim namespace.
 * The full bounded manifest is read/parsed only in a readonly worker, never the HTTP thread.
 * Membership is NOT a complete restore receipt. Callers repeat checks at anchored IO. */
export async function isAuthorizedLegacyRetainedSnapshotCommit(
	artifactId: string,
	principal: NarratorPrincipal,
	sha: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted || !/^[a-f0-9]{40}$/.test(sha)) return false;
	const { getAuthorizedLegacyArtifactDescriptor } = await import(
		"./legacy-migration-artifact-claims"
	);
	const authorize = async () => {
		if (signal?.aborted) return null;
		const claim = await getAuthorizedLegacyArtifactDescriptor(artifactId, principal);
		if (!claim || claim.kind !== "shadow" || !claim.narratorId || !claim.shadowKey) return null;
		const proof = await getAuthorizedLegacyRetainedHistoryOrigin(claim.narratorId, principal);
		if (
			!proof ||
			(proof.shadowKey !== null && proof.shadowKey !== claim.shadowKey) ||
			proof.manifestDigest !== claim.manifestDigest ||
			proof.origin.workspacePath !== claim.workspacePath ||
			proof.origin.sourceChapterId !== claim.sourceChapterId
		)
			return null;
		return { claim, proof };
	};
	const initial = await authorize();
	if (!initial || signal?.aborted) return false;
	const { getDbPath } = await import("../db/connection");
	const databasePath = getDbPath();
	const { claim } = initial;
	const allowed = await readLegacySnapshotMembership(
		{
			databasePath,
			artifactId,
			manifestDigest: claim.manifestDigest,
			narratorId: claim.narratorId as string,
			sourceChapterId: claim.sourceChapterId,
			workspacePath: claim.workspacePath,
			artifactPath: claim.artifactPath,
			shadowKey: claim.shadowKey as string,
			sha,
		},
		signal,
	);
	if (!allowed || signal?.aborted || getDbPath() !== databasePath) return false;
	// A worker round trip yields: revoked ACL, updated pointers/digests, released
	// claims or replaced artifact directory incarnations cannot carry old authority.
	const current = await authorize();
	return !!current && !signal?.aborted && JSON.stringify(current) === JSON.stringify(initial);
}

/** A reused physical scope ID is not an old-operation identity. Only complete,
 * selected current effects whose actual operation PKs are absent from the complete
 * retained manifest can avoid the old epoch bridge. Unknown results stay conservative. */
export async function areAuthorizedModernRetainedFileSources(
	narratorId: string,
	principal: NarratorPrincipal,
	identity: FileChangeIdentity,
	operationIds: readonly string[],
	signal: AbortSignal,
): Promise<boolean> {
	if (signal.aborted || operationIds.length === 0 || operationIds.length > 256) return false;
	const operationSelection = {
		scopeId: identity.scopeId,
		fileKey: fileChangeIdentityKey(identity),
		operationIds: [...new Set(operationIds)],
	};
	if (Buffer.byteLength(JSON.stringify(operationSelection)) > 8192) return false;
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(narratorId, principal);
	if (!origin?.scopeIds.includes(identity.scopeId) || signal.aborted) return false;
	const { getDbPath } = await import("../db/connection");
	const databasePath = getDbPath();
	const modern = await readLegacySnapshotMembership(
		{
			databasePath,
			artifactId: "",
			narratorId,
			manifestDigest: origin.manifestDigest,
			sourceChapterId: origin.origin.sourceChapterId as string,
			workspacePath: origin.origin.workspacePath,
			artifactPath: "",
			shadowKey: origin.shadowKey ?? "",
			sha: "",
			operationSelection,
		},
		signal,
	);
	if (signal.aborted || getDbPath() !== databasePath) return false;
	const current = await getAuthorizedLegacyRetainedHistoryOrigin(narratorId, principal);
	return modern && !signal.aborted && JSON.stringify(current) === JSON.stringify(origin);
}

/** Old history resolves through durable provenance, never through the current cwd.
 * This only authorizes same-origin reads; it does not upgrade snapshot coverage or
 * authorize a write/restore. Consumers must acquire their normal leases and repeat
 * physical identity checks at IO time. */
export async function getAuthorizedLegacyRetainedHistoryOrigin(
	narratorId: string,
	principal: NarratorPrincipal,
): Promise<LegacyRetainedHistoryOriginProof | null> {
	const { db, activeDatabaseBackend } = await import("../db");
	const { narrators, legacyNarratorWorkspaceAdoptions, legacyRetainedChapterMetadata } =
		await import("../db/schema");
	if (activeDatabaseBackend !== "sqlite") return null;
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!narrator) return null;
	await assertNarratorAccess(narrator, principal, "read");
	const proof = await db.query.legacyNarratorWorkspaceAdoptions.findFirst({
		where: and(
			eq(legacyNarratorWorkspaceAdoptions.narratorId, narratorId),
			sql`length(CAST(${legacyNarratorWorkspaceAdoptions.originJson} AS BLOB)) <= 65536`,
		),
	});
	if (!proof || proof.proofMode !== "retained" || !proof.originJson) return null;
	try {
		const origin = proof.originJson as unknown as LegacyRetainedHistoryOriginProof;
		if (
			Buffer.byteLength(JSON.stringify(origin)) > 65536 ||
			origin.version !== 1 ||
			origin.manifestDigest !== proof.historyDigest ||
			origin.origin?.narratorId !== narratorId ||
			origin.origin.deviceId !== "local" ||
			origin.origin.workspacePath !== proof.cwd ||
			origin.origin.workspaceRevision !== proof.previousRevision ||
			!origin.origin.sourceChapterId ||
			!Array.isArray(origin.scopeIds) ||
			origin.scopeIds.length > LEGACY_RETAINED_HISTORY_LIMITS.rows ||
			origin.scopeIds.some((value) => typeof value !== "string" || !value || value.length > 1024) ||
			new Set(origin.scopeIds).size !== origin.scopeIds.length ||
			(origin.shadowKey !== null &&
				(typeof origin.shadowKey !== "string" || origin.shadowKey.length > 4096))
		)
			return null;
		if (origin.origin.workspaceContext !== null) {
			const old = JSON.parse(origin.origin.workspaceContext) as WorkspaceContext;
			if (
				old.cwd !== origin.origin.workspacePath ||
				old.revision !== origin.origin.workspaceRevision ||
				old.deviceId !== "local"
			)
				return null;
		}
		const chapter = await db.query.legacyRetainedChapterMetadata.findFirst({
			where: eq(legacyRetainedChapterMetadata.sourceChapterId, origin.origin.sourceChapterId),
			columns: { migrationProjectId: true, manifestDigest: true },
		});
		if (
			!chapter ||
			chapter.migrationProjectId !== proof.migrationProjectId ||
			chapter.manifestDigest !== origin.manifestDigest
		)
			return null;
		if (
			!origin.linkedWorktree &&
			hasLegacyLinkedHistoryOrigin(proof.migrationProjectId, origin.origin.workspacePath)
		)
			return null;
		if (
			origin.linkedWorktree &&
			!(await readAuthorizedLegacyLinkedHistoryBinding(
				narratorId,
				principal,
				origin.linkedWorktree,
				proof.migrationProjectId,
				origin.origin.sourceChapterId,
				origin.origin.workspacePath,
			))
		)
			return null;
		// Archived reads do not require the current checkout to exist. Restore callers
		// separately recheck the rollback bridge, current write ACL and physical lease.
		return origin;
	} catch {
		return null;
	}
}
