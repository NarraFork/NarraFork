/**
 * The outline reads that know no page (pageless outline, H2), mounted inside the outline routes
 * at `/api/outline` (so `outline.enabled` off answers 404 here too). The page-keyed reads of
 * `routes/outline.ts` stay beside them until their callers have moved.
 *
 *   - `GET /spaces/:spaceId/subtree`, `GET /spaces/:spaceId/blocks/:blockId/subtree`: the
 *     space, or a block, and what is under it, breadth first within a budget.
 *   - `GET /spaces/:spaceId/children`: the children of the parents named, each level from its
 *     cursor: what opening rows of a loaded tree asks for.
 *   - `GET /spaces/:spaceId/marks`: what is under each of the blocks named (open questions,
 *     open tasks, locks, changes waiting), and whether anything there changed since a seq.
 *   - `GET /spaces/:spaceId/changed-children`: the children of a parent that differ between
 *     two seqs.
 *   - `GET /spaces/:spaceId/commits`, `GET /spaces/:spaceId/blocks/:blockId/commits`: the
 *     timeline of the space, or of a block and what was under it.
 *
 * ACCESS: exactly the page reads'. Every route names its space, and a space the person may not
 * read answers 404, the same as one that does not exist. A block named in the PATH must be a
 * block of that space (live or deleted: history may name it), 404 otherwise. Blocks named in
 * the QUERY (`parents`, `keys`, `parent`) are not looked up for the caller: every store read
 * is scoped to the space, so a block of another space has no children, no marks and no changes
 * here, exactly like an id that names nothing, and no route returns a block of another space.
 * Access is today's, also for a read as of an older seq.
 *
 * A read of history the space cannot answer (it is still being prepared, or the seq is older
 * than the history kept) is a 409 with a code and the history floor
 * (`services/outline/subtree-errors.ts`); reads of the current tree are never refused.
 */
import { OUTLINE_VIEW_STATE_LIMITS, type OutlineLockView } from "@shared/outline-api";
import type {
	OutlineChangedChildrenResponse,
	OutlineLevelsResponse,
	OutlineMarksResponse,
	OutlineSubtreeResponse,
	OutlineSubtreeTimelineResponse,
	OutlineTreeBlock,
} from "@shared/outline-subtree-api";
import { type Context, Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors";
import { outlineIdSchema } from "../lib/validators/outline/index";
import {
	outlineChangedChildrenQuerySchema,
	outlineLevelsQuerySchema,
	outlineMarksQuerySchema,
	outlineSubtreeQuerySchema,
	outlineSubtreeTimelineQuerySchema,
} from "../lib/validators/outline/subtree";
import {
	canManageSpace,
	canReadSpace,
	narratorVisibility,
	type OutlinePrincipal,
} from "../services/outline/access";
import { commitSeqAt } from "../services/outline/read";
import { outlineStore } from "../services/outline/store";
import type { OutlineBlockRow, OutlineSpaceRow } from "../services/outline/store/port";
import {
	readOutlineChangedChildren,
	readOutlineSubtreeTimeline,
} from "../services/outline/subtree-history";
import { readOutlineMarks } from "../services/outline/subtree-marks";
import { readOutlineLevels, readOutlineSubtree } from "../services/outline/subtree-read";
import { normalizeFolding } from "../services/outline/view-state";

export const outlineSubtreeRoutes = new Hono();

function principalOf(c: Context): OutlinePrincipal {
	const user = c.get("user");
	return { userId: user.sub, isAdmin: user.role === "admin" };
}

function parse<T>(
	schema: {
		safeParse(input: unknown): { success: true; data: T } | { success: false; error: Error };
	},
	input: unknown,
): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

function idParam(c: Context, name: string): string {
	return parse(outlineIdSchema, c.req.param(name));
}

/** The space, if the person may read it; 404 otherwise, whether or not it exists. */
async function readableSpace(c: Context): Promise<OutlineSpaceRow> {
	const spaceId = idParam(c, "spaceId");
	const space = await outlineStore.getSpace(spaceId);
	if (!space || !(await canReadSpace(principalOf(c), space)))
		throw new NotFoundError("Outline space", spaceId);
	return space;
}

/** A block of a readable space, live or deleted; 404 otherwise. */
async function readableBlock(
	c: Context,
): Promise<{ space: OutlineSpaceRow; block: OutlineBlockRow }> {
	const space = await readableSpace(c);
	const blockId = idParam(c, "blockId");
	const block = await outlineStore.getBlock(blockId);
	if (!block || block.spaceId !== space.id) throw new NotFoundError("Outline block", blockId);
	return { space, block };
}

/** Whether the caller may unlock each lock shown: the locker, a manager of the space, an admin. */
async function decideUnlocks(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
	blocks: readonly OutlineTreeBlock[],
): Promise<void> {
	const locks = blocks.flatMap((block) => (block.lock ? [block.lock] : []));
	if (locks.length === 0) return;
	const manages = await canManageSpace(principal, space);
	for (const lock of locks as OutlineLockView[]) {
		lock.canUnlock =
			principal.isAdmin || manages || (lock.by.kind === "human" && lock.by.id === principal.userId);
	}
}

async function seqOf(
	space: OutlineSpaceRow,
	query: { asOf?: number; at?: string },
): Promise<number | undefined> {
	return query.at !== undefined ? await commitSeqAt(space.id, query.at) : query.asOf;
}

async function subtree(
	c: Context,
	space: OutlineSpaceRow,
	root: OutlineBlockRow | null,
): Promise<Response> {
	const principal = principalOf(c);
	const query = parse(outlineSubtreeQuerySchema, c.req.query());
	let fold: { expanded: ReadonlySet<string>; collapsed: ReadonlySet<string> } | undefined;
	if (query.fold === "default") {
		// The reader's own folding is stored per page until blocks get their own (F1): that of
		// the page the root is on. Theirs alone; reading it needs no more than reading the block.
		const stored = root ? await outlineStore.getViewState(principal.userId, root.pageId) : null;
		const folding = normalizeFolding({
			collapsed: stored?.collapsed ?? [],
			expanded: stored?.expanded ?? [],
		});
		fold = {
			expanded: new Set(folding.expanded.slice(0, OUTLINE_VIEW_STATE_LIMITS.maxCollapsed)),
			collapsed: new Set(folding.collapsed.slice(0, OUTLINE_VIEW_STATE_LIMITS.maxCollapsed)),
		};
	}
	const result = await readOutlineSubtree({
		space,
		rootId: root?.id ?? null,
		asOf: await seqOf(space, query),
		view: query.view,
		budget: { blocks: query.blocks, bytes: query.bytes },
		fold,
		narratorVisible: narratorVisibility(principal),
	});
	if (!result) throw new NotFoundError("Outline block", root?.id ?? space.id);
	await decideUnlocks(principal, space, result.blocks);
	const body: OutlineSubtreeResponse = result;
	return c.json(body);
}

/** The whole space, top level first. */
outlineSubtreeRoutes.get("/spaces/:spaceId/subtree", async (c) => {
	return subtree(c, await readableSpace(c), null);
});

/** A block and what is under it. */
outlineSubtreeRoutes.get("/spaces/:spaceId/blocks/:blockId/subtree", async (c) => {
	const { space, block } = await readableBlock(c);
	return subtree(c, space, block);
});

/** The children of the parents named. */
outlineSubtreeRoutes.get("/spaces/:spaceId/children", async (c) => {
	const principal = principalOf(c);
	const space = await readableSpace(c);
	const query = parse(outlineLevelsQuerySchema, c.req.query());
	const parentIds: Array<string | null> = [
		...(query.top || !query.parents ? [null] : []),
		...(query.parents ?? []),
	];
	const result = await readOutlineLevels({
		space,
		parents: parentIds.map((parentId) => ({ parentId, cursor: query.cursor ?? null })),
		asOf: await seqOf(space, query),
		limit: query.limit,
		perParent: query.perParent,
		bytes: query.bytes,
		view: query.view,
		narratorVisible: narratorVisibility(principal),
	});
	await decideUnlocks(principal, space, result.blocks);
	const body: OutlineLevelsResponse = result;
	return c.json(body);
});

/** What is under each of the blocks named, and whether it changed since a seq. */
outlineSubtreeRoutes.get("/spaces/:spaceId/marks", async (c) => {
	const space = await readableSpace(c);
	const query = parse(outlineMarksQuerySchema, c.req.query());
	const result = await readOutlineMarks({ space, keys: query.keys, since: query.since });
	const body: OutlineMarksResponse = { spaceId: space.id, ...result };
	return c.json(body);
});

/** The children of a parent that differ between two seqs. */
outlineSubtreeRoutes.get("/spaces/:spaceId/changed-children", async (c) => {
	const space = await readableSpace(c);
	const query = parse(outlineChangedChildrenQuerySchema, c.req.query());
	const body: OutlineChangedChildrenResponse = await readOutlineChangedChildren(
		space,
		query.parent ?? null,
		{ after: query.after, upTo: query.upTo, cursor: query.cursor ?? null, limit: query.limit },
	);
	return c.json(body);
});

/** The commits of the space, newest first. */
outlineSubtreeRoutes.get("/spaces/:spaceId/commits", async (c) => {
	const space = await readableSpace(c);
	const query = parse(outlineSubtreeTimelineQuerySchema, c.req.query());
	const body: OutlineSubtreeTimelineResponse = await readOutlineSubtreeTimeline(space, null, query);
	return c.json(body);
});

/** The commits that changed a block or anything that was under it, newest first. */
outlineSubtreeRoutes.get("/spaces/:spaceId/blocks/:blockId/commits", async (c) => {
	const { space, block } = await readableBlock(c);
	const query = parse(outlineSubtreeTimelineQuerySchema, c.req.query());
	const body: OutlineSubtreeTimelineResponse = await readOutlineSubtreeTimeline(
		space,
		block.id,
		query,
	);
	return c.json(body);
});
