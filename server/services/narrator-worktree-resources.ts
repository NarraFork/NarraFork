import { createWorktreeResourceRegistry } from "./narrator-worktree-resource-store";

export type {
	VerifiedWorktreeScope,
	WorktreeResourceRegistration,
	WorktreeResourceRegistry,
} from "./narrator-worktree-resource-store";

import { and, eq } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { narratorWorktreeResources } from "../db/schema";
import { readQueryFirst } from "../db/worker-read";
import { AppError } from "../lib/errors";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";

/** Resources outlive sessions, owners and receipts. PostgreSQL has no adapter yet: closed. */
export const narratorWorktreeResourceRegistry = createWorktreeResourceRegistry(
	db,
	(resource, commit) => {
		if (activeDatabaseBackend !== "sqlite")
			throw new AppError(
				"Worktree resource registry is unavailable for PostgreSQL",
				503,
				"WORKTREE_RESOURCE_BACKEND_UNAVAILABLE",
			);
		const target = {
			deviceId: resource.deviceId,
			path: resource.worktreePath,
			repositoryKey: resource.repositoryKey,
			scopeProjectId: resource.scopeProjectId ?? undefined,
		};
		return withWorkspaceAdmission(target, commit);
	},
);

/** Indexed existence lookup: LIMIT never makes an owned path look orphaned. All states protect. */
export async function isRegisteredNarratorWorktree(worktreePath: string): Promise<boolean> {
	return !!(await readQueryFirst(
		db
			.select({ id: narratorWorktreeResources.id })
			.from(narratorWorktreeResources)
			.where(
				and(
					eq(narratorWorktreeResources.deviceId, "local"),
					eq(narratorWorktreeResources.worktreePath, worktreePath),
				),
			)
			.limit(1),
	));
}
