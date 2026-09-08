/**
 * A full dockview surface embedded in an expanded chapter node.
 *
 * The canvas node used to render a bare `NarratorPanel`, with no dock context at
 * all, which is why most of the narrator toolbar's buttons were hidden there:
 * git / search / browser / discussion / plugins are gated on
 * `useNarratorDockContext()`, and terminal / tasks / spec fell back to drawers.
 *
 * Here the node hosts the SAME surface the focus page does — `NarratorDockProvider`
 * plus the shared panel registry — so every tool panel opens as a sibling tab that
 * can be stacked, split and reordered inside the node. Two things differ from the
 * focus page:
 *
 *  1. Panels use the `onlyWhenVisible` renderer instead of `always`, so their size
 *     comes from CSS rather than from JS-written pixel values that would double-count
 *     the canvas zoom (see the `defaultRenderer` prop below).
 *  2. The layout lives server-side per chapter, so it arrives asynchronously and
 *     the surface must not mount before it does (see `./graph-node-dock-layout`).
 */

import { Box, Button, Center, Stack, Text } from "@mantine/core";
import { useStore } from "@xyflow/react";
import type { DockviewApi, DockviewDidDropEvent, SerializedDockview } from "dockview-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChapterDockLayout } from "../../../hooks/useChapterDockLayout";
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
	subagentDockPanelId,
} from "../../narrator/dock/dock-panel-types";
import {
	NarratorDockProvider,
	useNarratorDockContext,
} from "../../narrator/dock/NarratorDockContext";
import { narratorDockComponents, narratorDockTabComponents } from "../../narrator/dock/panels";
import { NarratorPanelSkeleton } from "../../narrator/NarratorPanelSkeleton";
import { filePanelResourceParams } from "../../narrator/panels/panel-kind";
import { acceptForeignPanelDragOver, handleForeignPanelDrop } from "./cross-surface-drop";
import { isDetachablePanelKind } from "./detachable";
import { getChapterDock, isDetachedSurface, registerChapterDock } from "./dock-registry";
import { applyChapterDockLayout, serializeChapterDockLayout } from "./graph-node-dock-layout";
import { isInteractiveZoom } from "./inverse-scale";

export interface ChapterNodeDockProps {
	chapterId: string;
	narratorId: string;
	/** Fork-from-message handler owned by the node (it renders the modal). */
	onForkFromMessage?: (messageId: string) => void;
}

/**
 * Host element for the surface. Deliberately a PLAIN full-size box: it is sized in
 * world units and carries no transform of its own, so React Flow's `scale(zoom)`
 * applies to the dock exactly once and every panel keeps its proportions at any
 * zoom.
 *
 * This used to inverse-scale (lay out at `size * zoom`, then `scale(1 / zoom)`) to
 * hand dockview an "unscaled" box for its pointer math. That is where the
 * proportion bug came from: the two transforms cancel VISUALLY, but the surface's
 * own layout width then varies with zoom (720 CSS px at zoom 1, 360 at zoom 0.5).
 * Everything dockview draws in fixed pixels — tab strip height, font size,
 * padding, panel minimum sizes — therefore occupied a different fraction of the
 * node at every zoom level: zooming out made the chrome balloon, zooming in shrank
 * it. Constant proportions and a zoom-independent CSS-pixel box are mutually
 * exclusive, and proportions are what the user actually sees, so the counter-scale
 * is gone.
 *
 * The cost is the thing the counter-scale bought: dockview reads raw `clientX`
 * deltas for sash drags, so at zoom != 1 a split divider still travels `1 / zoom`
 * times the pointer distance. That is a rough edge while dragging, not a defect at
 * rest, and it is dockview's own missing zoom awareness rather than something this
 * host can correct.
 */
function NodeDockHost({
	surfaceId,
	children,
}: {
	/**
	 * Stamped as `data-chapter-node-dock` so the canvas can hit-test whether a drag
	 * is over a dock (in which case that dock handles the drop) or over blank canvas
	 * (in which case the panel is torn out into its own node).
	 */
	surfaceId: string;
	children: React.ReactNode;
}) {
	// No measurement, no state, no transform: dockview's own shell ResizeObserver
	// sizes the panels from this box. Sizing it in percentages also means a node
	// resize needs no React render here at all.
	return (
		<Box
			data-chapter-node-dock={surfaceId}
			style={{ position: "relative", width: "100%", height: "100%" }}
		>
			{children}
		</Box>
	);
}

/**
 * The dockview surface itself. Memoized and kept free of the zoom value so
 * panning / zooming the canvas restyles the host without re-rendering (let alone
 * re-creating) the surface, which would tear down live terminals and sessions.
 */
const ChapterNodeDockSurface = memo(function ChapterNodeDockSurface({
	chapterId,
	narratorId,
	initialLayout,
	save,
}: {
	/** Doubles as this surface's id — see the `surfaceId` prop below. */
	chapterId: string;
	narratorId: string;
	initialLayout: SerializedDockview | null;
	save: (serialized: string | null) => void;
}) {
	const dock = useNarratorDockContext();
	if (!dock) {
		throw new Error("ChapterNodeDockSurface must be rendered inside a NarratorDockProvider");
	}
	const { apiRef, refreshOpenToolTypes } = dock;

	// Read the fetched layout exactly ONCE, at onReady. A later refetch returning
	// something different must not re-apply: that would yank the layout the user is
	// currently arranging back to an older snapshot.
	const initialLayoutRef = useRef(initialLayout);
	// Guards persistence until the first apply has completed, so the layout-change
	// events emitted by `fromJSON` / `addPanel` themselves cannot write back.
	const hasAppliedRef = useRef(false);
	const saveRef = useRef(save);
	saveRef.current = save;
	const disposablesRef = useRef<Array<{ dispose(): void }>>([]);

	const persist = useCallback(() => {
		if (!hasAppliedRef.current) return;
		const api = apiRef.current;
		if (!api) return;
		saveRef.current(serializeChapterDockLayout(api));
	}, [apiRef]);

	const handleReady = useCallback(
		(api: DockviewApi) => {
			apiRef.current = api;
			applyChapterDockLayout(api, initialLayoutRef.current, narratorId);
			hasAppliedRef.current = true;
			refreshOpenToolTypes();
			disposablesRef.current = [
				api.onDidLayoutChange(() => {
					persist();
					refreshOpenToolTypes();
				}),
				api.onDidAddPanel(() => refreshOpenToolTypes()),
				api.onDidRemovePanel(() => refreshOpenToolTypes()),
				// Without this a tab dragged in from another surface gets NO drop overlay
				// at all — see `./cross-surface-drop`.
				api.onUnhandledDragOver((e) => acceptForeignPanelDragOver(e, api)),
			];
		},
		[apiRef, narratorId, persist, refreshOpenToolTypes],
	);

	// Drop the dockview listeners when the node collapses. The pending layout write
	// is flushed by `useChapterDockLayout`'s own unmount effect, so there is
	// nothing to persist here.
	useLayoutEffect(() => {
		return () => {
			for (const d of disposablesRef.current) d.dispose();
			disposablesRef.current = [];
		};
	}, []);

	// Advertise this dock so code outside the node can reach it: the canvas closes the
	// source panel here when tearing one out, and a detached panel forwards its
	// chat-side actions (jump to message / open subagent) back through it.
	useEffect(() => registerChapterDock(chapterId, dock), [chapterId, dock]);

	/**
	 * Accept a drop that is not one of this surface's own panels.
	 *
	 * Three cases arrive here (see `isLocalPanelDrag`):
	 *
	 *  - A panel from a DETACHED canvas node (`surfaceId` names a detached surface):
	 *    accepted. The canvas owns that surface, so its panel can be closed below
	 *    before this one is created — the panel moves rather than being copied.
	 *  - A drag with no `panelId` at all: a detached node being dragged whole, or an
	 *    older-style subject drag. Accepted the same way.
	 *  - A live panel belonging to ANOTHER CHAPTER's dock: refused. Moving it would
	 *    require closing a panel on a surface we do not own, and adding it here
	 *    without that would DUPLICATE the panel. The two-step route (tear out to
	 *    canvas, then drag in) is supported and explicit.
	 *
	 * The distinction is load-bearing: detached surfaces host real dockview panels
	 * now, so their drags DO carry a `panelId`. Refusing on that alone (as this used
	 * to) would silently break dragging a panel from a canvas node into a dock.
	 */
	const handleDropSubject = useCallback(
		(drag: PanelDragState, target: DockviewDropTarget, api: DockviewApi) => {
			// A live panel from another chapter's dock — see above.
			if (drag.panelId && !isDetachedSurface(drag.surfaceId)) return;
			const kind = drag.toolKind;
			if (!isDetachablePanelKind(kind)) return;

			const group = api.groups.find((g) => g.id === target.groupId);
			if (!group) return;

			// A detached panel has no live panel to exchange, so a centre drop (swap)
			// is treated as a merge.
			const position = target.intent === "swap" ? "center" : intentToPosition(target.intent);
			const direction = target.intent === "swap" ? "within" : intentToDirection(target.intent);

			// Multi-instance kinds are keyed by their resource; the rest are singletons
			// per surface (`dockPanelId` deliberately does not accept the former).
			if ((kind === "subagent" || kind === "file") && !drag.resourceId) return;
			const fileTarget = filePanelResourceParams(drag.resourceId ?? "");
			const panelId =
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

			// Release the panel on the source surface FIRST, when it is a live one. If
			// this were done after adding, a failure in between would leave the same
			// panel in two surfaces at once — and both would hold their own session.
			// A detached surface that has already gone (node removed mid-drag) simply
			// has nothing to close.
			if (drag.panelId) {
				getChapterDock(drag.surfaceId)?.apiRef.current?.getPanel(drag.panelId)?.api.close();
			}

			// Already open here (the user tore out one instance and dragged in another,
			// or re-opened it from the toolbar meanwhile): focus it rather than adding a
			// second, so the panel does not exist in two places.
			const existing = api.getPanel(panelId);
			if (existing) {
				if (kind === "file" && fileTarget.referenceOrigin) {
					existing.api.updateParameters({ ...existing.params, referenceOrigin: true });
				}
				existing.api.moveTo({ group, position });
				existing.api.setActive();
				return;
			}

			const params =
				kind === "subagent"
					? { panelType: "subagent" as const, subagentNarratorId: drag.resourceId ?? "" }
					: kind === "file"
						? { panelType: "file" as const, ...fileTarget }
						: { panelType: kind, narratorId, chapterId };
			api.addPanel({
				id: panelId,
				component: NARRATOR_DOCK_COMPONENT[kind],
				params,
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
			// The chapter id IS this surface's identity: several node docks coexist on
			// one canvas and all share the global panel ids (`ndock-terminal`), so a
			// drop must only be treated as an in-surface move by the dock it began on.
			// It also lets a consumer look this dock up in the registry to reach the
			// panel being dragged out.
			surfaceId={chapterId}
			// NOT "always" here, unlike the focus page.
			//
			// The `always` renderer hoists every panel into a surface-wide overlay and
			// positions it with JS: it reads `getBoundingClientRect()` of the panel's
			// content container and writes those numbers into `style.width/height`. On a
			// React Flow canvas that rect is ALREADY multiplied by the viewport zoom,
			// while the style it writes is in unscaled CSS pixels — so the panel's
			// contents get the zoom applied a second time and their proportions drift as
			// the user zooms (dockview-core has no zoom awareness anywhere).
			//
			// `onlyWhenVisible` puts panel content directly in its group's flex
			// container, so sizing is pure CSS and inherits the ancestor transform
			// exactly once. The cost is that switching tabs or dragging a panel between
			// groups remounts it; that is the correct trade here, because a node dock
			// that renders at the wrong proportions is broken at rest, whereas a remount
			// only costs a reconnect on an explicit user action.
			defaultRenderer="onlyWhenVisible"
		/>
	);
});

export function ChapterNodeDock({
	chapterId,
	narratorId,
	onForkFromMessage,
}: ChapterNodeDockProps) {
	const { t } = useTranslation("graph");
	// Only the cutoff is read from zoom, and it changes value at most once per zoom
	// gesture, so this does not re-render on every wheel tick the way a raw zoom
	// subscription would.
	const interactive = useStore((s) => isInteractiveZoom(s.transform[2]));
	const { layout, isReady, isError, retry, save } = useChapterDockLayout(chapterId);

	// Zoomed too far out to read or use. Render a placeholder instead of a live
	// surface: below this threshold Dockview's minimum panel sizes would squeeze the
	// layout out of shape, and mounting the real thing would open a chat WebSocket,
	// xterm instances and plugin frames for something nobody can interact with.
	//
	// This unmounts an already-open dock when the user zooms out past the threshold,
	// which does drop live panel state (a terminal reconnects on the way back in).
	// That is the accepted trade for not keeping N invisible docks alive on a large
	// canvas — the alternative is a canvas that gets slower the more nodes are open.
	if (!interactive) {
		return (
			<Center h="100%" p="xs">
				<Text size="xs" c="dimmed" ta="center">
					{t("nodeDock.zoomToInteract")}
				</Text>
			</Center>
		);
	}

	// A failed read must NEVER be treated as "no saved layout": mounting the
	// surface here would build the default and immediately persist it over
	// whatever the user had. So the surface stays unmounted and we offer a retry.
	if (isError) {
		return (
			<Center h="100%" p="sm">
				<Stack gap="xs" align="center">
					<Text size="xs" c="dimmed" ta="center">
						{t("nodeDock.layoutLoadFailed")}
					</Text>
					<Button size="xs" variant="light" onClick={retry}>
						{t("nodeDock.retry")}
					</Button>
				</Stack>
			</Center>
		);
	}

	// Same reasoning: until the layout is known, there is no surface at all.
	if (!isReady) return <NarratorPanelSkeleton />;

	return (
		<NarratorDockProvider
			key={narratorId}
			narratorId={narratorId}
			chapterId={chapterId}
			onForkFromMessage={onForkFromMessage ?? null}
			// The node header (ChapterNode / ReviewNode) already renders this narrator's
			// title and owns its edit / generate actions, so the chat panel must not draw
			// a second title row — inside a node its own tool buttons squeezed that copy
			// to zero width, which is what made the title unreadable.
			hostOwnsTitle
			pluginSurface="graph"
		>
			<NodeDockHost surfaceId={chapterId}>
				<ChapterNodeDockSurface
					chapterId={chapterId}
					narratorId={narratorId}
					initialLayout={layout}
					save={save}
				/>
			</NodeDockHost>
		</NarratorDockProvider>
	);
}
