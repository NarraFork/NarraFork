/**
 * 文本差异：按词元（英文词、单个汉字、空白串、单个标点）做 Myers diff，输出字符区间的补丁。
 * 用于：正文修改「序列化 → 与 Y.Text 当前内容 diff → 只写差异」（§6.7），以及 agent 的三方合并（§6.5）。
 */

/** 把 a[start, end) 替换成 text。 */
export interface Hunk {
	start: number;
	end: number;
	text: string;
}

const TOKEN_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[\s\S]/gu;

function tokenize(s: string): string[] {
	return s.match(TOKEN_RE) ?? [];
}

/** 最简单的单区间差异（公共前缀 + 公共后缀）：输入时每次只改一处，足够且最快。 */
export function simpleDiff(a: string, b: string): Hunk | null {
	if (a === b) return null;
	let p = 0;
	const max = Math.min(a.length, b.length);
	while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
	let s = 0;
	while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
	return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}

function myers(a: string[], b: string[]): Array<[number, number]> {
	// 返回匹配的 (i, j) 对（a[i] === b[j]）
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const v = new Map<number, number>();
	v.set(1, 0);
	const trace: Array<Map<number, number>> = [];
	outer: for (let d = 0; d <= max; d++) {
		trace.push(new Map(v));
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)))
				x = v.get(k + 1) ?? 0;
			else x = (v.get(k - 1) ?? 0) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v.set(k, x);
			if (x >= n && y >= m) break outer;
		}
		if (d > 4000) return []; // 差异过大：退化为整体替换
	}
	const pairs: Array<[number, number]> = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vv = trace[d];
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) prevK = k + 1;
		else prevK = k - 1;
		const prevX = vv.get(prevK) ?? 0;
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

/** 多区间差异（按词元对齐）。 */
export function diffHunks(a: string, b: string): Hunk[] {
	if (a === b) return [];
	// 先去掉公共前后缀，按字符
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
	const offA: number[] = [0];
	for (const t of ta) offA.push(offA[offA.length - 1] + t.length);
	const offB: number[] = [0];
	for (const t of tb) offB.push(offB[offB.length - 1] + t.length);
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	const flush = (ni: number, nj: number) => {
		if (ni > i || nj > j) {
			hunks.push({ start: p + offA[i], end: p + offA[ni], text: bm.slice(offB[j], offB[nj]) });
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

export function applyHunks(a: string, hunks: Hunk[]): string {
	let out = "";
	let pos = 0;
	for (const h of hunks) {
		out += a.slice(pos, h.start) + h.text;
		pos = h.end;
	}
	return out + a.slice(pos);
}

/** Yjs 风格的 delta（retain / insert / delete），用于在不同版本之间映射偏移。 */
export type DeltaOp = { retain: number } | { insert: string } | { delete: number };

export function hunksToDelta(hunks: Hunk[]): DeltaOp[] {
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
 * 把旧文本里的偏移映射到应用 delta 之后的文本。
 * assoc < 0：插入点恰好在 pos 时留在插入内容之前；> 0 留在之后。
 */
export function mapOffset(delta: DeltaOp[], pos: number, assoc = 1): number {
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
