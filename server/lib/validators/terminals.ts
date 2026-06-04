import { z } from "zod";

export const createTerminalSchema = z
	.object({
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		name: z.string().max(100).optional(),
		cols: z.number().int().min(10).max(500).optional(),
		rows: z.number().int().min(2).max(200).optional(),
	})
	.refine((d) => !(d.chapterId && d.narratorId), {
		message: "Only one of chapterId or narratorId may be provided",
	});

export const updateTerminalGraphStateSchema = z.object({
	graphOpened: z.boolean().optional(),
	graphX: z.number().finite().optional(),
	graphY: z.number().finite().optional(),
	graphWidth: z.number().finite().optional(),
	graphHeight: z.number().finite().optional(),
});

// === Terminal Tabs ===

export const createTerminalTabSchema = z
	.object({
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		name: z.string().min(1).max(100),
	})
	.refine((d) => (d.chapterId || d.narratorId) && !(d.chapterId && d.narratorId), {
		message: "Exactly one of chapterId or narratorId is required",
	});

export const updateTerminalTabSchema = z.object({
	name: z.string().min(1).max(100).optional(),
});

export const reorderTerminalTabsSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
});

// === Terminal View State ===

export const updateTerminalViewStateSchema = z
	.object({
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		layout: z.enum(["single", "split-h", "split-v", "triple", "quad"]).optional(),
		activeTabId: z.string().nullable().optional(),
		panelAssignments: z
			.record(z.string(), z.union([z.string(), z.array(z.string())]))
			.nullable()
			.optional(),
	})
	.refine((d) => d.chapterId || d.narratorId, {
		message: "Either chapterId or narratorId is required",
	});
