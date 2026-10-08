/**
 * Resolves every narrator-toolbar badge in ONE place.
 *
 * `NarratorToolbarItemDef.badge` is only a wiring key. The nav equivalent
 * (`components/nav/use-nav-badges.ts`) is a hook because its counts come from
 * global queries; these counts are per-narrator live state that `NarratorPanel`
 * has already derived from its WebSocket state and queries, so re-fetching them
 * here would duplicate a subscription. Hence a pure function over supplied
 * counts instead.
 *
 * The reason to centralize at all is the same as the nav case: the header row and
 * the overflow menu both paint these, and a badge key handled in one place but
 * not the other fails silently — the entry just never shows a count.
 */

import type { NarratorToolbarItemDef } from "./narrator-toolbar-items";

export interface NarratorToolbarBadgeCounts {
	/** Background tasks currently running. */
	backgroundTasks: number;
	backgroundWork?: number;
	backgroundServices?: number;
	/** Live browser sessions. */
	browserSessions: number;
	/** Unread messages in the human discussion room. */
	userChatUnread: number;
	/** Active terminals. */
	terminals: number;
}

export interface NarratorToolbarBadgeValue {
	count: number;
	/** Display string, already "99+"-capped. */
	label: string;
	/**
	 * Whether this badge should pulse rather than show a number.
	 *
	 * Running work is a *state*, not a quantity: "2 tasks running" is less useful
	 * at a glance than "something is running", and the processing dot is what the
	 * old header used for exactly this entry.
	 */
	processing: boolean;
}

const EMPTY: NarratorToolbarBadgeValue = { count: 0, label: "", processing: false };

/** Above this a badge reads "99+" instead of an exact number. */
const BADGE_DISPLAY_MAX = 99;

function format(count: number, processing = false): NarratorToolbarBadgeValue {
	if (count <= 0) return EMPTY;
	return {
		count,
		label: count > BADGE_DISPLAY_MAX ? `${BADGE_DISPLAY_MAX}+` : String(count),
		processing,
	};
}

export function resolveNarratorToolbarBadge(
	badge: NarratorToolbarItemDef["badge"],
	counts: NarratorToolbarBadgeCounts,
): NarratorToolbarBadgeValue {
	switch (badge) {
		case "backgroundTasks":
			return format(counts.backgroundTasks, (counts.backgroundWork ?? counts.backgroundTasks) > 0);
		case "browserSessions":
			return format(counts.browserSessions);
		case "userChatUnread":
			return format(counts.userChatUnread);
		case "terminals":
			return format(counts.terminals);
		default:
			return EMPTY;
	}
}

/**
 * Aggregate badge for the overflow button itself.
 *
 * Without this, tucking an entry away would hide its unread count entirely: a
 * reader who moved the discussion room into the overflow menu would stop seeing
 * that anyone had written to them. The aggregate keeps the signal on the row even
 * when the specific control is one tap deeper.
 */
export function aggregateOverflowBadge(
	overflowItems: readonly NarratorToolbarItemDef[],
	counts: NarratorToolbarBadgeCounts,
): NarratorToolbarBadgeValue {
	let total = 0;
	let processing = false;
	for (const def of overflowItems) {
		const value = resolveNarratorToolbarBadge(def.badge, counts);
		total += value.count;
		if (value.processing) processing = true;
	}
	return format(total, processing);
}
