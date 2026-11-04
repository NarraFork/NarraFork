import { createHash } from "node:crypto";
import { type WorktreeCreateResult, worktreeListPreview } from "@shared/narrator-worktrees";
import type { WorkspaceContext } from "@shared/workspace-context";
import { z } from "zod/v4";
import type { NarratorPrincipal } from "../../../services/narrator-acl";
import type { NarratorWorktreeService } from "../../../services/narrator-worktree-service";
import { AppError } from "../../errors";
import { worktreeCreateSchema, worktreeListSchema } from "../../validators/narrator-worktrees";
import { ensureNonEmptySchema, zodToJsonSchema } from "../tool-registry";
import type { ToolContext, ToolDefinition } from "../types";

const listParameters = z.strictObject({
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Page size; defaults to 20, maximum 100."),
	cursor: z
		.string()
		.min(1)
		.max(512)
		.optional()
		.describe("Use nextCursor from the previous page with the same search and sorting."),
	sort: z
		.enum(["lastCommitAt", "createdAt", "name"])
		.optional()
		.describe("Sort field; defaults to lastCommitAt. Unknown times are placed last."),
	order: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to desc."),
	search: z
		.string()
		.trim()
		.max(512)
		.optional()
		.describe("Search all worktree branch names and paths, not just the current page."),
	confirm: z
		.literal(true)
		.optional()
		.describe("Compatibility parameter: pass true if required by the provider."),
});
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
		// Preserve historical execution/recovery without advertising the old protocol.
		isAvailable: () => false,
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
		// Providers/gateways may discard parameters of a root anyOf schema. Advertise
		// a flat object, but keep the discriminated union for strict execution validation.
		rawJsonSchema: zodToJsonSchema(
			z.object({
				...worktreeCreateSchema.shape,
				limit: listParameters.shape.limit,
				cursor: listParameters.shape.cursor,
				sort: listParameters.shape.sort,
				order: listParameters.shape.order,
				search: listParameters.shape.search,
				action: z.enum(["list", "create"]),
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
	},
	async (ctx) =>
		(await import("../../../services/narrator-worktree-runtime")).narratorWorktreePrincipalForTool(
			ctx,
		),
);

const branchName = z
	.string()
	.min(1)
	.max(256)
	.describe("Explicit Git branch name (without refs/heads/).");
const destinationPath = z
	.string()
	.min(1)
	.max(4096)
	.describe(
		"Absolute normalized destination inside the current repository root. Its non-symlink parent must exist; destination must not exist.",
	);
const switchToWorktree = z
	.boolean()
	.optional()
	.describe(
		"Also make the new worktree this narrator's working directory, instead of a separate SwitchWorkingDirectory call. Requires a switch-capable local primary narrator; a successful switch ends the current pass.",
	);
export const createWorktreeParameters = z.strictObject({
	branchName,
	destinationPath,
	baseRef: z
		.string()
		.min(1)
		.max(256)
		.optional()
		.describe(
			"Starting commit/ref for the new branch. Defaults to HEAD; resolved once and frozen before creation.",
		),
	switchToWorktree,
});
export const attachWorktreeParameters = z.strictObject({
	branchName,
	destinationPath,
	switchToWorktree,
});
export const getWorktreeOperationParameters = z.strictObject({
	operationId: z
		.string()
		.regex(/^wt1_[a-f0-9]{64}$/)
		.describe(
			"Copy the operationId returned by CreateWorktree or AttachWorktree. Never invent one.",
		),
});

/** This error is produced before execution, including by the shared executor. */
function formatWorktreeValidationError(error: z.ZodError): string {
	return JSON.stringify({
		error: {
			code: "INVALID_ARGUMENT",
			fields: error.issues.slice(0, 8).map((issue) => ({
				field: issue.path.map(String).join(".").slice(0, 128) || "input",
				problem: issue.code,
				...(issue.code === "invalid_type" ? { expected: issue.expected } : {}),
			})),
			message:
				"Provide the required fields with the types shown in this tool's schema. Do not supply workspaceKey, revision, action or requestId.",
		},
		dispatched: false,
		nextAction:
			"Correct the arguments and call this tool again. Creation requires branchName and destinationPath; recovery requires the returned operationId.",
	});
}

function agentInputJsonSchema(parameters: z.ZodType, needsCompatibilityParameter: boolean) {
	// Native conversion preserves regexes and bounds; no root union is needed for intent inputs.
	const { $schema: _dialect, ...schema } = z.toJSONSchema(parameters);
	return needsCompatibilityParameter ? ensureNonEmptySchema(schema) : schema;
}
type AgentWorktreeService<Principal> = Pick<
	NarratorWorktreeService<Principal>,
	"list" | "create" | "getOperation"
>;

/** Intent-only inputs. Concurrency and receipt identities are frozen host data, not model input. */
export function createAgentWorktreeTools<Principal>(
	service: AgentWorktreeService<Principal>,
	principalOf: (context: ToolContext) => Promise<Principal>,
): ToolDefinition[] {
	const definitions = [
		{
			name: "ListWorktrees",
			parameters: listParameters,
			description:
				"List linked Git worktrees for the current local repository. Defaults to 20 entries sorted by last commit time descending. Supports sorting, search and cursor pagination; pass nextCursor to read more. Read-only; does not create or switch directories.",
		},
		{
			name: "CreateWorktree",
			parameters: createWorktreeParameters,
			description:
				"Create a worktree with a NEW explicitly named Git branch. Supply branchName and absolute destinationPath; baseRef defaults to HEAD. Parent directory must exist. Does not copy uncommitted changes, and does not switch directories unless switchToWorktree is true. The host binds the current workspace and a durable operation ID. If outcome is unknown, call GetWorktreeOperation with the returned operationId; do not create again or delete residuals.",
		},
		{
			name: "AttachWorktree",
			parameters: attachWorktreeParameters,
			description:
				"Create a worktree by checking out an EXISTING local branch that is not already checked out. Supply branchName and absolute destinationPath. Parent directory must exist. Does not create a new branch or copy uncommitted changes; switches directories only when switchToWorktree is true. If outcome is unknown, call GetWorktreeOperation with the returned operationId; do not create again or delete residuals.",
		},
		{
			name: "GetWorktreeOperation",
			parameters: getWorktreeOperationParameters,
			description:
				"Read and reconcile an existing worktree operation using its returned operationId. Never creates a worktree or dispatches a creation command. Recovery requires the original actor, local device, repository and currently authorized destination scope. A missing receipt or unknown outcome is not permission to recreate or clean up.",
		},
	];
	return definitions.map(
		({ name, parameters, description }): ToolDefinition => ({
			name,
			description,
			parameters,
			rawJsonSchema: agentInputJsonSchema(parameters, name === "ListWorktrees"),
			formatValidationError: formatWorktreeValidationError,
			executionRouting: {
				kind: "single",
				resolve: (input) => ({
					key: "worktree",
					operation: name === "CreateWorktree" || name === "AttachWorktree" ? "write" : "read",
					...(name === "CreateWorktree" || name === "AttachWorktree"
						? { path: String(input.destinationPath ?? "") }
						: {}),
				}),
			},
			async execute(args, ctx) {
				let operationId: string | undefined;
				let enteredService = false;
				try {
					const input = parameters.safeParse(args);
					if (!input.success)
						return { isError: true, output: formatWorktreeValidationError(input.error) };
					ctx.assertWorkspaceCurrent?.();
					const workspace = ctx.workspaceContext;
					if (
						!workspace ||
						workspace.deviceId !== "local" ||
						(ctx.executionTarget && ctx.executionTarget.deviceId !== "local") ||
						!workspace.git?.workspaceKey ||
						!workspace.git.repositoryKey ||
						!Number.isSafeInteger(workspace.revision) ||
						workspace.revision < 0
					)
						throw new AppError(
							"A frozen local Git workspace context is required; refresh the session before retrying.",
							409,
							"WORKTREE_CONTEXT_REQUIRED",
						);
					const principal = await principalOf(ctx);
					if (name === "ListWorktrees") {
						enteredService = true;
						const { confirm: _confirm, ...query } = listParameters.parse(input.data);
						const result = await service.list(
							principal,
							ctx.narratorId,
							{ ...query, workspaceKey: workspace.git.workspaceKey },
							ctx.signal,
						);
						return {
							output: JSON.stringify(result),
							metadata: { workspaceWorktrees: worktreeListPreview(result) },
						};
					}
					if (name === "GetWorktreeOperation") {
						operationId = (input.data as { operationId: string }).operationId;
						enteredService = true;
						const result = await service.getOperation(
							principal,
							ctx.narratorId,
							operationId,
							ctx.signal,
						);
						return operationResult(operationId, result);
					}
					if (!ctx.userId)
						throw new AppError(
							"An authenticated actor is required",
							403,
							"WORKTREE_ACTOR_REQUIRED",
						);
					const intent = input.data as z.infer<typeof createWorktreeParameters>;
					// Resolved before Git runs: an impossible switch must not leave a worktree behind.
					const switchDirectory =
						intent.switchToWorktree === true ? requireSwitchDirectory(ctx, workspace) : undefined;
					const request = {
						workspaceKey: workspace.git.workspaceKey,
						expectedRevision: workspace.revision,
						destinationPath: intent.destinationPath,
						branch: {
							kind: name === "CreateWorktree" ? ("new" as const) : ("existing" as const),
							name: intent.branchName,
						},
						...(name === "CreateWorktree" ? { baseRef: intent.baseRef ?? "HEAD" } : {}),
					};
					// Logical operation identity survives new provider tool-call IDs. Never use live context here.
					operationId = `wt1_${createHash("sha256")
						.update(
							JSON.stringify([
								"worktree-intent-v1",
								ctx.narratorId,
								ctx.userId,
								workspace.deviceId,
								workspace.git.repositoryKey,
								request.workspaceKey,
								request.expectedRevision,
								request.branch.kind,
								request.branch.name,
								request.destinationPath,
								request.baseRef ?? null,
							]),
						)
						.digest("hex")}`;
					enteredService = true;
					const result = await service.create(
						principal,
						ctx.narratorId,
						{ ...request, requestId: operationId },
						ctx.signal,
					);
					return operationResult(
						operationId,
						result,
						switchDirectory
							? await switchToCreatedWorktree(switchDirectory, workspace, result, operationId)
							: undefined,
					);
				} catch (cause) {
					const code = cause instanceof AppError ? cause.code : "WORKTREE_REQUEST_FAILED";
					return {
						isError: true,
						output: JSON.stringify({
							...(operationId ? { operationId } : {}),
							error: {
								code,
								message:
									cause instanceof AppError
										? cause.message.slice(0, 1024)
										: "Worktree request failed; the execution outcome is not established.",
							},
							...(!enteredService ? { dispatched: false } : {}),
							nextAction:
								code === "WORKTREE_REQUEST_NOT_FOUND"
									? "No receipt was found. Verify the original operationId; do not infer that creation never happened."
									: code === "WORKTREE_SWITCH_UNSUPPORTED"
										? "Nothing was created. Retry without switchToWorktree, or call SwitchWorkingDirectory from a switch-capable primary narrator after creation."
										: operationId
											? "Do not recreate or clean up. Query GetWorktreeOperation with this operationId; restore the original authorized scope if recovery is denied."
											: "Check arguments, authorization and the current workspace; refresh the session if its context is stale.",
						}),
					};
				}
			},
		}),
	);
}

/** Whether the requested switch happened, and why not when it did not. */
interface WorktreeSwitchOutcome {
	switched: boolean;
	error?: { code: string; message: string };
}

/**
 * Resolve the switch port, or refuse before Git runs: creating a worktree this
 * caller can never work in is a durable side effect nobody asked for.
 */
function requireSwitchDirectory(
	ctx: ToolContext,
	workspace: WorkspaceContext,
): NonNullable<ToolContext["switchWorkingDirectory"]> {
	if (!ctx.switchWorkingDirectory || !workspace.capabilities.switchDirectory)
		throw new AppError(
			"This runtime cannot switch the narrator working directory; omit switchToWorktree, or create the worktree here and call SwitchWorkingDirectory from a switch-capable primary narrator.",
			409,
			"WORKTREE_SWITCH_UNSUPPORTED",
		);
	return ctx.switchWorkingDirectory;
}

/**
 * Reuses the ordinary workspace transition — same admission, CAS, publication and
 * pass-ending behaviour as a separate SwitchWorkingDirectory call, without spending
 * another tool call. That transition is idempotent by itself (a context already at
 * the target returns changed:false), so any result that does not throw leaves this
 * narrator working in the created worktree. A failed switch never disguises the
 * creation that already succeeded, and is never retried here.
 */
async function switchToCreatedWorktree(
	switchDirectory: NonNullable<ToolContext["switchWorkingDirectory"]>,
	workspace: WorkspaceContext,
	result: WorktreeCreateResult,
	operationId: string,
): Promise<WorktreeSwitchOutcome | undefined> {
	// Nothing was created, so there is nothing to switch to: recovery guidance owns this outcome.
	if (result.outcome !== "created" || !result.worktree) return undefined;
	try {
		await switchDirectory({
			expectedRevision: workspace.revision,
			// Derived from the creation identity so one intent has one switch id in the logs.
			requestId: `switch-${operationId}`,
			target: { deviceId: workspace.deviceId, cwd: result.worktree.path },
		});
		return { switched: true };
	} catch (cause) {
		return {
			switched: false,
			error: {
				code: cause instanceof AppError ? cause.code : "WORKTREE_SWITCH_FAILED",
				message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1024),
			},
		};
	}
}

function nextActionFor(
	outcome: WorktreeCreateResult["outcome"],
	worktreeSwitch?: WorktreeSwitchOutcome,
): string {
	if (outcome === "unknown")
		return "Query GetWorktreeOperation with this operationId. Do not recreate or clean up.";
	if (outcome !== "created")
		return "This operation failed. Inspect the error and residuals before making a corrected request; do not blindly retry or clean up.";
	if (!worktreeSwitch)
		return "Worktree created; cwd unchanged. SwitchWorkingDirectory if this narrator will work there (visible git stats follow cwd). Pass the path as Agent workdir to assign it to a subagent without switching.";
	return worktreeSwitch.switched
		? "Worktree created and the working directory switched to it. This pass ends; the next pass starts in the new worktree."
		: "Worktree created, but the switch did not complete. Do not recreate it. Check this session's workspace state, then switch to this path with SwitchWorkingDirectory or pass it as Agent workdir.";
}

function operationResult(
	operationId: string,
	result: WorktreeCreateResult,
	worktreeSwitch?: WorktreeSwitchOutcome,
) {
	return {
		isError: result.outcome !== "created",
		output: JSON.stringify({
			...result,
			operationId,
			...(worktreeSwitch ? { switch: worktreeSwitch } : {}),
			nextAction: nextActionFor(result.outcome, worktreeSwitch),
		}),
	};
}

export const agentWorktreeTools = createAgentWorktreeTools<NarratorPrincipal>(
	{
		list: async (...args) =>
			(await import("../../../services/narrator-worktree-runtime")).narratorWorktreeService.list(
				...args,
			),
		create: async (...args) =>
			(await import("../../../services/narrator-worktree-runtime")).narratorWorktreeService.create(
				...args,
			),
		getOperation: async (...args) =>
			(
				await import("../../../services/narrator-worktree-runtime")
			).narratorWorktreeService.getOperation(...args),
	},
	async (ctx) =>
		(await import("../../../services/narrator-worktree-runtime")).narratorWorktreePrincipalForTool(
			ctx,
		),
);
