/**
 * ScheduledTask action vocabulary, in a dependency-free leaf module.
 *
 * The permission layer classifies a ScheduledTask call by its action, so it needs
 * this list. Importing it from `scheduled-task.ts` would drag the tool's lazy
 * service graph (db → narrator-session) into `narrator-permission.ts` and re-form
 * a circular import, so the vocabulary lives here and both sides import it.
 */

export const SCHEDULED_TASK_ACTIONS = [
	"list",
	"get",
	"create",
	"update",
	"enable",
	"disable",
	"delete",
	"run_now",
	"runs",
] as const;

export type ScheduledTaskAction = (typeof SCHEDULED_TASK_ACTIONS)[number];

/**
 * Actions that only read schedule state.
 *
 * Deliberately an allow-list rather than a deny-list of mutations: an action added
 * to the tool but not classified here is then treated as mutating and gated, which
 * is the safe direction. The reverse would auto-allow a new mutation everywhere,
 * with no error to reveal the omission.
 */
const SCHEDULED_TASK_READ_ACTIONS = new Set<string>(["list", "get", "runs"]);

/** Whether a ScheduledTask `action` input value is a pure read. */
export function isScheduledTaskReadAction(action: unknown): boolean {
	return typeof action === "string" && SCHEDULED_TASK_READ_ACTIONS.has(action);
}
