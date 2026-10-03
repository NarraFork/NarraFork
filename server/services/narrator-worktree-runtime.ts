import { join } from "node:path";
import { eq } from "drizzle-orm";
import { isAdminUser } from "../lib/agent/tools/admin-common";
import type { ToolContext } from "../lib/agent/types";
import { AppError } from "../lib/errors";
import { narraforkDir } from "../lib/settings";
import { authorizeGitTargetForPrincipal } from "./git-workspace-access";
import type { NarratorPrincipal } from "./narrator-acl";
import { FileWorktreeJournal } from "./narrator-worktree-journal";
import { narratorWorktreeResourceRegistry } from "./narrator-worktree-resources";
import { NarratorWorktreeService } from "./narrator-worktree-service";
import { withWorkspaceRepositoryLock, workspaceContextService } from "./workspace-context-service";

/** Real production adapters; fixture tests deliberately import only the pure service. */
export const narratorWorktreeService = new NarratorWorktreeService<NarratorPrincipal>({
	authorize: (principal, narratorId, need, signal) =>
		authorizeGitTargetForPrincipal(principal, { narratorId }, need, signal),
	withRevision: (narratorId, revision, action) =>
		workspaceContextService.withRevision(narratorId, revision, undefined, async (context) => {
			if (context.deviceId !== "local" || !context.capabilities.switchDirectory)
				throw new AppError(
					"Only ordinary local primary narrators support worktree creation",
					409,
					"WORKTREE_UNSUPPORTED",
				);
			return action();
		}),
	principalKey: (principal) => principal.userId,
	withRepositoryLock: withWorkspaceRepositoryLock,
	journal: new FileWorktreeJournal(join(narraforkDir, "worktree-requests")),
	resources: narratorWorktreeResourceRegistry,
	generateBranchName: async (principal, narratorId, requirement, signal) => {
		const [{ summaryGenerate }, { db }, { narrators }] = await Promise.all([
			import("../lib/agent"),
			import("../db"),
			import("../db/schema"),
		]);
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { title: true },
		});
		const result = await summaryGenerate(
			(requirement ?? row?.title ?? "new worktree task").slice(0, 2000),
			"Return only one short lowercase ASCII kebab-case Git branch slug (1-48 characters, letters/digits/hyphens), describing this task. No prefix, quotes, markdown or explanation.",
			{ narratorId, userId: principal.userId, kind: "internal" },
			signal,
			undefined,
			undefined,
			64,
			false,
		);
		if (result.outputTruncated) throw new Error("Branch-name output was truncated");
		return result.text;
	},
});

/** Actor is supplied by the authenticated loop, never by tool input. */
export async function narratorWorktreePrincipalForTool(
	ctx: ToolContext,
): Promise<NarratorPrincipal> {
	if (!ctx.userId)
		throw new AppError("An authenticated actor is required", 403, "WORKTREE_ACTOR_REQUIRED");
	return { userId: ctx.userId, isAdmin: await isAdminUser(ctx.userId) };
}
