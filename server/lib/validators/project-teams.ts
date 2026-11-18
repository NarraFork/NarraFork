import {
	TEAM_BOARD_COLUMNS,
	TEAM_BOARD_PAGE_LIMIT,
	TEAM_BRANCH_MAX_LENGTH,
	TEAM_BRIEF_MAX_BYTES,
	TEAM_EVENTS_PAGE_LIMIT,
	TEAM_NAME_MAX_LENGTH,
	TEAM_SETTINGS_MAX_BYTES,
} from "@shared/project-teams";
import { z } from "zod";
import { gitBranchName } from "./common";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** The team brief: plain text, at most 4 KB of UTF-8. */
export const teamBriefSchema = z
	.string()
	.refine((value) => utf8Bytes(value) <= TEAM_BRIEF_MAX_BYTES, {
		message: `The team brief is limited to ${TEAM_BRIEF_MAX_BYTES} bytes`,
	});

/** A git branch name that cannot be read as an option, a range or a reflog expression. */
export const teamBaseBranchSchema = gitBranchName
	.max(TEAM_BRANCH_MAX_LENGTH)
	.refine(
		(value) =>
			!value.startsWith("-") &&
			!value.startsWith("/") &&
			!value.endsWith("/") &&
			!value.endsWith(".") &&
			!value.endsWith(".lock") &&
			!value.includes("..") &&
			!value.includes("//"),
		{ message: "Invalid branch name" },
	);

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
	})
	.strict()
	.refine((value) => utf8Bytes(JSON.stringify(value)) <= TEAM_SETTINGS_MAX_BYTES, {
		message: `Team settings are limited to ${TEAM_SETTINGS_MAX_BYTES} bytes`,
	});

export const createProjectTeamSchema = z
	.object({
		/** The team name, which is the coordinator session's title. */
		name: z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH),
		/** Defaults to the project's default branch. */
		baseBranch: teamBaseBranchSchema.optional(),
		brief: teamBriefSchema.optional(),
		settings: teamSettingsSchema.optional(),
		/** The coordinator's audiences; omitted follows the project-session defaults. */
		visibility: z.enum(["private", "project", "public"]).optional(),
		writeAudience: z.enum(["owner", "project", "public"]).optional(),
	})
	.strict();

export const updateProjectTeamSchema = z
	.object({
		baseBranch: teamBaseBranchSchema.optional(),
		brief: teamBriefSchema.optional(),
		settings: teamSettingsSchema.optional(),
	})
	.strict()
	.refine((value) => Object.values(value).some((field) => field !== undefined), {
		message: "Nothing to update",
	});

export const listProjectTeamsQuerySchema = z.object({
	status: z.enum(["active", "archived", "all"]).default("active"),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.string().max(200).optional(),
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
