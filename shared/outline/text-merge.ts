/**
 * Text differences and three-way merges of block source text, shared by the live editor (its
 * local edits are diffed against what it last showed and rebased over remote changes) and the
 * server (a write made outside the live session is merged into the session's text).
 *
 * Diffs work on tokens (a word, one CJK character, a run of whitespace, one other character) so
 * a hunk never splits a word, and come out as character ranges. The token diff is Myers' with a
 * bounded edit distance: past {@link MAX_EDIT_TOKENS} differing tokens, or once the work would
 * exceed {@link MAX_DIFF_WORK}, the middle is replaced as one hunk. A coarser diff is still a
 * correct diff (applying it gives the target); it only merges less finely, which matters for
 * strict merges and never loses text.
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

/** Differing tokens past which the middle of a diff becomes one hunk. */
export const MAX_EDIT_TOKENS = 600;
/** Snake steps (roughly `(n + m) * d`) one token diff may spend. */
export const MAX_DIFF_WORK = 2_000_000;

function tokenize(s: string): string[] {
	return s.match(TOKEN_RE) ?? [];
}

/** One hunk from the common prefix and suffix: typing changes one place, so this is enough. */
export function simpleDiff(a: string, b: string): Hunk | null {
	if (a === b) return null;
	let p = 0;
	const max = Math.min(a.length, b.length);
	while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
	let s = 0;
	while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
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

/** Hunks turning `a` into `b`, aligned on tokens (see the module header for the bound). */
export function diffHunks(a: string, b: string): Hunk[] {
	if (a === b) return [];
	let p = 0;
	const max = Math.min(a.length, b.length);
	while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
	let s = 0;
	while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
	const am = a.slice(p, a.length - s);
	const bm = b.slice(p, b.length - s);
	const ta = tokenize(am);
	const tb = tokenize(bm);
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
	| { ok: false; current: string; conflicts: Array<{ mine: Hunk; theirs: Hunk }> };

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
 *     as the current text (an agent re-reads instead of writing over someone's edit);
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
	const mh0 = diffHunks(base, mine);
	if (base === theirs) return { ok: true, result: mine, patch: mh0 };
	if (mine === theirs) return { ok: true, result: theirs, patch: [] };
	if (mh0.length === 0) return { ok: true, result: theirs, patch: [] };
	const th = diffHunks(base, theirs);
	// A change both sides made identically is made once.
	const same = (a: Hunk, b: Hunk) => a.start === b.start && a.end === b.end && a.text === b.text;
	const mh = mh0.filter((m) => !th.some((t) => same(m, t)));
	if (mh.length === 0) return { ok: true, result: theirs, patch: [] };
	const conflicts: Array<{ mine: Hunk; theirs: Hunk }> = [];
	for (const m of mh)
		for (const t of th) if (overlaps(m, t)) conflicts.push({ mine: m, theirs: t });
	if (conflicts.length && !opts.lenient) return { ok: false, current: theirs, conflicts };
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
	const patch: Hunk[] = mh.map((m) => {
		const s = mapStart(m.start);
		const e = m.start === m.end ? s : Math.max(s, mapEnd(m.end));
		return { start: Math.min(s, theirs.length), end: Math.min(e, theirs.length), text: m.text };
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
