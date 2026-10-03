import { z } from "zod/v4";
import type { NarratorPrincipal } from "../../../services/narrator-acl";
import type { NarratorWorktreeService } from "../../../services/narrator-worktree-service";
import { AppError } from "../../errors";
import { worktreeCreateSchema, worktreeListSchema } from "../../validators/narrator-worktrees";
import type { ToolContext, ToolDefinition } from "../types";

export const worktreeToolSchema = z.discriminatedUnion("action", [
	worktreeListSchema.extend({ action: z.literal("list") }),
	worktreeCreateSchema.safeExtend({ action: z.literal("create") }),
]);

/** HTTP and tools use the exact same authorization, revision guard, repository lock and receipts. */
export function createWorktreeTool<Principal>(
	service: Pick<NarratorWorktreeService<Principal>, "list" | "create">,
	principalOf: (context: ToolContext) => Promise<Principal>,
): ToolDefinition {
	return {
		name: "Worktree",
		description:
			"List or create linked Git worktrees for the current local narrator repository. " +
			"Creation does not switch directories or copy uncommitted source changes. " +
			"Supply the current workspaceKey and revision, a unique requestId, an absolute destination " +
			"inside the authorized repository root with an existing non-symlink parent, and a new/existing branch. " +
			"A new branch name may be omitted: the summary model generates and durably freezes it; naming failures are explicit. Existing branches require a name. " +
			"Reuse the same requestId with the exact same proposal after disconnects. " +
			"A result of unknown is NOT proof of failure: never blindly retry with a new ID or clean up. " +
			"Remote execution, removal and pruning are unsupported.",
		parameters: worktreeToolSchema,
		executionRouting: {
			kind: "single",
			resolve: (input) => ({
				key: "worktree",
				operation: input.action === "list" ? "read" : "write",
				...(input.action === "create" ? { path: String(input.destinationPath ?? "") } : {}),
			}),
		},
		async execute(args, ctx) {
			try {
				const input = worktreeToolSchema.parse(args);
				ctx.assertWorkspaceCurrent?.();
				const principal = await principalOf(ctx);
				const { action, ...request } = input;
				const result =
					action === "list"
						? await service.list(principal, ctx.narratorId, request, ctx.signal)
						: await service.create(principal, ctx.narratorId, request, ctx.signal);
				return {
					output: JSON.stringify(result),
					...("outcome" in result ? { isError: result.outcome !== "created" } : {}),
				};
			} catch (cause) {
				return {
					output: JSON.stringify({
						error: {
							code: cause instanceof AppError ? cause.code : "WORKTREE_REQUEST_FAILED",
							message:
								cause instanceof AppError
									? cause.message
									: "Worktree request failed before execution",
						},
					}),
					isError: true,
				};
			}
		},
	};
}

/** Lazy production adapter avoids importing the runtime/session graph while registering tools. */
export const worktreeTool: ToolDefinition = createWorktreeTool<NarratorPrincipal>(
	{
		list: async (...args) =>
			(await import("../../../services/narrator-worktree-runtime")).narratorWorktreeService.list(
				...args,
			),
		create: async (...args) =>
			(await import("../../../services/narrator-worktree-runtime")).narratorWorktreeService.create(
				...args,
			),
	},
	async (ctx) =>
		(await import("../../../services/narrator-worktree-runtime")).narratorWorktreePrincipalForTool(
			ctx,
		),
);
