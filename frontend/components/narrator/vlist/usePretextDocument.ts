import type { TreeMessage } from "@frontend/lib/api/types";
import type {
	PretextLayoutAnchor,
	PretextLayoutIndex,
	PretextLayoutManifest,
} from "@shared/pretext-layout";
import type { ProgressSnapshot } from "@shared/progress-phase";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { NarratorMsg } from "../narrator-panel-types";
import type { RenderLod } from "./prepared-block";
import type { PretextDocumentLoadOptions } from "./pretext-document-loader";
import {
	captureCoordinatorAnchor,
	type PretextLayoutBuildOptions,
	PretextLayoutCoordinator,
	type PretextLayoutCoordinatorSnapshot,
} from "./pretext-layout-coordinator";
import type { VListItem } from "./vlist-pipeline";

export interface PretextDocumentView {
	scrollTop: number;
	viewportHeight: number;
	pinnedToBottom: boolean;
	/**
	 * Document offset (px from the canvas top) of the point the user is pointing at
	 * — the mouse for alt+wheel, the pinch center for two fingers. Set only while a
	 * gesture is driving the rebuild; every other rebuild anchors on the viewport
	 * top as before.
	 */
	focusOffset?: number;
}

export interface UsePretextDocumentOptions {
	enabled?: boolean;
	/**
	 * A subagent page treats its own (parent-pointing) messages as top-level, which
	 * decides whether an arriving child message may be appended locally.
	 */
	isSubagent?: boolean;
	lod: RenderLod;
	widthBucket: string | number;
	contentWidth: number;
	viewportHeight: number;
	gap?: number;
	/** Wider gap between top-level render units (messages / tool-runs / dividers). */
	segmentGap?: number;
	topPadding?: number;
	bottomPadding?: number;
	pruneDividerLabel?: string;
	isExpanded?: (key: string) => boolean | undefined;
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
	/** Resolve whether a translated reasoning body shows its ORIGINAL text. */
	showOriginal?: (key: string) => boolean;
	/** Resolve whether a subagent card's prompt body is open. */
	isPromptOpen?: (key: string) => boolean;
	recentMessageIds?: ReadonlySet<string>;
	resolveRecentMessageIds?: (messages: readonly NarratorMsg[]) => ReadonlySet<string>;
	labels?: Record<string, string>;
	/** Active-language revision folded into the measurement cache key (see
	 * buildPretextDocumentLayout) so a language switch re-measures localized text
	 * instead of reusing the previous language's cached geometry. */
	labelsRevision?: string;
	resolveToolCategory?: (toolName: string, input?: unknown) => string;
	resolveToolColor?: (toolName: string, input?: unknown) => string;
	/** Authoritative header summary (tool-display.getSummary), so truncated inputs
	 * still show their target path / command in the collapsed header. */
	resolveToolSummary?: (tc: unknown) => string;
	/** Resolve a tool item's pending-permission presence (live WS list). Its
	 * reference changes when the pending set changes, so folding it into
	 * buildOptions triggers a document rebuild (cards expand / collapse). */
	resolveHasPendingPermission?: (toolUseId: string | undefined) => boolean;
	resolvePendingPlan?: (toolUseId: string | undefined) => string | undefined;
	/** Full (un-truncated) tool payloads once the shell has fetched them. */
	resolveFullToolInput?: (toolUseId: string | undefined) => unknown;
	resolveFullToolOutput?: (toolUseId: string | undefined) => unknown;
	/**
	 * A live pending permission's `suggestions`, which win over the persisted ones
	 * when resolving a reflection gate. Its reference changes with the pending set,
	 * so folding it into buildOptions rebuilds the document as a gate progresses.
	 */
	resolvePendingPermissionSuggestions?: (toolUseId: string | undefined) => unknown[] | undefined;
	scrollTop: number;
	pinnedToBottom: boolean;
	/** Synchronous live view used when a layout rebuild captures its scroll anchor. */
	getCurrentView?: () => PretextDocumentView;
	loadOptions?: PretextDocumentLoadOptions;
	onScrollTopCorrection?: (scrollTop: number, anchorKind: PretextLayoutAnchor["kind"]) => void;
}

export interface UsePretextDocumentResult {
	status: PretextLayoutCoordinatorSnapshot["status"];
	/**
	 * PERSISTED messages of the loaded window (never the live streaming row).
	 *
	 * Consumers that reason about document structure — tail meta, selection index,
	 * hand-off, catch-up cursors — must see only persisted content.
	 */
	messages: readonly TreeMessage[];
	/**
	 * The live streaming row currently laid out as the document's last message, as
	 * the coordinator sees it. Read back (rather than tracked in the shell) so the
	 * hand-off decision compares what is ACTUALLY in the committed layout.
	 */
	streamingMessage: TreeMessage | null;
	messageVersion?: number;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
	manifest?: PretextLayoutManifest;
	index?: PretextLayoutIndex;
	items: readonly VListItem[];
	scrollTopCorrection?: number;
	scrollTopCorrectionKind?: PretextLayoutAnchor["kind"];
	/** More (older) messages exist above the loaded window. */
	hasPrev: boolean;
	/** An older-page fetch is in flight. */
	loadingOlder: boolean;
	error?: Error;
	reload: () => void;
	/** Extend the loaded window upward by one older page (reverse infinite scroll). */
	loadOlder: () => void;
	/** Apply a live compact-progress tick to the loaded document (no refetch). */
	applyCompactProgress: (messageId: string, progress: ProgressSnapshot, isSegment: boolean) => void;
	/**
	 * Apply a live tool / reflection / subagent lifecycle patch to the loaded
	 * document (no refetch, anchor-preserving). Returns true when it changed
	 * something, so callers can tell a real update from an event for a tool
	 * outside the loaded window.
	 */
	applyLivePatch: (
		patch: (messages: readonly TreeMessage[]) => {
			readonly messages: readonly TreeMessage[];
			changed: boolean;
		},
	) => boolean;
	/**
	 * Publish (or clear with null) the LIVE streaming row as the document's last
	 * message. Anchor-preserving and version-neutral, so committed rows keep their
	 * cached measurements and never jump.
	 */
	setStreamingMessage: (message: TreeMessage | null) => void;
	/**
	 * Append a newly broadcast message to the loaded window in place. Returns false
	 * when the message cannot be appended safely (mid-window insert, structural
	 * marker, duplicate), so the caller falls back to a structural reload.
	 */
	appendMessage: (message: TreeMessage) => boolean;
}

const EMPTY_MESSAGES: readonly TreeMessage[] = [];
const EMPTY_ITEMS: readonly VListItem[] = [];

export function shouldForcePretextDocumentLoad(
	reloadToken: number,
	handledReloadToken: number,
): boolean {
	return reloadToken > handledReloadToken;
}

export function resolvePretextDocumentView(
	fallback: PretextDocumentView,
	getCurrentView?: () => PretextDocumentView,
): PretextDocumentView {
	return getCurrentView?.() ?? fallback;
}

/**
 * Strip the gesture focus point unless the rebuild is an LOD switch.
 *
 * The focus point exists so a zoom step keeps the content under the cursor put.
 * Any OTHER rebuild (a width change, a live lifecycle patch, an older page) must
 * keep anchoring on the viewport top: those fire without the user pointing at
 * anything, and honoring a stale pointer position there would shift the document
 * for reasons the reader cannot connect to their own input.
 */
export function resolveRebuildView(
	view: PretextDocumentView,
	lodChanged: boolean,
): PretextDocumentView {
	if (lodChanged) return view;
	return view.focusOffset == null ? view : { ...view, focusOffset: undefined };
}

export function usePretextDocument(
	narratorId: string,
	options: UsePretextDocumentOptions,
): UsePretextDocumentResult {
	const enabled = options.enabled !== false;
	const coordinator = useMemo(() => (enabled ? new PretextLayoutCoordinator() : null), [enabled]);
	const [reloadToken, setReloadToken] = useState(0);
	const handledReloadTokenRef = useRef(0);
	const previousNarratorRef = useRef<string | null>(null);
	const viewRef = useRef({
		scrollTop: options.scrollTop,
		viewportHeight: options.viewportHeight,
		pinnedToBottom: options.pinnedToBottom,
	});
	viewRef.current = {
		scrollTop: options.scrollTop,
		viewportHeight: options.viewportHeight,
		pinnedToBottom: options.pinnedToBottom,
	};
	// Previous LOD, so the rebuild below can tell an LOD switch from any other
	// rebuild trigger (width change, live patch, reload). Only an LOD switch honors
	// the gesture focus point; every other rebuild anchors on the viewport top.
	const lastLodRef = useRef(options.lod);
	const buildOptions = useMemo<PretextLayoutBuildOptions>(
		() => ({
			lod: options.lod,
			widthBucket: options.widthBucket,
			contentWidth: options.contentWidth,
			viewportHeight: options.viewportHeight,
			gap: options.gap ?? 4,
			segmentGap: options.segmentGap,
			topPadding: options.topPadding ?? 16,
			bottomPadding: options.bottomPadding ?? 16,
			pruneDividerLabel: options.pruneDividerLabel,
			isExpanded: options.isExpanded,
			isLodUserOverride: options.isLodUserOverride,
			showEarlier: options.showEarlier,
			expandedRows: options.expandedRows,
			showOriginal: options.showOriginal,
			isPromptOpen: options.isPromptOpen,
			recentMessageIds: options.recentMessageIds,
			resolveRecentMessageIds: options.resolveRecentMessageIds,
			labels: options.labels,
			labelsRevision: options.labelsRevision,
			resolveToolCategory: options.resolveToolCategory,
			resolveToolColor: options.resolveToolColor,
			resolveToolSummary: options.resolveToolSummary,
			resolveHasPendingPermission: options.resolveHasPendingPermission,
			resolvePendingPlan: options.resolvePendingPlan,
			resolveFullToolInput: options.resolveFullToolInput,
			resolveFullToolOutput: options.resolveFullToolOutput,
			resolvePendingPermissionSuggestions: options.resolvePendingPermissionSuggestions,
		}),
		[
			options.bottomPadding,
			options.contentWidth,
			options.expandedRows,
			options.gap,
			options.segmentGap,
			options.isExpanded,
			options.isLodUserOverride,
			options.labels,
			options.labelsRevision,
			options.pruneDividerLabel,
			options.recentMessageIds,
			options.resolveRecentMessageIds,
			options.lod,
			options.resolveToolCategory,
			options.resolveToolColor,
			options.resolveToolSummary,
			// Rebuild when the pending-permission set changes (its reference changes
			// with the set), so cards expand/collapse as permissions come and go.
			options.resolveHasPendingPermission,
			// Same contract for the pending plan bodies: a file-based plan arrives in
			// the permission payload AFTER the tool card exists, so the resolver's
			// identity must change with it or the adapter never re-runs and the card
			// keeps its empty-plan detail (the measure revision would never see the
			// new text either).
			options.resolvePendingPlan,
			// Same contract again for the fetched full tool payloads: a truncated body
			// is replaced only after the async detail fetch resolves, so the resolver
			// identity must change with the fetched map or the card keeps rendering its
			// preview.
			options.resolveFullToolInput,
			options.resolveFullToolOutput,
			// A reflection gate progressing (running → confirmed) arrives as a new
			// pending set, so the resolver identity must change with it for the notice
			// to re-measure with its new title/summary.
			options.resolvePendingPermissionSuggestions,
			options.showEarlier,
			// A language flip re-measures the affected reasoning body, so the resolver
			// identity must change with the set or the document never rebuilds.
			options.showOriginal,
			// Opening a subagent prompt adds a measured body, so the same contract
			// applies: the resolver identity moves with the set or the card never
			// unfolds.
			options.isPromptOpen,
			options.topPadding,
			options.viewportHeight,
			options.widthBucket,
		],
	);
	const snapshot = useSyncExternalStore(
		coordinator?.subscribe ?? (() => () => {}),
		coordinator?.getSnapshot ?? (() => ({ status: "idle" as const })),
		coordinator?.getSnapshot ?? (() => ({ status: "idle" as const })),
	);
	useEffect(() => {
		if (!coordinator) return;
		if (previousNarratorRef.current !== narratorId) {
			previousNarratorRef.current = narratorId;
			coordinator.reset();
		}
		const current = coordinator.getSnapshot();
		const lodChanged = lastLodRef.current !== options.lod;
		lastLodRef.current = options.lod;
		const currentView = resolveRebuildView(
			resolvePretextDocumentView(viewRef.current, options.getCurrentView),
			lodChanged,
		);
		const anchor = current.index ? captureAnchor(current.index, currentView) : undefined;
		const forceReload = shouldForcePretextDocumentLoad(reloadToken, handledReloadTokenRef.current);
		if (forceReload) handledReloadTokenRef.current = reloadToken;
		if (forceReload || current.status === "loading") {
			// load() coalesces: if a tail fetch for this narrator is already in
			// flight, it re-targets that same fetch to the latest build options and
			// commits once, instead of starting a second identical request. A
			// forceReload always restarts. The effect cleanup no longer cancels the
			// coordinator (that discarded the in-flight fetch on every width change,
			// causing a duplicate initial request); narrator switch / reload handle
			// invalidation explicitly.
			void coordinator.load(
				narratorId,
				buildOptions,
				options.loadOptions,
				anchor,
				options.viewportHeight,
				{ forceReload },
			);
			return;
		}
		if (current.input) coordinator.rebuild(buildOptions, anchor, options.viewportHeight);
		else
			void coordinator.load(
				narratorId,
				buildOptions,
				options.loadOptions,
				anchor,
				options.viewportHeight,
			);
	}, [
		buildOptions,
		coordinator,
		narratorId,
		// Read directly (not just through buildOptions) to classify the rebuild as an
		// LOD switch. Listing it adds no extra run: buildOptions already changes with
		// it.
		options.lod,
		options.getCurrentView,
		options.loadOptions,
		options.viewportHeight,
		reloadToken,
	]);
	// Apply the scroll correction in a layout effect (before the browser paints),
	// not a passive effect. A passive effect runs AFTER paint, so the taller canvas
	// would render one frame with the stale scrollTop — the content jumps to the
	// top and then snaps back, which reads as a flicker. useLayoutEffect writes the
	// corrected scrollTop synchronously after the DOM grows and before paint, so the
	// prepend and the correction land in the same frame (no visible jump).
	useLayoutEffect(() => {
		if (snapshot.scrollTop == null || !snapshot.scrollTopAnchorKind) return;
		options.onScrollTopCorrection?.(snapshot.scrollTop, snapshot.scrollTopAnchorKind);
	}, [options.onScrollTopCorrection, snapshot.scrollTop, snapshot.scrollTopAnchorKind]);
	const reload = useCallback(() => setReloadToken((value) => value + 1), []);
	const loadOlder = useCallback(() => {
		if (!coordinator) return;
		const current = coordinator.getSnapshot();
		if (current.status !== "ready" || !current.hasPrev || current.loadingOlder) return;
		if (!current.index) return;
		// Preserve the visible content by height arithmetic: the coordinator shifts
		// scrollTop by the exact height prepended above it. No item-key anchor is
		// used, so a tool-run regrouping across the new page boundary cannot desync
		// the position. Pinned-to-bottom (first-screen fill) stays pinned instead.
		// The view is read LIVE at commit time (after the fetch) so scrolling during
		// a slow request cannot desync the base scrollTop from the correction.
		void coordinator.loadOlder(buildOptions, () => {
			const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
			return {
				scrollTop: view.scrollTop,
				pinnedToBottom: view.pinnedToBottom,
				viewportHeight: view.viewportHeight,
			};
		});
	}, [buildOptions, coordinator, options.getCurrentView]);
	const applyCompactProgress = useCallback(
		(messageId: string, progress: ProgressSnapshot, isSegment: boolean) => {
			coordinator?.applyCompactProgress(messageId, progress, isSegment);
		},
		[coordinator],
	);
	// The view is read LIVE at patch time (same contract as loadOlder) so a scroll
	// in flight cannot desync the captured anchor from the applied correction.
	const applyLivePatch = useCallback<UsePretextDocumentResult["applyLivePatch"]>(
		(patch) =>
			coordinator?.applyLivePatch(patch, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? false,
		[coordinator, options.getCurrentView],
	);
	const appendMessage = useCallback(
		(message: TreeMessage) =>
			coordinator?.appendMessage(message, options.isSubagent === true, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? false,
		[coordinator, options.getCurrentView, options.isSubagent],
	);
	// Same live-view contract as loadOlder / applyLivePatch: the anchor is captured
	// from the CURRENT scroll position at publish time, so a scroll in flight cannot
	// desync it from the correction that follows.
	const setStreamingMessage = useCallback(
		(message: TreeMessage | null) => {
			coordinator?.setStreamingMessage(message, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			});
		},
		[coordinator, options.getCurrentView],
	);
	return {
		status: snapshot.status,
		messages: snapshot.input?.messages ?? EMPTY_MESSAGES,
		streamingMessage: snapshot.streamingMessage ?? null,
		messageVersion: snapshot.input?.messageVersion,
		pruneBoundaryMessageId: snapshot.input?.pruneBoundaryMessageId ?? null,
		prunedPercent: snapshot.input?.prunedPercent ?? null,
		manifest: snapshot.manifest,
		index: snapshot.index,
		items: snapshot.items ?? EMPTY_ITEMS,
		scrollTopCorrection: snapshot.scrollTop,
		scrollTopCorrectionKind: snapshot.scrollTopAnchorKind,
		hasPrev: snapshot.hasPrev ?? false,
		loadingOlder: snapshot.loadingOlder ?? false,
		error: snapshot.error,
		reload,
		loadOlder,
		applyCompactProgress,
		applyLivePatch,
		setStreamingMessage,
		appendMessage,
	};
}

/**
 * Anchor capture is shared with the coordinator's live-patch path (see
 * captureCoordinatorAnchor) so both rebuild routes preserve the viewport
 * identically; a local copy would be free to drift.
 */
const captureAnchor = captureCoordinatorAnchor;
