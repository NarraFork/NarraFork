/**
 * narrator-rounds.ts — 「一轮」的共享类型与非负约束。
 *
 * 一轮（round）= 一条真人用户消息，到下一个真人用户消息之前的所有内容。
 * 两个消费者必须用同一份定义，否则导航轨列出的轮与折叠切出的轮会漂移：
 *   - 后端 `GET /api/narrators/:id/rounds`（导航轨的索引）；
 *   - 前端 `vlist/round-group.ts`（整轮折叠的切点）。
 *
 * 这里只放类型与常量；两边的判定逻辑各在自己的运行时里实现
 * （SQL 用 WHERE，前端用纯函数），但判据必须逐条对应。
 */

/**
 * 一条真人用户消息 = 一轮的开始。判据与后端 SQL 完全对应：
 *
 *   - `role === "user"`
 *   - `origin` 为空（本列引入前的老数据）或 `"user"`
 *   - 不是压缩点（`isCompact === 0`）
 *
 * ⚠️ `origin` 这一条是承重的。`narrator_messages.origin` 与 `role` 正交：
 * 自动续跑、review 启动、rebase prompt 都是 `role="user"` 但 `origin="system"`。
 * 不排除它们，导航轨会被自动续跑刷满，而每一轮都短得没有内容。
 */
export const ROUND_USER_ORIGINS = [null, "user"] as const;

/** 用户原话在索引里保留多少字（SQL 侧截断，绝不回传整段正文）。 */
export const ROUND_USER_TEXT_MAX_CHARS = 80;

/**
 * 回复缩略在索引里保留多少字。
 *
 * 比原话短：它只是让读者确认「这一轮 AI 答了什么」，不是用来读的。真正的正文
 * 在点开、跳过去之后由消息列表按需加载。
 */
export const ROUND_REPLY_PREVIEW_MAX_CHARS = 120;

/**
 * 导航轨里的一轮。
 *
 * 刻意**不含回复正文**：完整正文在 `content_json` 大字段里，而这是列表接口。
 * 只保留 SQL 侧 `substr` 出来的短缩略（{@link ROUND_REPLY_PREVIEW_MAX_CHARS} 字），
 * 与 `userText` 同一套做法 —— 悬停卡片需要「AI 答了什么」的那一眼，但不需要全文。
 */
export type NarratorRound = {
	/** 该轮首条用户消息在 `narrator_message_refs` 里的序号，与消息分页同一坐标系。 */
	seq: number;
	messageId: string;
	/** 用户原话开头（已折叠空白，最多 {@link ROUND_USER_TEXT_MAX_CHARS} 字）。 */
	userText: string;
	/**
	 * 该轮最后一条 assistant 回复的开头（SQL 侧截断到
	 * {@link ROUND_REPLY_PREVIEW_MAX_CHARS} 字）；还没回复 → undefined。
	 */
	replyPreview?: string;
	/** 轮首时间（epoch ms）；老数据可能缺。 */
	startedAt: number | null;
	/** 该轮最后一条 assistant 回复的时间（epoch ms）；还没回复 → null。 */
	repliedAt: number | null;
	/** 该轮累计 token；查不到 → 不显示（绝不按字符数估算）。 */
	tokens?: number;
};

/** `GET /api/narrators/:id/rounds` 的响应。 */
export type NarratorRoundsPage = {
	rounds: NarratorRound[];
	/** 还有更早的轮可以取（用最后一轮的 `seq` 作 `beforeSeq`）。 */
	hasMore: boolean;
};

/** 一轮跑了多久（毫秒）。缺少任一端、或时间非递增 → undefined（不显示，而不是显示 0）。 */
export function roundDurationMs(
	round: Pick<NarratorRound, "startedAt" | "repliedAt">,
): number | undefined {
	const start = round.startedAt;
	const end = round.repliedAt;
	if (typeof start !== "number" || typeof end !== "number") return undefined;
	const span = end - start;
	// 时钟回拨 / 后端给了 0：显示「-3m」比不显示更让人困惑。
	return span > 0 ? span : undefined;
}
