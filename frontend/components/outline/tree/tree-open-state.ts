/**
 * Which rows of spaces and groups of the forest (`forest/OutlineForest.tsx`) are open, kept per
 * browser and per host (the outline page and the dock panels each have their own).
 *
 * A node is named by a key: `space:<id>`, `group:sessions:<projectId>`, `group:loose`,
 * `group:orphaned`, `group:recent`. The keys are ordered by when a node was opened (the newest
 * last); at most {@link TREE_OPEN_LIMITS.maxKeys} are kept (stored in `localStorage`), the
 * longest-open dropped first.
 *
 * BLOCKS are not here: what a reader opened and closed among them is their own per block,
 * stored on the server (`outline_fold_state`), the same on every device. Keys of the time when
 * the tree listed pages (`page:<id>`) are dropped when read: the tree is back at its default.
 *
 * Storage may be unavailable (a private window, blocked site data): the tree then opens and
 * closes for the session only.
 */

export const TREE_OPEN_LIMITS = {
	maxKeys: 500,
} as const;

const STORAGE_KEY = "narrafork_outline_tree_open";
const KEY_RE =
	/^space:[A-Za-z0-9_-]{1,64}$|^group:(loose|orphaned|recent)$|^group:sessions:[A-Za-z0-9_-]{1,64}$/;

/** Where a tree is shown: each host keeps its own open nodes. */
export type TreeHost = "page" | "panel";

export function treeOpenStorageKey(host: TreeHost): string {
	return host === "page" ? STORAGE_KEY : `${STORAGE_KEY}:panel`;
}

/** Stored keys, dropping anything malformed, the newest {@link TREE_OPEN_LIMITS.maxKeys}. */
export function parseTreeOpen(text: string | null): string[] {
	if (!text) return [];
	try {
		const value = JSON.parse(text) as unknown;
		if (!Array.isArray(value)) return [];
		const keys = [
			...new Set(value.filter((k): k is string => typeof k === "string" && KEY_RE.test(k))),
		];
		return keys.slice(-TREE_OPEN_LIMITS.maxKeys);
	} catch {
		return [];
	}
}

/** `keys` with `key` opened (as the newest) or closed, the newest maxKeys kept. */
export function withTreeOpen(keys: readonly string[], key: string, open: boolean): string[] {
	const rest = keys.filter((k) => k !== key);
	return open ? [...rest, key].slice(-TREE_OPEN_LIMITS.maxKeys) : rest;
}

/** The open nodes of one tree, with listeners; persisted per browser and host. */
export class TreeOpenState {
	private keys: string[];
	private set: Set<string>;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly storageKey: string | null = STORAGE_KEY,
		initial?: readonly string[],
	) {
		this.keys = parseTreeOpen(
			JSON.stringify(initial ?? (storageKey ? readTreeOpen(storageKey) : [])),
		);
		this.set = new Set(this.keys);
	}

	isOpen(key: string): boolean {
		return this.set.has(key);
	}

	/** The open keys, oldest first. */
	snapshot(): readonly string[] {
		return this.keys;
	}

	setOpen(key: string, open: boolean): void {
		if (this.set.has(key) === open) return;
		this.commit(withTreeOpen(this.keys, key, open));
	}

	/** Open or close several nodes at once, in the order given (the last is the newest). */
	setMany(keys: readonly string[], open: boolean): void {
		let next: readonly string[] = this.keys;
		for (const key of keys) next = withTreeOpen(next, key, open);
		this.commit(next);
	}

	toggle(key: string): void {
		this.setOpen(key, !this.set.has(key));
	}

	/** Close every node (the tree's "collapse all"). */
	clear(): void {
		if (this.keys.length === 0) return;
		this.commit([]);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private commit(next: readonly string[]): void {
		const keys = [...next];
		if (keys.length === this.keys.length && keys.every((k, i) => k === this.keys[i])) return;
		this.keys = keys;
		this.set = new Set(keys);
		if (this.storageKey) writeTreeOpen(this.storageKey, keys);
		for (const l of this.listeners) l();
	}
}

export function readTreeOpen(storageKey: string = STORAGE_KEY): string[] {
	try {
		return parseTreeOpen(localStorage.getItem(storageKey));
	} catch {
		return [];
	}
}

function writeTreeOpen(storageKey: string, keys: readonly string[]): void {
	try {
		localStorage.setItem(storageKey, JSON.stringify(keys));
	} catch {
		// The tree's open nodes are a convenience: without storage they last for the session.
	}
}

/** "99+" past the count's cap (a group counts up to `cap` and no further). */
export function treeCountLabel(count: number, cap: number): string {
	return count >= cap ? `${cap - 1}+` : String(count);
}
