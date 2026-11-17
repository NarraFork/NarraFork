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
 * loaded) is not asked for again; the row shows what is loaded.
 *
 * One loader per client, for every view of it (outline views and the mind map of every editing
 * surface showing the client's page): each tells it the trees it folds ({@link LoaderSource}).
 * It runs after their projections, at most once per task, and sends a change only when what
 * they need differs from what is watched (the client puts close changes into one frame).
 */
import type { FoldTree } from "@shared/outline-fold";
import { type LiveWatchWire, liveWatchKey } from "@shared/outline-live-protocol";
import type { LiveClient } from "./live-client";

/** Something that shows a client's blocks folded: the trees it folds now. */
export interface LoaderSource {
	foldTrees(): Array<FoldTree | null | undefined>;
}

export class LevelLoader {
	private readonly sources = new Set<LoaderSource>();
	private queued = false;
	private disposed = false;
	/** Runs that changed the watch set (tests). */
	runs = 0;

	constructor(private readonly client: LiveClient) {}

	/** A source of trees; returns its removal. */
	add(source: LoaderSource): () => void {
		this.sources.add(source);
		this.schedule();
		return () => {
			this.sources.delete(source);
		};
	}

	dispose(): void {
		this.disposed = true;
		this.sources.clear();
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

	/** What the views need watched, by key. */
	wanted(): Map<string, LiveWatchWire> | null {
		const c = this.client;
		const trees: FoldTree[] = [];
		for (const s of this.sources) for (const t of s.foldTrees()) if (t) trees.push(t);
		if (trees.length === 0) return null;
		const want = new Map<string, LiveWatchWire>();
		const v = c.visible;
		const refused = (key: string) => c.watchRefused.has(key);
		const visit = (tree: FoldTree, id: string): void => {
			const s: LiveWatchWire = { s: id };
			const ks = liveWatchKey(s);
			const l: LiveWatchWire = { l: id };
			const kl = liveWatchKey(l);
			const whole = c.watching(ks);
			if (whole === "set") {
				want.set(ks, s);
				return;
			}
			// Inside a subtree watched whole: everything under it is here.
			if (v.underRoot(id)) return;
			if (!refused(ks)) {
				want.set(ks, s);
				// Its level stays while the whole of it is on its way.
				if (c.watching(kl) === "set") want.set(kl, l);
				return;
			}
			// Too large to watch whole: its level, and what it shows opened.
			if (!refused(kl) || c.watching(kl) === "set") want.set(kl, l);
			const node = tree.nodes.get(id);
			if (!node?.open) return;
			for (const k of node.kids) visit(tree, k);
		};
		for (const tree of trees) {
			const root = tree.rootId;
			const covered = c.watching(liveWatchKey({ s: root })) === "set" || v.underRoot(root);
			if (!covered) {
				// A level does not show its parent: the root comes with its own parent's level.
				const anchor: LiveWatchWire = { l: v.get(root)?.parentId ?? null };
				want.set(liveWatchKey(anchor), anchor);
			}
			visit(tree, root);
		}
		return want;
	}

	/** Ask for what is needed and let go of what is not. */
	run(): void {
		const c = this.client;
		if (this.disposed || !c.ready || c.status !== "live") return;
		const want = this.wanted();
		if (!want) return;
		const add: LiveWatchWire[] = [];
		for (const [key, w] of want)
			if (c.watching(key) === null && !c.watchRefused.has(key)) add.push(w);
		const remove: LiveWatchWire[] = [];
		for (const w of c.watchSet) if (!want.has(liveWatchKey(w))) remove.push(w);
		if (add.length === 0 && remove.length === 0) return;
		this.runs++;
		c.watch({ add, remove });
	}
}

const loaders = new WeakMap<LiveClient, LevelLoader>();

/** The client's loader (made on first use; the client's own `watch` listener runs it again). */
export function levelLoaderOf(client: LiveClient): LevelLoader {
	let loader = loaders.get(client);
	if (!loader) {
		const made = new LevelLoader(client);
		loader = made;
		loaders.set(client, made);
		client.on((event) => {
			if (event === "watch" || event === "status" || event === "sync") made.schedule();
		});
	}
	return loader;
}
