import { worktreeListPreview } from "@shared/narrator-worktrees";
import { z } from "zod/v4";
import type { NarratorPrincipal } from "../../../services/narrator-acl";
import type { NarratorWorktreeService } from "../../../services/narrator-worktree-service";
import { AppError } from "../../errors";
import { worktreeCreateSchema, worktreeListSchema } from "../../validators/narrator-worktrees";
import { zodToJsonSchema } from "../tool-registry";
import type { ToolContext, ToolDefinition } from "../types";

export const worktreeToolSchema = z.discriminatedUnion("action", [
	worktreeListSchema.extend({ action: z.literal("list") }),
	worktreeCreateSchema.safeExtend({ action: z.literal("create") }),
	worktreeCreateSchema.safeExtend({ action: z.literal("reconcile") }),
]);

/** HTTP and tools use the exact same authorization, revision guard, repository lock and receipts. */
export function createWorktreeTool<Principal>(
	service: Pick<NarratorWorktreeService<Principal>, "list" | "create" | "reconcileRequest">,
	principalOf: (context: ToolContext) => Promise<Principal>,
): ToolDefinition {
	return {
		name: "Worktree",
		description:
			"List, create or reconcile linked Git worktrees for the current narrator repository on its selected device. " +
			"Creation does not switch directories or copy uncommitted source changes. " +
			"Supply the current workspaceKey and revision, a unique requestId, an absolute destination " +
			"inside the authorized repository root with an existing non-symlink parent, and a new/existing branch. " +
			"A new branch name may be omitted: the summary model generates and durably freezes it; naming failures are explicit. Existing branches require a name. " +
			"Reuse the same requestId with the exact same proposal after disconnects. " +
			"A result of unknown is NOT proof of failure: never blindly retry with a new ID or clean up. " +
			"Remote creation requires git.worktree.v1. Use reconcile after an unknown result, with the exact original proposal. Removal and pruning are unsupported.",
		parameters: worktreeToolSchema,
		// Providers/gateways may discard parameters of a root anyOf schema. Advertise
		// a flat object, but keep the discriminated union for strict execution validation.
		rawJsonSchema: zodToJsonSchema(
			z.object({
				...worktreeCreateSchema.shape,
				action: z.enum(["list", "create", "reconcile"]),
				expectedRevision: worktreeCreateSchema.shape.expectedRevision
					.optional()
					.describe("Required for create: current workspace revision."),
				requestId: worktreeCreateSchema.shape.requestId
					.optional()
					.describe("Required for create: unique request ID; reuse on retries."),
				destinationPath: worktreeCreateSchema.shape.destinationPath
					.optional()
					.describe("Required for create: absolute destination inside the repository root."),
				branch: worktreeCreateSchema.shape.branch
					.optional()
					.describe("Required for create: new/existing branch; existing requires name."),
			}),
		),
		executionRouting: {
			kind: "single",
			resolve: (input) => ({
				key: "worktree",
				operation: input.action === "create" ? "write" : "read",
				...(input.action === "create" ? { path: String(input.destinationPath ?? "") } : {}),
			}),
		},
		async execute(args, ctx) {
			try {
				const input = worktreeToolSchema.parse(args);
				ctx.assertWorkspaceCurrent?.();
				const principal = await principalOf(ctx);
				const { action, ...request } = input;
				if (action === "reconcile" && !service.reconcileRequest)
					throw new AppError("Worktree receipt recovery unavailable", 409, "WORKTREE_UNSUPPORTED");
				const result =
					action === "list"
						? await service.list(principal, ctx.narratorId, request, ctx.signal)
						: action === "reconcile"
							? await service.reconcileRequest(principal, ctx.narratorId, request, ctx.signal)
							: await service.create(principal, ctx.narratorId, request, ctx.signal);
				return {
					output: JSON.stringify(result),
					...("outcome" in result
						? { isError: result.outcome !== "created" }
						: { metadata: { workspaceWorktrees: worktreeListPreview(result) } }),
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
		reconcileRequest: async (...args) =>
			(
				await import("../../../services/narrator-worktree-runtime")
			).narratorWorktreeService.reconcileRequest(...args),
	},
	async (ctx) =>
		(await import("../../../services/narrator-worktree-runtime")).narratorWorktreePrincipalForTool(
			ctx,
		),
);
