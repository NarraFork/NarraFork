import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { searchSectionsQuerySchema, searchSessionHitsQuerySchema } from "../lib/validators/search";
import {
	encodeSearchCursor,
	type MessageSearchScope,
	SEARCH_SECTIONS,
	type SearchFilters,
	type SearchSection,
	searchService,
} from "../services/search-service";

export const searchRoutes = new Hono();

/**
 * Content `include` adds to the default scope (primary, unarchived sessions; what people
 * wrote and read). Unknown names are ignored.
 */
const SEARCH_INCLUDES = ["subagents", "system", "tools", "archived"] as const;

function parseScope(include: string | undefined): MessageSearchScope {
	const names = new Set((include ?? "").split(",").map((name) => name.trim()));
	return {
		subagents: names.has("subagents"),
		system: names.has("system"),
		tools: names.has("tools"),
		archived: names.has("archived"),
	} satisfies Record<(typeof SEARCH_INCLUDES)[number], boolean>;
}

function parseSections(value: string | undefined): SearchSection[] {
	const names = new Set((value ?? "").split(",").map((name) => name.trim()));
	const sections = SEARCH_SECTIONS.filter((section) => names.has(section));
	return sections.length > 0 ? sections : [...SEARCH_SECTIONS];
}

type BaseQuery = {
	q: string;
	sort?: string;
	include?: string;
	projectId?: string;
	from?: string;
	to?: string;
	mine?: string;
	history?: string;
	cursor?: string;
};

/** What every search request shares: query, sort, scope, filters and the viewer. */
function baseOptions(query: BaseQuery, user: { sub: string; role: string }, signal: AbortSignal) {
	const filters: SearchFilters = {
		projectId: query.projectId,
		from: query.from,
		to: query.to,
		ownerUserId: query.mine === "1" || query.mine === "true" ? user.sub : undefined,
	};
	return {
		query: query.q.trim(),
		sort: query.sort === "time" ? ("time" as const) : ("relevance" as const),
		scope: parseScope(query.include),
		filters,
		// Session and message hits are filtered to what this user may read, knowledge hits by
		// its own grants.
		principal: { userId: user.sub, isAdmin: user.role === "admin" },
		cursor: query.cursor,
		fullHistory: query.history === "all",
		signal,
	};
}

/**
 * Sectioned global search: `{ sections: { sessions?, knowledge? } }`, each a
 * page `{ items, total, totalIsLowerBound, nextCursor }`. A cursor continues one section, so
 * it is honoured only when `sections` names exactly one; so is `page`, which jumps straight
 * to that page of `limit` items.
 */
searchRoutes.get("/", async (c) => {
	const parsed = searchSectionsQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const query = parsed.data;
	if (!query.q.trim()) return c.json({ sections: {} });
	const sections = parseSections(query.sections);
	const limit = query.limit ?? 10;
	const options = baseOptions(query, c.get("user"), c.req.raw.signal);
	const result = await searchService.searchSections({
		...options,
		cursor: query.page ? encodeSearchCursor((query.page - 1) * limit) : options.cursor,
		sections,
		limits: Object.fromEntries(sections.map((section) => [section, limit])),
	});
	return c.json({ sections: result });
});

/** More hits of one session, paged, for expanding its result card. */
searchRoutes.get("/sessions/:narratorId/hits", async (c) => {
	const parsed = searchSessionHitsQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const query = parsed.data;
	if (!query.q.trim()) return c.json({ hits: [], nextCursor: null });
	const result = await searchService.searchSessionHits({
		...baseOptions(query, c.get("user"), c.req.raw.signal),
		narratorId: c.req.param("narratorId"),
		limit: query.limit,
	});
	return c.json(result);
});
