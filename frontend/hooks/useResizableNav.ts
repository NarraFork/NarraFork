/**
 * Sidebar width store: React owns settled widths; DOM layout properties own drags.
 *
 * `useNavCollapsed` isolates the rare boolean flips from the pixel stream, and
 * `useNavWidth` belongs only in the thin AppShell wrapper. Ordinary drag frames
 * never notify React: Mantine otherwise rewrites its AppShell <style> element.
 *
 * Updating inherited CSS variables on `html` was still expensive: a dashboard
 * trace showed ~643 elements restyled per frame (~1.22s across 180 frames). Writing
 * width/padding/margin on the three layout consumers reduced that to ~3 elements
 * (~66ms). Cache those nodes at pointerdown; do no DOM queries or geometry reads
 * on pointermove. Content still reflows normally alongside the sidebar.
 *
 * Suppress transitions on the actual consumers, not a variable on `html`:
 * AppShell declares its own transition duration, shadowing an ancestor override.
 * Restore the original inline properties after React has committed the final width.
 *
 * Pointer events cover mouse, touch and pen. The handle's `touch-action: none`
 * prevents touch drags being claimed by scrolling; listeners live only for a drag.
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
 * only caller that matters is `endDrag`, which runs as a `pointerup` HANDLER: an
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

interface SavedStyle {
	style: CSSStyleDeclaration;
	property: string;
	value: string;
	priority: string;
}

interface DragStyles {
	navbar: HTMLElement | null;
	main: HTMLElement | null;
	offsetElements: HTMLElement[];
	saved: SavedStyle[];
}

let dragStyles: DragStyles | null = null;
let releaseFrame: number | null = null;

/** Resolve and save only the layout properties owned by the resize gesture. */
function captureDragStyles(target?: HTMLElement | null): DragStyles {
	const shell =
		target?.closest(".mantine-AppShell-root") ?? document.querySelector(".mantine-AppShell-root");
	const navbar = shell?.querySelector<HTMLElement>(".mantine-AppShell-navbar") ?? null;
	const main = shell?.querySelector<HTMLElement>(".mantine-AppShell-main") ?? null;
	const offsetElements =
		shell?.getAttribute("data-layout") === "alt"
			? Array.from(
					shell.querySelectorAll<HTMLElement>(".mantine-AppShell-header, .mantine-AppShell-footer"),
				)
			: [];
	const saved: SavedStyle[] = [];
	const save = (element: HTMLElement | null, property: string) => {
		if (!element) return;
		saved.push({
			style: element.style,
			property,
			value: element.style.getPropertyValue(property) || "",
			priority: element.style.getPropertyPriority(property),
		});
	};
	save(navbar, "width");
	save(main, "padding-inline-start");
	for (const element of offsetElements) save(element, "margin-inline-start");
	for (const element of [navbar, main, ...offsetElements]) {
		save(element, "transition-duration");
		element?.style.setProperty("transition-duration", "0ms");
	}
	return { navbar, main, offsetElements, saved };
}

/** Drop only our overrides, preserving unrelated styles and original priorities. */
function restoreDragStyles(): void {
	if (releaseFrame !== null) {
		cancelAnimationFrame(releaseFrame);
		releaseFrame = null;
	}
	if (!dragStyles) return;
	for (const { style, property, value, priority } of dragStyles.saved) {
		if (value) style.setProperty(property, value, priority);
		else style.removeProperty(property);
	}
	dragStyles = null;
}

/** Non-inherited properties avoid restyling every descendant of the AppShell. */
function paintWidth(width: number): void {
	if (!dragStyles) return;
	const px = `${width}px`;
	dragStyles.navbar?.style.setProperty("width", px);
	dragStyles.main?.style.setProperty(
		"padding-inline-start",
		`calc(${px} + var(--app-shell-padding))`,
	);
	for (const element of dragStyles.offsetElements) {
		element.style.setProperty("margin-inline-start", px);
	}
}

/** Keep overrides (including 0ms transitions) until React commits the final width. */
function releaseToReact(): void {
	emit();
	if (!dragStyles) return;
	if (releaseFrame !== null) cancelAnimationFrame(releaseFrame);
	const releasedStyles = dragStyles;
	const drop = () => {
		// A stale callback must never clear a newer gesture's overrides.
		if (dragStyles !== releasedStyles || drag) return;
		releaseFrame = null;
		restoreDragStyles();
	};
	// Hidden tabs suspend animation frames. React's store update is queued first;
	// clean up after it without waiting indefinitely for the page to become visible.
	if (document.visibilityState === "hidden") queueMicrotask(drop);
	else if (typeof requestAnimationFrame === "function") releaseFrame = requestAnimationFrame(drop);
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

function onPointerMove(event: PointerEvent): void {
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
	window.removeEventListener("pointermove", onPointerMove);
	window.removeEventListener("pointerup", endDrag);
	// Abnormal terminations (see startNavResize). Removed here too so a normal
	// release does not leave a stale one-shot listener behind.
	window.removeEventListener("blur", endDrag);
	window.removeEventListener("pointercancel", endDrag);
	document.removeEventListener("visibilitychange", onVisibilityChange);

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
export function startNavResize(event: {
	clientX: number;
	preventDefault: () => void;
	currentTarget?: HTMLElement | null;
}): void {
	event.preventDefault();
	if (drag) endDrag();
	// A release frame from the previous gesture must never clear the next one.
	restoreDragStyles();
	dragStyles = captureDragStyles(event.currentTarget);
	drag = {
		startX: event.clientX,
		startWidth: getWidth(),
		startedCollapsed: getCollapsed(),
	};
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", endDrag);
	// A release outside the window, browser cancellation, or backgrounded tab may
	// never deliver pointerup. All must end the drag and release selection blocking.
	window.addEventListener("blur", endDrag);
	window.addEventListener("pointercancel", endDrag);
	document.addEventListener("visibilitychange", onVisibilityChange);
}

/** Toggle between the collapsed rail and the last expanded width. */
export function toggleNavCollapsed(): void {
	if (drag) endDrag();
	restoreDragStyles();
	const next = getCollapsed() ? (lastExpandedWidth ?? DEFAULT_WIDTH) : COLLAPSED_WIDTH;
	// No drag overrides: React drives the click, including its normal transition.
	writeWidth(next, true);
	releaseToReact();
	persist(next);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The settled width (also notified at collapse-threshold crossings). Keep this
 * subscription in the thin AppShell wrapper so width-only commits do not recreate
 * navbar content. Ordinary drag frames paint layout properties without emitting.
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

/** Current layout overrides, exposed for render-isolation and handover tests. */
export function readNavWidthOverrideForTest(): { width: string; offset: string } | null {
	if (!dragStyles) return null;
	const width = dragStyles.navbar?.style.getPropertyValue("width") || "";
	const offset = dragStyles.offsetElements[0]?.style.getPropertyValue("margin-inline-start") || "";
	return width || offset ? { width, offset } : null;
}

/** Test seam: reset the module store and any pending gesture to a known state. */
export function resetNavWidthStoreForTest(width = DEFAULT_WIDTH): void {
	if (drag) endDrag();
	restoreDragStyles();
	currentWidth = width;
	lastExpandedWidth = width >= COLLAPSE_THRESHOLD ? width : DEFAULT_WIDTH;
	emit();
}

export const NAV_WIDTH_CONSTANTS = {
	DEFAULT_WIDTH,
	EXPANDED_MIN,
	COLLAPSED_WIDTH,
	COLLAPSE_THRESHOLD,
	MAX_WIDTH,
} as const;
