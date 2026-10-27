/**
 * Where a write made outside a page's live session meets the session.
 *
 * While a page is being edited live, its text lives in the session (a Yjs document) and reaches
 * the blocks table a few seconds later. A write from anywhere else (an agent's `OutlineEdit`, a
 * revert, any future HTTP write) must not plan against stale content, and must not be lost when
 * the session writes next. So such a write runs behind the session's barrier:
 *
 *   1. the session's lane for the space is taken: no live edit of the space is applied meanwhile;
 *   2. every live session of the space writes its unflushed edits as commits first, so the
 *      write's version checks (`baseVersionSeq`, the agent read ledger, a revert's "changed
 *      later") see them: a block someone typed into since the agent read it is a conflict;
 *   3. the write runs;
 *   4. its commits are pushed into the sessions as remote changes, then the lane is released.
 *
 * This module is only the indirection, so the write path need not import the live sessions
 * (which import the write path). `services/outline/live/registry.ts` installs the barrier; with
 * no live session in the space (or none installed) a barrier costs one map lookup.
 */

export interface OutlineLiveBarrier {
	/** Run `fn` behind the barrier of `spaceId` (see the module header). */
	run<T>(spaceId: string, fn: () => Promise<T>): Promise<T>;
	/** Whether the current async context already holds the barrier of `spaceId`. */
	holds(spaceId: string): boolean;
}

let installed: OutlineLiveBarrier | null = null;

/** Install (or, with null, remove) the live session barrier. */
export function setOutlineLiveBarrier(barrier: OutlineLiveBarrier | null): void {
	installed = barrier;
}

/**
 * Run a write behind the live session barrier of its space. Reentrant: a caller already behind
 * the barrier (an agent edit that wraps its checks and its write, the session's own writes)
 * runs `fn` directly.
 */
export async function withOutlineLiveBarrier<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
	const barrier = installed;
	if (!barrier || barrier.holds(spaceId)) return await fn();
	return await barrier.run(spaceId, fn);
}
