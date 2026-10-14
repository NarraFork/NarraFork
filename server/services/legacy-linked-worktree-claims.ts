import { isAbsolute } from "node:path";
import { and, eq, gt } from "drizzle-orm";
import {
	narratorWorktreeResourceClaims as claims,
	narrators,
	narratorWorktreeResourceOrigins as origins,
	narratorWorktreeResources as resources,
} from "../db/schema";
import { AppError } from "../lib/errors";
import type { ResourceClaim } from "./worktree-lifecycle-guard";
import type { CurrentResourceAuthority, WorktreeResourceRecord } from "./worktree-resource-owner";

type ReadDb = Pick<typeof import("../db").db, "select">;
const originProjection = {
	resourceId: origins.resourceId,
	migrationProjectId: origins.migrationProjectId,
	sourceChapterId: origins.sourceChapterId,
	deviceId: origins.deviceId,
	commonDirectoryPath: origins.commonDirectoryPath,
	gitAdminDirectoryPath: origins.gitAdminDirectoryPath,
};
const claimProjection = {
	resourceId: claims.resourceId,
	migrationProjectId: claims.migrationProjectId,
	sourceChapterId: claims.sourceChapterId,
	narratorId: claims.narratorId,
	ownerUserId: claims.ownerUserId,
	state: claims.state,
	ownershipRevision: claims.ownershipRevision,
};
export interface LinkedWorktreeClaimSummary {
	origin: Pick<typeof origins.$inferSelect, keyof typeof originProjection> | null;
	claim:
		| (Pick<typeof claims.$inferSelect, keyof typeof claimProjection> & {
				currentNarratorOwnerUserId: string | null;
		  })
		| null;
}

/** Indexed, small, internal evidence only. No owner selection, creation, release or deletion API. */
export function createLegacyLinkedWorktreeClaimsReader(database: ReadDb) {
	return {
		readSummary(resourceId: string, narratorId: string | null): LinkedWorktreeClaimSummary {
			const origin =
				database
					.select(originProjection)
					.from(origins)
					.where(eq(origins.resourceId, resourceId))
					.limit(1)
					.get() ?? null;
			const claim = narratorId
				? (database
						.select({ ...claimProjection, currentNarratorOwnerUserId: narrators.ownerUserId })
						.from(claims)
						.innerJoin(narrators, eq(narrators.id, claims.narratorId))
						.where(and(eq(claims.resourceId, resourceId), eq(claims.narratorId, narratorId)))
						.limit(1)
						.get() ?? null)
				: null;
			return { origin, claim };
		},
		/** Exact canonical paths use their indexes; ancestry is checked by the bounded lifecycle guard. */
		hasExactDependency(deviceId: string, path: string): boolean {
			// Separate probes preserve both columns of each composite index (an OR may scan device).
			for (const column of [origins.commonDirectoryPath, origins.gitAdminDirectoryPath]) {
				if (
					database
						.select({ resourceId: origins.resourceId })
						.from(origins)
						.where(and(eq(origins.deviceId, deviceId), eq(column, path)))
						.limit(1)
						.get()
				)
					return true;
			}
			return false;
		},
	};
}

/** Authorized summary/list-consumer adapter: no fallback owner search and no private-scope widening. */
export function readAuthorizedLinkedWorktreeSummary(
	database: ReadDb,
	resource: WorktreeResourceRecord,
	authority: CurrentResourceAuthority,
	need: "read" | "write" = "read",
): LinkedWorktreeClaimSummary {
	const summary = createLegacyLinkedWorktreeClaimsReader(database).readSummary(
		resource.id,
		authority.sourceRootNarratorId,
	);
	if (!isBoundLinkedWorktreeClaimant(resource, authority, summary, need))
		throw new AppError(
			"Linked worktree current claimant authority denied",
			403,
			"RESOURCE_ACCESS_DENIED",
		);
	return summary;
}

/** ACL flags are current evidence supplied by the trusted auth adapter, never by migration receipts. */
export function isBoundLinkedWorktreeClaimant(
	resource: WorktreeResourceRecord,
	auth: CurrentResourceAuthority,
	summary: LinkedWorktreeClaimSummary,
	need: "read" | "write" = "read",
): boolean {
	const { origin, claim } = summary;
	return !!(
		origin &&
		claim &&
		resource.state === "ready" &&
		["standalone", "project"].includes(resource.scopeKind) &&
		resource.scopeOwnerUserId &&
		auth.actorUserId &&
		auth.backend === "sqlite" &&
		auth.workspaceKind === "git" &&
		resource.deviceId === "local" &&
		auth.deviceId === resource.deviceId &&
		auth.contextProjectId === resource.scopeProjectId &&
		(resource.scopeKind === "project"
			? !!resource.scopeProjectId
			: resource.scopeProjectId === null) &&
		auth.canonicalWorktreePath === resource.worktreePath &&
		auth.repositoryKey === resource.repositoryKey &&
		["normal", "readonly"].includes(auth.workspaceMode) &&
		(need !== "write" || (auth.writeAllowed === true && auth.workspaceMode === "normal")) &&
		origin.resourceId === resource.id &&
		origin.deviceId === resource.deviceId &&
		claim.resourceId === resource.id &&
		claim.state === "claimed" &&
		claim.ownershipRevision === resource.ownershipRevision &&
		claim.migrationProjectId === origin.migrationProjectId &&
		claim.ownerUserId === resource.scopeOwnerUserId &&
		claim.currentNarratorOwnerUserId === resource.scopeOwnerUserId &&
		auth.scopeOwnerUserId === resource.scopeOwnerUserId &&
		claim.narratorId &&
		auth.sourceNarratorId === claim.narratorId &&
		auth.basis === "sourceRoot" &&
		auth.rootNarratorId === claim.narratorId &&
		auth.sourceRootNarratorId === claim.narratorId &&
		(auth.sessionType === "primary"
			? auth.sessionNarratorId === claim.narratorId
			: auth.sessionType === "subagent" &&
				!!auth.sessionNarratorId &&
				auth.sessionAclRootNarratorId === claim.narratorId) &&
		auth.complete === true &&
		auth.readAllowed === true &&
		auth.projectAllowed === true &&
		auth.deviceAllowed === true &&
		auth.oauthAllowed === true &&
		auth.executionAllowed === true
	);
}

/** Durable dependencies survive SET NULL on *all* narrator/user claims. Never read evidenceJson. */
export async function readLinkedWorktreeProtection(
	database: ReadDb,
	deadline: number,
	signal?: AbortSignal,
	budget = { maxRows: 4096, maxBytes: 262144 },
): Promise<{ complete: boolean; claims: ResourceClaim[] }> {
	const result: ResourceClaim[] = [];
	let cursor: string | undefined;
	let count = 0;
	let bytes = 0;
	try {
		for (;;) {
			if (signal?.aborted || performance.now() > deadline) throw new Error("Protection timeout");
			const rows = database
				.select({
					...originProjection,
					resourcePath: resources.worktreePath,
					resourceDevice: resources.deviceId,
				})
				.from(origins)
				.leftJoin(resources, eq(resources.id, origins.resourceId))
				.where(cursor ? gt(origins.resourceId, cursor) : undefined)
				.orderBy(origins.resourceId)
				.limit(129)
				.all();
			for (const row of rows.slice(0, 128)) {
				count++;
				bytes += Buffer.byteLength(JSON.stringify(row));
				if (
					count > budget.maxRows ||
					bytes > budget.maxBytes ||
					signal?.aborted ||
					performance.now() > deadline
				)
					throw new Error("Protection budget exceeded");
				if (!row.resourcePath || row.deviceId !== row.resourceDevice)
					throw new Error("Linked dependency device mismatch");
				for (const path of [row.resourcePath, row.commonDirectoryPath, row.gitAdminDirectoryPath]) {
					if (
						!row.deviceId ||
						row.deviceId.length > 256 ||
						row.deviceId.includes("\0") ||
						!isAbsolute(path) ||
						path.length > 4096 ||
						path.includes("\0")
					)
						throw new Error("Unverifiable linked dependency");
					result.push({ kind: "registry", id: row.resourceId, deviceId: row.deviceId, path });
				}
			}
			if (rows.length <= 128) return { complete: true, claims: result };
			cursor = rows[127]?.resourceId;
			await new Promise<void>((done) => setTimeout(done, 0));
		}
	} catch {
		return { complete: false, claims: [] };
	}
}
