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
	repoMode: z.enum(["existing", "init", "clone"]),
	gitPath: z.string().min(1),
	// Clone-specific fields
	cloneUrl: z.string().min(1).optional(),
	cloneBranch: gitBranchName.optional(),
	cloneUsername: z.string().max(200).optional(),
	clonePassword: z.string().max(200).optional(),
	/**
	 * `ruler` is DEPRECATED and no longer developed. It stays selectable so existing
	 * projects keep working, but `classic` is the default for anything new.
	 */
	flowMode: z.enum(["classic", "ruler"]).default("classic"),
});

export const projectChapterSettingsSchema = z.object({
	autoCreateNarrator: z.boolean().optional(),
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
	requireReviewBeforeMerge: z.boolean().optional(),
});

export const updateProjectSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(["active", "archived"]).optional(),
	/**
	 * Which canvas the project's story network renders in.
	 *
	 * Accepted here because it used to be settable ONLY at creation time: the column
	 * existed and the create schema wrote it, but no update path read it, so a project
	 * created as `ruler` was locked in that view permanently with no way back. The Ruler
	 * is now deprecated, which makes an escape hatch mandatory rather than nice to have.
	 *
	 * Purely a view preference — no worktree, branch or chapter data depends on it, so
	 * flipping it is reversible and safe at any time.
	 */
	flowMode: z.enum(["classic", "ruler"]).optional(),
	defaultBranch: gitBranchName.optional(),
	startupScript: z.string().max(5000).nullable().optional(),
	copyFiles: z.string().max(5000).nullable().optional(),
	proxyDomain: z.string().max(200).nullable().optional(),
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
