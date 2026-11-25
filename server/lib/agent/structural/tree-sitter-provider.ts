/**
 * Structural provider facade. WASM loading, parsing and every AST walk belong to
 * the bounded structural worker; failures are never recomputed on this thread.
 */
import { getGrammarEntry, isKnownGrammarLanguage } from "./grammar-manifest";
import { invalidateParser as invalidateLocalParser } from "./parser-pool";
import type { StructDocument, StructureProvider } from "./provider";
import { invalidateStructuralWorkers, runStructuralTask } from "./worker-client";

const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const oversized = (doc: StructDocument) => Buffer.byteLength(doc.text, "utf8") > MAX_PARSE_BYTES;

export const treeSitterProvider: StructureProvider = {
	id: "tree-sitter",
	label: "exact",

	async supports(doc) {
		doc.signal?.throwIfAborted();
		if (!doc.languageId || !isKnownGrammarLanguage(doc.languageId)) return "no";
		if (oversized(doc)) return "degraded";
		return runStructuralTask("supports", doc);
	},
	async outline(doc) {
		doc.signal?.throwIfAborted();
		if (oversized(doc)) return [];
		return (await runStructuralTask("outline", doc)).nodes;
	},
	async isOutlineTruncated(doc) {
		doc.signal?.throwIfAborted();
		if (oversized(doc)) return false;
		return (await runStructuralTask("outline", doc)).truncated;
	},
	async locate(doc, selector) {
		doc.signal?.throwIfAborted();
		if (oversized(doc)) return [];
		return runStructuralTask("locate", doc, { selector });
	},
	async enclosing(doc, position) {
		doc.signal?.throwIfAborted();
		if (oversized(doc)) return [];
		return runStructuralTask("enclosing", doc, { position });
	},
	async imports(doc) {
		doc.signal?.throwIfAborted();
		if (oversized(doc)) return { imports: [], exports: [] };
		return runStructuralTask("imports", doc);
	},
	async statistics(doc) {
		doc.signal?.throwIfAborted();
		if (oversized(doc)) return null;
		return runStructuralTask("statistics", doc);
	},
	async elementTree(doc) {
		doc.signal?.throwIfAborted();
		if (oversized(doc)) return null;
		return runStructuralTask("elementTree", doc);
	},
	async explainLimitation(doc) {
		doc.signal?.throwIfAborted();
		if (!doc.languageId || !getGrammarEntry(doc.languageId)) return null;
		if (oversized(doc))
			return "File exceeds the 2 MB structural parsing limit, so the result is heuristic.";
		return runStructuralTask("explainLimitation", doc);
	},
};

/** Reference projections operate on plain worker results, never on syntax nodes. */
export async function referenceCounts(
	doc: StructDocument,
): Promise<ReadonlyMap<string, number> | null> {
	const stats = await treeSitterProvider.statistics?.(doc);
	if (!stats) return null;
	return new Map(stats.identifiers.map((entry) => [entry.name, entry.count]));
}

export async function referenceLines(
	doc: StructDocument,
): Promise<ReadonlyMap<string, number[]> | null> {
	const stats = await treeSitterProvider.statistics?.(doc);
	if (!stats) return null;
	const lines = new Map<string, number[]>();
	for (const entry of stats.identifiers) {
		if (entry.lines) lines.set(entry.name, entry.lines);
	}
	return lines;
}

/** Synchronous invalidation fences both queued and already-running old results. */
export function clearOutlineCache(): void {
	invalidateStructuralWorkers();
}

/** Grammar management also invalidates the separate Bash-analysis parser cache. */
export function invalidateStructureParser(languageId: string): void {
	invalidateLocalParser(languageId);
	invalidateStructuralWorkers();
}
