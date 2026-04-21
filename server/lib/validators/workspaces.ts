import { z } from "zod";

export const createWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	tree: z.string().min(2).max(50000), // JSON string of SplitNode
});

export const updateWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	tree: z.string().min(2).max(50000).optional(),
});

// === Project DB (backup/import) ===

export const importProjectSchema = z.object({
	gitPath: z.string().min(1),
});
