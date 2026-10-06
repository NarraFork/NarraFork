import { z } from "zod";

const slugSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens")
	.optional();

const controlledTagsSchema = z.array(z.string().min(1).max(64)).max(50);
const manifestSchema = z.record(z.string(), z.unknown());

/**
 * Pack metadata fields parsed from a multipart create request. The archive itself
 * arrives as a File part and is validated separately (type + size) in the service.
 * Numeric/JSON fields may arrive as strings in multipart, so coerce where needed.
 */
export const createKnowledgePackSchema = z.object({
	name: z.string().min(1).max(200),
	slug: slugSchema,
	description: z.string().max(2_000).optional(),
	projectId: z.string().optional(),
	entryId: z.string().optional(),
	classificationLevel: z.string().max(64).optional(),
	controlledTags: controlledTagsSchema.optional(),
	manifest: manifestSchema.optional(),
});

export const updateKnowledgePackSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2_000).nullable().optional(),
	entryId: z.string().nullable().optional(),
	classificationLevel: z.string().max(64).nullable().optional(),
	controlledTags: controlledTagsSchema.nullable().optional(),
	manifest: manifestSchema.nullable().optional(),
});

export const listKnowledgePacksQuerySchema = z.object({
	projectId: z.string().optional(),
	entryId: z.string().optional(),
});
