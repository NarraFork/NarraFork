import { OUTLINE_DIFF_LIMITS } from "@shared/outline-restore-api";
import { z } from "zod";
import { outlineIdSchema } from "./index";

/**
 * Bodies of comparing and restoring subtrees (`routes/outline-restore.ts`). Every limit is
 * bounded here, so a request outside them is refused before any read; a cursor or token is
 * opaque, sealed by the server, and checked by the service.
 */

const seqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sealedSchema = z
	.string()
	.min(1)
	.max(OUTLINE_DIFF_LIMITS.maxCursorChars)
	.regex(/^[A-Za-z0-9_.-]+$/);
const limitSchema = z.number().int().min(1).max(OUTLINE_DIFF_LIMITS.maxEntries);

/** `POST /spaces/:spaceId/diff`: `rootId` omitted or null compares the whole space. */
export const outlineDiffBodySchema = z
	.object({
		rootId: outlineIdSchema.nullable().optional(),
		thenSeq: seqSchema,
		to: seqSchema.optional(),
		cursor: sealedSchema.optional(),
		limit: limitSchema.optional(),
	})
	.strict();

/** `POST /spaces/:spaceId/restore/preview`: the first page names no token. */
export const outlineRestorePreviewBodySchema = z
	.object({
		rootId: outlineIdSchema.nullable().optional(),
		thenSeq: seqSchema,
		token: sealedSchema.optional(),
		cursor: sealedSchema.optional(),
		limit: limitSchema.optional(),
	})
	.strict()
	.refine((body) => body.cursor === undefined || body.token !== undefined, {
		message: "cursor needs the token of its preview",
	});

/** `POST /spaces/:spaceId/restore` */
export const outlineRestoreBodySchema = z
	.object({ token: sealedSchema, cursor: sealedSchema.optional() })
	.strict();

/** `POST /spaces/:spaceId/blocks/:blockId/move-back` */
export const outlineMoveBackBodySchema = z.object({ thenSeq: seqSchema }).strict();
