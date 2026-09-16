/**
 * Cross-file references to a symbol.
 *
 * `report` warns "cross-file usage is invisible here; confirm with Grep before deleting",
 * which collides head-on with the guidance to prefer structural tools over ad-hoc grep. A
 * report from a real session hit exactly this: `resolveSelectionOverlayBlockId` read as
 * dead (`refs: 1 ⚠`) in its own file while being another file's only entry point. Splitting
 * and deleting are inherently cross-file questions, and a single-file view cannot answer
 * them.
 *
 * The answer here is deliberately TWO-STAGE and its precision is deliberately advertised:
 *
 *   1. ripgrep prefilters to files whose TEXT contains the name — fast, but it also matches
 *      the name in comments, strings, and unrelated same-named symbols.
 *   2. the caller re-reads each candidate through the parser and keeps only real identifier
 *      occurrences, which drops the comment/string noise.
 *
 * What stage 2 CANNOT do without type resolution: tell two distinct symbols that share a
 * name apart, or follow an `import { x as y }` alias. So this is structural, not semantic —
 * a map of where the name appears as code, not proof of what references the symbol. The
 * output says so, because treating it as LSP-grade find-references is how someone deletes
 * something that was actually in use.
 */

/**
 * How much confidence a hit deserves.
 *
 * `confirmed` — the file imports the name from the module that declares it, so the
 *   identifier almost certainly IS the symbol being traced.
 * `unverified` — the name matches but no import ties it to the definition. Could be a
 *   same-named local, a different module's export, or a same-file reference. Reported
 *   rather than dropped, because an import this reader cannot see (a re-export chain, a
 *   dynamic import, a language whose imports are not parsed) still leaves a real usage.
 * `aliased` — the file imports the symbol under a DIFFERENT local name, so the lines
 *   listed for the original name are not the whole story.
 */
export type UsageConfidence = "confirmed" | "unverified" | "aliased";

/** One file's hits: the path and the 1-based lines the identifier appears on. */
export interface UsageFile {
	path: string;
	lines: number[];
	confidence?: UsageConfidence;
	/** Local name the symbol was imported as, when it was renamed. */
	alias?: string;
}

export interface CrossFileUsageResult {
	files: UsageFile[];
	/** Files matched by text but dropped once parsed (comment/string-only hits). */
	textOnlyFiles: number;
	/** ripgrep hit its candidate cap, so results are a lower bound. */
	candidatesCapped: boolean;
	/** Some candidates were skipped (unparseable, too large, unreadable). */
	skipped: number;
}

/** Per-file positions gathered by the caller after parsing each candidate. */
export interface RawFileHit {
	path: string;
	/** Identifier lines from the position index; empty means text-only (no real usage). */
	lines: readonly number[];
	confidence?: UsageConfidence;
	alias?: string;
}

export interface AssembleOptions {
	/** Positions shown per file before collapsing to a count. */
	maxLinesPerFile?: number;
	candidatesCapped?: boolean;
	skipped?: number;
}

/**
 * Turn per-file parse results into the reported structure.
 *
 * Files with no real identifier line are counted as text-only rather than listed: a match
 * that exists only in a comment is exactly the noise stage 2 is meant to remove, and
 * showing it would recreate the grep problem this mode is trying to replace.
 */
export function assembleUsages(
	hits: readonly RawFileHit[],
	options: AssembleOptions = {},
): CrossFileUsageResult {
	const maxPerFile = options.maxLinesPerFile ?? 20;
	const files: UsageFile[] = [];
	let textOnly = 0;

	for (const hit of hits) {
		const lines = [...new Set(hit.lines)].sort((a, b) => a - b);
		if (lines.length === 0) {
			textOnly++;
			continue;
		}
		files.push({
			path: hit.path,
			lines: lines.slice(0, maxPerFile),
			...(hit.confidence ? { confidence: hit.confidence } : {}),
			...(hit.alias ? { alias: hit.alias } : {}),
		});
	}

	// Confirmed first, then most-referenced: a caller planning a rename needs the files
	// that provably use this symbol before the ones that merely share its name.
	const rank = (f: UsageFile): number =>
		f.confidence === "confirmed" || f.confidence === "aliased" ? 0 : 1;
	files.sort(
		(a, b) => rank(a) - rank(b) || b.lines.length - a.lines.length || a.path.localeCompare(b.path),
	);

	return {
		files,
		textOnlyFiles: textOnly,
		candidatesCapped: options.candidatesCapped === true,
		skipped: options.skipped ?? 0,
	};
}

/** The mandatory precision caveat, kept in one place so every caller states it identically. */
export const CROSS_FILE_PRECISION_NOTE =
	"Structural, not semantic. `confirmed` files import the name from the defining module, " +
	"and an `import { x as y }` alias is followed to its local name. `unverified` files " +
	"carry the same name with no import this check could tie to the definition, so they may " +
	"be a different symbol entirely — or a usage reached through a re-export or a path " +
	"alias. Nothing here resolves types, so confirm before renaming or deleting.";

/**
 * Does an import specifier plausibly refer to `definingPath`?
 *
 * Deliberately a heuristic on the FILE NAME, not a resolver: honouring tsconfig paths,
 * package exports, index resolution and extension order needs the build system's own
 * logic, and half-implementing it would produce confident wrong answers. So the test is
 * narrow — the specifier's last meaningful segment must equal the defining file's base
 * name — and everything it cannot prove stays `unverified` rather than being called a
 * mismatch.
 *
 * `./tools/struct-view` matches `struct-view.ts` and `struct-view/index.ts`; a bare
 * `@server/lib/agent/tools/struct-view` matches the same way, since only the tail is
 * compared.
 *
 * BARREL IMPORTS COUNT. A specifier naming the defining file's own DIRECTORY resolves to
 * that directory's index, which is how most of a codebase reaches a symbol — importing
 * `../../structural` rather than `../../structural/cross-file-usages`. Excluding those
 * left genuine usages sitting in the unverified group, which is the same failure this
 * check was added to fix, one level up. The residual risk is a barrel that re-exports a
 * DIFFERENT same-named symbol from a sibling file; the caveat already says matching is
 * name-based, and that beats calling every barrel import unverifiable.
 */
export function importMayReferTo(specifier: string, definingPath: string): boolean {
	const spec = specifier.trim().replace(/\\/g, "/").replace(/\/+$/, "");
	if (spec.length === 0) return false;
	const normalizedDef = definingPath.replace(/\\/g, "/");
	const defFile = normalizedDef.split("/").pop() ?? "";
	const defBase = defFile.replace(/\.[^.]+$/, "");
	if (defBase.length === 0) return false;
	const parentDir = normalizedDef.split("/").at(-2) ?? "";

	const segments = spec.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
	let tail = segments[segments.length - 1] ?? "";
	tail = tail.replace(/\.[^.]+$/, "");
	if (tail.length === 0) return false;

	// A directory import resolves to its index file, so the directory name is what should
	// match. An explicit `./index` names the same file directly and counts too.
	if (defBase === "index") return tail === parentDir || tail === "index";
	if (tail === defBase) return true;
	// Barrel: the specifier names the directory the defining file lives in.
	return parentDir.length > 0 && tail === parentDir;
}
