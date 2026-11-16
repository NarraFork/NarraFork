/**
 * Wire types of copying a block's subtree under a parent, in the same space or another
 * (pageless outline, A2): `POST /api/outline/spaces/:spaceId/blocks/:blockId/copy`
 * (`server/routes/outline-copy.ts`, the service `server/services/outline/subtree-copy.ts`). What
 * 「复制到这里」 makes when a block is dragged into another space.
 *
 * The copy keeps the text (links to copied blocks point to their copies) and the order; a task
 * stays a task, to do when it was in progress, with no claim, no manager and only the assignees
 * who may write the target space; a question becomes a plain block; aliases, tags, locks and
 * plans are not copied. Its first block says where it came from. It is written in commits of at
 * most {@link OUTLINE_COPY_LIMITS.batchBlocks} blocks; a copy that stopped part way (`done`
 * false) goes on where it stopped when asked again with the same `copyId`.
 */

export const OUTLINE_COPY_LIMITS = {
	/** Blocks of one copy, its provenance included. */
	blocks: 2000,
	/** UTF-8 bytes of the copied content. */
	bytes: 1024 * 1024,
	/** Blocks one commit of a copy writes at most. */
	batchBlocks: 200,
} as const;

/** `copyId`: letters, digits, `-` and `_`, 8 to 64 characters. */
export const OUTLINE_COPY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Where among the target parent's children (default `last`). */
export type OutlineCopyPosition = "first" | "last" | { after: string } | { before: string };

export interface OutlineCopyRequest {
	/** The space the copy goes to (the source's own for a copy in one space). */
	targetSpaceId: string;
	/** A live block of the target space, or null for its top level. */
	parentId: string | null;
	position?: OutlineCopyPosition;
	/** The copy's id: the same one goes on with a copy that stopped. Made by the server if absent. */
	copyId?: string;
}

export interface OutlineCopyResponse {
	copyId: string;
	/** The copy of the block. */
	root: { id: string; sid: string; address: string; spaceId: string };
	/** Blocks of the source the copy holds. */
	copied: number;
	/** Blocks this request wrote (the provenance included). */
	written: number;
	/** Blocks under the source left out (past the limits; a lower bound for a very large one). */
	omitted: number;
	/** Steps whose assignee was dropped (who cannot work in the target space). */
	dropped: number;
	/** Commits this request wrote. */
	commits: number;
	/** Every block the copy takes is there. */
	done: boolean;
	/** Why it stopped before the end: ask again with the same `copyId` to go on. */
	stopped?: { code: string; message: string };
}
