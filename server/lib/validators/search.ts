import { z } from "zod";

/** An instant in any form `Date.parse` accepts, normalized to the ISO form stored rows use. */
const isoTime = z
	.string()
	.max(64)
	.refine((value) => !Number.isNaN(Date.parse(value)), "Invalid time")
	.transform((value) => new Date(value).toISOString());

const id = z.string().min(1).max(64);

/** Query parameters shared by every global-search request. */
const searchBaseQuerySchema = z.object({
	q: z.string().max(1000).optional().default(""),
	/** `relevance` (default) or `time`; anything else reads as the default. */
	sort: z.string().max(32).optional(),
	/** Comma-separated content to add to the default scope; unknown names are ignored. */
	include: z.string().max(128).optional(),
	projectId: id.optional(),
	from: isoTime.optional(),
	to: isoTime.optional(),
	/** Only sessions the viewer owns. */
	mine: z.enum(["1", "true", "0", "false"]).optional(),
	/** `all` searches the full history even for a query of only short terms. */
	history: z.enum(["all", "recent"]).optional(),
	cursor: z.string().max(512).optional(),
});

export const searchSectionsQuerySchema = searchBaseQuerySchema.extend({
	/** Comma-separated sections; unknown names are ignored, none means all. */
	sections: z.string().max(128).optional(),
	/** Page size for each requested section. */
	limit: z.coerce.number().int().min(1).max(100).optional(),
	/** 1-based page of a single section, in place of `cursor`. */
	page: z.coerce.number().int().min(1).max(10_000).optional(),
});

export const searchSessionHitsQuerySchema = searchBaseQuerySchema.extend({
	limit: z.coerce.number().int().min(1).max(50).optional(),
});
