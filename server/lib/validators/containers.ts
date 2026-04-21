import { z } from "zod";

export const containerRemoveSchema = z.object({
	deleteVolumes: z.boolean().optional(),
});

// === Volume Snapshots ===

export const createVolumeSnapshotSchema = z.object({
	chapterId: z.string().min(1),
	serviceName: z.string().min(1).max(200),
	containerPath: z
		.string()
		.min(1)
		.max(1000)
		.refine((p) => p.startsWith("/"), "Container path must be absolute")
		.refine((p) => !p.includes(".."), "Container path must not contain '..'"),
	name: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
});

export const applyVolumeSnapshotSchema = z.object({
	targetChapterId: z.string().min(1),
});

export const updateVolumeSnapshotSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).nullable().optional(),
});
