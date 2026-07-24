import {
	type PretextLayoutAnchor,
	type PretextLayoutIndex,
	type PretextLayoutManifest,
	restorePretextLayoutAnchor,
} from "@shared/pretext-layout";
import type { NarratorMsg } from "../narrator-panel-types";
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

	/** Build the exact layout for the loaded input (shared by every commit path). */
	private buildLayout(input: PretextDocumentInput, buildOptions: PretextLayoutBuildOptions) {
		return buildPretextDocumentLayout(input.messages as unknown as NarratorMsg[], {
			...buildOptions,
			pruneBoundaryMessageId: input.pruneBoundaryMessageId,
			// The loaded-message count keeps the revision distinct as the window
			// grows upward within one document version (prepended older pages).
			layoutRevision: `${input.messageVersion}:${input.messages.length}:${buildOptions.widthBucket}:${buildOptions.lod}`,
			documentRevision: input.messageVersion,
		});
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
