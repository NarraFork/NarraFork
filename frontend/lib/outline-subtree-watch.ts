/**
 * Watches of whole subtrees shared across a tab (pageless outline, A2): cards that keep fresh
 * what they show of some blocks (a plan's diff, the questions under a block) do not open a wire
 * subscription each. One block watch (`outline-block-watch.ts`) per space carries the union of
 * the blocks every caller in that space asks for; callers come and go by reference, and the last
 * one to leave a space closes its watch. Each subscription takes one of the socket's 16 places and
 * one of the person's 24 in the space: N cards in one space take one.
 *
 * A caller is told (`listener(seq)`): when a commit changes one of ITS blocks or anything under
 * it (or the frame says everything changed); when the watch is confirmed past what was seen (a
 * new set, a reconnect: anything may have changed meanwhile); `listener(null)` when changes
 * waiting for confirmation changed, or the watch is denied (the caller re-reads: a block it may
 * no longer read answers not found). A watch the server has no room for retries with the block
 * watch's own backoff; once that paused, it is tried again every {@link RESUME_MS} and, when it
 * comes back, every caller of the space re-reads.
 */
import type { OutlineWatchHandle, OutlineWatchHandlers } from "./outline-block-watch";

/** How long after the block watch paused (no room) a space's watch is asked for again. */
export const RESUME_MS = 60_000;

export type OutlineSubtreeListener = (seq: number | null) => void;

interface Caller {
	ids: ReadonlySet<string>;
	listener: OutlineSubtreeListener;
}

interface SpaceWatch {
	handle: OutlineWatchHandle;
	callers: Map<number, Caller>;
	/** The newest seq heard: older frames are not news. */
	seen: number;
	resume: ReturnType<typeof setTimeout> | null;
}

export class OutlineSubtreeWatches {
	private spaces = new Map<string, SpaceWatch>();
	private next = 0;

	constructor(
		private readonly open: (spaceId: string, handlers: OutlineWatchHandlers) => OutlineWatchHandle,
		private readonly resumeMs = RESUME_MS,
	) {}

	/** Spaces with an open watch (one wire subscription each). */
	get size(): number {
		return this.spaces.size;
	}

	/** Watch the subtrees of `blockIds` of `spaceId` until the returned function is called. */
	watch(spaceId: string, blockIds: Iterable<string>, listener: OutlineSubtreeListener): () => void {
		const ids = new Set(blockIds);
		if (!spaceId || ids.size === 0) return () => {};
		const token = ++this.next;
		const space = this.spaces.get(spaceId) ?? this.start(spaceId);
		space.callers.set(token, { ids, listener });
		this.send(space);
		return () => {
			if (!space.callers.delete(token)) return;
			if (space.callers.size > 0) {
				this.send(space);
				return;
			}
			if (space.resume !== null) clearTimeout(space.resume);
			space.handle.dispose();
			if (this.spaces.get(spaceId) === space) this.spaces.delete(spaceId);
		};
	}

	private start(spaceId: string): SpaceWatch {
		const notify = (seq: number | null, only?: ReadonlySet<string>) => {
			for (const caller of [...space.callers.values()]) {
				if (only && ![...caller.ids].some((id) => only.has(id))) continue;
				caller.listener(seq);
			}
		};
		const space: SpaceWatch = {
			callers: new Map(),
			seen: -1,
			resume: null,
			handle: this.open(spaceId, {
				onWatching: (seq) => {
					if (space.resume !== null) {
						clearTimeout(space.resume);
						space.resume = null;
					}
					if (seq <= space.seen) return;
					space.seen = seq;
					notify(seq);
				},
				onChanged: (frame) => {
					if (frame.seq <= space.seen && !frame.all) return;
					space.seen = Math.max(space.seen, frame.seq);
					notify(frame.seq, frame.all ? undefined : new Set(frame.subtrees));
				},
				onPending: () => notify(null),
				onError: (code) => {
					if (code === "access_denied") notify(null);
				},
				onPaused: () => {
					// No room after every automatic retry: ask again later; when the watch is
					// confirmed again, `onWatching` has every caller re-read.
					if (space.resume !== null) clearTimeout(space.resume);
					space.seen = -1;
					space.resume = setTimeout(() => {
						space.resume = null;
						space.handle.retry();
					}, this.resumeMs);
				},
			}),
		};
		this.spaces.set(spaceId, space);
		return space;
	}

	private send(space: SpaceWatch): void {
		const union = new Set<string>();
		for (const caller of space.callers.values()) for (const id of caller.ids) union.add(id);
		space.handle.set([], union);
	}
}
