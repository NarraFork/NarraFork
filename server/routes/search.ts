import { Hono } from "hono";
import { searchService, sortSearchResults } from "../services/search-service";

export const searchRoutes = new Hono();

/** Entity names `/api/search` accepts. Anything else in the query is ignored. */
const SEARCH_ENTITIES = ["chapters", "messages", "narrators", "knowledge"] as const;

searchRoutes.get("/", async (c) => {
	const q = c.req.query("q");
	if (!q?.trim()) return c.json({ results: [] });

	const entitiesParam = c.req.query("entities") ?? "chapters,messages,narrators,knowledge";
	const entities = entitiesParam
		.split(",")
		.filter((e): e is (typeof SEARCH_ENTITIES)[number] =>
			(SEARCH_ENTITIES as readonly string[]).includes(e),
		);

	if (entities.length === 0) {
		return c.json({ results: [] });
	}

	const rawLimit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 100);

	const user = c.get("user");
	const principal = { userId: user.sub, isAdmin: user.role === "admin" };
	const query = q.trim();

	const results = searchService.search({
		query,
		entities,
		limit,
		// Narrator and message hits are filtered to what this user may read; chapter
		// hits are unaffected (chapters have no per-user ACL).
		principal,
	});

	// Knowledge lives on its own async path: its visibility gate reads grants, so it
	// cannot ride along in the synchronous SQL search. Merged here and re-sorted with
	// the shared comparator so one ordering governs the whole response.
	if (entities.includes("knowledge")) {
		const knowledgeResults = await searchService.searchKnowledge({ query, limit, principal });
		if (knowledgeResults.length > 0) {
			return c.json({ results: sortSearchResults([...results, ...knowledgeResults]) });
		}
	}

	return c.json({ results });
});
