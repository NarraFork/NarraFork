/**
 * knowledge-excerpt.ts — turn a knowledge entry's Markdown body into a one-line
 * plain-text excerpt.
 *
 * ## The bug this exists to fix
 *
 * An injected knowledge hit carries a `summary` produced by flattening the entry's
 * body (`text.replace(/\s+/g, " ")`). Flattening Markdown does NOT neutralize it — it
 * makes it worse: the body's first line is almost always `# Some Title`, so after the
 * collapse the ENTIRE excerpt sits behind one `#` and renders as a single giant H1,
 * with the surviving `>`, `` ` `` and `-` markers scattered through it as debris. The
 * screenshot that prompted this had a 300-character display-size heading where a
 * two-line excerpt belonged.
 *
 * So a flattened body must be stripped to prose BEFORE it is stored or shown. Two
 * call sites use this, deliberately:
 *
 *   - the server, when it builds the hit (`knowledge-injection.summarize`) — so new
 *     rows are clean at rest;
 *   - the reader-facing projection, when it paints one — so rows ALREADY stored with
 *     a raw-Markdown excerpt render decently too. The transform is idempotent, which
 *     is what makes applying it twice safe.
 *
 * ## Why strip rather than render
 *
 * The excerpt's job is to answer "is this entry worth opening", in one or two lines,
 * inside a bubble whose header already names the entry. Structure has nothing to
 * contribute at that size: a heading, a list bullet and a blockquote marker all mean
 * the same thing here, which is "this came from further down the document". The
 * document itself is one click away, formatted.
 *
 * Zero DOM, zero React, no `server/` imports — the server generates with it and the
 * shared layout projection displays with it.
 */

/** Hard ceiling on a produced excerpt. Callers may ask for less. */
export const KNOWLEDGE_EXCERPT_MAX_CHARS = 320;

/**
 * A fenced code block's delimiter, or an indented-code line we keep as-is.
 *
 * Fences are dropped along with their CONTENT: a flattened code block reads as
 * line-noise in a prose excerpt, and it is never what identifies an entry.
 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** A setext underline (`===` / `---` under a heading) and thematic breaks. */
const RULE_RE = /^\s{0,3}([-*_=])\1{2,}\s*$/;

/** A table delimiter row: `|---|:--:|`. */
const TABLE_DELIM_RE = /^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/**
 * Line-leading block markers, stripped in one pass.
 *
 * Order matters: blockquote arrows come before list markers so `> - item` loses both.
 * Applied repeatedly (see `stripLinePrefixes`) because nesting is arbitrary.
 */
const LINE_PREFIX_RE = /^\s*(?:>+\s*|#{1,6}\s+|[-*+]\s+|\d{1,9}[.)]\s+)/;

/**
 * Block markers stranded MID-LINE by an earlier flattening pass.
 *
 * Load-bearing for the actual data: a stored `summary` is a body that already went
 * through `\s+ → " "`, so its second heading arrives as `… 踩坑 ## 1. fork 情况 …` where
 * no line-leading rule can reach it. Only applied to input that has no newlines — a
 * genuine multi-line body has its markers at line starts, where `LINE_PREFIX_RE`
 * handles them with no ambiguity at all.
 *
 * Restricted to the two markers that cannot plausibly be prose:
 *
 *   - an ATX run followed by a space (`## `). A `#` in real text is glued to what it
 *     labels (`#42`, `C#`), so the trailing space is what distinguishes them.
 *   - a blockquote arrow run followed by a space (`> `).
 *
 * List markers are deliberately NOT included: mid-line, `- ` and `1. ` are ordinary
 * punctuation far more often than flattened structure, and removing them would damage
 * prose to tidy debris that renders as plain characters anyway.
 *
 * ⚠️ Known trade-off: a bare comparison in flattened prose (`5 > 3`) loses its
 * operator. Accepted — an excerpt is a two-line "is this worth opening" cue, and
 * carrying quote debris into every excerpt is the worse of the two.
 */
const INLINE_BLOCK_MARKER_RE = /(^|\s)(?:#{1,6}|>+)\s+/g;

function stripInlineBlockMarkers(text: string): string {
	return text.replace(INLINE_BLOCK_MARKER_RE, "$1");
}

function stripLinePrefixes(line: string): string {
	let out = line;
	// Bounded: every iteration removes at least one character, and the guard stops
	// pathological inputs (`>>>>>>…`) from costing more than the line's own length.
	for (let i = 0; i < 8; i++) {
		const next = out.replace(LINE_PREFIX_RE, "");
		if (next === out) break;
		out = next;
	}
	return out;
}

/**
 * Reduce inline Markdown to the text it decorates.
 *
 * Links keep their LABEL and drop the target: a url inside a one-line excerpt costs
 * more width than it explains. An image keeps its alt text for the same reason.
 */
function stripInline(text: string): string {
	return (
		text
			// `![alt](src)` → alt, before the link rule so the `!` cannot survive.
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			// `[label](href)` → label.
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// Reference-style `[label][ref]` and bare `[label]` → label.
			.replace(/\[([^\]]*)\](?:\[[^\]]*\])?/g, "$1")
			// Inline code: keep the code, drop the ticks.
			.replace(/`+([^`]*)`+/g, "$1")
			// Strong / strike.
			.replace(/\*\*(.*?)\*\*/g, "$1")
			.replace(/~~(.*?)~~/g, "$1")
			// Single-marker emphasis. `*` works mid-word; `_` does NOT — CommonMark only
			// opens underscore emphasis at a word boundary, and ignoring that is how a
			// naive rule turns `ask_in_passing` into `askinpassing`. The lookarounds
			// reproduce the real parser's rule so identifiers survive.
			.replace(/\*(?!\s)(.*?)(?<!\s)\*/g, "$1")
			.replace(/(?<![0-9A-Za-z])__(?!\s)(.*?)(?<!\s)__(?![0-9A-Za-z])/g, "$1")
			.replace(/(?<![0-9A-Za-z])_(?!\s)(.*?)(?<!\s)_(?![0-9A-Za-z])/g, "$1")
	);
}

/**
 * Strip YAML frontmatter, when the body opens with it.
 *
 * A knowledge entry written with frontmatter would otherwise contribute its metadata
 * keys as the excerpt's first words, which is the least informative text in the file.
 */
function dropFrontmatter(lines: string[]): string[] {
	if (lines[0]?.trim() !== "---") return lines;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (line === "---" || line === "...") return lines.slice(i + 1);
	}
	// No closing delimiter: not frontmatter after all, so keep everything.
	return lines;
}

function normalizeLoose(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Loose equality for "this line is just the entry's title again". */
function sameText(a: string, b: string): boolean {
	const norm = normalizeLoose(a);
	return norm.length > 0 && norm === normalizeLoose(b);
}

/**
 * Drop a leading repetition of the entry title from an excerpt.
 *
 * The line-based path already skips a first LINE equal to the title, but a stored
 * `summary` was flattened before it got here, so the title is a PREFIX of one long line
 * rather than a line of its own — exactly the case in the report, where the bubble header
 * and the first ~20 characters of its body said the same thing.
 *
 * Prefix-only and boundary-checked: a title that merely happens to be a substring
 * further in, or one that runs into the following word, is left alone.
 */
function dropTitlePrefix(text: string, title: string): string {
	const normTitle = normalizeLoose(title);
	if (!normTitle) return text;
	if (!normalizeLoose(text).startsWith(normTitle)) return text;
	// Walk the ORIGINAL string in step with the normalized comparison so the cut lands on
	// a real offset (normalization can collapse runs of whitespace).
	//
	// The normalized side advances by the LOWERCASED length of each source character, not
	// by the source length. `toLowerCase()` is not always length-preserving — German ß
	// becomes "ss", and a handful of other characters expand the same way — so counting
	// source units against a normalized offset drifts by one unit per such character and
	// cuts in the wrong place (a title containing ß used to consume the whole string and
	// return empty). Per-character lowercasing can pick a different letter than
	// lowercasing the whole string does (Greek final sigma), but never a different
	// LENGTH, which is the only thing this loop reads from it.
	let consumed = 0;
	let matched = 0;
	while (consumed < text.length && matched < normTitle.length) {
		const ch = text[consumed] as string;
		if (/\s/.test(ch)) {
			// A whitespace run in the source corresponds to at most one space in the
			// normalized form.
			if (normTitle[matched] === " ") matched++;
			consumed++;
			continue;
		}
		matched += ch.toLowerCase().length;
		consumed += ch.length;
	}
	/*
	 * Nothing but the title → EMPTY, deliberately, matching the per-line path (which
	 * skips a title-only first line and then has nothing left).
	 *
	 * Empty is the useful answer rather than a degenerate one: it is the signal an entry
	 * has no excerpt worth a bubble, and the injection adapter uses exactly that to keep
	 * the hit in the compact list instead of drawing a bubble whose body repeats its own
	 * header. Returning the title here would manufacture that empty shell.
	 */
	return text
		.slice(consumed)
		.replace(/^[\s:：\-—–·|]+/, "")
		.trim();
}

/**
 * Project a Markdown body to a single-line plain-text excerpt.
 *
 * @param markdown  the entry body (or an already-flattened excerpt — the transform is
 *                  idempotent, so a stored value can be re-run on the way to the screen)
 * @param title     the entry's title, when known. A leading line that merely repeats it
 *                  is dropped: the bubble header already shows the title, and the
 *                  duplicate cost the excerpt its most valuable first line.
 * @param maxChars  ceiling for the result, ellipsized when it bites
 */
export function knowledgeExcerpt(
	markdown: string,
	{ title, maxChars = KNOWLEDGE_EXCERPT_MAX_CHARS }: { title?: string; maxChars?: number } = {},
): string {
	if (!markdown) return "";
	// The input is already bounded by its producer (a 512-char column slice server-side,
	// a stored excerpt on the display path), but a cap here keeps the line scan
	// proportional to what can ever be shown even if a caller hands over a whole file.
	const source = markdown.length > 8000 ? markdown.slice(0, 8000) : markdown;

	const lines = dropFrontmatter(source.split(/\r?\n/));
	// Whether the input still HAS lines decides how mid-line markers are treated: a real
	// body keeps its structure at line starts, while a stored (already flattened) excerpt
	// has it stranded mid-line. See INLINE_BLOCK_MARKER_RE on why the looser rule is not
	// applied to both.
	const wasFlattened = lines.length === 1;
	const parts: string[] = [];
	let inFence = false;
	let droppedTitle = false;

	for (const raw of lines) {
		if (FENCE_RE.test(raw)) {
			// A fence toggles the skip state; its content contributes nothing.
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (RULE_RE.test(raw) || TABLE_DELIM_RE.test(raw)) continue;

		const stripped = stripLinePrefixes(raw);
		const text = stripInline(wasFlattened ? stripInlineBlockMarkers(stripped) : stripped)
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		// Only the FIRST surviving line is title-checked. A later paragraph that happens
		// to restate the title is real content in its own position.
		if (!droppedTitle) {
			droppedTitle = true;
			if (title && sameText(text, title)) continue;
		}
		parts.push(text);
		// Stop once there is demonstrably enough text to fill the cap; the join below
		// decides the exact cut.
		if (parts.join(" ").length >= maxChars) break;
	}

	let flat = parts.join(" ").replace(/\s+/g, " ").trim();
	// A flattened input's title repetition is a PREFIX, not a line, so the per-line check
	// above could not see it.
	if (title && flat) flat = dropTitlePrefix(flat, title);
	return flat.length > maxChars ? `${sliceCodePoints(flat, maxChars)}…` : flat;
}

/**
 * Cut to at most `maxChars` UTF-16 code units without splitting a surrogate pair.
 *
 * `slice(0, n)` counts code units, so a cut that lands between the high and low halves of
 * an astral character (every emoji, and the CJK extension blocks — 𠮟, 𩸽 — that show up
 * in real knowledge entries) leaves a lone surrogate. A lone surrogate is not a valid
 * character: it renders as U+FFFD, and it survives JSON round-trips as an unpaired
 * escape, so the damage reaches the stored excerpt and not just one paint.
 *
 * The result is at most `maxChars` units and never more, i.e. dropping the orphaned half
 * rather than keeping its partner. Length is what the cap promises; one lost character at
 * the boundary is invisible next to the ellipsis that follows it.
 *
 * Grapheme clusters are deliberately NOT preserved. A family emoji or a flag can be split
 * into its component code points, which still render as valid characters — unlike a lone
 * surrogate. Segmenting properly would mean `Intl.Segmenter` over the whole string on
 * every excerpt, which is not worth it for a two-line cue.
 */
function sliceCodePoints(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	const code = text.charCodeAt(maxChars - 1);
	// A high surrogate in the last kept position means its low half is the first dropped
	// unit, so the pair straddles the cut.
	const straddles = code >= 0xd800 && code <= 0xdbff;
	return text.slice(0, straddles ? maxChars - 1 : maxChars);
}
