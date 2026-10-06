import { z } from "zod";

export const specFileQuerySchema = z.object({
	uri: z
		.string()
		.min(7) // "spec://x"
		.max(260)
		.refine((s) => s.startsWith("spec://"), { message: "uri must start with spec://" }),
});

export const updateSpecFileSchema = z.object({
	uri: z
		.string()
		.min(7)
		.max(260)
		.refine((s) => s.startsWith("spec://"), { message: "uri must start with spec://" }),
	content: z.string().max(200_000),
	baseRevisionId: z.string().max(120).nullable().optional(),
	notifyAgent: z.boolean().optional(),
});
