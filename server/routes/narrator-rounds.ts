import { Hono } from "hono";
import { requireNarratorAccess } from "../lib/narrator-access";
import { narratorRoundsQuerySchema } from "../lib/validators/narrator-rounds";
import { listNarratorRounds } from "../services/narrator-rounds";
import { requireSqliteNarratorSurface } from "./narrators";

/**
 * 轮次索引（只读）。挂在 `/api/narrators` 下，自带访问门与 PostgreSQL 准入门 ——
 * 不依赖 `routes/narrators.ts` 的中间件。
 */
export const narratorRoundsRoutes = new Hono();

narratorRoundsRoutes.use("/:id/rounds", async (c, next) => {
	requireSqliteNarratorSurface();
	await requireNarratorAccess(c, c.req.param("id") ?? "", "read");
	return next();
});

/** GET /:id/rounds?beforeSeq=&limit= — 导航轨的一页轮次（按 seq 升序）。 */
narratorRoundsRoutes.get("/:id/rounds", async (c) => {
	const query = narratorRoundsQuerySchema.parse(c.req.query());
	return c.json(
		await listNarratorRounds(c.req.param("id"), {
			...query,
			signal: c.req.raw.signal,
		}),
	);
});
