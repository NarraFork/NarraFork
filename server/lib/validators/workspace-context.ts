import { z } from "zod/v4";

// Strip obsolete arguments from historical tool calls instead of rejecting the switch.
export const switchWorkingDirectorySchema = z.object({
	expectedRevision: z.number().int().nonnegative(),
	requestId: z.string().trim().min(1).max(128),
	target: z.strictObject({
		deviceId: z.string().trim().min(1).max(128),
		cwd: z.string().trim().min(1).max(4096),
	}),
});
