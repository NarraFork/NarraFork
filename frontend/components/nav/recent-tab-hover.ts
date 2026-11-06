/**
 * Which sidebar row the hover details card is showing, and when it appears or goes away.
 *
 * One store per list instead of one HoverCard per row: rows only report pointer enter and
 * leave, so a hover never re-renders the list, and the card subscribes on its own.
 *
 * Timing follows the usual hover-card pattern:
 *   - the first card waits {@link RECENT_TAB_HOVER_SHOW_DELAY_MS} so passing over the
 *     list on the way somewhere else shows nothing;
 *   - once a card is up, moving to another row switches to it at once;
 *   - leaving waits {@link RECENT_TAB_HOVER_HIDE_DELAY_MS}, long enough to move the
 *     pointer from the row onto the card itself (which keeps it open).
 *
 * No DOM or React here, so the timing is testable with injected timers.
 */

export const RECENT_TAB_HOVER_SHOW_DELAY_MS = 250;
export const RECENT_TAB_HOVER_HIDE_DELAY_MS = 150;

export interface RecentTabHoverRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export interface RecentTabHoverAnchor {
	/** `type:id` of the hovered row. */
	key: string;
	/** The row's viewport rect, measured when the card appears. */
	rect: RecentTabHoverRect;
}

export interface RecentTabHoverStore {
	/** The pointer entered a row. `measure` is read when the card actually shows. */
	enter(key: string, measure: () => RecentTabHoverRect): void;
	/** The pointer left a row or the card. */
	leave(): void;
	/** The pointer entered the card: keep it open. */
	holdOpen(): void;
	/** Close now (click, scroll, drag start, menu open). */
	hide(): void;
	subscribe(listener: () => void): () => void;
	getSnapshot(): RecentTabHoverAnchor | null;
}

interface Timers {
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
}

const defaultTimers: Timers = {
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createRecentTabHoverStore(timers: Timers = defaultTimers): RecentTabHoverStore {
	let anchor: RecentTabHoverAnchor | null = null;
	let showTimer: unknown = null;
	let hideTimer: unknown = null;
	const listeners = new Set<() => void>();

	const set = (next: RecentTabHoverAnchor | null) => {
		if (next === anchor) return;
		anchor = next;
		for (const listener of listeners) listener();
	};
	const cancelShow = () => {
		if (showTimer !== null) timers.clearTimeout(showTimer);
		showTimer = null;
	};
	const cancelHide = () => {
		if (hideTimer !== null) timers.clearTimeout(hideTimer);
		hideTimer = null;
	};

	return {
		enter(key, measure) {
			cancelHide();
			cancelShow();
			if (anchor) {
				if (anchor.key !== key) set({ key, rect: measure() });
				return;
			}
			showTimer = timers.setTimeout(() => {
				showTimer = null;
				set({ key, rect: measure() });
			}, RECENT_TAB_HOVER_SHOW_DELAY_MS);
		},
		leave() {
			cancelShow();
			if (!anchor || hideTimer !== null) return;
			hideTimer = timers.setTimeout(() => {
				hideTimer = null;
				set(null);
			}, RECENT_TAB_HOVER_HIDE_DELAY_MS);
		},
		holdOpen: cancelHide,
		hide() {
			cancelShow();
			cancelHide();
			set(null);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => anchor,
	};
}
