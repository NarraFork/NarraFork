/**
 * Which nodes of the connected outline (`OutlineTree.tsx`) are open, kept per browser.
 *
 * A node is named by a key: `space:<id>`, `page:<id>`, `group:sessions:<projectId>`,
 * `group:loose`, `group:orphaned`, `group:recent`. The set is ordered by when a node was opened
 * (the newest last), so the limits drop the longest-open first:
 *
 *   - at most {@link TREE_OPEN_LIMITS.maxKeys} keys are kept (stored in `localStorage`, beside the
 *     recent pages);
 *   - at most {@link TREE_OPEN_LIMITS.maxPages} pages are open with their content at once: opening
 *     one more closes the page opened longest ago (its row stays; opening it reads it again);
 *   - of the open pages, the newest {@link TREE_OPEN_LIMITS.livePages} are kept fresh by a page
 *     subscription; the others show the read they have until they are opened again.
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

export function isPageKey(key: string): boolean {
	return key.startsWith("page:");
}

/** Stored keys, dropping anything malformed, at most the limits. */
export function parseTreeOpen(text: string | null): string[] {
	if (!text) return [];
	try {
		const value = JSON.parse(text) as unknown;
		if (!Array.isArray(value)) return [];
		const keys = [
			...new Set(value.filter((k): k is string => typeof k === "string" && KEY_RE.test(k))),
		];
		return bounded(keys);
	} catch {
		return [];
	}
}

/** `keys` within the limits: the newest pages and the newest keys. */
function bounded(keys: readonly string[]): string[] {
	let pages = 0;
	const kept: string[] = [];
	for (let i = keys.length - 1; i >= 0; i--) {
		const key = keys[i] as string;
		if (isPageKey(key)) {
			if (pages >= TREE_OPEN_LIMITS.maxPages) continue;
			pages++;
		}
		kept.push(key);
		if (kept.length >= TREE_OPEN_LIMITS.maxKeys) break;
	}
	return kept.reverse();
}

/** `keys` with `key` opened (as the newest) or closed. */
export function withTreeOpen(keys: readonly string[], key: string, open: boolean): string[] {
	const rest = keys.filter((k) => k !== key);
	return open ? bounded([...rest, key]) : rest;
}

/** The open pages kept fresh: the newest {@link TREE_OPEN_LIMITS.livePages}. */
export function liveTreePages(keys: readonly string[]): Set<string> {
	const pages = keys.filter(isPageKey);
	return new Set(pages.slice(-TREE_OPEN_LIMITS.livePages));
}

/** The open nodes of one tree, with listeners; persisted per browser. */
export class TreeOpenState {
	private keys: string[];
	private set: Set<string>;
	private live: Set<string>;
	private readonly listeners = new Set<() => void>();

	constructor(initial: readonly string[] = readTreeOpen()) {
		this.keys = bounded(initial);
		this.set = new Set(this.keys);
		this.live = liveTreePages(this.keys);
	}

	isOpen(key: string): boolean {
		return this.set.has(key);
	}

	/** An open page kept fresh by a subscription. */
	isLive(key: string): boolean {
		return this.live.has(key);
	}

	/** The open keys, oldest first. */
	snapshot(): readonly string[] {
		return this.keys;
	}

	setOpen(key: string, open: boolean): void {
		if (this.set.has(key) === open) return;
		this.keys = withTreeOpen(this.keys, key, open);
		this.set = new Set(this.keys);
		this.live = liveTreePages(this.keys);
		writeTreeOpen(this.keys);
		for (const l of this.listeners) l();
	}

	toggle(key: string): void {
		this.setOpen(key, !this.set.has(key));
	}

	/** Close every node (the tree's "collapse all"). */
	clear(): void {
		if (this.keys.length === 0) return;
		this.keys = [];
		this.set = new Set();
		this.live = new Set();
		writeTreeOpen(this.keys);
		for (const l of this.listeners) l();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

export function readTreeOpen(): string[] {
	try {
		return parseTreeOpen(localStorage.getItem(STORAGE_KEY));
	} catch {
		return [];
	}
}

function writeTreeOpen(keys: readonly string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
	} catch {
		// The tree's open nodes are a convenience: without storage they last for the session.
	}
}

/** "99+" past the count's cap (a group counts up to `cap` and no further). */
export function treeCountLabel(count: number, cap: number): string {
	return count >= cap ? `${cap - 1}+` : String(count);
}
