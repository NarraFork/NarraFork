/**
 * tree-store.ts — the file tree's layered directory cache.
 *
 * Holds one entry per LOADED directory, keyed by its worktree-relative path (the
 * root being {@link TREE_ROOT_KEY}). Nothing here fetches: the store is the pure
 * state machine, so the patch semantics can be tested without a server, a
 * component, or a clock.
 *
 * ## Why the cache is layered rather than one tree object
 *
 * A directory's listing is exactly what `/api/fs/browse` returns for it, and the
 * server answers one level at a time. Keeping levels separate is what lets a change
 * to `src/a/b.ts` re-read `src/a` alone — with a single nested document, patching
 * one level means rebuilding the object that contains every other level, and it
 * becomes very easy to write "refetch the tree" by accident.
 *
 * ## Invalidation is not eviction
 *
 * An invalidated directory keeps its entries and gains `stale: true`. This is
 * deliberate: dropping the rows would collapse the user's view (and any expanded
 * state below it) for the duration of a refetch that usually returns almost the same
 * listing. The tree keeps rendering what it has, and the rows are replaced when the
 * new listing lands.
 *
 * Eviction is reserved for directories that are GONE (`drop`), where the retained
 * rows would be a claim about the filesystem that is known to be false.
 */

import { computeTreePatch, TREE_ROOT_KEY, type TreeChange, type TreePatch } from "./tree-patch";

/** One row in a directory listing. */
export interface TreeEntry {
	name: string;
	/** Worktree-relative path, `/`-separated. */
	path: string;
	isDirectory: boolean;
	isSymlink: boolean;
	/** Byte size; only present for files. */
	size?: number;
}

/** Added / removed lines for one file or the aggregate beneath one directory. */
export interface TreeLineStats {
	added: number;
	removed: number;
}

/** One Git status record as consumed by the file tree. */
export interface TreeFileLineChange {
	path: string;
	linesAdded: number;
	linesRemoved: number;
}

/**
 * Index file-level Git figures by tree path and roll them up into every ancestor.
 *
 * The Git endpoint and filesystem tree both use cwd-relative `/` keys. The small
 * normalization below only accepts that contract; treating every backslash as a separator
 * would corrupt a valid POSIX filename. Folder totals do not require descendants to be
 * expanded or loaded.
 */
export function buildTreeLineStats(
	changes: readonly TreeFileLineChange[],
): ReadonlyMap<string, TreeLineStats> {
	const files = new Map<string, TreeLineStats>();
	for (const change of changes) {
		const path = normalizeTreePath(change.path);
		if (!path) continue;
		files.set(path, {
			added: Math.max(0, Math.floor(change.linesAdded)),
			removed: Math.max(0, Math.floor(change.linesRemoved)),
		});
	}

	const totals = new Map<string, TreeLineStats>(files);
	for (const [filePath, stats] of files) {
		let slash = filePath.lastIndexOf("/");
		while (slash > 0) {
			const dir = filePath.slice(0, slash);
			const current = totals.get(dir) ?? { added: 0, removed: 0 };
			totals.set(dir, {
				added: current.added + stats.added,
				removed: current.removed + stats.removed,
			});
			slash = dir.lastIndexOf("/");
		}
	}
	return totals;
}

function normalizeTreePath(path: string): string {
	const normalized = path.replace(/^\.\/+/, "").replace(/\/+$/g, "");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return "";
	}
	return normalized;
}

/** A loaded directory listing. */
export interface DirState {
	entries: TreeEntry[];
	/**
	 * The listing may no longer match the filesystem and should be re-read.
	 *
	 * The rows stay visible while stale — see the note on invalidation above.
	 */
	stale: boolean;
}

/** The tree's loaded state: one entry per loaded directory. */
export type TreeState = ReadonlyMap<string, DirState>;

/** An empty tree, with nothing loaded (not even the root). */
export function emptyTreeState(): TreeState {
	return new Map();
}

/** Directory keys the tree currently holds — the bound on any patch's work. */
export function loadedDirs(state: TreeState): ReadonlySet<string> {
	return new Set(state.keys());
}

/**
 * Record a freshly-read listing for one directory.
 *
 * Always clears `stale`: the listing just came from the server, so whatever
 * invalidated it has been answered. Returns a new map — callers hold `TreeState` as
 * immutable so React can compare by identity.
 */
export function setDirEntries(state: TreeState, dir: string, entries: TreeEntry[]): TreeState {
	const next = new Map(state);
	next.set(dir, { entries, stale: false });
	return next;
}

/**
 * Clear a directory's staleness after a read that FAILED, keeping its entries.
 *
 * Necessary for termination, not cosmetics. Revalidation loops until nothing is
 * stale; if a failed read left the flag set, an unreadable directory (permissions
 * removed, network mount down) would be retried without pause for as long as the
 * panel stayed open — a client-side hot loop against a synchronous server route.
 *
 * The failure is not lost: the caller records it per directory and the owning node
 * renders it with a retry action, so the retry becomes an explicit user decision
 * rather than an unbounded background one.
 *
 * A directory with no loaded entry is left absent: inserting one here would claim an
 * empty listing for a directory we failed to read.
 */
export function markDirReadFailed(state: TreeState, dir: string): TreeState {
	const existing = state.get(dir);
	if (!existing?.stale) return state;
	const next = new Map(state);
	next.set(dir, { ...existing, stale: false });
	return next;
}

/**
 * Apply a computed patch.
 *
 * Ordering is not incidental: drops happen first, so a directory that is both
 * dropped and (via a stale ancestor listing) invalidated cannot be re-added as a
 * stale entry by the invalidation pass. `computeTreePatch` already excludes dropped
 * directories from `invalidated`, and this order means a future change there cannot
 * resurrect a deleted subtree.
 */
export function applyTreePatch(state: TreeState, patch: TreePatch): TreeState {
	if (patch.dropped.length === 0 && patch.invalidated.length === 0 && !patch.revalidateAll) {
		// Identity-stable when there is nothing to do, so React skips the re-render.
		return state;
	}

	const next = new Map(state);

	for (const dir of patch.dropped) {
		next.delete(dir);
	}

	if (patch.revalidateAll) {
		// Everything still loaded is suspect. Marked stale rather than cleared, for the
		// same reason single invalidations are: the user keeps seeing the tree.
		for (const [dir, dirState] of next) {
			if (!dirState.stale) next.set(dir, { ...dirState, stale: true });
		}
		return next;
	}

	for (const dir of patch.invalidated) {
		const existing = next.get(dir);
		// Only levels that are loaded. An invalidation for an unloaded directory would
		// otherwise insert an empty entry, which reads as "this directory is empty".
		if (!existing || existing.stale) continue;
		next.set(dir, { ...existing, stale: true });
	}

	return next;
}

/**
 * Fold one batch of watcher changes into the state.
 *
 * The convenience path used by the WS handler: computes the patch against what is
 * currently loaded and applies it in one step.
 */
export function ingestChanges(
	state: TreeState,
	changes: readonly TreeChange[],
	truncated: boolean,
): TreeState {
	const patch = computeTreePatch({
		changes,
		truncated,
		loadedDirs: loadedDirs(state),
	});
	return applyTreePatch(state, patch);
}

/** Loaded directories needing a re-read, nearest the root first. */
export function staleDirs(state: TreeState): string[] {
	const stale: string[] = [];
	for (const [dir, dirState] of state) {
		if (dirState.stale) stale.push(dir);
	}
	// Shallowest first: a parent's refetch may reveal that a child directory is gone,
	// which drops the child's pending work instead of spending a request on it.
	return stale.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

function depth(dir: string): number {
	if (dir === TREE_ROOT_KEY) return 0;
	let count = 1;
	for (let i = 0; i < dir.length; i++) {
		if (dir.charCodeAt(i) === 47) count++;
	}
	return count;
}
