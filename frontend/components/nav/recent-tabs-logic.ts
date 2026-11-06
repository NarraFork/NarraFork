/**
 * Pure logic extracted out of `RecentTabs.tsx` — no React, no JSX.
 *
 * WHY IT IS A SEPARATE MODULE
 * --------------------------
 * `@vitejs/plugin-react` only treats a module as a valid Fast Refresh boundary when EVERY
 * one of its exports is a component. `RecentTabs.tsx` exported these four helpers
 * alongside `RecentTabList`, so each edit produced:
 *
 *     invalidate /components/nav/RecentTabs.tsx: Could not Fast Refresh
 *       ("autoScrollAllowedForPointer" export is incompatible)
 *
 * The invalidation propagates up through `AppRootLayout`, and any chain that reaches the
 * entry ends in a full page reload. Moving the non-component exports here makes
 * `RecentTabs.tsx` a valid boundary again, so a change to the tab list hot-updates in
 * place instead of reloading the app.
 *
 * These were already the parts worth testing independently (see `RecentTabs.swipe.test.ts`
 * and `RecentTabs.autoscroll.test.ts`), so the split follows the existing seam rather than
 * inventing one.
 */

// Imported from where the type is DEFINED, not through `hooks/useRecentTabs` which
// re-exports it: that module pulls in React Query, and a type-only import there would
// still be a real module edge for the HMR graph this split exists to keep small.
import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";

/** Horizontal travel, in px, at which a released swipe commits instead of springing back. */
export const SWIPE_THRESHOLD = 80;

/** What releasing a horizontal swipe at `swipeX` should do. */
export type SwipeRelease = "close" | "menu" | "cancel";

/**
 * Decide the outcome of a released horizontal swipe on a tab row.
 *
 * Extracted from the component because the two directions mean very different things —
 * right REMOVES the tab, left only opens its menu — and a sign error would silently turn
 * a menu gesture into a close.
 *
 * Left opens the row's context menu because touch has no right-click: long-press is the
 * drag gesture, so the platform `contextmenu` it fires is suppressed by the row.
 */
export function classifySwipeRelease(swipeX: number, canMenu: boolean): SwipeRelease {
	if (swipeX > SWIPE_THRESHOLD) return "close";
	if (canMenu && swipeX < -SWIPE_THRESHOLD) return "menu";
	return "cancel";
}

/**
 * Clamp a swipe's live travel.
 *
 * Left travel is suppressed entirely when the row has no menu: a row that slides open,
 * shows nothing, and springs back reads as a broken gesture rather than an absent one.
 */
export function clampSwipeTravel(dx: number, canMenu: boolean): number {
	return canMenu ? dx : Math.max(0, dx);
}

/**
 * Whether a scroll container may auto-scroll for the current pointer position.
 *
 * dnd-kit's auto-scroller decides the VERTICAL direction from the activation rect's
 * `top`/`bottom` only (`getScrollDirectionAndSpeed`), so a pointer that has left the
 * sidebar horizontally still drives the tab list as long as its height falls inside the
 * container's threshold band. That is wrong once the pointer is over the narrator /
 * workspace surface: the list scrolls under a drag that is no longer about ordering, and
 * the drop target keeps sliding away.
 *
 * So the horizontal test that the built-in vertical logic omits is added here: the
 * container may only scroll while the pointer is inside its own column.
 *
 * Returns true when the pointer position is unknown — keyboard-initiated drags and the
 * frames before the first move have no coordinates, and blocking them would disable
 * auto-scroll outright rather than scope it.
 */
export function autoScrollAllowedForPointer(
	pointerX: number | null,
	rect: { left: number; right: number },
): boolean {
	if (pointerX === null) return true;
	return pointerX >= rect.left && pointerX <= rect.right;
}

/** Whether `tab` is the one the current `pathname` is showing. */
export function isTabActive(tab: RecentTab, pathname: string): boolean {
	if (tab.type === "project") {
		return pathname === `/projects/${tab.id}`;
	}
	// A folder is not a page.
	if (tab.type === "folder") return false;
	// narrator and subagent both route to /narrators/:id
	return pathname === `/narrators/${tab.id}`;
}

/**
 * Whether a status event must stay silent (no notification sound, no PWA
 * browser notification) even though it is an attention state.
 *
 * True only for the done-transition (`status === "idle"`) that the server
 * flagged with `backgroundWorkActive`: the narrator's background work whose
 * completion wakes it (bash tasks / subagents — never transfers or services)
 * is still running, so the session is not actually finished, and the wake-up
 * turn after the last such task completes emits a fresh, unflagged done which
 * notifies normally. Permission waits (`waiting`) always stay audible — the
 * agent is blocked on the user, background work or not.
 *
 * The favicon alert and unread badge are deliberately NOT gated by this — they
 * are in-app state indicators, not notifications.
 */
export function isBackgroundWorkSilencedStatus(event: {
	status?: string;
	backgroundWorkActive?: boolean;
}): boolean {
	return event.backgroundWorkActive === true && event.status === "idle";
}
