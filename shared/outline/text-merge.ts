/**
 * Text differences and three-way merges of block source text, shared by the live editor (its
 * local edits are diffed against what it last showed and rebased over remote changes) and the
 * server (a write made outside the live session is merged into the session's text).
 *
 * Diffs work on tokens (a word, one CJK character, a run of whitespace, one other character) and
 * come out as character ranges. `diffHunks` first takes off the common prefix and suffix
 * character by character (so typing inside a word is a small insertion, which is what the editor
 * wants), and aligns only the middle on tokens; `diffTokenHunks` aligns the whole text on the
 * coarser tokens of strict merges (below), so a change inside a word replaces the word on both
 * sides. The token diff is Myers' with a bounded edit distance: past {@link MAX_EDIT_TOKENS}
 * differing tokens, or once the work would exceed {@link MAX_DIFF_WORK}, the middle is replaced
 * as one hunk. A coarser diff is still a correct diff (applying it gives the target); it only
 * merges less finely, which matters for strict merges and never loses text.
 *
 * No hunk ever starts or ends inside a surrogate pair: a common prefix or suffix that ends
 * between the two halves of a character gives the half back. Yjs replaces a lone half with
 * U+FFFD, so a patch that splits one (🔴 → 🟢 share their first half) corrupts live text.
 *
 * Pure functions: no DOM, no Node globals (the purity guard covers this directory).
 */

/** Replace `a[start, end)` with `text`. */
export interface Hunk {
	start: number;
	end: number;
	text: string;
}

/** Yjs-style delta (retain / insert / delete), for mapping offsets across versions. */
export type DeltaOp = { retain: number } | { insert: string } | { delete: number };

const TOKEN_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[\s\S]/gu;

/** Scripts written without spaces between words: one character is one token. */
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
/** A letter, digit or mark of a word written with spaces (marks: vowel signs, NFD accents). */
const WORD_CHAR = `(?:(?![${CJK}])[\\p{L}\\p{N}\\p{M}_])`;
const EMOJI_TAIL = "[\\p{Emoji_Modifier}\\uFE0F\\u20E3]*";
/**
 * Tokens of strict merges: what one person changes as a unit. Versus {@link TOKEN_RE}: marks stay
 * with their letter; a run of letters and digits joined by `. : / - , '` is one token (dates,
 * versions, times, amounts, contractions); an emoji with its modifiers, variation selectors and
 * ZWJ joins is one token, as is a flag (two regional indicators).
 */
const STRICT_TOKEN_RE = new RegExp(
	[
		"\\p{Regional_Indicator}{2}",
		`\\p{Extended_Pictographic}${EMOJI_TAIL}(?:\\u200D\\p{Extended_Pictographic}${EMOJI_TAIL})*`,
		`[${CJK}]\\p{M}*`,
		`${WORD_CHAR}+(?:[.:/\\-,'\u2019]${WORD_CHAR}+)*`,
		"\\s+",
		"[\\s\\S]\\p{M}*",
	].join("|"),
	"gu",
);
/** A character that is part of a word (not whitespace, not punctuation). */
const WORDLIKE_RE = /[\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Regional_Indicator}_]/u;

/** Differing tokens past which the middle of a diff becomes one hunk. */
export const MAX_EDIT_TOKENS = 600;
/** Snake steps (roughly `(n + m) * d`) one token diff may spend. */
export const MAX_DIFF_WORK = 2_000_000;

function tokenize(s: string): string[] {
	return s.match(TOKEN_RE) ?? [];
}

function isHigh(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Lengths of the common prefix and suffix of `a` and `b` (not overlapping), never ending or
 * starting between the two halves of a surrogate pair.
 */
function commonEnds(a: string, b: string): [prefix: number, suffix: number] {
	let p = 0;
	const max = Math.min(a.length, b.length);
	while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
	if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
	let s = 0;
	while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
	if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
	return [p, s];
}

/** One hunk from the common prefix and suffix: typing changes one place, so this is enough. */
export function simpleDiff(a: string, b: string): Hunk | null {
	if (a === b) return null;
	const [p, s] = commonEnds(a, b);
	return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}

/**
 * Matched token pairs `(i, j)` with `a[i] === b[j]`, in order, or null when the edit distance is
 * over the bound (the caller then replaces the whole range).
 */
function myers(a: readonly string[], b: readonly string[]): Array<[number, number]> | null {
	const n = a.length;
	const m = b.length;
	const maxD = Math.min(n + m, MAX_EDIT_TOKENS);
	const offset = maxD + 1;
	const v = new Int32Array(2 * maxD + 3);
	const trace: Int32Array[] = [];
	let work = 0;
	let found = false;
	outer: for (let d = 0; d <= maxD; d++) {
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number)))
				x = v[offset + k + 1] as number;
			else x = (v[offset + k - 1] as number) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
				work++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = true;
				break outer;
			}
		}
		work += 2 * d + 1;
		if (work > MAX_DIFF_WORK) return null;
	}
	if (!found) return null;
	const pairs: Array<[number, number]> = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vv = trace[d] as Int32Array;
		// `vv` holds diagonals -d-1 … d+1 of the state before round d.
		const at = (k: number) => vv[k + d + 1] as number;
		const k = x - y;
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const prevX = d === 0 ? 0 : at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			pairs.push([x, y]);
		}
		if (d > 0) {
			x = prevX;
			y = prevY;
		}
	}
	pairs.reverse();
	return pairs;
}

/** Hunks turning `a` into `b`, the middle aligned on tokens (see the module header). */
export function diffHunks(a: string, b: string): Hunk[] {
	if (a === b) return [];
	// The middles start and end on whole characters, and tokens never split one (`u` flag).
	const [p, s] = commonEnds(a, b);
	return tokenHunks(
		a,
		b,
		p,
		s,
		tokenize(a.slice(p, a.length - s)),
		tokenize(b.slice(p, b.length - s)),
	);
}

/**
 * Hunks turning `a` into `b`, aligned on whole tokens of both: a hunk starts and ends where
 * tokens of `a` and of `b` start and end, so a change inside a word replaces the word.
 */
export function diffTokenHunks(a: string, b: string): Hunk[] {
	if (a === b) return [];
	const ta = a.match(STRICT_TOKEN_RE) ?? [];
	const tb = b.match(STRICT_TOKEN_RE) ?? [];
	let i = 0;
	let p = 0;
	while (i < ta.length && i < tb.length && ta[i] === tb[i]) p += (ta[i++] as string).length;
	let j = 0;
	let s = 0;
	while (j < ta.length - i && j < tb.length - i && ta[ta.length - 1 - j] === tb[tb.length - 1 - j])
		s += (ta[ta.length - 1 - j++] as string).length;
	return tokenHunks(a, b, p, s, ta.slice(i, ta.length - j), tb.slice(i, tb.length - j));
}

/**
 * Hunks of `a` → `b` given their common prefix (`p` characters) and suffix (`s`) and the tokens
 * of the middles.
 */
function tokenHunks(
	a: string,
	b: string,
	p: number,
	s: number,
	ta: readonly string[],
	tb: readonly string[],
): Hunk[] {
	const bm = b.slice(p, b.length - s);
	const pairs = myers(ta, tb);
	if (pairs === null) return [{ start: p, end: a.length - s, text: bm }];
	const offA: number[] = [0];
	for (const t of ta) offA.push((offA[offA.length - 1] as number) + t.length);
	const offB: number[] = [0];
	for (const t of tb) offB.push((offB[offB.length - 1] as number) + t.length);
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	const flush = (ni: number, nj: number) => {
		if (ni > i || nj > j) {
			hunks.push({
				start: p + (offA[i] as number),
				end: p + (offA[ni] as number),
				text: bm.slice(offB[j] as number, offB[nj] as number),
			});
		}
	};
	for (const [pi, pj] of pairs) {
		flush(pi, pj);
		i = pi + 1;
		j = pj + 1;
	}
	flush(ta.length, tb.length);
	return hunks;
}

/** Apply ordered, non-overlapping hunks. */
export function applyHunks(a: string, hunks: readonly Hunk[]): string {
	let out = "";
	let pos = 0;
	for (const h of hunks) {
		out += a.slice(pos, h.start) + h.text;
		pos = h.end;
	}
	return out + a.slice(pos);
}

export function hunksToDelta(hunks: readonly Hunk[]): DeltaOp[] {
	const out: DeltaOp[] = [];
	let pos = 0;
	for (const h of hunks) {
		if (h.start > pos) out.push({ retain: h.start - pos });
		if (h.end > h.start) out.push({ delete: h.end - h.start });
		if (h.text) out.push({ insert: h.text });
		pos = h.end;
	}
	return out;
}

/**
 * An offset in the old text mapped into the text after `delta`. `assoc < 0`: an insertion at
 * exactly `pos` stays after it (the offset keeps to the left); `> 0`: the offset moves past it.
 */
export function mapOffset(delta: readonly DeltaOp[], pos: number, assoc = 1): number {
	let oldPos = 0;
	let newPos = 0;
	for (const op of delta) {
		if ("retain" in op) {
			if (pos < oldPos + op.retain) return newPos + (pos - oldPos);
			oldPos += op.retain;
			newPos += op.retain;
		} else if ("delete" in op) {
			if (pos < oldPos + op.delete) return newPos;
			oldPos += op.delete;
		} else {
			if (pos === oldPos && assoc < 0) return newPos;
			newPos += op.insert.length;
		}
	}
	return newPos + (pos - oldPos);
}

export type Merge3Result =
	| { ok: true; result: string /** Applied to `theirs`, in its coordinates. */; patch: Hunk[] }
	| {
			ok: false;
			current: string;
			/** The overlapping changes, as ranges of `base` (strict merges align them on tokens). */
			conflicts: Array<{ mine: Hunk; theirs: Hunk }>;
	  };

/** The code point of `s` that ends at `at` (undefined at the start). */
function codePointBefore(s: string, at: number): string | undefined {
	if (at <= 0) return undefined;
	const start =
		at >= 2 && isLow(s.charCodeAt(at - 1)) && isHigh(s.charCodeAt(at - 2)) ? at - 2 : at - 1;
	return s.slice(start, at);
}

/** The code point of `s` that starts at `at` (undefined at the end). */
function codePointAt(s: string, at: number): string | undefined {
	const cp = s.codePointAt(at);
	return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/**
 * Whether `left` ends where `right` starts and the two meet inside a word: the character the
 * merged text has on each side of the meeting point is part of a word (not whitespace, not
 * punctuation). Changes of adjacent characters of one word written without spaces (Chinese) or
 * a word extended right where the other side changed it are then one change.
 */
function meetInWord(base: string, left: Hunk, right: Hunk): boolean {
	if (left.end !== right.start) return false;
	const l = left.text
		? codePointBefore(left.text, left.text.length)
		: codePointBefore(base, left.start);
	const r = right.text ? codePointAt(right.text, 0) : codePointAt(base, right.end);
	return l !== undefined && r !== undefined && WORDLIKE_RE.test(l) && WORDLIKE_RE.test(r);
}

function overlaps(a: Hunk, b: Hunk): boolean {
	const aIns = a.start === a.end;
	const bIns = b.start === b.end;
	if (aIns && bIns) return a.start === b.start;
	if (aIns) return a.start > b.start && a.start < b.end;
	if (bIns) return b.start > a.start && b.start < a.end;
	return a.start < b.end && b.start < a.end;
}

/**
 * Three-way merge: the change `base → mine` applied onto `theirs` (which went `base → theirs`
 * meanwhile).
 *
 *   - strict (the default): changes that overlap theirs reject the merge, returning `theirs`
 *     as the current text (an agent re-reads instead of writing over someone's edit). Both
 *     sides are diffed on whole tokens (`diffTokenHunks`), so changes to one word overlap even
 *     where their characters do not (`two` → `TWO` against `two` → `twos`, `2026-10-27` →
 *     `-28` against → `2026-11-27`). Changes that only touch (one ends where the other starts)
 *     overlap when they meet inside a word (`重点` → `要点` against `重点` → `重心`; `完成` →
 *     `完结` against `完成了`), and do not when whitespace or punctuation is at the meeting point
 *     (a word changed, a sentence added after it); two insertions at one place always overlap;
 *   - `lenient`: never rejects; an overlapping hunk is placed where its start maps to, and an
 *     insertion at the same place as theirs goes after theirs. Used where both sides are kept
 *     no matter what (a person's replayed edits, an outside write into a live session).
 */
export function merge3(
	base: string,
	mine: string,
	theirs: string,
	opts: { lenient?: boolean } = {},
): Merge3Result {
	const diff = opts.lenient ? diffHunks : diffTokenHunks;
	const mh0 = diff(base, mine);
	if (base === theirs) return { ok: true, result: mine, patch: mh0 };
	if (mine === theirs) return { ok: true, result: theirs, patch: [] };
	if (mh0.length === 0) return { ok: true, result: theirs, patch: [] };
	const th = diff(base, theirs);
	// A change both sides made identically is made once.
	const same = (a: Hunk, b: Hunk) => a.start === b.start && a.end === b.end && a.text === b.text;
	const mh = mh0.filter((m) => !th.some((t) => same(m, t)));
	if (mh.length === 0) return { ok: true, result: theirs, patch: [] };
	if (!opts.lenient) {
		const conflicts: Array<{ mine: Hunk; theirs: Hunk }> = [];
		for (const m of mh)
			for (const t of th) {
				if (overlaps(m, t) || meetInWord(base, m, t) || meetInWord(base, t, m))
					conflicts.push({ mine: m, theirs: t });
			}
		if (conflicts.length) return { ok: false, current: theirs, conflicts };
	}
	// Map each of mine from base coordinates to theirs: the start counts an insertion of theirs
	// exactly there (mine goes after it), the end does not.
	const delta = (t: Hunk) => t.text.length - (t.end - t.start);
	const mapStart = (pos: number) =>
		pos + th.filter((t) => t.end <= pos).reduce((n, t) => n + delta(t), 0);
	const mapEnd = (pos: number) =>
		pos +
		th
			.filter((t) => t.end < pos || (t.end === pos && t.start < t.end))
			.reduce((n, t) => n + delta(t), 0);
	// A lenient merge maps an overlapping hunk by base offsets, which can land between the two
	// halves of a character of theirs: such an end is pulled back and such a start pushed on, so
	// the hunk never cuts (nor removes) that character.
	const inPair = (at: number) =>
		at > 0 &&
		at < theirs.length &&
		isHigh(theirs.charCodeAt(at - 1)) &&
		isLow(theirs.charCodeAt(at));
	const patch: Hunk[] = mh.map((m) => {
		let s = Math.min(mapStart(m.start), theirs.length);
		let e = m.start === m.end ? s : Math.min(Math.max(s, mapEnd(m.end)), theirs.length);
		if (inPair(s)) s++;
		if (inPair(e)) e--;
		if (e < s) e = s;
		return { start: s, end: e, text: m.text };
	});
	patch.sort((a, b) => a.start - b.start);
	// Lenient merges can map hunks onto each other: clip so they apply one after another.
	for (let i = 1; i < patch.length; i++) {
		const prev = patch[i - 1] as Hunk;
		const cur = patch[i] as Hunk;
		if (cur.start < prev.end)
			patch[i] = { ...cur, start: prev.end, end: Math.max(cur.end, prev.end) };
	}
	return { ok: true, result: applyHunks(theirs, patch), patch };
}
