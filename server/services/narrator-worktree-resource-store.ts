import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { narratorWorktreeResources } from "../db/schema";
import { AppError } from "../lib/errors";

export interface VerifiedWorktreeScope {
	/** Evidence from the authorized resolver and the judged ACL root; never the actor. */
	scopeKind: "unknown" | "standalone" | "project";
	scopeProjectId: string | null;
	scopeOwnerUserId: string | null;
}
export interface WorktreeResourceRegistration {
	ownerNarratorId: string;
	deviceId: string;
	repositoryKey: string;
	worktreePath: string;
	createRequestId: string;
	scope?: VerifiedWorktreeScope;
}
/** One durable inventory row, as removal reads it. */
export interface RecordedWorktreeResource {
	id: string;
	ownerNarratorId: string | null;
	deviceId: string;
	repositoryKey: string;
	worktreePath: string;
	state: "preparing" | "ready" | "unknown";
	createRequestId: string;
}
/** Page-sized lookups only: a worktree list page has at most 100 rows. */
export const WORKTREE_RESOURCE_FIND_MAX_PATHS = 128;
export interface WorktreeResourceRegistry {
	// biome-ignore lint/suspicious/noConfusingVoidType: Legacy registries return Promise<void>, not Promise<undefined>.
	register(resource: WorktreeResourceRegistration): Promise<void | { inserted: boolean }>;
	setState(resource: WorktreeResourceRegistration, state: "ready" | "unknown"): Promise<void>;
	/** Only the fresh creator with this call's inserted:true evidence, before Git dispatch. No disk cleanup. */
	releaseUndispatched?(resource: WorktreeResourceRegistration): Promise<void>;
	/**
	 * Rows recorded at exactly these canonical paths, by primary key. Removal never
	 * looks anywhere else: a directory without a row is not NarraFork's to remove.
	 */
	find?(deviceId: string, worktreePaths: readonly string[]): Promise<RecordedWorktreeResource[]>;
	/**
	 * Delete exactly this incarnation after its checkout is gone. False when the row
	 * changed, vanished, or is still referenced (every reference is ON DELETE RESTRICT).
	 */
	retire?(resource: RecordedWorktreeResource): Promise<boolean>;
}
export const unknownWorktreeScope: VerifiedWorktreeScope = Object.freeze({
	scopeKind: "unknown",
	scopeProjectId: null,
	scopeOwnerUserId: null,
});
export function worktreeResourceId(deviceId: string, worktreePath: string): string {
	return createHash("sha256")
		.update(JSON.stringify([deviceId, worktreePath]))
		.digest("hex");
}
export function validateVerifiedWorktreeScope(scope: VerifiedWorktreeScope): void {
	if (
		!["unknown", "standalone", "project"].includes(scope.scopeKind) ||
		(scope.scopeProjectId !== null && scope.scopeKind !== "project") ||
		(scope.scopeKind !== "unknown" &&
			(!scope.scopeOwnerUserId || (scope.scopeKind === "project" && !scope.scopeProjectId)))
	)
		throw new AppError(
			"Verified ownership evidence is incomplete",
			409,
			"WORKTREE_SCOPE_UNVERIFIED",
		);
}

type StoreDb = Pick<typeof import("../db").db, "insert" | "select" | "update" | "delete">;
export type WorktreeResourceAdmission = <T>(
	resource: Pick<WorktreeResourceRegistration, "deviceId" | "repositoryKey" | "worktreePath"> & {
		scopeProjectId?: string | null;
	},
	commit: () => Promise<T>,
) => Promise<T>;
/** Fixture-injectable store. Production must supply lifecycle admission; no implicit cleanup API. */
export function createWorktreeResourceRegistry(
	database: StoreDb,
	admission: WorktreeResourceAdmission,
) {
	return {
		async find(
			deviceId: string,
			worktreePaths: readonly string[],
		): Promise<RecordedWorktreeResource[]> {
			if (worktreePaths.length > WORKTREE_RESOURCE_FIND_MAX_PATHS)
				throw new AppError(
					"Too many worktree paths in one lookup",
					413,
					"WORKTREE_LOOKUP_TOO_LARGE",
				);
			const ids = [...new Set(worktreePaths)].map((path) => worktreeResourceId(deviceId, path));
			if (!ids.length) return [];
			return database
				.select({
					id: narratorWorktreeResources.id,
					ownerNarratorId: narratorWorktreeResources.ownerNarratorId,
					deviceId: narratorWorktreeResources.deviceId,
					repositoryKey: narratorWorktreeResources.repositoryKey,
					worktreePath: narratorWorktreeResources.worktreePath,
					state: narratorWorktreeResources.state,
					createRequestId: narratorWorktreeResources.createRequestId,
				})
				.from(narratorWorktreeResources)
				.where(inArray(narratorWorktreeResources.id, ids))
				.limit(ids.length)
				.all();
		},
		async retire(resource: RecordedWorktreeResource): Promise<boolean> {
			try {
				const removed = await database
					.delete(narratorWorktreeResources)
					.where(
						and(
							eq(narratorWorktreeResources.id, resource.id),
							eq(narratorWorktreeResources.deviceId, resource.deviceId),
							eq(narratorWorktreeResources.worktreePath, resource.worktreePath),
							eq(narratorWorktreeResources.repositoryKey, resource.repositoryKey),
							eq(narratorWorktreeResources.createRequestId, resource.createRequestId),
						),
					)
					.returning({ id: narratorWorktreeResources.id });
				return removed.length === 1;
			} catch {
				// A restricting reference keeps the row; the caller reports it as retained.
				return false;
			}
		},
		async register(resource: WorktreeResourceRegistration): Promise<{ inserted: boolean }> {
			const { scope = unknownWorktreeScope, ...identity } = resource;
			validateVerifiedWorktreeScope(scope);
			return admission({ ...resource, scopeProjectId: scope.scopeProjectId }, async () => {
				const id = worktreeResourceId(resource.deviceId, resource.worktreePath);
				const now = new Date().toISOString();
				const inserted = await database
					.insert(narratorWorktreeResources)
					.values({
						id,
						...identity,
						...scope,
						state: "preparing",
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing()
					.returning({ id: narratorWorktreeResources.id });
				const existing = database
					.select({
						repositoryKey: narratorWorktreeResources.repositoryKey,
						createRequestId: narratorWorktreeResources.createRequestId,
						ownerNarratorId: narratorWorktreeResources.ownerNarratorId,
					})
					.from(narratorWorktreeResources)
					.where(eq(narratorWorktreeResources.id, id))
					.get();
				if (
					!existing ||
					existing.repositoryKey !== resource.repositoryKey ||
					existing.createRequestId !== resource.createRequestId ||
					existing.ownerNarratorId !== resource.ownerNarratorId
				)
					throw new AppError(
						"Destination already has a durable resource owner",
						409,
						"WORKTREE_RESOURCE_CONFLICT",
					);
				return { inserted: inserted.length === 1 };
			});
		},
		async setState(
			resource: WorktreeResourceRegistration,
			state: "ready" | "unknown",
		): Promise<void> {
			await database
				.update(narratorWorktreeResources)
				.set({ state, updatedAt: new Date().toISOString() })
				.where(
					and(
						eq(
							narratorWorktreeResources.id,
							worktreeResourceId(resource.deviceId, resource.worktreePath),
						),
						eq(narratorWorktreeResources.createRequestId, resource.createRequestId),
					),
				);
		},
		async releaseUndispatched(resource: WorktreeResourceRegistration): Promise<void> {
			// This only retracts this creator's untouched preparing metadata. Scope transfers,
			// ready/unknown results and another owner/request must remain durable claims.
			await database
				.delete(narratorWorktreeResources)
				.where(
					and(
						eq(
							narratorWorktreeResources.id,
							worktreeResourceId(resource.deviceId, resource.worktreePath),
						),
						eq(narratorWorktreeResources.deviceId, resource.deviceId),
						eq(narratorWorktreeResources.worktreePath, resource.worktreePath),
						eq(narratorWorktreeResources.repositoryKey, resource.repositoryKey),
						eq(narratorWorktreeResources.ownerNarratorId, resource.ownerNarratorId),
						eq(narratorWorktreeResources.createRequestId, resource.createRequestId),
						eq(narratorWorktreeResources.state, "preparing"),
						eq(narratorWorktreeResources.ownershipRevision, 0),
					),
				);
		},
		/** Internal verified-evidence CAS; historical unknown rows are never adopted by register retries. */
		async compareAndSetScope(
			id: string,
			expectedRevision: number,
			scope: VerifiedWorktreeScope,
		): Promise<boolean> {
			validateVerifiedWorktreeScope(scope);
			if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
				throw new AppError("Invalid ownership revision", 409, "WORKTREE_SCOPE_REVISION");
			const identity = database
				.select({
					scopeKind: narratorWorktreeResources.scopeKind,
					scopeProjectId: narratorWorktreeResources.scopeProjectId,
					deviceId: narratorWorktreeResources.deviceId,
					repositoryKey: narratorWorktreeResources.repositoryKey,
					worktreePath: narratorWorktreeResources.worktreePath,
					createRequestId: narratorWorktreeResources.createRequestId,
				})
				.from(narratorWorktreeResources)
				.where(eq(narratorWorktreeResources.id, id))
				.get();
			if (!identity) return false;
			if (identity.scopeKind === "project" && identity.scopeProjectId === null)
				throw new AppError(
					"Project scope evidence is missing; cannot downgrade",
					409,
					"WORKTREE_SCOPE_PROJECT_MISSING",
				);
			const commitScope = async () => {
				const result = await database
					.update(narratorWorktreeResources)
					.set({
						...scope,
						ownershipRevision: expectedRevision + 1,
						updatedAt: new Date().toISOString(),
					})
					.where(
						and(
							eq(narratorWorktreeResources.id, id),
							eq(narratorWorktreeResources.ownershipRevision, expectedRevision),
							or(
								ne(narratorWorktreeResources.scopeKind, "project"),
								isNotNull(narratorWorktreeResources.scopeProjectId),
							),
						),
					)
					.returning({ id: narratorWorktreeResources.id });
				return result.length === 1;
			};
			// A scope transfer pins both existing and prospective project domains through commit.
			return admission(identity, () =>
				scope.scopeProjectId === identity.scopeProjectId
					? commitScope()
					: admission({ ...identity, scopeProjectId: scope.scopeProjectId }, commitScope),
			);
		},
	};
}
