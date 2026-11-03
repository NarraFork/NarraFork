import { z } from "zod";

/** Turn ids are nanoids, or `msg:<messageId>` for turns derived from user inputs. */
const turnIdSchema = z
	.string()
	.min(1)
	.max(140)
	.regex(/^(msg:)?[A-Za-z0-9_-]+$/, { message: "invalid turn id" });

export const narratorTimelineQuerySchema = z.object({
	turnId: turnIdSchema.optional(),
});

export const narratorTimelineTurnsQuerySchema = z.object({
	before: z.iso.datetime().optional(),
	limit: z.coerce.number().int().min(1).max(50).default(20),
});
