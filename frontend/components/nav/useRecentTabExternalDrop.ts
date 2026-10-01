/**
 * Accept a narrator dragged into the sidebar from OUTSIDE it (the narrator list page).
 *
 * The sidebar's own reordering is @dnd-kit: its sortable ids come from the tabs already in
 * the list, so a narrator that is not a tab yet can never be an `active` item there. Rather
 * than reworking three DndContexts and their collision detection to admit foreign ids, this
 * rides the existing `panel-drag` singleton — the same channel the narrator page's
 * drag-to-split and the workspace/graph docks already listen on.
 *
 * The cost is honest: an external drag gets no row-push animation, only an insertion line.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	isNarratorSubject,
	onPanelDragEnd,
	onPanelDragMove,
	type PanelDragState,
} from "../../lib/panel-drag";
import {
	type RecentTabDropRow,
	type RecentTabDropTarget,
	resolveRecentTabDropTarget,
} from "./recent-tab-drop-target";

export interface RecentTabExternalDropState {
	narratorId: string;
	title: string;
	target: RecentTabDropTarget;
	/** The rows measured for this frame, so the indicator can be positioned. */
	rows: RecentTabDropRow[];
	/**
	 * Viewport-space top of the container at measure time.
	 *
	 * Rows are measured in viewport coordinates (they have to be, to be compared against
	 * the pointer), but the indicator is absolutely positioned INSIDE the container. Both
	 * are captured in the same frame so the subtraction is consistent even mid-scroll.
	 */
	containerTop: number;
}

export interface UseRecentTabExternalDropOptions {
	containerRef: React.RefObject<HTMLElement | null>;
	/** False disables the whole listener (e.g. the projects section takes no narrators). */
	enabled: boolean;
	/**
	 * True while the sidebar's OWN @dnd-kit drag is in flight.
	 *
	 * Load-bearing. `handleDragStartForGroup` bridges internal drags into this same
	 * singleton (so workspace docks can receive them), which means an internal reorder is
	 * visible here too. Without this gate one internal drop would be handled twice — once
	 * by @dnd-kit's `onDragEnd` and once here — issuing two conflicting mutations.
	 */
	suspended: boolean;
	/** Synchronous internal-drag gate; when supplied, takes precedence over suspended. */
	suspendedRef?: React.RefObject<boolean>;
	/** Measure the currently rendered rows. Called on every drag frame over the sidebar. */
	measureRows: () => RecentTabDropRow[];
	onDrop: (drop: { narratorId: string; title: string; target: RecentTabDropTarget }) => void;
}

export function useRecentTabExternalDrop({
	containerRef,
	enabled,
	suspended,
	suspendedRef,
	measureRows,
	onDrop,
}: UseRecentTabExternalDropOptions): RecentTabExternalDropState | null {
	const [state, setState] = useState<RecentTabExternalDropState | null>(null);

	// Refs so the subscription is registered once and never re-registered mid-drag:
	// resubscribing would drop the pending target and the release would do nothing.
	const stateRef = useRef<RecentTabExternalDropState | null>(null);
	const suspendedBooleanRef = useRef(suspended);
	suspendedBooleanRef.current = suspended;
	const externalSuspendedRef = useRef(suspendedRef);
	externalSuspendedRef.current = suspendedRef;
	const readSuspended = useCallback(
		() => externalSuspendedRef.current?.current ?? suspendedBooleanRef.current,
		[],
	);
	const measureRef = useRef(measureRows);
	measureRef.current = measureRows;
	const onDropRef = useRef(onDrop);
	onDropRef.current = onDrop;

	const clear = useCallback(() => {
		if (!stateRef.current) return;
		stateRef.current = null;
		setState(null);
	}, []);

	useEffect(() => {
		clear();
		if (!enabled) return;

		const resolveDrag = (drag: PanelDragState): RecentTabExternalDropState | null => {
			// A tool/resource panel can never become a recent tab.
			if (readSuspended() || !isNarratorSubject(drag)) return null;
			const el = containerRef.current;
			if (!el) return null;
			const rect = el.getBoundingClientRect();
			const inside =
				drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom;
			if (!inside) return null;
			const rows = measureRef.current();
			const target = resolveRecentTabDropTarget(rows, drag.y);
			if (!target) return null;
			return {
				narratorId: drag.id,
				title: drag.title,
				target,
				rows,
				containerTop: rect.top,
			};
		};

		const unsubMove = onPanelDragMove((drag: PanelDragState) => {
			const next = resolveDrag(drag);
			if (!next) {
				clear();
				return;
			}
			stateRef.current = next;
			setState(next);
		});

		const unsubEnd = onPanelDragEnd((final: PanelDragState | null) => {
			clear();
			// Release coordinates, rows and identity are authoritative, not the last move.
			const resolved = final ? resolveDrag(final) : null;
			if (!resolved) return;
			onDropRef.current({
				narratorId: resolved.narratorId,
				title: resolved.title,
				target: resolved.target,
			});
		});

		return () => {
			unsubMove();
			unsubEnd();
			clear();
		};
	}, [enabled, containerRef, clear, readSuspended]);

	// A drag that starts inside the sidebar arms `suspended` only after the first frame,
	// so drop any indicator that slipped through before the gate closed.
	useEffect(() => {
		if (readSuspended()) clear();
	});

	return state;
}
