import { z } from "zod";

/** Device slug: lowercase letters, digits, hyphen, underscore. */
export const deviceSlugSchema = z
	.string()
	.min(2)
	.max(64)
	.regex(/^[a-z0-9_-]+$/, "Slug may only contain lowercase letters, digits, '-' and '_'");

export const createRemoteDeviceSchema = z.object({
	name: z.string().min(1).max(120),
	/** Optional explicit slug; generated from name when omitted. */
	slug: deviceSlugSchema.optional(),
	description: z.string().max(2000).optional(),
	connectionMode: z.enum(["reverse", "direct"]).default("reverse"),
	/** Required when connectionMode === "direct". */
	directUrl: z.string().url().max(2000).optional(),
	scope: z.enum(["global", "project"]).default("global"),
	/** Required when scope === "project". */
	projectId: z.string().optional(),
});

export const updateRemoteDeviceSchema = z.object({
	name: z.string().min(1).max(120).optional(),
	description: z.string().max(2000).nullable().optional(),
	connectionMode: z.enum(["reverse", "direct"]).optional(),
	directUrl: z.string().url().max(2000).nullable().optional(),
	scope: z.enum(["global", "project"]).optional(),
	projectId: z.string().nullable().optional(),
});

export const deviceTransferSchema = z.object({
	direction: z.enum(["download", "upload"]),
	remotePath: z.string().min(1).max(4096),
	localPath: z.string().min(1).max(4096),
	recursive: z.boolean().optional(),
});

export const deviceStatQuerySchema = z.object({
	path: z.string().min(1).max(4096),
	recursive: z.boolean().optional(),
});
