/**
 * Team — a team coordinator's control surface over its work items (docs/PROJECT_TEAMS-PLAN.md
 * §二.4, P3). Offered only to sessions with the `team` trait (the orchestrator filters it); the
 * service refuses any other caller as well.
 *
 * The server does the work and the coordinator reads the result: worktrees are made and removed
 * through the existing worktree service, every change is a `team_work_events` row naming this
 * agent. Permission is per action in `narrator-permission.ts`: bookkeeping and the team's own
 * worktree creation and base sync are allowed outside read-only, plan and review modes; `cleanup`
 * deletes a directory and always waits for a person's approval.
 */
import {
	TEAM_CHECKIN_MAX_MINUTES,
	TEAM_CHECKIN_MIN_MINUTES,
	TEAM_REVIEW_SUMMARY_MAX_LENGTH,
	TEAM_REVIEW_VERDICTS,
	TEAM_TOOL_ACTIONS,
	TEAM_WORK_BRANCH_HINT_MAX_LENGTH,
	TEAM_WORK_DEPENDENCIES_MAX,
	TEAM_WORK_TITLE_MAX_LENGTH,
	type TeamToolAction,
} from "@shared/project-teams";
import { z } from "zod/v4";
import { AppError } from "../../errors";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

export const TEAM_TOOL_NAME = "Team";

/** Actions that only read; every other action writes team state. */
export function isTeamReadAction(input: Record<string, unknown>): boolean {
	return (
		input.action === "work.list" || (input.action === "brief" && typeof input.text !== "string")
	);
}

/** The one action that deletes a directory: a person approves every call. */
export function isTeamCleanupCall(toolName: string, input: Record<string, unknown>): boolean {
	return toolName === TEAM_TOOL_NAME && input.action === "cleanup";
}

const confirmedLossSchema = z
	.object({
		head: z.string().max(128).nullable(),
		dirtyFileCount: z.number().int().nonnegative(),
		unreachableCommits: z.number().int().nonnegative(),
	})
	.strict();

export const teamToolParameters = z.object({
	action: z
		.enum(TEAM_TOOL_ACTIONS)
		.describe(
			"work.list | work.create | work.update | work.review | work.ready | work.sync | work.cancel | brief | checkin | cleanup | decision",
		),
	item: z
		.string()
		.min(1)
		.max(64)
		.optional()
		.describe(
			"Work item id (work.update, work.review, work.ready, work.sync, work.cancel, cleanup; optional for decision).",
		),
	title: z
		.string()
		.min(1)
		.max(TEAM_WORK_TITLE_MAX_LENGTH)
		.optional()
		.describe("work.create: the item's title (also names its branch)."),
	branchHint: z
		.string()
		.max(TEAM_WORK_BRANCH_HINT_MAX_LENGTH)
		.optional()
		.describe(
			'work.create: a few English words for the branch (e.g. "login unit tests"); give them when the title is not in English, since only ASCII words name a branch.',
		),
	dependsOn: z
		.array(z.string().min(1).max(64))
		.max(TEAM_WORK_DEPENDENCIES_MAX)
		.optional()
		.describe(
			"work.create / work.update: ids (from work.list) of items of this team, made from the same base branch, that must be merged before this one may start; work.update replaces the whole list ([] clears it) and only while the item is queued.",
		),
	verdict: z
		.enum(TEAM_REVIEW_VERDICTS)
		.optional()
		.describe('work.review: "blocker" when any blocking issue is left, else "clear".'),
	findings: z
		.number()
		.int()
		.min(0)
		.max(100_000)
		.optional()
		.describe("work.review: how many issues the review reported."),
	summary: z
		.string()
		.max(TEAM_REVIEW_SUMMARY_MAX_LENGTH)
		.optional()
		.describe(
			"work.review: the findings in a few short lines (each blocking issue; for a clear round, what was checked). People read it on the team page.",
		),
	reviewer: z
		.string()
		.max(200)
		.optional()
		.describe("work.review: the reviewing subagent's id or alias."),
	reason: z.string().max(500).optional().describe("work.cancel: why, in one line."),
	text: z
		.string()
		.max(8192)
		.optional()
		.describe(
			"brief: the new team brief (at most 4 KB; omit to read it). decision: what you decided on people's behalf.",
		),
	minutes: z
		.number()
		.int()
		.min(TEAM_CHECKIN_MIN_MINUTES)
		.max(TEAM_CHECKIN_MAX_MINUTES)
		.optional()
		.describe("checkin: wake this session after this many minutes (replaces a pending check-in)."),
	note: z.string().max(500).optional().describe("checkin: a note to read when woken."),
	force: z
		.boolean()
		.optional()
		.describe(
			"cleanup: ONLY after a person explicitly agreed to lose the work a refusal reported; requires confirmedLoss.",
		),
	confirmedLoss: confirmedLossSchema
		.optional()
		.describe("cleanup with force: copy details.loss from the refused cleanup exactly."),
});

type TeamInput = z.infer<typeof teamToolParameters>;

function result(value: Record<string, unknown>, isError = false): ToolResult {
	return { output: JSON.stringify(value), ...(isError ? { isError: true } : {}) };
}

function requireField<K extends keyof TeamInput>(
	input: TeamInput,
	key: K,
	action: TeamToolAction,
): NonNullable<TeamInput[K]> {
	const value = input[key];
	if (value === undefined || value === null || value === "")
		throw new AppError(`${action} requires ${String(key)}`, 400, "INVALID_ARGUMENT");
	return value as NonNullable<TeamInput[K]>;
}

async function principalOf(ctx: ToolContext) {
	const { narratorWorktreePrincipalForTool } = await import(
		"../../../services/narrator-worktree-runtime"
	);
	return narratorWorktreePrincipalForTool(ctx);
}

async function workerLabel(ctx: ToolContext, workerId: string | null): Promise<string | null> {
	if (!workerId) return null;
	const { resolveAgentLabel } = await import("../../../services/subagent-label");
	return (
		(await resolveAgentLabel(ctx.narratorId, workerId, { signal: ctx.signal }).catch(() => "")) ||
		workerId
	);
}

async function resolveReviewer(ctx: ToolContext, reviewer: string | undefined) {
	const trimmed = reviewer?.trim();
	if (!trimmed) return null;
	const { resolveTaskAlias } = await import("../../../services/subagent-alias");
	return resolveTaskAlias(ctx.narratorId, trimmed);
}

function cleanupNextAction(code: string): string {
	switch (code) {
		case "WORKTREE_REMOVAL_FORCE_REQUIRED":
		case "WORKTREE_REMOVAL_CHANGED":
			return "Nothing was removed. Tell the members exactly what details.loss says would be lost. Only if a person explicitly agrees, call cleanup again with force: true and confirmedLoss copied from details.loss.";
		case "WORKTREE_REMOVAL_DEPENDENT_RUNNING":
		case "WORKTREE_REMOVAL_BUSY":
			return "Nothing was removed. A session is still running in this worktree; stop or wait for it, then try again.";
		case "WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED":
			return "Nothing was removed. A conversation that is not a subagent still works in this worktree; a person archives it first.";
		default:
			return "Nothing was removed. Report the code to the members; do not work around it.";
	}
}

/** What the coordinator does after a base sync was handed off, by how the instruction went. */
export function syncNextAction(
	delivery: import("../../../services/teams/work-items").SyncDeliveryStatus,
	label: string | null,
): string {
	switch (delivery) {
		case "started":
		case "queued":
			return `The worker ("${label}") was told to merge the base into its branch and report; the server did not touch the branch. Wait for its report.`;
		case "blocked":
			return `The worker ("${label}") is stopped (a person stopped its last turn, or it ended with an error): the instruction is stored but it will not act on it. A person must resume it, or delegate the sync to another worker with Agent({ workdir: <the item's worktree>, prompt: instruction }).`;
		case "wake_failed":
			return `The instruction is stored for the worker ("${label}"), but it could not be started now and will not act on it until its next turn. Check on it, or Send the instruction again later.`;
		case "failed":
			return `The instruction did not reach the worker ("${label}"). Send it yourself (restore it first with Agent({ unarchive }) if it is archived).`;
		case "none":
			return "The item has no worker yet: delegate the instruction with Agent({ workdir: <the item's worktree>, prompt: instruction }).";
	}
}

async function run(input: TeamInput, ctx: ToolContext): Promise<ToolResult> {
	const items = await import("../../../services/teams/work-items");
	const actor = { kind: "agent" as const, id: ctx.narratorId };
	const coordinatorId = ctx.narratorId;
	items.requireCoordinatedTeam(coordinatorId);
	const action = input.action;
	switch (action) {
		case "work.list":
			return result(items.listWorkItems(coordinatorId));
		case "work.create": {
			const item = await items.createWorkItem({
				coordinatorId,
				title: requireField(input, "title", action),
				branchHint: input.branchHint,
				dependsOn: input.dependsOn,
				actor,
				principal: await principalOf(ctx),
				signal: ctx.signal,
			});
			const view = items.viewWorkItem(item);
			return result({
				item: view,
				nextAction:
					view.blockedBy.length > 0
						? 'It stays queued until every item in blockedBy is merged into the base; starting it before is refused. You get a note when it can start: then run work.sync on it and delegate it with Agent({ workdir: item.worktree, subagent_type: "worker", prompt }), the sync instruction first in the prompt.'
						: 'Delegate it with Agent({ workdir: item.worktree, subagent_type: "worker", prompt }); no approval is needed for this directory.',
			});
		}
		case "work.update": {
			const dependsOn = input.dependsOn;
			if (dependsOn === undefined)
				throw new AppError("work.update requires dependsOn", 400, "INVALID_ARGUMENT");
			const { item, changed } = items.setWorkItemDependencies({
				coordinatorId,
				itemId: requireField(input, "item", action),
				dependsOn,
				actor,
			});
			const view = items.viewWorkItem(item);
			return result({
				item: view,
				changed,
				nextAction:
					view.blockedBy.length > 0
						? "It stays queued until every item in blockedBy is merged; you get a note when it can start."
						: "Nothing blocks it: run work.sync on it, then delegate it with Agent({ workdir: item.worktree, ... }), the sync instruction first in the prompt.",
			});
		}
		case "work.review": {
			const verdict = requireField(input, "verdict", action);
			const { item, round } = await items.recordReview({
				coordinatorId,
				itemId: requireField(input, "item", action),
				verdict,
				findings: input.findings ?? 0,
				summary: input.summary,
				reviewer: await resolveReviewer(ctx, input.reviewer),
				actor,
			});
			const label = await workerLabel(ctx, item.workerNarratorId);
			return result({
				item: items.viewWorkItem(item),
				round,
				nextAction:
					verdict === "clear"
						? "No blocking issue is left: mark it with work.ready."
						: label
							? `Send the findings to the author with Send({ id: "${label}", message }); it keeps its context. If it is archived, restore it first with Agent({ unarchive: "${label}" }). Review again after the fix.`
							: "The item has no worker yet: delegate the fixes with Agent({ workdir: item.worktree, ... }).",
			});
		}
		case "work.ready": {
			const { item, commitsSinceReview } = await items.markReady({
				coordinatorId,
				itemId: requireField(input, "item", action),
				actor,
			});
			return result({
				item: items.viewWorkItem(item),
				commitsSinceReview,
				...(commitsSinceReview
					? {
							note: `${commitsSinceReview} commit(s) were made after the last clear review; review again unless they only bring the base in.`,
						}
					: {}),
			});
		}
		case "work.sync": {
			const toolUseId = ctx.currentToolUseId;
			const outcome = await items.syncWorkItem({
				coordinatorId,
				itemId: requireField(input, "item", action),
				actor,
				// The coordinator's ordinary message to its own subagent, like Send.
				deliver: toolUseId
					? async (worker, instruction) => {
							const { sendSubagentMessageDetailed } = await import(
								"../../../services/agent-communication"
							);
							const sent = await sendSubagentMessageDetailed({
								callerNarratorId: ctx.narratorId,
								id: worker,
								message: instruction,
								toolUseId,
								toolCallBinding: ctx.toolCallBinding,
								signal: ctx.signal,
								locale: ctx.locale,
								userId: ctx.userId ?? null,
							});
							const target = sent.targets.find((entry) => entry.id === worker) ?? sent.targets[0];
							const [{ isNarratorRuntimeBusy }, { narratorService }] = await Promise.all([
								import("../../../services/narrator-session-state"),
								import("../../../services/narrator-service"),
							]);
							const row = await narratorService.getById(worker).catch(() => null);
							const running =
								isNarratorRuntimeBusy(worker) ||
								row?.status === "working" ||
								row?.status === "waiting";
							return items.syncDeliveryStatus(target?.status, running);
						}
					: undefined,
			});
			if (outcome.outcome !== "handed_off") return result(outcome);
			const label = await workerLabel(ctx, outcome.worker);
			return result({
				...outcome,
				nextAction: syncNextAction(outcome.delivery, label),
			});
		}
		case "work.cancel": {
			const item = items.cancelWorkItem({
				coordinatorId,
				itemId: requireField(input, "item", action),
				reason: input.reason,
				actor,
			});
			const { queuedDependentsOf } = await import("../../../services/teams/work-item-dependencies");
			const waiting = queuedDependentsOf(item.teamId, item.id);
			return result({
				item: items.viewWorkItem(item),
				...(waiting.length > 0 ? { dependents: waiting.map((entry) => entry.id) } : {}),
				nextAction: `Stop its subagent if it still runs. Its worktree stays until cleanup, which a person approves; the branch is never deleted.${
					waiting.length > 0
						? ` The queued items in dependents wait for it and can never start now: remove or replace it in their dependsOn with work.update.`
						: ""
				}`,
			});
		}
		case "brief": {
			if (typeof input.text !== "string") return result({ brief: items.readBrief(coordinatorId) });
			return result(items.updateBrief({ coordinatorId, text: input.text, actor }));
		}
		case "checkin": {
			const scheduled = items.scheduleCheckin({
				coordinatorId,
				minutes: requireField(input, "minutes", action),
				note: input.note,
				locale: ctx.locale,
				actor,
				userId: ctx.userId ?? null,
			});
			return result({
				...scheduled,
				nextAction: "End your turn; the check-in wakes this session when it is due.",
			});
		}
		case "decision": {
			const eventId = items.recordDecision({
				coordinatorId,
				text: requireField(input, "text", action),
				itemId: input.item,
				actor,
			});
			return result({
				recorded: eventId,
				nextAction: "Also say it in your report to the members.",
			});
		}
		case "cleanup": {
			const outcome = await items.cleanupWorkItem({
				coordinatorId,
				itemId: requireField(input, "item", action),
				principal: await principalOf(ctx),
				force: input.force,
				confirmedLoss: input.confirmedLoss,
				actor,
				signal: ctx.signal,
			});
			if (outcome.outcome === "refused")
				return result(
					{
						error: { code: outcome.code },
						details: outcome,
						nextAction: cleanupNextAction(outcome.code),
					},
					true,
				);
			return result({ ...outcome, branchKept: true });
		}
	}
}

export const teamTool: ToolDefinition = {
	name: TEAM_TOOL_NAME,
	description:
		"Team coordinator only: manage the team's work items, brief, decisions and check-ins. " +
		"work.list lists items (with dependsOn and blockedBy); work.create makes an item with its own branch and worktree from the team's base branch, optionally with dependsOn: items that must be merged before it may start (starting it earlier is refused with TEAM_WORK_ITEM_BLOCKED); " +
		"work.update replaces a queued item's dependsOn; " +
		"work.review records one review round (verdict, findings, a short summary of them, reviewer); work.ready marks an item done after a clear review " +
		"(refused while its worktree has uncommitted changes, or, in a repository with knowledge/index.md, while the branch changed code a knowledge node anchors without updating that node, or added a source file no node anchors: details lists them for the worker to fix); " +
		"work.sync tells the item's worker to merge the base into its branch with a merge commit (never on the server, never a rebase); it brings in origin/<base> or the local base, as the team's settings say; " +
		"work.cancel stops tracking an item; cleanup removes a cancelled or merged item's worktree (never its branch) and always asks a person; " +
		"merging a ready item into the base is a member's action on the team page, never this tool's (when origin is on GitHub, NarraFork pushes the branch, opens a pull request and merges it there through the host's gh): you get a note when it lands, conflicts, or its pull request's checks fail or a review asks for changes, and review, ready, sync and cancel are refused with TEAM_WORK_ITEM_MERGING while it runs; " +
		"brief reads or replaces the team brief every subagent follows; decision records a decision taken on people's behalf; " +
		"checkin schedules one wake-up of this session after N minutes.",
	parameters: teamToolParameters,
	async execute(args, ctx): Promise<ToolResult> {
		const parsed = teamToolParameters.safeParse(args);
		if (!parsed.success)
			return result(
				{
					error: {
						code: "INVALID_ARGUMENT",
						message: parsed.error.issues
							.slice(0, 5)
							.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
							.join("; "),
					},
				},
				true,
			);
		try {
			return await run(parsed.data, ctx);
		} catch (cause) {
			return result(
				{
					error: {
						code: cause instanceof AppError ? cause.code : "TEAM_REQUEST_FAILED",
						message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1024),
					},
					// What a refusal lists for the coordinator to act on (e.g. the stale knowledge
					// nodes of work.ready), bounded by the service.
					...(cause instanceof AppError && cause.details !== undefined
						? { details: cause.details }
						: {}),
				},
				true,
			);
		}
	},
};
