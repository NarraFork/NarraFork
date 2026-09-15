/**
 * Single-file identifier and call statistics.
 *
 * Answers the questions that otherwise cost a handful of `grep -c` calls, and answers
 * them more accurately: `grep -c '\buseState('` reports 6 on a file that really has
 * 20, because it misses the generic form `useState<T>(`. A regex undercount is worse
 * than no count — it looks like an answer, and nothing about it suggests it is wrong.
 *
 * What this is NOT: resolved references. Counting is lexical and single-file, so two
 * unrelated symbols with the same name collapse into one tally and an aliased import
 * is invisible. That is the same `structural`-precision boundary the provider contract
 * already draws; callers must surface it rather than let a count read like an LSP's
 * find-references.
 *
 * One tree walk produces all three tallies, because the walk — not the counting — is
 * the cost.
 */
import type { SyntaxNode } from "./outline";

/** Node types that carry an identifier we want to tally. */
const IDENTIFIER_TYPES = new Set([
	"identifier",
	"property_identifier",
	"type_identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
	"field_identifier",
	"package_identifier",
]);

/** Upper bound on visited nodes, so a generated file cannot stall the walk. */
const MAX_VISITED_NODES = 400_000;

export interface ReferenceStats {
	/** identifier text → number of occurrences in the file (definition included). */
	identifiers: Map<string, number>;
	/** called function text (`useState`, `obj.method`) → call count. */
	calls: Map<string, number>;
	/** JSX element name → usage count. Empty for non-JSX languages. */
	elements: Map<string, number>;
	/** True when the node cap cut the walk short, so counts are lower bounds. */
	truncated: boolean;
}

/**
 * Walk the tree once and tally identifiers, calls and JSX elements.
 *
 * Uses an explicit stack rather than recursion: these trees are deep (a nested JSX
 * return can exceed default call-stack depth on real files) and an outline walk that
 * overflows would take down the whole tool call.
 */
export function collectReferenceStats(root: SyntaxNode): ReferenceStats {
	const identifiers = new Map<string, number>();
	const calls = new Map<string, number>();
	const elements = new Map<string, number>();
	let visited = 0;
	let truncated = false;

	const bump = (map: Map<string, number>, key: string): void => {
		if (key.length === 0) return;
		map.set(key, (map.get(key) ?? 0) + 1);
	};

	const stack: SyntaxNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (++visited > MAX_VISITED_NODES) {
			truncated = true;
			break;
		}

		if (IDENTIFIER_TYPES.has(node.type)) {
			bump(identifiers, node.text.trim());
		} else if (node.type === "call_expression" || node.type === "call") {
			const fn = node.childForFieldName("function");
			if (fn) bump(calls, normalizeCallee(fn.text));
		} else if (node.type === "jsx_element" || node.type === "jsx_self_closing_element") {
			const open = node.type === "jsx_element" ? node.childForFieldName("open_tag") : node;
			const name = open?.childForFieldName("name")?.text;
			if (name) bump(elements, name.trim());
		}

		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			// Anonymous nodes (punctuation, keywords) are included: skipping them would
			// also skip their named descendants, since tree-sitter nests through them.
			if (child) stack.push(child);
		}
	}

	return { identifiers, calls, elements, truncated };
}

/** Collapse whitespace inside a callee expression (`foo\n  .bar` → `foo .bar`). */
function normalizeCallee(text: string): string {
	return text.replaceAll(/\s+/g, "").trim();
}

export interface RankedEntry {
	name: string;
	count: number;
}

/**
 * Rank a tally, highest first, with a stable alphabetical tiebreak.
 *
 * The tiebreak matters for output stability: an unstable order would make two runs
 * over the same file produce diffs that mean nothing.
 */
export function rank(
	tally: ReadonlyMap<string, number>,
	options: { limit?: number; filter?: string; minCount?: number } = {},
): RankedEntry[] {
	const filter = options.filter?.toLowerCase();
	const minCount = options.minCount ?? 1;
	const entries: RankedEntry[] = [];
	for (const [name, count] of tally) {
		if (count < minCount) continue;
		if (filter && !name.toLowerCase().includes(filter)) continue;
		entries.push({ name, count });
	}
	entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	return options.limit != null ? entries.slice(0, options.limit) : entries;
}

/**
 * Reference count for one declaration.
 *
 * A destructuring declaration has no single name, so its count is the MAXIMUM over
 * its bindings rather than a sum: the question being answered is "is anything here
 * used", and summing 27 unused-but-bound names would invent usage that does not exist.
 */
export function referenceCountFor(
	stats: ReferenceStats,
	node: { name: string; bindings?: string[] },
): number | undefined {
	if (node.bindings && node.bindings.length > 0) {
		let max = 0;
		for (const binding of node.bindings) {
			max = Math.max(max, stats.identifiers.get(binding) ?? 0);
		}
		return max > 0 ? max : undefined;
	}
	// A call entry's "name" is a callee, not a declared symbol; its identifier tally
	// would answer a different question, so it is left unset.
	return stats.identifiers.get(node.name);
}
