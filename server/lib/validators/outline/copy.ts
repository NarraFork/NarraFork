import { OUTLINE_COPY_ID_RE } from "@shared/outline-copy-api";
import { z } from "zod";
import { outlineIdSchema } from "./index";

/** `POST /spaces/:spaceId/blocks/:blockId/copy` (`routes/outline-copy.ts`). */
export const outlineCopyBodySchema = z
	.object({
		targetSpaceId: outlineIdSchema,
		parentId: outlineIdSchema.nullable(),
		position: z
			.union([
				z.literal("first"),
				z.literal("last"),
				z.object({ after: outlineIdSchema }).strict(),
				z.object({ before: outlineIdSchema }).strict(),
			])
			.optional(),
		copyId: z.string().regex(OUTLINE_COPY_ID_RE).optional(),
	})
	.strict();
