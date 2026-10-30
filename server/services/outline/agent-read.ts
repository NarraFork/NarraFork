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
 * block line carries the block's short id right after the bullet; within the space that is its
 * address, elsewhere `key/sid`. Links show their targets' current titles where the session may
 * read them (`link-display.ts`). Lines in `‹…›` are notes, never content: an edit that copies a
 * read back drops them, and drops the ids again (`edit-text.ts`).
 *
 * The output is bounded by the read's budget, so the agent loop must not cut it again (its cut
 * keeps the tail and would lose the top of the outline).
 */
import { blockTitle, serializeMarkdownOutline, TASK_BOX } from "@shared/outline";
import { type OutlineAgentScope, spaceRootName } from "./agent-scope";
import { LINK_DISPLAY_LIMITS, linkTitles, withLinkTitles } from "./link-display";
import { OUTLINE_TOOL_TEXT } from "./messages";
import { commitSeqAt, readOutline } from "./read";
import { recordOutlineReads } from "./read-ledger";
import { OUTLINE_READ_LIMITS, type OutlineDisplay, outlineItem } from "./render";
import type { OutlineResolvedBlock } from "./resolve";
import { OUTLINE_SEARCH_LIMITS, searchOutline } from "./search";
import type { OutlineSpaceRow } from "./store/port";
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

export const OUTLINE_AGENT_READ_LIMITS = {
	/** Pages listed per space when a space is read as a whole. */
	maxPagesListed: 100,
	/** UTF-8 bytes of rendered text per block of budget, between the default and the maximum. */
	bytesPerBlock: 256,
	/** Characters of a title in a header, a path or a page list. */
	titleChars: 100,
} as const;

export interface OutlineReadInput {
	/** A block or page; `key/` (or `project/`, `session/`, `personal/`) lists a space's pages. */
	address?: string;
	view?: OutlineView;
	/** Blocks to show at most. */
	budget?: number;
	/** A commit number of the block's space, or a time. */
	asOf?: number | string;
}

export interface OutlineSearchInput {
	query: string;
	/** Space keys or words; the session's own spaces by default. */
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
	const lines = pages.map((page) => {
		const box = page.taskJson ? `[${TASK_BOX[page.taskJson.status]}] ` : "";
		return `- [${page.sid}] ${box}${clip(blockTitle(page.content)) || OUTLINE_TOOL_TEXT.untitled}`;
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
 * Blocks as a current read shows them, each on its own without children: the short id after
 * the bullet, links with their targets' titles where the session may read them. An edit's
 * result shows the blocks it merged this way, so they can be copied back like a read.
 */
export async function blockLinesForAgent(
	scope: OutlineAgentScope,
	nodes: readonly OutlineNode[],
): Promise<Map<string, string>> {
	const display = await displayFor(scope, new Map())({ current: true, seq: 0 }, nodes);
	const out = new Map<string, string>();
	for (const node of nodes) {
		const item = outlineItem(node);
		out.set(
			node.id,
			serializeMarkdownOutline([display?.(node, item) ?? item], { label: () => `[${node.sid}]` }),
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
	const result = await readOutline({
		blockId: block.id,
		view: input.view,
		budget: budgetOf(input.budget),
		asOf,
		label: (node) => `[${node.sid}]`,
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
	const query = input.query.trim();
	const spaces: OutlineSpaceRow[] = [];
	const unknown: string[] = [];
	if (input.spaces && input.spaces.length > 0) {
		for (const raw of input.spaces) {
			const name = raw.trim().replace(/\/$/, "");
			const space = await scope.space(name);
			if (space) spaces.push(space);
			else unknown.push(raw);
		}
	} else {
		for (const own of await scope.ownSpaces()) spaces.push(own.space);
	}
	const keys = spaces.map((space) => space.key);
	if (spaces.length === 0) {
		return {
			output:
				unknown.length > 0
					? OUTLINE_TOOL_TEXT.noSuchSpace(unknown.join(", "))
					: OUTLINE_TOOL_TEXT.noSpaces,
			isError: unknown.length > 0,
			metadata: { tool: "OutlineSearch", query, spaces: [], resultCount: 0, results: [] },
		};
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
	const described: string[] = [];
	for (const space of spaces) described.push(await scope.describe(space));
	const lines = [note(OUTLINE_TOOL_TEXT.searchHeader(hits.length, query, described))];
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
	if (hits.length === 0) lines.push(OUTLINE_TOOL_TEXT.noResults);
	return {
		output: lines.join("\n"),
		title: `OutlineSearch: ${clip(query, 60)}`,
		metadata: {
			tool: "OutlineSearch",
			query,
			spaces: keys,
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
}
