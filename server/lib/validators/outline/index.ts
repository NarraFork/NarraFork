import {
	OUTLINE_BLOCK_ID_RE,
	OUTLINE_PENDING_API_LIMITS,
	OUTLINE_REPORT_AUTHORS_API_LIMITS,
	OUTLINE_RESOLVE_REQUEST_LIMITS,
	OUTLINE_VIEW_LIMITS,
	OUTLINE_VIEW_STATE_LIMITS,
} from "@shared/outline-api";
import { OUTLINE_TASK_BOARD_LIMITS } from "@shared/outline-task-board";
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

/** The report containers to name the subagents of (`GET /spaces/:spaceId/report-authors`). */
export const outlineReportAuthorsQuerySchema = z.object({
	ids: z
		.string()
		.max(OUTLINE_REPORT_AUTHORS_API_LIMITS.maxIds * (OUTLINE_VIEW_STATE_LIMITS.maxIdChars + 1))
		.transform((value) => value.split(",").filter(Boolean))
		.pipe(
			z
				.array(z.string().regex(OUTLINE_BLOCK_ID_RE))
				.min(1)
				.max(OUTLINE_REPORT_AUTHORS_API_LIMITS.maxIds),
		),
});

/** One person's folding and mind-map direction of a page (`PUT /view-state/:pageId`). */
export const outlineViewStatePutSchema = z
	.object({
		// Block ids only: not free text (a reader may write this for every page they can read).
		collapsed: z
			.array(z.string().regex(OUTLINE_BLOCK_ID_RE).max(OUTLINE_VIEW_STATE_LIMITS.maxIdChars))
			.max(OUTLINE_VIEW_STATE_LIMITS.maxCollapsed),
		// What the reader opened that is folded by default; absent from an older client.
		expanded: z
			.array(z.string().regex(OUTLINE_BLOCK_ID_RE).max(OUTLINE_VIEW_STATE_LIMITS.maxIdChars))
			.max(OUTLINE_VIEW_STATE_LIMITS.maxCollapsed)
			.optional(),
		layout: z.enum(["right", "down"]),
	})
	// The two sets share one budget (what is stored is bounded the same way).
	.refine(
		(body) =>
			body.collapsed.length + (body.expanded?.length ?? 0) <=
			OUTLINE_VIEW_STATE_LIMITS.maxCollapsed,
		{ message: "collapsed and expanded together exceed the limit" },
	);

/** Locking a task tree: the session that may confirm step changes on the locker's behalf. */
export const outlineLockBodySchema = z.object({
	delegate: outlineIdSchema.nullable().optional(),
});

/** Rejecting a pending change: why, for its proposer. */
export const outlinePendingRejectBodySchema = z.object({
	reason: z.string().trim().max(OUTLINE_PENDING_API_LIMITS.maxReasonChars).nullable().optional(),
});

/** Answering questions put to the person (`POST /questions/answer`, outline P2 PR 7). */
export const outlineAnswerBodySchema = z.object({
	answers: z
		.array(
			z
				.object({
					blockId: outlineIdSchema,
					option: z.number().int().min(1).max(100).optional(),
					text: z.string().max(16_384).optional(),
					adopt: z.boolean().optional(),
					// The version the person read: required, so every caller gets the stale check (S3).
					versionSeq: z.number().int().min(1),
				})
				.strict(),
		)
		.min(1)
		.max(50),
});

/** Acknowledging confirmations agents made on the person's behalf (`POST /digest/seen`). */
export const outlineDigestSeenBodySchema = z.object({
	pendingIds: z.array(outlineIdSchema).min(1).max(50),
});

// ── Task board (outline P2 PR 5) ──────────────────────────────────────────────

/** A project board's next page of spaces. */
export const outlineTaskBoardQuerySchema = z.object({
	cursor: cursorSchema.optional(),
});

/** A space's next finished tasks. */
export const outlineFinishedTasksQuerySchema = z.object({
	cursor: cursorSchema.optional(),
	limit: limitSchema(OUTLINE_TASK_BOARD_LIMITS.maxFinishedPage).optional(),
});

/** A person adds a task to a session (the board's form). */
export const outlineBoardAddBodySchema = z.object({
	text: z.string().trim().min(1).max(OUTLINE_TASK_BOARD_LIMITS.maxTaskChars),
	lock: z.boolean().optional(),
	start: z.boolean().optional(),
});

/** A person changes one task on the board: its checkbox, or whom it is handed to. */
export const outlineBoardTaskUpdateBodySchema = z
	.object({
		baseVersionSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		status: z.enum(["todo", "done", "cancelled"]).optional(),
		assign: z
			.discriminatedUnion("kind", [
				z.object({ kind: z.literal("me") }),
				z.object({
					kind: z.literal("user"),
					username: z.string().trim().min(1).max(OUTLINE_TASK_BOARD_LIMITS.maxUsernameChars),
				}),
				z.object({ kind: z.literal("session") }),
			])
			.optional(),
		start: z.boolean().optional(),
	})
	.refine((body) => body.status !== undefined || body.assign !== undefined, {
		message: "nothing to change",
	});

/** The reader saw these tasks marked 「新完成」 on a board (outline P2 PR 9b). */
export const outlineBoardSeenBodySchema = z.object({
	tasks: z
		.array(
			z.object({
				id: outlineIdSchema,
				versionSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
			}),
		)
		.min(1)
		.max(OUTLINE_TASK_BOARD_LIMITS.seenPerRequest),
});

/** A plan's diff (outline P2 PR 8): compared from `from` (a seq; 0 is nothing) to now. */
export const outlinePlanDiffQuerySchema = z.object({
	from: seqSchema,
});

/** A person's decision on a submitted plan (`POST /narrators/permissions/:id/plan`). */
export const outlinePlanDecisionSchema = z
	.object({
		action: z.enum(["return", "draft", "lock"]),
		feedback: z.string().max(4000).optional(),
		delegate: outlineIdSchema.nullable().optional(),
		seenSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		compactAfter: z.boolean().optional(),
	})
	.strict();
