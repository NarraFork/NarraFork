/**
 * tree-patch.ts — turn watcher path events into the minimal set of directories a
 * lazily-loaded file tree must re-read.
 *
 * ## Why this is a patch and not a refetch
 *
 * The tree loads one directory level at a time (`/api/fs/browse`), so its state is
 * a set of independently-loaded levels rather than one document. A change to
 * `src/a/b.ts` invalidates exactly the listing of `src/a` — every other loaded
 * level is still correct. Refetching the whole tree would re-request every expanded
 * directory to learn what one of them already told us.
 *
 * ## What a path event does and does not justify
 *
 * A path's own listing is NOT invalidated by a change to that path: the parent's
 * listing is what names it. So the unit of invalidation is always a *parent
 * directory*, and this module's whole job is mapping paths to those parents.
 *
 * The exception is a deleted directory. Its own listing becomes meaningless, and so
 * does every listing beneath it, so descendants are dropped rather than re-read —
 * re-reading them would produce a run of failed requests for paths that are gone.
 *
 * ## Cases this module exists to get right
 *
 *  - `truncated`: the watcher capped the batch, so `changes` is a sample. Applying
 *    it literally would leave the unlisted changes invisible with no signal.
 *  - Unloaded directories: invalidating a level the tree never loaded would make it
 *    fetch subtrees the user never expanded, turning a background event into
 *    unbounded work.
 *  - The root itself: a change to a top-level entry has an empty parent path, which
 *    must resolve to the root rather than being discarded.
 */

/** How a watched path changed, mirroring the server's wire vocabulary. */
export type TreeChangeKind = "added" | "updated" | "deleted";

/** One path-level change, with the path relative to the tree's root. */
export interface TreeChange {
	/** Worktree-relative path, `/`-separated. Never absolute. */
	path: string;
	kind: TreeChangeKind;
}

/**
 * The root directory's key.
 *
 * The empty string, matching what `parentPath("top-level-file")` yields, so the
 * root needs no special case at any call site.
 */
export const TREE_ROOT_KEY = "";

/** The instruction a caller applies to its loaded tree state. */
export interface TreePatch {
	/**
	 * Directories whose listing must be re-read. Never contains a directory that
	 * was not loaded, and never contains a descendant of an entry in `dropped`.
	 */
	invalidated: string[];
	/**
	 * Directories whose loaded state must be discarded without re-reading: they
	 * were deleted, or live under something deleted.
	 */
	dropped: string[];
	/**
	 * Every loaded directory is suspect and must be re-read.
	 *
	 * Set when `truncated` says the change list was only a sample. The caller
	 * should re-read what it has loaded rather than trust `invalidated`, which in
	 * this case describes only the changes that fit in the batch.
	 */
	revalidateAll: boolean;
}

/**
 * The parent directory of a relative path.
 *
 * Returns {@link TREE_ROOT_KEY} for a top-level entry. Trailing slashes are
 * tolerated because a watcher may report a directory either way, and treating
 * `src/a/` as having parent `src/a` would invalidate the wrong level.
 */
export function parentPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash <= 0 ? TREE_ROOT_KEY : trimmed.slice(0, slash);
}

/** True when `candidate` is `ancestor` itself or nested beneath it. */
function isAtOrUnder(candidate: string, ancestor: string): boolean {
	if (ancestor === TREE_ROOT_KEY) return true;
	return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/**
 * Compute what a tree must do in response to one batch of path changes.
 *
 * `loadedDirs` is the set of directory keys whose listings the tree currently
 * holds (including {@link TREE_ROOT_KEY}). It is required rather than optional
 * because it is the only thing bounding the work: without it, a change deep inside
 * an unexpanded subtree would schedule a fetch for a level nobody is looking at.
 */
export function computeTreePatch(args: {
	changes: readonly TreeChange[];
	truncated: boolean;
	loadedDirs: ReadonlySet<string>;
}): TreePatch {
	const { changes, truncated, loadedDirs } = args;

	if (truncated) {
		// The list is a sample, so no subset of it is the answer. Deletions are still
		// honoured: a path known to be gone must not be left in place just because the
		// batch overflowed, and dropping it is strictly better than re-reading it.
		const dropped = collectDropped(changes, loadedDirs);
		return { invalidated: [], dropped: [...dropped], revalidateAll: true };
	}

	const dropped = collectDropped(changes, loadedDirs);
	const invalidated = new Set<string>();

	for (const change of changes) {
		const parent = parentPath(change.path);
		// Only levels the tree actually holds. An unloaded parent has nothing to
		// patch, and the next expand will read it fresh anyway.
		if (!loadedDirs.has(parent)) continue;
		// A parent inside a deleted subtree is being discarded, not re-read.
		if (isDroppedUnder(parent, dropped)) continue;
		invalidated.add(parent);
	}

	// A dropped directory's own parent still needs re-reading — that listing is what
	// names the entry that disappeared.
	for (const dir of dropped) {
		const parent = parentPath(dir);
		if (!loadedDirs.has(parent)) continue;
		if (isDroppedUnder(parent, dropped)) continue;
		invalidated.add(parent);
	}

	return { invalidated: [...invalidated], dropped: [...dropped], revalidateAll: false };
}

/**
 * Loaded directories that must be discarded because they were deleted or sit under
 * something deleted.
 *
 * A deletion event does not say whether the path was a file or a directory (it is
 * gone, so it cannot be probed). That ambiguity is resolved by only ever dropping
 * paths the tree had LOADED as directories: a deleted file was never a loaded
 * directory key, so it contributes nothing here and is handled purely as an
 * invalidation of its parent.
 */
function collectDropped(
	changes: readonly TreeChange[],
	loadedDirs: ReadonlySet<string>,
): Set<string> {
	const deleted: string[] = [];
	for (const change of changes) {
		if (change.kind !== "deleted") continue;
		deleted.push(change.path.replace(/\/+$/, ""));
	}
	if (deleted.length === 0) return new Set();

	const dropped = new Set<string>();
	for (const dir of loadedDirs) {
		if (dir === TREE_ROOT_KEY) continue;
		// Descendants included: a loaded level beneath a deleted directory is just as
		// gone, and re-reading it would only produce a failed request.
		if (deleted.some((del) => isAtOrUnder(dir, del))) dropped.add(dir);
	}
	return dropped;
}

/** True when `dir` is at or under any dropped directory. */
function isDroppedUnder(dir: string, dropped: ReadonlySet<string>): boolean {
	if (dropped.size === 0) return false;
	for (const d of dropped) {
		if (isAtOrUnder(dir, d)) return true;
	}
	return false;
}
