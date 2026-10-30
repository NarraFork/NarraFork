/**
 * `outline_blocks.in_process`, the derived cache of "this block is process" (design §2.1, §7.1:
 * a task, under a task, or in a session space): the background rebuild that derives it where
 * the write path could not, and the read that answers correctly while it has not run yet.
 *
 * WHEN A SPACE IS NOT DERIVED (`outline_spaces.in_process_ready` false)
 * --------------------------------------------------------------------
 *   - Spaces written before the column existed (the migration leaves them so). Spaces created
 *     since start derived.
 *   - A commit whose answers did not fit its row limit (a checkbox on a block with a huge
 *     subtree, a move of one): the write goes through and marks the space (`write.ts`), and asks
 *     for a rebuild ({@link requestOutlineInProcessRebuild}), which starts a moment later.
 *
 * THE REBUILD
 * -----------
 *   - page by page (`listSpacePages`, then the page's live structure, read off the main thread
 *     on SQLite when large), computing the flag from the page down and writing only rows that
 *     differ, in chunks;
 *   - every write is guarded by the space's commit counter as it was before the page was read.
 *     A commit landing in between that only changed text (content, aliases, tags) does not
 *     change any answer, so the write is simply repeated against the new counter; any other
 *     makes the job read the page again;
 *   - a space is marked derived only after a pass in which no commit changed structure or
 *     tasks (a commit may have moved blocks between a page already visited and one not yet
 *     visited). Spaces left pending (still changing, a page over the page limit, an error) are
 *     tried again later, backing off from {@link OUTLINE_IN_PROCESS_TIMING.retryMinMs}.
 * Between pages it yields to the event loop; nothing here runs on a request path.
 *
 * READING WHILE A SPACE IS NOT DERIVED
 * ------------------------------------
 * The column of such a space may be wrong either way, so it is not used: {@link readInProcess}
 * computes the answer from the tree (the blocks' ancestors, read level by level), which is exact.
 * Nothing process is then shown or injected as a fact, and no fact is hidden, whatever the
 * column holds. A reader that filters on the column in SQL does so only for the spaces
 * {@link outlineSpacesWithInProcess} returns, and asks {@link readInProcess} about the others.
 */
import { logger } from "@server/lib/logger";
import { OUTLINE_CHANGE, OUTLINE_LIMITS } from "./model";
import { outlineStore } from "./store";
import {
	chunked,
	type OutlineBlockMeta,
	type OutlineSpaceRow,
	type OutlineStore,
} from "./store/port";
import type { OutlineStructureRow } from "./store/read-port";

export const OUTLINE_IN_PROCESS_REBUILD = {
	/** Spaces read per listing. */
	spaceBatch: 20,
	/** Pages read per listing. */
	pageBatch: 100,
	/** Rows one guarded write sets. */
	writeChunk: 1000,
	/** Times a page is read again after a commit changed structure while it was being written. */
	pageAttempts: 3,
	/** Passes over a space before it is left for a later run. */
	passes: 3,
	/** Blocks one {@link readInProcess} answers. */
	maxRead: OUTLINE_LIMITS.maxPageBlocks,
} as const;

/** Timings of the rebuild scheduler. Mutable only so tests can change them. */
export const OUTLINE_IN_PROCESS_TIMING: Record<
	"requestDelayMs" | "retryMinMs" | "retryMaxMs",
	number
> = {
	/** A commit that left a space to the rebuild starts it this soon (a burst shares a run). */
	requestDelayMs: 1_000,
	/** A run that left spaces pending runs again after this, doubling each time… */
	retryMinMs: 30_000,
	/** …up to this. */
	retryMaxMs: 10 * 60_000,
};

/** Change flags that can change an in-process answer; text, aliases and tags cannot. */
const STRUCTURAL_CHANGES =
	OUTLINE_CHANGE.CREATE |
	OUTLINE_CHANGE.MOVE |
	OUTLINE_CHANGE.DELETE |
	OUTLINE_CHANGE.RESTORE |
	OUTLINE_CHANGE.TASK |
	OUTLINE_CHANGE.PAGE;

export interface OutlineInProcessRebuildResult {
	/** Spaces marked derived. */
	spaces: number;
	/** Pages visited. */
	pages: number;
	/** Spaces left for a later run (kept changing, a page too large, or an error). */
	left: number;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** The flag of every live block of one page: from the page down. */
export function inProcessOfPage(
	rows: readonly OutlineStructureRow[],
	sessionSpace: boolean,
): { inProcess: string[]; notInProcess: string[] } {
	if (sessionSpace) return { inProcess: rows.map((r) => r.id), notInProcess: [] };
	const byId = new Map(rows.map((r) => [r.id, r]));
	const value = new Map<string, boolean>();
	for (const row of rows) {
		const path: OutlineStructureRow[] = [];
		let current: OutlineStructureRow | undefined = row;
		while (current && !value.has(current.id) && path.length <= OUTLINE_LIMITS.maxDepth) {
			path.push(current);
			current = current.parentId === null ? undefined : byId.get(current.parentId);
		}
		let above = current ? (value.get(current.id) ?? false) : false;
		for (let i = path.length - 1; i >= 0; i--) {
			const block = path[i] as OutlineStructureRow;
			above = block.taskJson !== null || above;
			value.set(block.id, above);
		}
	}
	const inProcess: string[] = [];
	const notInProcess: string[] = [];
	for (const [id, v] of value) (v ? inProcess : notInProcess).push(id);
	return { inProcess, notInProcess };
}

/**
 * Write a page's answers against the counter they were computed at. A commit that landed since
 * and changed only text leaves them right: they are written again against the new counter.
 * Returns false when a commit changed structure (the page has to be read again).
 */
async function writeGuarded(
	store: OutlineStore,
	spaceId: string,
	seq: number,
	values: { inProcess: readonly string[]; notInProcess: readonly string[]; ready?: boolean },
): Promise<boolean> {
	let at = seq;
	for (let attempt = 0; attempt < OUTLINE_IN_PROCESS_REBUILD.pageAttempts * 2; attempt++) {
		if (await store.setInProcess(spaceId, at, values)) return true;
		const now = (await store.getSpace(spaceId))?.nextSeq;
		if (now === undefined || (await store.hasChangesSince(spaceId, seq - 1, STRUCTURAL_CHANGES)))
			return false;
		at = now;
	}
	return false;
}

/** One page, read and written under the counter guard. */
async function rebuildPage(
	store: OutlineStore,
	space: OutlineSpaceRow,
	pageId: string,
): Promise<"done" | "moved" | "too-large"> {
	for (let attempt = 0; attempt < OUTLINE_IN_PROCESS_REBUILD.pageAttempts; attempt++) {
		const seq = (await store.getSpace(space.id))?.nextSeq;
		if (seq === undefined) return "done";
		const page = await store.listPageStructure(pageId, {
			asOf: null,
			limit: OUTLINE_LIMITS.maxPageBlocks,
		});
		if (page.truncated) return "too-large";
		const { inProcess, notInProcess } = inProcessOfPage(page.rows, space.kind === "session");
		let moved = false;
		const chunk = OUTLINE_IN_PROCESS_REBUILD.writeChunk;
		for (let i = 0; i < Math.max(inProcess.length, notInProcess.length); i += chunk) {
			const values = {
				inProcess: inProcess.slice(i, i + chunk),
				notInProcess: notInProcess.slice(i, i + chunk),
			};
			if (!(await writeGuarded(store, space.id, seq, values))) {
				moved = true;
				break;
			}
		}
		if (!moved) return "done";
		await yieldToEventLoop();
	}
	return "moved";
}

/** Every page of a space, until a pass sees no structural commit land; then mark it derived. */
async function rebuildSpace(
	store: OutlineStore,
	space: OutlineSpaceRow,
	counts: { pages: number },
): Promise<boolean> {
	for (let pass = 0; pass < OUTLINE_IN_PROCESS_REBUILD.passes; pass++) {
		const startSeq = (await store.getSpace(space.id))?.nextSeq;
		if (startSeq === undefined) return false;
		let after: { orderKey: string; id: string } | null = null;
		for (;;) {
			const pages = await store.listSpacePages(space.id, {
				after,
				limit: OUTLINE_IN_PROCESS_REBUILD.pageBatch,
			});
			for (const page of pages) {
				const outcome = await rebuildPage(store, space, page.id);
				counts.pages++;
				if (outcome === "too-large") {
					logger.warn("Outline in-process rebuild: page too large, space left", {
						spaceId: space.id,
						pageId: page.id,
					});
					return false;
				}
				await yieldToEventLoop();
			}
			const last = pages.at(-1);
			if (!last || pages.length < OUTLINE_IN_PROCESS_REBUILD.pageBatch) break;
			after = { orderKey: last.orderKey, id: last.id };
		}
		// Derived only if nothing structural landed during the pass (that includes a commit that
		// marked the space again). The mark itself is guarded by the counter the check saw.
		const endSeq = (await store.getSpace(space.id))?.nextSeq;
		if (endSeq === undefined) return false;
		const quiet =
			endSeq === startSeq ||
			!(await store.hasChangesSince(space.id, startSeq - 1, STRUCTURAL_CHANGES));
		if (
			quiet &&
			(await store.setInProcess(space.id, endSeq, { inProcess: [], notInProcess: [], ready: true }))
		)
			return true;
	}
	return false;
}

/** Derive `in_process` for every space that is not derived; see the module header. */
export async function rebuildOutlineInProcess(
	options: { store?: OutlineStore } = {},
): Promise<OutlineInProcessRebuildResult> {
	const store = options.store ?? outlineStore;
	const result: OutlineInProcessRebuildResult = { spaces: 0, pages: 0, left: 0 };
	let after: string | null = null;
	for (;;) {
		const spaces = await store.listSpacesPendingInProcess({
			after,
			limit: OUTLINE_IN_PROCESS_REBUILD.spaceBatch,
		});
		for (const space of spaces) {
			try {
				if (await rebuildSpace(store, space, result)) result.spaces++;
				else result.left++;
			} catch (error) {
				result.left++;
				logger.warn("Outline in-process rebuild failed for a space", {
					spaceId: space.id,
					error: String(error),
				});
			}
		}
		const last = spaces.at(-1);
		if (!last || spaces.length < OUTLINE_IN_PROCESS_REBUILD.spaceBatch) break;
		after = last.id;
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling: one run at a time per store, soon after a request, again later if spaces are left
// ─────────────────────────────────────────────────────────────────────────────

interface Scheduler {
	timer: ReturnType<typeof setTimeout> | null;
	/** When the timer fires (ms since the epoch). */
	timerAt: number;
	running: Promise<OutlineInProcessRebuildResult | null> | null;
	/** A request arrived during the run: run once more after it. */
	again: boolean;
	retryMs: number;
}

const schedulers = new WeakMap<OutlineStore, Scheduler>();
const timers = new Set<ReturnType<typeof setTimeout>>();

function schedulerOf(store: OutlineStore): Scheduler {
	let s = schedulers.get(store);
	if (!s) {
		s = { timer: null, timerAt: 0, running: null, again: false, retryMs: 0 };
		schedulers.set(store, s);
	}
	return s;
}

function clearTimer(s: Scheduler): void {
	if (!s.timer) return;
	clearTimeout(s.timer);
	timers.delete(s.timer);
	s.timer = null;
}

/** Fire a run in `delayMs`, unless one is due sooner already. */
function runIn(store: OutlineStore, s: Scheduler, delayMs: number): void {
	const at = Date.now() + delayMs;
	if (s.timer && s.timerAt <= at) return;
	clearTimer(s);
	const timer = setTimeout(() => {
		timers.delete(timer);
		if (s.timer === timer) s.timer = null;
		void runOutlineInProcessRebuild(store);
	}, delayMs);
	timer.unref?.();
	timers.add(timer);
	s.timer = timer;
	s.timerAt = at;
}

/**
 * Run the rebuild now for `store` (cancelling a scheduled run); during a run, it runs once more
 * after it. Resolves with the last run's result (null when it failed).
 */
export function runOutlineInProcessRebuild(
	store: OutlineStore = outlineStore,
): Promise<OutlineInProcessRebuildResult | null> {
	const s = schedulerOf(store);
	clearTimer(s);
	if (s.running) {
		s.again = true;
		return s.running;
	}
	s.running = (async () => {
		let result: OutlineInProcessRebuildResult | null = null;
		do {
			s.again = false;
			try {
				result = await rebuildOutlineInProcess({ store });
				if (result.spaces || result.left)
					logger.info("Outline in-process flags derived", { ...result });
			} catch (error) {
				result = null;
				logger.warn("Outline in-process rebuild failed", { error: String(error) });
			}
		} while (s.again);
		if (result === null || result.left > 0) {
			s.retryMs = Math.min(
				OUTLINE_IN_PROCESS_TIMING.retryMaxMs,
				s.retryMs > 0 ? s.retryMs * 2 : OUTLINE_IN_PROCESS_TIMING.retryMinMs,
			);
			runIn(store, s, s.retryMs);
		} else s.retryMs = 0;
		return result;
	})().finally(() => {
		s.running = null;
	});
	return s.running;
}

/**
 * A commit left a space to the rebuild (`write.ts`): run it after
 * {@link OUTLINE_IN_PROCESS_TIMING.requestDelayMs}, or once more after the run in progress.
 */
export function requestOutlineInProcessRebuild(store: OutlineStore = outlineStore): void {
	const s = schedulerOf(store);
	if (s.running) {
		s.again = true;
		return;
	}
	runIn(store, s, OUTLINE_IN_PROCESS_TIMING.requestDelayMs);
}

/** The startup run: spaces written before the column existed, and any left by the last process. */
export function scheduleOutlineInProcessRebuild(): Promise<OutlineInProcessRebuildResult | null> {
	return runOutlineInProcessRebuild(outlineStore);
}

/** Cancel scheduled runs (shutdown); a run in progress finishes its current page and ends. */
export function stopOutlineInProcessRebuild(): void {
	for (const timer of timers) clearTimeout(timer);
	timers.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

/** Of `spaceIds`, the spaces whose `in_process` column can be used as is (derived). */
export async function outlineSpacesWithInProcess(
	spaceIds: readonly string[],
	options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	const store = options.store ?? outlineStore;
	const ready = spaceIds.length > 0 ? await store.getInProcessReady(spaceIds) : new Map();
	return new Set([...ready].filter(([, v]) => v).map(([id]) => id));
}

/**
 * Whether each block of a space is process. A derived space answers from the column; one that is
 * not (see the module header) from its tree: each block's ancestors are read level by level (one
 * indexed query per level), and a block is process when it or an ancestor is a task. Exact either
 * way. Blocks of other spaces and unknown ids are left out; at most
 * {@link OUTLINE_IN_PROCESS_REBUILD.maxRead} blocks are answered.
 */
export async function readInProcess(
	spaceId: string,
	blockIds: readonly string[],
	options: { store?: OutlineStore } = {},
): Promise<Map<string, boolean>> {
	const store = options.store ?? outlineStore;
	const out = new Map<string, boolean>();
	const ids = [...new Set(blockIds)].slice(0, OUTLINE_IN_PROCESS_REBUILD.maxRead);
	const space = await store.getSpace(spaceId);
	if (!space || ids.length === 0) return out;
	const metas = await store.getBlockMetas(spaceId, { ids });
	if (space.kind === "session") {
		for (const meta of metas) out.set(meta.id, true);
		return out;
	}
	if ((await store.getInProcessReady([spaceId])).get(spaceId) === true) {
		for (const meta of metas) out.set(meta.id, meta.inProcess);
		return out;
	}
	const known = new Map<string, OutlineBlockMeta>(metas.map((m) => [m.id, m]));
	for (let depth = 0; depth < OUTLINE_LIMITS.maxDepth; depth++) {
		const missing = new Set<string>();
		for (const meta of known.values())
			if (meta.parentId !== null && !known.has(meta.parentId)) missing.add(meta.parentId);
		if (missing.size === 0) break;
		let found = 0;
		for (const chunk of chunked([...missing])) {
			for (const meta of await store.getBlockMetas(spaceId, { ids: chunk })) {
				known.set(meta.id, meta);
				found++;
			}
		}
		if (found === 0) break;
	}
	const value = new Map<string, boolean>();
	const answer = (meta: OutlineBlockMeta): boolean => {
		const path: OutlineBlockMeta[] = [];
		let current: OutlineBlockMeta | undefined = meta;
		while (current && !value.has(current.id) && path.length <= OUTLINE_LIMITS.maxDepth) {
			path.push(current);
			current = current.parentId === null ? undefined : known.get(current.parentId);
		}
		let above = current ? (value.get(current.id) ?? false) : false;
		for (let i = path.length - 1; i >= 0; i--) {
			const block = path[i] as OutlineBlockMeta;
			above = block.taskJson !== null || above;
			value.set(block.id, above);
		}
		return value.get(meta.id) ?? false;
	};
	for (const meta of metas) out.set(meta.id, answer(meta));
	return out;
}
