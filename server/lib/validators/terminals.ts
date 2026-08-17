import { z } from "zod";

export const createTerminalSchema = z
	.object({
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		name: z.string().max(100).optional(),
		cols: z.number().int().min(10).max(500).optional(),
		rows: z.number().int().min(2).max(200).optional(),
		deviceId: z.string().min(1).optional(),
	})
	.refine((d) => !(d.chapterId && d.narratorId), {
		message: "Only one of chapterId or narratorId may be provided",
	});

// === Terminal Tabs: removed ===
//
// `createTerminalTabSchema` / `updateTerminalTabSchema` / `reorderTerminalTabsSchema` used
// to live here, validating the `/terminals/tabs` routes. Those routes, their service and
// the `terminal_tabs` table are gone — nothing ever called them. See `routes/terminals.ts`.

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
