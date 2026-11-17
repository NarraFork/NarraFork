/**
 * Production ports of the work item lifecycle: the coordinator's own worktree service calls.
 *
 * Creation is `prepare` (explicit branch name, the default destination under the repository)
 * followed by `create`, exactly as the worktree dialog does; removal is the PR #493 channel's
 * `planRemoval` + `remove`. Both run as the person behind the coordinator's turn and under the
 * coordinator's current workspace (the project's main checkout), so every authorization,
 * revision guard, repository lock and protection reservation of those paths applies unchanged.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { isAdminUser } from "../../lib/agent/tools/admin-common";
import { AppError } from "../../lib/errors";
import { resolveNarratorGitIdentityEnv } from "../../lib/git-identity";
import { wakeInboxIfEligible } from "../agent-runtime/inbox";
import { tryClaimExecution } from "../agent-runtime/ownership";
import { isNarratorRuntimeBusy, withNarratorWorkAdmission } from "../narrator-session-state";
import { narratorWorktreeService } from "../narrator-worktree-runtime";
import { workspaceContextService } from "../workspace-context-service";
import type { WorkItemWorktreePorts } from "./work-items";

async function coordinatorWorkspace(coordinatorId: string) {
	const workspace = await workspaceContextService.get(coordinatorId);
	const workspaceKey = workspace.git?.workspaceKey;
	if (workspace.deviceId !== "local" || !workspaceKey)
		throw new AppError(
			"The team coordinator's working directory is not a local Git checkout",
			409,
			"TEAM_WORKSPACE_UNAVAILABLE",
		);
	return { revision: workspace.revision, workspaceKey };
}

export const productionWorkItemPorts: WorkItemWorktreePorts = {
	async createWorktree({ coordinatorId, principal, requestId, branchName, baseRef, signal }) {
		const workspace = await coordinatorWorkspace(coordinatorId);
		const prepared = await narratorWorktreeService.prepare(
			principal,
			coordinatorId,
			{ expectedRevision: workspace.revision, workspaceKey: workspace.workspaceKey, branchName },
			signal,
		);
		const result = await narratorWorktreeService.create(
			principal,
			coordinatorId,
			{
				expectedRevision: workspace.revision,
				workspaceKey: workspace.workspaceKey,
				requestId,
				destinationPath: prepared.destinationPath,
				branch: { kind: "new", name: prepared.branchName },
				baseRef,
			},
			signal,
		);
		if (result.outcome !== "created" || !result.worktree)
			throw new AppError(
				`The work item's worktree was not created (${result.outcome}${
					result.error ? `: ${result.error.message}` : ""
				})`,
				409,
				result.error?.code ?? "TEAM_WORKTREE_NOT_CREATED",
			);
		return { path: result.worktree.path };
	},

	async planRemoval({ coordinatorId, principal, path, signal }) {
		const workspace = await coordinatorWorkspace(coordinatorId);
		return narratorWorktreeService.planRemoval(
			principal,
			coordinatorId,
			{ workspaceKey: workspace.workspaceKey, path },
			signal,
		);
	},

	async removeWorktree({
		coordinatorId,
		principal,
		path,
		expectedRevision,
		force,
		confirmedLoss,
		signal,
	}) {
		const workspace = await coordinatorWorkspace(coordinatorId);
		return narratorWorktreeService.remove(
			principal,
			coordinatorId,
			{
				expectedRevision,
				workspaceKey: workspace.workspaceKey,
				path,
				...(force ? { force: true, confirmedLoss } : {}),
			},
			signal,
		);
	},

	/**
	 * The work lease every narrator write takes (as `deliverInjection` does) on the first
	 * session, and its execution owner claimed for each session: a run cannot start while the
	 * owner is held. Anything already running, waiting or owned is busy. Mailbox input that
	 * arrived meanwhile is woken afterwards.
	 */
	async holdSessions(narratorIds, fn) {
		const [first] = narratorIds;
		if (!first) return { held: true as const, value: await fn() };
		return withNarratorWorkAdmission(first, async () => {
			const owners: Array<{ release(): boolean }> = [];
			const release = () => {
				for (const owner of owners.splice(0)) owner.release();
			};
			for (const id of narratorIds) {
				const row = await db.query.narrators.findFirst({
					where: eq(narrators.id, id),
					columns: { status: true },
				});
				const owner =
					row?.status === "working" || row?.status === "waiting" || isNarratorRuntimeBusy(id)
						? null
						: tryClaimExecution(id, "tool-replay");
				if (!owner) {
					release();
					return { held: false as const, busy: id };
				}
				owners.push(owner);
			}
			try {
				return { held: true as const, value: await fn() };
			} finally {
				release();
				for (const id of narratorIds) void wakeInboxIfEligible(id).catch(() => false);
			}
		});
	},

	async principalOf(userId) {
		return { userId, isAdmin: await isAdminUser(userId) };
	},

	gitIdentity: ({ userId, coordinatorId }) =>
		resolveNarratorGitIdentityEnv({ turnUserId: userId, narratorId: coordinatorId }),
};
