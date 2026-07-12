/**
 * Shared panel adapter helpers used by every dockview surface (focus dock +
 * workspace). Extracted from the previously-duplicated copies in
 * `dock/panels.tsx` and `workspace/panels.tsx`.
 */

import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PanelDragSubjectKind, startPanelDrag } from "../../../lib/panel-drag";

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
			setCompact((entries[0]?.contentRect.width ?? 0) < COMPACT_WIDTH_THRESHOLD);
		});
		ro.observe(el);
		roRef.current = ro;
	}, []);
	useEffect(() => () => roRef.current?.disconnect(), []);
	return { ref, compact };
}

/**
 * Begin dragging an existing dockview panel via its header bar. The containing
 * DockviewSurface listens on the panel-drag singleton, hit-tests groups, and
 * performs swap / merge / split on drop. `subjectId` is the real narrator id
 * for narrator panels, or a synthetic marker (e.g. `__terminal__`) otherwise so
 * consumers can key off `panelId` for move/swap.
 */
export function usePanelHeaderDrag(
	// biome-ignore lint/suspicious/noExplicitAny: header drag is params-agnostic
	props: IDockviewPanelProps<any>,
	subjectId: string,
	subjectKind: PanelDragSubjectKind = "narrator",
): (e: React.PointerEvent) => void {
	return useCallback(
		(e: React.PointerEvent) => {
			startPanelDrag({
				panelId: props.api.id,
				id: subjectId,
				title: props.api.title || subjectId,
				sourceGroupId: props.api.group?.id,
				subjectKind,
				x: e.clientX,
				y: e.clientY,
			});
		},
		[props.api, subjectId, subjectKind],
	);
}
