/**
 * Shared panel adapter helpers used by every dockview surface (focus dock +
 * workspace). Extracted from the previously-duplicated copies in
 * `dock/panels.tsx` and `workspace/panels.tsx`.
 */

import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type PanelDragSubjectKind, startPanelDrag } from "../../../lib/panel-drag";
import { useDockviewSurfaceId } from "../../dockview";

/** Width (px) below which a chat panel should use its compact toolbar layout. */
export const COMPACT_WIDTH_THRESHOLD = 640;

/**
 * Observe a panel's width and report whether it is below the compact threshold.
 * Returns a ref callback to attach to the panel's root element.
 */
export function usePanelCompact(): {
	ref: (el: HTMLDivElement | null) => void;
	compact: boolean;
} {
	const [compact, setCompact] = useState(true);
	const roRef = useRef<ResizeObserver | null>(null);
	const ref = useCallback((el: HTMLDivElement | null) => {
		roRef.current?.disconnect();
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			// A retained desktop dock is off-layout on mobile. Keep its last visible
			// chrome until it is shown again, rather than publishing a false breakpoint.
			if (width <= 0) return;
			setCompact(width < COMPACT_WIDTH_THRESHOLD);
		});
		ro.observe(el);
		roRef.current = ro;
	}, []);
	useEffect(() => () => roRef.current?.disconnect(), []);
	return { ref, compact };
}

/**
 * Dockview's always-rendered panels mount inside an unpositioned overlay. Its
 * actual size is written on the next animation frame, even though the content
 * can already read a temporary full-surface width. Mount expensive content only
 * after that first positioning; never gate it again during moves or tab changes.
 */
export function usePanelGeometryReady(onAttach: (el: HTMLDivElement | null) => void): {
	ref: (el: HTMLDivElement | null) => void;
	geometryReady: boolean;
} {
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const [geometryReady, setGeometryReady] = useState(false);
	const ref = useCallback(
		(el: HTMLDivElement | null) => {
			onAttach(el);
			setNode(el);
		},
		[onAttach],
	);
	useLayoutEffect(() => {
		if (!node || geometryReady) return;
		const overlay = node.closest<HTMLElement>(".dv-render-overlay");
		if (!overlay) {
			setGeometryReady(true);
			return;
		}
		const isPositioned = () =>
			overlay.style.visibility !== "hidden" &&
			Number.parseFloat(overlay.style.width) > 0 &&
			Number.parseFloat(overlay.style.height) > 0;
		if (isPositioned()) {
			setGeometryReady(true);
			return;
		}
		const observer = new MutationObserver(() => {
			if (!isPositioned()) return;
			observer.disconnect();
			setGeometryReady(true);
		});
		observer.observe(overlay, { attributes: true, attributeFilter: ["style"] });
		return () => observer.disconnect();
	}, [node, geometryReady]);
	return { ref, geometryReady };
}

/**
 * Begin dragging an existing dockview panel via its header bar. The containing
 * DockviewSurface listens on the panel-drag singleton, hit-tests groups, and
 * performs swap / merge / split on drop. `subjectId` is the real narrator id
 * for narrator panels, or a synthetic marker (e.g. `__terminal__`) otherwise so
 * consumers can key off `panelId` for move/swap.
 *
 * Every panel this runs in is a real dockview panel, including inside a detached
 * canvas node (which hosts its own surface). So there is one path: always a
 * `panelId`-bearing drag, with `surfaceId` naming the surface it began on. A
 * detached node is dragged by its own grip bar instead, never through a panel
 * header — otherwise "rearrange this panel" and "move the whole node" would be the
 * same gesture.
 */
export function usePanelHeaderDrag(
	// biome-ignore lint/suspicious/noExplicitAny: header drag is params-agnostic
	props: IDockviewPanelProps<any>,
	subjectId: string,
	subjectKind: PanelDragSubjectKind = "narrator",
	/**
	 * The panel's kind + resource identity, forwarded so a consumer can rebuild
	 * this panel elsewhere (e.g. tear it out onto the story-network canvas) without
	 * parsing `panelId`'s `ndock-<kind>` shape.
	 */
	detach?: { toolKind: string; resourceId?: string },
): (e: React.PointerEvent) => void {
	// Stamped onto the drag so a surface receiving the drop can tell "my own panel
	// being rearranged" from "a panel belonging to another surface" — panel ids are
	// global, so without it a foreign id would resolve against the wrong api.
	const surfaceId = useDockviewSurfaceId();
	const toolKind = detach?.toolKind;
	const resourceId = detach?.resourceId;
	return useCallback(
		(e: React.PointerEvent) => {
			startPanelDrag({
				panelId: props.api.id,
				id: subjectId,
				title: props.api.title || subjectId,
				sourceGroupId: props.api.group?.id,
				subjectKind,
				...(surfaceId ? { surfaceId } : {}),
				...(toolKind ? { toolKind } : {}),
				...(resourceId ? { resourceId } : {}),
				x: e.clientX,
				y: e.clientY,
			});
		},
		[props.api, subjectId, subjectKind, surfaceId, toolKind, resourceId],
	);
}
