import { STORAGE_RETENTION_TARGETS } from "@shared/storage-retention";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { AppError } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { getStorageHistoryService } from "../services/storage-history-runtime";
import type { createStorageHistoryService } from "../services/storage-history-service";

const selectionSchema = z.strictObject({
	target: z.enum(STORAGE_RETENTION_TARGETS),
	cutoffAt: z.string().max(64).datetime({ offset: true }),
});
const targetSchema = z.strictObject({ target: z.enum(STORAGE_RETENTION_TARGETS) });
type Service = ReturnType<typeof createStorageHistoryService>;

async function readBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		if (error instanceof Error && error.name === "BodyLimitError")
			throw new AppError("History cleanup request is too large", 413, "HISTORY_REQUEST_TOO_LARGE");
		throw error;
	}
}

export function createStorageHistoryRoutes(getService: () => Service = getStorageHistoryService) {
	const routes = new Hono();
	routes.use(
		"*",
		requireAdmin,
		bodyLimit({
			maxSize: 8192,
			onError: (c) => c.json({ error: "History cleanup request is too large" }, 413),
		}),
	);
	routes.get("/jobs", async (c) => c.json({ jobs: await getService().jobs() }));
	routes.post("/preview", async (c) => {
		const parsed = selectionSchema.safeParse(await readBody(c));
		if (!parsed.success) return c.json({ error: "Choose a history type and cutoff date" }, 400);
		const preview = await getService().preview(
			parsed.data.target,
			parsed.data.cutoffAt,
			c.req.raw.signal,
		);
		return c.json({ preview });
	});
	routes.post("/cleanup", async (c) => {
		const parsed = selectionSchema.safeParse(await readBody(c));
		if (!parsed.success) return c.json({ error: "Choose a history type and cutoff date" }, 400);
		const job = await getService().start(parsed.data.target, parsed.data.cutoffAt);
		return c.json({ job }, 202);
	});
	routes.post("/cancel", async (c) => {
		const parsed = targetSchema.safeParse(await readBody(c));
		if (!parsed.success) return c.json({ error: "Choose a history type" }, 400);
		return c.json({ job: await getService().cancel(parsed.data.target) });
	});
	return routes;
}

export const storageHistoryRoutes = createStorageHistoryRoutes();
