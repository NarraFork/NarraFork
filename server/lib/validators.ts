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
