/**
 * A block's subtree as a tree in memory, by the block and its ancestry, now or as of a seq
 * (pageless outline, A2): what the task features read where they read "the page's structure and
 * cut it at the block" before. No page is read, named or returned.
 *
 * WHAT ONE READ COSTS
 * -------------------
 *   - the block's ancestry: ONE recursive statement by primary key, whatever the depth
 *     (`getAncestry`), then the ancestors' structure rows by primary key (now: the blocks; as of
 *     a seq: the versions valid then, one backward seek each);
 *   - the subtree under the block, breadth first, level by level (`listSubtreeAt`), at most
 *     `limit` rows ({@link OUTLINE_BLOCK_TREE_LIMITS.defaultBlocks} by default, at most
 *     {@link OUTLINE_BLOCK_TREE_LIMITS.maxBlocks}); `truncated` when the subtree holds more (the
 *     deepest blocks are the ones missing, and only the parent of the last row read may have
 *     fewer children here than it has).
 *
 * The ancestors are linked to the block (`root.parent` is its nearest ancestor), each with
 * only the next one on the way down among its children: `isUnderTask(root)` and `ancestorsOf`
 * work as on a whole tree, but an ancestor's other children are not read. A reader that needs
 * them (a task's siblings) reads those levels with {@link readChildLevels}.
 *
 * A read as of a seq is refused (`OutlineHistoryUnavailableError`) when the space's placements
 * are not built yet or the seq is below its history floor; a read of the current tree never is.
 */
import { ValidationError } from "@server/lib/errors";
import { compareOrderKeys } from "@shared/outline";
import { OUTLINE_TEXT } from "./messages";
import { OUTLINE_LIMITS } from "./model";
import { type OutlineReadRequest, type OutlineTreeReadResult, renderSubtreeRead } from "./read";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineStructureRow } from "./store/read-port";
import { ancestorsOf, buildTree, type OutlineNode } from "./tree";

export const OUTLINE_BLOCK_TREE_LIMITS = {
	/** Blocks under the root one read takes by default. */
	defaultBlocks: 800,
	/** At most (a plan's submission and diff read up to 2,000 blocks and one more). */
	maxBlocks: 2001,
	/** Rows one read of child levels takes in all. */
	childRows: 800,
} as const;

/** What `loadBodies` needs, and the space and seq the tree is as of. */
export interface OutlineTreeState {
	space: OutlineSpaceRow;
	/** The seq the tree is as of (for a current read, the space's last commit when it started). */
	seq: number;
	/** Read from the current rows rather than from history. */
	current: boolean;
	/** Every block read, by id: the ancestors, the root and what is under it. */
	nodes: Map<string, OutlineNode>;
	/** The subtree holds more blocks than were read. */
	truncated: boolean;
}

export interface OutlineBlockTree {
	state: OutlineTreeState;
	root: OutlineNode;
	/** The root's ancestors, the top-level block first. */
	path: OutlineNode[];
}

function readSeq(space: OutlineSpaceRow, asOf: number | undefined): number | null {
	if (asOf === undefined) return null;
	if (!Number.isSafeInteger(asOf) || asOf < 0)
		throw new ValidationError(OUTLINE_TEXT.errors.badSeq("asOf"));
	return Math.min(asOf, space.nextSeq - 1);
}

function clampLimit(limit: number | undefined): number {
	const max = OUTLINE_BLOCK_TREE_LIMITS.maxBlocks;
	if (limit === undefined || !Number.isFinite(limit))
		return OUTLINE_BLOCK_TREE_LIMITS.defaultBlocks;
	return Math.max(0, Math.min(max, Math.floor(limit)));
}

/**
 * The structure rows of a block and its ancestors (the block first, then nearest first), as the
 * tree is now or was at `seq`. Null when the block is not a live block of the space then.
 */
async function chainRows(
	store: OutlineStore,
	spaceId: string,
	blockId: string,
	seq: number | null,
): Promise<OutlineStructureRow[] | null> {
	const ancestry = await store.getAncestry(spaceId, blockId, {
		asOf: seq,
		maxDepth: OUTLINE_LIMITS.maxDepth,
	});
	if (!ancestry || ancestry.length === 0) return null;
	const ids = ancestry.map((row) => row.id);
	if (seq === null) {
		const metas = new Map(
			(await store.getBlockMetasByIds(ids)).map((meta) => [meta.id, meta] as const),
		);
		const rows: OutlineStructureRow[] = [];
		for (const id of ids) {
			const meta = metas.get(id);
			if (!meta || meta.deleted || meta.spaceId !== spaceId) return null;
			rows.push({
				id: meta.id,
				sid: meta.sid,
				parentId: meta.parentId,
				orderKey: meta.orderKey,
				alias: meta.alias,
				taskJson: meta.taskJson,
				askJson: meta.askJson,
				versionSeq: meta.versionSeq,
			});
		}
		return rows;
	}
	const versions = new Map(
		(
			await store.listVersionMetasAt(
				ids.map((id) => ({ blockId: id, seq })),
				{ withAsk: true },
			)
		).map((v) => [v.blockId, v] as const),
	);
	const placements = new Map(
		(await store.getPlacementsAt(spaceId, ids, seq)).map((p) => [p.blockId, p] as const),
	);
	const sids = new Map(ancestry.map((row) => [row.id, row.sid] as const));
	const rows: OutlineStructureRow[] = [];
	for (const id of ids) {
		const version = versions.get(id);
		if (!version || version.deleted) return null;
		rows.push({
			id,
			sid: sids.get(id) as string,
			parentId: version.parentId,
			orderKey: placements.get(id)?.orderKey ?? "",
			alias: null,
			taskJson: version.taskJson,
			askJson: version.askJson,
			versionSeq: version.fromSeq,
		});
	}
	// The alias of a version is not in its meta; a reader of the past needs none of the path's.
	return rows;
}

/**
 * A block, its ancestors and its subtree (see the module header), now or as of `asOf`. Null when
 * the block is not a live block (then).
 */
export async function readBlockSubtree(
	blockId: string,
	options: { asOf?: number; limit?: number; store?: OutlineStore } = {},
): Promise<OutlineBlockTree | null> {
	const store = options.store ?? outlineStore;
	const block = (await store.getBlockMetasByIds([blockId]))[0];
	if (!block) return null;
	const space = await store.getSpace(block.spaceId);
	if (!space) return null;
	const seq = readSeq(space, options.asOf);
	if (seq === null && block.deleted) return null;
	const chain = await chainRows(store, space.id, blockId, seq);
	if (!chain) return null;
	const { rows, truncated } = await store.listSubtreeAt(space.id, blockId, {
		asOf: seq,
		limit: clampLimit(options.limit),
	});
	// The chain first: a row under the root that names an ancestor's id cannot be (a tree), but
	// the root's own row must be the chain's, with the parent it has on the way up.
	const nodes = buildTree([...chain.slice().reverse(), ...rows]);
	const root = nodes.get(blockId);
	if (!root) return null;
	return {
		state: { space, seq: seq ?? space.nextSeq - 1, current: seq === null, nodes, truncated },
		root,
		path: ancestorsOf(root),
	};
}

/**
 * Read the whole child levels of some nodes of `tree` (ancestors, typically: a task's siblings
 * under the task above it), at most {@link OUTLINE_BLOCK_TREE_LIMITS.childRows} rows in all, and
 * link them in sibling order. A child the tree holds already is kept as it is (with what was read
 * under it); the others come without their own children. Returns whether every level was read
 * whole.
 */
export async function readChildLevels(
	tree: OutlineBlockTree,
	parents: readonly OutlineNode[],
	options: { store?: OutlineStore; limit?: number } = {},
): Promise<boolean> {
	const store = options.store ?? outlineStore;
	const { state } = tree;
	const wanted = [...new Set(parents.map((node) => node.id))];
	if (wanted.length === 0) return true;
	const found = await store.listLevels(state.space.id, wanted, {
		asOf: state.current ? null : state.seq,
		limit: Math.min(
			options.limit ?? OUTLINE_BLOCK_TREE_LIMITS.childRows,
			OUTLINE_BLOCK_TREE_LIMITS.childRows,
		),
	});
	const fresh = buildTree(found.rows.filter((row) => !state.nodes.has(row.id)));
	const byParent = new Map<string, OutlineNode[]>();
	for (const row of found.rows) {
		const node = state.nodes.get(row.id) ?? fresh.get(row.id);
		if (!node || row.parentId === null) continue;
		const list = byParent.get(row.parentId);
		if (list) list.push(node);
		else byParent.set(row.parentId, [node]);
	}
	for (const [parentId, children] of byParent) {
		const parent = state.nodes.get(parentId);
		if (!parent) continue;
		for (const child of children) {
			child.parent = parent;
			if (!state.nodes.has(child.id)) state.nodes.set(child.id, child);
		}
		// `listLevels` gives each parent's children in sibling order; a child the tree held that a
		// cut level left out stays (the way down to the root never breaks).
		const kept = parent.children.filter((child) => !children.includes(child));
		parent.children =
			kept.length === 0
				? children
				: [...children, ...kept].sort(
						(a, b) =>
							compareOrderKeys(a.orderKey, b.orderKey) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
					);
	}
	return !found.truncated;
}

/**
 * A block and its subtree as a markdown outline, read by block (see the module header) and
 * rendered as `readOutline` renders: the facts view by default, breadth first within the budget.
 * Null when the block is not live (at `asOf`). `limit`: blocks under the root read (default
 * {@link OUTLINE_BLOCK_TREE_LIMITS.defaultBlocks}); past them the read says it is truncated.
 */
export async function readBlockOutline(
	request: OutlineReadRequest & { limit?: number },
): Promise<OutlineTreeReadResult | null> {
	const { blockId, asOf, limit, ...rest } = request;
	const tree = await readBlockSubtree(blockId, {
		...(asOf !== undefined ? { asOf } : {}),
		...(limit !== undefined ? { limit } : {}),
		store: request.store,
	});
	return tree ? await renderSubtreeRead(tree, rest) : null;
}

/** Blocks read walking up for {@link documentOrderKeys}, all spaces together. */
export const OUTLINE_DOCUMENT_ORDER_WALK_ROWS = 2000;

/**
 * Where each block sits in its space's document order: the order keys from its top-level
 * ancestor down to itself (the space and the id come after, as the caller sorts). One ancestry
 * walk per space (one recursive statement per 500 blocks, by primary key, at most
 * {@link OUTLINE_DOCUMENT_ORDER_WALK_ROWS} rows in all) and the ancestors' rows by primary key. A
 * block whose way up is not known (deleted, or past the walk) gets its own key alone.
 */
export async function documentOrderKeys(
	blocks: ReadonlyArray<{ id: string; spaceId: string; orderKey: string }>,
	options: { store?: OutlineStore } = {},
): Promise<Map<string, string[]>> {
	const store = options.store ?? outlineStore;
	const out = new Map<string, string[]>();
	const bySpace = new Map<string, string[]>();
	for (const block of blocks) {
		out.set(block.id, [block.orderKey]);
		bySpace.set(block.spaceId, [...(bySpace.get(block.spaceId) ?? []), block.id]);
	}
	let left = OUTLINE_DOCUMENT_ORDER_WALK_ROWS;
	for (const [spaceId, ids] of bySpace) {
		if (left <= 0) break;
		const walk = await store.listAncestryOf(spaceId, ids, left);
		left -= walk.rows.length;
		const parentOf = new Map(walk.rows.map((row) => [row.id, row.parentId] as const));
		const keys = new Map(
			(await store.getBlockMetasByIds([...parentOf.keys()])).map(
				(meta) => [meta.id, meta.orderKey] as const,
			),
		);
		for (const id of ids) {
			const path: string[] = [];
			let at: string | null = id;
			for (let depth = 0; at !== null && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
				const key = keys.get(at);
				if (key === undefined || !parentOf.has(at)) break;
				path.unshift(key);
				at = parentOf.get(at) ?? null;
				if (at === null) out.set(id, path);
			}
		}
	}
	return out;
}

/** Compare two {@link documentOrderKeys} paths: the document order (a parent before its children). */
export function compareDocumentOrder(a: readonly string[], b: readonly string[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const order = compareOrderKeys(a[i] as string, b[i] as string);
		if (order !== 0) return order;
	}
	return a.length - b.length;
}
