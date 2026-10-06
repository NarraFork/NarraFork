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
import { buildGenericOutline } from "./generic-language";
import { getGrammarEntry, isKnownGrammarLanguage } from "./grammar-manifest";
import { getLanguageSpec } from "./languages";
import { enclosingInOutline, locateInOutline } from "./locate";
import { buildOutline, flattenOutline, type RichOutlineNode, type SyntaxNode } from "./outline";
import { acquireParser } from "./parser-pool";
import type {
	ElementNode,
	FileStatistics,
	ImportExportInfo,
	ImportedName,
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
	// The id stays as-is: it is an internal key, used by settings and diagnostics.
	id: "tree-sitter",
	// The LABEL reaches the model on every call, in `[tsx, via …]`. It answers the only
	// question that changes how results should be read — are they exact or guessed — so it
	// names the precision rather than the parsing library behind it.
	label: "exact",

	async supports(doc: StructDocument): Promise<ProviderSupport> {
		if (!doc.languageId || !isKnownGrammarLanguage(doc.languageId)) return "no";
		// A grammar with no declaration table used to be rejected here, which made
		// downloading one a no-op: it parsed fine and reported nothing. Generic-tier
		// languages now fall through to the type-name heuristics instead, and
		// `explainLimitation` says the results are rule-based rather than exact.
		if (!getLanguageSpec(doc.languageId) && !isGenericTier(doc.languageId)) return "no";
		if (byteLength(doc.text) > MAX_PARSE_BYTES) return "degraded";
		const lease = await acquireParser(doc.languageId);
		return lease.ok ? "full" : "degraded";
	},

	async outline(doc: StructDocument): Promise<OutlineNode[]> {
		const result = await parseOutline(doc);
		return result.nodes;
	},

	async isOutlineTruncated(doc: StructDocument): Promise<boolean> {
		return (await parseOutline(doc)).truncated;
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
		const collectedBoth = await withParsedTree(doc, (root, languageId) => {
			const spec = getLanguageSpec(languageId);
			if (!spec) return null;
			const imports: ImportExportInfo["imports"] = [];
			const reExports: ImportExportInfo["exports"] = [];
			collectImports(root, spec.importTypes, imports);
			collectReExports(root, reExports);
			return { imports, reExports };
		});
		if (!collectedBoth) return { imports: [], exports: [] };

		const { nodes } = await parseOutline(doc);
		const own = flattenOutline(nodes as RichOutlineNode[])
			.filter((node) => node.exported)
			.map((node) => ({ name: node.symbolPath, kind: node.kind, line: node.startLine }));

		// Re-exports are listed alongside the file's own exports because that is what they
		// are — part of its public surface. They carry `from`, which is how a caller can
		// tell a pass-through from a declaration and follow the chain one hop.
		return { imports: collectedBoth.imports, exports: [...own, ...collectedBoth.reExports] };
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
		if (lease.ok) {
			// Parsing succeeded, but for a generic-tier language the STRUCTURE came from
			// cross-language type-name rules rather than a table for this grammar. Staying
			// silent here would let a rule-based outline read as an authoritative one.
			if (!getLanguageSpec(doc.languageId)) {
				return (
					`${entry.label} has no declaration table, so structure was inferred from generic ` +
					`node-type rules — some declaration forms may be missing.` +
					(entry.note ? ` ${entry.note}` : "")
				);
			}
			return null;
		}
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
		getLanguageSpec(languageId)
			? buildOutline(root, languageId, {
					maxNodes: MAX_OUTLINE_NODES,
					...(doc.signal ? { signal: doc.signal } : {}),
				})
			: buildGenericOutline(root, {
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
		// Line lists are attached here, inside the scope: they are plain numbers, so unlike
		// the nodes they came from they remain valid after the tree is released.
		return {
			identifiers: rank(stats.identifiers).map((entry) => {
				const lines = stats.identifierLines.get(entry.name);
				return lines ? { ...entry, lines } : entry;
			}),
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

/**
 * Reference LINES keyed by identifier.
 *
 * Separate from `referenceCounts` so the outline annotation path keeps allocating one
 * small map; callers that need positions ask for them explicitly.
 */
export async function referenceLines(
	doc: StructDocument,
): Promise<ReadonlyMap<string, number[]> | null> {
	const stats = await parseStatistics(doc);
	if (!stats) return null;
	const map = new Map<string, number[]>();
	for (const entry of stats.identifiers) {
		if (entry.lines) map.set(entry.name, entry.lines);
	}
	return map;
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
			const names = extractImportedNames(child);
			out.push({
				module: moduleName ?? child.text.trim().slice(0, 120),
				line: child.startPosition.row + 1,
				form: child.type,
				...(names.length > 0 ? { names } : {}),
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

/**
 * Collect `export … from "module"` statements — the barrel pattern.
 *
 * These were invisible before: a re-export is neither an `import_statement` (so
 * `collectImports` skipped it) nor a declaration in the outline (so it produced no export
 * entry either). The result was that a file reached through a barrel — the normal way most
 * of a codebase imports anything — could not be tied back to the module that declares the
 * symbol, and every such usage was reported as unverified.
 *
 * A plain `export function x` is deliberately excluded: it has no source string, so it is
 * a declaration the outline already reports, not a pass-through.
 *
 * `export * from "m"` yields one entry named `*`, meaning "everything from m". A caller
 * cannot know which names that covers without reading `m`, and saying so beats inventing
 * a list.
 */
function collectReExports(node: SyntaxNode, out: ImportExportInfo["exports"]): void {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		// Grammar-neutral shape check: an export that names a source module. Keyed on the
		// presence of that source rather than on a node-type list, so a grammar spelling the
		// statement differently still works as long as it carries the module string.
		if (!child.type.startsWith("export")) continue;
		const moduleName = extractModuleName(child);
		if (!moduleName) continue;
		const line = child.startPosition.row + 1;
		const names = extractImportedNames(child);
		if (names.length === 0) {
			out.push({ name: "*", kind: "unknown", line, from: moduleName });
			continue;
		}
		for (const named of names) {
			out.push({ name: named.local, kind: "unknown", line, from: moduleName });
		}
	}
}

/**
 * Names an import statement binds into the local scope.
 *
 * The LOCAL name is what gets recorded, which for `import { a as b }` is `b`: a caller
 * asking "does this file reference the symbol under some other name" needs the name
 * that appears in the file's body, not the one the module exported. The original is
 * kept alongside as `original` so an alias can still be traced back.
 *
 * Two grammar shapes, both real:
 *  - JS/TS `import_specifier` carries `name`/`alias` FIELDS.
 *  - Python `aliased_import` has POSITIONAL children (original, then alias) and no
 *    fields, so a field-only reader silently returns nothing for every Python file.
 *
 * The module specifier is skipped: it is a string, not a bound name, and including it
 * would make `"./m"` look like an imported identifier.
 */
function extractImportedNames(node: SyntaxNode): ImportedName[] {
	const names: ImportedName[] = [];
	const seen = new Set<string>();
	const push = (local: string | undefined, original?: string): void => {
		const trimmed = local?.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		names.push({
			local: trimmed,
			...(original && original.trim() !== trimmed ? { original: original.trim() } : {}),
		});
	};

	const walk = (current: SyntaxNode, depth: number): void => {
		if (depth > 6) return;
		for (let i = 0; i < current.childCount; i++) {
			const child = current.child(i);
			if (!child?.isNamed) continue;
			switch (child.type) {
				// `{ a }` / `{ a as b }` — fields are reliable here.
				case "import_specifier":
				case "export_specifier": {
					const name = child.childForFieldName("name")?.text;
					const alias = child.childForFieldName("alias")?.text;
					if (alias) push(alias, name);
					else push(name);
					continue;
				}
				// Python `b as c`, and Rust's `use x as y`: positional, no fields.
				case "aliased_import":
				case "use_as_clause": {
					const first = firstIdentifierText(child, 0);
					const last = lastIdentifierText(child);
					if (last && last !== first) push(last, first);
					else push(first);
					continue;
				}
				// `import * as ns` / `import def from`.
				case "namespace_import":
				case "import_require_clause": {
					push(firstIdentifierText(child, 0));
					continue;
				}
				case "identifier":
				case "type_identifier": {
					push(child.text);
					continue;
				}
				case "dotted_name": {
					// In `from mod import a`, the FIRST dotted_name is the module. Only the
					// ones inside the import list bind a name, and those sit after it.
					push(child.text);
					continue;
				}
				case "string":
				case "string_literal":
				case "interpreted_string_literal":
					continue;
				default:
					walk(child, depth + 1);
			}
		}
	};
	walk(node, 0);

	// `from mod import a` records `mod` first because both are dotted_names; the module
	// is already reported separately, so drop it rather than presenting it as a binding.
	const moduleName = extractModuleName(node);
	return moduleName ? names.filter((n) => n.local !== moduleName) : names;
}

function firstIdentifierText(node: SyntaxNode, depth: number): string | undefined {
	if (depth > 4) return undefined;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		if (child.type === "identifier" || child.type === "dotted_name") return child.text;
		const nested = firstIdentifierText(child, depth + 1);
		if (nested) return nested;
	}
	return undefined;
}

function lastIdentifierText(node: SyntaxNode): string | undefined {
	for (let i = node.childCount - 1; i >= 0; i--) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		if (child.type === "identifier" || child.type === "dotted_name") return child.text;
	}
	return undefined;
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

/** Whether this language is offered without a hand-written declaration table. */
function isGenericTier(languageId: string): boolean {
	return getGrammarEntry(languageId)?.tier === "generic";
}

/** Drop cached parse results. Used after a grammar install/remove, and by tests. */
export function clearOutlineCache(): void {
	outlineCache.clear();
	statsCache.clear();
}
