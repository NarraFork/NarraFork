/**
 * The states a task is shown in, and the colour each one takes, in one place.
 *
 * A task's own status (`todo`, `doing`, `done`, `cancelled`) and the states derived from it that
 * some views show (waiting for a person or an earlier task, handed to a subagent, locked by a
 * plan, finished since the reader last looked). Every view draws a state as the same icon on the
 * same tinted background (`frontend/components/outline/outline-icons.ts` for the icons,
 * `outline-icons.css` for the colours); views drawn from shared layout data (the transcript's
 * task notices) take the colour name from here, so a chip and a checkbox never disagree.
 *
 * Colour is never the only signal: each state has its own icon shape and its name as the
 * accessible label.
 *
 * Pure: no DOM, no React.
 */

export const OUTLINE_STATUS_KEYS = [
	"todo",
	"doing",
	"done",
	"cancelled",
	"waiting",
	"delegated",
	"locked",
	"newly_done",
] as const;

export type OutlineStatusKey = (typeof OUTLINE_STATUS_KEYS)[number];

/** The Mantine colour a state is tinted with (badge background and icon, chips). */
export type OutlineStatusTone = "gray" | "blue" | "green" | "orange" | "violet" | "indigo" | "teal";

export const OUTLINE_STATUS_TONE: Record<OutlineStatusKey, OutlineStatusTone> = {
	todo: "gray",
	doing: "blue",
	done: "green",
	cancelled: "gray",
	waiting: "orange",
	delegated: "violet",
	locked: "indigo",
	newly_done: "teal",
};

export function isOutlineStatusKey(value: unknown): value is OutlineStatusKey {
	return typeof value === "string" && (OUTLINE_STATUS_KEYS as readonly string[]).includes(value);
}
