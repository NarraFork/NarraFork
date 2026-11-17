import { z } from "zod/v4";

const workspaceKey = z.string().min(1).max(256);
export const worktreeListQuerySchema = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).default(20),
		cursor: z.string().min(1).max(512).optional(),
		sort: z.enum(["lastCommitAt", "createdAt", "name"]).default("lastCommitAt"),
		order: z.enum(["asc", "desc"]).default("desc"),
		search: z.string().trim().max(512).default(""),
	})
	.strict();
export const worktreeListSchema = worktreeListQuerySchema.extend({ workspaceKey });
export const worktreeCreateSchema = z
	.object({
		expectedRevision: z.number().int().nonnegative(),
		workspaceKey,
		requestId: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[a-zA-Z0-9_-]+$/),
		destinationPath: z.string().min(1).max(4096),
		branch: z
			.object({ kind: z.enum(["new", "existing"]), name: z.string().min(1).max(256).optional() })
			.strict(),
		baseRef: z.string().min(1).max(256).optional(),
	})
	.strict()
	.refine((input) => input.branch.kind === "new" || input.baseRef === undefined, {
		message: "baseRef is only supported for a new branch",
	})
	.refine((input) => input.branch.kind === "new" || input.branch.name !== undefined, {
		message: "Existing branches require an explicit name",
	});
export const worktreePrepareSchema = z
	.object({
		expectedRevision: z.number().int().nonnegative(),
		workspaceKey,
		name: z.string().max(256).optional(),
		requirement: z.string().trim().max(2000).optional(),
		branchName: z.string().min(1).max(256).optional(),
		destinationPath: z.string().min(1).max(4096).optional(),
	})
	.strict()
	.refine(
		(input) => input.branchName !== undefined || !!input.name?.trim() || !!input.requirement,
		{
			message: "Provide a branch name or task requirement",
		},
	);
export type WorktreeCreateRequest = z.infer<typeof worktreeCreateSchema>;
const worktreeRemovalPath = z.string().min(1).max(4096);
/** No base ref: what counts as kept is never the caller's choice. */
export const worktreeRemovalQuerySchema = z
	.object({ workspaceKey, path: worktreeRemovalPath })
	.strict();
export const worktreeRemovalDiscardSchema = z
	.object({
		head: z
			.string()
			.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
			.nullable(),
		uncommittedFiles: z.number().int().nonnegative().max(1_000_000_000),
		unmergedCommits: z.number().int().nonnegative().max(1_000_000_000_000),
	})
	.strict();
export const worktreeRemoveSchema = worktreeRemovalQuerySchema
	.extend({
		deleteBranch: z.boolean().default(false),
		discard: worktreeRemovalDiscardSchema.optional(),
	})
	.strict();
