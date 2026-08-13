import type { TreeMessage } from "@frontend/lib/api/types";
import {
	capturePretextLayoutAnchor,
	type PretextLayoutAnchor,
	type PretextLayoutIndex,
	type PretextLayoutManifest,
	restorePretextLayoutAnchor,
} from "@shared/pretext-layout";
import { resetPreparedMarkdownCache } from "@shared/pretext-layout/prepared-markdown-cache";
import type { ProgressSnapshot } from "@shared/progress-phase";
import type { NarratorMsg } from "../narrator-panel-types";
import { ensureKatexLoaded, getFontRevision, getKatexRevision } from "./katex-runtime";
import { measureCache } from "./measure-cache";
import type { RenderLod } from "./prepared-block";
import {
	invalidateCachedPretextDocument,
	peekCachedPretextDocument,
	writeCachedPretextDocument,
} from "./pretext-document-cache";
import {
	type BuildPretextDocumentLayoutOptions,
	buildPretextDocumentLayout,
} from "./pretext-document-layout";
import {
	firstScreenPageSizeForLod,
	loadPretextDocumentOlder,
	loadPretextDocumentTail,
	type PretextDocumentInput,
	type PretextDocumentLoadOptions,
} from "./pretext-document-loader";
import { appendLoadedMessage } from "./vlist-message-append";
import { removeLoadedMessages } from "./vlist-message-remove";
import { replaceLoadedMessage } from "./vlist-message-replace";
import type { VListItem } from "./vlist-pipeline";

export type PretextLayoutCoordinatorStatus = "idle" | "loading" | "computing" | "ready" | "error";

/** Live scroll state read at commit time for prepend correction. */
export interface PrependView {
	scrollTop: number;
	pinnedToBottom: boolean;
	viewportHeight: number;
}

export interface PretextLayoutCoordinatorSnapshot {
	status: PretextLayoutCoordinatorStatus;
	input?: PretextDocumentInput;
	/**
	 * The live streaming message currently appended to the document, if any.
	 *
	 * Kept OUTSIDE `input` on purpose: `input` is the persisted, paginated snapshot
	 * (its `messages.length`, `oldestLoadedSeq`, `hasPrev` and version drive
	 * `loadOlder`'s prepend arithmetic and its version/prune consistency checks).
	 * A synthetic, unpersisted row must not participate in any of that.
	 */
	streamingMessage?: TreeMessage | null;
	manifest?: PretextLayoutManifest;
	index?: PretextLayoutIndex;
	items?: readonly VListItem[];
	scrollTop?: number;
	scrollTopAnchorKind?: PretextLayoutAnchor["kind"];
	/** More (older) messages exist above the loaded window. */
	hasPrev?: boolean;
	/** An older-page fetch is in flight (drives the load indicator). */
	loadingOlder?: boolean;
	/**
	 * Wall-clock cost (ms) of the most recent layout build.
	 *
	 * DIAGNOSTIC ONLY. It deliberately drives no behaviour: it times the measurement
	 * pass, and using it to decide whether a resize could "afford" a rebuild is exactly
	 * what made the drag freeze inert (a realistic window measures ~2ms while its
	 * mounted DOM takes an order of magnitude longer to rebuild). See
	 * vlist-width-settle for why no cost estimate is consulted at all.
	 */
	lastBuildMs?: number;
	error?: Error;
}

export interface PretextLayoutBuildOptions
	extends Omit<
		BuildPretextDocumentLayoutOptions,
		"layoutRevision" | "documentRevision" | "lod" | "pruneBoundaryMessageId"
	> {
	lod: RenderLod;
}

/**
 * Capture the scroll anchor for a rebuild: the bottom distance when pinned,
 * otherwise the item under the FOCUS POINT plus the offset into it. Restoring it
 * after the rebuild (restorePretextLayoutAnchor) keeps that point's content fixed
 * even when an item's height changed.
 *
 * `view.focusOffset` (document px) is the point the user is pointing at — the
 * mouse for alt+wheel, the pinch center for two fingers. Absent (live patches,
 * width changes) it defaults to the viewport top, which is the behavior every
 * non-gesture rebuild wants.
 *
 * Lives here (rather than in the hook) because BOTH the hook's rebuild path and
 * the coordinator's own live-patch path must capture identically — two copies
 * would be free to drift and silently reintroduce viewport jumps.
 */
/** Monotonic clock, falling back to Date.now in environments without performance. */
function now(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function captureCoordinatorAnchor(
	index: PretextLayoutIndex,
	view: {
		scrollTop: number;
		viewportHeight: number;
		pinnedToBottom: boolean;
		focusOffset?: number;
	},
): PretextLayoutAnchor {
	return capturePretextLayoutAnchor(
		index,
		view.scrollTop,
		view.viewportHeight,
		view.pinnedToBottom,
		{ focusOffset: view.focusOffset },
	);
}

export class PretextLayoutCoordinator {
	private generation = 0;
	private input: PretextDocumentInput | undefined;
	private current: PretextLayoutCoordinatorSnapshot = { status: "idle" };
	private readonly listeners = new Set<() => void>();
	/** Retained so loadOlder can fetch subsequent pages without re-plumbing them. */
	private narratorId: string | undefined;
	private loadOptions: PretextDocumentLoadOptions = {};
	private loadingOlder = false;
	/**
	 * The in-flight upward page, so a second caller can AWAIT it instead of being
	 * told "0 prepended" and looping against a window that is about to grow.
	 *
	 * Only the awaitable jump path needs this. `loadOlder`'s fire-and-forget callers
	 * (the scroll gate, first-screen fill) are content with the early return, but a
	 * jump that pages toward a target must not mistake "someone else is already
	 * fetching this page" for "there is nothing more to load".
	 */
	private pendingOlder: Promise<number> | null = null;
	/**
	 * Last committed build options + viewport, retained so an out-of-band mutation
	 * (e.g. a compact_progress tick that patches an already-loaded message in place)
	 * can rebuild the layout without the shell re-plumbing the current build params.
	 */
	private lastBuildOptions: PretextLayoutBuildOptions | undefined;
	private lastViewportHeight = 0;
	/**
	 * Live streaming message, appended to the document at build time.
	 *
	 * This is what replaced the old streaming OVERLAY. Rendering live output as a
	 * separate block below the canvas meant it had its own layout, its own scroll
	 * arithmetic, and a retirement handshake that could clear it while the real card
	 * had not arrived yet (the "output vanishes when you scroll up" bug). As a
	 * regular trailing message it shares one coordinate system with everything else.
	 */
	private streamingMessage: TreeMessage | null = null;
	/**
	 * Full payloads for cards that expand WITHOUT user input. Resolved on the async
	 * boundary below (beside KaTeX) so the first build already measures the real
	 * body — an auto-expanded card must never grow after paint. Cards the user
	 * expands later keep the on-demand path in the shell.
	 */
	/**
	 * In-flight tail load. Its fetch is width/LOD-independent, so a build-option
	 * change during it (e.g. the initial ResizeObserver pass) must NOT start a
	 * second fetch — it only updates the params the single fetch commits with.
	 */
	private pendingLoad: {
		narratorId: string;
		generation: number;
		buildOptions: PretextLayoutBuildOptions;
		anchor?: PretextLayoutAnchor;
		viewportHeight: number;
		promise: Promise<PretextLayoutCoordinatorSnapshot>;
	} | null = null;

	getSnapshot = (): PretextLayoutCoordinatorSnapshot => this.current;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	async load(
		narratorId: string,
		buildOptions: PretextLayoutBuildOptions,
		loadOptions: PretextDocumentLoadOptions = {},
		anchor?: PretextLayoutAnchor,
		viewportHeight = 0,
		opts: { forceReload?: boolean } = {},
	): Promise<PretextLayoutCoordinatorSnapshot> {
		// Coalesce: reuse an in-flight tail fetch for the same narrator instead of
		// issuing a duplicate request. Re-target it to the latest build options so
		// it commits once at the final width/LOD. forceReload always restarts.
		const pending = this.pendingLoad;
		if (pending && !opts.forceReload && pending.narratorId === narratorId) {
			pending.buildOptions = buildOptions;
			pending.anchor = anchor;
			pending.viewportHeight = viewportHeight;
			this.loadOptions = loadOptions;
			return pending.promise;
		}

		const generation = ++this.generation;
		this.narratorId = narratorId;
		this.loadOptions = loadOptions;
		this.current = { ...this.current, status: "loading", error: undefined };
		this.emit();
		const entry: NonNullable<PretextLayoutCoordinator["pendingLoad"]> = {
			narratorId,
			generation,
			buildOptions,
			anchor,
			viewportHeight,
			promise: undefined as unknown as Promise<PretextLayoutCoordinatorSnapshot>,
		};
		// Size the first-screen fetch by the initiating LOD (an explicit
		// firstScreenPageSize in loadOptions always wins). The fetch size is fixed
		// at initiation: a coalesced LOD change re-targets the layout build, not the
		// number of rows fetched, so it never triggers a second request.
		const tailLoadOptions: PretextDocumentLoadOptions = {
			...loadOptions,
			firstScreenPageSize:
				loadOptions.firstScreenPageSize ?? firstScreenPageSizeForLod(buildOptions.lod),
		};
		const run = async (): Promise<PretextLayoutCoordinatorSnapshot> => {
			try {
				// First screen: the newest (tail) page only. Older messages are pulled
				// lazily by loadOlder so long histories never fetch the whole document.
				const input = await loadPretextDocumentTail(narratorId, tailLoadOptions);
				if (generation !== this.generation) return this.current;
				// Math needs KaTeX before heights can be measured exactly (see
				// prepareKatex); no-ops for documents without formulas.
				//
				// Truncated bodies need NO equivalent pre-pass: a truncated body reserves
				// its full cap (measure-tool-call's cappedBodyHeight), so its first
				// painted height is already its final one. That is what removed the
				// build-time payload prefetch this used to await.
				await this.prepareKatex(input);
				if (generation !== this.generation) return this.current;
				this.input = input;
				// Commit with the LATEST params (a resize during the fetch updates them).
				return this.commitLayout(
					input,
					entry.buildOptions,
					entry.anchor,
					entry.viewportHeight,
					generation,
				);
			} catch (error) {
				if (generation !== this.generation) return this.current;
				this.current = {
					...this.current,
					status: "error",
					error: error instanceof Error ? error : new Error(String(error)),
				};
				this.emit();
				throw error;
			} finally {
				if (this.pendingLoad === entry) this.pendingLoad = null;
			}
		};
		entry.promise = run();
		this.pendingLoad = entry;
		return entry.promise;
	}

	/**
	 * Extend the loaded window upward by one older page, then rebuild the exact
	 * layout from the full loaded set.
	 *
	 * Scroll preservation is pure arithmetic: prepending older messages only adds
	 * height ABOVE everything already on screen, so the content the reader is on
	 * shifts down by exactly `newTotalHeight - oldTotalHeight`. Correcting
	 * `scrollTop` by that delta keeps the visible content perfectly fixed. This is
	 * deterministic (heights come from pretext, never DOM measurement) and — unlike
	 * an item-key anchor — immune to key changes when a tool-run regroups across
	 * the new page boundary. When the caller is pinned to the bottom (first-screen
	 * fill), the newest content stays pinned instead and the shell re-snaps.
	 * Returns the number of messages prepended.
	 */
	async loadOlder(
		buildOptions: PretextLayoutBuildOptions,
		getView: () => PrependView = () => ({ scrollTop: 0, pinnedToBottom: false, viewportHeight: 0 }),
	): Promise<number> {
		const previous = this.input;
		if (!previous?.hasPrev || this.narratorId == null) return 0;
		// Join the in-flight page rather than reporting "nothing prepended": the
		// awaitable jump path uses the resolved count to decide whether to page
		// again, and a premature 0 would end the jump one page short of its target.
		if (this.loadingOlder) return this.pendingOlder ?? 0;
		this.loadingOlder = true;
		const promise = this.runLoadOlder(previous, buildOptions, getView);
		this.pendingOlder = promise;
		return promise;
	}

	private async runLoadOlder(
		previous: PretextDocumentInput,
		buildOptions: PretextLayoutBuildOptions,
		getView: () => PrependView,
	): Promise<number> {
		if (this.narratorId == null) return 0;
		const generation = this.generation;
		const previousTotalHeight = this.current.index?.totalHeight ?? 0;
		this.current = { ...this.current, loadingOlder: true };
		this.emit();
		try {
			const next = await loadPretextDocumentOlder(this.narratorId, previous, this.loadOptions);
			if (generation !== this.generation) return 0;
			// An older page may introduce the document's first formula; resolved before
			// the prepend commits so the newly prepended rows are never re-measured.
			await this.prepareKatex(next);
			if (generation !== this.generation) return 0;
			const added = next.messages.length - previous.messages.length;
			this.input = next;
			if (added <= 0) {
				// Nothing prepended (server reported no older rows); just refresh flags.
				this.current = { ...this.current, input: next, hasPrev: next.hasPrev };
				this.emit();
				return 0;
			}
			// Read the view LIVE (after the fetch) so momentum scrolling during a slow
			// request cannot desync the base scrollTop from the applied correction.
			this.commitPrependLayout(next, buildOptions, getView(), previousTotalHeight, generation);
			return added;
		} catch (error) {
			if (generation !== this.generation) return 0;
			// A FAILED UPWARD PAGE MUST NOT DISABLE THE LIST.
			//
			// This used to set `status: "error"`, which was self-defeating: `loadOlder`
			// only runs while the status is "ready", so one failure permanently disabled
			// upward paging — and because the already-loaded canvas kept rendering, the
			// reader saw no error at all, just history that had silently stopped loading.
			//
			// The loaded window is still perfectly valid (nothing was mutated before the
			// throw), so the recoverable outcome is to stay "ready" and let the next
			// upward gesture retry. The error is retained for diagnostics only.
			this.current = {
				...this.current,
				error: error instanceof Error ? error : new Error(String(error)),
			};
			this.emit();
			throw error;
		} finally {
			this.loadingOlder = false;
			this.pendingOlder = null;
			// Repair a stale spinner flag even if a concurrent rebuild/reload bumped
			// the generation while this fetch was in flight (that commit captured
			// loadingOlder=true). Never resurrect a snapshot from an older generation.
			if (this.current.loadingOlder) {
				this.current = { ...this.current, loadingOlder: false };
				this.emit();
			}
		}
	}

	rebuild(
		buildOptions: PretextLayoutBuildOptions,
		anchor?: PretextLayoutAnchor,
		viewportHeight = 0,
	): PretextLayoutCoordinatorSnapshot {
		if (!this.input) throw new Error("cannot rebuild layout before document input is loaded");
		const generation = ++this.generation;
		this.current = { ...this.current, status: "computing", error: undefined };
		this.emit();
		return this.commitLayout(this.input, buildOptions, anchor, viewportHeight, generation);
	}

	/**
	 * Apply a live compact-progress tick (from the `compact_progress` WS event) to
	 * the loaded document without a network refetch. The server streams the
	 * summary char count but does NOT persist it or re-broadcast the message, so —
	 * mirroring the chunk path's `applyCompactProgressByMessageId` — we patch the
	 * compact block's progress fields in the already-loaded input in place and
	 * rebuild. The compact indicator's height is constant, so this only re-composes
	 * its one-line label (the adapter folds the phase and both counts into the
	 * measure cache key so the new text is not served stale). No-ops when the
	 * target message is not loaded, its progress is unchanged, or no prior build
	 * options exist yet.
	 */
	applyCompactProgress(messageId: string, progress: ProgressSnapshot, isSegment: boolean): void {
		if (!this.input || !this.lastBuildOptions) return;
		const expectedType = isSegment ? "segment_compact" : "compact";
		const patched = patchCompactProgress(this.input.messages, messageId, progress, expectedType);
		if (!patched.changed) return;
		// No anchor: the compact indicator's height is CONSTANT, so the rebuild
		// cannot move anything. (applyLivePatch below must anchor, because a tool
		// status change does resize its card.)
		// Keep the same messageVersion/length (this is an in-place field patch, not
		// a structural change) so the anchor-preserving rebuild reuses every other
		// item's cached measurement; only the compacting card re-measures.
		this.input = { ...this.input, messages: patched.messages };
		const generation = ++this.generation;
		this.commitLayout(
			this.input,
			this.lastBuildOptions,
			undefined,
			this.lastViewportHeight,
			generation,
		);
	}

	/**
	 * Apply a LIVE LIFECYCLE patch to the loaded document without a refetch.
	 *
	 * This is the update channel for events that mutate an already-loaded message
	 * in place: a tool call finishing, a reflection gate resolving, a permission
	 * being decided, a subagent's activity summary advancing. The server does not
	 * re-broadcast the owning message for any of these (and reflections do not even
	 * bump `messageVersion`), so without this path the card renders its stale
	 * "running" / "reflecting" state until an unrelated structural reload happens.
	 *
	 * Like applyCompactProgress this keeps `messageVersion` and the message COUNT
	 * unchanged — it is a field patch, not a structural change — so the rebuild
	 * reuses every untouched item's cached measurement and only the patched card is
	 * re-measured.
	 *
	 * Unlike applyCompactProgress it MUST anchor. A status transition changes the
	 * card's height (a detail body appears, a status row changes), and the exact
	 * list's protected invariant is that a committed row never visually jumps
	 * without a user action. Capturing the anchor before the rebuild and restoring
	 * scrollTop after keeps the viewport content pinned across the resize; the
	 * caller supplies the live view so a scroll in flight cannot desync it.
	 *
	 * No-ops when nothing is loaded, no build options exist yet, or the patch
	 * reports no change (an event for a tool outside the loaded window).
	 */
	applyLivePatch(
		patch: (messages: readonly TreeMessage[]) => {
			readonly messages: readonly TreeMessage[];
			changed: boolean;
		},
		getView?: () => PrependView,
	): boolean {
		if (!this.input || !this.lastBuildOptions) return false;
		const result = patch(this.input.messages);
		if (!result.changed) return false;
		// The patch result is readonly by contract (its no-change branch hands back
		// this very array). This coordinator is the owner that adopts it as the new
		// loaded document, so the cast is confined to exactly one place.
		this.input = { ...this.input, messages: result.messages as TreeMessage[] };
		const view = getView?.();
		const anchor =
			view && this.current.index ? captureCoordinatorAnchor(this.current.index, view) : undefined;
		const generation = ++this.generation;
		this.commitLayout(
			this.input,
			this.lastBuildOptions,
			anchor,
			view?.viewportHeight ?? this.lastViewportHeight,
			generation,
		);
		return true;
	}

	/**
	 * Append a newly broadcast message to the loaded window IN PLACE.
	 *
	 * This replaces answering an arriving message with a tail refetch (40-100
	 * messages plus a full re-measure, coalesced over 120ms-1s and DEFERRED entirely
	 * while the reader was scrolled up). The message body arrives in the event, so
	 * the round trip bought nothing; appending costs one row's measurement because an
	 * append perturbs at most one committed item (the previous card's trailing
	 * divider when it stops being its run's last).
	 *
	 * Only tail-extending, non-restructuring messages qualify — `resolveMessageAppend`
	 * owns that judgement and everything else still falls back to a reload.
	 *
	 * Like every other in-place path this keeps `messageVersion` fixed (it is the
	 * measurement-cache generation for the rows on screen) and anchors the rebuild so
	 * a reader who has scrolled up is not moved.
	 *
	 * Returns false when nothing was appended, so the caller can decide to reload.
	 */
	appendMessage(message: TreeMessage, isSubagent: boolean, getView?: () => PrependView): boolean {
		if (!this.input || !this.lastBuildOptions) return false;
		const result = appendLoadedMessage(this.input.messages, message, isSubagent);
		if (!result.appended) return false;
		this.input = { ...this.input, messages: result.messages as TreeMessage[] };
		const view = getView?.();
		const anchor =
			view && this.current.index ? captureCoordinatorAnchor(this.current.index, view) : undefined;
		const generation = ++this.generation;
		this.commitLayout(
			this.input,
			this.lastBuildOptions,
			anchor,
			view?.viewportHeight ?? this.lastViewportHeight,
			generation,
		);
		return true;
	}

	/**
	 * Drop deleted messages from the loaded window IN PLACE.
	 *
	 * The counterpart to `appendMessage`, and for the same reason: the event carries
	 * everything needed (the ids), so answering a deletion with a tail refetch bought
	 * nothing — and worse, a structural reload is DEFERRED while the reader is
	 * scrolled up (`vlist-reload-policy.ts`), which is precisely where a reader who
	 * right-clicked a message in history always is. That deferral is what made a
	 * rollback appear not to happen until the reader scrolled back to the bottom.
	 *
	 * `removeLoadedMessages` owns the judgement of what may be dropped locally;
	 * anything it declines still falls back to the reload, which is always correct.
	 *
	 * Like every in-place path this keeps `messageVersion` fixed — it is the measure
	 * cache generation for the rows on screen, and the surviving rows' content did
	 * not change — and anchors the rebuild so nobody is scrolled around. Cache
	 * correctness rests on `spec.key`: removed rows' keys simply stop appearing.
	 *
	 * Returns false when nothing was removed, so the caller can decide to reload.
	 */
	removeMessages(deletedIds: readonly string[], getView?: () => PrependView): boolean {
		if (!this.input || !this.lastBuildOptions) return false;
		const result = removeLoadedMessages(this.input.messages, deletedIds);
		if (!result.removed) return false;
		// `oldestLoadedSeq` and `hasPrev` are deliberately NOT recomputed. They
		// describe the upper bound of what has been FETCHED ("I hold seq >= this"),
		// not the oldest message currently held, and their only consumer is
		// loadPretextDocumentOlder's `beforeSeq` + overlap check. Deleting rows does
		// not make the server grow older history, so the bound has not moved.
		// Recomputing it from the survivors would push the bound forward after the
		// oldest loaded message is deleted, and the next upward page would then skip
		// the span in between — a silent hole in history. Keeping the old value costs
		// at most one overlapping page, which the loader already rejects.
		this.input = { ...this.input, messages: result.messages as TreeMessage[] };
		const view = getView?.();
		const anchor =
			view && this.current.index ? captureCoordinatorAnchor(this.current.index, view) : undefined;
		const generation = ++this.generation;
		this.commitLayout(
			this.input,
			this.lastBuildOptions,
			anchor,
			view?.viewportHeight ?? this.lastViewportHeight,
			generation,
		);
		return true;
	}

	/**
	 * Apply a `message_updated` event IN PLACE when it is a trailing-block
	 * truncation.
	 *
	 * This is the second half of a rollback: after deleting the messages below the
	 * target, the server drops the target's own blocks past the rollback point and
	 * broadcasts the rewritten message. Without this path those blocks stay on screen
	 * until a structural reload — deferred, again, exactly when the reader is
	 * scrolled up — so the rollback looked half-applied.
	 *
	 * Only a truncation is accepted, and `replaceLoadedMessage` owns that judgement:
	 * because `messageVersion` stays fixed, a surviving block keeping its
	 * `${msg.id}-b${bi}` key while its content changed would be served the height
	 * measured from the OLD content (CONTRACT.md §4.5 constraint 3). Truncation is
	 * the one shape where every surviving key still denotes the same block. Every
	 * other update keeps the reload, which replaces the window and its version
	 * together.
	 *
	 * Returns false when nothing was replaced, so the caller can decide to reload.
	 */
	replaceMessage(message: TreeMessage, getView?: () => PrependView): boolean {
		if (!this.input || !this.lastBuildOptions) return false;
		const result = replaceLoadedMessage(this.input.messages, message);
		if (!result.replaced) return false;
		this.input = { ...this.input, messages: result.messages as TreeMessage[] };
		const view = getView?.();
		const anchor =
			view && this.current.index ? captureCoordinatorAnchor(this.current.index, view) : undefined;
		const generation = ++this.generation;
		this.commitLayout(
			this.input,
			this.lastBuildOptions,
			anchor,
			view?.viewportHeight ?? this.lastViewportHeight,
			generation,
		);
		return true;
	}

	/**
	 * Publish (or clear) the LIVE STREAMING message as the document's last row.
	 *
	 * This is the replacement for the old streaming overlay. Because the row is part
	 * of the ordinary document there is a single scroll coordinate system, the
	 * committed rows above keep their cached measurements, and — crucially — there is
	 * no window in which live output is neither in the overlay nor in the document.
	 *
	 * Contract, mirroring applyLivePatch (see CONTRACT.md §4.5):
	 * - `messageVersion` and the PERSISTED message set are untouched, so every
	 *   committed row is served from the measure cache and only the streaming row
	 *   (plus, at a run boundary, the one card whose trailing divider flips) is
	 *   re-measured.
	 * - The rebuild MUST anchor: a streaming row grows continuously, and a reader who
	 *   has scrolled up may not be pushed around by it.
	 *
	 * Returns false when nothing changed (so callers can skip a needless commit).
	 */
	setStreamingMessage(message: TreeMessage | null, getView?: () => PrependView): boolean {
		const next = message ?? null;
		if (this.streamingMessage === next) return false;
		// Identity comparison is enough: the accumulator hands over a NEW object for
		// every render version, and clearing passes null.
		this.streamingMessage = next;
		// Nothing to lay out yet (initial load in flight). Recording the row is still
		// correct — the first commit will include it.
		if (!this.input || !this.lastBuildOptions) {
			this.current = { ...this.current, streamingMessage: next };
			this.emit();
			return true;
		}
		const view = getView?.();
		const anchor =
			view && this.current.index ? captureCoordinatorAnchor(this.current.index, view) : undefined;
		const generation = ++this.generation;
		this.commitLayout(
			this.input,
			this.lastBuildOptions,
			anchor,
			view?.viewportHeight ?? this.lastViewportHeight,
			generation,
		);
		return true;
	}

	cancel(): void {
		this.generation++;
		// Abandon any in-flight tail load so a later same-narrator load() does not
		// coalesce onto a superseded fetch.
		this.pendingLoad = null;
	}

	/**
	 * Abandon the loaded document (narrator switch / teardown), publishing it to
	 * the cross-switch document cache first so a return visit can restore it
	 * without a refetch (see `restore`).
	 *
	 * The PREPARED cache is deliberately NOT released here any more.
	 *
	 * It used to be, to stop a long SPA session accumulating the union of every
	 * document ever opened. But its keys are the body TEXT (plus the KaTeX/font
	 * generations) — they carry no narrator identity — so its entries are exactly
	 * as valid after a switch as before one, and it already bounds itself at 4M
	 * source chars with a bulk-clear. Dropping it on switch therefore bought no
	 * correctness and forced the returning document to re-parse every body
	 * (measured at 94% of a full measure), which is the single largest cost in
	 * repainting a first screen. `measureCache` was already left alone for the same
	 * reason: keyed by `documentRevision`, its stale entries are unreachable rather
	 * than wrong.
	 */
	reset(): void {
		this.publishDocumentSnapshot();
		this.generation++;
		this.pendingLoad = null;
		this.input = undefined;
		this.narratorId = undefined;
		this.loadingOlder = false;
		this.streamingMessage = null;
		this.current = { status: "idle" };
		this.emit();
	}

	/**
	 * Publish the loaded window to the cross-switch cache.
	 *
	 * Called on `reset` (the narrator switch / teardown path) and directly by the
	 * hook on unmount, because an unmount does not necessarily route through
	 * `reset`. Writing the same snapshot twice is harmless — the cache's
	 * `shouldReplace` gate keeps the wider/newer one.
	 */
	publishDocumentSnapshot(): void {
		if (!this.narratorId || !this.input) return;
		writeCachedPretextDocument({ narratorId: this.narratorId, input: this.input });
	}

	/**
	 * Adopt a cached document for `narratorId` and commit its layout synchronously.
	 *
	 * This is the fast path for revisiting a narrator: the tail page (283KB-1.3MB on
	 * long histories) is already in hand, so the first screen paints from a single
	 * measure pass that hits `measureCache` for every row whose `messageVersion` and
	 * geometry are unchanged. A `diff` reconcile against the server still has to
	 * confirm the window is current — that is the caller's job (it triggers a
	 * background reload), because a restore is an optimisation and never authority.
	 *
	 * Returns false when nothing was cached, so the caller falls back to `load`.
	 */
	restore(
		narratorId: string,
		buildOptions: PretextLayoutBuildOptions,
		loadOptions: PretextDocumentLoadOptions = {},
		viewportHeight = 0,
	): boolean {
		const cached = peekCachedPretextDocument(narratorId);
		if (!cached) return false;
		this.generation++;
		const generation = this.generation;
		this.pendingLoad = null;
		this.narratorId = narratorId;
		this.loadOptions = loadOptions;
		this.loadingOlder = false;
		this.streamingMessage = null;
		this.input = cached;
		try {
			// No anchor: a restore establishes the document rather than perturbing an
			// existing one, and the shell opens pinned to the bottom (see
			// PretextExactMessageList's `pinnedToBottom` initial state).
			this.commitLayout(cached, buildOptions, undefined, viewportHeight, generation);
			return true;
		} catch {
			// A restore must never be able to wedge the list: drop the suspect entry
			// and report failure so the caller performs a normal load. The error is
			// already recorded on the snapshot by commitLayout.
			invalidateCachedPretextDocument(narratorId);
			this.input = undefined;
			this.narratorId = undefined;
			this.current = { status: "idle" };
			this.emit();
			return false;
		}
	}

	/**
	 * Drop every cached measurement and prepared body, then rebuild at the last
	 * committed params.
	 *
	 * This is the FONT-GENERATION path (see the `documentRevision` note): the
	 * prepared handles carry pixel widths baked against the previous face, so they
	 * cannot be reused, and the heights derived from them are already on screen.
	 * The rebuild anchors so the reader is not moved by the corrected geometry.
	 *
	 * No-ops before the first commit — the first build will use the new generation
	 * anyway.
	 */
	invalidateFontDependentLayout(getView?: () => PrependView): boolean {
		resetPreparedMarkdownCache();
		measureCache.clear();
		if (!this.input || !this.lastBuildOptions) return false;
		const view = getView?.();
		const anchor =
			view && this.current.index ? captureCoordinatorAnchor(this.current.index, view) : undefined;
		const generation = ++this.generation;
		this.commitLayout(
			this.input,
			this.lastBuildOptions,
			anchor,
			view?.viewportHeight ?? this.lastViewportHeight,
			generation,
		);
		return true;
	}

	/**
	 * Messages to lay out: the persisted window plus the live streaming row.
	 *
	 * The streaming row is appended here rather than stored in `input.messages` so
	 * pagination and version checks only ever see persisted content.
	 */
	private layoutMessages(input: PretextDocumentInput): readonly TreeMessage[] {
		if (!this.streamingMessage) return input.messages;
		return [...input.messages, this.streamingMessage];
	}

	/**
	 * Cost (ms) of the last completed build, exposed on the snapshot so the shell can
	 * size its resize strategy from measurement rather than a guess.
	 */
	private lastBuildMs = 0;

	/** Build the exact layout for the loaded input (shared by every commit path). */
	private buildLayout(input: PretextDocumentInput, buildOptions: PretextLayoutBuildOptions) {
		const startedAt = now();
		const built = this.buildLayoutInner(input, buildOptions);
		this.lastBuildMs = now() - startedAt;
		return built;
	}

	private buildLayoutInner(input: PretextDocumentInput, buildOptions: PretextLayoutBuildOptions) {
		const messages = this.layoutMessages(input);
		return buildPretextDocumentLayout(messages as unknown as NarratorMsg[], {
			...buildOptions,
			pruneBoundaryMessageId: input.pruneBoundaryMessageId,
			// The loaded-message count keeps the revision distinct as the window
			// grows upward within one document version (prepended older pages).
			layoutRevision: `${input.messageVersion}:${input.messages.length}:${buildOptions.widthBucket}:${buildOptions.lod}:k${getKatexRevision()}:f${getFontRevision()}`,
			// The KaTeX revision belongs on the DOCUMENT revision, not just the layout
			// revision: `layoutRevision` only reaches the manifest identity, while the
			// measure cache keys on `documentRevision` + the data revision. Without it
			// here, heights (and prepared blocks) computed before the runtime arrived
			// are served from cache afterwards — a display formula measured as literal
			// text stays an `inline` block, so the row keeps the wrong height AND never
			// paints the formula at all.
			//
			// The FONT generation rides along for the same reason, one level broader:
			// every prepared fragment carries a baked pixel width measured against the
			// then-available face, so a face swap invalidates heights on math-free
			// documents too (see prepared-markdown-cache's FONT REVISION note).
			documentRevision: `${input.messageVersion}~k:${getKatexRevision()}~f:${getFontRevision()}`,
		});
	}

	/**
	 * Load KaTeX before measuring, when the fetched messages contain math.
	 *
	 * The prepared/measure layers are synchronous, so this async boundary is the
	 * only place the 584KB KaTeX bundle can be awaited. Documents without math
	 * skip it entirely. A failed load is non-fatal: formulas fall back to their
	 * source text rather than blocking the whole document.
	 */
	private async prepareKatex(input: PretextDocumentInput): Promise<void> {
		const texts: string[] = [];
		for (const message of input.messages) {
			if (message.contentText) texts.push(message.contentText);
		}
		if (texts.length === 0) return;
		try {
			await ensureKatexLoaded(texts);
		} catch {
			// Rendering degrades to source text; never block the document.
		}
	}

	private commitLayout(
		input: PretextDocumentInput,
		buildOptions: PretextLayoutBuildOptions,
		anchor: PretextLayoutAnchor | undefined,
		viewportHeight: number,
		generation: number,
	): PretextLayoutCoordinatorSnapshot {
		if (generation !== this.generation) return this.current;
		try {
			this.lastBuildOptions = buildOptions;
			this.lastViewportHeight = viewportHeight;
			const built = this.buildLayout(input, buildOptions);
			if (generation !== this.generation) return this.current;
			const previous = this.current.index;
			let scrollTop: number | undefined;
			if (previous && anchor) {
				scrollTop = restorePretextLayoutAnchor(anchor, built.index, viewportHeight);
			}
			this.current = {
				status: "ready",
				input,
				streamingMessage: this.streamingMessage,
				manifest: built.manifest,
				index: built.index,
				items: built.items,
				hasPrev: input.hasPrev,
				loadingOlder: this.loadingOlder,
				lastBuildMs: this.lastBuildMs,
				// A successful commit clears any retained diagnostic error. loadOlder
				// deliberately stays "ready" after a failed upward page and keeps its
				// error for diagnostics; without clearing it here that error would ride
				// along on every later healthy snapshot forever.
				error: undefined,
				...(scrollTop == null ? {} : { scrollTop, scrollTopAnchorKind: anchor?.kind ?? "item" }),
			};
			this.emit();
			return this.current;
		} catch (error) {
			this.current = {
				...this.current,
				status: "error",
				error: error instanceof Error ? error : new Error(String(error)),
			};
			this.emit();
			throw error;
		}
	}

	/**
	 * Commit a layout after prepending older messages, preserving the visible
	 * content by height arithmetic rather than an item-key anchor. The prepended
	 * page only adds height above the previous first item, so shifting scrollTop by
	 * the exact totalHeight delta keeps every on-screen row in place. Emits a
	 * "bottom" correction when the caller was pinned so first-screen fill re-snaps.
	 */
	private commitPrependLayout(
		input: PretextDocumentInput,
		buildOptions: PretextLayoutBuildOptions,
		view: PrependView,
		previousTotalHeight: number,
		generation: number,
	): PretextLayoutCoordinatorSnapshot {
		if (generation !== this.generation) return this.current;
		try {
			this.lastBuildOptions = buildOptions;
			const built = this.buildLayout(input, buildOptions);
			if (generation !== this.generation) return this.current;
			let scrollTop: number;
			let scrollTopAnchorKind: PretextLayoutAnchor["kind"];
			if (view.pinnedToBottom) {
				// First-screen fill: keep the newest content pinned to the bottom.
				scrollTop = Math.max(0, built.index.totalHeight - Math.max(0, view.viewportHeight));
				scrollTopAnchorKind = "bottom";
			} else {
				// The whole existing document moved down by the height added above it.
				const heightDelta = built.index.totalHeight - previousTotalHeight;
				scrollTop = Math.max(0, view.scrollTop + heightDelta);
				scrollTopAnchorKind = "item";
			}
			this.current = {
				status: "ready",
				input,
				streamingMessage: this.streamingMessage,
				manifest: built.manifest,
				index: built.index,
				items: built.items,
				hasPrev: input.hasPrev,
				loadingOlder: this.loadingOlder,
				lastBuildMs: this.lastBuildMs,
				// Same contract as commitLayout: a successful page clears the retained
				// error of an earlier failed one.
				error: undefined,
				scrollTop,
				scrollTopAnchorKind,
			};
			this.emit();
			return this.current;
		} catch (error) {
			this.current = {
				...this.current,
				status: "error",
				error: error instanceof Error ? error : new Error(String(error)),
			};
			this.emit();
			throw error;
		}
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

/**
 * Whether a compact block already shows exactly this progress.
 *
 * A block loaded from the server carries no progress fields at all, and an older
 * server sends no `phase` — both normalize to `output` with a 0 thinking count,
 * the same rule `coerceProgressSnapshot` applies. Without that normalization a
 * duplicate output-phase tick would look like a change and force a pointless
 * rebuild on every event.
 */
function sameCompactProgress(block: unknown, progress: ProgressSnapshot): boolean {
	const fields = (block ?? {}) as {
		outputChars?: unknown;
		thinkingChars?: unknown;
		progressPhase?: unknown;
	};
	const phase = fields.progressPhase === "thinking" ? "thinking" : "output";
	const thinkingChars = typeof fields.thinkingChars === "number" ? fields.thinkingChars : 0;
	return (
		fields.outputChars === progress.outputChars &&
		thinkingChars === progress.thinkingChars &&
		phase === progress.phase
	);
}

/**
 * Immutably patch the two-phase progress of the running compact block on the
 * message with `messageId` (searching the top level and any child trees). Only
 * rewrites a block whose `type` matches `expectedType` and whose `status` is
 * still `compacting`, and only when a label-affecting field actually changes —
 * so a duplicate or late tick is a cheap no-op. Mirrors the chunk path's
 * `updateCompactProgressInMessages` but scoped to the vlist coordinator.
 */
function patchCompactProgress(
	messages: readonly TreeMessage[],
	messageId: string,
	progress: ProgressSnapshot,
	expectedType: "compact" | "segment_compact",
): { messages: TreeMessage[]; changed: boolean } {
	let changed = false;
	const next = messages.map((message) => {
		if (message.id === messageId) {
			const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
			let blockChanged = false;
			const contentJson = blocks.map((block) => {
				if (block.type !== expectedType || block.status !== "compacting") return block;
				if (sameCompactProgress(block, progress)) return block;
				blockChanged = true;
				return {
					...block,
					outputChars: progress.outputChars,
					thinkingChars: progress.thinkingChars,
					progressPhase: progress.phase,
				};
			});
			if (!blockChanged) return message;
			changed = true;
			return { ...message, contentJson };
		}
		if (!message.children?.length) return message;
		const childResult = patchCompactProgress(message.children, messageId, progress, expectedType);
		if (!childResult.changed) return message;
		changed = true;
		return { ...message, children: childResult.messages };
	});
	return changed ? { messages: next, changed: true } : { messages: [...messages], changed: false };
}
