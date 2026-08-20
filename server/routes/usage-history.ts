import {
	buildRawDumpEnvelope,
	isServableDumpFilePath,
	REQUEST_DUMP_SPILL_POINTER_SCHEMA,
	redactSpillPointerPaths,
} from "@server/lib/api-request-dump-store";
import { buildAttachmentDisposition } from "@server/lib/content-disposition";
import { ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { decodeUsageHistoryCursor } from "@server/lib/usage-history-cursor";
import { requireAdmin, requireAuth } from "@server/middleware/auth";
import {
	listProviderCredentialTotals,
	serializeCredentialUsageTotalsList,
} from "@server/services/credential-usage-totals";
import {
	type RawDumpSource,
	type UsageHistoryService,
	usageHistoryService,
} from "@server/services/usage-history-service";
import { Hono } from "hono";
import { z } from "zod";

export type UsageHistoryRouteService = Pick<
	UsageHistoryService,
	| "listUsageHistoryCursor"
	| "listUsageHistory"
	| "listProviders"
	| "getUsageStats"
	| "getUsageTimeSeries"
	| "getUsageRecord"
	| "getRawDumpSource"
	| "getUsageBreakdown"
	| "getUsageTimeSeriesStacked"
>;

interface UsageHistoryRouteOptions {
	requireAuth?: typeof requireAuth;
	requireAdmin?: typeof requireAdmin;
	service?: UsageHistoryRouteService;
}

// 查询参数 schema
const listFilterShape = {
	narratorId: z.string().optional(),
	chapterId: z.string().optional(),
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
	narratorId: z.string().optional(),
	chapterId: z.string().optional(),
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

const credentialTotalsQuerySchema = z.object({
	provider: z.string().min(1),
	limit: z.coerce.number().int().positive().max(1000).default(200),
});

const breakdownQuerySchema = statsQuerySchema.extend({
	dimension: z.enum(["provider", "model", "kind"]),
	metric: z.enum(["requests", "tokens", "cost", "inputTokens", "outputTokens", "reasoningTokens"]),
	cluster: z
		.enum(["true", "false", "1", "0"])
		.default("true")
		.transform((v) => v === "true" || v === "1"),
});

const stackedTimeSeriesQuerySchema = statsQuerySchema.extend({
	dimension: z.enum(["provider", "model", "kind"]),
	metric: z.enum(["requests", "tokens", "cost", "inputTokens", "outputTokens", "reasoningTokens"]),
	granularity: z.enum(["hour", "day", "month"]).default("day"),
	topN: z.coerce.number().int().positive().max(10).default(5),
	cluster: z
		.enum(["true", "false", "1", "0"])
		.default("true")
		.transform((v) => v === "true" || v === "1"),
});

/**
 * Extract a spilled dump's file path from a stored `raw_dump_json`, or null.
 *
 * Validates the path against the directories dumps are written to. The value came from our
 * own database, so this is defense in depth: a corrupted or hand-edited row must not turn
 * the download route into an arbitrary-file reader.
 */
function readSpillFilePath(rawDumpJson: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawDumpJson);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const spill = (parsed as { spill?: unknown }).spill;
	if (spill == null || typeof spill !== "object" || Array.isArray(spill)) return null;
	const { schema, filePath } = spill as { schema?: unknown; filePath?: unknown };
	if (schema !== REQUEST_DUMP_SPILL_POINTER_SCHEMA) return null;
	if (typeof filePath !== "string" || !isServableDumpFilePath(filePath)) return null;
	return filePath;
}

/**
 * The row's dump, wrapped in the same envelope a spill file carries, with the spill
 * pointer's server-side path removed.
 *
 * Both download paths must hand back one shape. Returning the bare `raw_dump_json` here
 * made the response shape depend on whether the dump happened to exceed a row budget —
 * an invisible difference to whoever writes the tooling that reads these files, and it
 * dropped the request identity (narrator/chapter/project/credential) that the previous
 * client-side export attached. A dump gets forwarded to whoever is helping diagnose it, so
 * "which conversation was this" has to travel with it.
 *
 * Only reached when no file is served, so the parse cost is paid on a bounded head (the row
 * is clamped to the inline ceiling) rather than on a multi-MB file. An unparseable row is
 * still enveloped, with the text preserved verbatim under `dumpText`: re-encoding would
 * destroy the malformed text someone is trying to read, and silently returning it bare
 * would break the shape promise for exactly the rows that need explaining.
 */
function inlineDumpEnvelope(record: RawDumpSource, rawDumpJson: string): string {
	const meta = {
		requestId: record.id,
		createdAt: record.createdAt,
		narratorId: record.narratorId,
		narratorTitle: record.narratorTitle,
		chapterId: record.chapterId,
		chapterTitle: record.chapterTitle,
		projectId: record.projectId,
		kind: record.kind,
		provider: record.provider,
		model: record.model,
		credentialId: record.credentialId,
		credentialName: record.credentialName,
		errorMessage: record.errorMessage,
	};
	try {
		return JSON.stringify(
			buildRawDumpEnvelope(meta, redactSpillPointerPaths(JSON.parse(rawDumpJson))),
		);
	} catch {
		return JSON.stringify({
			...buildRawDumpEnvelope(meta, null),
			dumpParseError: "The stored dump is not valid JSON; its text is preserved verbatim below.",
			dumpText: rawDumpJson,
		});
	}
}

export function createUsageHistoryRoutes(options: UsageHistoryRouteOptions = {}) {
	const routes = new Hono();
	const authMiddleware = options.requireAuth ?? requireAuth;
	const adminMiddleware = options.requireAdmin ?? requireAdmin;
	const service = options.service ?? usageHistoryService;

	routes.use("*", authMiddleware, adminMiddleware);

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
		const result = await service.listUsageHistory(filters, page, pageSize);

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
		const providers = await service.listProviders();
		return c.json({ providers });
	});

	/**
	 * GET /api/usage-history/stats
	 * 获取使用统计
	 */
	routes.get("/stats", async (c) => {
		const filters = statsQuerySchema.parse(c.req.query());
		const stats = await service.getUsageStats(filters);
		return c.json(stats);
	});

	/**
	 * GET /api/usage-history/timeseries
	 * 获取后端聚合后的时间序列统计
	 */
	routes.get("/timeseries", async (c) => {
		const query = timeSeriesQuerySchema.parse(c.req.query());
		const { granularity, ...filters } = query;
		const result = await service.getUsageTimeSeries(filters, { granularity });
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
		const result = await service.getUsageBreakdown(filters, { dimension, metric, cluster });
		return c.json(result);
	});

	/**
	 * GET /api/usage-history/timeseries-stacked
	 * 按维度+时间分组的堆叠时序数据
	 */
	routes.get("/timeseries-stacked", async (c) => {
		const query = stackedTimeSeriesQuerySchema.parse(c.req.query());
		const { dimension, metric, granularity, topN, cluster, ...filters } = query;
		const result = await service.getUsageTimeSeriesStacked(filters, {
			dimension,
			metric,
			granularity,
			topN,
			cluster,
		});
		return c.json(result);
	});

	/**
	 * GET /api/usage-history/:id/raw-dump
	 *
	 * Download the COMPLETE dump for one request, as an attachment.
	 *
	 * The point of this route is that "download" must never hand back a preview. A dump
	 * larger than the row budget lives in a file (see `api-request-dump-store`), and
	 * building the response from the database row would silently return the truncated head
	 * — the failure this route exists to remove. So when the row carries a spill pointer,
	 * the file is streamed verbatim.
	 *
	 * Registered before `/:id` so the literal sub-path wins.
	 */
	routes.get("/:id/raw-dump", async (c) => {
		const id = c.req.param("id");
		if (!id) return c.json({ error: "Missing usage record ID" }, 400);

		const record = await service.getRawDumpSource(id);
		if (!record) return c.json({ error: "Usage record not found" }, 404);
		if (!record.rawDumpJson) {
			return c.json(
				{
					error:
						"No raw dump stored for this request. Dumps are retained when request dumping is enabled, when a leak is detected, or when the upstream rejected the request body.",
				},
				404,
			);
		}

		const fileName = `api-request-${record.createdAt.replace(/[:.]/g, "-")}-${record.id}.json`;
		const attachmentHeaders = {
			// octet-stream, never application/json: the payload is attacker-influenced text
			// on a same-origin URL, so an honest content type would invite sniffing.
			"Content-Type": "application/octet-stream",
			"Content-Disposition": buildAttachmentDisposition(fileName),
			// A dump is served under a session credential and may be re-spilled or pruned.
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		} as const;

		const spillPath = readSpillFilePath(record.rawDumpJson);
		if (spillPath) {
			const file = Bun.file(spillPath);
			if (await file.exists()) {
				// Stream the file as-is. Parsing it here to re-wrap it would pull the whole
				// multi-MB dump onto the main thread for no gain.
				return new Response(file, { headers: attachmentHeaders });
			}
			// Pruned or hand-deleted: fall through to the inline head rather than 404, so the
			// user still gets the part that survived plus the pointer explaining what is missing.
			logger.warn("Spilled API request dump file is missing; serving the inline head", {
				requestId: record.id,
				filePath: spillPath,
			});
			// Falls through to the row-serving path below.
		}

		// Every path that serves the ROW rather than the file goes through here: the file was
		// pruned, the pointer was unusable, or the dump never spilled. A row that carries a
		// pointer carries an absolute server path naming the host's OS account, and a
		// downloaded dump gets forwarded to whoever is helping diagnose it — so the path is
		// stripped regardless of WHY the row is being served. Redacting only on the
		// pruned-file branch would have left the unusable-pointer branch leaking it.
		return new Response(inlineDumpEnvelope(record, record.rawDumpJson), {
			headers: attachmentHeaders,
		});
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
