import { z } from "zod/v4";
import type { Principal } from "../../../services/knowledge-acl";
import { knowledgeAcl } from "../../../services/knowledge-acl";
import { knowledgeBranchService } from "../../../services/knowledge-branch-service";
import { knowledgeService } from "../../../services/knowledge-service";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

/**
 * Resolve the acting principal for the current loop turn from ctx.userId.
 * NarraFork narrators have no fixed owner; authority is per-trigger.
 * userId null/anonymous → public-only baseline (handled inside resolveCapsByUserId).
 */
async function principalOf(ctx: ToolContext): Promise<Principal> {
	const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
	return { userId: caps.userId, role: caps.role };
}

// ─── KnowledgeSearch ───
export const knowledgeSearchTool: ToolDefinition = {
	name: "KnowledgeSearch",
	description:
		"Search the project knowledge base (full-text + tag). Returns matching entries (id, title, snippet, tags) that the current user is allowed to read. Use this to find documented errors, procedures, FAQs, and reference material before answering or acting. Then use KnowledgeRead to fetch an entry's full content by id.",
	parameters: z.object({
		query: z
			.string()
			.describe("Search keywords (full-text). Use specific terms, error codes, etc."),
		tag: z.string().optional().describe("Optional tag to filter by"),
		collectionId: z.string().optional().describe("Optional collection id to scope the search"),
		limit: z.number().optional().describe("Max results (default 10, max 30)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { query, tag, collectionId, limit } = args as {
			query: string;
			tag?: string;
			collectionId?: string;
			limit?: number;
		};
		try {
			const principal = await principalOf(ctx);
			const results = knowledgeService.search({
				q: query,
				tag,
				collectionId,
				projectId: ctx.projectId ?? undefined,
				limit: Math.min(limit ?? 10, 30),
			});
			const readable = await knowledgeService.filterReadable(principal, results);
			if (readable.length === 0) {
				return { output: "No matching knowledge entries found.", title: "KnowledgeSearch" };
			}
			const lines = readable.map(
				(r) =>
					`- [${r.id}] ${r.title}${r.tags?.length ? ` (tags: ${r.tags.join(", ")})` : ""}\n  ${r.snippet ?? ""}`,
			);
			return {
				output: `Found ${readable.length} entr${readable.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}\n\nUse KnowledgeRead with an id to read full content.`,
				title: `KnowledgeSearch: ${query}`,
			};
		} catch (err) {
			return {
				output: `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

// ─── KnowledgeRead ───
/** Max characters of entry body returned to the model — guards the context window. */
const KNOWLEDGE_READ_MAX_CHARS = 24_000;

export const knowledgeReadTool: ToolDefinition = {
	name: "KnowledgeRead",
	description:
		"Read the full content of a knowledge-base entry by id (from KnowledgeSearch). Returns the current version's body. Access is checked against the current user's clearance and tags; entries you cannot access return as not found.",
	parameters: z.object({
		entryId: z.string().describe("The knowledge entry id to read"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { entryId } = args as { entryId: string };
		try {
			const principal = await principalOf(ctx);
			// getEntry enforces ACL when principal is supplied; no access → NotFoundError.
			const entry = (await knowledgeService.getEntry(entryId, {
				withContent: true,
				principal,
			})) as { title: string; currentContent?: string | null; tagsJson?: unknown };
			const tags = Array.isArray(entry.tagsJson) ? (entry.tagsJson as string[]) : [];
			const rawBody = entry.currentContent ?? "(empty)";
			// Cap the body so a very large entry can't blow up the context window.
			const truncated = rawBody.length > KNOWLEDGE_READ_MAX_CHARS;
			const body = truncated
				? `${rawBody.slice(0, KNOWLEDGE_READ_MAX_CHARS)}\n\n…[truncated ${rawBody.length - KNOWLEDGE_READ_MAX_CHARS} chars; the entry is longer than the read limit]`
				: rawBody;
			return {
				output: `# ${entry.title}${tags.length ? `\nTags: ${tags.join(", ")}` : ""}\n\n${body}`,
				title: `KnowledgeRead: ${entry.title}`,
			};
		} catch {
			return {
				output: `Knowledge entry not found or not accessible: ${entryId}`,
				isError: true,
			};
		}
	},
};

// ─── KnowledgeDraft (controlled write) ───
export const knowledgeDraftTool: ToolDefinition = {
	name: "KnowledgeDraft",
	description:
		"Propose a change to a knowledge-base entry by creating/updating your personal draft and submitting it for review. ONLY use this when the user explicitly asks you to record or update knowledge. This never changes the global version directly — it creates a draft and a review submission. Requires user permission.",
	parameters: z.object({
		entryId: z.string().describe("The entry to draft a change for"),
		content: z.string().describe("The proposed new full content of the entry"),
		changeNote: z.string().optional().describe("Short note describing the change"),
		submit: z
			.boolean()
			.optional()
			.describe("If true, submit the draft for review after saving (default true)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { entryId, content, changeNote, submit } = args as {
			entryId: string;
			content: string;
			changeNote?: string;
			submit?: boolean;
		};
		// Controlled write — require explicit user permission.
		const decision = await ctx.requestPermission(
			"KnowledgeDraft",
			{ entryId, changeNote: changeNote ?? "" },
			ctx.currentToolUseId ?? "",
		);
		if (decision.behavior !== "allow") {
			return { output: "KnowledgeDraft was denied by the user.", isError: true };
		}
		try {
			const principal = await principalOf(ctx);
			if (!principal.userId) {
				return {
					output: "Cannot draft knowledge without an identified user.",
					isError: true,
				};
			}
			// Ensure the entry is readable first (also guards existence/ACL).
			await knowledgeService.getEntry(entryId, { principal });
			const existing = await knowledgeBranchService.getMyDraft(principal, entryId);
			const draft = existing
				? await knowledgeBranchService.updateDraft(principal, existing.id, { content })
				: await knowledgeBranchService.createDraft(principal, entryId, {});
			const draftId = existing ? existing.id : (draft as { id: string }).id;
			if (!existing) {
				await knowledgeBranchService.updateDraft(principal, draftId, { content });
			}
			let submitted = false;
			if (submit !== false) {
				await knowledgeBranchService.submitForReview(principal, draftId, { changeNote });
				submitted = true;
			}
			return {
				output: submitted
					? `Draft saved and submitted for review (entry ${entryId}). A reviewer must approve before it becomes the global version.`
					: `Draft saved (entry ${entryId}). Not yet submitted for review.`,
				title: "KnowledgeDraft",
			};
		} catch (err) {
			return {
				output: `KnowledgeDraft failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
