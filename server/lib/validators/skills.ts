import { z } from "zod";

const skillContentSchema = z.string().max(200_000).optional().default("");

export const createProjectSkillSchema = z.object({
	name: z.string().max(100),
	description: z.string().max(2_000),
	content: skillContentSchema,
});

export const updateProjectSkillSchema = z.object({
	name: z.string().max(100).optional(),
	description: z.string().max(2_000),
	content: skillContentSchema,
});
