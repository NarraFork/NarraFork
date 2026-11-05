import { z } from "zod";

/** Request bodies of `/api/settings/provider-import/*` (docs/PROVIDER_IMPORT.md). */

export const providerImportFetchSchema = z.object({
	input: z.string().min(1).max(2000),
	/** Short links name an exact host; typed input may be a domain or shorthand. */
	exact: z.boolean().optional(),
});

/** The payload itself is validated by the shared whitelist, not here. */
export const providerImportPreviewSchema = z.object({ payload: z.unknown() });

/** Keys to verify before importing; same payload shape as preview. */
export const providerImportCheckSchema = z.object({ payload: z.unknown() });

export const providerImportCommitSchema = z.object({
	payload: z.unknown(),
	entries: z
		.array(
			z.object({
				action: z.enum(["add", "replace-key", "skip"]),
				/** Existing provider whose key is replaced (`replace-key`). */
				targetId: z.string().max(100).optional(),
				prefix: z.string().max(50).optional(),
				name: z.string().max(100).optional(),
				disabled: z.boolean().optional(),
			}),
		)
		.max(10),
});
