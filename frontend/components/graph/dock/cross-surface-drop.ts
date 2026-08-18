/**
 * Moving a panel between two dockview surfaces on the story-network canvas by
 * dragging its TAB (dockview's own native drag-and-drop).
 *
 * Dockview refuses this on its own, in two separate places:
 *
 *  1. `canDisplayOverlay` (`dockviewGroupPanelModel.js:1354-1357`) fires
 *     `onUnhandledDragOver` for a drag it does not recognise as its own and returns
 *     `event.isAccepted`. Nobody accepting it means **no drop overlay is ever
 *     drawn** — the target looks undroppable rather than merely refusing on
 *     release. This is what "can't drag into the detached node" was.
 *  2. `handleDropEvent` (`:1386`) only performs an internal move when
 *     `data.viewId === this.accessor.id`, i.e. within ONE dockview instance.
 *     Everything else falls through to `onDidDrop` (`:1438`), which the canvas
 *     surfaces have to implement themselves.
 *
 * So a cross-surface tab move needs both hooks, and this module holds the shared
 * logic: the chapter-node dock and the detached-node dock behave identically here,
 * and duplicating "close on the source, create on the target" is exactly the kind
 * of ordering that drifts (getting it backwards leaves the panel in two surfaces,
 * each with its own live session).
 */

import type { DockviewApi, DockviewDidDropEvent, DockviewDndOverlayEvent } from "dockview-react";
import { getPanelData } from "dockview-react";
import {
	dockPanelId,
	fileDockPanelId,
	NARRATOR_DOCK_COMPONENT,
	subagentDockPanelId,
} from "../../narrator/dock/dock-panel-types";
import { getChapterDock } from "./dock-registry";
import { resolveTabDetachSubject } from "./tab-detach";

/**
 * Accept a tab dragged in from ANOTHER surface, so dockview draws a drop overlay.
 *
 * Refuses drags from this same surface: those are dockview's own business (tab
 * reordering, splitting), and accepting them here would put our handler in the way
 * of behaviour that already works.
 */
export function acceptForeignPanelDragOver(event: DockviewDndOverlayEvent, api: DockviewApi): void {
	if (shouldAcceptForeignPanel(getPanelData()?.panelId, api)) event.accept();
}

/**
 * The accept/reject decision, split out from the dockview event so it is testable
 * without reaching into dockview's module-level drag singleton (which it does not
 * export a setter for).
 */
export function shouldAcceptForeignPanel(
	panelId: string | null | undefined,
	api: Pick<DockviewApi, "getPanel">,
): boolean {
	if (!panelId) return false;
	// Already ours → let dockview handle it internally (reorder / split).
	if (api.getPanel(panelId)) return false;
	// Only panels some mounted surface holds and we know how to rebuild.
	return resolveTabDetachSubject(panelId) !== null;
}

/**
 * Complete a cross-surface tab move: close the panel on the surface that owns it,
 * then create it here.
 *
 * Returns true when it handled the drop, so callers can fall through to their own
 * logic otherwise.
 */
export function handleForeignPanelDrop(
	event: DockviewDidDropEvent,
	api: DockviewApi,
	target: { narratorId: string; chapterId: string },
): boolean {
	// The event's own `getData()`, not the global `getPanelData()`: the drag payload is
	// a module-level singleton that the drag source disposes on drag end, so reading it
	// here races with that cleanup. The event captured it at drop time.
	const panelId = event.getData()?.panelId;
	if (!panelId) return false;
	// A panel this surface already has is not a cross-surface move.
	if (api.getPanel(panelId)) return false;

	const subject = resolveTabDetachSubject(panelId);
	if (!subject) return false;

	// Close on the source FIRST. Reversed, a failure in between would leave the same
	// panel live in two surfaces at once.
	const sourceApi = getChapterDock(subject.surfaceId)?.apiRef.current;
	const sourcePanel = sourceApi?.getPanel(panelId);
	if (!sourcePanel) return false;
	sourcePanel.api.close();

	const { kind, resourceId } = subject;
	// Multi-instance kinds are keyed by their resource; the rest are singletons per
	// surface (`dockPanelId` deliberately does not accept the former).
	if ((kind === "subagent" || kind === "file") && !resourceId) return false;
	const newPanelId =
		kind === "subagent"
			? subagentDockPanelId(resourceId as string)
			: kind === "file"
				? fileDockPanelId(resourceId as string)
				: dockPanelId(kind);

	api.addPanel({
		id: newPanelId,
		component: NARRATOR_DOCK_COMPONENT[kind],
		params:
			kind === "subagent"
				? { panelType: "subagent" as const, subagentNarratorId: resourceId ?? "" }
				: kind === "file"
					? { panelType: "file" as const, filePath: resourceId ?? "" }
					: { panelType: kind, narratorId: target.narratorId, chapterId: target.chapterId },
		// Dropped position: dockview reports which group and edge the pointer was
		// over; `position` is absent for a plain tab-strip drop.
		...(event.group ? { position: { referenceGroup: event.group } } : {}),
	});
	return true;
}
