import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import {
	narratorWorktreeResourceClaims as claims,
	narrators,
	narratorWorktreeResourceOrigins as origins,
	narratorWorktreeResources as resources,
} from "../db/schema";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import type { LegacyLinkedWorktreeEvidence } from "./legacy-linked-worktree-identity";
import { assertNarratorAccess, NARRATOR_ACL_COLUMNS, type NarratorPrincipal } from "./narrator-acl";

export interface LegacyLinkedHistoryBinding {
	resourceId: string;
	evidenceDigest: string;
	ownershipRevision: number;
	commonDirectoryPath: string;
	gitAdminDirectoryPath: string;
}

/** A stripped optional adoption marker must not downgrade a durable linked origin to Root0. */
export function hasLegacyLinkedHistoryOrigin(
	migrationProjectId: string,
	workspacePath: string,
): boolean {
	return !!db
		.select({ resourceId: origins.resourceId })
		.from(resources)
		.innerJoin(origins, eq(origins.resourceId, resources.id))
		.where(
			and(
				eq(resources.deviceId, "local"),
				eq(resources.worktreePath, workspacePath),
				eq(origins.migrationProjectId, migrationProjectId),
			),
		)
		.limit(1)
		.get();
}

/** Indexed archived namespace lookup. Never depends on current cwd or probes live Git for reads. */
export async function readAuthorizedLegacyLinkedHistoryBinding(
	narratorId: string,
	principal: NarratorPrincipal,
	binding: LegacyLinkedHistoryBinding,
	migrationProjectId: string,
	sourceChapterId: string,
	workspacePath: string,
	need: "read" | "write" = "read",
): Promise<LegacyLinkedWorktreeEvidence | null> {
	if (activeDatabaseBackend !== "sqlite" || !binding || typeof binding.resourceId !== "string")
		return null;
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!narrator) return null;
	await assertNarratorAccess(narrator, principal, need);
	const select = () =>
		db
			.select({
				evidence: origins.evidenceJson,
				digest: origins.evidenceDigest,
				common: origins.commonDirectoryPath,
				admin: origins.gitAdminDirectoryPath,
				originDevice: origins.deviceId,
				originMigration: origins.migrationProjectId,
				claimMigration: claims.migrationProjectId,
				claimChapter: claims.sourceChapterId,
				owner: claims.ownerUserId,
				claimState: claims.state,
				claimRevision: claims.ownershipRevision,
				resourceRevision: resources.ownershipRevision,
				resourceState: resources.state,
				scopeKind: resources.scopeKind,
				scopeOwner: resources.scopeOwnerUserId,
				scopeProject: resources.scopeProjectId,
				resourceDevice: resources.deviceId,
				repositoryKey: resources.repositoryKey,
				resourceNarrator: resources.ownerNarratorId,
				workspace: resources.worktreePath,
			})
			.from(origins)
			.innerJoin(resources, eq(resources.id, origins.resourceId))
			.innerJoin(
				claims,
				and(eq(claims.resourceId, origins.resourceId), eq(claims.narratorId, narratorId)),
			)
			.where(
				and(
					eq(origins.resourceId, binding.resourceId),
					sql`length(CAST(${origins.evidenceJson} AS BLOB)) <= 16384`,
				),
			)
			.limit(1)
			.get();
	const row = select();
	if (
		!row?.owner ||
		row.owner !== narrator.ownerUserId ||
		row.scopeOwner !== row.owner ||
		row.claimState !== "claimed" ||
		row.resourceState !== "ready" ||
		row.resourceNarrator !== null ||
		row.scopeKind !== "standalone" ||
		row.scopeProject !== null ||
		row.claimRevision !== row.resourceRevision ||
		row.resourceRevision !== binding.ownershipRevision ||
		row.originDevice !== "local" ||
		row.resourceDevice !== "local" ||
		row.originMigration !== migrationProjectId ||
		row.claimMigration !== migrationProjectId ||
		row.claimChapter !== sourceChapterId ||
		row.workspace !== workspacePath ||
		row.digest !== binding.evidenceDigest ||
		row.common !== binding.commonDirectoryPath ||
		row.admin !== binding.gitAdminDirectoryPath
	)
		return null;
	const evidence = row.evidence as unknown as LegacyLinkedWorktreeEvidence;
	if (
		Buffer.byteLength(JSON.stringify(evidence)) > 16384 ||
		evidence?.version !== 1 ||
		evidence.digest !== row.digest ||
		evidence.top !== row.workspace ||
		evidence.common !== row.common ||
		evidence.adminDir !== row.admin ||
		!Array.isArray(evidence.metadata) ||
		typeof evidence.projectRoot !== "string" ||
		typeof evidence.branch !== "string" ||
		evidence.gitfile !== join(row.workspace, ".git")
	)
		return null;
	const { digest, ...payload } = evidence;
	const hash = Buffer.from(
		await crypto.subtle.digest("SHA-256", Buffer.from(JSON.stringify(payload))),
	).toString("hex");
	if (hash !== digest) return null;
	const repositoryKey = Buffer.from(
		await crypto.subtle.digest(
			"SHA-256",
			Buffer.from(JSON.stringify(["local", localPathSemantics.identityKey(evidence.common)])),
		),
	).toString("hex");
	if (row.repositoryKey !== repositoryKey) return null;
	// Hashing/ACL resolution yield: revoked owners or claims must not survive that round trip.
	const currentNarrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!currentNarrator || JSON.stringify(currentNarrator) !== JSON.stringify(narrator)) return null;
	await assertNarratorAccess(currentNarrator, principal, need);
	if (JSON.stringify(select()) !== JSON.stringify(row)) return null;
	return evidence;
}
