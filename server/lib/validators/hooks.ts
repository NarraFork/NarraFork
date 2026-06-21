import { z } from "zod";

export const hookEventEnum = z.enum(["PreToolUse", "PostToolUse", "Stop"]);

export const hookTypeEnum = z.enum(["command", "http"]);

export const createHookSchema = z
	.object({
		projectId: z.string().min(1).max(100).optional(),
		event: hookEventEnum,
		matcher: z.string().max(200).default(""),
		type: hookTypeEnum,
		command: z.string().max(10000).optional(),
		url: z.string().url().max(2000).optional(),
		headers: z.record(z.string(), z.string().max(2000)).optional(),
		timeout: z.number().int().min(1).max(600).default(30),
		enabled: z.boolean().default(true),
		sortOrder: z.number().int().default(0),
	})
	.refine(
		(d) => {
			if (d.type === "command") return !!d.command;
			if (d.type === "http") return !!d.url;
			return false;
		},
		{ message: "Missing required field for hook type" },
	);

export const updateHookSchema = z
	.object({
		event: hookEventEnum.optional(),
		matcher: z.string().max(200).optional(),
		type: hookTypeEnum.optional(),
		command: z.string().max(10000).optional().nullable(),
		url: z.string().url().max(2000).optional().nullable(),
		headers: z.record(z.string(), z.string().max(2000)).optional().nullable(),
		timeout: z.number().int().min(1).max(600).optional(),
		enabled: z.boolean().optional(),
		sortOrder: z.number().int().optional(),
	})
	.refine(
		(d) => {
			if (!d.type) return true;
			if (d.type === "command") return d.command !== undefined && d.command !== null;
			if (d.type === "http") return d.url !== undefined && d.url !== null;
			return true;
		},
		{
			message: "When changing hook type, the corresponding field (command/url) must be provided",
		},
	);
