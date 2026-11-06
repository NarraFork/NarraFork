/**
 * Request schemas of the reports (`/api/outline/digests`, outline P2 PR 11) and of the two report
 * settings in `PATCH /api/user-preferences`.
 */
import { OUTLINE_DIGEST_TIME_PATTERN } from "@shared/outline-digest";
import { z } from "zod";
import { canonicalTimeZone } from "../../../services/outline/digest-time";
import { outlineIdSchema } from "./index";

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `GET /digests`: the person's daily reports, days before `before`. */
export const outlineDigestListQuerySchema = z.object({
	before: dayKey.optional(),
	limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** `POST /digests/seen`: reports the person has read. */
export const outlineDigestsSeenBodySchema = z.object({
	ids: z.array(outlineIdSchema).min(1).max(50),
});

/** `POST /digests/undo`: the commit of a decision made in the person's name. */
export const outlineDigestUndoBodySchema = z.object({
	commitId: outlineIdSchema,
});

/**
 * A report time zone: an IANA name this runtime knows, stored as its canonical spelling; null
 * goes back to the server's.
 */
export const outlineDigestTimeZoneSchema = z
	.string()
	.max(64)
	.nullable()
	.transform((value, ctx) => {
		if (value === null) return null;
		const zone = canonicalTimeZone(value);
		if (!zone) {
			ctx.addIssue({ code: "custom", message: "Unknown time zone" });
			return z.NEVER;
		}
		return zone;
	});

/** A report time of day, `HH:MM`; null goes back to the default. */
export const outlineDigestTimeSchema = z
	.string()
	.regex(OUTLINE_DIGEST_TIME_PATTERN, "Expected HH:MM")
	.nullable();
