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

export const setNarratorDeviceWorkspaceSchema = z.strictObject({
	requestId: z.string().trim().min(1).max(128),
	deviceId: z.string().trim().min(1).max(128),
	cwd: z.string().min(1).max(4096),
	expectedBindingRevision: z.number().int().nonnegative(),
	expectedSelectionRevision: z.number().int().nonnegative().optional(),
	expectedWorktreeKey: z.string().min(1).max(128).optional(),
});

export const selectNarratorDeviceWorkspaceSchema = z.strictObject({
	requestId: z.string().trim().min(1).max(128),
	deviceId: z.string().trim().min(1).max(128),
	expectedBindingRevision: z.number().int().positive(),
	expectedSelectionRevision: z.number().int().nonnegative(),
});

export const listNarratorDeviceWorkspacesSchema = z.strictObject({
	cursor: z.string().min(1).max(128).optional(),
	limit: z.coerce.number().int().min(1).max(32).optional(),
});
