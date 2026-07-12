import { z } from "zod";
import { isSecureDirectDeviceUrl } from "../device-url";

/** Device slug: lowercase letters, digits, hyphen, underscore. */
export const deviceSlugSchema = z
	.string()
	.min(2)
	.max(64)
	.regex(/^[a-z0-9_-]+$/, "Slug may only contain lowercase letters, digits, '-' and '_'");

const directDeviceUrlSchema = z.string().url().max(2000).refine(isSecureDirectDeviceUrl, {
	message: "Direct device URL must use wss://, or ws:// with a loopback IP literal",
});

export const createRemoteDeviceSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		/** Optional explicit slug; generated from name when omitted. */
		slug: deviceSlugSchema.optional(),
		description: z.string().trim().max(2000).optional(),
		connectionMode: z.enum(["reverse", "direct"]).default("reverse"),
		/** Required when connectionMode === "direct". */
		directUrl: directDeviceUrlSchema.optional(),
		scope: z.enum(["global", "project"]).default("global"),
		/** Required when scope === "project". */
		projectId: z.string().trim().min(1).optional(),
	})
	.superRefine((data, ctx) => {
		if (data.connectionMode === "direct" && !data.directUrl) {
			ctx.addIssue({
				code: "custom",
				path: ["directUrl"],
				message: "directUrl is required for direct connection mode",
			});
		}
		if (data.scope === "project" && !data.projectId) {
			ctx.addIssue({
				code: "custom",
				path: ["projectId"],
				message: "projectId is required for project scope",
			});
		}
	});

export const updateRemoteDeviceSchema = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().trim().max(2000).nullable().optional(),
	connectionMode: z.enum(["reverse", "direct"]).optional(),
	directUrl: directDeviceUrlSchema.nullable().optional(),
	scope: z.enum(["global", "project"]).optional(),
	projectId: z.string().trim().min(1).nullable().optional(),
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
