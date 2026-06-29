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
		"Search the project knowledge base (full-text + tag). Returns matching entries (id, title, snippet, tags) that the current user is allowed to read. By default this reflects YOUR personal drafts: entries you have an active draft on are matched and shown from the draft (marked '(draft)'). Pass useDraft:false to search only the committed global versions. Use this to find documented errors, procedures, FAQs, and reference material before answering or acting. Then use KnowledgeRead to fetch an entry's full content by id.",
	parameters: z.object({
		query: z
			.string()
			.describe("Search keywords (full-text). Use specific terms, error codes, etc."),
		tag: z.string().optional().describe("Optional tag to filter by"),
		collectionId: z.string().optional().describe("Optional collection id to scope the search"),
		limit: z.number().optional().describe("Max results (default 10, max 30)"),
		useDraft: z
			.boolean()
			.optional()
			.describe(
				"Default true: your active drafts shadow the global version. Set false to search only committed versions.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { query, tag, collectionId, limit, useDraft } = args as {
			query: string;
			tag?: string;
			collectionId?: string;
			limit?: number;
			useDraft?: boolean;
		};
		try {
			const principal = await principalOf(ctx);
			// Draft-shadow view is the default; only enabled when we have an identified user.
			const draftUserId = useDraft !== false && principal.userId ? principal.userId : undefined;
			const results = knowledgeService.search({
				q: query,
				tag,
				collectionId,
				projectId: ctx.projectId ?? undefined,
				limit: Math.min(limit ?? 10, 30),
				draftUserId,
			});
			const readable = await knowledgeService.filterReadable(principal, results);
			if (readable.length === 0) {
				return { output: "No matching knowledge entries found.", title: "KnowledgeSearch" };
			}
			const lines = readable.map((r) => {
				const draftMark = (r as { fromDraft?: boolean }).fromDraft ? " (draft)" : "";
				return `- [${r.id}] ${r.title}${draftMark}${r.tags?.length ? ` (tags: ${r.tags.join(", ")})` : ""}\n  ${r.snippet ?? ""}`;
			});
			return {
				output: `Found ${readable.length} entr${readable.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}\n\nUse KnowledgeRead with an id to read full content.`,
				title: `KnowledgeSearch: ${query}`,
				metadata: {
					tool: "KnowledgeSearch",
					query,
					resultCount: readable.length,
					results: readable.map((r) => ({
						id: r.id,
						title: r.title,
						snippet: r.snippet ?? "",
						tags: r.tags ?? [],
						fromDraft: (r as { fromDraft?: boolean }).fromDraft ?? false,
					})),
				},
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
		"Read the full content of a knowledge-base entry by id (from KnowledgeSearch). By default, if YOU have an active draft on the entry, its draft content is returned (your working copy, marked as such); otherwise the committed global version is returned. Pass useDraft:false to always read the committed version. Access is checked against the current user's clearance and tags; entries you cannot access return as not found.",
	parameters: z.object({
		entryId: z.string().describe("The knowledge entry id to read"),
		useDraft: z
			.boolean()
			.optional()
			.describe(
				"Default true: return your active draft content if you have one. Set false to read the committed global version.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { entryId, useDraft } = args as { entryId: string; useDraft?: boolean };
		try {
			const principal = await principalOf(ctx);
			// getEntry enforces ACL when principal is supplied; no access → NotFoundError.
			const entry = (await knowledgeService.getEntry(entryId, {
				withContent: true,
				principal,
			})) as { title: string; currentContent?: string | null; tagsJson?: unknown };
			const tags = Array.isArray(entry.tagsJson) ? (entry.tagsJson as string[]) : [];

			// Working-copy overlay: if the caller has an active draft, return it instead of main.
			let rawBody = entry.currentContent ?? "(empty)";
			let draftBanner = "";
			let isDraft = false;
			if (useDraft !== false && principal.userId) {
				const draft = await knowledgeBranchService.getMyDraft(principal, entryId);
				if (draft) {
					rawBody = draft.content ?? "(empty)";
					draftBanner = `\n> ⚠️ This is YOUR draft version (status: ${draft.status}); it is not yet merged into the global version.`;
					isDraft = true;
				}
			}

			// Cap the body so a very large entry can't blow up the context window.
			const truncated = rawBody.length > KNOWLEDGE_READ_MAX_CHARS;
			const body = truncated
				? `${rawBody.slice(0, KNOWLEDGE_READ_MAX_CHARS)}\n\n…[truncated ${rawBody.length - KNOWLEDGE_READ_MAX_CHARS} chars; the entry is longer than the read limit]`
				: rawBody;
			return {
				output: `# ${entry.title}${tags.length ? `\nTags: ${tags.join(", ")}` : ""}${draftBanner}\n\n${body}`,
				title: `KnowledgeRead: ${entry.title}`,
				metadata: {
					tool: "KnowledgeRead",
					entryId,
					title: entry.title,
					tags,
					isDraft,
					truncated,
				},
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
				metadata: {
					tool: "KnowledgeDraft",
					entryId,
					submitted,
					changeNote: changeNote ?? null,
				},
			};
		} catch (err) {
			return {
				output: `KnowledgeDraft failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
