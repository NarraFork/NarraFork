import { OUTLINE_RESOLVE_REQUEST_LIMITS, OUTLINE_VIEW_LIMITS } from "@shared/outline-api";
import { z } from "zod";

/**
 * Query and path inputs of the outline routes (`/api/outline`). Numbers arrive as strings and
 * are coerced; every limit is bounded here so a request outside them is refused before any
 * read, and the services clamp again.
 */

/** Opaque ids: block, space, page, commit, project and narrator ids. */
export const outlineIdSchema = z.string().min(1).max(128);

const cursorSchema = z.string().min(1).max(2048);
const seqSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function limitSchema(max: number) {
	return z.coerce.number().int().min(1).max(max);
}

export const outlineSpaceListQuerySchema = z.object({
	kind: z.enum(["project", "personal", "session"]).optional(),
	cursor: cursorSchema.optional(),
	limit: limitSchema(OUTLINE_VIEW_LIMITS.maxListPage).optional(),
});

export const outlinePageListQuerySchema = z.object({
	cursor: cursorSchema.optional(),
	limit: limitSchema(OUTLINE_VIEW_LIMITS.maxListPage).optional(),
});

/**
 * Reading a block: `asOf` (a commit seq) or `at` (a time; the last commit at or before it),
 * not both; `blocks` and `bytes` are the view's budget.
 */
export const outlineBlockViewQuerySchema = z
	.object({
		asOf: seqSchema.optional(),
		at: z.iso.datetime({ offset: true }).optional(),
		view: z.enum(["facts", "all"]).optional(),
		blocks: limitSchema(OUTLINE_VIEW_LIMITS.maxBlocks).optional(),
		bytes: limitSchema(OUTLINE_VIEW_LIMITS.maxBytes).optional(),
	})
	.refine((query) => query.asOf === undefined || query.at === undefined, {
		message: "asOf and at are exclusive",
	});

export const outlineHistoryQuerySchema = z.object({
	before: seqSchema.optional(),
	limit: limitSchema(OUTLINE_VIEW_LIMITS.maxTimeline).optional(),
});

export const outlineBacklinksQuerySchema = z.object({
	limit: limitSchema(OUTLINE_VIEW_LIMITS.maxBacklinks).optional(),
});

export const outlineSearchQuerySchema = z.object({
	q: z.string().trim().min(1).max(500),
	spaceId: outlineIdSchema.optional(),
	limit: limitSchema(OUTLINE_VIEW_LIMITS.maxSearch).optional(),
});

/**
 * What to resolve: a block reference (`ref`), or a commit (`commit`, a seq) of `space`. `space` is
 * a space key or id; a reference written as `key/…` names its own space and needs none.
 */
export const outlineResolveQuerySchema = z
	.object({
		ref: z.string().trim().min(1).max(OUTLINE_RESOLVE_REQUEST_LIMITS.maxRef).optional(),
		space: outlineIdSchema.optional(),
		commit: seqSchema.optional(),
	})
	.refine((query) => (query.ref === undefined) !== (query.commit === undefined), {
		message: "exactly one of ref and commit",
	})
	.refine((query) => query.commit === undefined || query.space !== undefined, {
		message: "commit needs space",
	});
