import { OUTLINE_SUBTREE_LIMITS } from "@shared/outline-subtree-api";
import { z } from "zod";
import { outlineIdSchema } from "./index";

/**
 * Query inputs of the outline reads that know no page (`routes/outline-subtree.ts`). Numbers
 * arrive as strings and are coerced; every limit is bounded here so a request outside them is
 * refused before any read, and the services clamp again.
 */

const cursorSchema = z.string().min(1).max(2048);
const seqSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function limitSchema(max: number) {
	return z.coerce.number().int().min(1).max(max);
}

/** A comma-separated list of ids, each once. */
function idListSchema(max: number) {
	return z
		.string()
		.min(1)
		.max(max * 129)
		.transform((text) => text.split(","))
		.pipe(z.array(outlineIdSchema).min(1).max(max))
		.refine((ids) => new Set(ids).size === ids.length, { message: "an id is named twice" });
}

const asOfShape = {
	/** A commit seq, or a time (the last commit at or before it); not both. */
	asOf: seqSchema.optional(),
	at: z.iso.datetime({ offset: true }).optional(),
};
const asOfExclusive = [
	(query: { asOf?: number; at?: string }) => query.asOf === undefined || query.at === undefined,
	{ message: "asOf and at are exclusive" },
] as const;

/** `GET /spaces/:spaceId/subtree`, `GET /spaces/:spaceId/blocks/:blockId/subtree` */
export const outlineSubtreeQuerySchema = z
	.object({
		...asOfShape,
		view: z.enum(["facts", "all"]).optional(),
		blocks: limitSchema(OUTLINE_SUBTREE_LIMITS.maxBlocks).optional(),
		bytes: limitSchema(OUTLINE_SUBTREE_LIMITS.maxBytes).optional(),
		/** Do not go below rows closed by default and by the reader. */
		fold: z.literal("default").optional(),
	})
	.refine(...asOfExclusive);

/**
 * `GET /spaces/:spaceId/children`: the children of `parents` (block ids, comma-separated; the
 * top level of the space when omitted, or `top=1` to name it together with blocks). `cursor`
 * continues one level, so it needs exactly one parent.
 */
export const outlineLevelsQuerySchema = z
	.object({
		...asOfShape,
		parents: idListSchema(OUTLINE_SUBTREE_LIMITS.maxParents).optional(),
		top: z.literal("1").optional(),
		cursor: cursorSchema.optional(),
		limit: limitSchema(OUTLINE_SUBTREE_LIMITS.maxLevelBlocks).optional(),
		perParent: limitSchema(OUTLINE_SUBTREE_LIMITS.maxLevelBlocks).optional(),
		bytes: limitSchema(OUTLINE_SUBTREE_LIMITS.maxBytes).optional(),
		view: z.enum(["facts", "all"]).optional(),
	})
	.refine(...asOfExclusive)
	.refine(
		(query) =>
			(query.parents?.length ?? 0) + (query.top || !query.parents ? 1 : 0) <=
			OUTLINE_SUBTREE_LIMITS.maxParents,
		{ message: "too many parents" },
	)
	.refine(
		(query) =>
			query.cursor === undefined ||
			(query.parents?.length ?? 0) + (query.top || !query.parents ? 1 : 0) === 1,
		{ message: "cursor needs exactly one parent" },
	);

/**
 * `GET /spaces/:spaceId/marks`: `keys` are block ids of the space, or the space's own id for
 * the whole space.
 */
export const outlineMarksQuerySchema = z.object({
	keys: idListSchema(OUTLINE_SUBTREE_LIMITS.maxMarkKeys),
	since: seqSchema.optional(),
});

/** `GET /spaces/:spaceId/changed-children` */
export const outlineChangedChildrenQuerySchema = z.object({
	/** The parent block; the top level of the space when omitted. */
	parent: outlineIdSchema.optional(),
	after: seqSchema,
	upTo: seqSchema.optional(),
	cursor: cursorSchema.optional(),
	limit: limitSchema(OUTLINE_SUBTREE_LIMITS.maxChanged).optional(),
});

/** `GET /spaces/:spaceId/commits`, `GET /spaces/:spaceId/blocks/:blockId/commits` */
export const outlineSubtreeTimelineQuerySchema = z.object({
	before: seqSchema.optional(),
	limit: limitSchema(OUTLINE_SUBTREE_LIMITS.maxTimeline).optional(),
});
