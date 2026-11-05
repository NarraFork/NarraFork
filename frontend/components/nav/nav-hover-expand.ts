/**
 * When the collapsed sidebar opens on hover, and when it closes again. No React; the
 * timing (`createNavHoverIntent`) touches no DOM either, the hold checks at the bottom do.
 *
 *   - Resting the mouse on the rail for {@link NAV_HOVER_EXPAND_DELAY_MS} opens it; passing
 *     over it on the way to something else does not.
 *   - Leaving closes it after {@link NAV_HOVER_COLLAPSE_DELAY_MS}, unless something still
 *     needs it open (`isHeld`: a drag in flight, an open menu, focus in its search box).
 *     A held panel is checked again every {@link NAV_HOVER_HOLD_RECHECK_MS}.
 *   - `keep` cancels a pending close without opening: the pointer reached something the
 *     open panel owns (its menu, the details card) that lies outside its box.
 */

export const NAV_HOVER_EXPAND_DELAY_MS = 250;
export const NAV_HOVER_COLLAPSE_DELAY_MS = 150;
export const NAV_HOVER_HOLD_RECHECK_MS = 300;

interface Timers {
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
}

const defaultTimers: Timers = {
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface NavHoverIntent {
	/** The pointer is over the rail. */
	enter(): void;
	/** The pointer is over something the open panel owns: stay open, but never open. */
	keep(): void;
	/** The pointer is somewhere else. */
	leave(): void;
	/** Open now, no delay (a click on a rail icon, or Cmd/Ctrl+K). */
	open(): void;
	/** Close now and forget pending timers (the sidebar was pinned open, or unmounts). */
	reset(): void;
	isExpanded(): boolean;
}

export function createNavHoverIntent(options: {
	onChange: (expanded: boolean) => void;
	isHeld: () => boolean;
	timers?: Timers;
}): NavHoverIntent {
	const timers = options.timers ?? defaultTimers;
	let expanded = false;
	let openTimer: unknown = null;
	let closeTimer: unknown = null;

	const set = (next: boolean) => {
		if (next === expanded) return;
		expanded = next;
		options.onChange(next);
	};
	const cancelOpen = () => {
		if (openTimer !== null) timers.clearTimeout(openTimer);
		openTimer = null;
	};
	const cancelClose = () => {
		if (closeTimer !== null) timers.clearTimeout(closeTimer);
		closeTimer = null;
	};
	const scheduleClose = (ms: number) => {
		closeTimer = timers.setTimeout(() => {
			closeTimer = null;
			if (options.isHeld()) scheduleClose(NAV_HOVER_HOLD_RECHECK_MS);
			else set(false);
		}, ms);
	};

	return {
		enter() {
			cancelClose();
			if (expanded || openTimer !== null) return;
			openTimer = timers.setTimeout(() => {
				openTimer = null;
				set(true);
			}, NAV_HOVER_EXPAND_DELAY_MS);
		},
		keep() {
			if (expanded) cancelClose();
		},
		leave() {
			cancelOpen();
			if (!expanded || closeTimer !== null) return;
			scheduleClose(NAV_HOVER_COLLAPSE_DELAY_MS);
		},
		open() {
			cancelOpen();
			cancelClose();
			set(true);
		},
		reset() {
			cancelOpen();
			cancelClose();
			set(false);
		},
		isExpanded: () => expanded,
	};
}

// ── What keeps the open panel open ──────────────────────────────────────────

/**
 * Something open that the pointer may be on while outside the box: a menu opened from
 * the panel, or a Modal / Drawer / Menu / Popover layer (the theme stamps
 * `nf-overlay-layer` on all of them, see lib/mantine-theme.ts). Closing the panel under
 * one would also remount the bell and the workspace switcher, which own them.
 */
export const OPEN_POPUP_SELECTOR = '[aria-haspopup][aria-expanded="true"]';
/** Also the sidebar's own floating parts: the row menu and the details card. */
const LAYER_SELECTOR = ".nf-overlay-layer, [data-nav-keep-open]";

/** Where an open Modal / Drawer actually paints: its root is an empty wrapper. */
const MODAL_CONTENT_SELECTOR = ".mantine-Modal-content, .mantine-Drawer-content";

function hasArea(el: Element | null): boolean {
	if (!el) return false;
	const rect = el.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

/**
 * Is any such layer actually showing?
 *
 * Presence in the DOM is not enough: `keepMounted` menus and drawers (the session
 * toolbar's overflow menu, the file viewer drawer) stay in the DOM while closed, and
 * counting them held the panel open for good. A shown dropdown or card has a box with
 * area; a Modal / Drawer root is an empty wrapper even when open, so for those it is the
 * content box that counts (hidden with `display: none` while closed).
 */
export function hasVisibleLayer(root: ParentNode = document): boolean {
	for (const el of root.querySelectorAll<HTMLElement>(LAYER_SELECTOR)) {
		if (hasArea(el) || hasArea(el.querySelector(MODAL_CONTENT_SELECTOR))) return true;
	}
	return false;
}

/**
 * Keyboard focus (and any focused text field, which browsers always count as visible).
 * A mouse-clicked link keeps focus too but does not match, so it never pins the panel.
 * DOMs without `:focus-visible` support throw on the selector; treat that as "no".
 */
export function matchesFocusVisible(el: Element): boolean {
	try {
		return el.matches(":focus-visible");
	} catch {
		return false;
	}
}

/** Does the panel hold keyboard focus (see `matchesFocusVisible`)? */
export function hasFocusVisibleWithin(panel: Element): boolean {
	const focused = panel.ownerDocument.activeElement;
	return !!focused && panel.contains(focused) && matchesFocusVisible(focused);
}

/** Inside the panel, or inside something it opened. */
export function isOwnedTarget(panel: HTMLElement, target: EventTarget | null): boolean {
	if (!(target instanceof Node)) return false;
	if (panel.contains(target)) return true;
	return target instanceof Element && target.closest(LAYER_SELECTOR) !== null;
}
