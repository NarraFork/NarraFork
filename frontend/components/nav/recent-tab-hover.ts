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
 * The keyboard shows the same card for the row Ctrl+Up / Ctrl+Down highlights on the
 * collapsed rail, where the titles are clipped away (`useRecentTabKeyboardCard.ts`):
 *   - at once, and it follows the highlight from row to row;
 *   - it takes the card over from the pointer, and the pointer entering a row takes it
 *     back; the pointer leaving a row never closes it (the card itself lets the pointer
 *     through, see `RecentTabDetailCard`);
 *   - once the highlight is gone it stays {@link RECENT_TAB_KEYBOARD_CARD_LINGER_MS},
 *     so the row the switch landed on can still be read.
 *
 * No DOM or React here, so the timing is testable with injected timers.
 */

export const RECENT_TAB_HOVER_SHOW_DELAY_MS = 500;
export const RECENT_TAB_HOVER_HIDE_DELAY_MS = 150;
export const RECENT_TAB_KEYBOARD_CARD_LINGER_MS = 600;

export interface RecentTabHoverRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export interface RecentTabHoverAnchor {
	/** `type:id` of the row the card is for. */
	key: string;
	/** Where the card anchors, in viewport coordinates: the row's rect, measured when shown. */
	rect: RecentTabHoverRect;
	/** Who put the card up: the pointer resting on a row, or the keyboard highlight. */
	source: "pointer" | "keyboard";
}

export interface RecentTabHoverStore {
	/** The pointer entered a row. `measure` is read when the card actually shows. */
	enter(key: string, measure: () => RecentTabHoverRect): void;
	/** The pointer left a row or the card. */
	leave(): void;
	/** The pointer entered the card: keep it open. */
	holdOpen(): void;
	/** Close now (click, scroll, drag start, menu open). Also stops following the keyboard. */
	hide(): void;
	/**
	 * The keyboard highlight moved to `key`: show its card at `rect` now, in place of
	 * whatever card is up. A null `rect` (the row is not on screen) shows nothing, but the
	 * row stays followed, so a later `reanchor` shows it once the row scrolls in.
	 */
	follow(key: string, rect: RecentTabHoverRect | null): void;
	/** The followed row moved (the list scrolled, the rail opened or closed). */
	reanchor(rect: RecentTabHoverRect | null): void;
	/** The highlight is gone: keep following a little longer, then close the card. */
	release(): void;
	/** Stop following now, and close the card if it is the keyboard's. */
	unfollow(): void;
	/** The row the keyboard card follows (also while it lingers), null when none. */
	followedKey(): string | null;
	subscribe(listener: () => void): () => void;
	getSnapshot(): RecentTabHoverAnchor | null;
}

function sameRect(a: RecentTabHoverRect, b: RecentTabHoverRect): boolean {
	return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

/**
 * Where the keyboard card anchors for a row: the row's rect, cut to what is visible.
 *
 * On the collapsed rail a row keeps its expanded layout box and is only clipped, so its
 * own `right` lies ~160px past the rail and a card placed from it would float over the
 * page. `rail` (the collapsed navbar) cuts the rect to the rail's column.
 *
 * Null when the row has no box or lies outside `list` (the list's scroll viewport): a
 * card there would point at nothing.
 */
export function railCardAnchor(
	row: RecentTabHoverRect,
	/** The collapsed navbar; null when the row is not clipped (the rail is open on hover). */
	rail: RecentTabHoverRect | null,
	list: RecentTabHoverRect | null,
): RecentTabHoverRect | null {
	if (row.bottom <= row.top) return null;
	if (list && (row.bottom <= list.top || row.top >= list.bottom)) return null;
	if (!rail) return { top: row.top, bottom: row.bottom, left: row.left, right: row.right };
	return {
		top: row.top,
		bottom: row.bottom,
		left: Math.max(row.left, rail.left),
		right: Math.min(row.right, rail.right),
	};
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
	/** The keyboard's row, kept while its card lingers. */
	let followed: string | null = null;
	let lingerTimer: unknown = null;
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
	const stopFollowing = () => {
		if (lingerTimer !== null) timers.clearTimeout(lingerTimer);
		lingerTimer = null;
		followed = null;
	};
	// While following, the card up is the keyboard's or none (`follow` replaces the
	// pointer's, `enter` stops following), so a null rect can simply close it.
	const showKeyboard = (key: string, rect: RecentTabHoverRect | null) => {
		if (!rect) {
			set(null);
			return;
		}
		// Re-measured on every scroll frame: a card that did not move must not re-render.
		if (anchor?.source === "keyboard" && anchor.key === key && sameRect(anchor.rect, rect)) return;
		set({ key, rect, source: "keyboard" });
	};

	return {
		enter(key, measure) {
			cancelHide();
			cancelShow();
			stopFollowing();
			// The keyboard's card may sit against the collapsed rail, and resting on a rail
			// row opens the sidebar (sooner than the card's delay). So the pointer's card
			// starts over with the usual delay and lands next to the opened row, never
			// against the full row's edge out over the page before the rail has opened.
			if (anchor?.source === "keyboard") set(null);
			if (anchor) {
				if (anchor.key !== key) set({ key, rect: measure(), source: "pointer" });
				return;
			}
			showTimer = timers.setTimeout(() => {
				showTimer = null;
				set({ key, rect: measure(), source: "pointer" });
			}, RECENT_TAB_HOVER_SHOW_DELAY_MS);
		},
		leave() {
			cancelShow();
			// The pointer leaving a row says nothing about the row the keys are on.
			if (!anchor || anchor.source === "keyboard" || hideTimer !== null) return;
			hideTimer = timers.setTimeout(() => {
				hideTimer = null;
				set(null);
			}, RECENT_TAB_HOVER_HIDE_DELAY_MS);
		},
		holdOpen: cancelHide,
		hide() {
			cancelShow();
			cancelHide();
			stopFollowing();
			set(null);
		},
		follow(key, rect) {
			cancelShow();
			cancelHide();
			stopFollowing();
			followed = key;
			showKeyboard(key, rect);
		},
		reanchor(rect) {
			if (followed !== null) showKeyboard(followed, rect);
		},
		release() {
			if (followed === null || lingerTimer !== null) return;
			// Lingers even with no card up yet: the switch can fire while the highlighted
			// row is still scrolling into view, and the card should appear once it is in.
			lingerTimer = timers.setTimeout(() => {
				lingerTimer = null;
				followed = null;
				if (anchor?.source === "keyboard") set(null);
			}, RECENT_TAB_KEYBOARD_CARD_LINGER_MS);
		},
		unfollow() {
			stopFollowing();
			if (anchor?.source === "keyboard") set(null);
		},
		followedKey: () => followed,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => anchor,
	};
}
