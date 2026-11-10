/**
 * 读者日历：把绝对时刻换算到请求显式声明的 IANA 时区。
 *
 * 服务端不能替读者选时区——容器里的进程时区几乎总是 UTC，而人按自己所在城市的日看统计。
 * 这里只做换算、不持有全局状态：同一进程可以同时服务不同时区的请求。
 *
 * 桶 key 是**读者日历的标签**：形如 `2026-03-08T00:00:00.000Z`，但它表示「当地 3 月 8 日
 * 零点」而不是一个绝对时刻。标签在转发到展示层时按 UTC 原样格式化，因此 DST 跳变那天
 * 也不会因为「这个钟点不存在」而错位。绝对时刻只出现在查询过滤条件里。
 */

export type UsageBucketGranularity = "hour" | "day" | "month";

/** 缺省时区：请求没声明时按 UTC 统计，绝不推断服务器进程时区。 */
export const DEFAULT_USAGE_TIME_ZONE = "UTC";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** DST 扫描的步长：切换一晚一次，半天粒度足以发现变化，再由二分收敛到毫秒。 */
const OFFSET_SCAN_STEP_MS = 12 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

export interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

export interface OffsetSegment {
	/** 该段起始的绝对时刻（毫秒，含）。 */
	fromMs: number;
	/** 该段内恒定的 UTC 偏移（分钟，东为正）。 */
	offsetMinutes: number;
}

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = formatters.get(timeZone);
	if (cached) return cached;
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	formatters.set(timeZone, formatter);
	return formatter;
}

/** 接受任意 IANA 时区名；无法识别时回落到 UTC，而不是让整个请求失败。 */
export function normalizeUsageTimeZone(value: string | undefined | null): string {
	const trimmed = value?.trim();
	if (!trimmed) return DEFAULT_USAGE_TIME_ZONE;
	try {
		zonedFormatter(trimmed);
		return trimmed;
	} catch {
		return DEFAULT_USAGE_TIME_ZONE;
	}
}

/** 该时刻在指定时区的墙上时间。 */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
	const parts = zonedFormatter(timeZone).formatToParts(instant);
	const read = (type: Intl.DateTimeFormatPartTypes): number => {
		const value = parts.find((part) => part.type === type)?.value;
		return value ? Number(value) : 0;
	};
	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour: read("hour") % 24,
		minute: read("minute"),
		second: read("second"),
	};
}

/** 该时刻在指定时区的 UTC 偏移（分钟，东为正）。 */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
	const parts = zonedParts(instant, timeZone);
	const wallAsUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
	// 墙上时间只精确到秒：抹平毫秒再比较，否则差值里会混进不到一秒的残量。
	const floored = Math.floor(instant.getTime() / 1000) * 1000;
	return Math.round((wallAsUtc - floored) / MINUTE_MS);
}

/** 绝对时刻落到哪个桶：返回读者日历的桶标签（不是绝对时刻）。 */
export function bucketLabelAt(
	instant: Date,
	granularity: UsageBucketGranularity,
	timeZone: string,
): string {
	const parts = zonedParts(instant, timeZone);
	if (granularity === "hour") return labelOf({ ...parts, minute: 0, second: 0 });
	if (granularity === "day") return labelOf({ ...parts, hour: 0, minute: 0, second: 0 });
	return labelOf({ ...parts, day: 1, hour: 0, minute: 0, second: 0 });
}

function labelOf(parts: ZonedParts): string {
	return new Date(
		Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
	).toISOString();
}

/** 桶标签递增：标签空间是纯 UTC 日历，与真实时区无关。 */
export function addBuckets(
	label: string,
	amount: number,
	granularity: UsageBucketGranularity,
): string {
	const cursor = new Date(label);
	if (granularity === "hour") cursor.setUTCHours(cursor.getUTCHours() + amount);
	else if (granularity === "day") cursor.setUTCDate(cursor.getUTCDate() + amount);
	else cursor.setUTCMonth(cursor.getUTCMonth() + amount);
	return cursor.toISOString();
}

export function countBucketsBetween(
	startLabel: string,
	endLabel: string,
	granularity: UsageBucketGranularity,
): number {
	const start = new Date(startLabel);
	const end = new Date(endLabel);
	if (start.getTime() > end.getTime()) return 0;
	if (granularity === "hour") {
		return Math.floor((end.getTime() - start.getTime()) / HOUR_MS) + 1;
	}
	if (granularity === "day") {
		return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
	}
	return (
		(end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
		(end.getUTCMonth() - start.getUTCMonth()) +
		1
	);
}

/**
 * 桶标签对应的实际查询下界。重复的墙上时间取较早一次，确保两次出现都进入同一个桶；
 * 不存在的墙上时间取 DST 跳变点，避免漏掉跳变后的记录。全程只使用指定 IANA 时区。
 */
export function bucketStartAt(label: string, timeZone: string): Date {
	const wallMs = new Date(label).getTime();
	if (Number.isNaN(wallMs)) throw new RangeError(`Invalid usage bucket label: ${label}`);

	// 实际时刻与标签的 UTC 表示最多相差一个时区偏移；两天余量也覆盖国际日期变更线。
	const segments = offsetSegments(
		new Date(wallMs - 2 * DAY_MS),
		new Date(wallMs + 2 * DAY_MS),
		timeZone,
	);
	let earliest = Number.POSITIVE_INFINITY;
	for (const [index, segment] of segments.entries()) {
		const candidate = wallMs - segment.offsetMinutes * MINUTE_MS;
		const segmentEnd = segments[index + 1]?.fromMs ?? Number.POSITIVE_INFINITY;
		if (candidate >= segment.fromMs && candidate < segmentEnd) {
			earliest = Math.min(earliest, candidate);
		}
	}
	if (Number.isFinite(earliest)) return new Date(earliest);

	// 春季跳变时没有任何 instant 能表示这段墙上时间，下界应是偏移切换本身。
	for (let index = 1; index < segments.length; index++) {
		const previous = segments[index - 1];
		const current = segments[index];
		if (!previous || !current) continue;
		const previousWallMs = current.fromMs + previous.offsetMinutes * MINUTE_MS;
		const currentWallMs = current.fromMs + current.offsetMinutes * MINUTE_MS;
		if (previousWallMs <= wallMs && wallMs < currentWallMs) return new Date(current.fromMs);
	}
	throw new RangeError(`Cannot resolve usage bucket label in ${timeZone}: ${label}`);
}

/** 查询跨度内该时区的偏移分段：DST 切换一次多一段，SQL 侧据此按区间取偏移。 */
export function offsetSegments(start: Date, end: Date, timeZone: string): OffsetSegment[] {
	const from = start.getTime();
	const to = end.getTime();
	const segments: OffsetSegment[] = [
		{ fromMs: from, offsetMinutes: offsetMinutesAt(start, timeZone) },
	];
	if (to <= from) return segments;
	let cursor = from;
	while (cursor < to) {
		const next = Math.min(cursor + OFFSET_SCAN_STEP_MS, to);
		const offset = offsetMinutesAt(new Date(next), timeZone);
		const last = segments[segments.length - 1];
		if (offset !== last.offsetMinutes) {
			segments.push({
				fromMs: findOffsetChange(last.offsetMinutes, cursor, next, timeZone),
				offsetMinutes: offset,
			});
		}
		cursor = next;
	}
	return segments;
}

function findOffsetChange(
	previousOffset: number,
	low: number,
	high: number,
	timeZone: string,
): number {
	let lo = low;
	let hi = high;
	// 收敛到毫秒：DST 切换点在整点/半点，留一分钟模糊就会让边界那一小时的归属飘。
	while (hi - lo > 1) {
		const mid = lo + Math.floor((hi - lo) / 2);
		if (offsetMinutesAt(new Date(mid), timeZone) === previousOffset) lo = mid;
		else hi = mid;
	}
	return hi;
}
