import { requireAuth } from "@server/middleware/auth";
import { usageHistoryService } from "@server/services/usage-history-service";
import { Hono } from "hono";
import { z } from "zod";

const usageHistoryRoutes = new Hono();

// 查询参数 schema
const listQuerySchema = z.object({
	narratorId: z.string().optional(),
	chapterId: z.string().optional(),
	projectId: z.string().optional(),
	provider: z.string().optional(),
	model: z.string().optional(),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().positive().max(100).default(50),
});

const statsQuerySchema = z.object({
	narratorId: z.string().optional(),
	chapterId: z.string().optional(),
	projectId: z.string().optional(),
	provider: z.string().optional(),
	model: z.string().optional(),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
});

/**
 * GET /api/usage-history
 * 获取使用历史记录列表（分页）
 */
usageHistoryRoutes.get("/", requireAuth, async (c) => {
	const query = listQuerySchema.parse(c.req.query());
	const { page, pageSize, ...filters } = query;

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
 * GET /api/usage-history/stats
 * 获取使用统计
 */
usageHistoryRoutes.get("/stats", requireAuth, async (c) => {
	const filters = statsQuerySchema.parse(c.req.query());
	const stats = await usageHistoryService.getUsageStats(filters);
	return c.json(stats);
});

/**
 * GET /api/usage-history/:id
 * 获取单条使用记录详情
 */
usageHistoryRoutes.get("/:id", requireAuth, async (c) => {
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
