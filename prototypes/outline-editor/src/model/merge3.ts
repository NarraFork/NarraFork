/**
 * agent 的三方合并（§6.5）：以 agent 读到的文本为基线算补丁，应用到当前文本；
 * 和读取之后别人的修改不重叠就合并，重叠就拒绝并返回当前内容。
 */
import { diffHunks, type Hunk } from "./diff";

export type Merge3Result =
	| { ok: true; result: string; /** 应用到 theirs 上的补丁（theirs 坐标） */ patch: Hunk[] }
	| { ok: false; current: string; conflicts: Array<{ mine: Hunk; theirs: Hunk }> };

function overlaps(a: Hunk, b: Hunk): boolean {
	const aIns = a.start === a.end;
	const bIns = b.start === b.end;
	if (aIns && bIns) return a.start === b.start;
	if (aIns) return a.start > b.start && a.start < b.end;
	if (bIns) return b.start > a.start && b.start < a.end;
	return a.start < b.end && b.start < a.end;
}

export function merge3(base: string, mine: string, theirs: string): Merge3Result {
	const mh = diffHunks(base, mine);
	if (base === theirs) return { ok: true, result: mine, patch: mh };
	if (mh.length === 0) return { ok: true, result: theirs, patch: [] };
	const th = diffHunks(base, theirs);
	const conflicts: Array<{ mine: Hunk; theirs: Hunk }> = [];
	for (const m of mh) for (const t of th) if (overlaps(m, t)) conflicts.push({ mine: m, theirs: t });
	if (conflicts.length) return { ok: false, current: theirs, conflicts };
	// 把 mine 的每个区间从 base 坐标映射到 theirs 坐标：
	// 起点算上恰好在此处的插入（mine 排在 theirs 的插入之后），终点不算。
	const delta = (t: Hunk) => t.text.length - (t.end - t.start);
	const mapStart = (pos: number) => pos + th.filter((t) => t.end <= pos).reduce((n, t) => n + delta(t), 0);
	const mapEnd = (pos: number) =>
		pos +
		th
			.filter((t) => t.end < pos || (t.end === pos && t.start < t.end))
			.reduce((n, t) => n + delta(t), 0);
	const patch: Hunk[] = mh.map((m) => {
		const s = mapStart(m.start);
		const e = m.start === m.end ? s : Math.max(s, mapEnd(m.end));
		return { start: s, end: e, text: m.text };
	});
	patch.sort((a, b) => a.start - b.start);
	let out = "";
	let pos = 0;
	for (const h of patch) {
		out += theirs.slice(pos, h.start) + h.text;
		pos = h.end;
	}
	out += theirs.slice(pos);
	return { ok: true, result: out, patch };
}
