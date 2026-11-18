/**
 * What a live client watches, from what its views show (pageless plan, L4: only expanded blocks
 * are loaded and in the editor).
 *
 * A block whose whole subtree fits one watch (`OUTLINE_LIVE_LIMITS.maxWatchBlocks`) is watched
 * whole (`{ s }`): its folding is then exact (previews, counts, an unanswered question holding
 * the blocks above it open), and opening or closing inside it changes nothing loaded. The client
 * starts that way with its root. Where a subtree does not fit (the server answers `too_large`),
 * it is loaded by levels as the reader opens it:
 *
 *   - the block's level (`{ l }`: its direct children) is watched, which is what its row shows
 *     closed (the preview line, the counts: worked out from that level);
 *   - opened, each child it shows is watched in turn the same way (whole, or by levels);
 *   - closed again, what its children brought is let go (unwatched), its level stays.
 *
 * While a block's whole subtree is on its way, its level stays (no row goes blank meanwhile).
 * A watch refused for another reason (the person's share, the space full: budgets count what is
 * loaded) is not asked for instead by its level, and is asked for again only once the block was
 * closed and shown again, or watches were let go (there may be room then); the watch set never
 * grows past the participant's budget (`OUTLINE_LIVE_LIMITS.watchBudget`, which the server
 * enforces too: `watch_cap`). Such blocks are listed
 * in `notLoaded` (the editor says part of the outline is not loaded), and their rows take typing
 * but no delete or join (`view.ts` refuses deleting a block whose children are not loaded).
 *
 * One loader per client, for every view of it (outline views and the mind map of every editing
 * surface showing the client's page): each tells it the trees it folds ({@link LoaderSource}).
 * It runs after their projections, at most once per task, and sends a change only when what
 * they need differs from what is watched (the client puts close changes into one frame).
 */
import type { FoldTree } from "@shared/outline-fold";
import {
	type LiveCloseCode,
	type LiveWatchWire,
	liveWatchKey,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import type { LiveClient } from "./live-client";

/** Something that shows a client's blocks folded: the trees it folds now. */
export interface LoaderSource {
	foldTrees(): Array<FoldTree | null | undefined>;
}

/**
 * Why a shown block's children are not loaded (its rows can be typed in, not deleted or
 * joined): a refusal's code, or `watch_cap` (the watch set is full,
 * `OUTLINE_LIVE_LIMITS.watchBudget`).
 */
export type NotLoaded = LiveCloseCode | "watch_cap";

/** Refusals for room: asked for again once there may be room (see `run`). */
const RETRIED: ReadonlySet<string> = new Set([
	"user_limit",
	"space_full",
	"unavailable",
	"watch_cap",
]);

/** New watches asked for at once (the rest follow as the answers come). */
export const LOADER_BATCH = 64;

export class LevelLoader {
	private readonly sources = new Set<LoaderSource>();
	private readonly listeners = new Set<() => void>();
	private queued = false;
	private disposed = false;
	/** Runs that changed the watch set (tests). */
	runs = 0;
	/** Shown blocks whose children could not be loaded, and why (after the last run). */
	notLoaded: ReadonlyMap<string, NotLoaded> = new Map();
	/** Removes the client listener (`levelLoaderOf`). */
	off: (() => void) | null = null;

	constructor(private readonly client: LiveClient) {}

	/** A source of trees; returns its removal. */
	add(source: LoaderSource): () => void {
		this.sources.add(source);
		this.schedule();
		return () => {
			this.sources.delete(source);
		};
	}

	/** Told when {@link notLoaded} changes; returns the removal. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	dispose(): void {
		this.disposed = true;
		this.sources.clear();
		this.listeners.clear();
		this.off?.();
		this.off = null;
	}

	/** Run after the current task (projections of several views coalesce). */
	schedule(): void {
		if (this.queued || this.disposed) return;
		this.queued = true;
		queueMicrotask(() => {
			this.queued = false;
			this.run();
		});
	}

	/** What the views need watched, by key (and what cannot be loaded: `notLoaded`). */
	wanted(notLoaded = new Map<string, NotLoaded>()): Map<string, LiveWatchWire> | null {
		const c = this.client;
		const trees: FoldTree[] = [];
		for (const s of this.sources) for (const t of s.foldTrees()) if (t) trees.push(t);
		if (trees.length === 0) return null;
		const want = new Map<string, LiveWatchWire>();
		const v = c.visible;
		/** The block a new watch is for (what is not loaded when there is no room for it). */
		const owner = new Map<string, string>();
		const refusedSeen = new Set<string>();
		const take = (w: LiveWatchWire, id: string): void => {
			const key = liveWatchKey(w);
			if (want.has(key)) return;
			want.set(key, w);
			owner.set(key, id);
		};
		/** The subtree watched whole a block is in (itself or an ancestor), kept wanted. */
		const covering = (id: string): boolean => {
			let cur: string | null = id;
			for (let guard = 0; cur && guard < 10_000; guard++) {
				const w: LiveWatchWire = { s: cur };
				if (c.watching(liveWatchKey(w)) === "set") {
					want.set(liveWatchKey(w), w);
					return true;
				}
				cur = v.get(cur)?.parentId ?? null;
			}
			return false;
		};
		/** A root's own block: its subtree watched whole, or its parent's level and its own. */
		const base = (root: string): void => {
			if (covering(root)) return;
			const anchor: LiveWatchWire = { l: v.get(root)?.parentId ?? null };
			want.set(liveWatchKey(anchor), anchor);
		};
		const visit = (tree: FoldTree, id: string): void => {
			const s: LiveWatchWire = { s: id };
			const ks = liveWatchKey(s);
			const l: LiveWatchWire = { l: id };
			const kl = liveWatchKey(l);
			// Inside a subtree watched whole (its own or an ancestor's): everything under it is here.
			if (covering(id)) return;
			const levelSet = c.watching(kl) === "set";
			const whole = c.watchRefused.get(ks);
			if (whole !== undefined) refusedSeen.add(ks);
			if (whole === undefined) {
				take(s, id);
				// Its level stays while the whole of it is on its way.
				if (levelSet) want.set(kl, l);
				return;
			}
			if (whole !== "too_large" && whole !== "user_limit" && whole !== "space_full") {
				// Refused by the server's limits (`unavailable`, the budget): not asked for again
				// until there may be room (`run`), and not by its level instead (it would be
				// refused the same way). What it has loaded stays.
				notLoaded.set(id, whole);
				if (levelSet) want.set(kl, l);
				return;
			}
			// Too large to watch whole, or more than the person's share or the space has room
			// for: its level (far smaller), and what it shows opened; if that is refused too,
			// it is listed.
			const level = c.watchRefused.get(kl);
			if (level !== undefined) refusedSeen.add(kl);
			if (level !== undefined && !levelSet) {
				notLoaded.set(id, level);
				return;
			}
			take(l, id);
			const node = tree.nodes.get(id);
			if (!node?.open) return;
			for (const k of node.kids) visit(tree, k);
		};
		// The client's own root is always kept (its session is the page's), whatever is shown.
		base(c.pageId);
		if (!covering(c.pageId) && c.watchRefused.get(liveWatchKey({ s: c.pageId })) === "too_large") {
			const own: LiveWatchWire = { l: c.pageId };
			want.set(liveWatchKey(own), own);
		}
		for (const tree of trees) {
			// A level does not show its parent: a root comes with its own parent's level.
			base(tree.rootId);
			visit(tree, tree.rootId);
		}
		// The participant's budget (`OUTLINE_LIVE_LIMITS.watchBudget`, the server's too): what is
		// held or asked for and still wanted counts first; new watches take what room is left,
		// in the order the views show them (the roots' own first).
		let room = OUTLINE_LIVE_LIMITS.watchBudget;
		for (const key of want.keys()) if (c.watching(key) !== null) room--;
		for (const key of [...want.keys()]) {
			if (c.watching(key) !== null) continue;
			if (room > 0) {
				room--;
				continue;
			}
			want.delete(key);
			const id = owner.get(key);
			if (id !== undefined) notLoaded.set(id, "watch_cap");
		}
		this.refusedSeen = refusedSeen;
		return want;
	}

	/** Refusals the last {@link wanted} came across (still needed). */
	private refusedSeen = new Set<string>();

	/** Ask for what is needed and let go of what is not. */
	run(): void {
		const c = this.client;
		if (this.disposed || !c.ready || c.status !== "live") return;
		const notLoaded = new Map<string, NotLoaded>();
		const want = this.wanted(notLoaded);
		if (!want) return;
		if (!sameMap(notLoaded, this.notLoaded)) {
			this.notLoaded = notLoaded;
			for (const l of this.listeners) l();
		}
		const add: LiveWatchWire[] = [];
		let asked = 0;
		for (const [key, w] of want) {
			const at = c.watching(key);
			if (at === "asked") asked++;
			else if (at === null && !c.watchRefused.has(key)) add.push(w);
		}
		// A few at a time: each answer runs this again (a frame of hundreds of loads holds the
		// space's lane and its other people meanwhile).
		add.splice(Math.max(0, LOADER_BATCH - asked));
		const remove: LiveWatchWire[] = [];
		for (const w of c.watchSet) if (!want.has(liveWatchKey(w))) remove.push(w);
		// A refusal for room (the person's share, a full space, the budget, the server's limits)
		// is forgotten once the block is closed or gone, or when watches are let go: asked again
		// when it is shown again, or at the next run (there may be room now).
		for (const [key, code] of [...c.watchRefused])
			if (RETRIED.has(code) && (remove.length > 0 || !this.refusedSeen.has(key)))
				c.watchRefused.delete(key);
		if (add.length === 0 && remove.length === 0) return;
		this.runs++;
		c.watch({ add, remove });
	}
}

function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, x] of a) if (b.get(k) !== x) return false;
	return true;
}

const loaders = new WeakMap<LiveClient, LevelLoader>();

/** The client's loader (made on first use; the client's own `watch` listener runs it again). */
export function levelLoaderOf(client: LiveClient): LevelLoader {
	let loader = loaders.get(client);
	if (!loader) {
		const made = new LevelLoader(client);
		loader = made;
		loaders.set(client, made);
		made.off = client.on((event) => {
			if (event === "watch" || event === "status" || event === "sync") made.schedule();
		});
	}
	return loader;
}
