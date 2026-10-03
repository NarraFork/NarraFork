/** Lazy file-tree reads and mutations are scoped to one execution-context identity. */
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

const REVALIDATE_CONCURRENCY = 3;
export interface DirError {
	dir: string;
	message: string;
}
export interface UseFileTreeResult {
	state: TreeState;
	loading: ReadonlySet<string>;
	errors: ReadonlyMap<string, string>;
	load: (dir: string) => Promise<void>;
	reload: (dir: string) => Promise<void>;
	reloadAll: () => void;
	ingest: (changes: readonly TreeChange[], truncated: boolean) => void;
}
interface TreeSnapshot {
	token: object;
	state: TreeState;
	loading: ReadonlySet<string>;
	errors: ReadonlyMap<string, string>;
}
function emptySnapshot(token: object): TreeSnapshot {
	return { token, state: emptyTreeState(), loading: new Set(), errors: new Map() };
}

/** A token, not a path equality check: returning A→B→A must not revive A's old requests. */
export function useFileTree(
	root: string,
	showHidden: boolean,
	contextKey = root,
): UseFileTreeResult {
	const key = JSON.stringify([contextKey, root, showHidden]);
	const identity = useRef({
		key,
		token: {},
		active: true,
		inFlight: new Map<string, Promise<void>>(),
	});
	if (identity.current.key !== key) {
		identity.current = { key, token: {}, active: true, inFlight: new Map() };
	}
	const owner = identity.current;
	const [stored, setStored] = useState<TreeSnapshot>(() => emptySnapshot(owner.token));
	let snapshot = stored;
	if (stored.token !== owner.token) {
		// Clear all visible and optimistic mutation state before returning the new root.
		snapshot = emptySnapshot(owner.token);
		setStored(snapshot);
	}
	const liveSnapshot = useRef(snapshot);
	liveSnapshot.current = snapshot;
	const current = useCallback(
		() => owner.active && identity.current.token === owner.token,
		[owner],
	);
	useEffect(() => {
		owner.active = true;
		return () => {
			owner.active = false;
		};
	}, [owner]);
	const update = useCallback(
		(mutate: (previous: TreeSnapshot) => TreeSnapshot) => {
			if (!current() || liveSnapshot.current.token !== owner.token) return;
			const next = mutate(liveSnapshot.current);
			liveSnapshot.current = next;
			setStored((previous) => (current() && previous.token === owner.token ? next : previous));
		},
		[current, owner],
	);

	const readDir = useCallback(
		async (dir: string): Promise<void> => {
			if (!root || !current()) return;
			const existing = owner.inFlight.get(dir);
			if (existing) return existing;
			const task = Promise.resolve().then(async () => {
				if (!current()) {
					owner.inFlight.delete(dir);
					return;
				}
				update((previous) => ({ ...previous, loading: new Set(previous.loading).add(dir) }));
				try {
					const path = dir === TREE_ROOT_KEY ? root : `${root}/${dir}`;
					const response = await api.fsBrowse(path, { showHidden, includeFiles: true });
					if (!current()) return;
					const entries: TreeEntry[] = response.entries.map((entry) => ({
						name: entry.name,
						path: dir === TREE_ROOT_KEY ? entry.name : `${dir}/${entry.name}`,
						isDirectory: entry.isDirectory !== false,
						isSymlink: entry.isSymlink === true,
						...(entry.size == null ? {} : { size: entry.size }),
					}));
					update((previous) => {
						const errors = new Map(previous.errors);
						errors.delete(dir);
						return { ...previous, state: setDirEntries(previous.state, dir, entries), errors };
					});
				} catch (error) {
					update((previous) => ({
						...previous,
						errors: new Map(previous.errors).set(
							dir,
							error instanceof Error ? error.message : String(error),
						),
						state: markDirReadFailed(previous.state, dir),
					}));
				} finally {
					update((previous) => {
						const loading = new Set(previous.loading);
						loading.delete(dir);
						return { ...previous, loading };
					});
					// Each identity owns its own map; old completions cannot remove B's pending read.
					owner.inFlight.delete(dir);
				}
			});
			owner.inFlight.set(dir, task);
			return task;
		},
		[current, owner, root, showHidden, update],
	);

	const load = useCallback(
		async (dir: string) => {
			if (!current()) return;
			const previous = liveSnapshot.current;
			if (previous.token !== owner.token) return;
			const existing = previous.state.get(dir);
			if (existing && !existing.stale) return;
			await readDir(dir);
		},
		[current, owner, readDir],
	);
	const reload = useCallback(
		async (dir: string) => {
			if (current()) await readDir(dir);
		},
		[current, readDir],
	);
	const reloadAll = useCallback(() => {
		update((previous) => ({ ...previous, state: ingestChanges(previous.state, [], true) }));
	}, [update]);
	const ingest = useCallback(
		(changes: readonly TreeChange[], truncated: boolean) => {
			update((previous) => ({
				...previous,
				state: ingestChanges(previous.state, changes, truncated),
			}));
		},
		[update],
	);

	const staleKey = useMemo(() => JSON.stringify(staleDirs(snapshot.state)), [snapshot.state]);
	useEffect(() => {
		if (!root || staleKey === "[]" || !current()) return;
		let cancelled = false;
		void (async () => {
			for (;;) {
				if (cancelled || !current() || liveSnapshot.current.token !== owner.token) return;
				const pending = staleDirs(liveSnapshot.current.state);
				if (!pending.length) return;
				await Promise.allSettled(pending.slice(0, REVALIDATE_CONCURRENCY).map(readDir));
				if (cancelled || !current()) return;
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [current, owner, readDir, root, staleKey]);
	return {
		state: snapshot.state,
		loading: snapshot.loading,
		errors: snapshot.errors,
		load,
		reload,
		reloadAll,
		ingest,
	};
}
