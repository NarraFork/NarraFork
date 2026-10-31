/**
 * `OutlineRead` and `OutlineSearch`: what an agent gets back, as text it can act on.
 *
 * HOW A READ LOOKS
 * ----------------
 *   ‹space Kx81mPqa · this session's project "NarraFork" · in Auth module›
 *   - [Pq83nXcB] Token refresh has a race; see [[Lm29XkQa/Rt5uVw7Y|Session notes]]
 *     - [Ab3dEf9Q] [ ] Add a regression test @agent:w-auth
 *     ‹… 3 more›
 *   ‹facts only: 6 blocks under tasks not shown; read with view "all" to include them›
 *
 * The first line names the space once (its key and what it is) and where the block sits. Every
 * block line carries the block's address right after the bullet: its short id in one of the
 * session's own spaces (where a bare id is looked up), `key/sid` in any other space it may read.
 * Links show their targets' current titles where the session may read them (`link-display.ts`);
 * a link to anything else shows no title, whether its target is unreadable or does not exist,
 * and is never expanded. Lines in `‹…›` are notes, never content: an edit that copies a read
 * back drops them, and drops the ids again (`edit-text.ts`).
 *
 * READING ACROSS SPACES
 * ---------------------
 * Every space the session may read (`session-scope.ts`) can be read and searched: by key,
 * through the overview of all of them (`OutlineRead` with address `*`: each space's pages,
 * expanded level by level within one budget, the session's own spaces first), or by searching
 * them all (`OutlineSearch` with spaces `["*"]`; the readable set goes into the SQL filter before
 * the result limit). A space it may not read is never named, listed or searched, and a reference
 * into one gets exactly the answer a reference to nothing gets. Reads of other spaces are
 * recorded in the read ledger like any other. The overview and searches span several turns of
 * the event loop: an access change meanwhile makes them start again (`stableAnswer`), so they
 * never show what the session may no longer read.
 *
 * The output is bounded by the read's budget, so the agent loop must not cut it again (its cut
 * keeps the tail and would lose the top of the outline).
 */
import { blockTitle, serializeMarkdownOutline, TASK_BOX } from "@shared/outline";
import { type OutlineAgentScope, type OutlineSpaceWord, spaceRootName } from "./agent-scope";
import { LINK_DISPLAY_LIMITS, linkTitles, withLinkTitles } from "./link-display";
import { OUTLINE_LISTED_NAMES, OUTLINE_TOOL_TEXT } from "./messages";
import { commitSeqAt, loadBodiesWithin, readOutline } from "./read";
import { recordOutlineReads } from "./read-ledger";
import {
	clampBudget,
	OUTLINE_READ_LIMITS,
	type OutlineDisplay,
	type OutlineRenderSection,
	outlineItem,
	renderOutlineSections,
	sectionsBreadthFirst,
} from "./render";
import type { OutlineResolvedBlock } from "./resolve";
import { OUTLINE_SEARCH_LIMITS, searchOutline } from "./search";
import { sessionScopeEpoch, yieldToEventLoop } from "./session-scope";
import type { OutlineBlockMeta, OutlineSpaceRow } from "./store/port";
import type { OutlinePageListRow, OutlineStructureRow } from "./store/read-port";
import { buildTree, type OutlineNode, type OutlineView } from "./tree";

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
	/** Pages listed per space when a space is read as a whole, or taken into the overview. */
	maxPagesListed: 100,
	/** UTF-8 bytes of rendered text per block of budget, between the default and the maximum. */
	bytesPerBlock: 256,
	/** Characters of a title in a header, a path or a page list. */
	titleChars: 100,
	/** Spaces the overview of every readable space covers. */
	overviewSpaces: 50,
	/** Pages one structure read of the overview covers. */
	overviewPagesPerRead: 500,
	/** Blocks one structure read of the overview returns; a page with more is shown alone. */
	overviewBlocksPerRead: 2000,
	/** Blocks the overview's structure reads return in all. */
	overviewBlocks: 10_000,
	/** Structure reads one overview makes at most. */
	overviewReads: 10,
	/** Spaces whose pages the overview lists between two yields to the event loop. */
	overviewSpacesPerSlice: 10,
	/** Spaces a search of every readable space covers. */
	searchAllSpaces: 100,
};

/** The address that reads the overview of every space the session may read. */
export const OUTLINE_ALL_SPACES = "*";

export interface OutlineReadInput {
	/**
	 * A block or page; `key/` (or `project/`, `session/`, `personal/`) lists a space's pages;
	 * `*` is the overview of every space the session may read.
	 */
	address?: string;
	view?: OutlineView;
	/** Blocks to show at most. */
	budget?: number;
	/** A commit number of the block's space, or a time. */
	asOf?: number | string;
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

function budgetOf(blocks: number | undefined): { blocks: number; bytes: number } | undefined {
	if (blocks === undefined || !Number.isFinite(blocks)) return undefined;
	const n = Math.max(1, Math.min(OUTLINE_READ_LIMITS.maxBlocks, Math.floor(blocks)));
	return {
		blocks: n,
		bytes: Math.max(
			OUTLINE_READ_LIMITS.defaultBudget.bytes,
			Math.min(OUTLINE_READ_LIMITS.maxBytes, n * OUTLINE_AGENT_READ_LIMITS.bytesPerBlock),
		),
	};
}

/** A space's pages as outline lines, each with its short id. */
async function pageLines(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
): Promise<{ lines: string[]; more: boolean; count: number }> {
	const limit = OUTLINE_AGENT_READ_LIMITS.maxPagesListed;
	const rows = await scope.store.listChildren(space.id, null, limit + 1);
	const pages = rows.slice(0, limit);
	// Only titles, clipped: not a read of the pages (their edits need one).
	const label = scope.labelIn(space);
	const lines = pages.map((page) => {
		const box = page.taskJson ? `[${TASK_BOX[page.taskJson.status]}] ` : "";
		return `- ${label(page.sid)} ${box}${clip(blockTitle(page.content)) || OUTLINE_TOOL_TEXT.untitled}`;
	});
	return { lines, more: rows.length > limit, count: pages.length };
}

async function spaceSection(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	isDefault: boolean,
): Promise<{ lines: string[]; count: number }> {
	const pages = await pageLines(scope, space);
	const lines = [note(OUTLINE_TOOL_TEXT.spaceSection(await scope.describe(space), isDefault))];
	if (pages.lines.length === 0) lines.push(note(OUTLINE_TOOL_TEXT.noPages));
	lines.push(...pages.lines);
	if (pages.more) lines.push(note(OUTLINE_TOOL_TEXT.morePages));
	return { lines, count: pages.count };
}

/** `OutlineRead` with no address: the session's own spaces and their pages. */
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
		spaces.push({ key: space.key, kind: space.kind, word, pages: section.count });
	}
	lines.push(note(OUTLINE_TOOL_TEXT.writeHint));
	return {
		output: lines.join("\n"),
		title: "OutlineRead",
		metadata: { tool: "OutlineRead", spaces },
	};
}

/** A page's node on its own, content not loaded yet (its tags load with it). */
function pageNode(meta: OutlineBlockMeta): OutlineNode {
	return {
		id: meta.id,
		sid: meta.sid,
		parentId: null,
		orderKey: meta.orderKey,
		alias: meta.alias,
		task: meta.taskJson,
		versionSeq: meta.versionSeq,
		parent: null,
		children: [],
		content: null,
		tags: null,
	};
}

/** One space of the overview, before rendering. */
interface OverviewSpace {
	space: OutlineSpaceRow;
	word: OutlineSpaceWord | null;
	own: boolean;
	header: string[];
	/** Pages the view shows, in sibling order, as listed (titles only so far). */
	pages: OutlinePageListRow[];
	/** The space has more pages than one list takes. */
	listCut: boolean;
	/** Pages that are tasks, left out by the facts view. */
	taskPages: number;
	/** Another session's notes in the facts view: only counted. */
	process?: { pages: number; more: boolean };
	/** Pages the budget could show: the first this many of `pages`. */
	showable: number;
}

/**
 * The structure of the pages the overview may show, many pages per read, in the order the
 * budget takes them: whole pages by id; `large`, pages with more blocks than one read returns;
 * `unread`, pages past what the overview reads in all. Bounded by
 * {@link OUTLINE_AGENT_READ_LIMITS}: rows per read, rows and reads in all; yields between reads.
 */
async function overviewStructure(
	scope: OutlineAgentScope,
	pageIds: readonly string[],
): Promise<{
	loaded: Map<string, OutlineStructureRow[]>;
	large: Set<string>;
	unread: Set<string>;
}> {
	const limits = OUTLINE_AGENT_READ_LIMITS;
	const loaded = new Map<string, OutlineStructureRow[]>();
	const large = new Set<string>();
	let queue = [...pageIds];
	let rowsLeft = limits.overviewBlocks;
	let reads = 0;
	while (queue.length > 0 && rowsLeft > 0 && reads < limits.overviewReads) {
		if (reads > 0) await yieldToEventLoop();
		const batch = queue.slice(0, limits.overviewPagesPerRead);
		const limit = Math.min(limits.overviewBlocksPerRead, rowsLeft);
		const { rows, truncated } = await scope.store.listPagesStructure(batch, limit);
		reads++;
		rowsLeft -= rows.length;
		const byPage = new Map<string, OutlineStructureRow[]>();
		for (const row of rows) {
			const list = byPage.get(row.pageId);
			if (list) list.push(row);
			else byPage.set(row.pageId, [row]);
		}
		// Rows come page by page: when the read was cut, only its last page may be short.
		const cutPage = truncated ? rows[rows.length - 1]?.pageId : undefined;
		const again: string[] = [];
		for (const id of batch) {
			const rowsOfPage = byPage.get(id);
			if (rowsOfPage && id !== cutPage) loaded.set(id, rowsOfPage);
			else if (id === cutPage && byPage.size === 1 && limit === limits.overviewBlocksPerRead) {
				large.add(id);
			} else if (truncated) again.push(id);
			// Otherwise the page has no live blocks any more: left out.
		}
		queue = [...again, ...queue.slice(batch.length)];
	}
	return { loaded, large, unread: new Set(queue) };
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
 * {@link OUTLINE_AGENT_READ_LIMITS.overviewSpaces}), each with its pages, expanded together
 * within the read's budget (`renderOutlineSections`, round-robin across spaces): first the
 * page lines of every space, then, with what the budget has left, the next level of all of
 * them, and so on. Facts only by default: tasks are left out, and so are other sessions' notes,
 * which are process as a whole (design §2.1): such a space shows as its line and the number of
 * its pages; view `all` lists them.
 *
 * Bounded: one page list per space (titles only, at most 100 pages); the structure of the pages
 * the budget could show (round-robin, at most its number of blocks) in a few batched reads
 * ({@link overviewStructure}); content loaded only for what fits. A page whose structure was not
 * read shows on its own, and the space says so. What it shows is a read: recorded in the
 * ledger, links titled where the session may read them.
 */
async function overviewAnswer(
	scope: OutlineAgentScope,
	input: OutlineReadInput,
): Promise<ScopedAnswer> {
	const meta: Record<string, unknown> = { tool: "OutlineRead", address: OUTLINE_ALL_SPACES };
	if (input.asOf !== undefined) {
		return {
			output: { output: OUTLINE_TOOL_TEXT.overviewNotAsOf, isError: true, metadata: meta },
			reads: [],
			spaces: [],
		};
	}
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
	const budget = clampBudget(budgetOf(input.budget));
	const context = await scope.contextSpace();

	// 1. Every space's pages, titles only: one statement per space.
	const plans: OverviewSpace[] = [];
	for (const [i, { space, word }] of spaces.entries()) {
		if (i > 0 && i % limits.overviewSpacesPerSlice === 0) await yieldToEventLoop();
		const own = scope.isOwnSpace(space);
		const header = [
			note(OUTLINE_TOOL_TEXT.spaceSection(await scope.describe(space), space.id === context?.id)),
		];
		const plan = { space, word, own, header, listCut: false, taskPages: 0, showable: 0 };
		if (view === "facts" && space.kind === "session" && !own) {
			// Another session's notes are process: counted, not listed (metas only, bounded).
			const max = limits.maxPagesListed;
			const count = (await scope.store.listChildMetas(space.id, [null], max + 1)).length;
			plans.push({
				...plan,
				pages: [],
				process: { pages: Math.min(count, max), more: count > max },
			});
			continue;
		}
		// Pages that are tasks are listed but take nothing from the budget in the facts view.
		const max = limits.maxPagesListed;
		const listed = await scope.store.listSpacePages(space.id, { limit: max + 1 });
		const taken = listed.slice(0, max);
		const pages = view === "facts" ? taken.filter((page) => !page.isTask) : taken;
		plans.push({
			...plan,
			pages,
			listCut: listed.length > max,
			taskPages: taken.length - pages.length,
		});
	}

	// 2. The pages the budget could show, taken round-robin across spaces as the render takes
	// them, and their structure.
	const order: OutlinePageListRow[] = [];
	for (let i = 0; order.length < budget.blocks; i++) {
		let more = false;
		for (const plan of plans) {
			const page = plan.pages[i];
			if (!page || order.length >= budget.blocks) continue;
			order.push(page);
			plan.showable++;
			more = true;
		}
		if (!more) break;
	}
	const { loaded, large, unread } = await overviewStructure(
		scope,
		order.map((page) => page.id),
	);

	// 3. Page trees (a page whose structure was not read, alone), and the sections.
	const sections: OutlineRenderSection[] = [];
	const rootsOf = new Map<OverviewSpace, OutlineNode[]>();
	let truncated = cut !== null;
	for (const plan of plans) {
		const { space } = plan;
		const label = scope.labelIn(space);
		const shownPages = plan.pages.slice(0, plan.showable);
		const alone = shownPages.filter((page) => !loaded.has(page.id)).map((page) => page.id);
		const metas = new Map(
			alone.length === 0
				? []
				: (await scope.store.getBlockMetas(space.id, { ids: alone })).map((m) => [m.id, m]),
		);
		const roots: OutlineNode[] = [];
		const tooLarge: string[] = [];
		const pastLimit: string[] = [];
		for (const page of shownPages) {
			const rows = loaded.get(page.id);
			if (rows) {
				const root = buildTree(rows).get(page.id);
				if (root && root.parentId === null) roots.push(root);
				continue;
			}
			const m = metas.get(page.id);
			if (!m || m.deleted || m.parentId !== null) continue;
			roots.push(pageNode(m));
			if (large.has(page.id)) tooLarge.push(label(m.sid));
			else if (unread.has(page.id)) pastLimit.push(label(m.sid));
		}
		rootsOf.set(plan, roots);
		const footer: string[] = [];
		if (plan.process) {
			footer.push(
				note(
					plan.process.pages === 0
						? OUTLINE_TOOL_TEXT.noPages
						: OUTLINE_TOOL_TEXT.otherSessionPages(plan.process.pages, plan.process.more),
				),
			);
		} else if (plan.pages.length === 0 && plan.taskPages === 0 && !plan.listCut) {
			footer.push(note(OUTLINE_TOOL_TEXT.noPages));
		}
		if (tooLarge.length > 0) footer.push(note(OUTLINE_TOOL_TEXT.notExpandedLarge(tooLarge)));
		if (pastLimit.length > 0) footer.push(note(OUTLINE_TOOL_TEXT.notExpandedLimit(pastLimit)));
		const notTaken = plan.pages.length - plan.showable;
		truncated ||= plan.listCut || notTaken > 0 || tooLarge.length > 0 || pastLimit.length > 0;
		sections.push({
			header: plan.header,
			roots,
			label: (node) => label(node.sid),
			footer,
			moreTops: (hidden) => {
				const pages = hidden.roots + notTaken;
				return pages === 0 && !plan.listCut
					? null
					: note(OUTLINE_TOOL_TEXT.morePagesOf(space.key, pages, plan.listCut));
			},
		});
	}

	// 4. Content in the order the render spends the budget, then the render: each a stretch of
	// the main thread of its own (a render of 2000 blocks takes some tens of milliseconds).
	await yieldToEventLoop();
	const state = { current: true, seq: 0 };
	const loadOrder = sectionsBreadthFirst(sections, {
		view,
		interleave: true,
		limit: budget.blocks,
	});
	await loadBodiesWithin(state, loadOrder, budget.bytes, { store: scope.store });
	await yieldToEventLoop();
	const seen = new Map<string, number>();
	const display = await displayFor(scope, seen)(
		state,
		loadOrder.filter((node) => node.content !== null),
	);
	await yieldToEventLoop();
	const taskPages = plans.reduce((sum, plan) => sum + plan.taskPages, 0);
	const notes: string[] = [];
	if (taskPages > 0) notes.push(note(OUTLINE_TOOL_TEXT.taskPagesHidden(taskPages)));
	if (cut === "limit") notes.push(note(OUTLINE_TOOL_TEXT.moreSpaces));
	if (cut === "candidates") notes.push(note(OUTLINE_TOOL_TEXT.spacesUnchecked));
	const rendered = renderOutlineSections(sections, {
		view,
		budget,
		display,
		notes,
		interleave: true,
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
			spaces: plans.map((plan) => ({
				key: plan.space.key,
				kind: plan.space.kind,
				word: plan.word,
				own: plan.own,
				pages: plan.process
					? plan.process.pages
					: (rootsOf.get(plan) ?? []).filter((root) => shownIds.has(root.id)).length,
				...(plan.process ? { process: true } : {}),
			})),
			complete: cut === null,
			view: rendered.view,
			blocks: rendered.blockIds.length,
			hiddenByBudget: rendered.hiddenByBudget,
			hiddenByView: rendered.hiddenByView + taskPages,
			truncated: truncated || rendered.hiddenByBudget > 0,
		},
	};
	return { output, reads, spaces: plans.map((plan) => plan.space) };
}

async function readSpace(scope: OutlineAgentScope, name: string): Promise<OutlineToolOutput> {
	const space = name === "" ? await scope.contextSpace() : await scope.space(name);
	if (!space) {
		return {
			output: OUTLINE_TOOL_TEXT.noSuchSpace(name || "/"),
			isError: true,
			metadata: { tool: "OutlineRead", address: `${name}/` },
		};
	}
	const context = await scope.contextSpace();
	const section = await spaceSection(scope, space, space.id === context?.id);
	return {
		output: section.lines.join("\n"),
		title: `OutlineRead: ${space.key}/`,
		metadata: {
			tool: "OutlineRead",
			address: `${space.key}/`,
			space: { key: space.key, kind: space.kind },
			blocks: section.count,
		},
	};
}

function candidateLines(candidates: readonly OutlineResolvedBlock[]): string[] {
	return candidates.map(
		(c) =>
			`- [${c.address}] ${clip(c.title) || OUTLINE_TOOL_TEXT.untitled}${
				c.isPage ? OUTLINE_TOOL_TEXT.pageMark : ""
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

export async function outlineRead(
	scope: OutlineAgentScope,
	input: OutlineReadInput,
): Promise<OutlineToolOutput> {
	const address = input.address?.trim() ?? "";
	if (address === "") return await readOverview(scope);
	if (address === OUTLINE_ALL_SPACES) {
		return await stableAnswer(scope, (current) => overviewAnswer(current, input));
	}
	const root = spaceRootName(address);
	if (root !== null) return await readSpace(scope, root);

	const resolution = await scope.resolve(address);
	if (resolution.status === "not_found") {
		return {
			output: OUTLINE_TOOL_TEXT.notFound(address),
			isError: true,
			metadata: { tool: "OutlineRead", address },
		};
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
	if (!space) {
		return {
			output: OUTLINE_TOOL_TEXT.notFound(address),
			isError: true,
			metadata: { tool: "OutlineRead", address },
		};
	}
	let asOf: number | undefined;
	if (input.asOf !== undefined) {
		const seq = await readSeq(space, input.asOf);
		if (typeof seq !== "number") {
			return { output: seq.error, isError: true, metadata: { tool: "OutlineRead", address } };
		}
		asOf = seq;
	}
	const seen = new Map<string, number>();
	const label = scope.labelIn(space);
	const result = await readOutline({
		blockId: block.id,
		view: input.view,
		budget: budgetOf(input.budget),
		asOf,
		label: (node) => label(node.sid),
		display: displayFor(scope, seen),
	});
	if (!result) {
		return {
			output:
				asOf === undefined
					? OUTLINE_TOOL_TEXT.deleted(block.address)
					: OUTLINE_TOOL_TEXT.notAtSeq(block.address, asOf),
			isError: true,
			metadata: { tool: "OutlineRead", address: block.address },
		};
	}
	if (result.current) {
		recordOutlineReads(
			scope.narratorId,
			result.blockIds.flatMap((id) => {
				const version = seen.get(id);
				return version === undefined ? [] : [[id, version] as const];
			}),
		);
	}
	const path = result.path.map((p) => clip(p.title, 40) || OUTLINE_TOOL_TEXT.untitled);
	const header = note(
		OUTLINE_TOOL_TEXT.readHeader(
			await scope.describe(space),
			path,
			result.current ? null : result.seq,
		),
	);
	const output = `${header}\n${result.markdown}`;
	return {
		output,
		title: `OutlineRead: ${clip(blockTitle(block.title), 60) || block.address}`,
		bounded: true,
		metadata: {
			tool: "OutlineRead",
			address: block.address,
			space: { key: space.key, kind: space.kind },
			rootId: result.rootId,
			pageId: result.pageId,
			view: result.view,
			blocks: result.blockIds.length,
			hiddenByBudget: result.hiddenByBudget,
			hiddenByView: result.hiddenByView,
			truncated: result.truncated,
			...(result.current ? {} : { asOf: result.seq }),
		},
	};
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
