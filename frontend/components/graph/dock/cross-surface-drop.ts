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
import type { PanelDragState } from "../../../lib/panel-drag";
import {
	dockPanelId,
	fileDockPanelId,
	NARRATOR_DOCK_COMPONENT,
	resolveFilePanel,
	subagentDockPanelId,
} from "../../narrator/dock/dock-panel-types";
import { filePanelResourceId, filePanelResourceParams } from "../../narrator/panels/panel-kind";
import { isDetachablePanelKind } from "./detachable";
import { getChapterDock } from "./dock-registry";
import { readPanelSubject, resolveTabDetachSubject, type TabDetachSubject } from "./tab-detach";

/**
 * Accept a tab dragged in from ANOTHER surface, so dockview draws a drop overlay.
 *
 * Refuses drags from this same surface: those are dockview's own business (tab
 * reordering, splitting), and accepting them here would put our handler in the way
 * of behaviour that already works.
 */
export function acceptForeignPanelDragOver(event: DockviewDndOverlayEvent, api: DockviewApi): void {
	const transfer = getPanelData();
	if (shouldAcceptForeignPanel(transfer?.panelId, api, transfer?.viewId)) event.accept();
}

/**
 * The accept/reject decision, split out from the dockview event so it is testable
 * without reaching into dockview's module-level drag singleton (which it does not
 * export a setter for).
 */
export function shouldAcceptForeignPanel(
	panelId: string | null | undefined,
	api: Pick<DockviewApi, "id">,
	viewId: string | null | undefined,
): boolean {
	if (!panelId || !viewId) return false;
	// Already ours → let dockview handle it internally (reorder / split).
	if (viewId === api.id) return false;
	// Only panels some mounted surface holds and we know how to rebuild.
	const subject = resolveTabDetachSubject(panelId, viewId);
	return (
		subject !== null &&
		(!(subject.kind === "file" || subject.kind === "subagent") || !!subject.resourceId)
	);
}

/** Read the live source, retaining implicit authority rather than a header fallback. */
export function resolvePanelDragSource(
	drag: Pick<
		PanelDragState,
		"toolKind" | "panelId" | "surfaceId" | "resourceId" | "largeFileConfirmed"
	>,
) {
	if (!isDetachablePanelKind(drag.toolKind)) return null;
	if (!drag.panelId) return null;
	const dock = getChapterDock(drag.surfaceId);
	const api = dock?.apiRef.current;
	const panel = api?.getPanel(drag.panelId);
	const subject = panel ? readPanelSubject(panel.params) : null;
	if (!api || !panel || !dock || subject?.kind !== drag.toolKind) return null;
	if ((subject.kind === "file" || subject.kind === "subagent") && !subject.resourceId) return null;
	if (subject.kind === "file") {
		if (!drag.resourceId || !subject.resourceId) return null;
		const requested = filePanelResourceParams(drag.resourceId);
		if (
			!resolveFilePanel(
				[panel],
				{ panelType: "file", ...requested, hostNarratorId: dock.narratorId },
				panel.id,
				"focus",
			).existing
		)
			return null;
		// A live header carries its effective reader. Preserve the source's explicit
		// reader field so implicit authority follows the target's narrator context.
		const actual = filePanelResourceParams(subject.resourceId);
		subject.resourceId = filePanelResourceId(
			actual.filePath,
			actual.deviceId,
			actual.referenceOrigin || requested.referenceOrigin,
			actual.toolEdit,
			actual.fileNarratorId,
		);
	} else if (subject.kind === "subagent" && subject.resourceId !== drag.resourceId) {
		return null;
	}
	if (drag.largeFileConfirmed === true && subject.kind === "file")
		subject.largeFileConfirmed = true;
	return { api, panel, subject };
}

/** Release a validated pointer source, leaving the target untouched on a close veto. */
export function releasePanelDragSource(
	drag: PanelDragState,
	targetApi: Pick<DockviewApi, "id">,
): Pick<TabDetachSubject, "kind" | "resourceId" | "largeFileConfirmed"> | null {
	if (!isDetachablePanelKind(drag.toolKind)) return null;
	if (!drag.panelId) {
		return {
			kind: drag.toolKind,
			resourceId: drag.resourceId,
			largeFileConfirmed: drag.largeFileConfirmed,
		};
	}
	const source = resolvePanelDragSource(drag);
	if (!source || source.api.id === targetApi.id) return null;
	source.panel.api.close();
	return source.api.getPanel(drag.panelId) ? null : source.subject;
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
	const transfer = event.getData();
	const panelId = transfer?.panelId;
	if (!panelId || !transfer.viewId) return false;
	// A panel this surface already has is not a cross-surface move.
	if (transfer.viewId === api.id) return false;

	const subject = resolveTabDetachSubject(panelId, transfer.viewId);
	if (!subject) return false;
	const { kind, resourceId } = subject;
	if ((kind === "subagent" || kind === "file") && !resourceId) return false;

	// Close on the source FIRST. Reversed, a failure in between would leave the same
	// panel live in two surfaces at once.
	const sourceApi = getChapterDock(subject.surfaceId)?.apiRef.current;
	const sourcePanel = sourceApi?.getPanel(panelId);
	if (!sourcePanel) return false;
	sourcePanel.api.close();
	if (sourceApi?.getPanel(panelId)) return false;

	// Multi-instance kinds are keyed by their resource; the rest are singletons per
	// surface (`dockPanelId` deliberately does not accept the former).
	const fileTarget = filePanelResourceParams(resourceId ?? "");
	const canonicalId =
		kind === "subagent"
			? subagentDockPanelId(resourceId as string)
			: kind === "file"
				? fileDockPanelId(
						fileTarget.filePath,
						fileTarget.deviceId,
						fileTarget.toolEdit,
						fileTarget.fileNarratorId,
					)
				: dockPanelId(kind);
	const { id: newPanelId, existing } =
		kind === "file"
			? resolveFilePanel(
					api.panels,
					{ panelType: "file", ...fileTarget, hostNarratorId: target.narratorId },
					canonicalId,
					"focus",
				)
			: { id: canonicalId, existing: api.getPanel(canonicalId) };
	if (existing) {
		if (kind === "file" && (fileTarget.referenceOrigin || subject.largeFileConfirmed)) {
			existing.api.updateParameters({
				...existing.params,
				...(fileTarget.referenceOrigin ? { referenceOrigin: true } : {}),
				...(subject.largeFileConfirmed ? { largeFileConfirmed: true } : {}),
			});
		}
		if (event.group) existing.api.moveTo({ group: event.group, position: "center" });
		existing.api.setActive();
		return true;
	}

	api.addPanel({
		id: newPanelId,
		component: NARRATOR_DOCK_COMPONENT[kind],
		params:
			kind === "subagent"
				? { panelType: "subagent" as const, subagentNarratorId: resourceId ?? "" }
				: kind === "file"
					? {
							panelType: "file" as const,
							...fileTarget,
							...(subject.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
						}
					: { panelType: kind, narratorId: target.narratorId, chapterId: target.chapterId },
		// Dropped position: dockview reports which group and edge the pointer was
		// over; `position` is absent for a plain tab-strip drop.
		...(event.group ? { position: { referenceGroup: event.group } } : {}),
	});
	return true;
}
