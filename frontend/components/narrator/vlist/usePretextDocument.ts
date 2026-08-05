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
import { onFontRevisionChange } from "./katex-runtime";
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
	/** Label detail for a subagent recent-call row (tool name + projected input keys),
	 * so the vlist row says the same thing the chunked one does. */
	resolveSubagentRecentSummary?: (toolName: string, inputSummary: unknown) => string | null;
	/** Whether an error card may offer the "turn off image generation" fix. Its
	 * button is a measured row, so this reaches the adapter (see AdapterContext).
	 * The reference changes with the user/narrator/provider it depends on, which is
	 * why folding it into buildOptions triggers a rebuild. */
	canOfferProviderFix?: (errorText: string) => boolean;
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
	/**
	 * Reader enabled per-turn token usage rows. Toggling it changes the item COUNT
	 * (the adapter emits no usage spec when disabled), so it needs no cache-key
	 * revision of its own — the rebuild it triggers is already structural.
	 */
	showTokenUsage?: boolean;
	/** Phone-sized viewport → the trailing usage summary splits across two lines. */
	compactUsageLines?: boolean;
	/** Locale-aware number grouping for the usage rows. */
	formatUsageNumber?: (value: number) => string;
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
			resolveSubagentRecentSummary: options.resolveSubagentRecentSummary,
			canOfferProviderFix: options.canOfferProviderFix,
			resolveHasPendingPermission: options.resolveHasPendingPermission,
			resolvePendingPlan: options.resolvePendingPlan,
			resolveFullToolInput: options.resolveFullToolInput,
			resolveFullToolOutput: options.resolveFullToolOutput,
			resolvePendingPermissionSuggestions: options.resolvePendingPermissionSuggestions,
			showTokenUsage: options.showTokenUsage,
			compactUsageLines: options.compactUsageLines,
			formatUsageNumber: options.formatUsageNumber,
		}),
		[
			options.bottomPadding,
			// Both usage inputs change the emitted item list, so a rebuild is required
			// (not merely a re-measure) when the reader flips the preference or rotates
			// a phone across the breakpoint.
			options.showTokenUsage,
			options.compactUsageLines,
			options.formatUsageNumber,
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
			options.resolveSubagentRecentSummary,
			// The fix button is a measured row, so eligibility must rebuild the
			// document: the predicate's identity changes when the current user or the
			// narrator's resolved provider does, and a card that gains (or loses) the
			// button changes height.
			options.canOfferProviderFix,
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
			// Adopt a cached document for this narrator so the first screen paints from
			// memory instead of a 283KB-1.3MB tail refetch plus a cold measure pass.
			//
			// A restore is an OPTIMISATION, never authority: the window it replays was
			// current when the reader left, and anything that happened since (new
			// messages, an edit, a compact) is invisible to it. So a successful restore
			// always schedules one structural revalidation, which replaces the window
			// with the live tail. The reader sees their history immediately and the
			// refresh lands underneath them, pinned to the bottom exactly as a cold
			// load would be.
			//
			// Returns here rather than falling through: the restore already committed a
			// layout at these very build options, so continuing would rebuild the
			// identical document a second time in this same effect run. The revalidation
			// is scheduled by bumping the reload token, which re-runs THIS effect and
			// takes its `forceReload` branch — the same path a manual refresh uses, so
			// the restored window is replaced by the live tail with no special-case
			// commit logic. The restored screen stays visible until that fetch commits
			// (the coordinator keeps its `input` while `status` is "loading"), making it
			// a background refresh rather than a flash back to a skeleton.
			if (
				coordinator.restore(narratorId, buildOptions, options.loadOptions, options.viewportHeight)
			) {
				lastLodRef.current = options.lod;
				setReloadToken((value) => value + 1);
				return;
			}
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
		if (current.input) {
			// SWALLOW the rethrow, deliberately.
			//
			// `rebuild` is synchronous and rethrows after recording `status: "error"`
			// on the snapshot. Letting that escape an effect hands the error to the
			// route's CatchBoundary, which remounts this subtree — and the remount
			// re-runs this very effect, which throws again. That loop is not
			// hypothetical: a missing `Array.prototype.at` on Safari 14 made every
			// markdown measure throw, and the list flickered forever with no message
			// rendered and no error shown (the shell's own error card reads
			// `pretextDocument.error`, which the escaping throw skipped past).
			//
			// The coordinator has already published the error by the time it rethrows,
			// so catching here loses no information: the shell renders its retry card
			// from the snapshot instead of dying. `load`'s failures are equivalent and
			// already discarded via `void` on a rejected promise; this is the same
			// contract for the synchronous path.
			try {
				coordinator.rebuild(buildOptions, anchor, options.viewportHeight);
			} catch {
				// Reported through the snapshot (status: "error" + error).
			}
		} else
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
	// Publish the loaded window on teardown so the next mount can restore it.
	//
	// `reset()` already publishes on the narrator-switch path, but an unmount does
	// not route through it (the route destroys the whole subtree under
	// `key={narratorId}`), which is precisely the case this cache exists for.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId drives the cleanup that publishes the outgoing narrator's document
	useEffect(() => {
		if (!coordinator) return;
		return () => coordinator.publishDocumentSnapshot();
	}, [coordinator, narratorId]);
	// A font face resolving mid-session invalidates every baked fragment width, so
	// the prepared blocks AND the heights derived from them must be dropped and the
	// layout rebuilt — otherwise the committed geometry keeps the old wrap points
	// while the DOM repaints with the real face (scroll jumps + overlapping rows).
	// This is the ONLY subscriber to that generation, so without it the mechanism in
	// katex-runtime / prepared-markdown-cache would never fire.
	//
	// A no-op today: the app ships system font stacks only, so the generation stays
	// 0 (see the FONT REVISION note in prepared-markdown-cache). Plumbed because the
	// assumption is one `@font-face` away from being wrong and the failure is silent.
	//
	// The view is read LIVE at invalidation time and the gesture focus point is
	// dropped (same contract as loadOlder / applyLivePatch): fonts settle without
	// the reader pointing at anything, so the rebuild anchors on the viewport top.
	useEffect(() => {
		if (!coordinator) return;
		return onFontRevisionChange(() => {
			coordinator.invalidateFontDependentLayout(() => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			});
		});
	}, [coordinator, options.getCurrentView]);
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
