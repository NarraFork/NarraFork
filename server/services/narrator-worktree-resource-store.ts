import { createHash } from "node:crypto";
import { and, eq, isNotNull, ne, or } from "drizzle-orm";
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
export interface WorktreeResourceRegistry {
	register(resource: WorktreeResourceRegistration): Promise<void>;
	setState(resource: WorktreeResourceRegistration, state: "ready" | "unknown"): Promise<void>;
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

type StoreDb = Pick<typeof import("../db").db, "insert" | "select" | "update">;
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
		async register(resource: WorktreeResourceRegistration): Promise<void> {
			const { scope = unknownWorktreeScope, ...identity } = resource;
			validateVerifiedWorktreeScope(scope);
			await admission({ ...resource, scopeProjectId: scope.scopeProjectId }, async () => {
				const id = worktreeResourceId(resource.deviceId, resource.worktreePath);
				const now = new Date().toISOString();
				await database
					.insert(narratorWorktreeResources)
					.values({
						id,
						...identity,
						...scope,
						state: "preparing",
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing();
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
