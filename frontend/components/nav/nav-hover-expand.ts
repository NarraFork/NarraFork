/**
 * When the collapsed sidebar opens on hover, and when it closes again. No DOM or React.
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
