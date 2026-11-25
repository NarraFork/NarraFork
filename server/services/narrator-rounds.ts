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
 *   3. `is_compact = 0` —— 排除压缩标记行本身（不把压缩标记当轮首）。
 *
 * ⚠️ 绝不 SELECT `content_json`：那是列表接口禁止读取的大字段。用户原话取
 * `content_text`（纯文本列）并在 SQL 侧就截断到 ROUND_USER_TEXT_MAX_CHARS。
 *
 * ⚠️ 所有查询经 `readQuery` 走只读 worker 池，且回复扫描按 `seq DESC` 游标分批、
 * 带单次上限、总行数上限、超时与取消，避免大历史会话在 HTTP 主线程阻塞或 OOM。
 */

import type { NarratorRound, NarratorRoundsPage } from "@shared/narrator-rounds";
import { ROUND_REPLY_PREVIEW_MAX_CHARS, ROUND_USER_TEXT_MAX_CHARS } from "@shared/narrator-rounds";
import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages, narrators } from "../db/schema";
import { readQuery } from "../db/worker-read";

const ROUND_READ_TIMEOUT_MS = 10_000;
const REPLY_BATCH_SIZE = 500;
/** 单次索引请求最多扫描的 assistant 行数（硬上限，防超长工具轮拖垮 worker）。 */
export const MAX_ROUND_REPLY_ROWS_SCANNED = 5_000;

export interface ListNarratorRoundsOptions {
	beforeSeq?: number;
	limit: number;
	signal?: AbortSignal;
	/** 测试用：覆盖单次请求允许扫描的 assistant 行数上限。 */
	maxReplyRowsScanned?: number;
}

/** 分批有界查询「轮首 + 该轮最后一条 assistant 的时间/缩略 + 累计 token」。 */
export async function listNarratorRounds(
	narratorId: string,
	options: ListNarratorRoundsOptions,
): Promise<NarratorRoundsPage> {
	const { beforeSeq, limit, signal } = options;
	const maxReplyRows = Math.max(
		1,
		Math.trunc(options.maxReplyRowsScanned ?? MAX_ROUND_REPLY_ROWS_SCANNED),
	);
	const deadlineAt = Date.now() + ROUND_READ_TIMEOUT_MS;
	const baseReadOpts = {
		signal,
		deadlineAt,
		timeoutMs: ROUND_READ_TIMEOUT_MS,
		diagnosticSource: "narrator-rounds",
	} as const;
	// 多取一条判断是否还有更早的轮，避免额外的 COUNT(*)。
	const probe = limit + 1;

	/**
	 * 会话类型决定切轮判据：子代理的「用户」消息是父代理派发的任务（实测 100%
	 * 是 `origin='assistant'`），沿用主会话判据会让子代理永远切不出轮。
	 */
	const narratorRow = await readQuery<Array<{ type: string | null }>>(
		db
			.select({ type: narrators.type })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.limit(1),
		{ ...baseReadOpts, maxRows: 1, shortRead: true },
	);
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

	/**
	 * 步骤一：取轮首（真人用户消息）。
	 *
	 * `content_text` 走 `substr` 截断，最后在 JS 侧收敛空白 —— SQL 里做多空白合并
	 * 会让查询失去索引友好性，而一行 80 字的正则成本可以忽略。
	 */
	const startRows = await readQuery<
		Array<{
			seq: number;
			messageId: string;
			text: string | null;
			createdAt: string;
		}>
	>(
		db
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
					// 判据 3：排除压缩标记行本身。
					eq(narratorMessageRefs.isCompact, 0),
					typeof beforeSeq === "number" ? lt(narratorMessageRefs.seq, beforeSeq) : undefined,
				),
			)
			// 取「最近的一页」：游标向前翻。
			.orderBy(desc(narratorMessageRefs.seq))
			.limit(probe),
		{ ...baseReadOpts, maxRows: probe },
	);

	const hasMore = startRows.length > limit;
	const page = hasMore ? startRows.slice(0, limit) : startRows;
	if (page.length === 0) return { rounds: [], hasMore: false };

	// 结果按 seq 升序返回（导航轨从旧到新），SQL 侧为分页便利用了 DESC。
	page.reverse();

	/**
	 * 步骤二：取本页之外的下一个轮首作为右边界，避免把更晚一轮的回复算进本页最后一轮。
	 */
	const boundaryRows = await readQuery<Array<{ seq: number }>>(
		db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessages.role, "user"),
					userOriginCondition(isSubagent),
					eq(narratorMessageRefs.isCompact, 0),
					gt(narratorMessageRefs.seq, page[page.length - 1]!.seq),
				),
			)
			.orderBy(asc(narratorMessageRefs.seq))
			.limit(1),
		{ ...baseReadOpts, maxRows: 1, shortRead: true },
	);
	const tailBoundary = boundaryRows[0]?.seq ?? null;

	/**
	 * 步骤三：按 `seq DESC` 游标分批扫 assistant 回复并归到各轮。
	 *
	 * 倒序扫描有两个好处：
	 *   1. 每轮遇到的第一条 assistant 就是最新回复（`repliedAt`），第一条非空正文
	 *      就是最终结论（`replyPreview`），无需把整段全放进内存；
	 *   2. 即使超长会话命中 `maxReplyRows` 硬上限提前收手，最新几轮仍 100% 完整，
	 *      被截断的更早轮省略可能不完整的 `tokens`（绝不展示截断后的半截数字）。
	 */
	const minSeq = page[0]!.seq;
	const roundAcc = page.map(() => ({
		repliedAt: null as string | null,
		replyPreview: null as string | null,
		tokens: 0,
		tokensComplete: true,
	}));

	let roundIdx = page.length - 1;
	let cursorBeforeSeq: number | null = tailBoundary;
	let scannedRows = 0;
	let scanTruncated = false;

	type RoundReplyRow = {
		seq: number;
		createdAt: string;
		preview: string | null;
		tokens: number | null;
	};

	while (scannedRows < maxReplyRows) {
		signal?.throwIfAborted();
		const remaining = maxReplyRows - scannedRows;
		const batchLimit = Math.min(REPLY_BATCH_SIZE, remaining);
		const batch: RoundReplyRow[] = await readQuery<RoundReplyRow[]>(
			db
				.select({
					seq: narratorMessageRefs.seq,
					createdAt: narratorMessages.createdAt,
					/**
					 * 回复缩略：**只用 `content_text` 纯文本列 + SQL 侧截断**，与 `userText`
					 * 同一套做法。绝不读 `content_json`（列表接口禁止读大字段）。
					 */
					preview: sql<string | null>`
						substr(coalesce(${narratorMessages.contentText}, ''), 1, ${ROUND_REPLY_PREVIEW_MAX_CHARS})
					`.as("reply_preview"),
					/**
					 * token 用量取**整型列**，不碰 `turn_usage_json`。
					 * 口径：`output_tokens + tokens_in`（与 `credential-usage-totals.ts` 一致）。
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
						gte(narratorMessageRefs.seq, minSeq),
						cursorBeforeSeq !== null ? lt(narratorMessageRefs.seq, cursorBeforeSeq) : undefined,
					),
				)
				.orderBy(desc(narratorMessageRefs.seq))
				.limit(batchLimit),
			{ ...baseReadOpts, maxRows: batchLimit },
		);

		if (batch.length === 0) break;
		scannedRows += batch.length;

		for (const reply of batch) {
			while (roundIdx > 0 && reply.seq < page[roundIdx]!.seq) {
				roundIdx -= 1;
			}
			if (reply.seq < page[roundIdx]!.seq) break;
			const acc = roundAcc[roundIdx]!;
			if (acc.repliedAt === null) acc.repliedAt = reply.createdAt;
			if (typeof reply.tokens === "number" && reply.tokens > 0) acc.tokens += reply.tokens;
			if (acc.replyPreview === null) {
				const text = collapseWhitespace(reply.preview ?? "", ROUND_REPLY_PREVIEW_MAX_CHARS);
				if (text.length > 0) acc.replyPreview = text;
			}
		}

		const oldestInBatch: number = batch[batch.length - 1]!.seq;
		if (batch.length < batchLimit || oldestInBatch <= minSeq) break;
		cursorBeforeSeq = oldestInBatch;
		if (scannedRows >= maxReplyRows) {
			scanTruncated = true;
			break;
		}
	}

	// 若扫描在 `roundIdx` 处因触达上限提前停止，当前轮及更早轮的 token 累计可能不完整，
	// 宁可不展示 token 也不展示偏小的半截数字。
	if (scanTruncated) {
		for (let i = 0; i <= roundIdx; i++) {
			roundAcc[i]!.tokensComplete = false;
		}
	}

	const rounds: NarratorRound[] = page.map((row, i) => {
		const acc = roundAcc[i]!;
		const tokens = acc.tokensComplete && acc.tokens > 0 ? acc.tokens : undefined;
		return {
			seq: row.seq,
			messageId: row.messageId,
			userText: collapseWhitespace(row.text ?? "", ROUND_USER_TEXT_MAX_CHARS),
			startedAt: toEpochMs(row.createdAt),
			repliedAt: toEpochMs(acc.repliedAt),
			...(acc.replyPreview ? { replyPreview: acc.replyPreview } : {}),
			...(tokens !== undefined ? { tokens } : {}),
		};
	});

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
	if (flat.length === 0) return "";
	// 空白折叠只会变短，所以拿折叠后的长度与上限比较是不对的：
	// 先看**截断前**的原始长度是否顶到上限。
	const truncated = Array.from(text).length >= maxChars;
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
