/**
 * Which nodes of the connected outline (`OutlineTree.tsx`) are open, kept per browser and per
 * host (the outline page and the dock panels each have their own).
 *
 * A node is named by a key: `space:<id>`, `page:<id>`, `group:sessions:<projectId>`,
 * `group:loose`, `group:orphaned`, `group:recent`. The keys are ordered by when a node was opened
 * (the newest last), so the limits drop the longest-open first:
 *
 *   - at most {@link TREE_OPEN_LIMITS.maxKeys} keys are kept (stored in `localStorage`);
 *   - at most {@link TREE_OPEN_LIMITS.maxPages} pages are SHOWN open with their content at once:
 *     opening (or showing again, by opening its parent) one more closes the shown page opened or
 *     shown longest ago (its row stays; opening it reads it again). A page shown again counts as
 *     the newest. A page open under a closed parent is not shown: it holds no content and does
 *     not count;
 *   - of the shown open pages, the newest {@link TREE_OPEN_LIMITS.livePages} are kept fresh by a
 *     page subscription; the others show the read they have.
 *
 * The block folding inside an open page is not here: it is the reader's own per page, stored on
 * the server (`outline_view_state`), shared with the focused page.
 *
 * Storage may be unavailable (a private window, blocked site data): the tree then opens and
 * closes for the session only.
 */

export const TREE_OPEN_LIMITS = {
	maxKeys: 500,
	maxPages: 12,
	livePages: 8,
} as const;

const STORAGE_KEY = "narrafork_outline_tree_open";
const KEY_RE =
	/^(space|page):[A-Za-z0-9_-]{1,64}$|^group:(loose|orphaned|recent)$|^group:sessions:[A-Za-z0-9_-]{1,64}$/;

/** Where a tree is shown: each host keeps its own open nodes. */
export type TreeHost = "page" | "panel";

export function treeOpenStorageKey(host: TreeHost): string {
	return host === "page" ? STORAGE_KEY : `${STORAGE_KEY}:panel`;
}

export function isPageKey(key: string): boolean {
	return key.startsWith("page:");
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

/**
 * `keys` with the shown open pages within {@link TREE_OPEN_LIMITS.maxPages}: the shown pages
 * opened longest ago are closed. Pages not shown are left alone.
 */
export function withinShownPages(keys: readonly string[], shown: ReadonlySet<string>): string[] {
	const pages = keys.filter((k) => isPageKey(k) && shown.has(k));
	const excess = pages.length - TREE_OPEN_LIMITS.maxPages;
	if (excess <= 0) return [...keys];
	const drop = new Set(pages.slice(0, excess));
	return keys.filter((k) => !drop.has(k));
}

/** The shown open pages kept fresh: the newest {@link TREE_OPEN_LIMITS.livePages}. */
export function liveTreePages(keys: readonly string[], shown: ReadonlySet<string>): Set<string> {
	const pages = keys.filter((k) => isPageKey(k) && shown.has(k));
	return new Set(pages.slice(-TREE_OPEN_LIMITS.livePages));
}

/** The open nodes of one tree, with listeners; persisted per browser and host. */
export class TreeOpenState {
	private keys: string[];
	private set: Set<string>;
	/** Open pages shown now (their content mounted), by how many mounts. */
	private readonly shown = new Map<string, number>();
	private live = new Set<string>();
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

	/** A shown open page kept fresh by a subscription. */
	isLive(key: string): boolean {
		return this.live.has(key);
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

	/**
	 * An open page's content is shown (mounted): it counts toward the limits until the returned
	 * function says it is not shown any more.
	 */
	showPage(key: string): () => void {
		const was = this.shown.get(key) ?? 0;
		this.shown.set(key, was + 1);
		// Shown again (its parent reopened): it is what the reader looks at now, so it counts as
		// the newest and the limits fall on pages out of sight or opened longer ago.
		this.commit(was === 0 && this.set.has(key) ? withTreeOpen(this.keys, key, true) : this.keys);
		return () => {
			const n = (this.shown.get(key) ?? 1) - 1;
			if (n <= 0) this.shown.delete(key);
			else this.shown.set(key, n);
			this.commit(this.keys);
		};
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private commit(next: readonly string[]): void {
		const shown = new Set(this.shown.keys());
		const keys = withinShownPages(next, shown);
		const live = liveTreePages(keys, shown);
		const keysChanged = keys.length !== this.keys.length || keys.some((k, i) => k !== this.keys[i]);
		const liveChanged = live.size !== this.live.size || [...live].some((k) => !this.live.has(k));
		if (!keysChanged && !liveChanged) return;
		this.keys = keys;
		this.set = new Set(keys);
		this.live = live;
		if (keysChanged && this.storageKey) writeTreeOpen(this.storageKey, keys);
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
