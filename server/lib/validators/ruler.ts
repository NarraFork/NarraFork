import { z } from "zod";

export const rulerMergeSchema = z.object({
	sourceChapterId: z.string().min(1),
	strategy: z.enum(["merge", "squash"]).default("merge"),
	message: z.string().max(500).optional(),
});

export const rulerAbandonSchema = z.object({
	chapterId: z.string().min(1),
});

export const rulerRebaseSchema = z.object({
	chapterId: z.string().min(1),
});

export const rulerRebaseResolveSchema = z.object({
	chapterId: z.string().min(1),
	action: z.enum(["abort", "continue"]),
});

export const updateRulerPositionsSchema = z.object({
	positions: z.array(
		z.object({
			chapterId: z.string().min(1),
			anchorCommitSha: z.string().min(1),
			axisOffset: z.number(),
			crossOffset: z.number().min(0),
			width: z.number().positive().optional(),
			height: z.number().positive().optional(),
		}),
	),
});
