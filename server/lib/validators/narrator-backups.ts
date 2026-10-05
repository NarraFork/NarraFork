import { z } from "zod";

const id = z.string().min(1).max(200);
const mapping = z
	.record(z.string().min(1).max(4096), z.string().min(1).max(4096))
	.refine((value) => Object.keys(value).length <= 1000, "Mapping limit exceeded");
export const narratorBackupRequestSchema = z
	.object({
		narratorIds: z.array(id).min(1).max(100),
		profile: z.enum(["conversation-state-v1", "conversation-tree-v1"]),
	})
	.strict();
export const narratorRestoreRequestSchema = z
	.object({
		artifactId: z.string().uuid(),
		mapping: z
			.object({
				users: mapping.optional(),
				devices: mapping.optional(),
				paths: mapping.optional(),
				projects: mapping.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
