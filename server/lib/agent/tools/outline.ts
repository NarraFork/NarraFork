/**
 * The outline tools: `OutlineRead` and `OutlineSearch` (core, read-only, across every space the
 * session may read) and `OutlineEdit` (optional, loaded with its routine). The work lives in
 * `server/services/outline/agent-*.ts`, loaded on first use; this module holds the schemas, the
 * descriptions and what only a tool call knows: the turn's person, the session's permission
 * mode and the call's provenance.
 *
 * All three are offered only while `outline.enabled` is on. Descriptions are static strings, so
 * an optional tool loaded in the history keeps the prompt cache (`tool-loading.ts`).
 */
import { z } from "zod/v4";
import { settings } from "../../settings";
import { MAX_BYTES, MAX_LINES } from "../truncate";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { looseNumber } from "./number-param";
import { OUTLINE_EDIT_TOOL, OUTLINE_READ_TOOL, OUTLINE_SEARCH_TOOL } from "./outline-names";

type ToolOutput = import("../../../services/outline/agent-read").OutlineToolOutput;
type Scope = import("../../../services/outline/agent-scope").OutlineAgentScope;
type EditRequest = import("../../../services/outline/agent-edit").OutlineEditRequest;

function outlineEnabled(): boolean {
	return settings.outline?.enabled === true;
}

/** The agent loop keeps the tail of a long output; an outline must keep its top instead. */
function exceedsLoopLimits(output: string): boolean {
	return Buffer.byteLength(output, "utf8") > MAX_BYTES || output.split("\n").length > MAX_LINES;
}

function toResult(out: ToolOutput): ToolResult {
	return {
		output: out.output,
		...(out.isError ? { isError: true } : {}),
		...(out.title ? { title: out.title } : {}),
		metadata: out.metadata,
		...(out.bounded || exceedsLoopLimits(out.output) ? { truncated: true } : {}),
	};
}

async function disabledText(): Promise<string> {
	const { OUTLINE_TOOL_TEXT } = await import("../../../services/outline/messages");
	return OUTLINE_TOOL_TEXT.disabled;
}

/**
 * Whether this session may write only its own outline space: read-only mode, strict plan mode
 * (relaxed planning keeps the session's mode), or a read-only capability ceiling. Read live, as
 * the notification service does, so a mode switched mid-turn applies at once.
 */
async function writesLimitedToSessionSpace(ctx: ToolContext): Promise<boolean> {
	if (ctx.runtimePolicy?.tools.readOnly || ctx.runtimePolicy?.readOnlyGitShell) return true;
	const [{ db }, { narrators }, { eq }, { isPlanModeTrait }, { resolveEffectiveRelaxedPlan }] =
		await Promise.all([
			import("@server/db"),
			import("@server/db/schema"),
			import("drizzle-orm"),
			import("../../narrator-utils"),
			import("../../permission-modes"),
		]);
	const [row] = await db
		.select({
			permissionMode: narrators.permissionMode,
			traits: narrators.traits,
			relaxedPlan: narrators.relaxedPlan,
		})
		.from(narrators)
		.where(eq(narrators.id, ctx.narratorId))
		.limit(1);
	if (!row) return true;
	return (
		row.permissionMode === "readOnly" ||
		(isPlanModeTrait(row.traits) &&
			!resolveEffectiveRelaxedPlan(row.permissionMode, row.relaxedPlan))
	);
}

/**
 * The tool call row and the message it belongs to, for the commit's provenance. The binding names
 * the row; without one (legacy callers) the provider tool-use id finds it.
 */
async function callProvenance(
	ctx: ToolContext,
): Promise<{ messageId: string | null; toolCallId: string | null }> {
	const binding = ctx.toolCallBinding;
	if (!binding && !ctx.currentToolUseId) return { messageId: null, toolCallId: null };
	try {
		const [{ db }, { narratorToolCalls }, { and, eq }] = await Promise.all([
			import("@server/db"),
			import("@server/db/schema"),
			import("drizzle-orm"),
		]);
		const row = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, ctx.narratorId),
				binding
					? eq(narratorToolCalls.id, binding.toolCallId)
					: eq(narratorToolCalls.toolUseId, ctx.currentToolUseId as string),
			),
			columns: { id: true, messageId: true },
		});
		return {
			messageId: row?.messageId ?? null,
			toolCallId: row?.id ?? binding?.toolCallId ?? null,
		};
	} catch {
		return { messageId: null, toolCallId: binding?.toolCallId ?? null };
	}
}

async function openScope(ctx: ToolContext, forWrite: boolean): Promise<Scope> {
	const { OutlineAgentScope } = await import("../../../services/outline/agent-scope");
	return await OutlineAgentScope.open({
		narratorId: ctx.narratorId,
		userId: ctx.userId ?? null,
		sessionSpaceOnly: forWrite ? await writesLimitedToSessionSpace(ctx) : false,
	});
}

async function failure(error: unknown, tool: string): Promise<ToolResult> {
	const { AppError } = await import("../../errors");
	if (error instanceof AppError && error.statusCode < 500) {
		return { output: error.message, isError: true, metadata: { tool } };
	}
	const { logger } = await import("../../logger");
	logger.warn("Outline tool failed", {
		tool,
		error: error instanceof Error ? error.message : String(error),
	});
	return {
		output: `${tool} failed: ${error instanceof Error ? error.message : String(error)}`,
		isError: true,
		metadata: { tool },
	};
}

// ─── OutlineRead ───

export const outlineReadTool: ToolDefinition = {
	name: OUTLINE_READ_TOOL,
	description: `Read the outline (the team's shared, versioned notes: pages of nested blocks in spaces: this session's project, its own notes, your personal space, and the other projects' and sessions' spaces this session may read). Returns a page or any block with what is under it as a markdown outline, expanded level by level within a budget.
- Every line starts with the block's address: \`- [Ab3dEf9Q] text\`, \`- [Ab3dEf9Q] [ ] a task @agent:name\`. The first line names the space (its key, e.g. Kx81mPqa). In this session's own spaces (its project's, its notes, the personal space) the id alone is the address; blocks of any other space are labeled key/id (\`- [Lm29XkQa/Ab3dEf9Q] text\`), which is how to address them. Links show their target's current title: [[Kx81mPqa/Ab3dEf9Q|Title]]; a link without a title points to something this session cannot read, or to nothing.
- Lines in ‹…› are notes, not content: ‹… 12 more› means blocks left out by the budget (raise budget, or read that block).
- A page shows facts by default: tasks and everything under them are left out (view "all" includes them; reading a task shows all of it).
- address: an id, key/id, an alias such as Q17, or a block's title (ids, aliases and titles alone are looked up in this session's own spaces). Omit it to list this session's own spaces and their pages; key/ (or project/, session/, personal/) lists one space's pages; "*" is an overview of every space this session can read, its own first, each with its pages expanded together within the budget.
- asOf: a commit number or a time, to read the block as it was then.
To write, use OutlineEdit (copy what you read into it: the ids and ‹…› notes are dropped).`,
	parameters: z.object({
		address: z
			.string()
			.optional()
			.describe(
				"Block or page: an id, key/id, an alias or a title. Omit to list this session's spaces; key/ lists a space's pages; \"*\" is an overview of every space this session can read",
			),
		view: z
			.enum(["facts", "all"])
			.optional()
			.describe('"facts" (default) leaves tasks and what is under them out; "all" shows them'),
		budget: looseNumber("Blocks to show at most (default 80, max 2000)"),
		asOf: z
			.union([z.number(), z.string()])
			.optional()
			.describe("Read as of a commit number or a time (ISO 8601)"),
	}),
	isAvailable: outlineEnabled,
	metadata: { readOnly: true },
	async execute(args, ctx): Promise<ToolResult> {
		if (!outlineEnabled()) return { output: await disabledText(), isError: true };
		try {
			const { outlineRead } = await import("../../../services/outline/agent-read");
			const scope = await openScope(ctx, false);
			return toResult(
				await outlineRead(scope, {
					address: typeof args.address === "string" ? args.address : undefined,
					view: args.view === "all" ? "all" : args.view === "facts" ? "facts" : undefined,
					budget: typeof args.budget === "number" ? args.budget : undefined,
					asOf:
						typeof args.asOf === "number" || typeof args.asOf === "string" ? args.asOf : undefined,
				}),
			);
		} catch (error) {
			return await failure(error, OUTLINE_READ_TOOL);
		}
	},
};

// ─── OutlineSearch ───

export const outlineSearchTool: ToolDefinition = {
	name: OUTLINE_SEARCH_TOOL,
	description: `Search the outline by words (full text over block content, titles and aliases). Returns up to 50 blocks, best matches first and facts before process (tasks, what is under them, session notes), each with its address [key/id], where it sits and a snippet. Read a result with OutlineRead.
Searches this session's own spaces by default (its project's, its own notes, and the personal space where available); spaces names others by key, and ["*"] searches every space this session can read.`,
	parameters: z.object({
		query: z.string().describe("Words to look for"),
		spaces: z
			.array(z.string())
			.optional()
			.describe(
				'Space keys (or project, session, personal; "*" for every space this session can read) to search instead of the default',
			),
		limit: looseNumber("Results at most (default 20, max 50)"),
	}),
	isAvailable: outlineEnabled,
	metadata: { readOnly: true },
	async execute(args, ctx): Promise<ToolResult> {
		if (!outlineEnabled()) return { output: await disabledText(), isError: true };
		try {
			const { outlineSearch } = await import("../../../services/outline/agent-read");
			const scope = await openScope(ctx, false);
			return toResult(
				await outlineSearch(scope, {
					query: String(args.query ?? ""),
					spaces: Array.isArray(args.spaces)
						? args.spaces.filter((s): s is string => typeof s === "string")
						: undefined,
					limit: typeof args.limit === "number" ? args.limit : undefined,
				}),
			);
		} catch (error) {
			return await failure(error, OUTLINE_SEARCH_TOOL);
		}
	},
};

// ─── OutlineEdit ───

const CHECKBOXES = [" ", "/", "x", "-", "todo", "doing", "done", "cancelled", "none"] as const;

const editSchema = z.object({
	add: z
		.string()
		.optional()
		.describe(
			'Add under this block; key/ (or project/, session/, personal/) adds new pages to that space, "/" to the default space',
		),
	markdown: z.string().optional().describe("With add: the blocks, as a markdown outline"),
	replace: z.string().optional().describe("Replace this block's text"),
	text: z
		.string()
		.optional()
		.describe("With replace: the new text, written like one outline item without its bullet"),
	move: z.string().optional().describe("Move this block (and what is under it)"),
	to: z.string().optional().describe("With move: the new parent block, or key/ to make it a page"),
	after: z
		.string()
		.optional()
		.describe("With add or move: the sibling to place after (default: last)"),
	delete: z.string().optional().describe("Delete this block and everything under it"),
	set: z.string().optional().describe("Set the checkbox, assignee or alias of this block"),
	checkbox: z
		.enum(CHECKBOXES)
		.optional()
		.describe('With set: " " todo, "/" doing, "x" done, "-" cancelled, "none" no checkbox'),
	assignee: z
		.string()
		.nullable()
		.optional()
		.describe("With set: agent:name or human:name; null clears it"),
	alias: z
		.string()
		.nullable()
		.optional()
		.describe('With set: an alias such as Q17, "Q?" for the next free number, null to clear'),
});

type EditInput = z.infer<typeof editSchema>;

const EDIT_KINDS = ["add", "replace", "move", "delete", "set"] as const;
const EDIT_FIELDS: Record<(typeof EDIT_KINDS)[number], readonly string[]> = {
	add: ["markdown", "after"],
	replace: ["text"],
	move: ["to", "after"],
	delete: [],
	set: ["checkbox", "assignee", "alias"],
};

/** One edit as the service takes it, or what is wrong with it. */
function editRequest(edit: EditInput, n: number): EditRequest | string {
	const present = Object.entries(edit)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key);
	const kinds = EDIT_KINDS.filter((kind) => present.includes(kind));
	if (kinds.length !== 1) {
		return `edit ${n}: give exactly one of add, replace, move, delete, set (got ${kinds.join(", ") || "none"})`;
	}
	const kind = kinds[0] as (typeof EDIT_KINDS)[number];
	const stray = present.filter((key) => key !== kind && !EDIT_FIELDS[kind].includes(key));
	if (stray.length > 0) return `edit ${n}: ${stray.join(", ")} does not go with ${kind}`;
	switch (kind) {
		case "add":
			if (edit.markdown === undefined) return `edit ${n}: add needs markdown`;
			return {
				add: edit.add as string,
				markdown: edit.markdown,
				...(edit.after !== undefined ? { after: edit.after } : {}),
			};
		case "replace":
			if (edit.text === undefined) return `edit ${n}: replace needs text`;
			return { replace: edit.replace as string, text: edit.text };
		case "move":
			if (edit.to === undefined) return `edit ${n}: move needs to`;
			return {
				move: edit.move as string,
				to: edit.to,
				...(edit.after !== undefined ? { after: edit.after } : {}),
			};
		case "delete":
			return { delete: edit.delete as string };
		case "set":
			if (edit.checkbox === undefined && edit.assignee === undefined && edit.alias === undefined) {
				return `edit ${n}: set needs checkbox, assignee or alias`;
			}
			return {
				set: edit.set as string,
				...(edit.checkbox !== undefined ? { checkbox: edit.checkbox } : {}),
				...(edit.assignee !== undefined ? { assignee: edit.assignee } : {}),
				...(edit.alias !== undefined ? { alias: edit.alias } : {}),
			};
	}
}

export const outlineEditTool: ToolDefinition = {
	name: OUTLINE_EDIT_TOOL,
	description: `Write to the outline. One call is one commit in one space: all edits apply, or none does. Every commit records who wrote it and can be reverted.
edits, in order, each one of:
- { add: <parent>, markdown, after? }: add blocks written as a markdown outline under a block, or as new pages with key/ (or project/, session/, personal/), or "/" for this session's project space (its own notes when it may not write the project's). after: the sibling to place them after (default: last).
- { replace: <block>, text }: the block's new text, written like one outline item without its bullet. A checkbox, @assignee and key:: lines in it are applied, whatever you leave out keeps its value, indented items become child blocks.
- { move: <block>, to: <parent or key/>, after? }
- { delete: <block> }: the block and everything under it.
- { set: <block>, checkbox?, assignee?, alias? }: checkbox " " todo, "/" doing, "x" done, "-" cancelled, "none" makes a task a plain block; assignee agent:name, human:name or null; alias Q17, "Q?" (next free number) or null.
Markdown outline: every list item is a block, indentation nests; \`- [ ] task @agent:name\` is a task; \`depends:: [[…]]\`, \`due:: 2026-11-01\`, \`alias:: Q?\`, \`tags:: [[…]]\` lines under an item are properties. Link with [[title]], [[alias]] or [[key/id]]; links are stored as addresses, so renaming never breaks them, and blocks added in one call can link to each other by title. Text copied from OutlineRead works as is: the ids after bullets and the ‹…› notes are dropped. Lists or extra paragraphs inside one item become child blocks; the result says what was split.
<block>, <parent>: an id, key/id, an alias or a title. message: a short summary for the timeline.
The result gives each edit's outcome and the ids of new blocks. Read a block (OutlineRead) before you replace or delete it, unless this session wrote it (blocks another session or a subagent wrote need a read too): what you read is forgotten when the server restarts, and an edit of a block you have not read that someone else wrote writes nothing and shows the block's current text, which then counts as read. If someone else changed a block after you read it, your replace is merged with their change where the two do not overlap, and the result shows the merged text (continue from that text); if they overlap, or the block's edit is a move, delete or set, nothing is written: read it again and redo the edit. A delete also writes nothing when blocks under the block changed (or were added by someone else) since you read them; the result shows them.`,
	parameters: z.object({
		edits: z.array(editSchema).min(1).max(200).describe("The edits, applied in order"),
		message: z.string().optional().describe("Short summary of the change for the timeline"),
	}),
	isAvailable: outlineEnabled,
	async execute(args, ctx): Promise<ToolResult> {
		if (!outlineEnabled()) return { output: await disabledText(), isError: true };
		const raw = Array.isArray(args.edits) ? (args.edits as EditInput[]) : [];
		const edits: EditRequest[] = [];
		const problems: string[] = [];
		raw.forEach((edit, i) => {
			const request = editRequest(edit, i + 1);
			if (typeof request === "string") problems.push(request);
			else edits.push(request);
		});
		if (problems.length > 0 || edits.length === 0) {
			return {
				output: ["Nothing was written.", ...problems.map((p) => `- ${p}`)].join("\n"),
				isError: true,
				metadata: { tool: OUTLINE_EDIT_TOOL },
			};
		}
		try {
			const { outlineEdit } = await import("../../../services/outline/agent-edit");
			const scope = await openScope(ctx, true);
			const provenance = await callProvenance(ctx);
			return toResult(
				await outlineEdit(
					scope,
					{
						edits,
						...(typeof args.message === "string" ? { message: args.message } : {}),
					},
					{ ...provenance, signal: ctx.signal },
				),
			);
		} catch (error) {
			return await failure(error, OUTLINE_EDIT_TOOL);
		}
	},
};
