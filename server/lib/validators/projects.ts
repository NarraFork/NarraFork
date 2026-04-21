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
	flowMode: z.enum(["classic", "ruler"]).default("classic"),
});

export const updateProjectSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(["active", "archived"]).optional(),
	defaultBranch: gitBranchName.optional(),
	startupScript: z.string().max(5000).nullable().optional(),
	copyFiles: z.string().max(5000).nullable().optional(),
	proxyDomain: z.string().max(200).nullable().optional(),
	chapterSettings: z
		.object({
			autoCreateNarrator: z.boolean().optional(),
			commands: z.array(commandSchema).max(100).optional(),
			routines: z
				.object({
					disabledRoutines: z.array(z.string()).optional(),
					enabledRoutines: z.array(z.string()).optional(),
				})
				.optional(),
			whitelistDirs: z.array(whitelistDirEntrySchema).max(50).optional(),
			blacklistDirs: z.array(blacklistDirEntrySchema).max(50).optional(),
			commandWhitelist: z.array(commandWhitelistEntrySchema).max(50).optional(),
			commandBlacklist: z.array(commandBlacklistEntrySchema).max(50).optional(),
			requireReviewBeforeMerge: z.boolean().optional(),
		})
		.optional(),
});
