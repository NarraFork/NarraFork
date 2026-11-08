/**
 * 用量统计的分桶 SQL：把 `created_at` 归到「读者日历的桶标签」。
 *
 * 两种方言各自实现同一语义，桶 key 统一是读者日历的标签（见 `shared/usage-time-zone`），
 * 前端按同一份标签原样格式化，不会出现两边各按自己日历算的错位：
 *
 * - SQLite 没有 IANA 时区支持，所以由调用方给出查询跨度内的偏移分段，这里生成
 *   `case when created_at < ... then '<offset> minutes' ...` 的修饰符；DST 切换那天两侧用
 *   各自的偏移，历史日期不会因为「一个查询一个偏移」而错位。
 * - PostgreSQL 有 `AT TIME ZONE`，直接把绝对时刻转到读者时区的墙上时间再截断，无需分段。
 */

import { apiRequests } from "@server/db/schema";
import { offsetSegments, type UsageBucketGranularity } from "@shared/usage-time-zone";
import { type SQL, sql } from "drizzle-orm";

export type UsageSqlDialect = "sqlite" | "postgres";

export interface UsageBucketQuery {
	dialect: UsageSqlDialect;
	granularity: UsageBucketGranularity;
	timeZone: string;
	/** 查询跨度：SQLite 用它算 DST 分段，跨度之外的时间不参与聚合。 */
	start: Date;
	end: Date;
}

const LABEL_FORMAT = "%Y-%m-%dT%H:%M:%S.000Z";
const HOUR_LABEL_FORMAT = "%Y-%m-%dT%H:00:00.000Z";
const PG_LABEL_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export function usageBucketExpression(query: UsageBucketQuery): SQL<string> {
	return query.dialect === "postgres"
		? postgresBucketExpression(query)
		: sqliteBucketExpression(query);
}

function sqliteBucketExpression({
	granularity,
	timeZone,
	start,
	end,
}: UsageBucketQuery): SQL<string> {
	const column = apiRequests.createdAt;
	const shift = sqliteOffsetModifier(offsetSegments(start, end, timeZone));
	if (granularity === "hour")
		return sql<string>`strftime(${HOUR_LABEL_FORMAT}, ${column}, ${shift})`;
	const unit = granularity === "day" ? "start of day" : "start of month";
	return sql<string>`strftime(${LABEL_FORMAT}, ${column}, ${shift}, ${unit})`;
}

function sqliteOffsetModifier(segments: ReturnType<typeof offsetSegments>): SQL {
	const first = segments[0]?.offsetMinutes ?? 0;
	if (segments.length === 1) return sql.raw(`'${first} minutes'`);
	// 第 i 段的条件是「早于第 i+1 段的起点」，值用第 i 段自己的偏移；最后一段走 else。
	const branches = segments.slice(0, -1).map((segment, index) => {
		const nextFrom = segments[index + 1]?.fromMs;
		return sql`when ${apiRequests.createdAt} < ${new Date(nextFrom ?? 0).toISOString()} then ${sql.raw(
			`'${segment.offsetMinutes} minutes'`,
		)}`;
	});
	const last = segments[segments.length - 1]?.offsetMinutes ?? first;
	return sql`case ${sql.join(branches, sql` `)} else ${sql.raw(`'${last} minutes'`)} end`;
}

function postgresBucketExpression({ granularity, timeZone }: UsageBucketQuery): SQL<string> {
	const unit = granularity;
	// created_at 是可比较的 ISO 文本：先转成 timestamptz，再在读者时区里截断成标签。
	const column = sql`(${apiRequests.createdAt})::timestamptz`;
	return sql<string>`to_char(date_trunc(${unit}, ${column} AT TIME ZONE ${timeZone}), ${PG_LABEL_FORMAT})`;
}
