/**
 * Comparing two moments of a subtree, restoring a subtree to an earlier one, and moving one
 * block back (pageless outline, H3), mounted inside the outline routes at `/api/outline` (so
 * `outline.enabled` off answers 404 here too). The page-keyed history and
 * `POST /commits/:commitId/revert` of `routes/outline.ts` stay as they are.
 *
 *   - `POST /spaces/:spaceId/diff`: what differs under a block (or in the space) between two
 *     seqs, a page at a time. A READ, sent as POST because its cursor can be several KB.
 *   - `POST /spaces/:spaceId/restore/preview`: what a restore to a seq would do, a page at a
 *     time, and the token that names it. Writes nothing.
 *   - `POST /spaces/:spaceId/restore`: confirm a previewed restore; call again while `done` is
 *     false.
 *   - `POST /spaces/:spaceId/blocks/:blockId/move-back`: put one block back where it was at a
 *     seq.
 *
 * ACCESS. The diff is a read: a space the person may not read is 404, as one that does not
 * exist. The other three are a revert's: 404 when the space cannot be read, 403 when it can be
 * read but not written (the preview too: it hands out the token a restore is confirmed with);
 * someone else's lock is taken away only for who may unlock. A preview's token is the
 * previewing person's (anyone else gets 400 `OUTLINE_RESTORE_TOKEN_INVALID`, `reason: "person"`)
 * and runs out after `OUTLINE_RESTORE_LIMITS.tokenMinutes` (`reason: "expired"`). A block named in the path, or as
 * `rootId`, must be a block of that space (live or deleted), 404 otherwise.
 *
 * ERRORS: 409 `OUTLINE_HISTORY_NOT_READY` / `OUTLINE_HISTORY_BEFORE_FLOOR` (H2's) when the
 * space keeps no history of the seq; 409 `OUTLINE_RESTORE_CONFLICT` when the subtree changed
 * after the preview; 409 `OUTLINE_RESTORE_ROOT_NOT_THERE`; 409 `OUTLINE_RESTORE_PARENT_GONE`;
 * 400 `OUTLINE_RESTORE_TOKEN_INVALID`; 400 for a body outside the limits.
 */
import type {
	OutlineMoveBackResponse,
	OutlineRestorePreviewResponse,
	OutlineRestoreResponse,
	OutlineSubtreeDiffResponse,
} from "@shared/outline-restore-api";
import { type Context, Hono } from "hono";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors";
import { outlineIdSchema } from "../lib/validators/outline/index";
import {
	outlineDiffBodySchema,
	outlineMoveBackBodySchema,
	outlineRestoreBodySchema,
	outlineRestorePreviewBodySchema,
} from "../lib/validators/outline/restore";
import {
	canManageSpace,
	canReadSpace,
	canWriteSpace,
	type OutlinePrincipal,
} from "../services/outline/access";
import { outlineStore } from "../services/outline/store";
import type { OutlineSpaceRow } from "../services/outline/store/port";
import { readOutlineSubtreeDiff } from "../services/outline/subtree-diff";
import {
	moveOutlineBlockBack,
	type OutlineRestoreWriter,
	previewOutlineRestore,
	restoreOutlineSubtree,
} from "../services/outline/subtree-restore";

export const outlineRestoreRoutes = new Hono();

function principalOf(c: Context): OutlinePrincipal {
	const user = c.get("user");
	return { userId: user.sub, isAdmin: user.role === "admin" };
}

async function body<T>(
	c: Context,
	schema: {
		safeParse(input: unknown): { success: true; data: T } | { success: false; error: Error };
	},
): Promise<T> {
	let input: unknown;
	try {
		input = await c.req.json();
	} catch {
		throw new ValidationError("Invalid JSON body");
	}
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

function idParam(c: Context, name: string): string {
	const parsed = outlineIdSchema.safeParse(c.req.param(name));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

/** The space, if the person may read it (and, with `write`, write it: 403 otherwise). */
async function spaceFor(c: Context, write: boolean): Promise<OutlineSpaceRow> {
	const principal = principalOf(c);
	const spaceId = idParam(c, "spaceId");
	const space = await outlineStore.getSpace(spaceId);
	if (!space || !(await canReadSpace(principal, space)))
		throw new NotFoundError("Outline space", spaceId);
	if (write && !(await canWriteSpace(principal, space))) throw new ForbiddenError();
	return space;
}

/** A block must be one of the space, live or deleted. */
async function blockOf(space: OutlineSpaceRow, blockId: string | null | undefined) {
	if (blockId == null) return null;
	const block = await outlineStore.getBlock(blockId);
	if (!block || block.spaceId !== space.id) throw new NotFoundError("Outline block", blockId);
	return block.id;
}

function writerOf(c: Context, space: OutlineSpaceRow): OutlineRestoreWriter {
	const principal = principalOf(c);
	return {
		actor: { kind: "human", id: principal.userId },
		responsibleUserId: principal.userId,
		// As for a revert: someone else's lock goes only for who may unlock.
		unlockAuthority: async () => principal.isAdmin || (await canManageSpace(principal, space)),
	};
}

outlineRestoreRoutes.post("/spaces/:spaceId/diff", async (c) => {
	const space = await spaceFor(c, false);
	const input = await body(c, outlineDiffBodySchema);
	const result: OutlineSubtreeDiffResponse = await readOutlineSubtreeDiff({
		space,
		rootId: await blockOf(space, input.rootId),
		thenSeq: input.thenSeq,
		to: input.to,
		cursor: input.cursor,
		limit: input.limit,
	});
	return c.json(result);
});

outlineRestoreRoutes.post("/spaces/:spaceId/restore/preview", async (c) => {
	const space = await spaceFor(c, true);
	const input = await body(c, outlineRestorePreviewBodySchema);
	const result: OutlineRestorePreviewResponse = await previewOutlineRestore({
		space,
		rootId: await blockOf(space, input.rootId),
		thenSeq: input.thenSeq,
		userId: principalOf(c).userId,
		token: input.token,
		cursor: input.cursor,
		limit: input.limit,
	});
	return c.json(result);
});

outlineRestoreRoutes.post("/spaces/:spaceId/restore", async (c) => {
	const space = await spaceFor(c, true);
	const input = await body(c, outlineRestoreBodySchema);
	const result: OutlineRestoreResponse = await restoreOutlineSubtree({
		...writerOf(c, space),
		space,
		token: input.token,
		cursor: input.cursor,
	});
	return c.json(result);
});

outlineRestoreRoutes.post("/spaces/:spaceId/blocks/:blockId/move-back", async (c) => {
	const space = await spaceFor(c, true);
	const blockId = (await blockOf(space, idParam(c, "blockId"))) as string;
	const input = await body(c, outlineMoveBackBodySchema);
	const result: OutlineMoveBackResponse = await moveOutlineBlockBack({
		...writerOf(c, space),
		space,
		blockId,
		thenSeq: input.thenSeq,
	});
	return c.json(result);
});
