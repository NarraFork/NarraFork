/**
 * The coordinator's `Team` tool actions as people read them: one table for the team page's
 * conversation chips (「标记为可合并 ×2」), the tool card / trace row summary on every page
 * (`tool-display.getSummary`), and the activity feed, which words the same actions through the
 * events they record (`teams.event.*`).
 *
 * The chip and the summary read `narrator:teamTool.<labelKey>`; for every action that records an
 * event, that string must equal the activity feed's `projects:teams.event.<eventLabel>` in each
 * locale (`team-tool-actions.test.ts` holds them together), so one action never reads two ways.
 */

/** The display keys of a Team call: its action, with `brief` split into reading and writing. */
export const TEAM_TOOL_ACTION_KEYS = [
	"work.create",
	"work.update",
	"work.review",
	"work.ready",
	"work.sync",
	"work.cancel",
	"work.list",
	"brief.read",
	"brief.write",
	"checkin",
	"decision",
	"cleanup",
] as const;
export type TeamToolActionKey = (typeof TEAM_TOOL_ACTION_KEYS)[number];

/**
 * The activity feed label (under `projects:teams.event.`) that words the same action, or null
 * for an action that records no event (reading the list or the brief).
 */
export const TEAM_TOOL_ACTION_EVENT_LABEL: Readonly<Record<TeamToolActionKey, string | null>> = {
	"work.create": "work_created",
	// work.update only replaces a queued item's dependencies.
	"work.update": "work_dependencies_changed",
	"work.review": "work_review",
	"work.ready": "work_ready",
	"work.sync": "work_sync",
	"work.cancel": "work_cancelled",
	"work.list": null,
	"brief.read": null,
	"brief.write": "team_brief",
	checkin: "team_checkin",
	decision: "team_decision",
	cleanup: "work_cleanup",
};

/** The i18n key under `narrator:teamTool.` (dots are i18next's key separator). */
export function teamToolLabelKey(action: string): string {
	return (TEAM_TOOL_ACTION_KEYS as readonly string[]).includes(action)
		? action.replace(".", "_")
		: "other";
}

/** The actions that name one work item (`input.item`). */
export const TEAM_TOOL_ITEM_ACTIONS: ReadonlySet<string> = new Set([
	"work.update",
	"work.review",
	"work.ready",
	"work.sync",
	"work.cancel",
	"cleanup",
]);

const ACTION_IN_PREVIEW = /"action"\s*:\s*"([^"\\]{1,40})"/;

/**
 * The display key of one `Team` call's input: its action, with `brief` split into reading and
 * writing (`brief.read` / `brief.write`). A server-truncated input (`{_truncated, preview}`) is
 * read from its preview. Null when the action cannot be read.
 */
export function teamToolActionKey(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	let action = typeof record.action === "string" ? record.action : null;
	if (!action && record._truncated === true && typeof record.preview === "string")
		action = ACTION_IN_PREVIEW.exec(record.preview)?.[1] ?? null;
	if (!action) return null;
	if (action === "brief") {
		const writes =
			typeof record.text === "string" ||
			(record._truncated === true &&
				typeof record.preview === "string" &&
				/"text"\s*:/.test(record.preview));
		return writes ? "brief.write" : "brief.read";
	}
	return action;
}
