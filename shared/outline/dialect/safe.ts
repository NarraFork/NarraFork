/**
 * Write, then read back. The serializer's output is parsed again with the dialect parser
 * (marked@18) and compared character by character, marks included.
 *
 * CommonMark's flanking rules make some marks impossible to write. The common case is CJK text:
 * `这是**重点：**内容` (bold ending in full-width punctuation, followed directly by a Han
 * character) parses as literal asterisks. When that happens the punctuation at the edge of the
 * mark is moved outside it (`这是**重点**：内容`); if that is not enough, the mark is dropped
 * for that stretch. Guarantee: the text never changes; marks are only ever removed, never added.
 */
import { parseBlock } from "./parse";
import { canonicalBody, serializeBodyRaw } from "./serialize";
import type { Body, Inline, Mark, MentionNode, ParsedBlock } from "./types";

type Unit =
	| { kind: "ch"; ch: string; marks: Mark[] }
	| { kind: "atom"; node: MentionNode; marks: Mark[] }
	| { kind: "br"; marks: Mark[] };

const PUNCT = /[\p{P}\p{S}]/u;

/** Counters for diagnostics and tests. */
export const safeStats = { calls: 0, degraded: 0, dropped: 0, fixedPoint: 0 };

function toUnits(content: Inline[]): Unit[] {
	const out: Unit[] = [];
	for (const n of content) {
		if (n.type === "text") for (const ch of n.text) out.push({ kind: "ch", ch, marks: n.marks });
		else if (n.type === "mention") out.push({ kind: "atom", node: n, marks: n.marks });
		else out.push({ kind: "br", marks: [] });
	}
	return out;
}

function fromUnits(units: Unit[]): Inline[] {
	const out: Inline[] = [];
	for (const u of units) {
		if (u.kind === "br") out.push({ type: "br" });
		else if (u.kind === "atom") out.push({ ...u.node, marks: u.marks });
		else {
			const last = out[out.length - 1];
			if (last && last.type === "text" && marksKey(last.marks) === marksKey(u.marks))
				last.text += u.ch;
			else out.push({ type: "text", text: u.ch, marks: u.marks });
		}
	}
	return out;
}

function mk(m: Mark): string {
	return m.type === "link" ? `link:${m.href ?? ""}:${m.title ?? ""}` : m.type;
}

function marksKey(marks: Mark[]): string {
	return marks.map(mk).sort().join(",");
}

function unitKey(u: Unit | undefined): string {
	if (!u) return "∅";
	if (u.kind === "br") return "\n";
	if (u.kind === "atom") return `@${u.node.ref}|${u.node.label ?? ""}{${marksKey(u.marks)}}`;
	// Marks on whitespace are not visible, and the serializer moves edge whitespace out of them.
	if (/\s/.test(u.ch) && !u.marks.some((m) => m.type === "code")) return u.ch;
	return `${u.ch}{${marksKey(u.marks)}}`;
}

/** The inline containers of a body, in order. */
function containers(b: Body): Inline[][] {
	if (b.type === "table") return b.rows.flat();
	if (b.type === "paragraph" || b.type === "heading" || b.type === "quote") return [b.content];
	return [];
}

function withContainers(b: Body, cs: Inline[][]): Body {
	if (b.type === "table") {
		let k = 0;
		return { ...b, rows: b.rows.map((r) => r.map(() => cs[k++] as Inline[])) };
	}
	if (b.type === "paragraph" || b.type === "heading" || b.type === "quote")
		return { ...b, content: cs[0] as Inline[] };
	return b;
}

interface Diff {
	c: number;
	i: number;
	got: Unit[];
}

/** First difference between two canonical bodies of the same type, or null. */
function firstDiff(want: Body, got: Body): Diff | null {
	const A = containers(canonicalBody(want));
	const B = containers(canonicalBody(got));
	if (A.length !== B.length) return { c: 0, i: 0, got: [] };
	if (want.type === "table" && got.type === "table") {
		const sameAlign =
			want.align.length === got.align.length && want.align.every((a, i) => a === got.align[i]);
		if (!sameAlign) return { c: 0, i: 0, got: [] };
	}
	for (let c = 0; c < A.length; c++) {
		const a = toUnits(A[c] as Inline[]);
		const b = toUnits(B[c] as Inline[]);
		const n = Math.max(a.length, b.length);
		for (let i = 0; i < n; i++) if (unitKey(a[i]) !== unitKey(b[i])) return { c, i, got: b };
	}
	return null;
}

function without(marks: Mark[], key: string): Mark[] {
	return marks.filter((m) => mk(m) !== key);
}

/**
 * Finds the mark that failed to come back near unit `i`, then moves punctuation at its edges
 * outside it; when its edges are not punctuation, drops the mark for that stretch.
 */
function degrade(units: Unit[], i: number, parsed: Unit[]): boolean {
	const cur = units[Math.min(i, units.length - 1)];
	const prev = units[i - 1];
	const got = parsed[i];
	let culprit: string | null = null;
	if (cur && got && cur.kind === got.kind) {
		const want = new Set(cur.marks.map(mk));
		for (const m of got.marks) want.delete(mk(m));
		culprit = [...want][0] ?? null;
	}
	if (!culprit) {
		const a = new Set((prev?.marks ?? []).map(mk));
		const b = new Set((cur?.marks ?? []).map(mk));
		for (const k of a) if (!b.has(k)) culprit = culprit ?? k;
		for (const k of b) if (!a.has(k)) culprit = culprit ?? k;
	}
	if (!culprit) culprit = (cur?.marks ?? prev?.marks ?? []).map(mk)[0] ?? null;
	if (!culprit) return false;
	const key = culprit;
	const at = cur?.marks.some((m) => mk(m) === key) ? Math.min(i, units.length - 1) : i - 1;
	if (at < 0 || !units[at]?.marks.some((m) => mk(m) === key)) return false;
	let s = at;
	let e = at;
	while (s > 0 && units[s - 1]?.marks.some((m) => mk(m) === key)) s--;
	while (e + 1 < units.length && units[e + 1]?.marks.some((m) => mk(m) === key)) e++;
	const isP = (u: Unit) => u.kind === "ch" && PUNCT.test(u.ch);
	const strip = (k: number) => {
		const u = units[k] as Unit;
		units[k] = { ...u, marks: without(u.marks, key) } as Unit;
	};
	if (e > s && isP(units[e] as Unit)) {
		for (let k = e; k > s && isP(units[k] as Unit); k--) strip(k);
		return true;
	}
	if (e > s && isP(units[s] as Unit)) {
		for (let k = s; k < e && isP(units[k] as Unit); k++) strip(k);
		return true;
	}
	for (let k = s; k <= e; k++) strip(k);
	safeStats.dropped++;
	return true;
}

function stripMarks(b: Body): Body {
	return withContainers(
		b,
		containers(b).map((c) => c.map((n) => (n.type === "br" ? n : { ...n, marks: [] }))),
	);
}

/**
 * Writes `start` and reads it back; degrades the first mark that did not survive and tries
 * again. Returns the source and its parse, whose text equals the text of `start`.
 */
function writeChecked(start: Body, known?: Known): { s: string; parsed: Body } {
	let cur = canonicalBody(start);
	for (let attempt = 0; attempt < 16; attempt++) {
		const s = serializeBodyRaw(cur);
		const p = known && s === known.src ? known.parsed : parseBlock(s);
		if (p.extra.length || p.body.type !== cur.type) break;
		const d = firstDiff(cur, p.body);
		if (!d) {
			if (attempt > 0) safeStats.degraded++;
			return { s, parsed: p.body };
		}
		const cs = containers(cur);
		const units = toUnits(cs[d.c] as Inline[]);
		if (!degrade(units, d.i, d.got)) break;
		cs[d.c] = fromUnits(units);
		cur = canonicalBody(withContainers(cur, cs));
	}
	safeStats.dropped++;
	const s = serializeBodyRaw(stripMarks(cur));
	return { s, parsed: parseBlock(s).body };
}

/** A source whose parse is already known, so it need not be lexed again. */
interface Known {
	src: string;
	parsed: ParsedBlock;
}

/**
 * Canonical markdown for a block body. Parsing the result gives back the text of
 * `canonicalBody(body)`, with marks only removed where CommonMark cannot express them, and
 * serializing that parse gives the same string again (one content, one spelling).
 */
export function serializeBody(body: Body): string {
	return serializeChecked(body);
}

/**
 * `serializeBody`, reusing a known parse: when the output equals `known.src` (already canonical
 * input), it is not lexed again. Lexing dominates the cost of normalization.
 */
export function serializeChecked(body: Body, known?: Known): string {
	if (body.type === "code" || body.type === "embed") return serializeBodyRaw(body);
	safeStats.calls++;
	let { s, parsed } = writeChecked(body, known);
	// How marks nest can depend on which marks were already open, so the parse of `s` may be
	// spelled differently; iterate to the fixed point (at most one extra round in practice).
	for (let i = 0; i < 4; i++) {
		if (serializeBodyRaw(parsed) === s) return s;
		const next = writeChecked(parsed);
		if (next.s === s) return s;
		safeStats.fixedPoint++;
		s = next.s;
		parsed = next.parsed;
	}
	return s;
}

/**
 * Diagnostic comparison of an intended body with what came back from parsing its serialization.
 * `textEqual`: same characters, ignoring whitespace at the end of lines (and at both ends for
 * headings and cells), which can become plain text once a code mark is degraded and is then
 * normalized away; `extraMarks`: characters that gained a mark; `changed`: characters whose
 * marks differ at all.
 */
export function compareBodies(
	want: Body,
	got: Body,
): { textEqual: boolean; extraMarks: number; changed: number } {
	const A = containers(canonicalBody(want));
	const B = containers(canonicalBody(got));
	if (A.length !== B.length) return { textEqual: false, extraMarks: 0, changed: 0 };
	const trimStart = want.type === "heading" || want.type === "table";
	const isWs = (u: Unit | undefined) => u?.kind === "ch" && /\s/.test(u.ch);
	const lines = (content: Inline[]): Unit[][] => {
		const out: Unit[][] = [[]];
		for (const u of toUnits(content)) {
			if (u.kind === "br") out.push([]);
			else (out[out.length - 1] as Unit[]).push(u);
		}
		return out
			.map((l) => {
				while (isWs(l[l.length - 1])) l.pop();
				while (trimStart && isWs(l[0])) l.shift();
				return l;
			})
			.filter((l) => l.length > 0);
	};
	const txt = (l: Unit[]) =>
		l
			.map((x) => (x.kind === "ch" ? x.ch : x.kind === "atom" ? `[[${x.node.ref}]]` : "\n"))
			.join("");
	let extraMarks = 0;
	let changed = 0;
	for (let c = 0; c < A.length; c++) {
		const a = lines(A[c] as Inline[]);
		const b = lines(B[c] as Inline[]);
		if (a.length !== b.length) return { textEqual: false, extraMarks, changed };
		for (let l = 0; l < a.length; l++) {
			const la = a[l] as Unit[];
			const lb = b[l] as Unit[];
			if (txt(la) !== txt(lb)) return { textEqual: false, extraMarks, changed };
			for (let i = 0; i < la.length; i++) {
				const x = la[i] as Unit;
				const y = lb[i] as Unit;
				if (unitKey(x) === unitKey(y)) continue;
				changed++;
				const have = new Set(x.marks.map(mk));
				if (y.marks.some((m) => !have.has(mk(m)))) extraMarks++;
			}
		}
	}
	return { textEqual: true, extraMarks, changed };
}
