import { ValidationError } from "@server/lib/errors";
import { decodeUsageHistoryCursor } from "@server/lib/usage-history-cursor";
import { tokenRecalculationRangeSchema } from "@server/lib/validators/token-recalculation";
import { requireAdmin, requireAuth } from "@server/middleware/auth";
import {
	listProviderCredentialTotals,
	serializeCredentialUsageTotalsList,
} from "@server/services/credential-usage-totals";
import {
	getTokenRecalculationService,
	type TokenRecalculationService,
} from "@server/services/token-recalculation-service";
import {
	type UsageHistoryService,
	usageHistoryService,
} from "@server/services/usage-history-service";
import { listUserUsageTotals } from "@server/services/user-usage-totals";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

export type UsageHistoryRouteService = Pick<
	UsageHistoryService,
	| "listUsageHistoryCursor"
	| "listUsageHistory"
	| "listProviders"
	| "getUsageStats"
	| "getUsageTimeSeries"
	| "getUsageRecord"
	| "getUsageBreakdown"
	| "getUsageTimeSeriesStacked"
>;

interface UsageHistoryRouteOptions {
	requireAuth?: typeof requireAuth;
	requireAdmin?: typeof requireAdmin;
	service?: UsageHistoryRouteService;
	listUserUsageTotals?: typeof listUserUsageTotals;
	recalculationService?: Pick<TokenRecalculationService, "get" | "start" | "cancel">;
}

// 查询参数 schema
const listFilterShape = {
	userId: z.string().trim().max(128).optional(),
	narratorId: z.string().optional(),
	projectId: z.string().optional(),
	provider: z.string().optional(),
	credentialId: z.string().optional(),
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
	userId: z.string().trim().max(128).optional(),
	narratorId: z.string().optional(),
	projectId: z.string().optional(),
	provider: z.string().optional(),
	credentialId: z.string().optional(),
	model: z.string().optional(),
	kind: z.string().optional(),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
});

const timeSeriesQuerySchema = statsQuerySchema.extend({
	granularity: z.enum(["hour", "day", "month"]).default("day"),
});

const userTotalsQuerySchema = z.object({
	limit: z.coerce.number().int().positive().max(100).default(50),
	cursor: z.string().trim().min(1).max(128).optional(),
});

const credentialTotalsQuerySchema = z.object({
	provider: z.string().min(1),
	limit: z.coerce.number().int().positive().max(1000).default(200),
});

const breakdownQuerySchema = statsQuerySchema.extend({
	dimension: z.enum(["provider", "model", "kind", "user"]),
	metric: z.enum([
		"requests",
		"tokens",
		"cost",
		"inputTokens",
		"outputTokens",
		"cachedInputTokens",
		"cacheCreationTokens",
		"cacheHitRate",
		"reasoningTokens",
	]),
	cluster: z
		.enum(["true", "false", "1", "0"])
		.default("true")
		.transform((v) => v === "true" || v === "1"),
});

const stackedTimeSeriesQuerySchema = statsQuerySchema.extend({
	dimension: z.enum(["provider", "model", "kind", "user"]),
	metric: z.enum([
		"requests",
		"tokens",
		"cost",
		"inputTokens",
		"outputTokens",
		"cachedInputTokens",
		"cacheCreationTokens",
		"cacheHitRate",
		"reasoningTokens",
	]),
	granularity: z.enum(["hour", "day", "month"]).default("day"),
	topN: z.coerce.number().int().positive().max(10).default(5),
	cluster: z
		.enum(["true", "false", "1", "0"])
		.default("true")
		.transform((v) => v === "true" || v === "1"),
});

export function createUsageHistoryRoutes(options: UsageHistoryRouteOptions = {}) {
	const routes = new Hono();
	const authMiddleware = options.requireAuth ?? requireAuth;
	const adminMiddleware = options.requireAdmin ?? requireAdmin;
	const service = options.service ?? usageHistoryService;

	routes.use("*", authMiddleware, adminMiddleware);

	const recalculation = () => options.recalculationService ?? getTokenRecalculationService();
	routes.get("/token-recalculation", (c) => c.json({ job: recalculation().get() }));
	routes.post(
		"/token-recalculation",
		bodyLimit({
			maxSize: 1024,
			onError: (c) =>
				c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1024 bytes" }, 413),
		}),
		async (c) => {
			const body = await c.req.json().catch((error: unknown) => {
				if (error instanceof Error && error.name === "BodyLimitError") throw error;
				throw new ValidationError("Invalid JSON body");
			});
			const range = tokenRecalculationRangeSchema.safeParse(body);
			if (!range.success) throw new ValidationError("Invalid UTC date range");
			return c.json({ job: recalculation().start(range.data) }, 202);
		},
	);
	routes.post("/token-recalculation/:id/cancel", (c) =>
		c.json({ job: recalculation().cancel(c.req.param("id")) }),
	);

	// Lifetime totals are independent of the date-filtered, removable history.
	routes.get("/user-totals", (c) => {
		const { limit, cursor } = userTotalsQuerySchema.parse(c.req.query());
		return c.json((options.listUserUsageTotals ?? listUserUsageTotals)(limit, cursor));
	});

	/**
	 * GET /api/usage-history
	 * 获取使用历史记录列表（兼容 page 与 cursor 两种分页模式）
	 */
	routes.get("/", async (c) => {
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
			const result = await service.listUsageHistoryCursor(filters, limit, cursor ?? undefined);

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
		const result = await service.listUsageHistory(filters, page, pageSize, {
			signal: c.req.raw.signal,
		});

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
	routes.get("/providers", async (c) => {
		const providers = await service.listProviders({ signal: c.req.raw.signal });
		return c.json({ providers });
	});

	/**
	 * GET /api/usage-history/stats
	 * 获取使用统计
	 */
	routes.get("/stats", async (c) => {
		const filters = statsQuerySchema.parse(c.req.query());
		const stats = await service.getUsageStats(filters, { signal: c.req.raw.signal });
		return c.json(stats);
	});

	/**
	 * GET /api/usage-history/timeseries
	 * 获取后端聚合后的时间序列统计
	 */
	routes.get("/timeseries", async (c) => {
		const query = timeSeriesQuerySchema.parse(c.req.query());
		const { granularity, ...filters } = query;
		const result = await service.getUsageTimeSeries(
			filters,
			{ granularity },
			{ signal: c.req.raw.signal },
		);
		return c.json(result);
	});

	/**
	 * GET /api/usage-history/credential-totals?provider=codex
	 *
	 * Lifetime token/cost totals per credential. Unlike everything else on this
	 * route these come from `credential_usage_totals`, not `api_requests`, so they
	 * survive narrator deletion. Registered before `/:id` so the literal path wins.
	 */
	routes.get("/credential-totals", (c) => {
		const query = credentialTotalsQuerySchema.parse(c.req.query());
		return c.json({
			provider: query.provider,
			entries: serializeCredentialUsageTotalsList(
				listProviderCredentialTotals(query.provider, query.limit),
			),
		});
	});

	/**
	 * GET /api/usage-history/breakdown
	 * 按维度聚合统计数据
	 */
	routes.get("/breakdown", async (c) => {
		const query = breakdownQuerySchema.parse(c.req.query());
		const { dimension, metric, cluster, ...filters } = query;
		const result = await service.getUsageBreakdown(
			filters,
			{ dimension, metric, cluster },
			{ signal: c.req.raw.signal },
		);
		return c.json(result);
	});

	/**
	 * GET /api/usage-history/timeseries-stacked
	 * 按维度+时间分组的堆叠时序数据
	 */
	routes.get("/timeseries-stacked", async (c) => {
		const query = stackedTimeSeriesQuerySchema.parse(c.req.query());
		const { dimension, metric, granularity, topN, cluster, ...filters } = query;
		const result = await service.getUsageTimeSeriesStacked(
			filters,
			{
				dimension,
				metric,
				granularity,
				topN,
				cluster,
			},
			{ signal: c.req.raw.signal },
		);
		return c.json(result);
	});

	/**
	 * GET /api/usage-history/:id
	 * 获取单条使用记录详情
	 */
	routes.get("/:id", async (c) => {
		const id = c.req.param("id");

		if (!id) {
			return c.json({ error: "Missing usage record ID" }, 400);
		}

		const record = await service.getUsageRecord(id);

		if (!record) {
			return c.json({ error: "Usage record not found" }, 404);
		}

		return c.json(record);
	});

	return routes;
}

const usageHistoryRoutes = createUsageHistoryRoutes();

export default usageHistoryRoutes;
