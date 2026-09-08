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
import {
	sameViewTarget,
	type VListViewOwner,
	type VListViewTarget,
	viewStateSig,
} from "./vlist-content-view-target";

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
	 * A no-op when nothing is open or the descriptor is unchanged, so it is safe to call
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
	 * Reaching a body's later half, or opening it in fullscreen, IS a request for
	 * that body's bytes, so a target flagged `truncated` triggers this — keyed by
	 * the target's spec key. Without it a body could only ever show the server-side
	 * prefix, which is exactly what a reader scrolls (or opens fullscreen) to get
	 * past.
	 */
	requestFullPayload?: (owner: VListViewOwner) => void;
}

export function useVListContentView(
	options: UseVListContentViewOptions = {},
): UseVListContentViewResult {
	const { data: userPrefs } = useUserPreferences();
	const [wrap, setWrap] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [showSource, setShowSource] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [openTarget, setOpenTarget] = useState<VListViewTarget | null>(null);
	const ownersRef = useRef(new Map<string, VListViewOwner>());
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

	/**
	 * Ask the shell for a body's real payload. A no-op for a body that is already
	 * complete, so every caller can hand it any target unconditionally.
	 *
	 * Two callers today: opening the body in fullscreen, and reading past the
	 * halfway mark of an inline one (VListContentViewHost). Both are user actions,
	 * and the underlying request is idempotent + grow-only, so neither has to know
	 * about the other.
	 */
	const requestFullPayload = useCallback((target: VListViewTarget) => {
		if (target.truncated !== true) return;
		requestFullPayloadRef.current?.(target.owner);
	}, []);

	const openFullscreen = useCallback(
		(target: VListViewTarget) => {
			setOpenTarget(target);
			// A prefix body is the one case where opening the modal must also FETCH:
			// the prefix is exactly what the reader opened fullscreen to get past.
			requestFullPayload(target);
		},
		[requestFullPayload],
	);

	const controls = useMemo<VListViewControls>(
		() => ({
			isWrapped,
			isSourceShown,
			toggleWrap: (target) => {
				ownersRef.current.set(target.id, target.owner);
				toggle(setWrap, target.id, defaultWrap(target));
			},
			toggleSource: (target) => {
				ownersRef.current.set(target.id, target.owner);
				toggle(setShowSource, target.id, false);
			},
			openFullscreen,
			requestFullPayload,
		}),
		[isWrapped, isSourceShown, defaultWrap, openFullscreen, requestFullPayload],
	);

	const refreshOpenTarget = useCallback((next: VListViewTarget) => {
		setOpenTarget((prev) => {
			if (!prev || prev.id !== next.id) return prev;
			if (sameViewTarget(prev, next)) return prev;
			if (ownersRef.current.has(next.id)) ownersRef.current.set(next.id, next.owner);
			return next;
		});
	}, []);

	const rowSig = useCallback(
		(specKey: string) => viewStateSig(wrap, showSource, specKey, ownersRef.current),
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
