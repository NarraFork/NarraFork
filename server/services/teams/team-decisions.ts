/**
 * Who decided a call of a team tree (docs/PROJECT_TEAMS-PLAN.md §二.12, decision T6; M1).
 *
 * Any member may decide a pending call of the team's tree — approve or deny it, answer an
 * AskUserQuestion, decide an outline plan, defer a question, and answer, dismiss, ignore or
 * follow up an asynchronous question — through the ordinary HTTP routes and WebSocket frames,
 * which check write access on the call's session (a subagent's access is the coordinator's)
 * again right before deciding. The IM gateway never decides a team call (its sender has no
 * proven NarraFork identity).
 *
 * The tool call row records only THAT a person decided (`permission_decided_by = 'user'`, which
 * later gates rely on), not which person, so the person is recorded here as a team event (one of
 * `TEAM_PERSON_DECISION_EVENT_KINDS`) with `actor_id` = the user. The team page shows it in the
 * activity log and in the approvals drawer. Best-effort: written after the decision, outside its
 * transaction; a failure is logged and the decision stands.
 *
 * Calls outside a team are left alone: one primary-key probe answers "no team". SQLite only,
 * like the team surface; on another backend nothing is recorded.
 */

import {
	TEAM_EVENT_DETAIL_MAX_BYTES,
	type TeamPersonDecisionEventKind,
	teamApprovalKind,
} from "@shared/project-teams";
import { eq } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../../db";
import { narrators, narratorToolCalls, teamWorkEvents } from "../../db/schema";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { teamIdOfNarrator } from "./team-membership";

/** The session and tool of a call a person is about to decide. */
export interface DecisionTarget {
	narratorId: string;
	toolName: string;
}

/**
 * Read before deciding: a decided call leaves the in-memory registries, and its row is the
 * only record afterwards. The live registries first (permission, danger reflection), then the
 * tool call row by primary key (the request id is the tool call id).
 */
export async function readDecisionTarget(requestId: string): Promise<DecisionTarget | null> {
	try {
		const { pendingPermissions, pendingDangerReflections } = await import(
			"../narrator-session-state"
		);
		const pending = pendingPermissions.get(requestId) ?? pendingDangerReflections.get(requestId);
		if (pending) return { narratorId: pending.narratorId, toolName: pending.toolName };
		const row = db
			.select({ narratorId: narratorToolCalls.narratorId, toolName: narratorToolCalls.toolName })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, requestId))
			.limit(1)
			.get();
		return row ?? null;
	} catch (error) {
		logger.warn("Could not read the call a person is deciding", {
			requestId,
			error: String(error),
		});
		return null;
	}
}

/** The event kind of a person's decision. */
export function personDecisionKind(
	toolName: string,
	decision: "allow" | "deny",
	answered: boolean,
): TeamPersonDecisionEventKind {
	if (decision === "deny") return "approval.denied";
	return answered || teamApprovalKind(toolName) === "question"
		? "question.answered"
		: "approval.allowed";
}

/**
 * Record a person's decision on a call of a team tree as a team event. A no-op outside a team.
 * Best-effort and outside the decision's own transaction: written after the decision succeeded,
 * never throws (the decision itself already happened), logged when it cannot be written.
 */
export function recordTeamPersonDecision(input: {
	requestId: string;
	target: DecisionTarget;
	userId: string | null | undefined;
	decision: "allow" | "deny";
	/** AskUserQuestion answers came with the decision. */
	answered?: boolean;
	/** An asynchronous question (answered later from the inbox), not a pending call. */
	questionId?: string;
	/** The event kind when it is not an approve / deny / answer (async question actions). */
	kind?: TeamPersonDecisionEventKind;
}): boolean {
	if (activeDatabaseBackend !== "sqlite" || !input.userId) return false;
	try {
		const teamId = teamIdOfNarrator(input.target.narratorId);
		if (!teamId) return false;
		const session = db
			.select({ title: narrators.title, parent: narrators.parentNarratorId })
			.from(narrators)
			.where(eq(narrators.id, input.target.narratorId))
			.limit(1)
			.get();
		const depth =
			input.target.narratorId === teamId
				? 0
				: !session?.parent || session.parent === teamId
					? 1
					: 2;
		const detail: Record<string, unknown> = {
			requestId: input.requestId,
			narratorId: input.target.narratorId,
			agentTitle: (session?.title ?? "").slice(0, 120),
			depth,
			tool: input.target.toolName.slice(0, 120),
			approvalKind: teamApprovalKind(input.target.toolName),
			...(input.questionId ? { questionId: input.questionId } : {}),
		};
		db.insert(teamWorkEvents)
			.values({
				id: generateId(),
				teamId,
				workItemId: null,
				kind:
					input.kind ??
					personDecisionKind(input.target.toolName, input.decision, input.answered === true),
				actorKind: "person",
				actorId: input.userId,
				detailJson:
					Buffer.byteLength(JSON.stringify(detail), "utf8") <= TEAM_EVENT_DETAIL_MAX_BYTES
						? detail
						: null,
				createdAt: new Date().toISOString(),
			})
			.run();
		return true;
	} catch (error) {
		logger.warn("Could not record who decided a team call", {
			requestId: input.requestId,
			error: String(error),
		});
		return false;
	}
}
