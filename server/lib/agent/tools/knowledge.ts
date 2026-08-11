import { z } from "zod/v4";
import type { Principal } from "../../../services/knowledge-acl";
import { knowledgeAcl } from "../../../services/knowledge-acl";
import { knowledgeBranchService } from "../../../services/knowledge-branch-service";
import { knowledgeService } from "../../../services/knowledge-service";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

/**
 * Resolve the acting principal for the current loop turn from ctx.userId.
 * NarraFork narrators have no fixed owner; authority is per-trigger.
 * userId null/anonymous → public-only baseline (handled inside resolveCapsByUserId).
 */
async function principalOf(ctx: ToolContext): Promise<Principal> {
	const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
	return { userId: caps.userId, role: caps.role };
}

/**
 * Discoverability hint appended to read-tool output. The write tools live in
 * OPTIONAL_TOOLS (must be loaded explicitly — a deliberate security default), so a
 * plain narrator would otherwise never learn they exist.
 *
 * Worded to stay correct for BOTH audiences, because ToolContext does not carry the
 * session's enabled-tool set and so this cannot be conditionalised: a narrator that
 * already has the write tools (e.g. a Knowledge Steward) reads it as "use them", while a
 * plain narrator reads it as "load them first". Phrasing it as an unconditional "load them
 * first" would be a false instruction for the former on every single search.
 */
const KNOWLEDGE_WRITE_TOOL_HINT =
	"To write knowledge, use KnowledgeCreate / KnowledgeEdit — if they are not in your tool list, load them first (`/load KnowledgeCreate`, `/load KnowledgeEdit`).";

/**
 * Fuller tool map, appended to KnowledgeLibrary output only.
 *
 * KNOWLEDGE_WRITE_TOOL_HINT rides on every search/read result, so it has to stay one line and
 * names only the two tools a contributor needs next. That left the remaining optional tools
 * (review, ACL admin, packs) with NO discovery path at all: they are in OPTIONAL_TOOLS, absent
 * from the tool list until loaded, and nothing ever mentioned them. KnowledgeLibrary is the
 * orientation call ("what is in here, what is mine"), so the complete map belongs here — read
 * once when getting your bearings, not on every single lookup.
 *
 * Same dual-audience wording as the short hint: correct whether or not the tools are loaded.
 */
const KNOWLEDGE_TOOL_MAP_HINT =
	"Knowledge tools (load with `/load <name>` if absent from your tool list): " +
	"KnowledgeCreate + KnowledgeEdit to author, publish, and track your own publish requests " +
	"(KnowledgeEdit action 'my_submissions'); KnowledgeReview to review OTHERS' publish requests; " +
	"KnowledgeAdmin for collections/levels/tags/grants (admin only); " +
	"PackList / PackActivate / PackDeactivate for knowledge packs (file bundles attached to entries).";

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
		limit: looseNumber("Max results (default 10, max 30)"),
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
				limit: normalizeNumber(limit, { min: 1, max: 30, fallback: 10 }),
				draftUserId,
			});
			const readable = await knowledgeService.filterReadable(principal, results);
			if (readable.length === 0) {
				return {
					output: `No matching knowledge entries found.\n\n${KNOWLEDGE_WRITE_TOOL_HINT}`,
					title: "KnowledgeSearch",
				};
			}
			const lines = readable.map((r) => {
				const row = r as { fromDraft?: boolean; drifted?: boolean };
				const draftMark = row.fromDraft
					? row.drifted
						? " (personal ⚠ behind main — rebase before relying on it, or re-query with useDraft:false to see the global version)"
						: " (personal)"
					: "";
				return `- [${r.id}] ${r.title}${draftMark}${r.tags?.length ? ` (tags: ${r.tags.join(", ")})` : ""}\n  ${r.snippet ?? ""}`;
			});
			return {
				output: `Found ${readable.length} entr${readable.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}\n\nUse KnowledgeRead with an id to read full content.\n${KNOWLEDGE_WRITE_TOOL_HINT}`,
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
				projectId: ctx.projectId ?? undefined,
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
				output: `# ${entry.title}${tags.length ? `\nTags: ${tags.join(", ")}` : ""}${banner}\n\n${cappedBody}\n\n---\n${KNOWLEDGE_WRITE_TOOL_HINT}`,
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
			// Deliberately does NOT distinguish "no such id" from "no permission" — telling the
			// caller which one it is leaks the existence of entries they may not see. But name
			// both possibilities and the way forward, or the agent has no next move.
			return {
				output:
					`Knowledge entry not found or not accessible: ${entryId}. ` +
					`Either the id is wrong or your clearance/tags do not cover it. ` +
					`Use KnowledgeSearch to get valid ids, or ask an admin for access.`,
				isError: true,
			};
		}
	},
};

// ─── KnowledgeLibrary ───
/**
 * Read-only orientation tool: which collections may I read/write, and what is in MY
 * personal library. Both answers used to be unreachable for a plain narrator — the
 * collection list only existed inside admin-only KnowledgeAdmin, and the personal
 * library only had an HTTP endpoint (GET /personal-entries) with no tool.
 *
 * Kept as a separate tool rather than extra KnowledgeSearch actions: KnowledgeSearch
 * is a full-text query surface with a required `query` param, and folding
 * list-style actions into it would make that param conditionally required and mix
 * two unrelated result shapes.
 *
 * Bounded by construction: only scalar summaries (ids, titles, flags, counts) are
 * returned — never entry or personal-entry BODIES.
 */
const LIBRARY_DEFAULT_LIMIT = 30;
const LIBRARY_MAX_LIMIT = 100;

export const knowledgeLibraryTool: ToolDefinition = {
	name: "KnowledgeLibrary",
	description:
		"Orient yourself in the knowledge base (read-only, no approval needed). Actions:\n" +
		"- list_collections: the collections the current user may READ (already ACL-filtered), each marked writable:true when they may write into it directly. Use this to get a collectionId for KnowledgeCreate instead of asking the user for one.\n" +
		"- list_mine: YOUR personal library entries (the ones KnowledgeCreate makes by default) — id, title, whether it is linked to a global entry or standalone, its publish target collection, drift status, and open publish-request status.\n" +
		"Returns metadata summaries only, never entry content — use KnowledgeRead for bodies.",
	parameters: z.object({
		action: z
			.enum(["list_collections", "list_mine"])
			.describe("list_collections (readable collections) or list_mine (my personal entries)"),
		status: z
			.enum(["active", "archived"])
			.optional()
			.describe("list_mine: filter by personal-entry status (default: all)"),
		limit: looseNumber(`Max rows (default ${LIBRARY_DEFAULT_LIMIT}, max ${LIBRARY_MAX_LIMIT})`),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { action, status, limit } = args as {
			action: "list_collections" | "list_mine";
			status?: "active" | "archived";
			limit?: number;
		};
		const max = normalizeNumber(limit, {
			min: 1,
			max: LIBRARY_MAX_LIMIT,
			fallback: LIBRARY_DEFAULT_LIMIT,
		});
		try {
			const principal = await principalOf(ctx);
			if (action === "list_collections") {
				// listCollections already hides collections the principal cannot read.
				const rows = await knowledgeService.listCollections(ctx.projectId ?? undefined, principal);
				const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
				const summaries = rows.slice(0, max).map((c) => ({
					id: c.id,
					name: c.name,
					slug: c.slug,
					projectId: c.projectId ?? null,
					// Write capability decides whether KnowledgeCreate direct:true can succeed here.
					writable: knowledgeAcl.canWriteCollection(caps, {
						id: c.id,
						defaultLevel: c.defaultLevel,
						classificationLevel: c.classificationLevel,
						controlledTagsJson: c.controlledTagsJson,
						ownerUserId: c.ownerUserId,
					}),
				}));
				if (summaries.length === 0) {
					return {
						output: "You have read access to no knowledge collections.",
						title: "KnowledgeLibrary: list_collections",
						metadata: { tool: "KnowledgeLibrary", action, count: 0, collections: [] },
					};
				}
				const lines = summaries.map(
					(c) =>
						`- [${c.id}] ${c.name} (slug: ${c.slug})${c.writable ? " — writable (direct create/save allowed)" : " — read-only (publish via KnowledgeEdit review)"}`,
				);
				return {
					output: `${summaries.length} readable collection${summaries.length === 1 ? "" : "s"}${rows.length > summaries.length ? ` (of ${rows.length}; raise 'limit' for more)` : ""}:\n${lines.join("\n")}\n\n${KNOWLEDGE_TOOL_MAP_HINT}`,
					title: "KnowledgeLibrary: list_collections",
					metadata: {
						tool: "KnowledgeLibrary",
						action,
						count: summaries.length,
						collections: summaries,
					},
				};
			}

			// list_mine
			if (!principal.userId) {
				return {
					output: "No identified user — a personal knowledge library requires a signed-in user.",
					isError: true,
				};
			}
			const mine = await knowledgeBranchService.listMine(principal, { status, limit: max });
			if (mine.length === 0) {
				return {
					output: `Your personal knowledge library is empty.\n\n${KNOWLEDGE_TOOL_MAP_HINT}`,
					title: "KnowledgeLibrary: list_mine",
					metadata: { tool: "KnowledgeLibrary", action, count: 0, personalEntries: [] },
				};
			}
			// Scalar-only summaries: content is deliberately dropped (bounded output rule).
			// Drift is resolved for the whole page in ONE query — the per-entry getDraftDrift
			// returns three full bodies each, which would be N×3 documents for N booleans.
			const driftedIds = await knowledgeBranchService
				.findDriftedDraftIds(mine)
				.catch(() => new Set<string>());
			const summaries = mine.map((d) => ({
				personalEntryId: d.id,
				title: d.title ?? null,
				linkedEntryId: d.entryId ?? null,
				standalone: !d.entryId,
				targetCollectionId: d.targetCollectionId ?? null,
				status: d.status,
				drifted: driftedIds.has(d.id),
				// Computed in SQL by listMine — the body itself is never loaded here.
				contentLength: d.contentLength,
				updatedAt: d.updatedAt,
			}));
			const lines = summaries.map((s) => {
				const kind = s.standalone
					? `standalone${s.targetCollectionId ? ` → collection ${s.targetCollectionId}` : " (no publish target set — use KnowledgeEdit action 'set_target')"}`
					: `linked to entry ${s.linkedEntryId}${s.drifted ? " ⚠ behind main — rebase needed" : ""}`;
				return `- [${s.personalEntryId}] ${s.title ?? "(inherits global title)"} — ${kind}; status ${s.status}, ${s.contentLength} chars`;
			});
			return {
				output:
					`${summaries.length} personal entr${summaries.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}\n\n` +
					`Use KnowledgeEdit to work on these (save / rebase / set_target / publish, then ` +
					`my_submissions / withdraw / resubmit to follow a publish request through review).`,
				title: "KnowledgeLibrary: list_mine",
				metadata: {
					tool: "KnowledgeLibrary",
					action,
					count: summaries.length,
					personalEntries: summaries,
				},
			};
		} catch (err) {
			return {
				output: `KnowledgeLibrary ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
