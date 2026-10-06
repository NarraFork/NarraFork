import { z } from "zod/v4";
import {
	resolveKnowledgeConflictSchema,
	reviewKnowledgeSubmissionSchema,
} from "../../../lib/validators";
import { knowledgeAcl, type Principal } from "../../../services/knowledge-acl";
import { knowledgeBranchService } from "../../../services/knowledge-branch-service";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { isKnowledgeReadAction } from "./knowledge-actions";

/**
 * KnowledgeReview — optional tool for REVIEWING publish requests (submissions): approving a
 * merge into the global base, requesting changes, commenting, and resolving conflicts.
 *
 * Authoring/maintaining knowledge (create / save / publish / update meta / transfer) lives in
 * KnowledgeCreate + KnowledgeEdit. This tool is review-only.
 *
 * NOT admin-gated at load time: any logged-in user may /load it, because reviewers are not
 * necessarily admins. Authority is enforced per-action by the service layer (canReview for
 * linked entries; target-collection write for standalone publishes). Unauthorized actions
 * throw and surface as errors without leaking entry existence.
 *
 * Write actions require user permission; under bypassPermissions the merge actions trigger
 * danger reflection (see classifyDanger).
 */

async function principalOf(ctx: ToolContext): Promise<Principal> {
	const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
	return { userId: caps.userId, role: caps.role };
}

function deny(message: string): ToolResult {
	return { output: message, isError: true };
}

function jsonOut(title: string, value: unknown): ToolResult {
	return { output: JSON.stringify(value, null, 2), title };
}

export const knowledgeReviewTool: ToolDefinition = {
	name: "KnowledgeReview",
	description:
		"Review publish requests (submissions) into the shared knowledge base — for admins and " +
		"users with review/write authority. " +
		"Read actions (no approval): list_submissions, get_submission. " +
		"Write actions (require approval): approve (publish the proposal into the global base), " +
		"request_changes (bounce back for another round — the author may resubmit), " +
		"reject (refuse for good; TERMINAL, not resubmittable — use request_changes if the author " +
		"should try again), comment (leave findings without changing the request's state), " +
		"resolve_conflict (supply merged content for a conflicted publish). " +
		"Authority is enforced per request: for an edit to an existing entry you must hold its review " +
		"tags; for a brand-new entry you must be able to write its target collection. " +
		"Authoring and maintaining knowledge is done with KnowledgeCreate / KnowledgeEdit, not here.",
	parameters: z.object({
		action: z
			.enum([
				"list_submissions",
				"get_submission",
				"approve",
				"request_changes",
				"reject",
				"comment",
				"resolve_conflict",
			])
			.describe("The review action to perform"),
		submissionId: z
			.string()
			.optional()
			.describe(
				"Submission id for get_submission / approve / request_changes / comment / resolve_conflict",
			),
		entryId: z.string().optional().describe("Entry id filter for list_submissions"),
		status: z
			.enum(["pending", "approved", "rejected", "changes_requested", "conflict"])
			.optional()
			.describe("list_submissions: filter by submission status"),
		findings: z
			.array(
				z.object({
					severity: z.enum(["critical", "major", "minor", "suggestion"]),
					message: z.string(),
					location: z.string().optional(),
				}),
			)
			.optional()
			.describe("Review findings for approve / request_changes / comment"),
		resolvedContent: z
			.string()
			.optional()
			.describe("resolve_conflict: the final merged content to commit to main"),
		changeNote: z.string().optional().describe("Change note for resolve_conflict"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const a = args as Record<string, unknown>;
		const action = a.action as string;
		const principal = await principalOf(ctx);

		// Write actions require an identified user + user permission. Reads run directly.
		if (!isKnowledgeReadAction(action)) {
			if (!principal.userId) {
				return deny("Cannot perform knowledge review actions without an identified user.");
			}
			const decision = await ctx.requestPermission(
				"KnowledgeReview",
				{ action, ...a },
				ctx.currentToolUseId ?? "",
			);
			if (decision.behavior !== "allow") {
				return deny(
					decision.behavior === "deny" && decision.message
						? decision.message
						: "KnowledgeReview action was denied by the user.",
				);
			}
		}

		try {
			switch (action) {
				case "list_submissions": {
					const result = await knowledgeBranchService.listSubmissions(principal, {
						entryId: (a.entryId as string | undefined) || undefined,
						status: (a.status as string | undefined) || undefined,
					});
					return {
						...jsonOut("Knowledge submissions", result),
						metadata: { tool: "KnowledgeReview", action },
					};
				}
				case "get_submission": {
					if (!a.submissionId) return deny("get_submission requires 'submissionId'.");
					const result = await knowledgeBranchService.getSubmission(
						principal,
						a.submissionId as string,
					);
					return {
						...jsonOut("Submission detail", result),
						metadata: { tool: "KnowledgeReview", action },
					};
				}

				case "approve":
				case "request_changes":
				case "reject":
				case "comment": {
					if (!a.submissionId) return deny(`${action} requires 'submissionId'.`);
					// Action names map 1:1 to verdicts except `comment` → `comment_only`.
					const verdict =
						action === "comment"
							? "comment_only"
							: (action as "approve" | "request_changes" | "reject");
					const parsed = reviewKnowledgeSubmissionSchema.safeParse({
						verdict,
						findings: a.findings,
					});
					if (!parsed.success) return deny(`Invalid review input: ${parsed.error.message}`);
					const result = await knowledgeBranchService.review(
						principal,
						a.submissionId as string,
						parsed.data,
					);
					return {
						...jsonOut(`Review: ${action}`, result),
						metadata: {
							tool: "KnowledgeReview",
							action,
							success: true,
							submissionId: a.submissionId as string,
						},
					};
				}

				case "resolve_conflict": {
					if (!a.submissionId) return deny("resolve_conflict requires 'submissionId'.");
					const parsed = resolveKnowledgeConflictSchema.safeParse({
						resolvedContent: a.resolvedContent,
						changeNote: a.changeNote,
					});
					if (!parsed.success)
						return deny(`Invalid resolve_conflict input: ${parsed.error.message}`);
					const result = await knowledgeBranchService.resolveConflict(
						principal,
						a.submissionId as string,
						parsed.data,
					);
					return {
						...jsonOut("Conflict resolved", result),
						metadata: {
							tool: "KnowledgeReview",
							action,
							success: true,
							submissionId: a.submissionId as string,
						},
					};
				}

				default:
					return deny(`Unknown action: ${action}`);
			}
		} catch (err) {
			return deny(
				`KnowledgeReview ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
};
