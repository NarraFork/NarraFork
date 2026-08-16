import { Hono } from "hono";
import { searchService } from "../services/search-service";

export const searchRoutes = new Hono();

searchRoutes.get("/", async (c) => {
	const q = c.req.query("q");
	if (!q?.trim()) return c.json({ results: [] });

	const entitiesParam = c.req.query("entities") ?? "chapters,messages,narrators";
	const entities = entitiesParam
		.split(",")
		.filter((e) => ["chapters", "messages", "narrators"].includes(e));

	if (entities.length === 0) {
		return c.json({ results: [] });
	}

	const rawLimit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 100);

	const user = c.get("user");
	const results = searchService.search({
		query: q.trim(),
		entities,
		limit,
		// Narrator and message hits are filtered to what this user may read; chapter
		// hits are unaffected (chapters have no per-user ACL).
		principal: { userId: user.sub, isAdmin: user.role === "admin" },
	});

	return c.json({ results });
});
