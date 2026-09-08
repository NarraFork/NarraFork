/**
 * Bridge the global panel-drag singleton (lib/panel-drag) into a Dockview
 * surface: track the pointer, resolve a three-zone drop intent, render an
 * overlay hint, and on release perform swap / merge / split for existing
 * panels — delegating "external subject" drops (e.g. a sidebar tab that has no
 * live panel yet) to the caller via `onDropSubject`.
 *
 * Generic and domain-free: the caller supplies how to materialise an external
 * subject drop.
 */

import type { DockviewApi } from "dockview-react";
import { type RefObject, useEffect, useState } from "react";
import { onPanelDragEnd, onPanelDragMove, type PanelDragState } from "../../lib/panel-drag";
import {
	type DropIndicator,
	type DropIntent,
	type DropZoneThresholds,
	hitTestGroups,
	intentToPosition,
	resolveNativeDrop,
	toIndicator,
} from "./drop-intent";
import { swapPanels } from "./panel-swap";

export interface DockviewDropTarget {
	groupId: string;
	intent: DropIntent;
	targetPanelId: string | undefined;
}

export interface UseDockviewDndOptions {
	apiRef: RefObject<DockviewApi | null>;
	rootRef: RefObject<HTMLElement | null>;
	/**
	 * Handle a drop of a subject that is NOT an existing panel of THIS surface
	 * (a sidebar recent tab, a detached canvas panel, or a live panel belonging to
	 * a different surface). Called with the raw drag state and resolved target so
	 * the caller can create / move / reject it however it wants.
	 */
	onDropSubject?: (state: PanelDragState, target: DockviewDropTarget) => void;
	thresholds?: DropZoneThresholds;
	/**
	 * This surface's identity, matched against `PanelDragState.surfaceId` to tell
	 * "my own panel being rearranged" from "someone else's panel".
	 *
	 * Required once multiple surfaces coexist: panel ids are global, so without it
	 * a surface would resolve a foreign `panelId` against its own api and move the
	 * wrong panel. Leave unset to keep the historical single-surface behaviour
	 * (any drag carrying a `panelId` is treated as local).
	 */
	surfaceId?: string;
}

/**
 * Whether a drag should be handled as an in-surface panel move.
 *
 * True only for a live panel that belongs to THIS surface. A drag with no
 * `panelId` has no live panel at all (sidebar tab, detached canvas panel). A drag
 * whose `surfaceId` names a different surface is someone else's panel: resolving
 * its global `panelId` here would hit our own same-kind panel and move that
 * instead — the silent mis-move this guard exists to prevent.
 *
 * When either side omits `surfaceId`, the drag is treated as local so surfaces
 * that have not opted in keep working exactly as before.
 *
 * Exported for unit testing.
 */
export function isLocalPanelDrag(state: PanelDragState, surfaceId: string | undefined): boolean {
	if (!state.panelId) return false;
	if (state.surfaceId === undefined || surfaceId === undefined) return true;
	return state.surfaceId === surfaceId;
}

/**
 * Whether this surface should engage with a drag at all (hit-test + indicator).
 *
 * A surface can act on exactly two kinds of drags: a LOCAL panel drag (its own
 * live panel being rearranged) and — only when it has an `onDropSubject` — an
 * external subject it knows how to materialise. Everything else must not even
 * show an indicator: the drop belongs to someone else, and a false affordance
 * is worse than none.
 *
 * The concrete bug this guards: on the single-narrator page the focus dock has
 * NO `onDropSubject` (it cannot host another narrator), yet it still lit up its
 * groups with merge/split/swap indicators when a sidebar narrator was dragged
 * over it — while the page-level create-workspace zone showed its own overlay
 * for the same gesture. Dropping never landed in the dock (the page navigates
 * to a fresh workspace instead), so the dock's indicator was a lie; with the
 * dock split (tools open on the right) the two competing highlights made the
 * gesture visibly broken.
 *
 * Exported for unit testing.
 */
export function canSurfaceHandleDrag(
	state: PanelDragState,
	surfaceId: string | undefined,
	hasDropSubject: boolean,
): boolean {
	return isLocalPanelDrag(state, surfaceId) || hasDropSubject;
}

export interface UseDockviewDndResult {
	dropIndicator: DropIndicator | null;
}

/**
 * Marker attribute stamped on every DockviewSurface root, so a drop can ask
 * "which surface is topmost under the pointer" without knowing about any of them.
 */
export const DOCKVIEW_SURFACE_ATTR = "data-dockview-surface";

/** Applied synchronously on the surface root before Dockview paints its overlay. */
export const NATIVE_DROP_PREVIEW_CLASS = "narrafork-native-drop-preview";

/**
 * Native preview lifecycle, kept outside React so child dragleave events and
 * Dockview's synchronous overlay paint can be tested without mocking hooks.
 * Cancel only the native PAINT (CSS covers both in-place and anchored overlays),
 * never the will-show event: preventDefault would disable the drop target too.
 */
export function bindNativeDropPreview(
	api: DockviewApi,
	root: HTMLElement,
	onIndicator: (indicator: DropIndicator | null) => void,
	thresholds?: DropZoneThresholds,
	enableSwapZone = true,
): () => void {
	let current: DropIndicator | null = null;
	const update = (next: DropIndicator | null) => {
		// Not a React className prop: waiting for a render leaves a frame with
		// both indicators. The root is not rewritten by Dockview's own classnames.
		root.classList.toggle(NATIVE_DROP_PREVIEW_CLASS, next !== null);
		if (
			current === next ||
			(current &&
				next &&
				current.variant === next.variant &&
				current.left === next.left &&
				current.top === next.top &&
				current.width === next.width &&
				current.height === next.height)
		)
			return;
		current = next;
		onIndicator(next);
	};
	const clear = () => update(null);
	const subscription = api.onWillShowOverlay((event) => {
		const resolved = event.defaultPrevented
			? null
			: resolveNativeDrop(api, event, thresholds, enableSwapZone);
		update(resolved ? toIndicator(resolved.hit, thresholds) : null);
	});
	const doc = root.ownerDocument;
	const outside = (event: MouseEvent) => {
		const rect = root.getBoundingClientRect();
		return (
			event.clientX < rect.left ||
			event.clientX > rect.right ||
			event.clientY < rect.top ||
			event.clientY > rect.bottom
		);
	};
	const leave = (event: MouseEvent) => {
		// Only the active surface measures anything; many graph docks can coexist.
		if (current && outside(event)) clear();
	};
	const dragLeave = (event: DragEvent) => {
		if (!current) return;
		const destination = event.relatedTarget;
		if (destination && "nodeType" in destination && root.contains(destination as Node)) return;
		// A child->child transition often has a null relatedTarget in native DnD.
		// It is NOT a drag end. Only clear on a real surface/window exit; subsequent
		// dragover/pointermove also clears when the pointer has moved outside.
		if (outside(event) || event.target === root) clear();
	};
	const handleEscape = (event: KeyboardEvent) => {
		if (event.key === "Escape") clear();
	};
	const endEvents = ["drop", "dragend", "pointerup", "pointercancel"] as const;
	for (const name of endEvents) doc.addEventListener(name, clear, true);
	root.addEventListener("dragleave", dragLeave);
	doc.addEventListener("dragover", leave, true);
	doc.addEventListener("pointermove", leave, true);
	doc.addEventListener("keydown", handleEscape, true);
	doc.defaultView?.addEventListener("blur", clear);
	return () => {
		clear();
		subscription.dispose();
		for (const name of endEvents) doc.removeEventListener(name, clear, true);
		root.removeEventListener("dragleave", dragLeave);
		doc.removeEventListener("dragover", leave, true);
		doc.removeEventListener("pointermove", leave, true);
		doc.removeEventListener("keydown", handleEscape, true);
		doc.defaultView?.removeEventListener("blur", clear);
	};
}

/**
 * Whether `root` is the topmost DockviewSurface in a front-to-back hit-test stack.
 *
 * Two requirements pull in opposite directions, which is why this is not a plain
 * `elementFromPoint(...) === root` test:
 *
 *  - Overlapping surfaces must not BOTH act on one drop (a detached canvas panel
 *    can sit on top of a chapter node's dock, and rect containment is true for
 *    both). So ordering has to be respected: only the frontmost surface wins.
 *  - Elements that are not surfaces at all must be transparent to the test. The
 *    concrete bug: @dnd-kit's `<DragOverlay>` is `position: fixed` and follows the
 *    pointer, so the topmost element at the release point is the drag ghost, not
 *    the surface underneath. A plain topmost-element check therefore rejected
 *    EVERY sidebar-tab drop into a live workspace — while the move handler, which
 *    does no such test, still painted the drop indicator. "The highlight shows but
 *    releasing does nothing" was exactly this.
 *
 * So: walk the stack front-to-back, skip anything that belongs to no surface, and
 * let the first surface encountered decide. Exported for unit testing.
 */
export function isTopmostSurface(root: Element, stack: readonly Element[]): boolean {
	for (const el of stack) {
		const surface = el.closest?.(`[${DOCKVIEW_SURFACE_ATTR}]`) ?? null;
		if (!surface) continue;
		return surface === root;
	}
	return false;
}

/**
 * Move / merge / swap an existing dockview panel per the resolved intent.
 * Exported for unit testing the merge/split/swap dispatch (see
 * useDockviewDnd.test.ts); not part of the public surface API.
 */
export function dropExistingPanel(
	api: DockviewApi,
	panelId: string,
	target: DockviewDropTarget,
): void {
	const panel = api.getPanel(panelId);
	const group = api.groups.find((g) => g.id === target.groupId);
	if (!panel || !group) return;

	// No-op guard: dropping a panel onto the group it ALREADY solely occupies
	// never changes the arrangement. Without this, a split intent (left/right/
	// above/below) would call moveTo against the panel's own lone group — which
	// tears the group down mid-move and can make the panel vanish. Applies to
	// every intent (split + merge), so just re-activate and bail.
	if (panel.api.group?.id === group.id && group.panels.length === 1) {
		panel.api.setActive();
		return;
	}

	if (target.intent === "swap") {
		if (target.targetPanelId && target.targetPanelId !== panelId) {
			swapPanels(api, panelId, target.targetPanelId);
		}
		return;
	}

	// No-op when merging a panel into a (multi-panel) group it already belongs to.
	if (target.intent === "merge" && panel.api.group?.id === group.id) {
		panel.api.setActive();
		return;
	}

	if (target.intent === "merge") {
		// Tab the panel INTO the target group. Use an explicit index rather than
		// `position: "center"`: a bare center position does not reliably relocate
		// a panel that is the sole member of its source group (the move is a
		// no-op and the two groups never collapse). Appending by index moves the
		// panel into the target group's tab strip and lets the emptied source
		// group be disposed.
		panel.api.moveTo({ group, index: group.panels.length });
	} else {
		panel.api.moveTo({ group, position: intentToPosition(target.intent) });
	}
	panel.api.setActive();
}

export function useDockviewDnd(options: UseDockviewDndOptions): UseDockviewDndResult {
	const { apiRef, rootRef, onDropSubject, thresholds, surfaceId } = options;
	const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

	useEffect(() => {
		const unsubMove = onPanelDragMove((state: PanelDragState) => {
			const api = apiRef.current;
			const root = rootRef.current;
			if (!api || !root) return;
			// Never advertise a drop this surface cannot perform (see
			// canSurfaceHandleDrag): with no `onDropSubject` an external subject
			// (e.g. a sidebar narrator) can never land here, and the indicator would
			// compete with the outer drop zone that actually owns the gesture.
			if (!canSurfaceHandleDrag(state, surfaceId, !!onDropSubject)) {
				setDropIndicator(null);
				return;
			}
			const hit = hitTestGroups(api, state.x, state.y, state.panelId, thresholds);
			if (!hit) {
				setDropIndicator(null);
				return;
			}
			setDropIndicator(toIndicator(hit, thresholds));
		});

		const unsubEnd = onPanelDragEnd((final: PanelDragState | null) => {
			setDropIndicator(null);
			const api = apiRef.current;
			const root = rootRef.current;
			if (!api || !root || !final) return;
			if (!canSurfaceHandleDrag(final, surfaceId, !!onDropSubject)) return;
			// Release may have crossed a zone boundary since the last move event.
			const hit = hitTestGroups(api, final.x, final.y, final.panelId, thresholds);
			if (!hit) return;
			const resolved = {
				groupId: hit.group.id,
				intent: hit.intent,
				targetPanelId: hit.targetPanelId,
			};

			// Only the surface the pointer was actually released over may act.
			//
			// Every surface subscribes to this singleton, so without this check a drag
			// from surface A onto surface B is handled TWICE: B creates the panel while A
			// — for which `isLocalPanelDrag` is true — also "rearranges" it locally from
			// its own stale hit-test. The result is the same panel in both places, which
			// is what "the target got it but the original is still there" was.
			//
			// DOM hit-testing rather than comparing rects: surfaces overlap on the
			// story-network canvas (a detached node can sit on top of a chapter node's
			// dock), and rect containment would be true for both. But the topmost
			// element is often NOT a surface (a drag ghost rides under the pointer), so
			// the whole stack is consulted and non-surface layers are skipped — see
			// `isTopmostSurface`.
			const stack = document.elementsFromPoint?.(final.x, final.y) ?? [];
			if (!isTopmostSurface(root, stack)) return;

			if (isLocalPanelDrag(final, surfaceId)) {
				// biome-ignore lint/style/noNonNullAssertion: isLocalPanelDrag requires panelId
				dropExistingPanel(api, final.panelId!, resolved);
			} else {
				onDropSubject?.(final, resolved);
			}
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [apiRef, rootRef, onDropSubject, thresholds, surfaceId]);

	return { dropIndicator };
}
