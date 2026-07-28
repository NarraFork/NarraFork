/**
 * useVListContentView.ts — the shell's state for the vlist fullscreen viewer.
 *
 * Three pieces of state, all deliberately OUTSIDE `VListInteractionState`:
 *
 *   wrap        : per-body soft-wrap override (default from user preferences)
 *   showSource  : per-markdown-body raw-source override (default: rendered)
 *   openTarget  : which body the single shell-level modal is showing
 *
 * `VListInteractionState` is what `computeLayout` reads (isExpanded /
 * showOriginal / expandedRows / …), so anything stored there becomes a measure
 * input. These three are pure render state: a vlist body box has a
 * measure-fixed height and scrolls internally, so wrap and source change what
 * the reader sees inside the box, never the box itself. Keeping them here makes
 * that structural rather than a comment — and `vlist-content-view.height-neutral`
 * guards the boundary.
 *
 * The only place they influence React is the per-row `interactionSig`, so a
 * toggle re-renders exactly the row that owns the body.
 */

import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { useCallback, useMemo, useState } from "react";
import type { VListViewControls } from "./VListContentViewHost";
import { type VListViewTarget, viewStateSig } from "./vlist-content-view-target";

export interface UseVListContentViewResult {
	/** Passed to every render body through `extra.viewControls`. */
	controls: VListViewControls;
	/** The body the fullscreen modal is showing, or null. */
	openTarget: VListViewTarget | null;
	/** Close the modal. */
	close: () => void;
	/** Wrap state of the currently open target (for the modal toolbar). */
	openWrapped: boolean;
	/** Source state of the currently open target (for the modal toolbar). */
	openSourceShown: boolean;
	/** Render-state signature for one row (appended to its interaction sig). */
	rowSig: (specKey: string) => string;
}

/** Toggle one key in a boolean override map, defaulting to `fallback`. */
function toggle(
	setter: (next: (prev: ReadonlyMap<string, boolean>) => Map<string, boolean>) => void,
	id: string,
	fallback: boolean,
): void {
	setter((prev) => {
		const next = new Map(prev);
		next.set(id, !(prev.get(id) ?? fallback));
		return next;
	});
}

export function useVListContentView(): UseVListContentViewResult {
	const { data: userPrefs } = useUserPreferences();
	const [wrap, setWrap] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [showSource, setShowSource] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [openTarget, setOpenTarget] = useState<VListViewTarget | null>(null);

	// Same three preferences the chunked path's ContentViewer environment reads
	// (NarratorPanel's contentViewerEnvironment), so a reader's wrap defaults are
	// identical on both paths.
	const defaultWrap = useCallback(
		(target: VListViewTarget): boolean => {
			if (target.kind === "markdown") return userPrefs?.wordWrapMarkdown ?? true;
			if (target.kind === "diff") return userPrefs?.wordWrapDiff ?? true;
			return userPrefs?.wordWrapCode ?? true;
		},
		[userPrefs?.wordWrapCode, userPrefs?.wordWrapDiff, userPrefs?.wordWrapMarkdown],
	);

	const isWrapped = useCallback(
		(target: VListViewTarget) => wrap.get(target.id) ?? defaultWrap(target),
		[wrap, defaultWrap],
	);
	const isSourceShown = useCallback(
		(target: VListViewTarget) => showSource.get(target.id) === true,
		[showSource],
	);

	const controls = useMemo<VListViewControls>(
		() => ({
			isWrapped,
			isSourceShown,
			toggleWrap: (target) => toggle(setWrap, target.id, defaultWrap(target)),
			toggleSource: (target) => toggle(setShowSource, target.id, false),
			openFullscreen: (target) => setOpenTarget(target),
		}),
		[isWrapped, isSourceShown, defaultWrap],
	);

	const rowSig = useCallback(
		(specKey: string) => viewStateSig(wrap, showSource, specKey),
		[wrap, showSource],
	);

	return {
		controls,
		openTarget,
		close: useCallback(() => setOpenTarget(null), []),
		openWrapped: openTarget ? isWrapped(openTarget) : true,
		openSourceShown: openTarget ? isSourceShown(openTarget) : false,
		rowSig,
	};
}
