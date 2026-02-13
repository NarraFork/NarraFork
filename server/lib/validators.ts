import { z } from "zod";

// Reusable: valid git branch name (no flags, no special chars)
const gitBranchName = z.string().regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name");

// === Projects ===

export const createProjectSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	repositoryPath: z.string().min(1).optional(),
	repositoryName: z.string().max(200).optional(),
	defaultBranch: gitBranchName.optional(),
});

export const updateProjectSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(["active", "archived"]).optional(),
});

// === Chapters ===

export const createChapterSchema = z.object({
	projectId: z.string().min(1),
	repositoryId: z.string().min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	type: z.enum(["meanwhile", "whatif"]).optional(),
	baseBranch: gitBranchName.optional(),
});

export const updateChapterSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(["active", "dormant", "merged", "abandoned"]).optional(),
});

// === Narrators ===

export const createNarratorSchema = z.object({
	chapterId: z.string().min(1),
	type: z.enum(["primary", "secondary"]).optional(),
	model: z.string().optional(),
	systemPrompt: z.string().max(10000).optional(),
	permissionMode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
		.optional(),
});

export const sendMessageSchema = z.object({
	message: z.string().min(1),
});

export const permissionDecisionSchema = z.object({
	decision: z.enum(["allow", "deny"]),
	message: z.string().optional(),
});

// === Terminals ===

export const createTerminalSchema = z.object({
	chapterId: z.string().min(1),
	name: z.string().max(100).optional(),
	cols: z.number().int().min(10).max(500).optional(),
	rows: z.number().int().min(2).max(200).optional(),
});

// === Fork / Merge / Cleanup ===

export const forkChapterSchema = z.object({
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	type: z.enum(["meanwhile", "whatif"]).optional(),
	inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
	forkAtMessageUuid: z.string().optional(),
});

export const mergeChapterSchema = z.object({
	targetChapterId: z.string().min(1),
	strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
	message: z.string().max(500).optional(),
});

export const mergeCheckSchema = z.object({
	targetChapterId: z.string().min(1),
});

export const batchCleanupSchema = z.object({
	chapterIds: z.array(z.string().min(1)).min(1),
	force: z.boolean().optional(),
	deleteBranch: z.boolean().optional(),
});

export const batchMergeSchema = z.object({
	baseChapterId: z.string().min(1),
	sourceChapterIds: z.array(z.string().min(1)).min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
});

// === Containers ===

export const containerConfigSchema = z.object({
	composeFile: z.string().max(500).optional(),
	services: z.array(z.string().min(1)).optional(),
	ports: z
		.array(
			z.object({
				containerPort: z.number().int().min(1).max(65535),
				serviceName: z.string().min(1),
			}),
		)
		.optional(),
	env: z.record(z.string(), z.string()).optional(),
});

export const containerRemoveSchema = z.object({
	deleteVolumes: z.boolean().optional(),
});

// === Auth ===

export const registerSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, hyphens, underscores only"),
	password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
});

export const adminUpdateSettingsSchema = z.object({
	registrationOpen: z.boolean(),
});

// === Sessions (standalone) ===

export const createSessionSchema = z.object({
	model: z.string().optional(),
	systemPrompt: z.string().max(10000).optional(),
	permissionMode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
		.optional(),
});
