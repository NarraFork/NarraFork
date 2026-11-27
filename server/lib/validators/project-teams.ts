import { teamBaseBranchSchema, teamBriefSchema, teamNameSchema } from "@shared/project-team-draft";
import {
	TEAM_BOARD_COLUMNS,
	TEAM_BOARD_PAGE_LIMIT,
	TEAM_EVENTS_PAGE_LIMIT,
	TEAM_PR_MERGE_METHODS,
	TEAM_RETURN_REASON_MAX_LENGTH,
	TEAM_SETTINGS_MAX_BYTES,
	TEAM_WORK_START_MODES,
	TEAM_WORK_STATS_IDS_MAX,
} from "@shared/project-teams";
import { z } from "zod";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

// The fields a person types live in `shared/` so the dialogs check a draft by the same rules.
export { teamBaseBranchSchema, teamBriefSchema };

const positiveLimit = (max: number) => z.number().int().min(1).max(max);

export const coordinatorLimitsSchema = z
	.object({
		editLines: positiveLimit(10_000),
		newFileLines: positiveLimit(10_000),
		filesPerTurn: positiveLimit(1_000),
		readLines: positiveLimit(100_000),
		searchLines: positiveLimit(100_000),
		bashOutputBytes: positiveLimit(10 * 1024 * 1024),
		contextPercent: positiveLimit(100),
	})
	.partial()
	.strict();

/** `TeamSettings`; unknown keys are refused so typos do not silently do nothing. */
export const teamSettingsSchema = z
	.object({
		coordinatorLimits: coordinatorLimitsSchema.optional(),
		mergeNeedsPerson: z.boolean().optional(),
		/** Where new work items start: `origin/<base>` or the local base (absent: the default). */
		workStart: z.enum(TEAM_WORK_START_MODES).optional(),
	})
	.strict()
	.refine((value) => utf8Bytes(JSON.stringify(value)) <= TEAM_SETTINGS_MAX_BYTES, {
		message: `Team settings are limited to ${TEAM_SETTINGS_MAX_BYTES} bytes`,
	});

/** A settings change: the keys given replace the stored ones, `null` removes one. */
export const teamSettingsPatchSchema = z
	.object({
		coordinatorLimits: coordinatorLimitsSchema.nullable().optional(),
		mergeNeedsPerson: z.boolean().nullable().optional(),
		workStart: z.enum(TEAM_WORK_START_MODES).nullable().optional(),
	})
	.strict()
	.refine((value) => utf8Bytes(JSON.stringify(value)) <= TEAM_SETTINGS_MAX_BYTES, {
		message: `Team settings are limited to ${TEAM_SETTINGS_MAX_BYTES} bytes`,
	});

export const createProjectTeamSchema = z
	.object({
		/** The team name, which is the coordinator session's title. */
		name: teamNameSchema,
		/** Defaults to the project's default branch. */
		baseBranch: teamBaseBranchSchema.optional(),
		brief: teamBriefSchema.optional(),
		settings: teamSettingsSchema.optional(),
		/** The coordinator's audiences; omitted follows the project-session defaults. */
		visibility: z.enum(["private", "project", "public"]).optional(),
		writeAudience: z.enum(["owner", "project", "public"]).optional(),
	})
	.strict();

/**
 * `POST /api/projects/:projectId/teams` with `fromNarratorId`: turn an existing session into the
 * team's coordinator. Strict and separate from creation: the session keeps its audiences, which
 * change only through the sharing routes, so `visibility` / `writeAudience` are refused here.
 */
export const upgradeProjectTeamSchema = z
	.object({
		/** The session that becomes the coordinator. */
		fromNarratorId: z.string().min(1).max(200),
		/** The team name; omitted keeps the session's title. */
		name: teamNameSchema.optional(),
		baseBranch: teamBaseBranchSchema.optional(),
		brief: teamBriefSchema.optional(),
		settings: teamSettingsSchema.optional(),
	})
	.strict();

export const updateProjectTeamSchema = z
	.object({
		baseBranch: teamBaseBranchSchema.optional(),
		brief: teamBriefSchema.optional(),
		settings: teamSettingsPatchSchema.optional(),
	})
	.strict()
	.refine((value) => Object.values(value).some((field) => field !== undefined), {
		message: "Nothing to update",
	});

export const listProjectTeamsQuerySchema = z.object({
	status: z.enum(["active", "archived", "all"]).default("active"),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.string().max(200).optional(),
	/** R2: each team carries its card's numbers; the page is then at most 24 teams. */
	counts: z
		.enum(["true", "false"])
		.optional()
		.transform((value) => value === "true"),
});

// ── P4: the team page ────────────────────────────────────────────────────────

const pageCursor = z.string().min(1).max(600).optional();

export const teamBoardQuerySchema = z.object({
	column: z.enum(TEAM_BOARD_COLUMNS),
	limit: z.coerce.number().int().min(1).max(TEAM_BOARD_PAGE_LIMIT).default(TEAM_BOARD_PAGE_LIMIT),
	cursor: pageCursor,
});

export const teamActivityQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(TEAM_EVENTS_PAGE_LIMIT).default(TEAM_EVENTS_PAGE_LIMIT),
	cursor: pageCursor,
});

/** `POST /api/projects/:projectId/team-locks/release`: a person releases the exclusive lock. */
export const releaseTeamLockSchema = z
	.object({
		workItemId: z.string().min(1).max(200),
		reason: z.string().max(500).optional(),
	})
	.strict();

// ── R: the redesigned team page ─────────────────────────────────────────────

/** `GET …/work-stats?ids=a,b,c`: up to the limit, comma-separated. */
export const teamWorkStatsQuerySchema = z.object({
	ids: z
		.string()
		.max(TEAM_WORK_STATS_IDS_MAX * 201)
		.transform((value) => value.split(",").filter(Boolean))
		.pipe(z.array(z.string().min(1).max(200)).max(TEAM_WORK_STATS_IDS_MAX)),
});

/** `GET …/work/:itemId/diff?path=`: a repository-relative path the branch changed. */
export const teamWorkDiffQuerySchema = z.object({
	path: z.string().min(1).max(4096),
});

/** G: `PUT /projects/:projectId/team-github`: the repository a manager confirms (`host/owner/repo`). */
export const teamGithubPinSchema = z.object({ target: z.string().trim().min(5).max(400) }).strict();

/** G: `POST …/work/:itemId/pr/merge`: the merge method (absent: the repository's default). */
export const mergeTeamPullRequestSchema = z
	.object({ method: z.enum(TEAM_PR_MERGE_METHODS).optional() })
	.strict();

/** `POST …/work/:itemId/return`: the reason the worker gets. */
export const returnTeamWorkItemSchema = z
	.object({
		reason: z.string().trim().min(1).max(TEAM_RETURN_REASON_MAX_LENGTH),
	})
	.strict();
