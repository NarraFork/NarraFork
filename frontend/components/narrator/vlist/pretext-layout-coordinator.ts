import type { TreeMessage } from "@frontend/lib/api/types";
import {
	type PretextLayoutAnchor,
	type PretextLayoutIndex,
	type PretextLayoutManifest,
	restorePretextLayoutAnchor,
} from "@shared/pretext-layout";
import type { NarratorMsg } from "../narrator-panel-types";
import { ensureKatexLoaded, getKatexRevision } from "./katex-runtime";
import type { RenderLod } from "./prepared-block";
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
import { PretextToolDetailPrefetchStore } from "./pretext-tool-detail-prefetch";
import { collectAutoExpandedTruncatedToolUses } from "./vlist-auto-expanded-details";
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
	manifest?: PretextLayoutManifest;
	index?: PretextLayoutIndex;
	items?: readonly VListItem[];
	scrollTop?: number;
	scrollTopAnchorKind?: PretextLayoutAnchor["kind"];
	/** More (older) messages exist above the loaded window. */
	hasPrev?: boolean;
	/** An older-page fetch is in flight (drives the load indicator). */
	loadingOlder?: boolean;
	error?: Error;
}

export interface PretextLayoutBuildOptions
	extends Omit<
		BuildPretextDocumentLayoutOptions,
		"layoutRevision" | "documentRevision" | "lod" | "pruneBoundaryMessageId"
	> {
	lod: RenderLod;
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
	 * Last committed build options + viewport, retained so an out-of-band mutation
	 * (e.g. a compact_progress tick that patches an already-loaded message in place)
	 * can rebuild the layout without the shell re-plumbing the current build params.
	 */
	private lastBuildOptions: PretextLayoutBuildOptions | undefined;
	private lastViewportHeight = 0;
	/**
	 * Full payloads for cards that expand WITHOUT user input. Resolved on the async
	 * boundary below (beside KaTeX) so the first build already measures the real
	 * body — an auto-expanded card must never grow after paint. Cards the user
	 * expands later keep the on-demand path in the shell.
	 */
	private readonly toolDetails = new PretextToolDetailPrefetchStore();
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
				// prepareKatex); no-ops for documents without formulas. Auto-expanded
				// cards need their full body for the same reason — both must land BEFORE
				// the build or the first painted height is not the final one.
				await Promise.all([
					this.prepareKatex(input),
					this.prepareToolDetails(narratorId, input, entry.buildOptions),
				]);
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
		if (this.loadingOlder) return 0;
		this.loadingOlder = true;
		const generation = this.generation;
		const previousTotalHeight = this.current.index?.totalHeight ?? 0;
		this.current = { ...this.current, loadingOlder: true };
		this.emit();
		try {
			const next = await loadPretextDocumentOlder(this.narratorId, previous, this.loadOptions);
			if (generation !== this.generation) return 0;
			// An older page may introduce the document's first formula, and its own
			// auto-expanded truncated cards. Both are resolved before the prepend
			// commits so the newly prepended rows are never re-measured taller.
			await Promise.all([
				this.prepareKatex(next),
				this.prepareToolDetails(this.narratorId, next, buildOptions),
			]);
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
			// A version/prune drift means the loaded snapshot is stale. Surface the
			// error so the shell reloads the tail from scratch.
			this.current = {
				...this.current,
				status: "error",
				error: error instanceof Error ? error : new Error(String(error)),
			};
			this.emit();
			throw error;
		} finally {
			this.loadingOlder = false;
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
	 * compact block's `outputChars` in the already-loaded input in place and
	 * rebuild. The compact indicator's height is constant, so this only re-composes
	 * its one-line label (the adapter folds `outputChars` into the measure cache
	 * key so the new text is not served stale). No-ops when the target message is
	 * not loaded, its count is unchanged, or no prior build options exist yet.
	 */
	applyCompactProgress(messageId: string, outputChars: number, isSegment: boolean): void {
		if (!this.input || !this.lastBuildOptions) return;
		const expectedType = isSegment ? "segment_compact" : "compact";
		const patched = patchCompactOutputChars(
			this.input.messages,
			messageId,
			outputChars,
			expectedType,
		);
		if (!patched.changed) return;
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

	cancel(): void {
		this.generation++;
		// Abandon any in-flight tail load so a later same-narrator load() does not
		// coalesce onto a superseded fetch.
		this.pendingLoad = null;
	}

	reset(): void {
		this.generation++;
		this.pendingLoad = null;
		this.input = undefined;
		this.narratorId = undefined;
		this.loadingOlder = false;
		this.current = { status: "idle" };
		this.emit();
	}

	/**
	 * Prefer the shell's on-demand resolver (a payload the USER's expansion fetched)
	 * and fall back to the prefetched store. Both return `undefined` for an unknown
	 * id, so the adapter keeps the truncated preview in that case.
	 */
	private chainToolInput(
		shellResolver: PretextLayoutBuildOptions["resolveFullToolInput"],
	): (toolUseId: string | undefined) => unknown {
		return (toolUseId) =>
			shellResolver?.(toolUseId) ?? this.toolDetails.resolveFullToolInput(toolUseId);
	}

	private chainToolOutput(
		shellResolver: PretextLayoutBuildOptions["resolveFullToolOutput"],
	): (toolUseId: string | undefined) => unknown {
		return (toolUseId) =>
			shellResolver?.(toolUseId) ?? this.toolDetails.resolveFullToolOutput(toolUseId);
	}

	/** Build the exact layout for the loaded input (shared by every commit path). */
	private buildLayout(input: PretextDocumentInput, buildOptions: PretextLayoutBuildOptions) {
		return buildPretextDocumentLayout(input.messages as unknown as NarratorMsg[], {
			...buildOptions,
			// Prefetched bodies for auto-expanded cards. Chained BEHIND the shell's
			// own on-demand resolvers so a payload the user's click fetched still wins;
			// the prefetch only fills what the shell has not resolved itself.
			resolveFullToolInput: this.chainToolInput(buildOptions.resolveFullToolInput),
			resolveFullToolOutput: this.chainToolOutput(buildOptions.resolveFullToolOutput),
			pruneBoundaryMessageId: input.pruneBoundaryMessageId,
			// The loaded-message count keeps the revision distinct as the window
			// grows upward within one document version (prepended older pages).
			layoutRevision: `${input.messageVersion}:${input.messages.length}:${buildOptions.widthBucket}:${buildOptions.lod}:k${getKatexRevision()}`,
			// The KaTeX revision belongs on the DOCUMENT revision, not just the layout
			// revision: `layoutRevision` only reaches the manifest identity, while the
			// measure cache keys on `documentRevision` + the data revision. Without it
			// here, heights (and prepared blocks) computed before the runtime arrived
			// are served from cache afterwards — a display formula measured as literal
			// text stays an `inline` block, so the row keeps the wrong height AND never
			// paints the formula at all.
			documentRevision: `${input.messageVersion}~k:${getKatexRevision()}`,
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

	/**
	 * Fetch the full payloads of every card that will be expanded WITHOUT the user
	 * acting, before the layout is built.
	 *
	 * This is the whole point of doing it here: `computeDefaultOpen` opens file /
	 * plan / tasks / knowledge / … cards and everything at LOD 6, so those rows used
	 * to be measured from a 2000-char preview and then re-measured taller once the
	 * async detail landed — a height change with no user action behind it. Resolving
	 * the bodies on this boundary makes the first arithmetic the final arithmetic.
	 *
	 * Bounded and failure-tolerant: at most AUTO_EXPANDED_DETAIL_LIMIT ids per build,
	 * six requests in flight, and a failed fetch just keeps the preview.
	 */
	private async prepareToolDetails(
		narratorId: string,
		input: PretextDocumentInput,
		buildOptions: PretextLayoutBuildOptions,
	): Promise<void> {
		const ids = collectAutoExpandedTruncatedToolUses({
			messages: input.messages as unknown as NarratorMsg[],
			lod: buildOptions.lod,
			resolveToolCategory: buildOptions.resolveToolCategory,
		});
		if (ids.length === 0) return;
		try {
			await this.toolDetails.prefetch(narratorId, ids);
		} catch {
			// Never block the document on a detail fetch.
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
				manifest: built.manifest,
				index: built.index,
				items: built.items,
				hasPrev: input.hasPrev,
				loadingOlder: this.loadingOlder,
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
				manifest: built.manifest,
				index: built.index,
				items: built.items,
				hasPrev: input.hasPrev,
				loadingOlder: this.loadingOlder,
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
 * Immutably patch the `outputChars` of the running compact block on the message
 * with `messageId` (searching the top level and any child trees). Only rewrites
 * a block whose `type` matches `expectedType` and whose `status` is still
 * `compacting`, and only when the value actually changes — so a duplicate or
 * late tick is a cheap no-op. Mirrors the chunk path's
 * `updateCompactProgressInMessages` but scoped to the vlist coordinator.
 */
function patchCompactOutputChars(
	messages: readonly TreeMessage[],
	messageId: string,
	outputChars: number,
	expectedType: "compact" | "segment_compact",
): { messages: TreeMessage[]; changed: boolean } {
	let changed = false;
	const next = messages.map((message) => {
		if (message.id === messageId) {
			const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
			let blockChanged = false;
			const contentJson = blocks.map((block) => {
				if (block.type !== expectedType || block.status !== "compacting") return block;
				if (block.outputChars === outputChars) return block;
				blockChanged = true;
				return { ...block, outputChars };
			});
			if (!blockChanged) return message;
			changed = true;
			return { ...message, contentJson };
		}
		if (!message.children?.length) return message;
		const childResult = patchCompactOutputChars(
			message.children,
			messageId,
			outputChars,
			expectedType,
		);
		if (!childResult.changed) return message;
		changed = true;
		return { ...message, children: childResult.messages };
	});
	return changed ? { messages: next, changed: true } : { messages: [...messages], changed: false };
}
