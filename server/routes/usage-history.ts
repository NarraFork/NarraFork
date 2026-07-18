import { ValidationError } from "@server/lib/errors";
import { decodeUsageHistoryCursor } from "@server/lib/usage-history-cursor";
import { requireAdmin, requireAuth } from "@server/middleware/auth";
import { usageHistoryService } from "@server/services/usage-history-service";
import { Hono } from "hono";
import { z } from "zod";

const usageHistoryRoutes = new Hono();

usageHistoryRoutes.use("*", requireAuth, requireAdmin);

// 查询参数 schema
const listFilterShape = {
	narratorId: z.string().optional(),
	chapterId: z.string().optional(),
	projectId: z.string().optional(),
	provider: z.string().optional(),
	model: z.string().optional(),
	kind: z.string().optional(),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
};

const pageListQuerySchema = z.object({
	...listFilterShape,
	pagination: z.literal("page").default("page"),
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().positive().max(100).default(50),
});

const cursorListQuerySchema = z.object({
	...listFilterShape,
	pagination: z.literal("cursor"),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().positive().max(100).default(50),
});

const statsQuerySchema = z.object({
	narratorId: z.string().optional(),
	chapterId: z.string().optional(),
	projectId: z.string().optional(),
	provider: z.string().optional(),
	model: z.string().optional(),
	kind: z.string().optional(),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
});

const timeSeriesQuerySchema = statsQuerySchema.extend({
	granularity: z.enum(["hour", "day", "month"]).default("day"),
});

/**
 * GET /api/usage-history
 * 获取使用历史记录列表（兼容 page 与 cursor 两种分页模式）
 */
usageHistoryRoutes.get("/", async (c) => {
	const rawQuery = c.req.query();
	const pagination = rawQuery.pagination ?? "page";

	if (pagination === "cursor") {
		if (rawQuery.page !== undefined || rawQuery.pageSize !== undefined) {
			throw new ValidationError("pagination=cursor cannot be combined with page or pageSize");
		}

		const query = cursorListQuerySchema.parse(rawQuery);
		const cursor = decodeUsageHistoryCursor(query.cursor);
		if (query.cursor && !cursor) throw new ValidationError("Invalid usage history cursor");

		const { pagination: _pagination, cursor: _cursor, limit, ...filters } = query;
		const result = await usageHistoryService.listUsageHistoryCursor(
			filters,
			limit,
			cursor ?? undefined,
		);

		return c.json({
			records: result.records,
			hasMore: result.hasMore,
			nextCursor: result.nextCursor,
			limit: result.limit,
		});
	}

	if (pagination !== "page") throw new ValidationError("Invalid usage history pagination mode");
	if (rawQuery.cursor !== undefined || rawQuery.limit !== undefined) {
		throw new ValidationError("pagination=page cannot be combined with cursor or limit");
	}

	const query = pageListQuerySchema.parse(rawQuery);
	const { pagination: _pagination, page, pageSize, ...filters } = query;
	const result = await usageHistoryService.listUsageHistory(filters, page, pageSize);

	return c.json({
		records: result.records,
		total: result.total,
		page,
		pageSize,
		totalPages: Math.ceil(result.total / pageSize),
	});
});

/**
 * GET /api/usage-history/providers
 * 获取历史中出现过的 provider 列表
 */
usageHistoryRoutes.get("/providers", async (c) => {
	const providers = await usageHistoryService.listProviders();
	return c.json({ providers });
});

/**
 * GET /api/usage-history/stats
 * 获取使用统计
 */
usageHistoryRoutes.get("/stats", async (c) => {
	const filters = statsQuerySchema.parse(c.req.query());
	const stats = await usageHistoryService.getUsageStats(filters);
	return c.json(stats);
});

/**
 * GET /api/usage-history/timeseries
 * 获取后端聚合后的时间序列统计
 */
usageHistoryRoutes.get("/timeseries", async (c) => {
	const query = timeSeriesQuerySchema.parse(c.req.query());
	const { granularity, ...filters } = query;
	const result = await usageHistoryService.getUsageTimeSeries(filters, { granularity });
	return c.json(result);
});

/**
 * GET /api/usage-history/:id
 * 获取单条使用记录详情
 */
usageHistoryRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");

	if (!id) {
		return c.json({ error: "Missing usage record ID" }, 400);
	}

	const record = await usageHistoryService.getUsageRecord(id);

	if (!record) {
		return c.json({ error: "Usage record not found" }, 404);
	}

	return c.json(record);
});

export default usageHistoryRoutes;
