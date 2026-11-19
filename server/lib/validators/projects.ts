import {
	TEAM_EXCLUSIVE_PATH_MAX_LENGTH,
	TEAM_EXCLUSIVE_PATHS_MAX,
	TEAM_EXCLUSIVE_PATHS_MAX_BYTES,
} from "@shared/project-teams";
import { z } from "zod";
import {
	blacklistDirEntrySchema,
	commandBlacklistEntrySchema,
	commandSchema,
	commandWhitelistEntrySchema,
	gitBranchName,
	whitelistDirEntrySchema,
} from "./common";

export const createProjectSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	// Repository mode: "existing" (default), "init", "clone"
	repoMode: z.enum(["existing", "init", "clone"]).default("existing"),
	gitPath: z.string().trim().min(1).max(4096),
	// Clone-specific fields
	cloneUrl: z.string().min(1).optional(),
	cloneBranch: gitBranchName.optional(),
	cloneUsername: z.string().max(200).optional(),
	clonePassword: z.string().max(200).optional(),
});

/**
 * One exclusive path glob: relative to the repository root, `/` separators, no `..` segment and
 * no leading `/` (e.g. `drizzle/**`, `server/db/schema.ts`).
 */
const exclusivePathGlobSchema = z
	.string()
	.trim()
	.min(1)
	.max(TEAM_EXCLUSIVE_PATH_MAX_LENGTH)
	.refine(
		(glob) =>
			!glob.startsWith("/") &&
			!glob.includes("\\") &&
			!glob.split("/").includes("..") &&
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
			!/[\u0000-\u001f\u007f]/.test(glob),
		"An exclusive path is a glob relative to the repository root",
	)
	// A directory written `dir/` covers everything under it.
	.transform((glob) => {
		const relative = glob.replace(/^(\.\/)+/, "");
		return relative.endsWith("/") ? `${relative.replace(/\/+$/, "")}/**` : relative;
	})
	// Only `*` / `**` segments (`*`, `**`, `**` then `*`, …) would lock every change of the project.
	.refine(
		(glob) => glob.split("/").some((segment) => segment.length > 0 && !/^\*+$/.test(segment)),
		"Too broad an exclusive path: it matches everything",
	);

export const teamProjectSettingsSchema = z
	.object({
		exclusivePaths: z.array(exclusivePathGlobSchema).max(TEAM_EXCLUSIVE_PATHS_MAX).optional(),
	})
	.strict()
	.refine(
		(value) =>
			Buffer.byteLength(JSON.stringify(value.exclusivePaths ?? []), "utf8") <=
			TEAM_EXCLUSIVE_PATHS_MAX_BYTES,
		`The exclusive paths are at most ${TEAM_EXCLUSIVE_PATHS_MAX_BYTES} bytes`,
	);

export const projectChapterSettingsSchema = z.object({
	commands: z.array(commandSchema).max(100).optional(),
	routines: z
		.object({
			disabledRoutines: z.array(z.string()).optional(),
			enabledRoutines: z.array(z.string()).optional(),
			/** Three-position mode per optional tool routine. See lib/routine-modes.ts. */
			toolModes: z.record(z.string(), z.enum(["manual", "auto", "resident"])).optional(),
		})
		.optional(),
	whitelistDirs: z.array(whitelistDirEntrySchema).max(50).optional(),
	blacklistDirs: z.array(blacklistDirEntrySchema).max(50).optional(),
	commandWhitelist: z.array(commandWhitelistEntrySchema).max(50).optional(),
	commandBlacklist: z.array(commandBlacklistEntrySchema).max(50).optional(),
	/** Project Teams settings: exclusive path globs (see `TeamProjectSettings`). */
	teams: teamProjectSettingsSchema.optional(),
});

export const updateProjectSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	gitPath: z.string().trim().min(1).max(4096).optional(),
	status: z.enum(["active", "archived"]).optional(),
	defaultBranch: gitBranchName.optional(),
	chapterSettings: projectChapterSettingsSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Project access control (membership)
// ─────────────────────────────────────────────────────────────────────────────

/** Who may reach the project at all. Write access never comes from here. */
export const projectVisibilitySchema = z.object({
	visibility: z.enum(["private", "public"]),
});

/**
 * Add or change members.
 *
 * Bounded at 50 per call: inviting people is a deliberate act on a handful of
 * colleagues, and an unbounded list would turn one request into an arbitrarily large
 * write on the main thread.
 */
export const projectMembersSchema = z.object({
	userIds: z.array(z.string().min(1).max(128)).min(1).max(50),
	/** read = follow along; write = work here; manage = also decide who else may. */
	role: z.enum(["read", "write", "manage"]).default("read"),
});

export const projectTransferOwnerSchema = z.object({
	/** null hands the project back to "no owner" (admin-managed). */
	userId: z.string().min(1).max(128).nullable(),
});
