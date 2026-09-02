import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@shared/i18n-locales";
import { z } from "zod/v4";
import type { scheduledTasks } from "../../../db/schema";
import { isValidCron, nextCronRun } from "../../cron";
import { PERMISSION_MODES } from "../../permission-modes";
import type { ToolDefinition, ToolResult } from "../types";
import { SCHEDULED_TASK_ACTIONS } from "./scheduled-task-actions";

/**
 * ScheduledTask — optional tool for managing NarraFork's cron-driven task queue
 * (the same records the `/scheduled-tasks` UI edits, backed by
 * `services/scheduled-task-service`).
 *
 * A scheduled task launches a narrator unattended and injects a prompt into it,
 * commonly under `bypassPermissions`. Creating or editing one therefore hands out
 * recurring, unsupervised execution authority, which is a strictly larger grant
 * than any single tool call the model could make right now.
 *
 * ## Where the permission gate actually is
 *
 * NOT in this file. `resolvePermissionDecision` in `services/narrator-permission.ts`
 * inspects `input.action` and returns `ask` for every mutating one, so the approval
 * happens before `execute` is ever called. Two properties of that placement matter and
 * are easy to undo by "tidying up":
 *
 *   - The `ScheduledTask` branch sits ABOVE the `bypassPermissions` short-circuit, so
 *     even a bypassing session must confirm a mutation. That is deliberate: bypass
 *     means "do not ask about this turn's actions", and arming a recurring unattended
 *     run is not confined to this turn.
 *   - Read actions are classified in `scheduled-task-actions.ts`, and anything not on
 *     that list counts as a mutation. A new action is therefore gated by default
 *     rather than silently permitted.
 *
 * So this module does no permission work of its own, and must not be read as if it
 * did — an added action needs its classification updated, not a call added here.
 */

// Lazy import: the service pulls in the db + narrator-session graph, and this
// module is imported by tools/index.ts during registry construction.
async function getService() {
	const mod = await import("../../../services/scheduled-task-service");
	return mod.scheduledTaskService;
}

/** Hard cap on run-history rows a single call may pull back into context. */
const RUNS_LIMIT_MAX = 50;
const RUNS_LIMIT_DEFAULT = 10;

const runContextEnum = z.enum(["standalone", "chapter"]);
const narratorModeEnum = z.enum(["new", "reuse"]);

/**
 * Task fields the model may set. Mirrors `createScheduledTaskSchema`'s bounds so
 * the tool rejects an over-long prompt with a readable message instead of letting
 * the service write an unbounded row.
 */
const taskFieldsSchema = z.object({
	name: z.string().min(1).max(200).optional().describe("Human-readable task name."),
	cronExpr: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			'Cron expression, e.g. "0 9 * * *" for 09:00 daily. Seconds field is optional (croner syntax).',
		),
	timezone: z
		.string()
		.max(100)
		.nullable()
		.optional()
		.describe('IANA timezone for the cron expression, e.g. "Asia/Shanghai". Null = server local.'),
	prompt: z
		.string()
		.min(1)
		.max(50000)
		.optional()
		.describe("The prompt injected into the narrator on each run."),
	systemPrompt: z
		.string()
		.max(10000)
		.nullable()
		.optional()
		.describe("Extra system prompt for narrators this task creates."),
	model: z.string().max(200).nullable().optional().describe("Model override for the run."),
	permissionMode: z
		.enum(PERMISSION_MODES)
		.optional()
		.describe(
			'Permission mode for the spawned narrator. Defaults to "bypassPermissions" because a scheduled run has nobody to answer prompts.',
		),
	locale: z.enum(SUPPORTED_LOCALES).optional().describe("Locale of the injected message."),
	runContext: runContextEnum
		.optional()
		.describe(
			'"standalone" runs in its own session at `cwd`; "chapter" runs inside a chapter worktree and requires projectId + chapterId.',
		),
	cwd: z
		.string()
		.max(4096)
		.nullable()
		.optional()
		.describe("Working directory for standalone runs. Defaults to the home directory."),
	projectId: z.string().max(100).nullable().optional().describe("Required for chapter runContext."),
	chapterId: z.string().max(100).nullable().optional().describe("Required for chapter runContext."),
	narratorMode: narratorModeEnum
		.optional()
		.describe(
			'Standalone only: "new" creates a fresh narrator per run, "reuse" keeps appending to the same session.',
		),
	enabled: z.boolean().optional().describe("Whether the schedule is armed."),
});

type TaskFields = z.infer<typeof taskFieldsSchema>;

const parametersSchema = z.object({
	action: z
		.enum(SCHEDULED_TASK_ACTIONS)
		.describe(
			"list (all tasks) | get (one task) | create | update | enable | disable | delete | " +
				"run_now (trigger immediately without disturbing the cron cadence) | runs (run history).",
		),
	id: z
		.string()
		.min(1)
		.max(100)
		.optional()
		.describe("Task id. Required for every action except list and create."),
	task: taskFieldsSchema
		.optional()
		.describe(
			"Task fields. For create, `name`, `cronExpr` and `prompt` are required. " +
				"For update, only the fields you pass are changed.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(RUNS_LIMIT_MAX)
		.optional()
		.describe(`Max run-history rows for the runs action (default ${RUNS_LIMIT_DEFAULT}).`),
	cursor: z
		.string()
		.max(100)
		.optional()
		.describe("Pagination cursor from a previous runs call (`nextCursor`)."),
});

/**
 * The task row this tool reports on. Derived from the schema rather than
 * re-declared so a column rename is a compile error here instead of a field that
 * silently reports `undefined` in the tool output.
 */
type TaskRow = typeof scheduledTasks.$inferSelect;

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Summary projection for the `list` action.
 *
 * `prompt` and `systemPrompt` are reported as lengths rather than text: a list of
 * 30 tasks with 50k-character prompts would be the largest thing in the model's
 * context, and none of it answers "what is scheduled and is it healthy". Use
 * `get` for one task's full prompt.
 */
function summarizeTask(task: TaskRow) {
	return {
		id: task.id,
		name: task.name,
		enabled: task.enabled,
		cronExpr: task.cronExpr,
		timezone: task.timezone,
		nextRunAt: task.nextRunAt,
		lastRunAt: task.lastRunAt,
		lastStatus: task.lastStatus,
		...(task.lastError ? { lastError: truncate(task.lastError, 200) } : {}),
		runContext: task.runContext,
		...(task.chapterId ? { chapterId: task.chapterId } : {}),
		permissionMode: task.permissionMode,
		promptChars: task.prompt.length,
		...(task.systemPrompt ? { systemPromptChars: task.systemPrompt.length } : {}),
	};
}

function detailTask(task: TaskRow) {
	return {
		...summarizeTask(task),
		prompt: task.prompt,
		systemPrompt: task.systemPrompt,
		model: task.model,
		locale: task.locale,
		cwd: task.cwd,
		projectId: task.projectId,
		narratorMode: task.narratorMode,
		reuseNarratorId: task.reuseNarratorId,
		lastNarratorId: task.lastNarratorId,
		lastError: task.lastError,
		createdBy: task.createdBy,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
}

function jsonOut(title: string, value: unknown): ToolResult {
	return { output: JSON.stringify(value, null, 2), title };
}

function fail(message: string): ToolResult {
	return { output: message, isError: true };
}

/** Reject a cron/timezone pair before it reaches the service's generic error. */
function validateSchedule(
	cronExpr: string | undefined,
	timezone: string | null | undefined,
): string | null {
	if (cronExpr === undefined) return null;
	if (!isValidCron(cronExpr, timezone ?? null)) {
		return (
			`Invalid cron expression "${cronExpr}"` +
			(timezone ? ` for timezone "${timezone}"` : "") +
			". Patterns that never fire (e.g. Feb 30th) are rejected too."
		);
	}
	return null;
}

/**
 * Chapter runs need both ids. Checked here rather than only in the service so the
 * model is told which field is missing instead of getting the service's message.
 */
function validateChapterContext(
	runContext: string,
	projectId: string | null | undefined,
	chapterId: string | null | undefined,
): string | null {
	if (runContext !== "chapter") return null;
	const missing: string[] = [];
	if (!projectId) missing.push("projectId");
	if (!chapterId) missing.push("chapterId");
	if (missing.length === 0) return null;
	return `runContext "chapter" requires ${missing.join(" and ")}.`;
}

export const scheduledTaskTool: ToolDefinition = {
	name: "ScheduledTask",
	description:
		"Manage NarraFork scheduled tasks (cron-driven prompts that launch a narrator unattended). " +
		"Actions: list, get, create, update, enable, disable, delete, run_now (trigger immediately), " +
		"runs (run history). A task runs on a cron schedule and injects its prompt into a new or " +
		"reused narrator, either standalone or inside a chapter worktree. Mutating actions require " +
		"user approval because a scheduled task keeps executing after this session ends.",
	parameters: parametersSchema,
	async execute(args, ctx): Promise<ToolResult> {
		const parsed = parametersSchema.safeParse(args);
		if (!parsed.success) {
			return fail(`Invalid ScheduledTask arguments: ${parsed.error.message}`);
		}
		const { action, id, task, limit, cursor } = parsed.data;

		if (action !== "list" && action !== "create" && !id) {
			return fail(`Error: 'id' is required for the ${action} action.`);
		}

		const service = await getService();

		try {
			switch (action) {
				case "list": {
					const { tasks, truncated } = await service.list();
					if (tasks.length === 0) {
						return { output: "No scheduled tasks exist.", title: "Scheduled tasks: 0" };
					}
					// The truncation notice goes in the OUTPUT, not just the title: a model
					// reading a short list would otherwise conclude those are all the tasks
					// and happily create a duplicate of one it cannot see.
					const summaries = tasks.map(summarizeTask);
					const body = truncated
						? {
								truncated: true,
								note: `Showing the first ${tasks.length} tasks.`,
								tasks: summaries,
							}
						: summaries;
					const title = truncated
						? `Scheduled tasks: ${tasks.length}+ (truncated)`
						: `Scheduled tasks: ${tasks.length}`;
					return jsonOut(title, body);
				}

				case "get": {
					const found = await service.get(id as string);
					if (!found) return fail(`Scheduled task '${id}' not found.`);
					return jsonOut(`Task: ${found.name}`, detailTask(found));
				}

				case "create": {
					const fields: TaskFields = task ?? {};
					const missing = (["name", "cronExpr", "prompt"] as const).filter((key) => !fields[key]);
					if (missing.length > 0) {
						return fail(`Error: create requires task.${missing.join(", task.")}.`);
					}
					const runContext = fields.runContext ?? "standalone";
					const scheduleError = validateSchedule(fields.cronExpr, fields.timezone);
					if (scheduleError) return fail(scheduleError);
					const contextError = validateChapterContext(
						runContext,
						fields.projectId,
						fields.chapterId,
					);
					if (contextError) return fail(contextError);

					const created = await service.create({
						...fields,
						name: fields.name as string,
						cronExpr: fields.cronExpr as string,
						prompt: fields.prompt as string,
						runContext,
						locale: fields.locale ?? DEFAULT_LOCALE,
						// The task acts as whoever drove this turn. Without it the run resolves to
						// the empty principal and can only reuse sessions open to everyone.
						createdBy: ctx.userId ?? null,
					});
					return jsonOut(`Created: ${created.name}`, detailTask(created));
				}

				case "update": {
					const fields: TaskFields = task ?? {};
					if (Object.keys(fields).length === 0) {
						return fail("Error: update requires at least one field in `task`.");
					}
					const existing = await service.get(id as string);
					if (!existing) return fail(`Scheduled task '${id}' not found.`);

					const scheduleError = validateSchedule(
						fields.cronExpr,
						fields.timezone !== undefined ? fields.timezone : existing.timezone,
					);
					if (scheduleError) return fail(scheduleError);
					// A timezone-only edit still re-derives nextRunAt from the stored cron
					// expression, so validate that pair too.
					if (fields.cronExpr === undefined && fields.timezone !== undefined) {
						const tzError = validateSchedule(existing.cronExpr, fields.timezone);
						if (tzError) return fail(tzError);
					}
					const contextError = validateChapterContext(
						fields.runContext ?? existing.runContext,
						fields.projectId !== undefined ? fields.projectId : existing.projectId,
						fields.chapterId !== undefined ? fields.chapterId : existing.chapterId,
					);
					if (contextError) return fail(contextError);

					const updated = await service.update(id as string, fields);
					return jsonOut(`Updated: ${updated.name}`, detailTask(updated));
				}

				case "enable":
				case "disable": {
					const enabled = action === "enable";
					const updated = await service.setEnabled(id as string, enabled);
					const when = updated.nextRunAt ? ` Next run: ${updated.nextRunAt}.` : "";
					return {
						output: `Task "${updated.name}" is now ${enabled ? "enabled" : "disabled"}.${when}`,
						title: `${enabled ? "Enabled" : "Disabled"}: ${updated.name}`,
					};
				}

				case "delete": {
					const existing = await service.get(id as string);
					if (!existing) return fail(`Scheduled task '${id}' not found.`);
					await service.delete(id as string);
					return {
						output: `Deleted scheduled task "${existing.name}" (${id}). Run history is removed with it.`,
						title: `Deleted: ${existing.name}`,
					};
				}

				case "run_now": {
					const existing = await service.get(id as string);
					if (!existing) return fail(`Scheduled task '${id}' not found.`);
					await service.runTask(id as string, { manual: true });
					// runTask records the outcome on the row; re-read it rather than reporting
					// "triggered", which would hide a skip (e.g. narrator already running).
					const after = await service.get(id as string);
					const status = after?.lastStatus ?? "unknown";
					const detail = after?.lastError ? `\nDetail: ${after.lastError}` : "";
					const narrator = after?.lastNarratorId ? `\nNarrator: ${after.lastNarratorId}` : "";
					return {
						output:
							`Triggered "${existing.name}" manually.\nOutcome: ${status}${narrator}${detail}\n` +
							`The cron cadence was not disturbed${after?.nextRunAt ? ` (next run: ${after.nextRunAt})` : ""}.`,
						title: `Ran: ${existing.name} (${status})`,
					};
				}

				case "runs": {
					const existing = await service.get(id as string);
					if (!existing) return fail(`Scheduled task '${id}' not found.`);
					const result = await service.listRuns(id as string, {
						limit: limit ?? RUNS_LIMIT_DEFAULT,
						cursor: cursor ?? null,
					});
					if (result.runs.length === 0) {
						return {
							output: `No run history for "${existing.name}".`,
							title: `Runs: ${existing.name} (0)`,
						};
					}
					return jsonOut(`Runs: ${existing.name} (${result.runs.length})`, {
						runs: result.runs.map((run) => ({
							status: run.status,
							manual: run.manual,
							startedAt: run.startedAt,
							durationMs: run.durationMs,
							narratorId: run.narratorId,
							...(run.error ? { error: truncate(run.error, 300) } : {}),
						})),
						nextCursor: result.nextCursor,
					});
				}

				default:
					return fail(`Unknown action: ${action}`);
			}
		} catch (err) {
			return fail(
				`ScheduledTask ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
};

/**
 * Describe the next few fire times for a cron expression. Exported for tests and
 * potential UI reuse; not part of the tool surface.
 */
export function previewCronRuns(
	cronExpr: string,
	timezone: string | null | undefined,
	count: number,
): string[] {
	const out: string[] = [];
	let from = new Date();
	for (let i = 0; i < count; i++) {
		const next = nextCronRun(cronExpr, timezone ?? null, from);
		if (!next) break;
		out.push(next);
		from = new Date(next);
	}
	return out;
}
