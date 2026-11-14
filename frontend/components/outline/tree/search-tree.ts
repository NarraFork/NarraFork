/**
 * A search drawn as a tree (readability F): the hits with their ancestors, nothing else.
 *
 *   ▾ Project A                        the space of the hits under it
 *       ▾ Tasks                        the page
 *           ▾ Fix the refresh race     an ancestor (drawn once, however many hits are under it)
 *               • … the **race** is in the reader …      a hit, with its snippet
 *
 * Built from the hits alone: each names its ancestors by id (`pathIds`, the page first) and by
 * title (`path`), and its space is in the response. A hit may itself be an ancestor of another.
 * Bounded by the hits loaded (pages of at most 50, as many as one search ranks). Pure.
 */
import type { OutlineSearchHitView, OutlineSpaceSummary } from "@shared/outline-api";

export interface SearchTreeNode {
	/** `space:<id>` for a space's row, else the block's id. */
	key: string;
	kind: "space" | "page" | "block";
	spaceId: string;
	/** A block's id; null for a space's row. */
	blockId: string | null;
	title: string;
	/** The hit this row is; null for a row that only leads to hits. */
	hit: OutlineSearchHitView | null;
	space: OutlineSpaceSummary | null;
	children: SearchTreeNode[];
}

/** The hits as a tree, spaces in the order of their first hit, hits in the order given. */
export function buildSearchTree(
	hits: readonly OutlineSearchHitView[],
	spaces: readonly OutlineSpaceSummary[],
): SearchTreeNode[] {
	const spaceById = new Map(spaces.map((space) => [space.id, space]));
	const roots: SearchTreeNode[] = [];
	const nodes = new Map<string, SearchTreeNode>();
	const seen = new Set<string>();
	const child = (
		parent: SearchTreeNode,
		blockId: string,
		title: string,
		page: boolean,
	): SearchTreeNode => {
		const key = `${parent.spaceId}:${blockId}`;
		let node = nodes.get(key);
		if (!node) {
			node = {
				key: blockId,
				kind: page ? "page" : "block",
				spaceId: parent.spaceId,
				blockId,
				title,
				hit: null,
				space: null,
				children: [],
			};
			nodes.set(key, node);
			parent.children.push(node);
		}
		return node;
	};
	for (const hit of hits) {
		// A hit shown once (two pages of a search may overlap after a commit).
		if (seen.has(hit.blockId)) continue;
		seen.add(hit.blockId);
		let at = nodes.get(`space:${hit.spaceId}`);
		if (!at) {
			at = {
				key: `space:${hit.spaceId}`,
				kind: "space",
				spaceId: hit.spaceId,
				blockId: null,
				title: "",
				hit: null,
				space: spaceById.get(hit.spaceId) ?? null,
				children: [],
			};
			nodes.set(at.key, at);
			roots.push(at);
		}
		// Without ids (an older server) the hit hangs under its space, its path said in words.
		const ids = hit.pathIds?.length === hit.path.length ? hit.pathIds : [];
		for (let i = 0; i < ids.length; i++) {
			at = child(at, ids[i] as string, hit.path[i] ?? "", ids[i] === hit.pageId);
		}
		const node = child(at, hit.blockId, hit.title, hit.blockId === hit.pageId);
		node.hit = hit;
		if (hit.title) node.title = hit.title;
	}
	return roots;
}

/** Every row of the tree in document order, with its depth (a space's row is 0). */
export function flattenSearchTree(
	roots: readonly SearchTreeNode[],
): Array<{ node: SearchTreeNode; depth: number }> {
	const out: Array<{ node: SearchTreeNode; depth: number }> = [];
	const stack = roots.map((node) => ({ node, depth: 0 })).reverse();
	while (stack.length > 0) {
		const at = stack.pop() as { node: SearchTreeNode; depth: number };
		out.push(at);
		for (let i = at.node.children.length - 1; i >= 0; i--) {
			stack.push({ node: at.node.children[i] as SearchTreeNode, depth: at.depth + 1 });
		}
	}
	return out;
}

/** Terms of a query as the snippet marks them: its words, longest first, at most 8. */
export function searchTerms(query: string): string[] {
	return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))]
		.sort((a, b) => b.length - a.length)
		.slice(0, 8);
}

/** `text` cut at every occurrence of a term (case-insensitive): the parts, matches marked. */
export function markTerms(
	text: string,
	terms: readonly string[],
): Array<{ text: string; match: boolean }> {
	if (terms.length === 0 || text === "") return text ? [{ text, match: false }] : [];
	const lower = text.toLowerCase();
	const out: Array<{ text: string; match: boolean }> = [];
	let from = 0;
	let at = 0;
	while (at < text.length) {
		const term = terms.find((t) => t !== "" && lower.startsWith(t, at));
		// (Lower-casing may change a string's length in rare scripts: then nothing is marked.)
		if (!term || lower.length !== text.length) {
			at++;
			continue;
		}
		if (at > from) out.push({ text: text.slice(from, at), match: false });
		out.push({ text: text.slice(at, at + term.length), match: true });
		at += term.length;
		from = at;
	}
	if (from < text.length) out.push({ text: text.slice(from), match: false });
	return out;
}
