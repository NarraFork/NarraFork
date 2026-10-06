import { ValidationError } from "@server/lib/errors";
import { decodeExecutionLogCursor } from "@server/lib/execution-log-cursor";
import { requireAdmin, requireAuth } from "@server/middleware/auth";
import {
	type ExecutionLogService,
	executionLogService,
	MAX_EXECUTION_LOG_LIMIT,
} from "@server/services/execution-log-service";
import { Hono } from "hono";
import { z } from "zod";

export type ExecutionLogRouteService = Pick<
	ExecutionLogService,
	"listCursor" | "getRecord" | "listFacets"
>;

interface ExecutionLogRouteOptions {
	requireAuth?: typeof requireAuth;
	requireAdmin?: typeof requireAdmin;
	service?: ExecutionLogRouteService;
}

/** `?flag=1|true` → true, `0|false` → false, absent → undefined. */
const booleanFlag = z
	.union([z.literal("1"), z.literal("0"), z.literal("true"), z.literal("false")])
	.transform((value) => value === "1" || value === "true")
	.optional();

const listQuerySchema = z.object({
	narratorId: z.string().min(1).max(128).optional(),
	includeSubagents: booleanFlag,
	chapterId: z.string().min(1).max(128).optional(),
	projectId: z.string().min(1).max(128).optional(),
	toolName: z.string().min(1).max(128).optional(),
	status: z.enum(["initializing", "pending", "running", "success", "fail"]).optional(),
	executionDeviceId: z.string().min(1).max(128).optional(),
	provider: z.string().min(1).max(128).optional(),
	model: z.string().max(128).optional(),
	onlyErrors: booleanFlag,
	isBackground: booleanFlag,
	hideFileHistoryCheckpoints: booleanFlag,
	startDate: z.string().max(64).optional(),
	endDate: z.string().max(64).optional(),
	q: z.string().max(128).optional(),
	searchPayload: booleanFlag,
	cursor: z.string().max(512).optional(),
	limit: z.coerce.number().int().positive().max(MAX_EXECUTION_LOG_LIMIT).default(50),
});

export function createExecutionLogRoutes(options: ExecutionLogRouteOptions = {}) {
	const routes = new Hono();
	const authMiddleware = options.requireAuth ?? requireAuth;
	const adminMiddleware = options.requireAdmin ?? requireAdmin;
	const service = options.service ?? executionLogService;

	routes.use("*", authMiddleware, adminMiddleware);

	/**
	 * GET /api/execution-log
	 *
	 * Cursor-paginated tool calls across every narrator, newest execution first.
	 * Cursor-only by design: an offset/`COUNT(*)` mode would have to scan a table
	 * measured at 561k rows on every page.
	 */
	routes.get("/", async (c) => {
		const query = listQuerySchema.parse(c.req.query());
		const cursor = decodeExecutionLogCursor(query.cursor);
		if (query.cursor && !cursor) throw new ValidationError("Invalid execution log cursor");
		// A payload search without a needle would silently widen to the whole window
		// for no benefit; reject it so the client's intent stays explicit.
		if (query.searchPayload && !query.q?.trim()) {
			throw new ValidationError("searchPayload requires a non-empty q");
		}

		const { cursor: _cursor, limit, ...filters } = query;
		const result = await service.listCursor(filters, limit, cursor ?? undefined);
		return c.json(result);
	});

	/**
	 * GET /api/execution-log/facets
	 * Filter options (tool names, statuses, providers). Registered before `/:id`.
	 */
	routes.get("/facets", async (c) => {
		return c.json(await service.listFacets());
	});

	/**
	 * GET /api/execution-log/:id
	 * Full detail for one call, including byte-capped input/output payloads.
	 */
	routes.get("/:id", async (c) => {
		const id = c.req.param("id");
		if (!id) return c.json({ error: "Missing execution log record ID" }, 400);

		const record = await service.getRecord(id);
		if (!record) return c.json({ error: "Execution log record not found" }, 404);

		return c.json(record);
	});

	return routes;
}

const executionLogRoutes = createExecutionLogRoutes();

export default executionLogRoutes;
