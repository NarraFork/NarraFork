import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@shared/reasoning-effort";
import { isSubagentReasoningEffort, SUBAGENT_POOL_TYPES } from "@shared/subagent-model-policy";
import { z } from "zod/v4";
import { isCheckpointStop } from "../../../services/agent-runtime/checkpoint-stop";
import { resolvePath } from "../../platform-path";
import { expandAllowedPoolForDisplay, getSubagentVisibleModels, settings } from "../../settings";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

const TAKEOVER_BY_USER_DESCRIPTION =
	"Set to true to create this subagent directly in user takeover mode for further human interaction. " +
	"The Agent call returns immediately without requiring run_in_background. The initial prompt still runs, " +
	"but completion does not notify or wake the parent; the subagent stays taken over until the user explicitly ends takeover. " +
	"Do not automatically Watch this agent.";

const REASONING_EFFORT_DESCRIPTION =
	'Reasoning/thinking effort for this subagent. Use "none" to disable thinking where supported. ' +
	'Valid values: "none", "low", "medium", "high", "xhigh", "max" ("max" is only honored by some providers like DeepSeek; other providers clamp it down). ' +
	"If the selected model/provider does not support configurable thinking intensity, this option is ignored. " +
	"A fixed reasoning effort configured in the matching model pool overrides this parameter.";

const TASK_DESCRIPTION =
	"An outline task to hand to this agent, in a session whose tasks live in the outline: its address (an id, key/id, an alias or its title). " +
	"The agent's instructions are written from the task's tree, so prompt may be left out; when given, it is added as further instructions. " +
	"While the agent works the task is its own; its report is attached under the task when it finishes, and the task comes back to you, still in progress. " +
	"Not available in other sessions.";

const ISOLATION_DESCRIPTION =
	'Team coordinators only: "worktree" creates a team work item (its own branch from the team\'s base and its own worktree) and starts the agent there (default subagent_type "worker"). ' +
	"When that run ends with no commit and no uncommitted change, the worktree is removed and the item cancelled; otherwise the item stays in progress. Not combinable with workdir.";

const TITLE_DESCRIPTION =
	"With isolation \"worktree\": the work item's title (also names its branch; a title without English words leaves the branch to description's English words). Defaults to description.";

// Use text import so the bundler inlines the file content at build time
import baseDescription from "./task.txt" with { type: "text" };

/** Build a dynamic model list string from all visible models. */
function getAvailableModelsList(): string {
	const models = getSubagentVisibleModels().slice().sort();
	if (models.length > 0) {
		return models.join(", ");
	}
	return "(no models configured yet)";
}

function filterSubagentModels(models: string[]): string[] {
	const visible = new Set(getSubagentVisibleModels());
	return models.filter((model) => visible.has(model));
}

const MODEL_PARAM_BASE =
	"Override the model for this subagent. Without an explicit model, a configured allowed model pool selects its first entry and pins the child independently. Without a pool, a selected per-type/custom model preference pins the child; otherwise it follows the parent narrator's current model, including later switches when resumed or before the next model request. Explicit models must also be allowed by the pool. " +
	"`<provider>:<model>` pins that provider; `auto:<model>` lets NarraFork choose any provider that serves the model.";

/** Dynamic prompt context only; never used to construct tool definitions. */
export function buildSubagentModelContext(
	config?: Pick<AgentConfig, "subagentModelRestrictionDescription">,
): string {
	// Per-narrator custom restriction trait takes precedence and already describes the pools.
	if (config?.subagentModelRestrictionDescription) {
		return `${MODEL_PARAM_BASE}\n\n${config.subagentModelRestrictionDescription}`;
	}

	// Global per-type pool restriction (settings.agent.subagentAllowedModels).
	const pools = settings.agent.subagentAllowedModels;
	const restrictedParts: string[] = [];
	const unrestrictedTypes: string[] = [];
	if (pools) {
		for (const type of SUBAGENT_POOL_TYPES) {
			const pool = pools[type];
			if (pool && pool.length > 0) {
				const availablePool = filterSubagentModels(pool);
				const efforts = settings.agent.subagentModelReasoningEfforts?.[type];
				// Keep the old compact display untouched when this pool has no fixed tiers.
				const models = availablePool.some((model) => isSubagentReasoningEffort(efforts?.[model]))
					? availablePool.map((model) => {
							const display = expandAllowedPoolForDisplay([model]).join(", ");
							const effort = efforts?.[model];
							return isSubagentReasoningEffort(effort)
								? `${display} [fixed reasoning_effort=${effort}]`
								: display;
						})
					: expandAllowedPoolForDisplay(availablePool);
				restrictedParts.push(`${type}: ${models.join(", ")}`);
			} else {
				unrestrictedTypes.push(type);
			}
		}
	}

	// No restriction configured at all — list every visible model.
	if (restrictedParts.length === 0) {
		return `${MODEL_PARAM_BASE} Available models: ${getAvailableModelsList()}`;
	}

	// At least one type is restricted: describe the allowed pool per type instead of
	// dumping every visible model (which would be misleading).
	let note = `${MODEL_PARAM_BASE}\n\nNote: Subagent model selection is restricted per type. Allowed models — ${restrictedParts.join("; ")}. Models outside the pool for a given type will be ignored.`;
	if (unrestrictedTypes.length > 0) {
		note += ` For ${unrestrictedTypes.join(", ")} (not restricted), any available model may be used: ${getAvailableModelsList()}.`;
	}
	return note;
}

function buildParameters() {
	return z.preprocess(
		(input, ctx) => {
			// Check the original input before unknown object fields can be stripped.
			if (input && typeof input === "object" && Object.hasOwn(input, "stop")) {
				ctx.addIssue({
					code: "custom",
					path: ["stop"],
					message: 'Agent no longer accepts stop. Use Stop({ type: "agent", id }) instead.',
				});
			}
			return input;
		},
		z.object({
			description: z
				.string()
				.optional()
				.describe(
					"A short (3-5 word) description of the task (required when launching a new agent)",
				),
			subagent_type: z
				.string()
				.optional()
				.describe(
					'The type of specialized agent to use for this task. Built-in types: "explore" (read-only codebase exploration), "plan" (architecture planning, only in plan mode), "general" (full write access), "worker" (general plus Terminal, Browser and its own helper agents, which cannot launch further agents). You can also use any custom subagent type name defined by the user.',
				),
			run_in_background: z
				.boolean()
				.optional()
				.describe(
					"Set to true to run this agent in the background. You will be notified when it completes.",
				),
			takeover_by_user: z.boolean().optional().describe(TAKEOVER_BY_USER_DESCRIPTION),
			timeout: looseNumber(
				"Optional execution timeout for this subagent in milliseconds. Background runs default to 5 hours when omitted; use 0 for no wall-clock limit or provide any positive safe integer. This controls the Agent run itself, not Watch waiting.",
			),
			model: z.string().optional().describe(MODEL_PARAM_BASE),
			reasoning_effort: z
				.enum(REASONING_EFFORT_VALUES)
				.optional()
				.describe(REASONING_EFFORT_DESCRIPTION),
			workdir: z
				.string()
				.optional()
				.describe(
					"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
				),
			prompt: z
				.string()
				.optional()
				.describe("The task for the agent to perform (required when launching a new agent)"),
			task: z.string().optional().describe(TASK_DESCRIPTION),
			isolation: z.enum(["worktree"]).optional().describe(ISOLATION_DESCRIPTION),
			title: z.string().max(200).optional().describe(TITLE_DESCRIPTION),
			alias: z
				.string()
				.optional()
				.describe(
					'A short human-readable alias for this background task (e.g. "run-tests", "build-frontend"). ' +
						"Must be unique within the current session. If omitted, an alias is auto-generated from the description. " +
						"Use this alias with Watch or Send to reference the task later.",
				),

			archive: z
				.string()
				.optional()
				.describe(
					"Archive a subagent by its ID or alias. When provided, no new agent is launched. " +
						"Running work is stopped first. Archived subagents are excluded from TeamStatus " +
						"broadcast (@all members) and will not be woken by broadcasts; direct Send to them is also rejected.",
				),
			unarchive: z
				.string()
				.optional()
				.describe(
					"Restore an archived subagent by its ID or alias so it can receive messages and " +
						"broadcasts again. When provided, no new agent is launched.",
				),
		}),
	);
}

function buildRawJsonSchema(): Record<string, unknown> {
	return {
		type: "object" as const,
		properties: {
			description: {
				description:
					"A short (3-5 word) description of the task (required when launching a new agent)",
				type: "string",
			},
			subagent_type: {
				description:
					'The type of specialized agent to use for this task. Built-in types: "explore", "plan", "search", "general", "worker". Custom types are also supported.',
				type: "string",
			},
			run_in_background: {
				description:
					"Set to true to run this agent in the background. You will be notified when it completes.",
				type: "boolean",
			},
			takeover_by_user: {
				description: TAKEOVER_BY_USER_DESCRIPTION,
				type: "boolean",
			},
			timeout: {
				description:
					"Optional execution timeout in milliseconds. Background runs default to 5 hours when omitted; use 0 for no wall-clock limit or provide any positive safe integer. This controls the Agent run, not Watch waiting.",
				type: "number",
			},
			model: {
				description: MODEL_PARAM_BASE,
				type: "string",
			},
			reasoning_effort: {
				description: REASONING_EFFORT_DESCRIPTION,
				type: "string",
				enum: REASONING_EFFORT_VALUES,
			},
			workdir: {
				description:
					"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
				type: "string",
			},
			alias: {
				description:
					'A short human-readable alias for this background task (e.g. "run-tests", "build-frontend"). ' +
					"Must be unique within the current session. If omitted, an alias is auto-generated from the description. " +
					"Use this alias with Watch or Send to reference the task later.",
				type: "string",
			},

			archive: {
				description:
					"Archive a subagent by its ID or alias. When provided, no new agent is launched. " +
					"Running work is stopped first. Archived subagents are excluded from TeamStatus " +
					"broadcast (@all members) and will not be woken by broadcasts; direct Send to them is also rejected.",
				type: "string",
			},
			unarchive: {
				description:
					"Restore an archived subagent by its ID or alias so it can receive messages and " +
					"broadcasts again. When provided, no new agent is launched.",
				type: "string",
			},
			prompt: {
				description: "The task for the agent to perform (required when launching a new agent)",
				type: "string",
			},
			task: {
				description: TASK_DESCRIPTION,
				type: "string",
			},
			isolation: {
				description: ISOLATION_DESCRIPTION,
				type: "string",
				enum: ["worktree"],
			},
			title: {
				description: TITLE_DESCRIPTION,
				type: "string",
			},
		},
		required: [] as string[],
		additionalProperties: false,
	};
}

/**
 * Resolve an Agent archive/unarchive selector to a narrator id.
 *
 * Exact id wins. Archive uses the addressable roster. Unarchive uses archived
 * candidates only. An ambiguous name throws instead of following an old task row.
 */
async function resolveArchiveTargetId(
	callerNarratorId: string,
	selector: string,
	action: "archive" | "unarchive",
): Promise<string> {
	const { resolveAgentLifecycleTarget } = await import("@server/services/agent-communication");
	return resolveAgentLifecycleTarget(callerNarratorId, selector, action);
}

export const agentTool: ToolDefinition = {
	name: "Agent",
	description: `${baseDescription}\nTo cancel a running background agent, use Stop({ type: "agent", id }). Agent only launches, archives, or unarchives agents; it does not accept stop. Consult the current model and tool-availability context for available models, search tools and runtime restrictions.`,
	parameters: buildParameters(),
	rawJsonSchema: buildRawJsonSchema(),
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as {
			prompt?: string;
			description?: string;
			subagent_type?: string;
			run_in_background?: boolean;
			takeover_by_user?: boolean;
			timeout?: number;
			model?: string;
			reasoning_effort?: ReasoningEffort;
			workdir?: string;
			alias?: string;
			archive?: string;
			unarchive?: string;
			task?: string;
			isolation?: "worktree";
			title?: string;
			// Legacy parameter name (pre-rename compat)
			background?: boolean;
		};

		if (args && typeof args === "object" && Object.hasOwn(args, "stop")) {
			return {
				output: 'Agent no longer accepts stop. Use Stop({ type: "agent", id }) instead.',
				isError: true,
			};
		}

		// Lifecycle commands are mutually exclusive with each other and with launch.
		const lifecycleModes = [raw.archive, raw.unarchive].filter(Boolean);
		if (lifecycleModes.length > 1) {
			return {
				output:
					"Agent tool error: archive and unarchive are mutually exclusive — provide only one.",
				isError: true,
			};
		}

		// --- Archive mode: retire a subagent so broadcasts stop waking it ---
		if (raw.archive) {
			try {
				const targetId = await resolveArchiveTargetId(ctx.narratorId, raw.archive, "archive");
				const { narratorService } = await import("@server/services/narrator-service");
				const { authorizeAgentControl } = await import("@server/services/narrator-control");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");

				if (!(await narratorService.getById(targetId).catch(() => null))) {
					return {
						output: `Agent archive error: no subagent found for "${raw.archive}".`,
						isError: true,
					};
				}
				// Archiving is a control action: only the registered controller may do it.
				const narrator = await authorizeAgentControl({
					callerNarratorId: ctx.narratorId,
					targetNarratorId: targetId,
					action: "archive",
					userId: ctx.userId,
				}).catch(() => null);
				if (!narrator) {
					return {
						output: `Agent archive error: "${raw.archive}" is not a direct child subagent of this narrator.`,
						isError: true,
					};
				}
				const label = agentLabelFromNarrator(narrator, ctx.narratorId);
				const { interruptAndArchiveSubagent } = await import("@server/services/subagent-lifecycle");
				// Agent control: a team coordinator's archive event names this agent.
				const { runAsTeamStatusActor } = await import("@server/services/teams/team-records");
				const archived = await runAsTeamStatusActor({ kind: "agent", id: ctx.narratorId }, () =>
					interruptAndArchiveSubagent(narrator.id),
				);
				if (!archived.ok) {
					return {
						output: `Agent archive error: failed to archive "${raw.archive}" (${archived.error ?? "unknown"}).`,
						isError: true,
					};
				}
				if (archived.alreadyArchived) {
					return {
						output: `Agent ${label} (${narrator.id}) is already archived. It remains excluded from TeamStatus broadcast (@all members) until unarchived.`,
					};
				}

				return {
					output:
						`Agent ${label} (${narrator.id}) has been archived.\n` +
						"It will not receive TeamStatus broadcast (@all members) messages or wake-ups. " +
						"Direct Send to an archived subagent is also rejected. " +
						"Use unarchive to restore it, or a user page interaction (which auto-unarchives).",
				};
			} catch (err) {
				return {
					output: `Agent archive error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		// --- Unarchive mode: restore an archived subagent ---
		if (raw.unarchive) {
			try {
				const targetId = await resolveArchiveTargetId(ctx.narratorId, raw.unarchive, "unarchive");
				const { narratorService } = await import("@server/services/narrator-service");
				const { authorizeAgentControl } = await import("@server/services/narrator-control");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");

				if (!(await narratorService.getById(targetId).catch(() => null))) {
					return {
						output: `Agent unarchive error: no subagent found for "${raw.unarchive}".`,
						isError: true,
					};
				}
				// Archiving is a control action: only the registered controller may do it.
				const narrator = await authorizeAgentControl({
					callerNarratorId: ctx.narratorId,
					targetNarratorId: targetId,
					action: "archive",
					userId: ctx.userId,
				}).catch(() => null);
				if (!narrator) {
					return {
						output: `Agent unarchive error: "${raw.unarchive}" is not a direct child subagent of this narrator.`,
						isError: true,
					};
				}
				const label = agentLabelFromNarrator(narrator, ctx.narratorId);
				if (narrator.status !== "archived") {
					return {
						output: `Agent ${label} (${narrator.id}) is not archived (current status: ${narrator.status}).`,
					};
				}
				const { runAsTeamStatusActor } = await import("@server/services/teams/team-records");
				await runAsTeamStatusActor({ kind: "agent", id: ctx.narratorId }, () =>
					narratorService.updateStatus(narrator.id, "idle"),
				);
				const { reconcileRestoredSubagentAlias } = await import("@server/services/subagent-alias");
				await reconcileRestoredSubagentAlias(narrator.id);
				const restored = await narratorService.getById(narrator.id);
				const restoredLabel = agentLabelFromNarrator(restored, ctx.narratorId);
				return {
					output:
						`Agent ${restoredLabel} (${narrator.id}) has been unarchived. ` +
						"It can receive messages and TeamStatus broadcast (@all members) again.",
				};
			} catch (err) {
				return {
					output: `Agent unarchive error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		const { subagent_type, model, reasoning_effort, workdir, alias } = raw;
		let { prompt, description } = raw;
		// Normalize timeout leniently: floats/strings/negatives → sane non-negative int
		// (0 = no wall-clock limit).
		const timeout = normalizeNumber(raw.timeout, { min: 0, max: Number.MAX_SAFE_INTEGER });
		// Prefer new name, fall back to legacy name for in-flight conversations.
		// A bot never runs one in the foreground: that would hold its loop — and every
		// person waiting on a reply — for the whole task. The result arrives as its next
		// input instead, like any background completion.
		const run_in_background = ctx.bot ? true : (raw.run_in_background ?? raw.background);

		// Resolve effective cwd: use workdir if provided, otherwise parent's cwd
		let resolvedWorkdir = workdir ? resolvePath(ctx.cwd, workdir) : ctx.cwd;

		const toolUseId = ctx.currentToolUseId;
		if (!toolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}
		const toolCallBinding = ctx.toolCallBinding;
		if (!toolCallBinding) {
			return { output: "Internal error: missing persisted Agent tool-call binding", isError: true };
		}
		const updateExecutionLease = ctx.updateExecutionLease;
		if (!updateExecutionLease) {
			return { output: "Internal error: missing Agent update execution lease", isError: true };
		}

		// Lazy import to avoid circular dependency at module load time
		const { runSubagent } = await import("@server/services/narrator-subagent");

		// An outline task (outline P2 PR 9a): checked and written into the agent's instructions
		// before anything is created; the caller's prompt is added to them.
		let delegation:
			| import("@server/services/outline/delegation").PreparedOutlineDelegation
			| undefined;
		// Weak models emit every optional parameter as an empty string; "" means "no task".
		if (typeof raw.task === "string" && raw.task.trim() !== "") {
			const { OutlineDelegationError, prepareOutlineDelegation } = await import(
				"@server/services/outline/delegation"
			);
			try {
				delegation = await prepareOutlineDelegation({
					narratorId: ctx.narratorId,
					userId: ctx.userId ?? null,
					task: raw.task,
					prompt,
					takeoverByUser: raw.takeover_by_user === true,
					readOnlyCeiling:
						ctx.runtimePolicy?.tools.readOnly === true ||
						ctx.runtimePolicy?.readOnlyGitShell === true,
				});
			} catch (err) {
				return {
					output:
						err instanceof OutlineDelegationError
							? err.message
							: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
			prompt = delegation.brief;
			description ||= delegation.title;
		}

		if (!prompt) {
			return {
				output: "Missing required parameter: prompt (the task for the agent to perform)",
				isError: true,
			};
		}

		// A team coordinator's work item (P3): `isolation: "worktree"` makes one; a workdir that is
		// an item's own worktree delegates into it. Either way the subagent becomes its worker.
		let workItem: { teamId: string; id: string; branch: string | null; created: boolean } | null =
			null;
		if (raw.isolation !== undefined || workdir) {
			const { coordinatedTeamId } = await import("@server/services/teams/team-membership");
			const teamId = coordinatedTeamId(ctx.narratorId);
			if (raw.isolation !== undefined) {
				if (raw.isolation !== "worktree")
					return { output: 'Agent error: isolation only accepts "worktree".', isError: true };
				if (workdir)
					return {
						output: 'Agent error: isolation "worktree" creates its own directory; omit workdir.',
						isError: true,
					};
				if (!teamId)
					return {
						output:
							'Agent error: isolation "worktree" is for team coordinators; use CreateWorktree and workdir instead.',
						isError: true,
					};
				const title = (raw.title || description || "").trim();
				if (!title)
					return {
						output: 'Agent error: isolation "worktree" needs a title (or description).',
						isError: true,
					};
				try {
					const items = await import("@server/services/teams/work-items");
					const { narratorWorktreePrincipalForTool } = await import(
						"@server/services/narrator-worktree-runtime"
					);
					const { TEAM_ISOLATED_WORK_KIND } = await import("@shared/project-teams");
					const item = await items.createWorkItem({
						coordinatorId: ctx.narratorId,
						title,
						// A title with no ASCII words (a Chinese title) cannot name the branch.
						branchHint: items.workBranchSlug(title) ? undefined : description,
						kind: TEAM_ISOLATED_WORK_KIND,
						actor: { kind: "agent", id: ctx.narratorId },
						principal: await narratorWorktreePrincipalForTool(ctx),
						signal: ctx.signal,
					});
					const path = items.worktreePathOf(item);
					if (!path) throw new Error("the work item's worktree is not recorded");
					resolvedWorkdir = path;
					description ||= title;
					workItem = { teamId, id: item.id, branch: item.branchName, created: true };
				} catch (err) {
					return {
						output: `Agent error: the work item could not be created: ${err instanceof Error ? err.message : String(err)}`,
						isError: true,
					};
				}
			} else if (teamId) {
				const { workItemAtWorktree } = await import("@server/services/teams/work-items");
				const item = workItemAtWorktree(teamId, resolvedWorkdir);
				if (item && !item.workerNarratorId) {
					// D: an item with no worker starts only once every dependency merged, whatever its
					// state; nothing is created when it cannot (409 TEAM_WORK_ITEM_BLOCKED, naming the
					// blockers). `attachWorker` checks it again when the subagent exists.
					const { assertWorkItemStartable } = await import(
						"@server/services/teams/work-item-dependencies"
					);
					try {
						assertWorkItemStartable(item.id);
					} catch (err) {
						const code = (err as { code?: unknown }).code;
						return {
							output: `Agent error (${typeof code === "string" ? code : "TEAM_REQUEST_FAILED"}): ${err instanceof Error ? err.message : String(err)}`,
							isError: true,
						};
					}
					workItem = { teamId, id: item.id, branch: item.branchName, created: false };
				}
			}
		}
		// Imported before the run so the creation hook below stays synchronous.
		const workItemsModule = workItem ? await import("@server/services/teams/work-items") : null;
		/** The subagent the call created for the work item, once it exists. */
		let workItemWorker: string | null = null;
		const workItemNote = workItem
			? `\n\nTeam work item ${workItem.id}${workItem.branch ? ` (branch ${workItem.branch})` : ""} in ${resolvedWorkdir}; this agent is its worker.`
			: "";

		// What the call carries for its card (outline P2 PR 9b): the task, and the head of the note
		// its result was delivered with, as data no projection of the text can cut.
		let delivered: import("@shared/outline-report-note").OutlineReportNote | null = null;
		try {
			const result = await runSubagent({
				parentNarratorId: ctx.narratorId,
				toolUseId,
				toolCallBinding,
				subagentType: subagent_type || (workItem?.created ? "worker" : "general"),
				prompt,
				title: description || undefined,
				cwd: resolvedWorkdir,
				signal: ctx.signal,
				updateExecutionLease,
				locale: ctx.locale,
				model: model || undefined,
				reasoningEffort: reasoning_effort,
				background: run_in_background || false,
				takeoverByUser: raw.takeover_by_user === true,
				timeoutMs: timeout,
				alias: alias || description || undefined,
				// The subagent acts on behalf of whoever triggered this parent turn:
				// knowledge ACL and fast-mode "inherit" both resolve against them.
				userId: ctx.userId ?? null,
				...(workItem && workItemsModule
					? {
							onCreated: (subagentId: string) => {
								if (!workItem) return;
								workItemWorker = subagentId;
								workItemsModule.attachWorker(workItem.teamId, workItem.id, subagentId, {
									kind: "agent",
									id: ctx.narratorId,
								});
							},
						}
					: {}),
				...(delegation
					? {
							delegation,
							onDelegatedResult: (note) => {
								delivered = note;
							},
						}
					: {}),
			});

			// The runner already writes the alias into the `<subagent_id>` /
			// `<background_task_id>` tag and registers it, so no string surgery is
			// needed here. Conflicts are reported by the runner too.
			if (!delegation) return { output: result + workItemNote };
			const { OUTLINE_DELEGATION_METADATA_KEY, outlineDelegationMetadata } = await import(
				"@shared/outline-report-note"
			);
			return {
				output: result,
				metadata: {
					[OUTLINE_DELEGATION_METADATA_KEY]: outlineDelegationMetadata(delegation, delivered),
				},
			};
		} catch (err) {
			if (isCheckpointStop(err)) throw err;
			// The work item of a call whose agent never ran is settled (see `settleFailedStart`):
			// an untouched isolated worktree is removed, an attached item goes back to the queue.
			if (workItem && workItemsModule)
				await workItemsModule
					.settleFailedStart(workItem.teamId, workItem.id, workItemWorker, {
						kind: "agent",
						id: ctx.narratorId,
					})
					.catch(() => "kept");
			// A delegation refused once the agent existed (the task changed hands) says so itself.
			if (delegation && err instanceof Error && err.name === "OutlineDelegationError")
				return { output: err.message, isError: true };
			return {
				output: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
