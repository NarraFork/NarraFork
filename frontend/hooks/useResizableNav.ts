/**
 * useResizableNav — the sidebar's width, driven by CSS VARIABLES during a drag.
 *
 * Why an external store rather than `useState`
 * -------------------------------------------
 * The width used to be `useState` inside `AuthenticatedLayout` (1031 lines, ~86
 * hooks), and the drag writes it on every `mousemove`. That re-rendered the whole
 * AppShell each frame — navbar NavLinks, both `RecentTabList`s, every Tooltip. The
 * same component already documents what that costs: an unrelated per-second tick
 * that re-rendered "the whole AppShell (navbar NavLinks, tab strip, tooltips)" was
 * measured at ~140ms of main-thread work per second, and the fix there was to move
 * the subscription into a leaf component (see OutputStatsBadge). The width was the
 * same bug, unfixed.
 *
 * Splitting width from collapsed is the point of the store. They change at wildly
 * different rates:
 *   - `width` moves every frame of a drag, and is needed by exactly one consumer:
 *     the `navbar.width` prop on `<AppShell>`.
 *   - `collapsed` is a boolean derived from it, needed all over the navbar content
 *     (labels, tooltips, padding), and flips at most once per drag.
 *
 * With `useSyncExternalStore` a consumer only re-renders when ITS OWN snapshot
 * changes by `Object.is`. So `useNavCollapsed()` re-renders on the boolean flip and
 * ignores the pixel stream, while `useNavWidth()` — deliberately called only by the
 * thin AppShell wrapper — absorbs it. The layout that hosts the navbar content never
 * subscribes to width at all.
 *
 * WHY REACT IS BYPASSED ENTIRELY MID-DRAG
 * --------------------------------------
 * Isolating the re-render was necessary but NOT sufficient. Mantine's AppShell does
 * not put the navbar width in an inline style: `AppShellMediaStyles` renders an
 * `InlineStyles` element, which is a `<style>` tag written through
 * `dangerouslySetInnerHTML`. So every distinct `navbar.width` REWRITES A STYLE SHEET,
 * which invalidates document-wide CSS and forces a full style recalculation — cost
 * proportional to the whole DOM, not to the navbar. Re-rendering only a thin wrapper
 * does nothing about that; the wrapper is exactly what renders the style tag.
 *
 * So during a drag the width never reaches React at all. `writeWidth` sets the two
 * variables AppShell reads (`--app-shell-navbar-width` for the navbar's own width,
 * `--app-shell-navbar-offset` for Main's padding and the alt-layout Header's margin)
 * directly on the element carrying them, and React is told once on release.
 *
 * Two details make the override hold:
 *   - The variables are set on `document.documentElement`, because Mantine's
 *     `cssVariablesSelector` defaults to `:root` and AppShell runs in `fixed` mode
 *     (its media styles therefore land in the `:root` block rather than on `#id`).
 *     Setting them inline on the same element wins on specificity.
 *   - `--app-shell-transition-duration: 0ms` is forced for the duration of the drag.
 *     Main transitions `padding` and Header transitions `margin-inline-start`, so
 *     without this every frame starts a fresh 200ms animation toward a target that
 *     has already moved, which both smears visually and multiplies the work.
 *
 * The drag listeners are attached on mousedown and removed on mouseup, rather than
 * living for the component's whole lifetime as they did before.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "narrafork_nav_width";
const DEFAULT_WIDTH = 250;
const EXPANDED_MIN = 180;
const COLLAPSED_WIDTH = 60;
const COLLAPSE_THRESHOLD = 72;
const MAX_WIDTH = 480;

/**
 * Read the persisted width, falling back to the default on ANY storage failure.
 *
 * The try/catch is not defensive padding: Safari's private mode and a
 * blocked-cookies profile both make `localStorage` access throw rather than
 * return null. This runs from `getWidth()`, i.e. inside a `useSyncExternalStore`
 * snapshot, so a throw here would take out the render of every component that
 * reads the nav width.
 */
function readStoredWidth(): number {
	try {
		if (typeof localStorage === "undefined") return DEFAULT_WIDTH;
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const n = Number(saved);
			if (n >= COLLAPSED_WIDTH && n <= MAX_WIDTH) return n;
		}
	} catch {
		// Storage unavailable (private mode, quota, blocked): use the default.
	}
	return DEFAULT_WIDTH;
}

/**
 * Persist the width, ignoring storage failures.
 *
 * `setItem` throws under Safari private mode and when the quota is exhausted. The
 * only caller that matters is `endDrag`, which runs as a `mouseup` HANDLER: an
 * exception escaping it would abort the rest of that handler (the listener teardown
 * has already run by then, but the snap write has not been observed by React) and
 * surface as an uncaught error. Losing the persisted width is the correct trade —
 * the live width is already applied.
 */
function persist(width: number): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(STORAGE_KEY, String(width));
	} catch {
		// Storage unavailable: the width still applies for this session.
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Lazily initialised so module import never touches localStorage. */
let currentWidth: number | null = null;
/** Width to restore when expanding from the collapsed rail. */
let lastExpandedWidth: number | null = null;
const listeners = new Set<() => void>();

function getWidth(): number {
	if (currentWidth === null) {
		currentWidth = readStoredWidth();
		lastExpandedWidth = currentWidth >= COLLAPSE_THRESHOLD ? currentWidth : DEFAULT_WIDTH;
	}
	return currentWidth;
}

function getCollapsed(): boolean {
	return getWidth() < COLLAPSE_THRESHOLD;
}

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * The two AppShell variables the navbar width feeds, and the transition switch.
 *
 * `width` sizes the navbar itself; `offset` is what Main pads by and what the
 * alt-layout Header takes as `margin-inline-start`. Both must move together or the
 * sidebar and the content beside it disagree mid-drag.
 */
const NAVBAR_WIDTH_VAR = "--app-shell-navbar-width";
const NAVBAR_OFFSET_VAR = "--app-shell-navbar-offset";
const TRANSITION_VAR = "--app-shell-transition-duration";

/** The element Mantine's `:root` variables resolve against. */
function varsTarget(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	return document.documentElement;
}

/**
 * Push a width straight to CSS, bypassing React.
 *
 * This is the whole point of the drag path: no component re-renders, and — crucially
 * — Mantine's `<style>` tag is not rewritten (see the module comment).
 */
function paintWidth(width: number): void {
	const target = varsTarget();
	if (!target) return;
	const px = `${width}px`;
	target.style.setProperty(NAVBAR_WIDTH_VAR, px);
	target.style.setProperty(NAVBAR_OFFSET_VAR, px);
}

/**
 * Force / restore the AppShell transition duration around a drag.
 *
 * Main transitions `padding` and the alt-layout Header transitions
 * `margin-inline-start`, both off the same variable. Left at its default every drag
 * frame starts a fresh ~200ms animation toward a target that has already moved,
 * which smears visually AND multiplies the work — see the module comment. Restored on
 * release so the collapse toggle (a click, where the animation is wanted) is unaffected.
 */
function setDragTransitionSuppressed(suppressed: boolean): void {
	const target = varsTarget();
	if (!target) return;
	if (suppressed) target.style.setProperty(TRANSITION_VAR, "0ms");
	else target.style.removeProperty(TRANSITION_VAR);
}

/**
 * Hand the width back to React and drop the inline overrides.
 *
 * Order matters: React must have committed the new `navbar.width` BEFORE the inline
 * variables are removed, or there is a frame where the sheet still carries the old
 * value and the sidebar snaps back. `emit()` here runs synchronously through
 * `useSyncExternalStore`, and the removal is deferred one frame.
 */
function releaseToReact(): void {
	emit();
	const target = varsTarget();
	if (!target) return;
	const drop = () => {
		target.style.removeProperty(NAVBAR_WIDTH_VAR);
		target.style.removeProperty(NAVBAR_OFFSET_VAR);
	};
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(drop);
	else drop();
}

/**
 * Write the width.
 *
 * Bails on a no-op so a drag frame that produces the same clamped pixel (dragging
 * against MIN/MAX) costs nothing.
 *
 * `notify` distinguishes the two paths: mid-drag frames paint CSS only, while the
 * settle (and the collapse toggle) tell React. The COLLAPSED boolean is the one
 * exception — it is a genuine React input (labels, tooltips, padding all change), so
 * a frame that crosses the threshold notifies even mid-drag. That happens at most
 * once per drag.
 */
function writeWidth(next: number, notify: boolean): void {
	const previous = getWidth();
	if (previous === next) return;
	const collapsedBefore = previous < COLLAPSE_THRESHOLD;
	currentWidth = next;
	if (next >= COLLAPSE_THRESHOLD) lastExpandedWidth = next;
	paintWidth(next);
	if (notify || collapsedBefore !== next < COLLAPSE_THRESHOLD) emit();
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag
// ─────────────────────────────────────────────────────────────────────────────

interface DragState {
	startX: number;
	startWidth: number;
	startedCollapsed: boolean;
}

let drag: DragState | null = null;

function onMouseMove(event: MouseEvent): void {
	if (!drag) return;
	const raw = drag.startWidth + (event.clientX - drag.startX);
	// CSS only: React hears nothing until the drag ends.
	writeWidth(Math.min(MAX_WIDTH, Math.max(COLLAPSED_WIDTH, raw)), false);
}

function endDrag(): void {
	if (!drag) return;
	const startedCollapsed = drag.startedCollapsed;
	drag = null;
	document.body.style.cursor = "";
	document.body.style.userSelect = "";
	window.removeEventListener("mousemove", onMouseMove);
	window.removeEventListener("mouseup", endDrag);
	// Abnormal terminations (see startNavResize). Removed here too so a normal
	// mouseup does not leave a stale one-shot listener behind.
	window.removeEventListener("blur", endDrag);
	window.removeEventListener("pointercancel", endDrag);
	document.removeEventListener("visibilitychange", onVisibilityChange);
	setDragTransitionSuppressed(false);

	// Snap. Which way depends on where the drag STARTED, so a drag out of the
	// collapsed rail expands and a drag into it collapses.
	const width = getWidth();
	const snapped = startedCollapsed
		? width >= COLLAPSE_THRESHOLD
			? Math.max(EXPANDED_MIN, width)
			: COLLAPSED_WIDTH
		: width < EXPANDED_MIN
			? COLLAPSED_WIDTH
			: width;
	// `writeWidth` no-ops when the snap lands on the current width, so the handover to
	// React is done unconditionally here.
	writeWidth(snapped, true);
	releaseToReact();
	persist(snapped);
}

/** End the drag when the tab is hidden (a `visibilitychange` that hid the page). */
function onVisibilityChange(): void {
	if (document.visibilityState === "hidden") endDrag();
}

/** Begin a resize drag. Stable identity, so it never invalidates a memo. */
export function startNavResize(event: { clientX: number; preventDefault: () => void }): void {
	event.preventDefault();
	drag = {
		startX: event.clientX,
		startWidth: getWidth(),
		startedCollapsed: getCollapsed(),
	};
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
	setDragTransitionSuppressed(true);
	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", endDrag);
	// ── Abnormal terminations ──
	//
	// `mouseup` is not guaranteed to arrive. If the window loses focus while the
	// button is held (alt-tab, a native dialog, dragging out of the browser and
	// releasing there), the release lands on another surface and this drag would stay
	// open indefinitely: `drag` stays non-null AND `document.body.style.userSelect`
	// stays "none", which makes TEXT UNSELECTABLE ACROSS THE WHOLE APP until the next
	// mouseup anywhere. The width itself does not run away (no `mousemove` arrives
	// without focus), so the leaked body style is the visible symptom.
	//
	// `blur` covers focus loss, `pointercancel` the browser taking the gesture over,
	// and `visibilitychange` a backgrounded tab. All three route to the same `endDrag`,
	// which snaps and persists exactly as a normal release does.
	window.addEventListener("blur", endDrag);
	window.addEventListener("pointercancel", endDrag);
	document.addEventListener("visibilitychange", onVisibilityChange);
}

/** Toggle between the collapsed rail and the last expanded width. */
export function toggleNavCollapsed(): void {
	const next = getCollapsed() ? (lastExpandedWidth ?? DEFAULT_WIDTH) : COLLAPSED_WIDTH;
	// A click, not a gesture: React drives it, and the transition is wanted here.
	writeWidth(next, true);
	releaseToReact();
	persist(next);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The live width in px.
 *
 * ⚠️ This subscribes to EVERY drag frame, so it belongs only in a component whose
 * re-render is cheap and whose children are passed through as a stable `children`
 * element (see AppShellWithNavWidth in AppRootLayout). Calling it from a component
 * that renders the navbar content re-creates the original performance bug.
 */
export function useNavWidth(): number {
	return useSyncExternalStore(subscribe, getWidth, getWidth);
}

/**
 * Whether the sidebar is in its collapsed rail form.
 *
 * Safe to call from the layout: the snapshot is a boolean, so a re-render happens
 * only when it flips — at most once per drag — not on the pixel stream.
 */
export function useNavCollapsed(): boolean {
	return useSyncExternalStore(subscribe, getCollapsed, getCollapsed);
}

/**
 * The inline CSS override currently applied, or null when React owns the width.
 * Exposed for tests: the drag path's whole contract is that it paints CSS without
 * notifying React, which is otherwise invisible.
 */
export function readNavWidthOverrideForTest(): { width: string; offset: string } | null {
	const target = varsTarget();
	if (!target) return null;
	const width = target.style.getPropertyValue(NAVBAR_WIDTH_VAR);
	const offset = target.style.getPropertyValue(NAVBAR_OFFSET_VAR);
	return width || offset ? { width, offset } : null;
}

/** Test seam: reset the module store to a known state. */
export function resetNavWidthStoreForTest(width = DEFAULT_WIDTH): void {
	drag = null;
	currentWidth = width;
	lastExpandedWidth = width >= COLLAPSE_THRESHOLD ? width : DEFAULT_WIDTH;
	const target = varsTarget();
	if (target) {
		target.style.removeProperty(NAVBAR_WIDTH_VAR);
		target.style.removeProperty(NAVBAR_OFFSET_VAR);
		target.style.removeProperty(TRANSITION_VAR);
	}
	emit();
}

export const NAV_WIDTH_CONSTANTS = {
	DEFAULT_WIDTH,
	EXPANDED_MIN,
	COLLAPSED_WIDTH,
	COLLAPSE_THRESHOLD,
	MAX_WIDTH,
} as const;
