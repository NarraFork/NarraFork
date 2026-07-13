import { SUPPORTED_LOCALES } from "@shared/i18n-locales";
import { z } from "zod";

export const localeSchema = z.enum(SUPPORTED_LOCALES);

/** Reusable: valid git branch name (no flags, no special chars) */
export const gitBranchName = z.string().regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name");

/** Reusable schema for whitelist directory entries (global / project level). */
export const whitelistDirEntrySchema = z.object({
	path: z.string().trim().min(1).max(4096),
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).default("readOnly"),
	enabled: z.boolean().default(true),
});

/** Reusable schema for blacklist directory entries (global / project level). */
export const blacklistDirEntrySchema = z.object({
	path: z.string().trim().min(1).max(4096),
	denyLevel: z.enum(["denyWrite", "denyAll"]).default("denyAll"),
	enabled: z.boolean().default(true),
});

/** Reusable schema for command whitelist entries (global / project level). */
export const commandWhitelistEntrySchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	enabled: z.boolean().default(true),
});

/** Reusable schema for command blacklist entries (global / project level). */
export const commandBlacklistEntrySchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	denyPrompt: z.string().max(2000).optional(),
	enabled: z.boolean().default(true),
});

export const commandSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/),
	prompt: z.string().min(1).max(400000),
	description: z.string().max(500).optional(),
	runBashFirst: z.boolean().optional(),
	bashCommand: z.string().max(400000).optional(),
	params: z
		.array(
			z.object({
				name: z.string().min(1).max(50),
				description: z.string().max(500).optional(),
				required: z.boolean().optional(),
				defaultValue: z.string().max(1000).optional(),
			}),
		)
		.max(20)
		.optional(),
	modelOverride: z
		.object({
			model: z.string().min(1).max(100),
			mode: z.enum(["temporary", "permanent"]),
		})
		.optional(),
});
