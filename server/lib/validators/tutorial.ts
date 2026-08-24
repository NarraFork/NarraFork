import { z } from "zod/v4";

/**
 * Interactive tutorial request schemas.
 *
 * Lesson and step ids are validated for SHAPE here and for EXISTENCE in the
 * service, which owns the lesson catalog. Splitting it that way keeps the
 * validator free of a dependency on the lesson data while still rejecting an
 * unbounded string before it reaches a database lookup.
 */

/** Lesson / step ids are authored slugs, so the shape is narrow on purpose. */
const tutorialIdSchema = z
	.string()
	.min(1)
	.max(80)
	.regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug");

export const startTutorialLessonSchema = z.object({});

export const tutorialProgressSchema = z.object({
	/**
	 * Steps the client observed as completed. Capped because the payload is a set,
	 * not a log: no lesson has more steps than this, so a larger array is a client
	 * bug rather than a request worth honouring.
	 */
	completedStepIds: z.array(tutorialIdSchema).max(50),
	/**
	 * Mark the lesson finished even if some steps were not individually reported.
	 * Lets a "skip to the end" affordance record completion without fabricating
	 * per-step evidence the client never actually observed.
	 */
	completed: z.boolean().optional(),
});

export { tutorialIdSchema };
