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
const worktreePath = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => !value.includes("\0"), {
		message: "path must not contain NUL",
	});
export const worktreeRemovalPlanSchema = z
	.object({
		workspaceKey,
		path: worktreePath,
	})
	.strict();
export const worktreeRemovalRequestSchema = z
	.object({
		expectedRevision: z.number().int().nonnegative(),
		workspaceKey,
		path: worktreePath,
		force: z.boolean().optional(),
		confirmedLoss: z
			.object({
				head: z.string().max(128).nullable(),
				dirtyFileCount: z.number().int().nonnegative().max(1_000_000_000),
				unreachableCommits: z.number().int().nonnegative().max(1_000_000_000_000),
			})
			.strict()
			.optional(),
		acknowledgeUnregistered: z.boolean().optional(),
	})
	.strict()
	.refine((input) => !input.force || input.confirmedLoss !== undefined, {
		message: "force must carry the confirmed loss",
	});
export type WorktreeCreateRequest = z.infer<typeof worktreeCreateSchema>;
export type WorktreeRemovalPlanRequest = z.infer<typeof worktreeRemovalPlanSchema>;
export type WorktreeRemovalRequest = z.infer<typeof worktreeRemovalRequestSchema>;
