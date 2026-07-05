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
	 * Handle a drop of a subject that is NOT an existing panel (e.g. a sidebar
	 * recent tab). Called with the raw drag state and resolved target so the
	 * caller can create / move a panel however it wants.
	 */
	onDropSubject?: (state: PanelDragState, target: DockviewDropTarget) => void;
	thresholds?: DropZoneThresholds;
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
	const { apiRef, rootRef, onDropSubject, thresholds } = options;
	const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

	useEffect(() => {
		let target: DockviewDropTarget | null = null;

		const unsubMove = onPanelDragMove((state: PanelDragState) => {
			const api = apiRef.current;
			const root = rootRef.current;
			if (!api || !root) return;
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
			if (!api || !final || !resolved) return;
			if (final.panelId) {
				dropExistingPanel(api, final.panelId, resolved);
			} else {
				onDropSubject?.(final, resolved);
			}
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [apiRef, rootRef, onDropSubject, thresholds]);

	return { dropIndicator };
}
