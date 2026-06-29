import { z } from "zod/v4";
import {
	addKnowledgeRevisionSchema,
	createKnowledgeEntrySchema,
	resolveKnowledgeConflictSchema,
	reviewKnowledgeSubmissionSchema,
	updateKnowledgeEntrySchema,
} from "../../../lib/validators";
import { knowledgeAcl, type Principal } from "../../../services/knowledge-acl";
import { knowledgeBranchService } from "../../../services/knowledge-branch-service";
import { knowledgeService } from "../../../services/knowledge-service";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { isKnowledgeReadAction } from "./knowledge-actions";

/**
 * KnowledgeReview — optional tool for reviewing knowledge-base drafts, merging
 * approved submissions, and writing entries directly to main.
 *
 * NOT admin-gated at load time: any logged-in user may /load it, because reviewers
 * are not necessarily admins. Authority is enforced per-action by the service layer
 * (canReview for review/merge, canWriteMain for direct writes). Unauthorized actions
 * throw and are surfaced as errors without leaking entry existence.
 *
 * Write actions require user permission via ctx.requestPermission; under
 * bypassPermissions they trigger danger reflection (see classifyDanger).
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
		"Review knowledge-base drafts and write entries (for admins and users with review/write authority). " +
		"Read actions (no approval): list_submissions, get_submission. " +
		"Write actions (require approval): approve (merge a submission into main), request_changes, comment, " +
		"resolve_conflict (supply merged content for a conflicted submission), create_entry (new entry + first revision), " +
		"write_main (append a new main revision directly), update_entry_meta (title/tags/status), " +
		"transfer_owner (give an entry to another user), transfer_collection_owner (give a collection to another user). " +
		"Permission is enforced per entry: you can only review entries you hold the review tags for, and only write to " +
		"entries you own or hold a write grant for. Transfer requires you be an admin or the current owner. " +
		"Use this to help users review, merge, publish, and hand off knowledge.",
	parameters: z.object({
		action: z
			.enum([
				"list_submissions",
				"get_submission",
				"approve",
				"request_changes",
				"comment",
				"resolve_conflict",
				"create_entry",
				"write_main",
				"update_entry_meta",
				"transfer_owner",
				"transfer_collection_owner",
			])
			.describe("The review/write action to perform"),
		submissionId: z
			.string()
			.optional()
			.describe(
				"Submission id for get_submission / approve / request_changes / comment / resolve_conflict",
			),
		entryId: z
			.string()
			.optional()
			.describe(
				"Entry id filter for list_submissions, or target for write_main / update_entry_meta / transfer_owner",
			),
		collectionTargetId: z
			.string()
			.optional()
			.describe("Collection id for transfer_collection_owner"),
		newOwnerUserId: z
			.string()
			.nullable()
			.optional()
			.describe(
				"transfer_owner / transfer_collection_owner: the user id to give ownership to; null abandons ownership (admin only)",
			),
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
		changeNote: z
			.string()
			.optional()
			.describe("Change note for resolve_conflict / create_entry / write_main"),
		// create_entry
		collectionId: z.string().optional().describe("create_entry: target collection id"),
		title: z.string().optional().describe("create_entry / update_entry_meta: entry title"),
		slug: z.string().optional().describe("create_entry: optional explicit slug"),
		content: z.string().optional().describe("create_entry / write_main: entry body content"),
		format: z.enum(["markdown", "text", "json"]).optional().describe("Content format"),
		tags: z.array(z.string()).optional().describe("create_entry / update_entry_meta: tag list"),
		// update_entry_meta
		entryStatus: z
			.enum(["active", "archived"])
			.optional()
			.describe("update_entry_meta: set entry status"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const a = args as Record<string, unknown>;
		const action = a.action as string;
		const principal = await principalOf(ctx);

		// Write actions require an identified user + user permission. Reads run directly.
		if (!isKnowledgeReadAction(action)) {
			if (!principal.userId) {
				return deny("Cannot perform knowledge write actions without an identified user.");
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
				case "comment": {
					if (!a.submissionId) return deny(`${action} requires 'submissionId'.`);
					const verdict =
						action === "approve"
							? "approve"
							: action === "request_changes"
								? "request_changes"
								: "comment_only";
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

				case "create_entry": {
					// Authorization is enforced inside createEntry via the principal: the caller
					// must be able to READ the target collection AND have write capability
					// (admin / collection owner / write grant). This correctly allows a collection
					// owner who holds no global write grant, which a pre-check here could not.
					const parsed = createKnowledgeEntrySchema.safeParse({
						collectionId: a.collectionId,
						title: a.title,
						slug: a.slug,
						content: a.content,
						format: a.format,
						tags: a.tags,
						changeNote: a.changeNote,
					});
					if (!parsed.success) return deny(`Invalid create_entry input: ${parsed.error.message}`);
					const created = await knowledgeService.createEntry({
						...parsed.data,
						authorUserId: principal.userId,
						principal,
					});
					return {
						...jsonOut("Entry created", { id: created.id, title: created.title }),
						metadata: {
							tool: "KnowledgeReview",
							action,
							success: true,
							entryId: created.id,
						},
					};
				}

				case "write_main": {
					if (!a.entryId) return deny("write_main requires 'entryId'.");
					const parsed = addKnowledgeRevisionSchema.safeParse({
						content: a.content,
						format: a.format,
						changeNote: a.changeNote,
					});
					if (!parsed.success) return deny(`Invalid write_main input: ${parsed.error.message}`);
					const result = await knowledgeService.addRevision(a.entryId as string, {
						...parsed.data,
						authorUserId: principal.userId,
						principal,
					});
					return {
						...jsonOut("Main revision written", result),
						metadata: {
							tool: "KnowledgeReview",
							action,
							success: true,
							entryId: a.entryId as string,
						},
					};
				}

				case "update_entry_meta": {
					if (!a.entryId) return deny("update_entry_meta requires 'entryId'.");
					const parsed = updateKnowledgeEntrySchema.safeParse({
						title: a.title,
						tags: a.tags,
						status: a.entryStatus,
					});
					if (!parsed.success)
						return deny(`Invalid update_entry_meta input: ${parsed.error.message}`);
					await knowledgeService.updateEntryMeta(a.entryId as string, parsed.data, principal);
					return {
						output: `Entry ${a.entryId} metadata updated.`,
						title: "Entry updated",
						metadata: {
							tool: "KnowledgeReview",
							action,
							success: true,
							entryId: a.entryId as string,
						},
					};
				}

				case "transfer_owner": {
					if (!a.entryId) return deny("transfer_owner requires 'entryId'.");
					// newOwnerUserId: string (give to user) | null (abandon → unowned, admin only).
					if (a.newOwnerUserId === undefined) {
						return deny(
							"transfer_owner requires 'newOwnerUserId' (a user id, or null to abandon).",
						);
					}
					const newOwner = a.newOwnerUserId as string | null;
					const res = await knowledgeService.transferEntryOwner(
						a.entryId as string,
						newOwner,
						principal,
					);
					return {
						output: `Entry ${res.entryId} owner set to ${res.ownerUserId ?? "(none)"}.`,
						title: "Entry ownership transferred",
						metadata: {
							tool: "KnowledgeReview",
							action,
							success: true,
							entryId: a.entryId as string,
						},
					};
				}

				case "transfer_collection_owner": {
					if (!a.collectionTargetId) {
						return deny("transfer_collection_owner requires 'collectionTargetId'.");
					}
					if (a.newOwnerUserId === undefined) {
						return deny(
							"transfer_collection_owner requires 'newOwnerUserId' (a user id, or null to abandon).",
						);
					}
					const newOwner = a.newOwnerUserId as string | null;
					const res = await knowledgeService.transferCollectionOwner(
						a.collectionTargetId as string,
						newOwner,
						principal,
					);
					return {
						output: `Collection ${res.collectionId} owner set to ${res.ownerUserId ?? "(none)"}.`,
						title: "Collection ownership transferred",
						metadata: { tool: "KnowledgeReview", action, success: true },
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
