/**
 * A dockview surface inside a detached panel node.
 *
 * Sibling of `ChapterNodeDock`, and deliberately close to it: a detached node is
 * just another canvas-hosted surface, so it inherits the same decisions about
 * renderer choice, layout persistence and drop handling. Read that file's comments
 * for the reasoning; only the differences are explained here.
 *
 * Differences from the chapter dock:
 *
 *  - Its surface id is the NODE id, not the chapter id. One chapter can own its own
 *    dock plus any number of detached nodes, and dockview panel ids are global
 *    (`ndock-terminal`), so each surface must be separately addressable or a drop
 *    would resolve a panel against the wrong api.
 *  - It has no protagonist. The chapter dock always restores a chat panel because a
 *    node with tools and no conversation is unusable; a detached node has no such
 *    anchor, so an empty layout means the node should disappear instead.
 *  - Its layout lives in the chapter's detached-nodes column (one layout per node),
 *    not in `dockLayoutJson`.
 */

import type { DockviewApi, DockviewDidDropEvent, SerializedDockview } from "dockview-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { PanelDragState } from "../../../lib/panel-drag";
import {
	type DockviewDropTarget,
	DockviewSurface,
	intentToDirection,
	intentToPosition,
} from "../../dockview";
import {
	dockPanelId,
	fileDockPanelId,
	NARRATOR_DOCK_COMPONENT,
	resolveFilePanel,
	subagentDockPanelId,
} from "../../narrator/dock/dock-panel-types";
import { useNarratorDockContext } from "../../narrator/dock/NarratorDockContext";
import { narratorDockComponents, narratorDockTabComponents } from "../../narrator/dock/panels";
import { stripIdentityFromLayout } from "../../narrator/panels/layout-envelope";
import { filePanelResourceParams } from "../../narrator/panels/panel-kind";
import {
	acceptForeignPanelDragOver,
	handleForeignPanelDrop,
	releasePanelDragSource,
} from "./cross-surface-drop";
import { isDetachablePanelKind } from "./detachable";
import type { DetachedPanelEntry } from "./detached-panels";
import { registerDetachedDock } from "./dock-registry";

export interface DetachedNodeDockProps {
	/** The canvas node's id; doubles as this surface's id. */
	nodeId: string;
	chapterId: string;
	narratorId: string;
	/** Restored dockview layout, when this node already has one. */
	initialLayout: SerializedDockview | null;
	/** Panels to create on first mount (fresh tear-out, or upgraded v1/v2 data). */
	pendingPanels: DetachedPanelEntry[] | undefined;
	/** Persist this surface's layout after every change. */
	save: (layout: SerializedDockview) => void;
	/**
	 * Called when the surface ends up with no panels at all — which is how a source
	 * node disappears after its last panel is dragged elsewhere. Driven by
	 * `onDidLayoutChange`, which fires on group removal, so closing the final panel
	 * does reach here.
	 */
	onEmpty: (nodeId: string) => void;
}

/** Build the dockview panel id for a pending entry. */
function panelIdOf(panel: DetachedPanelEntry): string | null {
	if (panel.kind === "subagent") {
		return panel.subagentNarratorId ? subagentDockPanelId(panel.subagentNarratorId) : null;
	}
	if (panel.kind === "file") {
		return panel.filePath
			? fileDockPanelId(panel.filePath, panel.deviceId, panel.toolEdit, panel.fileNarratorId)
			: null;
	}
	return dockPanelId(panel.kind);
}

/** Params for a pending entry, matching what each adapter's params type requires. */
function paramsOf(panel: DetachedPanelEntry, narratorId: string, chapterId: string) {
	if (panel.kind === "subagent") {
		return { panelType: "subagent" as const, subagentNarratorId: panel.subagentNarratorId ?? "" };
	}
	if (panel.kind === "file") {
		return {
			panelType: "file" as const,
			filePath: panel.filePath ?? "",
			deviceId: panel.deviceId ?? "local",
			referenceOrigin: panel.referenceOrigin === true,
			...(panel.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
			...(panel.toolEdit ? { toolEdit: panel.toolEdit } : {}),
			...(panel.fileNarratorId ? { fileNarratorId: panel.fileNarratorId } : {}),
		};
	}
	return { panelType: panel.kind, narratorId, chapterId };
}

export const DetachedNodeDock = memo(function DetachedNodeDock({
	nodeId,
	chapterId,
	narratorId,
	initialLayout,
	pendingPanels,
	save,
	onEmpty,
}: DetachedNodeDockProps) {
	const dock = useNarratorDockContext();
	if (!dock) {
		throw new Error("DetachedNodeDock must be rendered inside a NarratorDockProvider");
	}
	const { apiRef } = dock;

	// Read the restored layout exactly ONCE, at onReady. A later re-render carrying a
	// different layout must not re-apply: that would yank the arrangement the user is
	// working on back to an older snapshot.
	const initialLayoutRef = useRef(initialLayout);
	const pendingRef = useRef(pendingPanels);
	// Guards persistence until the first apply has completed, so the layout-change
	// events emitted by `fromJSON` / `addPanel` themselves cannot write back.
	const hasAppliedRef = useRef(false);
	const saveRef = useRef(save);
	saveRef.current = save;
	const onEmptyRef = useRef(onEmpty);
	onEmptyRef.current = onEmpty;
	const disposablesRef = useRef<Array<{ dispose(): void }>>([]);

	const persist = useCallback(() => {
		if (!hasAppliedRef.current) return;
		const api = apiRef.current;
		if (!api) return;
		// An empty surface has nothing to show and no protagonist to fall back on, so
		// the node itself should go rather than persisting a layout that restores to
		// nothing.
		if (api.panels.length === 0) {
			onEmptyRef.current(nodeId);
			return;
		}
		saveRef.current(stripIdentityFromLayout(api.toJSON()));
	}, [apiRef, nodeId]);

	const handleReady = useCallback(
		(api: DockviewApi) => {
			apiRef.current = api;

			// `fromJSON` first, falling back to creating the pending panels. Same shape
			// as `applyChapterDockLayout`: a restore that throws may leave a partial
			// layout behind, so clear before rebuilding.
			let restored = false;
			const layout = initialLayoutRef.current;
			if (layout) {
				try {
					api.fromJSON(layout);
					restored = api.panels.length > 0;
				} catch {
					restored = false;
				}
				if (!restored) {
					try {
						api.clear();
					} catch {
						// Nothing more to do; addPanel below still gives a usable surface.
					}
				}
			}
			if (!restored) {
				for (const panel of pendingRef.current ?? []) {
					const canonicalId = panelIdOf(panel);
					if (!canonicalId) continue;
					const params = paramsOf(panel, narratorId, chapterId);
					const { id: panelId, existing } =
						params.panelType === "file"
							? resolveFilePanel(
									api.panels,
									{ ...params, hostNarratorId: narratorId },
									canonicalId,
									"focus",
								)
							: { id: canonicalId, existing: api.getPanel(canonicalId) };
					if (existing) {
						if (panel.kind === "file" && (panel.referenceOrigin || panel.largeFileConfirmed)) {
							existing.api.updateParameters({
								...existing.params,
								...(panel.referenceOrigin ? { referenceOrigin: true } : {}),
								...(panel.largeFileConfirmed ? { largeFileConfirmed: true } : {}),
							});
						}
						continue;
					}
					api.addPanel({
						id: panelId,
						component: NARRATOR_DOCK_COMPONENT[panel.kind],
						params,
					});
				}
			}

			hasAppliedRef.current = true;
			// Write the resulting layout immediately, which is what makes the upgrade
			// from the older `pendingPanels` shapes one-shot: after this the node owns a
			// real layout and the pending list is gone for good.
			persist();

			disposablesRef.current = [
				api.onDidLayoutChange(() => persist()),
				// Without this a tab dragged in from another surface gets NO drop overlay
				// at all — see `./cross-surface-drop`.
				api.onUnhandledDragOver((e) => acceptForeignPanelDragOver(e, api)),
			];
		},
		[apiRef, chapterId, narratorId, persist],
	);

	useLayoutEffect(() => {
		return () => {
			for (const d of disposablesRef.current) d.dispose();
			disposablesRef.current = [];
		};
	}, []);

	// Advertise this surface so code outside the node can reach it: closing a panel
	// when one is dragged out, and identifying a native tab drag by panel id.
	useEffect(() => registerDetachedDock(nodeId, chapterId, dock), [nodeId, chapterId, dock]);

	/**
	 * Accept a drop that is not one of this surface's own panels — i.e. a panel
	 * arriving from another surface.
	 *
	 * Unlike the chapter dock this accepts drags that CARRY a `panelId`: those come
	 * from another canvas surface, and the source panel is closed below before this
	 * one is created, so the panel is moved rather than duplicated.
	 */
	const handleDropSubject = useCallback(
		(drag: PanelDragState, target: DockviewDropTarget, api: DockviewApi) => {
			const kind = drag.toolKind;
			if (!isDetachablePanelKind(kind)) return;

			const group = api.groups.find((g) => g.id === target.groupId);
			if (!group) return;

			const position = target.intent === "swap" ? "center" : intentToPosition(target.intent);
			const direction = target.intent === "swap" ? "within" : intentToDirection(target.intent);

			if ((kind === "subagent" || kind === "file") && !drag.resourceId) return;
			const subject = releasePanelDragSource(drag, api);
			if (!subject) return;
			const fileTarget = {
				...filePanelResourceParams(subject.resourceId ?? ""),
				...(subject.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
			};
			const canonicalId =
				kind === "subagent"
					? subagentDockPanelId(drag.resourceId as string)
					: kind === "file"
						? fileDockPanelId(
								fileTarget.filePath,
								fileTarget.deviceId,
								fileTarget.toolEdit,
								fileTarget.fileNarratorId,
							)
						: dockPanelId(kind);

			const { id: panelId, existing } =
				kind === "file"
					? resolveFilePanel(
							api.panels,
							{ panelType: "file", ...fileTarget, hostNarratorId: narratorId },
							canonicalId,
							"focus",
						)
					: { id: canonicalId, existing: api.getPanel(canonicalId) };
			if (existing) {
				if (kind === "file" && (fileTarget.referenceOrigin || fileTarget.largeFileConfirmed)) {
					existing.api.updateParameters({
						...existing.params,
						...(fileTarget.referenceOrigin ? { referenceOrigin: true } : {}),
						...(fileTarget.largeFileConfirmed ? { largeFileConfirmed: true } : {}),
					});
				}
				existing.api.moveTo({ group, position });
				existing.api.setActive();
				return;
			}

			api.addPanel({
				id: panelId,
				component: NARRATOR_DOCK_COMPONENT[kind],
				params:
					kind === "subagent"
						? { panelType: "subagent" as const, subagentNarratorId: subject.resourceId ?? "" }
						: kind === "file"
							? { panelType: "file" as const, ...fileTarget }
							: { panelType: kind, narratorId, chapterId },
				position: { referenceGroup: group, direction },
			});
		},
		[chapterId, narratorId],
	);

	/** Cross-surface TAB drop (native DnD); see `./cross-surface-drop`. */
	const handleDidDrop = useCallback(
		(event: DockviewDidDropEvent, api: DockviewApi) => {
			handleForeignPanelDrop(event, api, { narratorId, chapterId });
		},
		[chapterId, narratorId],
	);

	return (
		<DockviewSurface
			apiRef={apiRef}
			components={narratorDockComponents}
			tabComponents={narratorDockTabComponents}
			onReady={handleReady}
			onDropSubject={handleDropSubject}
			onDidDrop={handleDidDrop}
			// The NODE id, not the chapter id: see the file header.
			surfaceId={nodeId}
			// `onlyWhenVisible` for the same reason as the chapter dock: the `always`
			// renderer positions panels with JS from a rect that already includes the
			// canvas zoom, so contents would be scaled twice and drift while zooming.
			defaultRenderer="onlyWhenVisible"
		/>
	);
});
