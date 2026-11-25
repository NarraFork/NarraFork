/**
 * narrator-rounds.ts — 轮次索引（「一轮 = 一条真人用户消息到下一个真人用户消息之前」）。
 *
 * 导航轨要列出**整个会话**的每一轮，而前端只加载消息的一个窗口（分页按 refs.seq）。
 * 所以索引必须在 SQL 侧算，且成本与「轮数」成正比、与「每轮事件数」无关。
 *
 * 与 Vantaloom 的 `/rounds` 相比这里省掉了一整类技巧：它的事件存在 JSON 文件里，
 * 只能物化用户消息、再回看有限个位置猜「哪条是最终回复」。nfk 有
 * `narrator_message_refs.seq` 与 `narrator_messages.created_at` 两列都能进索引，
 * 一条聚合 SQL 就能同时拿到轮首、回复时间与用时。
 *
 * ⚠️ 三条判据必须与前端 `vlist/round-group.ts` 逐条对应（改一处就要改另一处）：
 *   1. `role = 'user'`；
 *   2. `origin IS NULL OR origin = 'user'` —— 排除自动续跑 / review 启动 / rebase prompt；
 *   3. `is_compact = 0` —— 压缩点之前的轮不再可达，列出来点过去是空的。
 *
 * ⚠️ 绝不 SELECT `content_json`：那是列表接口禁止读取的大字段。用户原话取
 * `content_text`（纯文本列）并在 SQL 侧就截断到 ROUND_USER_TEXT_MAX_CHARS。
 */

import type { NarratorRound, NarratorRoundsPage } from "@shared/narrator-rounds";
import { ROUND_REPLY_PREVIEW_MAX_CHARS, ROUND_USER_TEXT_MAX_CHARS } from "@shared/narrator-rounds";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages, narrators } from "../db/schema";

/** 一条 SQL 里同时算「轮首 + 该轮最后一条 assistant 的时间 + 累计 token」。 */
export async function listNarratorRounds(
	narratorId: string,
	options: { beforeSeq?: number; limit: number },
): Promise<NarratorRoundsPage> {
	const { beforeSeq, limit } = options;
	// 多取一条判断是否还有更早的轮，避免额外的 COUNT(*)。
	const probe = limit + 1;

	/**
	 * 步骤一：取轮首（真人用户消息）。
	 *
	 * `content_text` 走 `substr` 截断，最后在 JS 侧收敛空白 —— SQL 里做多空白合并
	 * 会让查询失去索引友好性，而一行 80 字的正则成本可以忽略。
	 */
	/**
	 * 会话类型决定切轮判据：子代理的「用户」消息是父代理派发的任务（实测 100%
	 * 是 `origin='assistant'`），沿用主会话判据会让子代理永远切不出轮。
	 */
	const narratorRow = await db
		.select({ type: narrators.type })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.limit(1);
	const isSubagent = narratorRow[0]?.type === "subagent";

	/** 真人来源的判据。子代理不同：它的「用户」消息是父代理派发的任务（origin=assistant）。 */
	const userOriginCondition = (sub: boolean) =>
		sub
			? or(
					isNull(narratorMessages.origin),
					eq(narratorMessages.origin, "user"),
					eq(narratorMessages.origin, "assistant"),
				)
			: or(isNull(narratorMessages.origin), eq(narratorMessages.origin, "user"));

	const startRows = await db
		.select({
			seq: narratorMessageRefs.seq,
			messageId: narratorMessages.id,
			text: sql<string | null>`
				substr(coalesce(${narratorMessages.contentText}, ''), 1, ${ROUND_USER_TEXT_MAX_CHARS})
			`.as("round_text"),
			createdAt: narratorMessages.createdAt,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessages.role, "user"),
				// 判据 2：真人来源（老数据 origin 为 null；子代理见 isSubagent）。
				userOriginCondition(isSubagent),
				// 判据 3：压缩点之前的轮不可达。
				eq(narratorMessageRefs.isCompact, 0),
				...(typeof beforeSeq === "number" ? [sql`${narratorMessageRefs.seq} < ${beforeSeq}`] : []),
			),
		)
		// 取「最近的一页」：游标向前翻。
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(probe);

	const hasMore = startRows.length > limit;
	const page = hasMore ? startRows.slice(0, limit) : startRows;
	if (page.length === 0) return { rounds: [], hasMore: false };

	// 结果按 seq 升序返回（导航轨从旧到新），SQL 侧为分页便利用了 DESC。
	page.reverse();

	/**
	 * 步骤二：这一页里每一轮的「最后一条 assistant 回复时间」。
	 *
	 * 一轮的区间是 [本轮的 seq, 下一轮的 seq)。最末一轮用开区间到无穷，
	 * 但此时那些更晚的轮（不在本页）其实属于更晚的区间 —— 所以上一页传下来的
	 * 边界要靠 `nextSeqOfPage` 补齐：只要本页不是从头开始，最后一轮的右边界
	 * 就是本页最早一条之前那一轮的首 seq，而这里拿不到它。
	 *
	 * 因此右边界统一用「比本页最末 seq 更大的下一个轮首 seq」，查不到就取无穷：
	 * `repliedAt` 只用于展示用时，多算进更晚轮的内容只会让极少数跨越边界的轮
	 * 偏大，而不会让导航轨错位。为把这点偏差也消掉，下一条查询会在本页之外
	 * 多取一个轮首作为收口边界。
	 */
	const boundaryRows = await db
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessages.role, "user"),
				userOriginCondition(isSubagent),
				eq(narratorMessageRefs.isCompact, 0),
				sql`${narratorMessageRefs.seq} > ${page[page.length - 1]!.seq}`,
			),
		)
		.orderBy(asc(narratorMessageRefs.seq))
		.limit(1);
	const tailBoundary = boundaryRows[0]?.seq ?? null;

	const replyRows = await db
		.select({
			seq: narratorMessageRefs.seq,
			createdAt: narratorMessages.createdAt,
			/**
			 * 回复缩略：**只用 `content_text` 纯文本列 + SQL 侧截断**，与 `userText`
			 * 同一套做法。绝不读 `content_json`（列表接口禁止读大字段）。
			 *
			 * 悬停卡片需要「这一轮 AI 答了什么」的那一眼；完整正文由消息列表在跳过去
			 * 之后按需加载。
			 */
			preview: sql<string | null>`
				substr(coalesce(${narratorMessages.contentText}, ''), 1, ${ROUND_REPLY_PREVIEW_MAX_CHARS})
			`.as("reply_preview"),
			/**
			 * token 用量取**整型列**，不碰 `turn_usage_json`。
			 *
			 * 那个 JSON 平均 830 字节、还带 `context_snapshot` 等用不到的键，解析
			 * 200 轮要多花约 15ms —— 对一个导航列表接口来说不值，而且 nfk 自己的
			 * DTO（`display-page-query.ts` 的 DISPLAY_MESSAGE_COLUMNS）本来就把
			 * `turnUsageJson` 列为排除字段。`tokens_in` / `output_tokens` 是同一批
			 * 数据的整型投影，读它们零解析、可进索引。
			 *
			 * 口径：`output_tokens + tokens_in`（与 `credential-usage-totals.ts`
			 * 的 totalTokens 一致 —— 缓存/推理 token 不重复计入）。provider 不回报
			 * usage 时为 NULL，此时该轮不出 token 段，绝不按字符数估算。
			 */
			tokens: sql<number | null>`
				coalesce(${narratorMessages.outputTokens}, 0)
				+ coalesce(${narratorMessages.tokensIn}, 0)
			`.as("reply_tokens"),
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessages.role, "assistant"),
				// 与本页的时间跨度对齐：只看这一页覆盖的区间。
				sql`${narratorMessageRefs.seq} >= ${page[0]!.seq}`,
				...(tailBoundary !== null ? [sql`${narratorMessageRefs.seq} < ${tailBoundary}`] : []),
			),
		)
		.orderBy(asc(narratorMessageRefs.seq));

	// 把 assistant 回复按「属于哪一轮」归到轮首上（一次线性扫描）。
	const rounds: NarratorRound[] = [];
	let replyCursor = 0;
	for (let i = 0; i < page.length; i++) {
		const row = page[i]!;
		const nextSeq = i + 1 < page.length ? page[i + 1]!.seq : (tailBoundary ?? Infinity);
		let repliedAt: string | null = null;
		// 一轮内可能有多条 assistant（多次汇报），token 要全部累加；缩略取最后一条。
		let tokens = 0;
		let replyPreview: string | null = null;
		while (replyCursor < replyRows.length && replyRows[replyCursor]!.seq < nextSeq) {
			const reply = replyRows[replyCursor]!;
			if (reply.seq >= row.seq) {
				repliedAt = reply.createdAt;
				if (typeof reply.tokens === "number" && reply.tokens > 0) tokens += reply.tokens;
				// 最后一条非空正文才是这一轮的结论（前面的中间汇报不算）。
				const text = collapseWhitespace(reply.preview ?? "", ROUND_REPLY_PREVIEW_MAX_CHARS);
				if (text.length > 0) replyPreview = text;
			}
			replyCursor += 1;
		}
		rounds.push({
			seq: row.seq,
			messageId: row.messageId,
			userText: collapseWhitespace(row.text ?? "", ROUND_USER_TEXT_MAX_CHARS),
			startedAt: toEpochMs(row.createdAt),
			repliedAt: toEpochMs(repliedAt),
			// 一个都没查到就不写这个字段：界面据此不显示对应段，而不是显示空串 / 0。
			...(replyPreview ? { replyPreview } : {}),
			...(tokens > 0 ? { tokens } : {}),
		});
	}

	return { rounds, hasMore };
}

/**
 * 空白折叠并截断 —— 导航轨只显示一行，换行会把条目撑高。
 *
 * `text` 已经被 SQL 的 `substr` 截到 `maxChars` 字，所以这里
 * 不能再靠「长度超过上限才加省略号」来判断是否截过：截断后长度恰好等于上限，
 * 那个条件永远为假，省略号就永远不出现。判据因此改成「是否已经顶到上限」——
 * 恰好等于上限就意味着原文可能更长（也可能正好等长，多一个省略号无害），
 * 而真正短的消息不会被加。
 */
function collapseWhitespace(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	// 空白折叠只会变短，所以拿折叠后的长度与上限比较是不对的：
	// 先看**截断前**的原始长度是否顶到上限。
	const truncated = text.length >= maxChars;
	if (!truncated) return flat;
	const chars = Array.from(flat);
	const head = chars.slice(0, maxChars).join("").trimEnd();
	return `${head}…`;
}

/** ISO 字符串 → epoch ms；非法 / 缺失 → null（界面据此不显示该段）。 */
function toEpochMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}
