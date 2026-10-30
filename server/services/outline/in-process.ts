/**
 * The one-time background rebuild of `outline_blocks.in_process` (design §7.1: a derived cache of
 * "this block is process": a task, under a task, or in a session space).
 *
 * The write path keeps the flag in step from the moment the column exists (`write.ts`,
 * `planInProcess`), but blocks written before that carry the column's default. Spaces created
 * since are marked derived at creation (`outline_spaces.in_process_ready`); this job visits the
 * others once:
 *
 *   - page by page (`listSpacePages`, then the page's live structure, read off the main thread
 *     on SQLite when large), computing the flag from the page down and writing only rows that
 *     differ, in chunks;
 *   - every write is guarded by the space's commit counter as it was before the page was read,
 *     so a commit landing in between makes the job read that page again instead of writing a
 *     stale answer;
 *   - a space is marked derived only after a pass during which no commit landed in it (a
 *     commit may have moved blocks between a page already visited and one not yet visited);
 *     a space that keeps changing is left for the next start.
 *
 * Between pages it yields to the event loop; nothing here runs on a request path.
 */
import { logger } from "@server/lib/logger";
import { OUTLINE_LIMITS } from "./model";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineStructureRow } from "./store/read-port";

export const OUTLINE_IN_PROCESS_REBUILD = {
	/** Spaces read per listing. */
	spaceBatch: 20,
	/** Pages read per listing. */
	pageBatch: 100,
	/** Rows one guarded write sets. */
	writeChunk: 1000,
	/** Times a page is read again after a commit landed while it was being written. */
	pageAttempts: 3,
	/** Passes over a space before it is left for the next start. */
	passes: 3,
} as const;

export interface OutlineInProcessRebuildResult {
	/** Spaces marked derived. */
	spaces: number;
	/** Pages visited. */
	pages: number;
	/** Spaces left for the next start (kept changing, a page too large, or an error). */
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

/** One page, guarded by the counter read before it; false when commits kept landing. */
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
			const ok = await store.setInProcess(space.id, seq, {
				inProcess: inProcess.slice(i, i + chunk),
				notInProcess: notInProcess.slice(i, i + chunk),
			});
			if (!ok) {
				moved = true;
				break;
			}
		}
		if (!moved) return "done";
		await yieldToEventLoop();
	}
	return "moved";
}

/** Every page of a space, until a pass sees no commit land; then mark the space derived. */
async function rebuildSpace(
	store: OutlineStore,
	space: OutlineSpaceRow,
	counts: { pages: number },
): Promise<boolean> {
	for (let pass = 0; pass < OUTLINE_IN_PROCESS_REBUILD.passes; pass++) {
		const startSeq = (await store.getSpace(space.id))?.nextSeq;
		if (startSeq === undefined) return false;
		let after: { orderKey: string; id: string } | null = null;
		let quiet = true;
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
				if (outcome === "moved") quiet = false;
				await yieldToEventLoop();
			}
			const last = pages.at(-1);
			if (!last || pages.length < OUTLINE_IN_PROCESS_REBUILD.pageBatch) break;
			after = { orderKey: last.orderKey, id: last.id };
		}
		// Marked only if no commit landed during the pass (the guard is the counter as it began).
		if (
			quiet &&
			(await store.setInProcess(space.id, startSeq, {
				inProcess: [],
				notInProcess: [],
				ready: true,
			}))
		)
			return true;
	}
	return false;
}

/** Derive `in_process` for every space created before the column; see the module header. */
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

let rebuildRunning: Promise<OutlineInProcessRebuildResult | null> | null = null;

/** Run the rebuild once per process, in the background (startup); later calls share the run. */
export function scheduleOutlineInProcessRebuild(): Promise<OutlineInProcessRebuildResult | null> {
	rebuildRunning ??= rebuildOutlineInProcess()
		.then((result) => {
			if (result.spaces || result.left)
				logger.info("Outline in-process flags derived", { ...result });
			return result;
		})
		.catch((error) => {
			logger.warn("Outline in-process rebuild failed", { error: String(error) });
			return null;
		});
	return rebuildRunning;
}
