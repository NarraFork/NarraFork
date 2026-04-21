import { z } from "zod";

export const createExplorationGroupSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	baseChapterId: z.string().min(1),
	branches: z
		.array(
			z.object({
				title: z.string().min(1).max(200),
				description: z.string().max(2000).optional(),
				inheritMode: z.enum(["full", "compressed", "fresh"]).default("full"),
			}),
		)
		.min(2)
		.max(10),
});

export const updateExplorationGroupSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
});
