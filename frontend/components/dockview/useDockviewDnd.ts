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
		let target: DockviewDropTarget | null = null;

		const unsubMove = onPanelDragMove((state: PanelDragState) => {
			const api = apiRef.current;
			const root = rootRef.current;
			if (!api || !root) return;
			// Never advertise a drop this surface cannot perform (see
			// canSurfaceHandleDrag): with no `onDropSubject` an external subject
			// (e.g. a sidebar narrator) can never land here, and the indicator would
			// compete with the outer drop zone that actually owns the gesture.
			if (!canSurfaceHandleDrag(state, surfaceId, !!onDropSubject)) {
				target = null;
				setDropIndicator(null);
				return;
			}
			const hit = hitTestGroups(api, state.x, state.y, state.panelId, thresholds);
			if (!hit) {
				target = null;
				setDropIndicator(null);
				return;
			}
			target = { groupId: hit.group.id, intent: hit.intent, targetPanelId: hit.targetPanelId };
			setDropIndicator(toIndicator(hit, thresholds));
		});

		const unsubEnd = onPanelDragEnd((final: PanelDragState | null) => {
			const resolved = target;
			target = null;
			setDropIndicator(null);
			const api = apiRef.current;
			const root = rootRef.current;
			if (!api || !root || !final || !resolved) return;

			// Only the surface the pointer was actually released over may act.
			//
			// Every surface subscribes to this singleton, so without this check a drag
			// from surface A onto surface B is handled TWICE: B creates the panel while A
			// — for which `isLocalPanelDrag` is true — also "rearranges" it locally from
			// its own stale hit-test. The result is the same panel in both places, which
			// is what "the target got it but the original is still there" was.
			//
			// `elementFromPoint` rather than comparing rects: surfaces overlap on the
			// story-network canvas (a detached node can sit on top of a chapter node's
			// dock), and rect containment would be true for both. Hit-testing the DOM
			// answers "which one is on top here", which is what the user aimed at.
			const dropped = document.elementFromPoint(final.x, final.y);
			if (!dropped || !root.contains(dropped)) return;

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
