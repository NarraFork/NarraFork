import { z } from "zod";

const filePathArray = z.array(z.string().min(1)).min(1);

export const gitStageSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitUnstageSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitCommitSchema = z.object({
	message: z.string().min(1).max(500),
});

export const gitDiscardSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitStashSchema = z.object({
	action: z.enum(["push", "pop", "drop"]),
	message: z.string().max(200).optional(),
	index: z.number().int().min(0).optional(),
});

export const gitResetSchema = z.object({
	target: z.string().min(1).max(100),
	mode: z.enum(["soft", "hard"]),
});

export const gitLogQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	skip: z.coerce.number().int().min(0).default(0),
});

export const gitDiffQuerySchema = z.object({
	file: z.string().min(1),
	staged: z
		.string()
		.optional()
		.transform((v) => v === "true"),
});

// === commits list ===

export const listCommitsSchema = z.object({
	since: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
