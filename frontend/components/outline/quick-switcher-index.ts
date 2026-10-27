/**
 * The quick switcher's results (design §6.10, D35): the current space first, from a local index
 * of what this tab already holds (the live page's blocks: instant, no request), then the server's
 * full-text search (PR7's `/api/outline/search`), the current space's other pages before the other
 * readable spaces. Recently focused blocks rank first.
 *
 * The local index matches titles (a block's first line, plain) and bodies (the whole text) as
 * substrings, case-insensitively; aliases are not in the live page (they are a block's column, not
 * its text), so alias hits come from the server, whose search matches them exactly. Pure: no DOM,
 * no requests.
 */

import { titleOf } from "@shared/outline";
import type { OutlineSearchHitView } from "@shared/outline-api";

export type SwitcherVia = "title" | "alias" | "body" | "recent";

export interface SwitcherHit {
	blockId: string;
	pageId: string;
	spaceId: string;
	/** What the row shows. */
	label: string;
	via: SwitcherVia;
	/** Titles of the ancestors, the page first (server hits). */
	path: string[];
	/** From this tab's own index (the live page): no request, focus in place. */
	local: boolean;
}

interface Entry {
	id: string;
	/** The block's text the entry was made from (an unchanged text keeps its entry). */
	text: string;
	title: string;
	body: string;
	label: string;
}

function entryOf(id: string, text: string): Entry {
	const title = titleOf(text);
	return { id, text, title: title.toLowerCase(), body: text.toLowerCase(), label: title };
}

/** Results shown at most. */
export const SWITCHER_LIMIT = 30;

/**
 * Parsing a search may do for blocks not indexed yet (a page just opened, before the idle warm-up
 * got through it): the rest waits for the next keystroke or idle slice.
 */
const SEARCH_PARSE_BUDGET_MS = 8;

export interface LocalSource {
	pageId: string;
	ids(): Iterable<string>;
	textOf(id: string): string;
}

/**
 * The index of one page. Titles need a parse of each block (`titleOf`), the costly part: entries
 * are kept per block while its text is unchanged, so a rebuild after an edit parses only the
 * blocks that changed, and `warm` parses the page in small idle slices before the first search.
 */
export class LocalSwitcherIndex {
	private entries: Entry[] = [];
	private byId = new Map<string, Entry>();
	private built: LocalSource | null = null;
	private stale = true;
	stats = { buildMs: 0, queryMs: 0, entries: 0, parsed: 0, left: 0 };

	/** The source changed: rebuild before the next search. */
	invalidate(): void {
		this.stale = true;
	}

	private cached(id: string, text: string): Entry | null {
		const e = this.byId.get(id);
		return e && e.text === text ? e : null;
	}

	/**
	 * Collect the entries of the source's blocks, parsing those not indexed yet for at most
	 * `budgetMs`: the rest are left out of this search (the server's search still finds them)
	 * and the index stays stale, so the next search or idle slice goes on.
	 */
	private build(source: LocalSource, budgetMs: number): void {
		const t0 = performance.now();
		const end = t0 + budgetMs;
		if (this.built !== source) this.byId.clear();
		const out: Entry[] = [];
		const byId = new Map<string, Entry>(this.byId);
		const ids = new Set<string>();
		let parsed = 0;
		let left = 0;
		for (const id of source.ids()) {
			ids.add(id);
			const text = source.textOf(id);
			let e = this.cached(id, text);
			if (!e) {
				if (performance.now() >= end) {
					left++;
					continue;
				}
				e = entryOf(id, text);
				parsed++;
			}
			out.push(e);
			byId.set(id, e);
		}
		// Blocks no longer there leave the index.
		for (const id of byId.keys()) if (!ids.has(id)) byId.delete(id);
		this.entries = out;
		this.byId = byId;
		this.built = source;
		this.stale = left > 0;
		this.stats.buildMs = performance.now() - t0;
		this.stats.entries = out.length;
		this.stats.parsed = parsed;
		this.stats.left = left;
	}

	/**
	 * Parse blocks not yet indexed for at most `budgetMs` (an idle slice); true once every block
	 * is (the next search then only collects entries).
	 */
	warm(source: LocalSource, budgetMs: number): boolean {
		if (this.built !== source) {
			this.byId.clear();
			this.built = source;
			this.stale = true;
		}
		const end = performance.now() + budgetMs;
		for (const id of source.ids()) {
			const text = source.textOf(id);
			if (this.cached(id, text)) continue;
			this.byId.set(id, entryOf(id, text));
			if (performance.now() >= end) return false;
		}
		return true;
	}

	/** Hits of `query` in the source (recently focused first), or the recent blocks for "". */
	search(
		source: LocalSource,
		spaceId: string,
		query: string,
		recent: readonly string[],
		/** Time this search may spend parsing blocks not indexed yet. */
		budgetMs = SEARCH_PARSE_BUDGET_MS,
	): SwitcherHit[] {
		if (this.stale || this.built !== source) this.build(source, budgetMs);
		const t0 = performance.now();
		const q = query.trim().toLowerCase();
		const rank = new Map<string, number>();
		recent.forEach((id, i) => {
			rank.set(id, i);
		});
		const hit = (e: Entry, via: SwitcherVia): SwitcherHit => ({
			blockId: e.id,
			pageId: source.pageId,
			spaceId,
			label: e.label,
			via,
			path: [],
			local: true,
		});
		const out: SwitcherHit[] = [];
		if (!q) {
			const byId = new Map(this.entries.map((e) => [e.id, e]));
			for (const id of recent) {
				const e = byId.get(id);
				if (e) out.push(hit(e, "recent"));
				if (out.length >= SWITCHER_LIMIT) break;
			}
			this.stats.queryMs = performance.now() - t0;
			return out;
		}
		const scored: Array<{ h: SwitcherHit; score: number }> = [];
		for (const e of this.entries) {
			let score: number;
			let via: SwitcherVia = "body";
			if (e.title.startsWith(q)) {
				score = 100;
				via = "title";
			} else if (e.title.includes(q)) {
				score = 80;
				via = "title";
			} else if (e.body.includes(q)) score = 40;
			else continue;
			const r = rank.get(e.id);
			if (r !== undefined) score += 1000 - r;
			scored.push({ h: hit(e, via), score });
		}
		scored.sort((a, b) => b.score - a.score);
		for (const s of scored.slice(0, SWITCHER_LIMIT)) out.push(s.h);
		this.stats.queryMs = performance.now() - t0;
		return out;
	}
}

/** A server hit as a row: matched by alias when the alias is the query, else title or body. */
export function serverHit(hit: OutlineSearchHitView, query: string): SwitcherHit {
	const q = query.trim().toLowerCase();
	const via: SwitcherVia =
		hit.alias && hit.alias.toLowerCase() === q
			? "alias"
			: hit.title.toLowerCase().includes(q)
				? "title"
				: "body";
	return {
		blockId: hit.blockId,
		pageId: hit.pageId,
		spaceId: hit.spaceId,
		label: hit.title || hit.snippet || hit.address,
		via,
		path: hit.path,
		local: false,
	};
}

/**
 * Local hits first, then the server's hits of the current space, then of the other spaces;
 * each block once (a local hit wins over the same block from the server).
 */
export function mergeSwitcherHits(
	local: readonly SwitcherHit[],
	server: readonly SwitcherHit[],
	spaceId: string,
	limit = SWITCHER_LIMIT,
): SwitcherHit[] {
	const out: SwitcherHit[] = [];
	const seen = new Set<string>();
	const add = (h: SwitcherHit) => {
		if (seen.has(h.blockId) || out.length >= limit) return;
		seen.add(h.blockId);
		out.push(h);
	};
	for (const h of local) add(h);
	for (const h of server) if (h.spaceId === spaceId) add(h);
	for (const h of server) if (h.spaceId !== spaceId) add(h);
	return out;
}
