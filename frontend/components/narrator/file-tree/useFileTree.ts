/**
 * useFileTree.ts — drives the file tree's layered cache: lazy reads, WS patches,
 * and bounded revalidation.
 *
 * The pure state machine lives in `tree-store.ts` / `tree-patch.ts`; this hook is
 * only the part that needs React and the network. It deliberately does NOT use
 * React Query: the cache here is keyed by directory and mutated by patch events, so
 * one query per loaded directory would mean N subscriptions whose invalidation we
 * would then have to coordinate by hand — the store already is that coordination.
 *
 * ## Refetch is bounded on purpose
 *
 * A `truncated` batch marks every loaded directory stale at once, and a deep tree
 * can have many. Firing them all in parallel would put a burst of synchronous
 * `readdirSync` calls on the server's single JS thread (see the main-thread rules in
 * CLAUDE.md). Revalidation therefore runs a small number at a time, shallowest
 * first, so a parent that reveals a deleted child cancels the child's pending work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api";
import { TREE_ROOT_KEY, type TreeChange } from "./tree-patch";
import {
	emptyTreeState,
	ingestChanges,
	markDirReadFailed,
	setDirEntries,
	staleDirs,
	type TreeEntry,
	type TreeState,
} from "./tree-store";

/**
 * Concurrent directory reads during revalidation.
 *
 * Low because each one is a synchronous `readdirSync` on the server's only JS
 * thread. Three keeps a burst from monopolising it while still being clearly faster
 * than serial for the common case of a handful of stale levels.
 */
const REVALIDATE_CONCURRENCY = 3;

/** Per-directory load failure, surfaced so a node can show it rather than look empty. */
export interface DirError {
	dir: string;
	message: string;
}

export interface UseFileTreeResult {
	state: TreeState;
	/** Directories currently being read (for spinners on the owning node). */
	loading: ReadonlySet<string>;
	errors: ReadonlyMap<string, string>;
	/** Read one directory, unless it is already loaded and fresh. */
	load: (dir: string) => Promise<void>;
	/** Force a re-read of one directory, ignoring cache state. */
	reload: (dir: string) => Promise<void>;
	/** Mark everything loaded as stale, triggering bounded revalidation. */
	reloadAll: () => void;
	/** Apply one batch of watcher changes. */
	ingest: (changes: readonly TreeChange[], truncated: boolean) => void;
}

/**
 * @param root Absolute path of the tree's root (the narrator's cwd). Empty disables
 *   the tree entirely — no requests are made without a root to resolve against.
 * @param showHidden Include dotfiles.
 */
export function useFileTree(root: string, showHidden: boolean): UseFileTreeResult {
	const [storedState, setState] = useState<TreeState>(emptyTreeState);
	const [storedLoading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
	const [storedErrors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());

	// Reset when the root or the hidden-file filter changes: entries are keyed relative
	// to the root, and `showHidden` changes what every listing contains, so keeping the
	// old cache would mix two different views of the filesystem.
	//
	// Done DURING RENDER (React's documented "adjusting state when props change"
	// pattern) rather than in an effect. An effect resets one render too late, leaving a
	// pass where `root` is already the new path but the entries are the old root's — and
	// `absolute()` combines the two, so that pass would resolve relative keys against
	// the wrong root and could request paths that belong to neither tree.
	const resetKey = `${showHidden ? "h" : "-"}${root}`;
	const [prevResetKey, setPrevResetKey] = useState(resetKey);
	let state = storedState;
	let loading = storedLoading;
	let errors = storedErrors;
	if (prevResetKey !== resetKey) {
		state = emptyTreeState();
		loading = new Set();
		errors = new Map();
		setPrevResetKey(resetKey);
		setState(state);
		setLoading(loading);
		setErrors(errors);
	}

	// The live state, for callbacks that must not be re-created on every keystroke of
	// tree activity (a changing `load` identity would retrigger consumers' effects).
	const stateRef = useRef(state);
	stateRef.current = state;
	const inFlight = useRef(new Map<string, Promise<void>>());

	/** Absolute path for a relative directory key. */
	const absolute = useCallback(
		(dir: string) => (dir === TREE_ROOT_KEY ? root : `${root}/${dir}`),
		[root],
	);

	const readDir = useCallback(
		async (dir: string): Promise<void> => {
			// Coalesce concurrent reads of the same directory: an expand click and a
			// revalidation pass can both want it, and two requests would race to write
			// the same key.
			const existing = inFlight.current.get(dir);
			if (existing) return existing;

			const task = (async () => {
				setLoading((prev) => new Set(prev).add(dir));
				try {
					const res = await api.fsBrowse(absolute(dir), {
						showHidden,
						includeFiles: true,
					});
					const entries: TreeEntry[] = res.entries.map((entry) => ({
						name: entry.name,
						// Re-derive the relative path rather than trusting the server's absolute
						// one: the store is keyed relatively, and a symlinked root would
						// otherwise produce keys that do not match their parent.
						path: dir === TREE_ROOT_KEY ? entry.name : `${dir}/${entry.name}`,
						// Missing means directory — the pre-`includeFiles` server only ever
						// returned directories, so absence must not read as "file".
						isDirectory: entry.isDirectory !== false,
						isSymlink: entry.isSymlink === true,
						...(entry.size == null ? {} : { size: entry.size }),
					}));
					setState((prev) => setDirEntries(prev, dir, entries));
					setErrors((prev) => {
						if (!prev.has(dir)) return prev;
						const next = new Map(prev);
						next.delete(dir);
						return next;
					});
				} catch (err) {
					// Recorded, not swallowed: a directory that failed to read must say so on
					// its own node. Rendering it as an empty directory would be a false claim
					// about the filesystem, and it is indistinguishable from the truth.
					setErrors((prev) =>
						new Map(prev).set(dir, err instanceof Error ? err.message : String(err)),
					);
					// Staleness is cleared even though the read failed, which is what makes the
					// revalidation loop terminate: leaving the flag set would retry an
					// unreadable directory continuously. The recorded error drives an explicit
					// retry on the node instead.
					setState((prev) => markDirReadFailed(prev, dir));
				} finally {
					setLoading((prev) => {
						const next = new Set(prev);
						next.delete(dir);
						return next;
					});
					inFlight.current.delete(dir);
				}
			})();

			inFlight.current.set(dir, task);
			return task;
		},
		[absolute, showHidden],
	);

	const load = useCallback(
		async (dir: string): Promise<void> => {
			if (!root) return;
			const existing = stateRef.current.get(dir);
			// Already loaded and fresh: expanding a node the user collapsed earlier must
			// not re-request it.
			if (existing && !existing.stale) return;
			await readDir(dir);
		},
		[readDir, root],
	);

	const reload = useCallback(
		async (dir: string): Promise<void> => {
			if (!root) return;
			await readDir(dir);
		},
		[readDir, root],
	);

	const reloadAll = useCallback(() => {
		// Routed through the same staleness mechanism the patch path uses, so manual
		// refresh and a truncated batch cannot diverge in behaviour.
		setState((prev) => ingestChanges(prev, [], true));
	}, []);

	const ingest = useCallback((changes: readonly TreeChange[], truncated: boolean) => {
		setState((prev) => ingestChanges(prev, changes, truncated));
	}, []);

	// Bounded revalidation of stale directories.
	//
	// Keyed on `staleKey` — a newline-joined projection of the stale list — rather than
	// on `state` or on the array itself. Both alternatives re-run this effect on every
	// unrelated state identity change (a spinner toggling, an unrelated level loading),
	// which would restart the revalidation walk mid-flight. The list is re-derived from
	// live state inside the effect, so the projection is only a change TRIGGER and never
	// the data the walk trusts.
	const staleKey = useMemo(() => staleDirs(state).join("\n"), [state]);
	useEffect(() => {
		if (!root || staleKey === "") return;
		let cancelled = false;

		void (async () => {
			// Re-derived from live state rather than captured: by the time a later batch
			// runs, an earlier one may have evicted directories (a parent's listing revealed
			// a deletion) or already cleared their staleness.
			//
			// Shallowest first, which `staleDirs` guarantees: a parent read that reveals a
			// missing child drops the child from the remaining work instead of spending a
			// request on a path that is gone.
			for (;;) {
				if (cancelled) return;
				const pending = staleDirs(stateRef.current);
				if (pending.length === 0) return;
				const batch = pending.slice(0, REVALIDATE_CONCURRENCY);
				await Promise.allSettled(batch.map((dir) => readDir(dir)));
				// Each read clears its own directory's staleness, so the pending set strictly
				// shrinks and this terminates. A read that FAILS also clears it (the error is
				// recorded on the node instead), so a permanently unreadable directory cannot
				// spin here.
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [staleKey, readDir, root]);

	return { state, loading, errors, load, reload, reloadAll, ingest };
}
