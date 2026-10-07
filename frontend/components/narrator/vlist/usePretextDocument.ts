import type { TreeMessage } from "@frontend/lib/api/types";
import type {
	PretextLayoutAnchor,
	PretextLayoutIndex,
	PretextLayoutManifest,
} from "@shared/pretext-layout";
import { onTypographyChange } from "@shared/pretext-layout/typography";
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
import type { ResizePermissionResolver } from "./vlist-resize-permission";
import { indexWithHeightOverrides } from "./vlist-resize-preview";

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
	/** Keep the trailing empty reasoning live while the narrator is active. */
	keepEmptyReasoningLive?: boolean;
	/**
	 * A subagent page treats its own (parent-pointing) messages as top-level, which
	 * decides whether an arriving child message may be appended locally.
	 */
	isSubagent?: boolean;
	lod: RenderLod;
	widthBucket: string | number;
	contentWidth: number;
	viewportHeight: number;
	/** Explicit finish signal, including a drag that returns to its starting width. */
	widthCommitEpoch?: number;
	/** Live controlled-exception heights, read only at preview/finish time. */
	getHeightOverrides?: () => ReadonlyMap<string, number>;
	getResizeInputs?: () => {
		dirtyKeys: ReadonlySet<string>;
		resolvePermissionForm: ResizePermissionResolver;
		onMeasuredKeys: (keys: ReadonlySet<string>) => void;
	};
	gap?: number;
	/** Wider gap between top-level render units (messages / tool-runs / dividers). */
	segmentGap?: number;
	topPadding?: number;
	bottomPadding?: number;
	isExpanded?: (key: string) => boolean | undefined;
	isTextExpanded?: (specKey: string, bodyKey?: string) => boolean;
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
	/**
	 * Row-KEY addressed expansion for `activity-trace` (see
	 * `AdapterContext.isRowExpanded`). Its identity moves with the expanded-row
	 * state, so folding it into `buildOptions` is what rebuilds the document when
	 * the reader drills into a row.
	 */
	isRowExpanded?: (traceKey: string, rowKey: string) => boolean;
	/** Resolve whether a translated reasoning body shows its ORIGINAL text. */
	showOriginal?: (key: string) => boolean;
	/** Resolve whether a subagent card's prompt body is open. */
	isPromptOpen?: (key: string) => boolean;
	/** Reader expanded a subagent card's file-change list (its own fold). */
	isFileChangesOpen?: (key: string) => boolean;
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
	/** Whether an error card may offer the model probe. Shares the fix's measured
	 * button row, so the same rebuild contract applies. */
	canOfferModelTest?: (errorText: string) => boolean;
	/** Resolve a tool item's pending-permission presence (live WS list). Its
	 * reference changes when the pending set changes, so folding it into
	 * buildOptions triggers a document rebuild (cards expand / collapse). */
	resolveHasPendingPermission?: (toolUseId: string | undefined) => boolean;
	/**
	 * First-frame layout / painted height of a live InlinePermission form. Both
	 * change identity when their inputs do (a request arriving, a form reporting a new
	 * height), so folding them into buildOptions rebuilds the document with the
	 * reserve the card must now make.
	 */
	resolvePermissionFormPrediction?: (toolUseId: string | undefined) => unknown;
	resolvePermissionFormHeight?: (toolUseId: string | undefined) => number | undefined;
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
	onScrollTopCorrection?: (
		scrollTop: number,
		anchorKind: PretextLayoutAnchor["kind"],
		smoothFollow?: boolean,
	) => void;
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
	manifest?: PretextLayoutManifest;
	index?: PretextLayoutIndex;
	items: readonly VListItem[];
	/** Content/spec baseline; pure width previews do not invalidate semantic metadata. */
	semanticItems: readonly VListItem[];
	semanticManifest?: PretextLayoutManifest;
	resizePreview: boolean;
	resizeWidth?: number;
	resizeMeasuredCount: number;
	resizeRevision: number;
	/** Width-only preview at the LIVE view, returning whether another bounded batch is needed. */
	previewWidth: (width: number, compactUsageLines?: boolean) => boolean;
	scrollTopCorrection?: number;
	scrollTopCorrectionKind?: PretextLayoutAnchor["kind"];
	/** True when the correction answers tail growth and may glide (vlist-smooth-follow). */
	scrollTopCorrectionSmoothFollow?: boolean;
	/** More (older) messages exist above the loaded window. */
	hasPrev: boolean;
	/** An older-page fetch is in flight. */
	loadingOlder: boolean;
	/**
	 * Smallest loaded top-level seq, or null when nothing is loaded yet.
	 *
	 * The one coordinate that answers "is this message inside the loaded window?"
	 * for a target that has no layout item yet — which is what a jump into
	 * not-yet-loaded history has to decide before it can page toward it (see
	 * vlist-jump-window).
	 */
	oldestLoadedSeq: number | null;
	/**
	 * SYNCHRONOUS read of the currently committed window, straight from the
	 * coordinator.
	 *
	 * For callers that page across `await`s. Every field above is render state, so
	 * after awaiting a page they still describe the window as it was BEFORE it grew
	 * (the commit has been published to the store but React may not have re-rendered
	 * yet). A loop that decides "page again?" from those values would either stall or
	 * fetch a page twice; this reads the authoritative snapshot instead.
	 */
	readWindow: () => {
		oldestLoadedSeq: number | null;
		hasPrev: boolean;
		index?: PretextLayoutIndex;
	};

	error?: Error;
	reload: () => void;
	/** Bounded canonical refresh of the current window; never jumps to an ask source. */
	refreshAskInPassing: () => Promise<boolean>;
	/** Extend the loaded window upward by one older page (reverse infinite scroll). */
	loadOlder: () => void;
	/**
	 * `loadOlder` as an awaitable step, resolving with the number of messages
	 * prepended (0 when the document had nothing older to give).
	 *
	 * Exists for the ONE caller that has to know when the page landed: a jump into
	 * history pages upward in a loop until the window covers its target, and a
	 * fire-and-forget `loadOlder` gives it nothing to await, so the loop would spin
	 * against a window that has not grown yet.
	 *
	 * In-flight fetches are COALESCED rather than queued: while a page is loading
	 * (typically one the reader's own upward scroll started), every caller awaits
	 * that same promise instead of starting a second request. Rejects when the page
	 * fails, so the jump loop aborts instead of looping on an unchanged window.
	 */
	loadOlderAsync: () => Promise<number>;
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
	/** Apply a canonical realtime/catch-up message by id + seq without duplicating it. */
	upsertMessage: (message: TreeMessage) => boolean;
	/**
	 * Insert a mid-window structural marker (a segment-compact marker, or a custom
	 * compact with a `beforeMessageId`) into the loaded window in place. Returns
	 * false when the marker cannot be placed locally (duplicate, no seq, newer
	 * than the loaded tail), so the caller falls back to a structural reload.
	 */
	insertMessage: (message: TreeMessage) => boolean;
	/**
	 * Drop deleted messages from the loaded window in place. Returns false when the
	 * deletion cannot be applied locally (nothing loaded matches, or it would empty
	 * the document), so the caller falls back to a structural reload.
	 */
	removeMessages: (deletedIds: readonly string[]) => boolean;
	/**
	 * Apply an updated message in place when it is a trailing-block truncation (the
	 * second half of a rollback). Returns false for any other update, so the caller
	 * falls back to a structural reload — which is the only correct answer for an
	 * edit, since a version-neutral rebuild would serve the surviving blocks' cached
	 * heights.
	 */
	replaceMessage: (
		message: TreeMessage,
		aliases?: {
			oldMessageId?: string;
			replacedMessageId?: string;
			messageId?: string;
			replacementMessageId?: string;
		},
	) => boolean;
	/**
	 * Drop the oldest `dropCount` loaded messages so a long session's window stays
	 * bounded. The caller must obtain `dropCount` from `resolveHeadTrim`, which owns
	 * the safety rules (notably: never while a streaming row is live). Returns true
	 * when the window actually shrank, so the caller can sweep its per-row caches.
	 */
	trimHead: (dropCount: number) => boolean;
	/** Timestamp of the last trim, for the fill loop's cooldown. 0 when never. */
	getLastTrimAt: () => number;
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
	const lastWidthCommitEpochRef = useRef(options.widthCommitEpoch);
	const heightOverridesReaderRef = useRef(options.getHeightOverrides);
	heightOverridesReaderRef.current = options.getHeightOverrides;
	const resizeInputsReaderRef = useRef(options.getResizeInputs);
	resizeInputsReaderRef.current = options.getResizeInputs;
	const buildOptions = useMemo<PretextLayoutBuildOptions>(
		() => ({
			lod: options.lod,
			keepEmptyReasoningLive: options.keepEmptyReasoningLive,
			isSubagent: options.isSubagent,
			widthBucket: options.widthBucket,
			contentWidth: options.contentWidth,
			viewportHeight: options.viewportHeight,
			gap: options.gap ?? 4,
			segmentGap: options.segmentGap,
			topPadding: options.topPadding ?? 16,
			bottomPadding: options.bottomPadding ?? 16,
			isExpanded: options.isExpanded,
			isTextExpanded: options.isTextExpanded,
			isLodUserOverride: options.isLodUserOverride,
			showEarlier: options.showEarlier,
			expandedRows: options.expandedRows,
			isRowExpanded: options.isRowExpanded,
			showOriginal: options.showOriginal,
			isPromptOpen: options.isPromptOpen,
			isFileChangesOpen: options.isFileChangesOpen,
			recentMessageIds: options.recentMessageIds,
			resolveRecentMessageIds: options.resolveRecentMessageIds,
			labels: options.labels,
			labelsRevision: options.labelsRevision,
			resolveToolCategory: options.resolveToolCategory,
			resolveToolColor: options.resolveToolColor,
			resolveToolSummary: options.resolveToolSummary,
			resolveSubagentRecentSummary: options.resolveSubagentRecentSummary,
			canOfferProviderFix: options.canOfferProviderFix,
			canOfferModelTest: options.canOfferModelTest,
			resolveHasPendingPermission: options.resolveHasPendingPermission,
			resolvePermissionFormPrediction: options.resolvePermissionFormPrediction,
			resolvePermissionFormHeight: options.resolvePermissionFormHeight,
			// ⚠️ No `latestSpecTasksToolUseId` here, deliberately. The pinned tasks card
			// is resolved by `buildPretextDocumentLayout` from the exact message list it
			// lays out, so it needs no build option and cannot go stale: every event that
			// moves the pin (a new tasks write landing) arrives as a message change, which
			// already rebuilds through the in-place channels.
			resolvePendingPlan: options.resolvePendingPlan,
			resolveFullToolInput: options.resolveFullToolInput,
			resolveFullToolOutput: options.resolveFullToolOutput,
			resolvePendingPermissionSuggestions: options.resolvePendingPermissionSuggestions,
			showTokenUsage: options.showTokenUsage,
			compactUsageLines: options.compactUsageLines,
			formatUsageNumber: options.formatUsageNumber,
		}),
		[
			options.keepEmptyReasoningLive,
			options.isSubagent,
			options.bottomPadding,
			// The preference changes the item list. The breakpoint here is already
			// settled; its live value belongs to the bounded preview, not this build.
			options.showTokenUsage,
			options.compactUsageLines,
			options.formatUsageNumber,
			options.contentWidth,
			options.expandedRows,
			// Drilling into a trace row adds a whole measured card, so the resolver's
			// identity must move with the expanded-row state or the document never
			// rebuilds and the row cannot open (same contract as `expandedRows`).
			options.isRowExpanded,
			options.gap,
			options.segmentGap,
			options.isExpanded,
			options.isTextExpanded,
			options.isLodUserOverride,
			options.labels,
			options.labelsRevision,
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
			// Same reason: gaining or losing the probe button changes the card's height.
			options.canOfferModelTest,
			// Rebuild when the pending-permission set changes (its reference changes
			// with the set), so cards expand/collapse as permissions come and go.
			options.resolveHasPendingPermission,
			// The live form's reserve: a new request (prediction) and a new painted height
			// both change a card's height, so each must rebuild the document.
			options.resolvePermissionFormPrediction,
			options.resolvePermissionFormHeight,
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
			// Same contract: expanding a file list draws more rows, so the resolver
			// identity must move with the set or the list never expands.
			options.isFileChangesOpen,
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
			let loadAnchor = anchor;
			let restoreOverrides: ReadonlyMap<string, number> | undefined;
			// A cached/background-loaded document is still being painted. Finish its
			// mixed frames now, without abandoning the width-independent tail fetch.
			if (current.input && lastWidthCommitEpochRef.current !== options.widthCommitEpoch) {
				try {
					const overrides = heightOverridesReaderRef.current?.();
					loadAnchor = current.index
						? captureAnchor(indexWithHeightOverrides(current.index, overrides), currentView)
						: undefined;
					const valid = new Map<string, number>();
					for (const [key, height] of overrides ?? []) {
						const i = current.index?.itemByKey(key)?.index;
						if (i != null && current.items?.[i]?.contentWidth === buildOptions.contentWidth)
							valid.set(key, height);
					}
					restoreOverrides = valid;
					coordinator.finishResize(buildOptions, currentView, overrides);
					lastWidthCommitEpochRef.current = options.widthCommitEpoch;
					// finish already retargeted the pending load with the EFFECTIVE anchor.
					// Do not overwrite it with the raw anchor captured before this finish.
					if (!forceReload) return;
				} catch {
					// The coordinator retains the error; the canonical load can recover.
				}
				lastWidthCommitEpochRef.current = options.widthCommitEpoch;
			}
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
				loadAnchor,
				currentView.viewportHeight,
				{ forceReload, restoreOverrides },
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
				if (lastWidthCommitEpochRef.current !== options.widthCommitEpoch) {
					coordinator.finishResize(buildOptions, currentView, heightOverridesReaderRef.current?.());
				} else coordinator.rebuild(buildOptions, anchor, currentView.viewportHeight);
			} catch {
				// Reported through the snapshot (status: "error" + error).
			}
			lastWidthCommitEpochRef.current = options.widthCommitEpoch;
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
		options.widthCommitEpoch,
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
		return () => {
			coordinator.publishDocumentSnapshot();
			coordinator.releaseTransientCaches();
		};
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
	// The reader's own typography (font scale / letter spacing / block spacing) is a
	// MEASUREMENT input, not presentation, so a change invalidates exactly what a
	// font swap does: baked fragment widths, the heights derived from them, and the
	// committed layout holding those heights. Hence the same rebuild path.
	//
	// Unlike the font generation this one fires in normal use — the settings panel
	// is designed to be adjusted while watching the transcript — so anchoring is
	// what keeps the text the reader is looking at from sliding away under them.
	useEffect(() => {
		if (!coordinator) return;
		return onTypographyChange(() => {
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
		// The same numeric correction must be re-applied to each new canvas commit.
		void snapshot.resizeRevision;
		if (snapshot.scrollTop == null || !snapshot.scrollTopAnchorKind) return;
		options.onScrollTopCorrection?.(
			snapshot.scrollTop,
			snapshot.scrollTopAnchorKind,
			snapshot.scrollTopSmoothFollow === true,
		);
	}, [
		options.onScrollTopCorrection,
		snapshot.scrollTop,
		snapshot.scrollTopAnchorKind,
		snapshot.scrollTopSmoothFollow,
		snapshot.resizeRevision,
	]);
	const reload = useCallback(() => setReloadToken((value) => value + 1), []);
	// Preserve the visible content by height arithmetic: the coordinator shifts
	// scrollTop by the exact height prepended above it. No item-key anchor is
	// used, so a tool-run regrouping across the new page boundary cannot desync
	// the position. Pinned-to-bottom (first-screen fill) stays pinned instead.
	// The view is read LIVE at commit time (after the fetch) so scrolling during
	// a slow request cannot desync the base scrollTop from the correction.
	const loadOlderAsync = useCallback(async () => {
		if (!coordinator) return 0;
		const current = coordinator.getSnapshot();
		// `loadingOlder` is NOT a rejection here (unlike the other guards): the
		// coordinator joins an in-flight page, which is exactly what a caller that
		// awaits the result needs. Only a document that cannot page at all returns 0.
		if (current.status !== "ready" || !current.hasPrev) return 0;
		if (!current.index) return 0;
		return coordinator.loadOlder(
			buildOptions,
			() => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			},
			() => heightOverridesReaderRef.current?.(),
		);
	}, [buildOptions, coordinator, options.getCurrentView]);
	// Fire-and-forget wrapper for the scroll gate / first-screen fill, which have
	// nothing to await and no way to report a failure. The rejection is swallowed
	// here (the coordinator has already recorded it on the snapshot and stayed
	// "ready", so the next upward gesture retries) rather than surfacing as an
	// unhandled rejection.
	const loadOlder = useCallback(() => {
		if (!coordinator || coordinator.getSnapshot().loadingOlder) return;
		void loadOlderAsync().catch(() => {
			// Reported through the snapshot's retained error; paging stays available.
		});
	}, [coordinator, loadOlderAsync]);
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
	const readWindow = useCallback<UsePretextDocumentResult["readWindow"]>(() => {
		const current = coordinator?.getSnapshot();
		return {
			oldestLoadedSeq: current?.input?.oldestLoadedSeq ?? null,
			hasPrev: current?.hasPrev ?? false,
			index: current?.index,
		};
	}, [coordinator]);
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
	// Same live-view contract as appendMessage: the anchor is captured from the
	// CURRENT scroll position at insert time, so a scroll in flight cannot desync
	// it from the correction that follows.
	const upsertMessage = useCallback(
		(message: TreeMessage) =>
			coordinator?.upsertMessage(message, options.isSubagent === true, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? false,
		[coordinator, options.getCurrentView, options.isSubagent],
	);
	const refreshAskInPassing = useCallback(
		() =>
			coordinator?.refreshAskInPassing(() => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? Promise.resolve(false),
		[coordinator, options.getCurrentView],
	);
	const insertMessage = useCallback(
		(message: TreeMessage) =>
			coordinator?.insertMessage(message, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? false,
		[coordinator, options.getCurrentView],
	);
	// Both in-place history mutations read the view LIVE at patch time, the same
	// contract as loadOlder / applyLivePatch / appendMessage: a scroll in flight must
	// not desync the captured anchor from the correction that follows it.
	const removeMessages = useCallback(
		(deletedIds: readonly string[]) =>
			coordinator?.removeMessages(deletedIds, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? false,
		[coordinator, options.getCurrentView],
	);
	const replaceMessage = useCallback(
		(
			message: TreeMessage,
			aliases?: {
				oldMessageId?: string;
				replacedMessageId?: string;
				messageId?: string;
				replacementMessageId?: string;
			},
		) =>
			coordinator?.replaceMessage(message, aliases, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? false,
		[coordinator, options.getCurrentView],
	);
	const trimHead = useCallback(
		(dropCount: number) =>
			coordinator?.trimHead(dropCount, () => {
				const view = resolvePretextDocumentView(viewRef.current, options.getCurrentView);
				return {
					scrollTop: view.scrollTop,
					pinnedToBottom: view.pinnedToBottom,
					viewportHeight: view.viewportHeight,
				};
			}) ?? false,
		[coordinator, options.getCurrentView],
	);
	const getLastTrimAt = useCallback(() => coordinator?.getLastTrimAt() ?? 0, [coordinator]);
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
	const previewWidth = useCallback(
		(width: number, compactUsageLines?: boolean) =>
			coordinator?.previewWidth(
				width,
				() => resolvePretextDocumentView(viewRef.current, options.getCurrentView),
				heightOverridesReaderRef.current?.(),
				{ ...resizeInputsReaderRef.current?.(), compactUsageLines },
			) ?? false,
		[coordinator, options.getCurrentView],
	);
	return {
		status: snapshot.status,
		messages: snapshot.input?.messages ?? EMPTY_MESSAGES,
		streamingMessage: snapshot.streamingMessage ?? null,
		messageVersion: snapshot.input?.messageVersion,
		manifest: snapshot.manifest,
		index: snapshot.index,
		items: snapshot.items ?? EMPTY_ITEMS,
		semanticItems: snapshot.semanticItems ?? snapshot.items ?? EMPTY_ITEMS,
		semanticManifest: snapshot.semanticManifest ?? snapshot.manifest,
		resizePreview: snapshot.resizePreview === true,
		resizeWidth: snapshot.resizeWidth,
		resizeMeasuredCount: snapshot.resizeMeasuredCount ?? 0,
		resizeRevision: snapshot.resizeRevision ?? 0,
		previewWidth,
		scrollTopCorrection: snapshot.scrollTop,
		scrollTopCorrectionKind: snapshot.scrollTopAnchorKind,
		scrollTopCorrectionSmoothFollow: snapshot.scrollTopSmoothFollow,
		hasPrev: snapshot.hasPrev ?? false,
		loadingOlder: snapshot.loadingOlder ?? false,
		oldestLoadedSeq: snapshot.input?.oldestLoadedSeq ?? null,
		readWindow,

		error: snapshot.error,
		reload,
		refreshAskInPassing,
		loadOlder,
		loadOlderAsync,
		applyLivePatch,
		setStreamingMessage,
		appendMessage,
		upsertMessage,
		insertMessage,
		removeMessages,
		replaceMessage,
		trimHead,
		getLastTrimAt,
	};
}

/**
 * Anchor capture is shared with the coordinator's live-patch path (see
 * captureCoordinatorAnchor) so both rebuild routes preserve the viewport
 * identically; a local copy would be free to drift.
 */
const captureAnchor = captureCoordinatorAnchor;
