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
import { useCallback, useMemo, useRef, useState } from "react";
import type { VListViewControls } from "./VListContentViewHost";
import { type VListViewTarget, viewStateSig, viewTargetSpecKey } from "./vlist-content-view-target";

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
	/**
	 * Replace the open target with a freshly derived one carrying the same id.
	 *
	 * The modal holds a SNAPSHOT (targets are rebuilt with the document, so keeping
	 * a live reference is not an option), which means a body whose text was only a
	 * server-side prefix would keep showing that prefix even after the shell fetched
	 * the full payload. The shell calls this when it observes a new target for the
	 * open id, so the modal follows the data.
	 *
	 * A no-op when nothing is open or the text is unchanged, so it is safe to call
	 * from an effect on every rebuild.
	 */
	refreshOpenTarget: (next: VListViewTarget) => void;
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

export interface UseVListContentViewOptions {
	/**
	 * Ask the shell to fetch a row's un-truncated payload.
	 *
	 * Opening a body in fullscreen IS a request for that body's bytes, so a target
	 * flagged `truncated` triggers this — the same channel the truncation notice
	 * uses, keyed by the target's spec key. Without it the modal could only ever
	 * show the server-side prefix, which is exactly what a reader opens fullscreen
	 * to get past.
	 */
	requestFullPayload?: (specKey: string) => void;
}

export function useVListContentView(
	options: UseVListContentViewOptions = {},
): UseVListContentViewResult {
	const { data: userPrefs } = useUserPreferences();
	const [wrap, setWrap] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [showSource, setShowSource] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [openTarget, setOpenTarget] = useState<VListViewTarget | null>(null);
	// Read through a ref so `openFullscreen` — and therefore `controls` — cannot gain
	// a new identity just because the caller passed an inline callback. Every mounted
	// row compares `controls` identity-wise (the ExactRow memo), so an extra churn
	// source here would re-render the whole window on each scroll step.
	const requestFullPayloadRef = useRef(options.requestFullPayload);
	requestFullPayloadRef.current = options.requestFullPayload;

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

	const openFullscreen = useCallback((target: VListViewTarget) => {
		setOpenTarget(target);
		// A prefix body is the one case where opening the modal must also FETCH. The
		// request is idempotent and grow-only (see markVListFullPayloadRequested), so
		// re-opening the same body costs nothing.
		if (target.truncated === true) {
			const specKey = viewTargetSpecKey(target.id);
			if (specKey) requestFullPayloadRef.current?.(specKey);
		}
	}, []);

	const controls = useMemo<VListViewControls>(
		() => ({
			isWrapped,
			isSourceShown,
			toggleWrap: (target) => toggle(setWrap, target.id, defaultWrap(target)),
			toggleSource: (target) => toggle(setShowSource, target.id, false),
			openFullscreen,
		}),
		[isWrapped, isSourceShown, defaultWrap, openFullscreen],
	);

	const refreshOpenTarget = useCallback((next: VListViewTarget) => {
		setOpenTarget((prev) => {
			if (!prev || prev.id !== next.id) return prev;
			// Text identity is the signal: everything else on a target is derived from
			// the same measured block, and bailing here keeps this callable from an
			// effect without looping.
			if (prev.text === next.text && prev.truncated === next.truncated) return prev;
			return next;
		});
	}, []);

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
		refreshOpenTarget,
	};
}
