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

/** One file's hits: the path and the 1-based lines the identifier appears on. */
export interface UsageFile {
	path: string;
	lines: number[];
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
		files.push({ path: hit.path, lines: lines.slice(0, maxPerFile) });
	}

	// Most-referenced first: the files that use a symbol most are the ones a rename or a
	// deletion has to reckon with first.
	files.sort((a, b) => b.lines.length - a.lines.length || a.path.localeCompare(b.path));

	return {
		files,
		textOnlyFiles: textOnly,
		candidatesCapped: options.candidatesCapped === true,
		skipped: options.skipped ?? 0,
	};
}

/** The mandatory precision caveat, kept in one place so every caller states it identically. */
export const CROSS_FILE_PRECISION_NOTE =
	"Structural, not semantic: matches the name as an identifier, so a different symbol " +
	"with the same name is included and an `import { x as y }` alias is missed. Confirm " +
	"before renaming or deleting.";
