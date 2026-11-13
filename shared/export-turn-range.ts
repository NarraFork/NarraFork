/**
 * 「导出消息范围」的轮次区间。
 *
 * 用户写的是 `1,2,3-10,15,21` 这种串，导出与选择弹窗都按它筛轮。一轮 = 一条用户消息
 * 及其后的助手/工具消息，所以区间只关心轮号，不关心消息条数。
 */

export interface TurnRange {
	from: number;
	to: number;
}

/** 展开后的轮号上限：再大就不是"挑几轮导出"，而是变相全量导出。 */
export const TURN_RANGE_MAX_TURNS = 2000;

const SEGMENT = /^(\d+)(?:\s*-\s*(\d+))?$/;

/**
 * 解析成规范化的区间列表：升序、重叠与相邻合并。
 *
 * 空串（或只有分隔符/空白）返回空数组，表示"不限范围"；格式不合法返回 `null`。
 */
export function parseTurnRange(input: string): TurnRange[] | null {
	const text = input.trim();
	if (!text) return [];
	const ranges: TurnRange[] = [];
	for (const raw of text.split(",")) {
		const segment = raw.trim();
		if (!segment) continue;
		const match = SEGMENT.exec(segment);
		if (!match) return null;
		const from = Number(match[1]);
		const to = match[2] === undefined ? from : Number(match[2]);
		if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
		if (from < 1 || to < from) return null;
		ranges.push({ from, to });
	}
	return normalize(ranges);
}

/** 选中的轮号 → 合并后的连续区间（选择弹窗回写用）。 */
export function rangesFromTurns(turns: Iterable<number>): TurnRange[] {
	const sorted = [...new Set(turns)].filter((turn) => Number.isSafeInteger(turn) && turn >= 1);
	sorted.sort((a, b) => a - b);
	const ranges: TurnRange[] = [];
	for (const turn of sorted) {
		const last = ranges[ranges.length - 1];
		if (last && turn === last.to + 1) last.to = turn;
		else ranges.push({ from: turn, to: turn });
	}
	return ranges;
}

/** 区间列表 → 输入框里的原始串。 */
export function formatTurnRange(ranges: readonly TurnRange[]): string {
	return normalize(ranges)
		.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`))
		.join(",");
}

/** 展开成轮号集合；总数超过 `limit` 时返回 `null`（调用方按"范围过大"处理）。 */
export function expandTurnRange(
	ranges: readonly TurnRange[],
	limit: number = TURN_RANGE_MAX_TURNS,
): Set<number> | null {
	const normalized = normalize(ranges);
	let total = 0;
	for (const range of normalized) {
		total += range.to - range.from + 1;
		if (total > limit) return null;
	}
	const turns = new Set<number>();
	for (const range of normalized) {
		for (let turn = range.from; turn <= range.to; turn += 1) turns.add(turn);
	}
	return turns;
}

function normalize(ranges: readonly TurnRange[]): TurnRange[] {
	const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
	const merged: TurnRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		// 相邻也算相连：`1-2,3` 写成 `1-3` 更短，也少一个可点的叉。
		if (last && range.from <= last.to + 1) {
			last.to = Math.max(last.to, range.to);
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}
