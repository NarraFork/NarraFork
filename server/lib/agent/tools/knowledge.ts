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
		"Search the project knowledge base (full-text + tag). Returns matching entries (id, title, snippet, tags) that the current user is allowed to read. By default this reflects YOUR personal library: entries you have an active personal version of are matched and shown from it (marked '(personal)'; '(personal ⚠ behind main)' when it has drifted behind the latest global version). Pass useDraft:false to search only the committed global versions. Use this to find documented errors, procedures, FAQs, and reference material before answering or acting. Then use KnowledgeRead to fetch an entry's full content by id.",
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
				"Default true: your active personal versions shadow the global version. Set false to search only committed versions.",
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
				const row = r as { fromDraft?: boolean; drifted?: boolean };
				const draftMark = row.fromDraft
					? row.drifted
						? " (personal ⚠ behind main — rebase needed)"
						: " (personal)"
					: "";
				return `- [${r.id}] ${r.title}${draftMark}${r.tags?.length ? ` (tags: ${r.tags.join(", ")})` : ""}\n  ${r.snippet ?? ""}`;
			});
			return {
				output: `Found ${readable.length} entr${readable.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}\n\nUse KnowledgeRead with an id to read full content.`,
				title: `KnowledgeSearch: ${query}`,
				metadata: {
					tool: "KnowledgeSearch",
					query,
					resultCount: readable.length,
					results: readable.map((r) => {
						const row = r as { fromDraft?: boolean; drifted?: boolean };
						return {
							id: r.id,
							title: r.title,
							snippet: r.snippet ?? "",
							tags: r.tags ?? [],
							fromDraft: row.fromDraft ?? false,
							drifted: row.drifted ?? false,
						};
					}),
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
		"Read the full content of a knowledge-base entry by id (from KnowledgeSearch). By default, if YOU have an active personal version of the entry that is up to date with main, its content is returned (your working copy). If your personal version has DRIFTED behind the latest main, the current global version is returned instead, with a diff and a hint to rebase via KnowledgeEdit. Pass useDraft:false to always read the committed global version. Access is checked against the current user's clearance and tags; entries you cannot access return as not found.",
	parameters: z.object({
		entryId: z.string().describe("The knowledge entry id to read"),
		useDraft: z
			.boolean()
			.optional()
			.describe(
				"Default true: return your active personal version if you have one (up to date). Set false to read the committed global version.",
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
			})) as {
				title: string;
				currentContent?: string | null;
				tagsJson?: unknown;
				keywordsJson?: unknown;
			};
			const tags = Array.isArray(entry.tagsJson) ? (entry.tagsJson as string[]) : [];
			const keywords = Array.isArray(entry.keywordsJson) ? (entry.keywordsJson as string[]) : [];

			// Working-copy overlay with drift awareness. The default view shadows the caller's
			// own active PERSONAL entry, BUT only while it is based on the latest main revision.
			// Once main has advanced past its fork point (drift), the personal entry is a stale
			// "delta against an old version": we then show MAIN as the source of truth, attach a
			// main↔personal diff, and prompt a rebase — rather than silently serving old content.
			const mainBody = entry.currentContent ?? "(empty)";
			let body = mainBody;
			let banner = "";
			let isDraft = false;
			let drifted = false;
			let versionsBehind = 0;
			if (useDraft !== false && principal.userId) {
				const drift = await knowledgeBranchService.getDraftDrift(principal, entryId);
				if (drift.hasDraft) {
					if (drift.drifted) {
						// Show main; surface the personal version as a diff + rebase hint.
						drifted = true;
						versionsBehind = drift.versionsBehind;
						const diff = await knowledgeBranchService.getDraftDiff(principal, drift.draftId, {
							against: "current",
						});
						// Cap the diff independently so a huge delta can't blow up the context.
						const cappedDiff =
							diff.unified.length > KNOWLEDGE_READ_MAX_CHARS
								? `${diff.unified.slice(0, KNOWLEDGE_READ_MAX_CHARS)}\n…[diff truncated]`
								: diff.unified;
						banner =
							`\n> ⚠️ You have a personal version of this entry, but the global main has advanced since it was created` +
							`${versionsBehind > 0 ? ` (${versionsBehind} revision${versionsBehind === 1 ? "" : "s"} ahead)` : ""}.` +
							` Showing the CURRENT main version below. Your personal version is shown as a diff against main.` +
							` Next step: rebase it onto main via KnowledgeEdit (action "rebase"), then review the merged result.` +
							`\n>\n> Diff (main → your personal version):\n\`\`\`diff\n${cappedDiff}\n\`\`\``;
						body = mainBody;
					} else {
						// Not drifted → keep shadowing the personal version (the intended working-copy view).
						const draft = await knowledgeBranchService.getMyDraft(principal, entryId);
						body = draft?.content ?? mainBody;
						isDraft = true;
						banner = `\n> ⚠️ This is YOUR personal version of this entry; it is based on the latest main and is not yet published to the global base.`;
					}
				}
			}

			// Cap the body so a very large entry can't blow up the context window.
			const truncated = body.length > KNOWLEDGE_READ_MAX_CHARS;
			const cappedBody = truncated
				? `${body.slice(0, KNOWLEDGE_READ_MAX_CHARS)}\n\n…[truncated ${body.length - KNOWLEDGE_READ_MAX_CHARS} chars; the entry is longer than the read limit]`
				: body;
			return {
				output: `# ${entry.title}${tags.length ? `\nTags: ${tags.join(", ")}` : ""}${banner}\n\n${cappedBody}`,
				title: `KnowledgeRead: ${entry.title}`,
				metadata: {
					tool: "KnowledgeRead",
					entryId,
					title: entry.title,
					tags,
					keywords,
					isDraft,
					truncated,
					drift: { drifted, versionsBehind },
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
