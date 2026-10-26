/**
 * 「写完再读一遍」：序列化后立即用同一个解析器（marked@18）解析回来，逐字比较文字和标记。
 * CommonMark 的左右侧规则让一些标记写不出来，例如 `这是**重点：**内容`（粗体以全角标点结尾、
 * 后面紧跟汉字）解析出来是字面的星号。这时把标记边缘的标点挪到标记外面；还不行就去掉这段标记。
 * 保证：文字不变，标记尽量少丢。
 */
import { parseBlock } from "./parse";
import { serializeBodyRaw } from "./serialize";
import type { Body, Inline, Mark } from "./types";

type Unit =
	| { kind: "ch"; ch: string; marks: Mark[] }
	| { kind: "atom"; node: Extract<Inline, { type: "mention" }>; marks: Mark[] }
	| { kind: "br"; marks: Mark[] };

const PUNCT = /[\p{P}\p{S}]/u;

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
			if (last && last.type === "text" && markKey(last.marks) === markKey(u.marks)) last.text += u.ch;
			else out.push({ type: "text", text: u.ch, marks: u.marks });
		}
	}
	return out;
}

function mk(m: Mark): string {
	return m.type === "link" ? `link:${m.href}:${m.title ?? ""}` : m.type;
}

function markKey(marks: Mark[]): string {
	return marks.map(mk).sort().join(",");
}

function unitKey(u: Unit | undefined): string {
	if (!u) return "∅";
	if (u.kind === "br") return "\n";
	if (u.kind === "atom") return `@${u.node.ref}|${u.node.label ?? ""}{${markKey(u.marks.filter((m) => m.type !== "code" && m.type !== "link"))}}`;
	if (/\s/.test(u.ch) && !u.marks.some((m) => m.type === "code")) return u.ch;
	return `${u.ch}{${markKey(u.marks)}}`;
}

/** 比较前两边都做的规范化：去掉首尾 / 连续换行和换行前的空白；标题、单元格去首尾空白。 */
function normUnits(units: Unit[], trim: boolean): Unit[] {
	const out: Unit[] = [];
	for (const u of units) {
		if (u.kind === "br") {
			while (out.length && out[out.length - 1].kind === "ch" && /[ \t]/.test((out[out.length - 1] as { ch: string }).ch)) out.pop();
			if (!out.length || out[out.length - 1].kind === "br") continue;
		}
		out.push(u);
	}
	while (out.length && out[out.length - 1].kind === "br") out.pop();
	if (trim) {
		while (out.length && out[0].kind === "ch" && /\s/.test((out[0] as { ch: string }).ch)) out.shift();
		while (out.length && out[out.length - 1].kind === "ch" && /\s/.test((out[out.length - 1] as { ch: string }).ch)) out.pop();
	}
	return out;
}

function containers(b: Body): Inline[][] {
	if (b.type === "table") return b.rows.flat();
	if (b.type === "paragraph" || b.type === "heading" || b.type === "quote") return [b.content];
	return [];
}

function withContainers(b: Body, cs: Inline[][]): Body {
	if (b.type === "table") {
		let k = 0;
		return { ...b, rows: b.rows.map((r) => r.map(() => cs[k++])) };
	}
	if (b.type === "paragraph" || b.type === "heading" || b.type === "quote") return { ...b, content: cs[0] };
	return b;
}

interface Diff {
	c: number;
	i: number;
	a: Unit[];
	b: Unit[];
}

function firstDiff(x: Body, y: Body): Diff | null {
	const A = containers(x);
	const B = containers(y);
	if (A.length !== B.length) return { c: 0, i: 0, a: [], b: [] };
	const trim = x.type === "heading" || x.type === "table";
	for (let c = 0; c < A.length; c++) {
		const a = normUnits(toUnits(A[c]), trim);
		const b = normUnits(toUnits(B[c]), trim);
		const n = Math.max(a.length, b.length);
		for (let i = 0; i < n; i++) if (unitKey(a[i]) !== unitKey(b[i])) return { c, i, a, b };
	}
	return null;
}

function without(marks: Mark[], key: string): Mark[] {
	return marks.filter((m) => mk(m) !== key);
}

/** 在 units 里，从 i 附近找出写不出来的那段标记，把边缘标点挪出去，或者整段去掉。 */
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
	const at = cur?.marks.some((m) => mk(m) === culprit) ? Math.min(i, units.length - 1) : i - 1;
	if (at < 0 || !units[at]?.marks.some((m) => mk(m) === culprit)) return false;
	let s = at;
	let e = at;
	while (s > 0 && units[s - 1].marks.some((m) => mk(m) === culprit)) s--;
	while (e + 1 < units.length && units[e + 1].marks.some((m) => mk(m) === culprit)) e++;
	const isP = (u: Unit) => u.kind === "ch" && PUNCT.test(u.ch);
	if (e > s && isP(units[e])) {
		let k = e;
		while (k > s && isP(units[k])) {
			units[k] = { ...units[k], marks: without(units[k].marks, culprit) } as Unit;
			k--;
		}
		return true;
	}
	if (e > s && isP(units[s])) {
		let k = s;
		while (k < e && isP(units[k])) {
			units[k] = { ...units[k], marks: without(units[k].marks, culprit) } as Unit;
			k++;
		}
		return true;
	}
	for (let k = s; k <= e; k++) units[k] = { ...units[k], marks: without(units[k].marks, culprit) } as Unit;
	safeStats.dropped++;
	return true;
}

function stripMarks(b: Body): Body {
	return withContainers(
		b,
		containers(b).map((c) =>
			c.map((n) => (n.type === "br" ? n : { ...n, marks: [] })),
		),
	);
}

/** 让输出成为「解析 → 序列化」的不动点：同一内容总是写成同一份源码。 */
function fixedPoint(s: string, parsed: Body, want: Body): string {
	let cur = s;
	let body = parsed;
	for (let i = 0; i < 3; i++) {
		const next = serializeBodyRaw(body);
		if (next === cur) return cur;
		const p = parseBlock(next);
		if (p.extra.length || p.body.type !== want.type || firstDiff(want, p.body)) return cur;
		safeStats.fixedPoint++;
		cur = next;
		body = p.body;
	}
	return cur;
}

export function serializeBodySafe(body: Body): string {
	if (body.type === "code" || body.type === "embed") return serializeBodyRaw(body);
	safeStats.calls++;
	let cur = body;
	for (let attempt = 0; attempt < 16; attempt++) {
		const s = serializeBodyRaw(cur);
		const p = parseBlock(s);
		if (p.extra.length || p.body.type !== cur.type) break;
		const d = firstDiff(cur, p.body);
		if (!d) {
			if (attempt > 0) safeStats.degraded++;
			return fixedPoint(s, p.body, cur);
		}
		const cs = containers(cur);
		const units = normUnits(toUnits(cs[d.c]), cur.type === "heading" || cur.type === "table");
		if (!degrade(units, d.i, d.b)) break;
		cs[d.c] = fromUnits(units);
		cur = withContainers(cur, cs);
	}
	safeStats.dropped++;
	return serializeBodyRaw(stripMarks(cur));
}
