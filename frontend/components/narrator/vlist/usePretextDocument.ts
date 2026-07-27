import type { TreeMessage } from "@frontend/lib/api/types";
import type {
	PretextLayoutAnchor,
	PretextLayoutIndex,
	PretextLayoutManifest,
} from "@shared/pretext-layout";
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
}

export interface UsePretextDocumentOptions {
	enabled?: boolean;
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
	messages: readonly TreeMessage[];
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
	applyCompactProgress: (messageId: string, outputChars: number, isSegment: boolean) => void;
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
		const currentView = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
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
		(messageId: string, outputChars: number, isSegment: boolean) => {
			coordinator?.applyCompactProgress(messageId, outputChars, isSegment);
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
	return {
		status: snapshot.status,
		messages: snapshot.input?.messages ?? EMPTY_MESSAGES,
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
	};
}

/**
 * Anchor capture is shared with the coordinator's live-patch path (see
 * captureCoordinatorAnchor) so both rebuild routes preserve the viewport
 * identically; a local copy would be free to drift.
 */
const captureAnchor = captureCoordinatorAnchor;
