import { api } from "@frontend/lib/api";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

/**
 * Batched writes of CLASSIC canvas node positions.
 *
 * `x`/`y` are absolute React Flow world coordinates and land in classic's own
 * columns (`chapters.graphX`/`graphY`). Ruler persists through a different endpoint
 * with a different coordinate system (offsets relative to a commit tick); the two
 * are not interchangeable, and sharing storage between them meant opening a project
 * in one canvas wiped the layout arranged in the other.
 *
 * Neither axis is clamped. Ruler clamps its cross axis at 0 because it measures
 * distance from a ruler track, but a React Flow canvas has no such floor — negative
 * coordinates are simply up and to the left of the origin, and clamping them dragged
 * those nodes onto the axes behind the user's back.
 */
interface PendingUpdate {
	x: number;
	y: number;
	panelExpanded?: boolean;
	panelWidth?: number;
	panelHeight?: number;
}

export function useUpdateGraphPositions(projectId: string) {
	const pendingRef = useRef<Map<string, PendingUpdate>>(new Map());
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const mutation = useMutation({
		mutationFn: (
			positions: Array<{
				chapterId: string;
				x: number;
				y: number;
				panelExpanded?: boolean;
				panelWidth?: number;
				panelHeight?: number;
			}>,
		) => api.updateGraphPositions(projectId, positions),
	});

	// Store mutate in a ref so flush/scheduleFlush/savePosition/savePanelState
	// never depend on the mutation object (which changes every render).
	const mutateRef = useRef(mutation.mutate);
	mutateRef.current = mutation.mutate;

	const flush = useCallback(() => {
		if (pendingRef.current.size === 0) return;
		const positions = Array.from(pendingRef.current.entries()).map(([chapterId, upd]) => ({
			chapterId,
			x: upd.x,
			y: upd.y,
			panelExpanded: upd.panelExpanded,
			panelWidth: upd.panelWidth,
			panelHeight: upd.panelHeight,
		}));
		pendingRef.current.clear();
		mutateRef.current(positions);
	}, []);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const scheduleFlush = useCallback(() => {
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(flush, 500);
	}, [flush]);

	const savePosition = useCallback(
		(chapterId: string, x: number, y: number) => {
			const existing = pendingRef.current.get(chapterId);
			pendingRef.current.set(chapterId, { ...existing, x, y });
			scheduleFlush();
		},
		[scheduleFlush],
	);

	const savePanelState = useCallback(
		(
			chapterId: string,
			x: number,
			y: number,
			panelExpanded: boolean,
			panelWidth?: number,
			panelHeight?: number,
		) => {
			const existing = pendingRef.current.get(chapterId);
			pendingRef.current.set(chapterId, {
				...existing,
				x,
				y,
				panelExpanded,
				panelWidth,
				panelHeight,
			});
			scheduleFlush();
		},
		[scheduleFlush],
	);

	return { savePosition, savePanelState };
}
