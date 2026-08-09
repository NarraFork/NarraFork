/**
 * Which single letter the git panel shows for a file, per section.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 * A porcelain status is TWO independent characters: X (index) and Y (worktree).
 * The panel renders a file in the Staged section when X says something, and in
 * the Changes section when Y does — so one file can legitimately appear twice
 * with a different verdict in each place. `AM` is a brand-new file that is
 * staged (X=A) and has been edited again since (Y=M).
 *
 * The badge used to be built by stripping spaces from the raw status, which
 * concatenated both verdicts: `AM`, `MM`, `AD` are not keys in the status
 * registry, so they fell through to the gray fallback and lost their colour
 * along with their meaning. Only the accidentally-one-char cases (`A `, ` M`,
 * `D `) ever looked right.
 *
 * ── Why untracked reads as "A" ──────────────────────────────────────────────
 * Git writes `??` because the file is not in the index yet, but the panel's two
 * sections ALREADY carry the staged/unstaged axis. So the badge only has to say
 * what KIND of change this is, and a file the user just created is an addition
 * whether or not it has been staged. `A` in the Changes section means "new, not
 * staged"; `A` under Staged means "new, staged".
 *
 * PURE: no React, no DOM, so the mapping is testable on its own.
 */

/** Which half of the porcelain status a row is showing. */
export type GitFileSection = "staged" | "unstaged";

/** Porcelain letters the status registry knows how to colour. */
const KNOWN_CHARS = new Set(["A", "M", "D", "R", "C", "U"]);

/**
 * Whether a porcelain pair is a merge conflict.
 *
 * Git spells these with `U` on either side, plus the two same-letter pairs `AA`
 * (both added) and `DD` (both deleted). Every one of them used to render as a
 * two-letter gray badge; they are the same concatenation bug, so they are
 * classified here rather than left to the fallback.
 */
export function isUnmergedStatus(status: string): boolean {
	const x = status[0];
	const y = status[1];
	if (x === "U" || y === "U") return true;
	return (x === "A" && y === "A") || (x === "D" && y === "D");
}

/**
 * The badge letter for `status` as seen from `section`.
 *
 * Total: an unexpected or truncated status degrades to `M` rather than producing
 * an unmapped key, because a wrong-but-coloured badge is still readable while a
 * gray two-letter blob is what this replaced.
 */
export function gitFileBadgeChar(status: string, section: GitFileSection): string {
	// Conflicts are a property of the pair, not of one side, so they take
	// precedence over the per-section pick below.
	if (isUnmergedStatus(status)) return "U";
	// Untracked: `??`. The file exists only in the worktree, which makes it an
	// addition from the user's point of view.
	if (status.startsWith("?")) return "A";

	const own = section === "staged" ? status[0] : status[1];
	if (own && own !== " " && own !== "?" && KNOWN_CHARS.has(own)) return own;

	// The section's own half says nothing usable (e.g. a row shown for the other
	// half). Fall back to whichever side does carry a verdict.
	const other = section === "staged" ? status[1] : status[0];
	if (other && other !== " " && other !== "?" && KNOWN_CHARS.has(other)) return other;
	return "M";
}
