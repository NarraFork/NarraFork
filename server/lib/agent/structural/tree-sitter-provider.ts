/**
 * tree-sitter structure provider — the accurate path.
 *
 * Zero configuration, offline, fast, purely syntactic. It knows shapes and names,
 * not identity, which is the boundary that keeps it honest: it can tell you a class
 * has a `charge` method, but not whether the `charge` on line 400 refers to that one.
 * Resolving that needs a semantic engine and is left to a future LSP provider.
 *
 * Reports `degraded` (never throws) when the grammar for a supported language is not
 * installed, so the kernel can fall through to the heuristic provider and the tool
 * can tell the user where to install it.
 */
import { buildElementTree } from "./element-tree";
import { getGrammarEntry, isKnownGrammarLanguage } from "./grammar-manifest";
import { getLanguageSpec } from "./languages";
import { enclosingInOutline, locateInOutline } from "./locate";
import { buildOutline, flattenOutline, type RichOutlineNode, type SyntaxNode } from "./outline";
import { acquireParser } from "./parser-pool";
import type {
	ElementNode,
	FileStatistics,
	ImportExportInfo,
	LocatedNode,
	OutlineNode,
	ProviderSupport,
	StructDocument,
	StructPosition,
	StructSelector,
	StructureProvider,
} from "./provider";
import { collectReferenceStats, rank } from "./references";

/**
 * Files larger than this are not parsed.
 *
 * A tree-sitter parse is synchronous C in wasm: it cannot yield, so on the server's
 * single JS thread the parse duration IS request latency for every other session.
 * Files this large are nearly always generated or vendored, where a heuristic
 * outline is no worse.
 */
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

/** Bound on outline entries, so a generated file cannot produce unbounded output. */
const MAX_OUTLINE_NODES = 5000;

/** Cache of parse results keyed by content, so the modes composing a call parse once. */
const outlineCache = new Map<string, { nodes: RichOutlineNode[]; truncated: boolean }>();
const statsCache = new Map<string, FileStatistics>();
const MAX_CACHE_ENTRIES = 8;

export const treeSitterProvider: StructureProvider = {
	id: "tree-sitter",
	label: "tree-sitter",

	async supports(doc: StructDocument): Promise<ProviderSupport> {
		if (!doc.languageId || !isKnownGrammarLanguage(doc.languageId)) return "no";
		if (!getLanguageSpec(doc.languageId)) return "no";
		if (byteLength(doc.text) > MAX_PARSE_BYTES) return "degraded";
		const lease = await acquireParser(doc.languageId);
		return lease.ok ? "full" : "degraded";
	},

	async outline(doc: StructDocument): Promise<OutlineNode[]> {
		const result = await parseOutline(doc);
		return result.nodes;
	},

	async locate(doc: StructDocument, selector: StructSelector): Promise<LocatedNode[]> {
		const { nodes } = await parseOutline(doc);
		return locateInOutline(nodes, selector);
	},

	async enclosing(doc: StructDocument, position: StructPosition): Promise<LocatedNode[]> {
		const { nodes } = await parseOutline(doc);
		return enclosingInOutline(nodes, position);
	},

	async imports(doc: StructDocument): Promise<ImportExportInfo> {
		const imports = await withParsedTree(doc, (root, languageId) => {
			const spec = getLanguageSpec(languageId);
			if (!spec) return [];
			const collected: ImportExportInfo["imports"] = [];
			collectImports(root, spec.importTypes, collected);
			return collected;
		});
		if (!imports) return { imports: [], exports: [] };

		const { nodes } = await parseOutline(doc);
		const exports = flattenOutline(nodes as RichOutlineNode[])
			.filter((node) => node.exported)
			.map((node) => ({ name: node.symbolPath, kind: node.kind, line: node.startLine }));

		return { imports, exports };
	},

	async statistics(doc: StructDocument): Promise<FileStatistics | null> {
		return parseStatistics(doc);
	},

	async elementTree(doc: StructDocument): Promise<ElementNode[] | null> {
		return withParsedTree(doc, (root) => {
			const result = buildElementTree(root, {
				...(doc.signal ? { signal: doc.signal } : {}),
			});
			// An empty array is a meaningful answer ("no elements here"); null means the
			// file could not be parsed at all, which the caller reports differently.
			return result.roots;
		});
	},

	async explainLimitation(doc: StructDocument): Promise<string | null> {
		if (!doc.languageId) return null;
		const entry = getGrammarEntry(doc.languageId);
		if (!entry) return null;
		if (byteLength(doc.text) > MAX_PARSE_BYTES) {
			return (
				`File exceeds the ${Math.round(MAX_PARSE_BYTES / 1024 / 1024)} MB structural parsing ` +
				`limit, so the result is heuristic.`
			);
		}
		const lease = await acquireParser(doc.languageId);
		if (lease.ok) return null;
		switch (lease.reason) {
			case "not-installed":
				return (
					`The ${entry.label} grammar is not installed, so this result is heuristic. ` +
					`Install it under Settings → Structural Parsing for exact structure.`
				);
			case "load-failed":
				return `The ${entry.label} grammar failed to load (${lease.detail ?? "unknown error"}), so this result is heuristic.`;
			default:
				return null;
		}
	},
};

/**
 * Parse, hand the tree to `extract`, then always free it.
 *
 * The scoped shape is not stylistic. A `Tree` owns memory in the wasm heap, which
 * JS GC does not manage, so a tree that is never `delete()`d leaks for the lifetime
 * of the process — measured at ~10 MB per parse of a 3.5k-line file, 210 MB over 20
 * parses, none of it reclaimed. Returning the root node (as this used to) makes it
 * impossible to know when freeing is safe, so nobody ever freed it.
 *
 * `extract` MUST return plain data. After `delete()`, retained nodes do not throw —
 * they silently report type `ERROR` and garbage text. A leaked node reference would
 * therefore corrupt results rather than fail loudly, which is far worse.
 */
async function withParsedTree<T>(
	doc: StructDocument,
	extract: (root: SyntaxNode, languageId: string) => T,
): Promise<T | null> {
	if (!doc.languageId) return null;
	if (byteLength(doc.text) > MAX_PARSE_BYTES) return null;
	const lease = await acquireParser(doc.languageId);
	if (!lease.ok) return null;

	const tree = lease.parser.parse(doc.text);
	if (!tree) return null;
	try {
		return extract(tree.rootNode as unknown as SyntaxNode, lease.languageId);
	} finally {
		tree.delete();
	}
}

async function parseOutline(
	doc: StructDocument,
): Promise<{ nodes: RichOutlineNode[]; truncated: boolean }> {
	const key = cacheKey(doc);
	const cached = outlineCache.get(key);
	if (cached) return cached;

	// buildOutline returns RichOutlineNode, which holds only strings and numbers —
	// safe to keep after the tree is freed, and safe to cache. Never put a SyntaxNode
	// in here: it would read as ERROR/garbage once the tree is gone.
	const result = await withParsedTree(doc, (root, languageId) =>
		buildOutline(root, languageId, {
			maxNodes: MAX_OUTLINE_NODES,
			...(doc.signal ? { signal: doc.signal } : {}),
		}),
	);
	if (!result) return { nodes: [], truncated: false };

	// Bounded LRU-ish cache: a single StructView call may run outline + locate +
	// enclosing over the same text, and re-parsing per mode would triple the cost of
	// the one operation the size cap above exists to bound.
	if (outlineCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = outlineCache.keys().next().value;
		if (oldest !== undefined) outlineCache.delete(oldest);
	}
	outlineCache.set(key, result);
	return result;
}

/**
 * Tally identifiers/calls/elements, cached alongside the outline.
 *
 * Cached for the same reason the outline is: `mode=report` asks for statistics and an
 * outline over one file, and `with_refs` needs both at once. Without the cache that
 * single user-facing operation would parse twice.
 */
async function parseStatistics(doc: StructDocument): Promise<FileStatistics | null> {
	const key = cacheKey(doc);
	const cached = statsCache.get(key);
	if (cached) return cached;

	const result = await withParsedTree(doc, (root) => {
		const stats = collectReferenceStats(root);
		// Ranked into plain arrays inside the scope, so nothing tied to the tree escapes
		// and the tool layer never has to re-derive an order.
		return {
			identifiers: rank(stats.identifiers),
			calls: rank(stats.calls),
			elements: rank(stats.elements),
			truncated: stats.truncated,
		};
	});
	if (!result) return null;

	if (statsCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = statsCache.keys().next().value;
		if (oldest !== undefined) statsCache.delete(oldest);
	}
	statsCache.set(key, result);
	return result;
}

/** Reference counts keyed by identifier, for annotating an outline. */
export async function referenceCounts(
	doc: StructDocument,
): Promise<ReadonlyMap<string, number> | null> {
	const stats = await parseStatistics(doc);
	if (!stats) return null;
	return new Map(stats.identifiers.map((entry) => [entry.name, entry.count]));
}

function cacheKey(doc: StructDocument): string {
	// Length + head/tail sample rather than a full hash: hashing megabytes on every
	// mode invocation would cost more than the parse this cache saves.
	const head = doc.text.slice(0, 256);
	const tail = doc.text.slice(-256);
	return `${doc.languageId}\u0000${doc.text.length}\u0000${head}\u0000${tail}`;
}

function collectImports(
	node: SyntaxNode,
	importTypes: string[],
	out: ImportExportInfo["imports"],
): void {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		if (importTypes.includes(child.type)) {
			const moduleName = extractModuleName(child);
			out.push({
				module: moduleName ?? child.text.trim().slice(0, 120),
				line: child.startPosition.row + 1,
				form: child.type,
			});
			continue;
		}
		// Imports only ever appear at the top level (or inside a Rust/Go grouping), so
		// there is no need to descend into declaration bodies.
		if (child.childCount > 0 && child.type.endsWith("_declaration")) {
			collectImports(child, importTypes, out);
		}
	}
}

function extractModuleName(node: SyntaxNode): string | null {
	const source = node.childForFieldName("source");
	if (source) return stripQuotes(source.text);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (
			child.type === "string" ||
			child.type === "string_literal" ||
			child.type === "interpreted_string_literal"
		) {
			return stripQuotes(child.text);
		}
		if (child.type === "dotted_name" || child.type === "scoped_identifier") {
			return child.text.trim();
		}
	}
	return null;
}

function stripQuotes(text: string): string {
	return text
		.trim()
		.replace(/^['"`]/, "")
		.replace(/['"`]$/, "");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Drop cached parse results. Used after a grammar install/remove, and by tests. */
export function clearOutlineCache(): void {
	outlineCache.clear();
	statsCache.clear();
}
