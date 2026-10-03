import { z } from "zod/v4";

export const switchWorkingDirectorySchema = z.strictObject({
	expectedRevision: z.number().int().nonnegative(),
	requestId: z.string().trim().min(1).max(128),
	target: z.strictObject({
		deviceId: z.string().trim().min(1).max(128),
		cwd: z.string().trim().min(1).max(4096),
	}),
	expectedWorktreeKey: z.string().min(1).max(128).optional(),
});
