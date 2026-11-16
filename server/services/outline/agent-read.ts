/**
 * `OutlineRead` and `OutlineSearch`: what an agent gets back, as text it can act on.
 *
 * HOW A READ LOOKS
 * ----------------
 *   ‹space Kx81mPqa · this session's project "NarraFork" · in Auth module›
 *   - [Pq83nXcB] Token refresh has a race; see [[Lm29XkQa/Rt5uVw7Y|Session notes]]
 *     - [Ab3dEf9Q] [ ] Add a regression test @agent:w-auth
 *     ‹… more›
 *   ‹facts only: 2 tasks or questions not shown; read with view "all" to include them›
 *
 * The first line names the space once (its key and what it is) and where the block sits. Every
 * block line carries the block's address right after the bullet: its short id in one of the
 * session's own spaces (where a bare id is looked up), `key/sid` in any other space it may read.
 * Links show their targets' current titles where the session may read them (`link-display.ts`);
 * a link to anything else shows no title, whether its target is unreadable or does not exist,
 * and is never expanded. Lines in `‹…›` are notes, never content: an edit that copies a read
 * back drops them, and drops the ids again (`edit-text.ts`).
 *
 * ANY BLOCK, WITHIN A BUDGET
 * --------------------------
 * A space holds blocks, and a read names any of them: the block and what is under it, level by
 * level until the budget is spent (`subtree-read.ts`: what a read costs follows the blocks it
 * returns, never the size of what is under the block). Where the budget ends, `‹… more›` stands
 * under the block whose children are not all shown. The agent continues by reading that block,
 * or, where a level is long, by reading its parent again with `after` (the last child it was
 * shown): that read starts after it. A space as a whole (`key/`) lists its top-level blocks by
 * title, and continues the same way.
 *
 * READING ACROSS SPACES
 * ---------------------
 * Every space the session may read (`session-scope.ts`) can be read and searched: by key,
 * through the overview of all of them (`OutlineRead` with address `*`: each space's top-level
 * blocks, expanded level by level within one budget, the session's own spaces first), or by
 * searching them all (`OutlineSearch` with spaces `["*"]`; the readable set goes into the SQL
 * filter before the result limit). A space it may not read is never named, listed or searched,
 * and a reference into one gets exactly the answer a reference to nothing gets. Reads of other
 * spaces are recorded in the read ledger like any other. The overview and searches span several
 * turns of the event loop: an access change meanwhile makes them start again (`stableAnswer`),
 * so they never show what the session may no longer read.
 *
 * CHANGES WAITING FOR CONFIRMATION
 * --------------------------------
 * A current read shows the open changes of the locked plans it reads (a locked task among the
 * blocks shown, or above them; design §2.6): this session's own changes laid over the outline,
 * its version, and others' as marks on the blocks they touch (`pending-overlay.ts`, owner
 * decision Q1). Changes waiting for this session's confirmation (it is the locker's delegate)
 * are listed after the outline, and so is, once, each decision on this session's own changes
 * there it has not been told of.
 *
 * The output is bounded by the read's budget, so the agent loop must not cut it again (its cut
 * keeps the tail and would lose the top of the outline).
 */
import { blockTitle, serializeMarkdownOutline, TASK_BOX } from "@shared/outline";
import { OUTLINE_SUBTREE_LIMITS } from "@shared/outline-subtree-api";
import { type OutlineAgentScope, type OutlineSpaceWord, spaceRootName } from "./agent-scope";
import { LINK_DISPLAY_LIMITS, linkTitles, withLinkTitles } from "./link-display";
import { OUTLINE_LISTED_NAMES, OUTLINE_TOOL_TEXT } from "./messages";
import { outlinePendingLabel } from "./model";
import { mergeProposal, pendingNames, takePendingReports, withCurrentDeciders } from "./pending";
import { PENDING_WITHDRAW } from "./pending-hold";
import {
	type OutlineOwnPending,
	type OutlinePendingOverlay,
	pendingOverlay,
} from "./pending-overlay";
import { commitSeqAt } from "./read";
import { recordOutlineReads } from "./read-ledger";
import {
	OUTLINE_READ_LIMITS,
	type OutlineBudget,
	type OutlineDisplay,
	type OutlineRenderResult,
	type OutlineRenderSection,
	outlineItem,
	renderOutline,
	renderOutlineSections,
} from "./render";
import type { OutlineResolvedBlock } from "./resolve";
import { OUTLINE_SEARCH_LIMITS, searchOutline } from "./search";
import { sessionScopeEpoch, yieldToEventLoop } from "./session-scope";
import type { OutlineLevelCursor } from "./store/history-port";
import type { OutlinePendingHead, OutlineSpaceRow } from "./store/port";
import { readOutlineAncestry } from "./subtree-marks";
import {
	encodeOutlineLevelCursor,
	type OutlineReadNodes,
	readOutlineLevelsNodes,
	readOutlineSubtreeNodes,
} from "./subtree-read";
import type { OutlineNode, OutlineView } from "./tree";

/** A tool's answer before it becomes a `ToolResult`. */
export interface OutlineToolOutput {
	output: string;
	isError?: boolean;
	title?: string;
	metadata: Record<string, unknown>;
	/** The tool bounded the output itself; the agent loop must not cut it again. */
	bounded?: boolean;
}

/** Limits of the agent's reads (tests lower some of them). */
export const OUTLINE_AGENT_READ_LIMITS = {
	/** Blocks one read shows at most (what one read of a subtree takes from the store). */
	maxBlocks: OUTLINE_SUBTREE_LIMITS.maxBlocks,
	/** Top-level blocks listed per space when a space is read as a whole. */
	maxTopsListed: 100,
	/** UTF-8 bytes of rendered text per block of budget, between the default and the maximum. */
	bytesPerBlock: 256,
	/** Characters of a title in a header, a path or a list of top-level blocks. */
	titleChars: 100,
	/** Spaces the overview of every readable space covers. */
	overviewSpaces: 50,
	/** Blocks the overview reads of one space at least, however many spaces share the budget. */
	overviewMinShare: 12,
	/** Bytes of content the overview reads of one space at least. */
	overviewMinBytes: 4096,
	/** Reads of levels one continued level (`after`) makes below its first. */
	levelReads: 6,
	/** Spaces a search of every readable space covers. */
	searchAllSpaces: 100,
};

/** The address that reads the overview of every space the session may read. */
export const OUTLINE_ALL_SPACES = "*";

export interface OutlineReadInput {
	/**
	 * Any block; `key/` (or `project/`, `session/`, `personal/`) lists a space's top-level
	 * blocks; `*` is the overview of every space the session may read.
	 */
	address?: string;
	view?: OutlineView;
	/** Blocks to show at most. */
	budget?: number;
	/** A commit number of the block's space, or a time. */
	asOf?: number | string;
	/**
	 * Continue a level: a block directly under `address` (a top-level block of the space, for
	 * `key/`). The read shows the blocks after it there, not the block at `address` again.
	 */
	after?: string;
}

export interface OutlineSearchInput {
	query: string;
	/** Space keys or words, `*` for every readable space; the session's own spaces by default. */
	spaces?: string[];
	limit?: number;
}

function clip(text: string, max: number = OUTLINE_AGENT_READ_LIMITS.titleChars): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/** Text without markdown punctuation, to tell whether a snippet says more than the title. */
function plainText(text: string): string {
	return text
		.replace(/[`*_~[\]()\\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function note(text: string): string {
	return `‹${text.replace(/\n+/g, " ")}›`;
}

/** The budget of a read: the blocks asked for (default 80, at most 800) and the bytes for them. */
function budgetOf(blocks: number | undefined): OutlineBudget {
	if (blocks === undefined || !Number.isFinite(blocks))
		return { ...OUTLINE_READ_LIMITS.defaultBudget };
	const n = Math.max(1, Math.min(OUTLINE_AGENT_READ_LIMITS.maxBlocks, Math.floor(blocks)));
	return {
		blocks: n,
		bytes: Math.max(
			OUTLINE_READ_LIMITS.defaultBudget.bytes,
			Math.min(OUTLINE_READ_LIMITS.maxBytes, n * OUTLINE_AGENT_READ_LIMITS.bytesPerBlock),
		),
	};
}

function failed(text: string, metadata: Record<string, unknown>): OutlineToolOutput {
	return { output: text, isError: true, metadata: { tool: "OutlineRead", ...metadata } };
}

// ─────────────────────────────────────────────────────────────────────────────
// A tree loaded in part
// ─────────────────────────────────────────────────────────────────────────────

/** What one or several reads of levels returned, linked into one tree. */
interface LoadedTree {
	nodes: Map<string, OutlineNode>;
	/** The children loaded of the level read from its top (a space, a level continued). */
	tops: OutlineNode[];
	/** Blocks with children the tree does not hold; `null` stands for the top level. */
	open: Set<string | null>;
	/** Tasks and questions the facts view left out of the levels read. */
	processHidden: number;
}

type TreePart = OutlineReadNodes<{
	blocks: ReadonlyArray<{ id: string; hasChildren: boolean }>;
	levels: ReadonlyArray<{
		parentId: string | null;
		childIds: readonly string[];
		more: boolean;
		processHidden: number;
	}>;
}>;

/**
 * Link the nodes of some reads by the levels they returned. `top` names the parent whose
 * children are the tree's top (a space: `null`; a level continued: its parent, which the tree
 * does not hold); `undefined` when the tree has one root among its nodes.
 */
function linkTree(parts: readonly TreePart[], top: string | null | undefined): LoadedTree {
	const nodes = new Map<string, OutlineNode>();
	const withChildren = new Set<string>();
	for (const part of parts) {
		for (const node of part.nodes) {
			node.parent = null;
			node.children = [];
			nodes.set(node.id, node);
		}
		for (const block of part.read.blocks) if (block.hasChildren) withChildren.add(block.id);
	}
	const tops: OutlineNode[] = [];
	const open = new Set<string | null>();
	const looked = new Set<string | null>();
	let processHidden = 0;
	for (const part of parts) {
		for (const level of part.read.levels) {
			const parent = level.parentId === null ? undefined : nodes.get(level.parentId);
			const isTop = top !== undefined && level.parentId === top;
			if (!parent && !isTop) continue;
			looked.add(level.parentId);
			// The top level of the read is `null` here, whichever block it hangs under.
			if (level.more) open.add(parent ? level.parentId : null);
			processHidden += level.processHidden;
			for (const id of level.childIds) {
				const child = nodes.get(id);
				if (!child) continue;
				if (parent) {
					child.parent = parent;
					parent.children.push(child);
				} else tops.push(child);
			}
		}
	}
	for (const id of withChildren) if (!looked.has(id)) open.add(id);
	return { nodes, tops, open, processHidden };
}

/** What a read shows of a loaded tree: one root, or the blocks of a level. */
interface Shown {
	rendered: OutlineRenderResult;
	/** Notes after the outline (changes waiting for confirmation). */
	notes: string[];
	/** Block versions shown, for the read ledger. */
	reads: Array<readonly [string, number]>;
}

/**
 * Render a loaded tree as a read shows it: links with their targets' titles, the open changes
 * of the locked plans read laid over or marked (current reads), within the budget.
 */
async function showTree(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	tree: LoadedTree,
	args: {
		/** The read's root; null: the blocks of `tree.tops`. */
		root: OutlineNode | null;
		view: OutlineView;
		budget: OutlineBudget;
		state: { current: boolean; seq: number };
		/** Locked tasks above what was read. */
		lockedAbove: readonly string[];
		/** The block whose reads report decisions on this session's changes; null: none. */
		reportsOf: string | null;
		/** The block read: changes waiting for this session anywhere in its top-level block are listed. */
		forYouUnder: string;
	},
): Promise<Shown> {
	const { state } = args;
	const label = scope.labelIn(space);
	const pending = state.current
		? await pendingForRead(scope, space, {
				roots: [
					...args.lockedAbove,
					...[...tree.nodes.values()].flatMap((node) => (node.task?.lock ? [node.id] : [])),
				],
				reportsOf: args.reportsOf,
				forYouUnder: args.forYouUnder,
			})
		: null;
	const overlay = pending?.overlay ?? null;
	overlay?.prepare({ nodes: tree.nodes });
	const loaded = [...tree.nodes.values()].filter((node) => node.content !== null);
	overlay?.finish(loaded);
	const seen = new Map<string, number>();
	const display = await displayFor(scope, seen)(state, loaded);
	const moreBelow = (node: OutlineNode) => tree.open.has(node.id);
	const annotate = overlay ? (node: OutlineNode) => overlay.annotate(node) : undefined;
	const topOpen = tree.open.has(null);
	const rendered = args.root
		? renderOutline(args.root, {
				view: args.view,
				budget: args.budget,
				label: (node) => label(node.sid),
				display,
				annotate,
				moreBelow,
			})
		: renderOutlineSections(
				[
					{
						header: [],
						roots: tree.tops,
						label: (node) => label(node.sid),
						moreTops: (hidden) =>
							topOpen
								? OUTLINE_TOOL_TEXT.moreOpen(hidden.blocks)
								: hidden.roots > 0
									? OUTLINE_TOOL_TEXT.moreCounted(hidden.blocks)
									: null,
					},
				],
				{ view: args.view, budget: args.budget, display, annotate, moreBelow },
			);
	// Blocks a pending change of this session adds are shown but not stored: not read.
	const added = overlay?.added;
	const reads = rendered.blockIds.flatMap((id) => {
		const version = seen.get(id);
		return version === undefined || added?.has(id) ? [] : [[id, version] as const];
	});
	return { rendered, notes: (pending?.notes ?? []).map(note), reads };
}

// ─────────────────────────────────────────────────────────────────────────────
// A space as a whole: its top-level blocks by title
// ─────────────────────────────────────────────────────────────────────────────

/** A space's top-level blocks as outline lines, each with its address, from `after` on. */
async function topLines(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	after: OutlineLevelCursor | null = null,
): Promise<{ lines: string[]; more: boolean; count: number; last: string | null }> {
	const limit = OUTLINE_AGENT_READ_LIMITS.maxTopsListed;
	const { rows, next } = await scope.store.listLevel(space.id, null, {
		asOf: null,
		after,
		limit,
	});
	// Only titles, clipped: not a read of the blocks (their edits need one).
	const heads = new Map(
		rows.length === 0
			? []
			: (await scope.store.getBlockHeads(rows.map((row) => row.id))).map((head) => [
					head.id,
					head.contentHead,
				]),
	);
	const label = scope.labelIn(space);
	const address = scope.addressIn(space);
	const lines = rows.map((row) => {
		const box = row.taskJson ? `[${TASK_BOX[row.taskJson.status]}] ` : "";
		const title = clip(blockTitle(heads.get(row.id) ?? "")) || OUTLINE_TOOL_TEXT.untitled;
		return `- ${label(row.sid)} ${box}${title}`;
	});
	const last = rows.at(-1);
	return {
		lines,
		more: next !== null,
		count: rows.length,
		last: last ? address(last.sid) : null,
	};
}

async function spaceSection(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	isDefault: boolean,
	after: OutlineLevelCursor | null = null,
): Promise<{ lines: string[]; count: number; more: boolean }> {
	const tops = await topLines(scope, space, after);
	const lines = [note(OUTLINE_TOOL_TEXT.spaceSection(await scope.describe(space), isDefault))];
	if (tops.lines.length === 0) {
		lines.push(note(after ? OUTLINE_TOOL_TEXT.nothingAfter : OUTLINE_TOOL_TEXT.nothingYet));
	}
	lines.push(...tops.lines);
	if (tops.more && tops.last) {
		lines.push(note(OUTLINE_TOOL_TEXT.moreTops(space.key, tops.last)));
	}
	return { lines, count: tops.count, more: tops.more };
}

/** `OutlineRead` with no address: the session's own spaces and their top-level blocks. */
async function readOverview(scope: OutlineAgentScope): Promise<OutlineToolOutput> {
	const own = await scope.ownSpaces();
	if (own.length === 0) {
		return {
			output: OUTLINE_TOOL_TEXT.noSpaces,
			title: "OutlineRead",
			metadata: { tool: "OutlineRead", spaces: [] },
		};
	}
	const context = await scope.contextSpace();
	const lines = [note(OUTLINE_TOOL_TEXT.overviewHeader)];
	const spaces: Array<Record<string, unknown>> = [];
	for (const { word, space } of own) {
		const section = await spaceSection(scope, space, space.id === context?.id);
		lines.push(...section.lines);
		spaces.push({ key: space.key, kind: space.kind, word, blocks: section.count });
	}
	lines.push(note(OUTLINE_TOOL_TEXT.writeHint));
	return {
		output: lines.join("\n"),
		title: "OutlineRead",
		metadata: { tool: "OutlineRead", spaces },
	};
}

/** An answer built from what the session may read, before it is given. */
interface ScopedAnswer {
	output: OutlineToolOutput;
	/** Block versions it shows, for the read ledger. */
	reads: ReadonlyArray<readonly [string, number]>;
	/** Spaces whose content it shows. */
	spaces: readonly OutlineSpaceRow[];
}

/** Times an answer is built again when access changes while it is built. */
const ACCESS_ATTEMPTS = 3;

/**
 * Build an answer that spans several turns of the event loop (the overview, a search of every
 * space) and give it only if no access change dropped cached verdicts meanwhile
 * (`sessionScopeEpoch`): otherwise build it again from a fresh scope. When access keeps changing,
 * the last answer is given only if every space it shows is still readable now; else nothing is.
 * The read ledger records only the answer given.
 */
async function stableAnswer(
	scope: OutlineAgentScope,
	build: (scope: OutlineAgentScope) => Promise<ScopedAnswer>,
): Promise<OutlineToolOutput> {
	let current = scope;
	let answer: ScopedAnswer | null = null;
	let settled = false;
	for (let attempt = 0; attempt < ACCESS_ATTEMPTS && !settled; attempt++) {
		if (attempt > 0) current = await current.reopen();
		const epoch = sessionScopeEpoch();
		answer = await build(current);
		settled = sessionScopeEpoch() === epoch;
	}
	if (!answer) throw new Error("no answer was built");
	if (!settled) {
		const fresh = await current.reopen();
		for (const space of answer.spaces) {
			if (!(await fresh.canRead(space))) {
				return {
					output: OUTLINE_TOOL_TEXT.accessChanged,
					isError: true,
					metadata: { tool: answer.output.metadata.tool },
				};
			}
		}
	}
	if (answer.reads.length > 0) recordOutlineReads(scope.narratorId, answer.reads);
	return answer.output;
}

/**
 * `OutlineRead` with address `*`: every space the session may read (its own first, at most
 * {@link OUTLINE_AGENT_READ_LIMITS.overviewSpaces}), each with its top-level blocks, expanded
 * together within the read's budget (`renderOutlineSections`, round-robin across spaces): first
 * the top-level blocks of every space, then, with what the budget has left, the next level of
 * all of them, and so on. Facts only by default: tasks are left out, and so are other sessions'
 * notes, which are process as a whole (design §2.1): such a space shows as its line and the
 * number of its top-level blocks; view `all` lists them.
 *
 * Bounded: one read of each space from its top (`readOutlineSubtreeNodes`), for a share of the
 * budget (twice an even share, so a space with little leaves room for the others; at least
 * {@link OUTLINE_AGENT_READ_LIMITS.overviewMinShare} blocks), yielding between spaces. Where a space's share ended, its blocks say
 * `‹… more›`. What it shows is a read: recorded in the ledger, links titled where the session
 * may read them.
 */
async function overviewAnswer(
	scope: OutlineAgentScope,
	input: OutlineReadInput,
): Promise<ScopedAnswer> {
	const meta: Record<string, unknown> = { tool: "OutlineRead", address: OUTLINE_ALL_SPACES };
	const refuse = (text: string): ScopedAnswer => ({
		output: { output: text, isError: true, metadata: meta },
		reads: [],
		spaces: [],
	});
	if (input.asOf !== undefined) return refuse(OUTLINE_TOOL_TEXT.overviewNotAsOf);
	if (input.after !== undefined) return refuse(OUTLINE_TOOL_TEXT.afterNeedsLevel);
	const limits = OUTLINE_AGENT_READ_LIMITS;
	const { spaces, cut } = await scope.readableSpaces(limits.overviewSpaces);
	if (spaces.length === 0) {
		const output: OutlineToolOutput = {
			output: OUTLINE_TOOL_TEXT.allSpacesNone,
			title: "OutlineRead: *",
			metadata: { ...meta, spaces: [], complete: cut === null },
		};
		return { output, reads: [], spaces: [] };
	}
	const view: OutlineView = input.view ?? "facts";
	const budget = budgetOf(input.budget);
	const context = await scope.contextSpace();
	const share = {
		// Not capped by the budget: a read spends its blocks on rows read, and the facts view may
		// leave the first of them out (top-level tasks).
		blocks: Math.min(
			limits.maxBlocks,
			Math.max(limits.overviewMinShare, Math.ceil((budget.blocks * 2) / spaces.length)),
		),
		bytes: Math.min(
			budget.bytes,
			Math.max(limits.overviewMinBytes, Math.ceil((budget.bytes * 2) / spaces.length)),
		),
	};

	const sections: OutlineRenderSection[] = [];
	const all: OutlineNode[] = [];
	const open = new Set<string>();
	const shownOf: Array<{
		space: OutlineSpaceRow;
		word: OutlineSpaceWord | null;
		own: boolean;
		tops: readonly OutlineNode[];
		process?: number;
	}> = [];
	let processHidden = 0;
	let truncated = cut !== null;
	for (const { space, word } of spaces) {
		// Every space's read is a stretch of the main thread of its own.
		await yieldToEventLoop();
		const own = scope.isOwnSpace(space);
		const header = [
			note(OUTLINE_TOOL_TEXT.spaceSection(await scope.describe(space), space.id === context?.id)),
		];
		if (view === "facts" && space.kind === "session" && !own) {
			// Another session's notes are process: counted, not listed (metas only, bounded).
			const max = limits.maxTopsListed;
			const count = (await scope.store.listChildMetas(space.id, [null], max + 1)).length;
			sections.push({
				header,
				roots: [],
				footer: [
					note(
						count === 0
							? OUTLINE_TOOL_TEXT.nothingYet
							: OUTLINE_TOOL_TEXT.otherSessionNotes(Math.min(count, max), count > max),
					),
				],
			});
			shownOf.push({ space, word, own, tops: [], process: Math.min(count, max) });
			continue;
		}
		const got = await readOutlineSubtreeNodes({
			space,
			rootId: null,
			budget: share,
			view,
			store: scope.store,
		});
		const tree = linkTree(got ? [got] : [], null);
		for (const node of tree.nodes.values()) all.push(node);
		for (const id of tree.open) if (id !== null) open.add(id);
		processHidden += tree.processHidden;
		const topOpen = tree.open.has(null);
		truncated ||= tree.open.size > 0;
		const label = scope.labelIn(space);
		sections.push({
			header,
			roots: tree.tops,
			label: (node) => label(node.sid),
			footer:
				tree.tops.length === 0 && !topOpen && tree.processHidden === 0
					? [note(OUTLINE_TOOL_TEXT.nothingYet)]
					: [],
			moreTops: (hidden) =>
				hidden.roots === 0 && !topOpen
					? null
					: note(OUTLINE_TOOL_TEXT.moreTopsOf(space.key, hidden.roots, topOpen)),
		});
		shownOf.push({ space, word, own, tops: tree.tops });
	}

	// The render is a stretch of the main thread of its own.
	await yieldToEventLoop();
	const state = { current: true, seq: 0 };
	const seen = new Map<string, number>();
	const display = await displayFor(scope, seen)(state, all);
	await yieldToEventLoop();
	const notes: string[] = [];
	if (processHidden > 0) notes.push(note(OUTLINE_TOOL_TEXT.factsHidden(processHidden)));
	if (cut === "limit") notes.push(note(OUTLINE_TOOL_TEXT.moreSpaces));
	if (cut === "candidates") notes.push(note(OUTLINE_TOOL_TEXT.spacesUnchecked));
	const rendered = renderOutlineSections(sections, {
		view,
		budget,
		display,
		notes,
		interleave: true,
		moreBelow: (node) => open.has(node.id),
	});
	const reads = rendered.blockIds.flatMap((id) => {
		const version = seen.get(id);
		return version === undefined ? [] : [[id, version] as const];
	});
	const shownIds = new Set(rendered.blockIds);
	const output: OutlineToolOutput = {
		output: `${note(OUTLINE_TOOL_TEXT.allSpacesHeader(spaces.length))}\n${rendered.markdown}`,
		title: "OutlineRead: *",
		bounded: true,
		metadata: {
			...meta,
			spaces: shownOf.map((entry) => ({
				key: entry.space.key,
				kind: entry.space.kind,
				word: entry.word,
				own: entry.own,
				blocks: entry.process ?? entry.tops.filter((top) => shownIds.has(top.id)).length,
				...(entry.process !== undefined ? { process: true } : {}),
			})),
			complete: cut === null,
			view: rendered.view,
			blocks: rendered.blockIds.length,
			hiddenByBudget: rendered.hiddenByBudget,
			hiddenByView: rendered.hiddenByView + processHidden,
			truncated: truncated || rendered.hiddenByBudget > 0,
		},
	};
	return { output, reads, spaces: shownOf.map((entry) => entry.space) };
}

/** `after` of a read of a space: one of its top-level blocks, as a place to continue from. */
async function topCursor(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	after: string,
): Promise<OutlineLevelCursor | { error: string }> {
	const resolution = await scope.resolve(after, space);
	const block = resolution.status === "found" ? resolution.block : null;
	const meta =
		block && block.spaceId === space.id
			? (await scope.store.getBlockMetasByIds([block.id]))[0]
			: undefined;
	if (!meta || meta.deleted || meta.parentId !== null) {
		return { error: OUTLINE_TOOL_TEXT.afterNotUnder(after, `${space.key}/`) };
	}
	return { orderKey: meta.orderKey, id: meta.id };
}

async function readSpace(
	scope: OutlineAgentScope,
	name: string,
	after: string | undefined,
): Promise<OutlineToolOutput> {
	const space = name === "" ? await scope.contextSpace() : await scope.space(name);
	if (!space) {
		return failed(OUTLINE_TOOL_TEXT.noSuchSpace(name || "/"), { address: `${name}/` });
	}
	let cursor: OutlineLevelCursor | null = null;
	if (after !== undefined) {
		const found = await topCursor(scope, space, after);
		if ("error" in found) return failed(found.error, { address: `${space.key}/` });
		cursor = found;
	}
	const context = await scope.contextSpace();
	const section = await spaceSection(scope, space, space.id === context?.id, cursor);
	return {
		output: section.lines.join("\n"),
		title: `OutlineRead: ${space.key}/`,
		metadata: {
			tool: "OutlineRead",
			address: `${space.key}/`,
			space: { key: space.key, kind: space.kind },
			blocks: section.count,
			...(section.more ? { truncated: true } : {}),
		},
	};
}

function candidateLines(candidates: readonly OutlineResolvedBlock[]): string[] {
	return candidates.map(
		(c) =>
			`- [${c.address}] ${clip(c.title) || OUTLINE_TOOL_TEXT.untitled}${
				c.isPage ? OUTLINE_TOOL_TEXT.topMark : ""
			}`,
	);
}

/** The commit seq a read is as of: a number, or a time looked up in the space's commits. */
async function readSeq(
	space: OutlineSpaceRow,
	asOf: number | string,
): Promise<number | { error: string }> {
	if (typeof asOf === "number") {
		return Number.isSafeInteger(asOf) && asOf >= 0 ? asOf : { error: OUTLINE_TOOL_TEXT.badAsOf };
	}
	const text = asOf.trim().replace(/^#/, "");
	if (/^\d+$/.test(text)) return Number(text);
	if (Number.isNaN(Date.parse(text))) return { error: OUTLINE_TOOL_TEXT.badAsOf };
	return await commitSeqAt(space.id, text);
}

/**
 * Links in the blocks a read shows, with the titles of the targets the session may read; and
 * the version of each block, for the read ledger.
 */
function displayFor(scope: OutlineAgentScope, seen: Map<string, number>) {
	return async (
		state: { current: boolean; seq: number },
		nodes: readonly OutlineNode[],
	): Promise<OutlineDisplay | undefined> => {
		for (const node of nodes) seen.set(node.id, node.versionSeq);
		const rows = await scope.store.listLinksAt(
			nodes.map((node) => node.id),
			state.current ? null : state.seq,
			["link", "embed", "depends"],
			LINK_DISPLAY_LIMITS.maxLinkRows,
		);
		const targets = new Map<string, string[]>();
		for (const row of rows) {
			if (row.targetKind !== "block") continue;
			const list = targets.get(row.fromBlockId);
			if (list) list.push(row.targetRef);
			else targets.set(row.fromBlockId, [row.targetRef]);
		}
		if (targets.size === 0) return undefined;
		const titles = await linkTitles([...targets.values()].flat(), {
			store: scope.store,
			canRead: (space) => scope.canRead(space),
			spaceByKey: (key) => scope.spaceByKey(key),
		});
		if (titles.size === 0) return undefined;
		return (node, item) => {
			const own = targets.get(node.id);
			if (!own) return item;
			const depends = item.props.depends?.map((dep) => {
				const title = dep.label === null ? titles.get(dep.target) : undefined;
				return title ? { target: dep.target, label: title } : dep;
			});
			return {
				...item,
				content: withLinkTitles(item.content, own, titles),
				props: depends ? { ...item.props, depends } : item.props,
			};
		};
	};
}

/**
 * Blocks of `space` as a current read shows them, each on its own without children: the
 * block's label after the bullet (`[sid]` in an own space, `[key/sid]` elsewhere), links with
 * their targets' titles where the session may read them. An edit's result shows the blocks it
 * merged this way, so they can be copied back like a read.
 */
export async function blockLinesForAgent(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	nodes: readonly OutlineNode[],
): Promise<Map<string, string>> {
	const display = await displayFor(scope, new Map())({ current: true, seq: 0 }, nodes);
	const label = scope.labelIn(space);
	const out = new Map<string, string>();
	for (const node of nodes) {
		const item = outlineItem(node);
		out.set(
			node.id,
			serializeMarkdownOutline([display?.(node, item) ?? item], { label: () => label(node.sid) }),
		);
	}
	return out;
}

/**
 * The level under `parent` continued after one of its children: the children after it, each
 * with what is under it, breadth first within the budget. A few reads of levels at most
 * ({@link OUTLINE_AGENT_READ_LIMITS.levelReads}); what they did not reach says `‹… more›`.
 */
async function levelAfter(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	parent: { id: string },
	cursor: OutlineLevelCursor,
	args: { asOf: number | undefined; view: OutlineView; budget: OutlineBudget },
): Promise<LoadedTree> {
	const { asOf, view, budget } = args;
	const store = scope.store;
	const parts: TreePart[] = [];
	const first = await readOutlineLevelsNodes({
		space,
		parents: [{ parentId: parent.id, cursor: encodeOutlineLevelCursor(cursor) }],
		asOf,
		limit: budget.blocks,
		bytes: budget.bytes,
		view,
		store,
	});
	parts.push(first);
	let room = budget.blocks - first.nodes.length;
	let frontier = first.read.blocks.filter((block) => block.hasChildren).map((block) => block.id);
	for (
		let reads = 0;
		frontier.length > 0 && room > 0 && reads < OUTLINE_AGENT_READ_LIMITS.levelReads;
		reads++
	) {
		const batch = frontier.slice(0, OUTLINE_SUBTREE_LIMITS.maxParents);
		const part = await readOutlineLevelsNodes({
			space,
			parents: batch.map((parentId) => ({ parentId })),
			asOf,
			limit: room,
			bytes: budget.bytes,
			view,
			store,
		});
		parts.push(part);
		room -= part.nodes.length;
		frontier = [
			...frontier.slice(batch.length),
			...part.read.blocks.filter((block) => block.hasChildren).map((block) => block.id),
		];
	}
	return linkTree(parts, parent.id);
}

/** Where `after` sits (now, or as of a seq): directly under `parentId`, or an error. */
async function levelCursor(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	parent: OutlineResolvedBlock,
	after: string,
	asOf: number | undefined,
): Promise<OutlineLevelCursor | { error: string }> {
	const resolution = await scope.resolve(after, space);
	const block = resolution.status === "found" ? resolution.block : null;
	const error = { error: OUTLINE_TOOL_TEXT.afterNotUnder(after, parent.address) };
	if (!block || block.spaceId !== space.id) return error;
	if (asOf === undefined) {
		const meta = (await scope.store.getBlockMetasByIds([block.id]))[0];
		if (!meta || meta.deleted || meta.parentId !== parent.id) return error;
		return { orderKey: meta.orderKey, id: meta.id };
	}
	const version = (await scope.store.listVersionsAt([block.id], asOf))[0];
	if (!version || version.deleted || version.parentId !== parent.id) return error;
	return { orderKey: version.orderKey, id: block.id };
}

export async function outlineRead(
	scope: OutlineAgentScope,
	input: OutlineReadInput,
): Promise<OutlineToolOutput> {
	const address = input.address?.trim() ?? "";
	const after = input.after?.trim() || undefined;
	if (address === "") {
		if (after !== undefined) return failed(OUTLINE_TOOL_TEXT.afterNeedsLevel, {});
		if (input.asOf !== undefined) return failed(OUTLINE_TOOL_TEXT.listNotAsOf, {});
		return await readOverview(scope);
	}
	if (address === OUTLINE_ALL_SPACES) {
		return await stableAnswer(scope, (current) => overviewAnswer(current, input));
	}
	const spaceName = spaceRootName(address);
	if (spaceName !== null) {
		// Refused before the space is looked up: the same answer whether it exists or not.
		if (input.asOf !== undefined) return failed(OUTLINE_TOOL_TEXT.listNotAsOf, { address });
		return await readSpace(scope, spaceName, after);
	}

	const resolution = await scope.resolve(address);
	if (resolution.status === "not_found") {
		return failed(OUTLINE_TOOL_TEXT.notFound(address), { address });
	}
	if (resolution.status === "ambiguous") {
		return {
			output: [
				note(OUTLINE_TOOL_TEXT.ambiguous(address)),
				...candidateLines(resolution.candidates),
			].join("\n"),
			metadata: {
				tool: "OutlineRead",
				address,
				candidates: resolution.candidates.map((c) => c.address),
			},
		};
	}
	const block = resolution.block;
	const space = await scope.space(block.spaceKey);
	if (!space) return failed(OUTLINE_TOOL_TEXT.notFound(address), { address });
	let asOf: number | undefined;
	if (input.asOf !== undefined) {
		const seq = await readSeq(space, input.asOf);
		if (typeof seq !== "number") return failed(seq.error, { address });
		asOf = seq;
	}
	const budget = budgetOf(input.budget);
	const gone = () =>
		failed(
			asOf === undefined
				? OUTLINE_TOOL_TEXT.deleted(block.address)
				: OUTLINE_TOOL_TEXT.notAtSeq(block.address, asOf),
			{ address: block.address },
		);

	// The block with its ancestors, and (unless a level is continued) what is under it.
	const got = await readOutlineSubtreeNodes({
		space,
		rootId: block.id,
		asOf,
		budget: after === undefined ? budget : { blocks: 2, bytes: budget.bytes },
		view: input.view,
		store: scope.store,
	});
	if (!got) return gone();
	const { read } = got;
	const state = { current: read.current, seq: read.seq };
	const path = read.path.map((p) => clip(p.title, 40) || OUTLINE_TOOL_TEXT.untitled);
	if (read.pathTruncated) path.unshift("…");
	const label = scope.labelIn(space);

	let tree: LoadedTree;
	let shown: Shown;
	if (after === undefined) {
		tree = linkTree([got], undefined);
		const root = tree.nodes.get(block.id);
		if (!root) return gone();
		shown = await showTree(scope, space, tree, {
			root,
			view: read.view,
			budget,
			state,
			lockedAbove: got.lockedAbove,
			reportsOf: block.id,
			forYouUnder: block.id,
		});
	} else {
		const cursor = await levelCursor(scope, space, block, after, asOf);
		if ("error" in cursor) return failed(cursor.error, { address: block.address });
		const root = got.nodes[0];
		tree = await levelAfter(scope, space, block, cursor, { asOf, view: read.view, budget });
		path.push(clip(blockTitle(root?.content ?? ""), 40) || OUTLINE_TOOL_TEXT.untitled);
		shown = await showTree(scope, space, tree, {
			root: null,
			view: read.view,
			budget,
			state,
			lockedAbove: [...got.lockedAbove, ...(root?.task?.lock ? [block.id] : [])],
			reportsOf: null,
			forYouUnder: block.id,
		});
	}
	const { rendered } = shown;
	if (read.current) recordOutlineReads(scope.narratorId, shown.reads);

	const afterLabel = after === undefined ? null : label(bareSid(after));
	const header = note(
		OUTLINE_TOOL_TEXT.readHeader(
			await scope.describe(space),
			path,
			read.current ? null : read.seq,
			afterLabel,
		),
	);
	const lines = [header];
	if (rendered.markdown !== "") lines.push(rendered.markdown);
	else if (after !== undefined) lines.push(note(OUTLINE_TOOL_TEXT.nothingAfter));
	if (tree.processHidden > 0) lines.push(note(OUTLINE_TOOL_TEXT.factsHidden(tree.processHidden)));
	lines.push(...shown.notes);
	const truncated = rendered.hiddenByBudget > 0 || rendered.openBelow || tree.open.has(null);
	return {
		output: lines.join("\n"),
		title: `OutlineRead: ${clip(blockTitle(block.title), 60) || block.address}`,
		bounded: true,
		metadata: {
			tool: "OutlineRead",
			address: block.address,
			space: { key: space.key, kind: space.kind },
			rootId: block.id,
			...(after !== undefined ? { after } : {}),
			view: rendered.view,
			blocks: rendered.blockIds.length,
			hiddenByBudget: rendered.hiddenByBudget,
			hiddenByView: rendered.hiddenByView + tree.processHidden,
			truncated,
			...(read.current ? {} : { asOf: read.seq }),
			// For the reader's card, never the model's text: the block by its title, where it sits,
			// and the space by its name.
			title: clip(blockTitle(block.title), 80),
			// The titles as they are (an untitled block's is empty: the card words it in the
			// reader's language, not the model's "(untitled)").
			path: read.path.slice(-6).map((p) => clip(p.title, 40)),
			display: { v: 1, space: await scope.spaceDisplay(space) },
		},
	};
}

/** The id part of a reference as written (`key/sid`, `[sid]`, `sid`), for a header. */
function bareSid(ref: string): string {
	const text = ref.trim().replace(/^\[+|\]+$/g, "");
	const slash = text.lastIndexOf("/");
	return slash >= 0 ? text.slice(slash + 1) : text;
}

/**
 * The open changes a read of this session shows (the module header): its own laid over, others'
 * marked, those waiting for its confirmation and its decided ones listed. `roots` are the locked
 * tasks read or above what was read: a change hangs on the locked task its plan is rooted at
 * and touches only blocks under it, so these are the changes that can touch the read. Changes
 * waiting for this session's confirmation are listed further: any under the top-level block of
 * `forYouUnder` (the block read), as a read of its page listed them, so a delegate reading a
 * sibling of the locked task is still told ({@link pendingForYouNearby}). Null when there is
 * nothing to show.
 */
async function pendingForRead(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	args: { roots: readonly string[]; reportsOf: string | null; forYouUnder: string | null },
): Promise<{ overlay: OutlinePendingOverlay | null; notes: string[] } | null> {
	const session = scope.rootNarratorId ?? scope.narratorId;
	const store = scope.store;
	const roots = [...new Set(args.roots)];
	// Heads only (review S-7): the operations of this session's own changes are read below.
	const heads =
		roots.length === 0
			? []
			: (await store.listOpenPendingByRoots(roots, OUTLINE_SUBTREE_LIMITS.pendingRows)).filter(
					(row) => row.spaceId === space.id,
				);
	const reports = args.reportsOf ? await decisionReports(scope, session, args.reportsOf) : [];
	const nearby = args.forYouUnder
		? await pendingForYouNearby(
				scope,
				space,
				session,
				args.forYouUnder,
				new Set(heads.map((h) => h.id)),
			)
		: [];
	if (heads.length === 0 && reports.length === 0 && nearby.length === 0) return null;
	// Who decides each change is the lock as it is now (review S-8).
	const rows = await withCurrentDeciders(heads, { store });
	const names = await pendingNames([...rows, ...reports, ...nearby]);
	// Sessions are named by title only when this session may read them (review S-5).
	const titles = await scope.readableTitles(names.narrators);
	const text = OUTLINE_TOOL_TEXT.pending;
	const sessionName = (id: string) => text.deciderSession(titles.get(id) ?? null, id);
	const actorName = (ref: { kind: string; id: string }) =>
		ref.kind === "human"
			? text.deciderPerson(names.users.get(ref.id) ?? null, ref.id)
			: sessionName(ref.id);
	const deciderOf = (row: OutlinePendingHead) => {
		const by = actorName(row.deciderJson.by);
		return row.deciderJson.delegate
			? text.deciderEither(by, sessionName(row.deciderJson.delegate))
			: by;
	};
	const labeled = (row: OutlinePendingHead) => ({
		row,
		label: outlinePendingLabel(row.id),
		decider: deciderOf(row),
	});
	const others = rows.filter((r) => r.requesterSession !== session);
	// This session's own changes whole, laid over the blocks as they are now (review S-2).
	const ownIds = new Set(rows.filter((r) => r.requesterSession === session).map((r) => r.id));
	const deciderById = new Map(rows.map((r) => [r.id, r.deciderJson]));
	const own: OutlineOwnPending[] = [];
	if (ownIds.size > 0) {
		for (const whole of await store.getPending([...ownIds])) {
			if (whole.status !== "open") continue;
			const row = { ...whole, deciderJson: deciderById.get(whole.id) ?? whole.deciderJson };
			own.push({ ...labeled(row), row, merges: await mergeProposal(store, row) });
		}
	}
	const notes: string[] = own.map(({ label, decider, merges }) => {
		const states = [...merges.values()].map((m) => m.state);
		return text.yours(
			label,
			decider,
			states.includes("conflict") ? "conflict" : states.includes("merged") ? "merged" : "none",
		);
	});
	// Changes this session decides: it is the session the locker named (or its subagent). Those
	// found nearby are listed only, never laid over or marked: they touch no block read.
	const decidable = [...others, ...nearby];
	const delegates = [
		...new Set(decidable.flatMap((r) => (r.deciderJson.delegate ? [r.deciderJson.delegate] : []))),
	];
	if (delegates.length > 0) {
		const roots = await store.getNarratorRoots(delegates);
		for (const row of decidable) {
			const delegate = row.deciderJson.delegate;
			if (!delegate || (roots.get(delegate)?.root ?? delegate) !== session) continue;
			notes.push(
				text.forYou(
					outlinePendingLabel(row.id),
					row.summary || text.summaryOf(row.opCount),
					row.requesterSession ? sessionName(row.requesterSession) : actorName(row.requestedByJson),
				),
			);
		}
	}
	for (const row of reports) {
		const label = outlinePendingLabel(row.id);
		const by = row.decidedByJson ? actorName(row.decidedByJson) : OUTLINE_TOOL_TEXT.edit.someone;
		if (row.status === "confirmed") {
			const seq = row.decisionCommitId
				? ((await store.getCommit(row.decisionCommitId))?.seq ?? null)
				: null;
			notes.push(text.reportConfirmed(label, by, seq));
		} else if (row.status === "rejected") notes.push(text.reportRejected(label, by, row.reason));
		else
			notes.push(
				text.reportWithdrawn(
					label,
					row.reason === PENDING_WITHDRAW.deleted ? text.whyDeleted : text.whyUnlocked,
				),
			);
	}
	return {
		overlay: pendingOverlay({
			own,
			others: others.map(labeled),
			text: {
				own: text.markOwn,
				ownDeleted: text.markOwnDeleted,
				other: text.markOther,
				ownMerged: text.markOwnMerged,
				ownConflict: text.markOwnConflict,
			},
		}),
		notes,
	};
}

/** Open changes of a space a read looks through for those waiting for its session, at most. */
const PENDING_NEARBY_SCAN = OUTLINE_SUBTREE_LIMITS.pendingRows;

/**
 * Open changes waiting for `session`'s confirmation (it is the delegate the locker named, or its
 * root) whose plan is under the same top-level block as `blockId`, besides those in `seen`.
 * Bounded: one read of the space's open change heads (at most {@link PENDING_NEARBY_SCAN}, oldest
 * first), the deciders as they are now, and one walk up from the block and the few changes left
 * (at most `markWalkRows` blocks); a walk cut short lists none of them.
 */
async function pendingForYouNearby(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	session: string,
	blockId: string,
	seen: ReadonlySet<string>,
): Promise<OutlinePendingHead[]> {
	const store = scope.store;
	const listed = (await store.listOpenPendingBySpace(space.id, PENDING_NEARBY_SCAN)).filter(
		(row) => !seen.has(row.id) && row.requesterSession !== session && row.rootBlockId !== null,
	);
	if (listed.length === 0) return [];
	const current = (await withCurrentDeciders(listed, { store })).filter(
		(row) => !!row.deciderJson.delegate,
	);
	if (current.length === 0) return [];
	const roots = await store.getNarratorRoots([
		...new Set(current.map((row) => row.deciderJson.delegate as string)),
	]);
	const mine = current.filter((row) => {
		const delegate = row.deciderJson.delegate as string;
		return (roots.get(delegate)?.root ?? delegate) === session;
	});
	if (mine.length === 0) return [];
	const ancestry = await readOutlineAncestry(
		space.id,
		[blockId, ...mine.map((row) => row.rootBlockId as string)],
		{ maxRows: OUTLINE_SUBTREE_LIMITS.markWalkRows, store },
	);
	const topOf = (id: string): string | null => {
		const above = ancestry.above(id);
		return above === null ? null : (above.at(-1) ?? id);
	};
	const top = topOf(blockId);
	if (top === null) return [];
	return mine.filter((row) => topOf(row.rootBlockId as string) === top);
}

/**
 * Decisions on this session's changes it has not been told of, for a read of `blockId`: told
 * once, then marked. The store files a decided change by the top-level block its plan is under,
 * which is looked up here from the block read; nothing of it reaches the agent.
 */
async function decisionReports(
	scope: OutlineAgentScope,
	session: string,
	blockId: string,
): Promise<OutlinePendingHead[]> {
	const meta = (await scope.store.getBlockMetasByIds([blockId]))[0];
	if (!meta || meta.deleted) return [];
	return await takePendingReports(session, { store: scope.store, pageId: meta.pageId });
}

export async function outlineSearch(
	scope: OutlineAgentScope,
	input: OutlineSearchInput,
): Promise<OutlineToolOutput> {
	return await stableAnswer(scope, (current) => searchAnswer(current, input));
}

async function searchAnswer(
	scope: OutlineAgentScope,
	input: OutlineSearchInput,
): Promise<ScopedAnswer> {
	const query = input.query.trim();
	const spaces: OutlineSpaceRow[] = [];
	const unknown: string[] = [];
	const ownOnly = !input.spaces || input.spaces.length === 0;
	let cut: "limit" | "candidates" | null = null;
	const take = (space: OutlineSpaceRow) => {
		if (!spaces.some((s) => s.id === space.id)) spaces.push(space);
	};
	if (!ownOnly) {
		for (const raw of input.spaces ?? []) {
			const name = raw.trim().replace(/\/$/, "");
			if (name === OUTLINE_ALL_SPACES) {
				// Every readable space, listed before the search: the set goes into its SQL filter.
				const all = await scope.readableSpaces(OUTLINE_AGENT_READ_LIMITS.searchAllSpaces);
				for (const { space } of all.spaces) take(space);
				cut = all.cut;
				continue;
			}
			const space = await scope.space(name);
			if (space) take(space);
			else unknown.push(raw);
		}
	} else {
		for (const own of await scope.ownSpaces()) take(own.space);
	}
	const keys = spaces.map((space) => space.key);
	if (spaces.length === 0) {
		const output: OutlineToolOutput = {
			output:
				unknown.length > 0
					? OUTLINE_TOOL_TEXT.noSuchSpace(unknown.join(", "))
					: OUTLINE_TOOL_TEXT.noSpaces,
			isError: unknown.length > 0,
			metadata: { tool: "OutlineSearch", query, spaces: [], resultCount: 0, results: [] },
		};
		return { output, reads: [], spaces: [] };
	}
	const limit = Math.max(
		1,
		Math.min(
			OUTLINE_SEARCH_LIMITS.maxResults,
			Math.floor(input.limit ?? OUTLINE_SEARCH_LIMITS.defaultResults),
		),
	);
	const hits = await searchOutline({
		query,
		spaceIds: spaces.map((space) => space.id),
		contextSpaceId: scope.session?.id ?? null,
		limit,
	});
	// The header names the first few spaces and counts the rest (a search of every readable
	// space covers up to a hundred): only those are described.
	const described: string[] = [];
	for (const [i, space] of spaces.entries()) {
		described.push(i < OUTLINE_LISTED_NAMES ? await scope.describe(space) : space.key);
	}
	const lines = [note(OUTLINE_TOOL_TEXT.searchHeader(hits.length, query, described))];
	if (cut === "limit") lines.push(note(OUTLINE_TOOL_TEXT.searchedSome(spaces.length)));
	if (cut === "candidates") lines.push(note(OUTLINE_TOOL_TEXT.searchUnchecked));
	if (unknown.length > 0) lines.push(note(OUTLINE_TOOL_TEXT.spacesNotSearched(unknown)));
	for (const hit of hits) {
		const alias = hit.alias ? OUTLINE_TOOL_TEXT.aliasMark(hit.alias) : "";
		lines.push(`- [${hit.address}] ${hit.title || OUTLINE_TOOL_TEXT.untitled}${alias}`);
		const where: string[] = [];
		if (hit.path.length > 0) where.push(OUTLINE_TOOL_TEXT.inPath(hit.path.map((t) => clip(t, 40))));
		if (hit.process) {
			where.push(
				hit.task && hit.task.blockId !== hit.blockId
					? OUTLINE_TOOL_TEXT.underTask(hit.task.address, clip(hit.task.title, 60))
					: hit.task
						? OUTLINE_TOOL_TEXT.isTask
						: OUTLINE_TOOL_TEXT.sessionNotes,
			);
		}
		if (where.length > 0) lines.push(`  ${where.join(" · ")}`);
		if (hit.snippet && plainText(hit.snippet) !== plainText(hit.title)) {
			lines.push(`  “${hit.snippet}”`);
		}
	}
	if (hits.length === 0) {
		lines.push(ownOnly ? OUTLINE_TOOL_TEXT.noResultsOwn : OUTLINE_TOOL_TEXT.noResults);
	}
	const output: OutlineToolOutput = {
		output: lines.join("\n"),
		title: `OutlineSearch: ${clip(query, 60)}`,
		metadata: {
			tool: "OutlineSearch",
			query,
			spaces: keys,
			...(cut !== null ? { complete: false } : {}),
			resultCount: hits.length,
			results: hits.map((hit) => ({
				address: hit.address,
				title: hit.title,
				alias: hit.alias,
				path: hit.path,
				snippet: hit.snippet,
				process: hit.process,
			})),
		},
	};
	return { output, reads: [], spaces };
}
