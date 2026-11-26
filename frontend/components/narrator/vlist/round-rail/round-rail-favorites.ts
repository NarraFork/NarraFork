/**
 * round-rail-favorites.ts — 收藏轮次的持久化。纯函数，零 DOM。
 *
 * 收藏是「这条会话里我在意的那几轮」，所以按 narratorId 隔离存放：
 * 换会话就该换一套，绝不把上一条会话的收藏漏到新的上。
 *
 * 存的是 `seq`（轮次索引里的稳定序号），不是数组下标 —— 下标会随更早的轮
 * 被加载而整体位移，收藏就会指向别的轮。
 */

const KEY_PREFIX = "narrafork_round_favorites:";

/** 该叙述者的收藏存储键；没有 narratorId（草稿）→ ""（收藏功能关闭）。 */
export function roundFavoritesKey(narratorId: string | undefined): string {
	return narratorId ? `${KEY_PREFIX}${narratorId}` : "";
}

/** 读一次收藏集合。存储损坏 / 不可用 → 空集合（不阻塞轨道渲染）。 */
export function readRoundFavorites(narratorId: string | undefined): Set<number> {
	const key = roundFavoritesKey(narratorId);
	if (!key) return new Set();
	try {
		const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
		return normalizeRoundFavorites(raw);
	} catch {
		return new Set();
	}
}

/** 写回收藏集合；存储不可用时静默失败（本次会话内仍然生效）。 */
export function writeRoundFavorites(narratorId: string | undefined, favorites: Set<number>): void {
	const key = roundFavoritesKey(narratorId);
	if (!key) return;
	try {
		window.localStorage.setItem(key, JSON.stringify([...favorites].sort((a, b) => a - b)));
	} catch {
		// 忽略：收藏丢了不该打断阅读。
	}
}

/** 收敛任意 JSON 为合法的 seq 集合（只认正整数，去重）。 */
export function normalizeRoundFavorites(raw: unknown): Set<number> {
	const out = new Set<number>();
	if (!Array.isArray(raw)) return out;
	for (const item of raw) {
		if (typeof item !== "number" || !Number.isInteger(item) || item < 0) continue;
		out.add(item);
	}
	return out;
}

/** 切换收藏，返回新的集合（不改入参）。 */
export function toggleRoundFavorite(current: Set<number>, seq: number): Set<number> {
	const next = new Set(current);
	if (next.has(seq)) next.delete(seq);
	else next.add(seq);
	return next;
}
