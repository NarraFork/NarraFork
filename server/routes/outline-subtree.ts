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
 *   - `GET/PUT /spaces/:spaceId/fold-state`: the caller's own folding of the space, by block
 *     (`services/outline/fold-state.ts`); a write carries changes. Read access is enough, and
 *     nobody reads or writes another person's. `DELETE` (optionally `?under=<block>`) puts it
 *     back to the default in one request.
 *   - `GET /spaces/:spaceId/open-tasks?under=`: the open tasks under a block (the list behind
 *     a marks read's "in progress" count), cursor-paged.
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
import type { OutlineLockView } from "@shared/outline-api";
import {
	OUTLINE_FOLD_STATE_LIMITS,
	type OutlineChangedChildrenResponse,
	type OutlineFoldStateResponse,
	type OutlineLevelsResponse,
	type OutlineMarksResponse,
	type OutlineOpenTasksResponse,
	type OutlineSubtreeResponse,
	type OutlineSubtreeTimelineResponse,
	type OutlineTreeBlock,
} from "@shared/outline-subtree-api";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { NotFoundError, ValidationError } from "../lib/errors";
import { outlineIdSchema } from "../lib/validators/outline/index";
import {
	outlineChangedChildrenQuerySchema,
	outlineFoldStatePutSchema,
	outlineFoldStateResetQuerySchema,
	outlineLevelsQuerySchema,
	outlineMarksQuerySchema,
	outlineOpenTasksQuerySchema,
	outlineSubtreeQuerySchema,
	outlineSubtreeTimelineQuerySchema,
} from "../lib/validators/outline/subtree";
import {
	canManageSpace,
	canReadSpace,
	narratorVisibility,
	type OutlinePrincipal,
} from "../services/outline/access";
import {
	loadFoldSets,
	readFoldState,
	resetFoldState,
	writeFoldState,
} from "../services/outline/fold-state";
import { commitSeqAt } from "../services/outline/read";
import { outlineStore } from "../services/outline/store";
import type { OutlineBlockRow, OutlineSpaceRow } from "../services/outline/store/port";
import {
	readOutlineChangedChildren,
	readOutlineSubtreeTimeline,
} from "../services/outline/subtree-history";
import { readOutlineMarks, readOutlineOpenTasks } from "../services/outline/subtree-marks";
import { readOutlineLevels, readOutlineSubtree } from "../services/outline/subtree-read";

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
		// The reader's own folding, by block (`fold-state.ts`). Theirs alone; reading it needs
		// no more than reading the space.
		fold = await loadFoldSets(principal.userId, space.id);
	}
	const result = await readOutlineSubtree({
		space,
		rootId: root?.id ?? null,
		asOf: await seqOf(space, query),
		view: query.view,
		budget: { blocks: query.blocks, bytes: query.bytes },
		fold,
		topClosed: query.top === "closed",
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

/** The caller's own folding of the space. */
outlineSubtreeRoutes.get("/spaces/:spaceId/fold-state", async (c) => {
	const space = await readableSpace(c);
	const body: OutlineFoldStateResponse = await readFoldState(principalOf(c).userId, space);
	return c.json(body);
});

/** Changes to the caller's own folding of the space. */
outlineSubtreeRoutes.put(
	"/spaces/:spaceId/fold-state",
	bodyLimit({
		maxSize: OUTLINE_FOLD_STATE_LIMITS.maxBodyBytes,
		onError: (c) =>
			c.json(
				{
					code: "PAYLOAD_TOO_LARGE",
					message: `Request body exceeds ${OUTLINE_FOLD_STATE_LIMITS.maxBodyBytes} bytes`,
				},
				413,
			),
	}),
	async (c) => {
		const space = await readableSpace(c);
		const raw = await c.req.json().catch((error: unknown) => {
			if (error instanceof Error && error.name === "BodyLimitError") throw error;
			throw new ValidationError("Invalid JSON body");
		});
		const input = parse(outlineFoldStatePutSchema, raw);
		const body: OutlineFoldStateResponse = await writeFoldState(
			principalOf(c).userId,
			space,
			input.changes,
		);
		return c.json(body);
	},
);

/** The caller's own folding back to the default: the whole space, or a block and what is under it. */
outlineSubtreeRoutes.delete("/spaces/:spaceId/fold-state", async (c) => {
	const space = await readableSpace(c);
	const query = parse(outlineFoldStateResetQuerySchema, c.req.query());
	const body: OutlineFoldStateResponse = await resetFoldState(
		principalOf(c).userId,
		space,
		query.under ?? null,
	);
	return c.json(body);
});

/** The open tasks under a block (or the whole space), in progress first. */
outlineSubtreeRoutes.get("/spaces/:spaceId/open-tasks", async (c) => {
	const space = await readableSpace(c);
	const query = parse(outlineOpenTasksQuerySchema, c.req.query());
	const body: OutlineOpenTasksResponse = await readOutlineOpenTasks({
		space,
		under: query.under,
		cursor: query.cursor,
		limit: query.limit,
	});
	return c.json(body);
});
