import { useCallback, useState } from "react";

export type SubRulerRenderMode = "full" | "compact" | "indicator" | "hidden";

export interface FocusStackEntry {
	chapterId: string | null;
	depth: number;
}

export interface FocusStack {
	path: FocusStackEntry[];
	focusDepth: number;
	pushFocus: (chapterId: string) => void;
	popFocus: () => void;
	jumpTo: (depth: number) => void;
}

export function useFocusStack(): FocusStack {
	const [path, setPath] = useState<FocusStackEntry[]>([{ chapterId: null, depth: 0 }]);
	const [focusDepth, setFocusDepth] = useState(0);

	const pushFocus = useCallback((chapterId: string) => {
		setPath((prev) => {
			const newDepth = prev.length;
			return [...prev, { chapterId, depth: newDepth }];
		});
		setFocusDepth((prev) => prev + 1);
	}, []);

	const popFocus = useCallback(() => {
		setPath((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
		setFocusDepth((prev) => Math.max(0, prev - 1));
	}, []);

	const jumpTo = useCallback((depth: number) => {
		setPath((prev) => prev.slice(0, depth + 1));
		setFocusDepth(depth);
	}, []);

	return { path, focusDepth, pushFocus, popFocus, jumpTo };
}

/**
 * Determine render mode for a sub-ruler based on its depth relative to focus.
 * distance 0 = full, 1 = compact, 2 = indicator, 3+ = hidden
 */
export function getSubRulerRenderMode(layerDepth: number, focusDepth: number): SubRulerRenderMode {
	const distance = Math.abs(layerDepth - focusDepth);
	if (distance === 0) return "full";
	if (distance === 1) return "compact";
	if (distance === 2) return "indicator";
	return "hidden";
}
