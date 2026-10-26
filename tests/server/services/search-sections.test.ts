/**
 * Sectioned global search: sessions and knowledge, each ranked within itself and
 * paged on its own, against a real FTS index.
 *
 * Sessions are the point: a session shows up once however many of its messages match, with
 * an exact hit count, its first few hits, and the rest pageable. Filters (project,
 * time, owner) and the archived scope narrow every section they mean something to.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Hono } from "hono";
import { narratorMessages, narrators, projects, users } from "../../../server/db/schema";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const { ensureFts } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { createSqliteSearchStore } = await import("../../../server/services/search/sqlite-store");
const searchStore = createSqliteSearchStore(async (sql, params) =>
	sqlite.prepare<Record<string, unknown>, Array<string | number | null>>(sql).all(...params),
);
mock.module("../../../server/services/search/backend", () => ({ searchStore }));
const {
	clearSessionSearchCache,
	decodeSearchCursor,
	encodeSearchCursor,
	mergeSessionCandidates,
	rankSessions,
	SHORT_QUERY_RECENT_DAYS,
	searchService,
	sessionSearchWindow,
} = await import("../../../server/services/search-service");
const { searchRoutes } = await import("../../../server/routes/search");

const OWNER = "owner";
const OTHER = "other";
const ADMIN = { userId: "admin", isAdmin: true };

function appFor(userId: string, role: "admin" | "user" = "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: 2_000_000_000 });
		await next();
	});
	app.route("/api/search", searchRoutes);
	// Production's global handler serializes AppErrors with their status.
	app.onError((error, c) =>
		c.json({ error: error.message }, ((error as { statusCode?: number }).statusCode ?? 500) as 400),
	);
	return app;
}

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();

function seedNarrator(
	id: string,
	options: {
		title?: string;
		projectId?: string;
		owner?: string;
		visibility?: "public" | "private";
		status?: "idle" | "archived";
		type?: "primary" | "subagent";
		lastMessageAt?: string;
	} = {},
) {
	db.insert(narrators)
		.values({
			id,
			title: options.title ?? null,
			contextProjectId: options.projectId ?? "proj-a",
			type: options.type ?? "primary",
			inheritMode: "fresh",
			visibility: options.visibility ?? "public",
			ownerUserId: options.owner ?? OWNER,
			status: options.status ?? "idle",
			lastMessageAt: options.lastMessageAt ?? null,
			createdAt: day(1),
			updatedAt: day(1),
		})
		.run();
}

let messageSeq = 0;
function seedMessage(narratorId: string, text: string, createdAt: string, role = "assistant") {
	messageSeq += 1;
	const id = `${narratorId}-m${messageSeq}`;
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role: role as "assistant",
			contentText: text,
			contentJson: [{ type: "text", text }],
			createdAt,
		})
		.run();
	return id;
}

beforeEach(() => {
	for (const id of [OWNER, OTHER, "admin"]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: day(1) })
			.run();
	}
	for (const id of ["proj-a", "proj-b"]) {
		db.insert(projects)
			.values({
				id,
				name: id,
				gitPath: `/tmp/${id}`,
				visibility: "public",
				ownerUserId: OWNER,
				createdAt: day(1),
				updatedAt: day(1),
			})
			.run();
	}
});

afterEach(() => {
	clearSessionSearchCache();
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of ["narrator_messages", "narrators", "projects", "users"]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
	messageSeq = 0;
});

type Sections = Awaited<ReturnType<typeof searchService.searchSections>>;

async function sessions(
	query: string,
	options: Partial<Parameters<typeof searchService.searchSections>[0]> = {},
): Promise<NonNullable<Sections["sessions"]>> {
	const result = await searchService.searchSections({
		query,
		sections: ["sessions"],
		principal: ADMIN,
		limits: { sessions: 10 },
		...options,
	});
	return result.sessions as NonNullable<Sections["sessions"]>;
}

describe("session results", () => {
	it("count every hit of a session, list its best few, and show it once", async () => {
		seedNarrator("long");
		for (let i = 0; i < 30; i++) seedMessage("long", `kestrel note ${i}`, day(3));
		seedNarrator("short");
		seedMessage("short", "one kestrel remark", day(4));

		const page = await sessions("kestrel");
		expect(page.items.map((s) => [s.id, s.hitCount, s.hits.length])).toEqual(
			expect.arrayContaining([
				["long", 30, 3],
				["short", 1, 1],
			]),
		);
		expect(page.total).toBe(2);
		expect(page.totalIsLowerBound).toBe(false);
		const short = page.items.find((s) => s.id === "short");
		expect(short?.hits[0]).toMatchObject({ messageRole: "assistant", createdAt: day(4) });
		expect(short?.projectId).toBe("proj-a");
		expect(short?.projectName).toBe("proj-a");
	});

	it("merges a title match with the same session's message hits", async () => {
		seedNarrator("titled", { title: "Kestrel rollout", lastMessageAt: day(5) });
		seedMessage("titled", "kestrel rollout step one", day(5));
		seedNarrator("title-only", { title: "Kestrel follow-up", lastMessageAt: day(6) });

		const page = await sessions("kestrel");
		const byId = new Map(page.items.map((s) => [s.id, s]));
		expect(page.items).toHaveLength(2);
		expect(byId.get("titled")).toMatchObject({ titleMatch: true, hitCount: 1 });
		expect(byId.get("title-only")).toMatchObject({
			titleMatch: true,
			hitCount: 0,
			hits: [],
			lastActivityAt: day(6),
		});
	});

	it("finds two-character CJK terms through the substring path with a centered excerpt", async () => {
		seedNarrator("cjk");
		const lead = "这是一段很长的前文，用来把命中位置推到预览窗口之外。".repeat(6);
		seedMessage("cjk", `${lead}登录失败的原因已经找到`, day(3));

		// The fixed fixture date ages out of the recent window, so search the full history.
		const page = await sessions("登录", { fullHistory: true });
		expect(page.items.map((s) => s.id)).toEqual(["cjk"]);
		const snippet = page.items[0]?.hits[0]?.snippet ?? "";
		expect(snippet.startsWith("...")).toBe(true);
		expect(snippet).toContain("登录失败");
	});

	it("pages sessions with a cursor and keeps the total exact", async () => {
		for (const id of ["s1", "s2", "s3"]) {
			seedNarrator(id);
			seedMessage(id, "kestrel", day(3));
		}
		const first = await sessions("kestrel", { limits: { sessions: 2 } });
		expect(first.items).toHaveLength(2);
		expect(first.total).toBe(3);
		expect(first.nextCursor).not.toBeNull();
		const second = await sessions("kestrel", {
			limits: { sessions: 2 },
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		expect(new Set([...first.items, ...second.items].map((s) => s.id))).toEqual(
			new Set(["s1", "s2", "s3"]),
		);
	});

	it("pages one session's hits for expanding its card", async () => {
		seedNarrator("long");
		const ids = Array.from({ length: 7 }, (_, i) =>
			seedMessage("long", `kestrel ${i}`, day(10 + i)),
		);
		const base = { query: "kestrel", narratorId: "long", principal: ADMIN, sort: "time" as const };
		const first = await searchService.searchSessionHits({ ...base, limit: 5 });
		expect(first.hits.map((h) => h.id)).toEqual(ids.slice(2).reverse());
		const second = await searchService.searchSessionHits({
			...base,
			limit: 5,
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.hits.map((h) => h.id)).toEqual(ids.slice(0, 2).reverse());
		expect(second.nextCursor).toBeNull();
	});
});

describe("one search serves its pages", () => {
	it("lists each session's newest hits on later pages without searching again", async () => {
		const newest = new Map<string, string[]>();
		for (const id of ["s1", "s2", "s3", "s4"]) {
			seedNarrator(id);
			const ids = Array.from({ length: 5 }, (_, i) => seedMessage(id, `kestrel ${i}`, day(3 + i)));
			newest.set(id, ids.slice(2).reverse());
		}
		const aggregates = spyOn(searchStore, "searchSessionAggregates");
		const hits = spyOn(searchStore, "searchSessionHits");
		try {
			const first = await sessions("kestrel", { limits: { sessions: 2 } });
			const second = await sessions("kestrel", {
				limits: { sessions: 2 },
				cursor: first.nextCursor ?? undefined,
			});
			for (const item of [...first.items, ...second.items]) {
				expect(item.hitCount).toBe(5);
				expect(item.hits.map((h) => h.id)).toEqual(newest.get(item.id) ?? []);
				expect(item.hits[0]?.snippet).toContain("kestrel");
			}
			// Expanding a card pages through one read of its hits.
			const base = { query: "kestrel", narratorId: "s1", principal: ADMIN };
			const firstHits = await searchService.searchSessionHits({ ...base, limit: 2 });
			const moreHits = await searchService.searchSessionHits({
				...base,
				limit: 2,
				cursor: firstHits.nextCursor ?? undefined,
			});
			expect([...firstHits.hits, ...moreHits.hits].map((h) => h.id)).toHaveLength(4);
			expect(aggregates).toHaveBeenCalledTimes(1);
			expect(hits).toHaveBeenCalledTimes(1);
		} finally {
			aggregates.mockRestore();
			hits.mockRestore();
		}
	});

	it("keeps viewers and filters apart", async () => {
		seedNarrator("mine", { visibility: "private", owner: OWNER });
		seedMessage("mine", "kestrel private", day(3));
		const asAdmin = await sessions("kestrel");
		const asOther = await sessions("kestrel", { principal: { userId: OTHER, isAdmin: false } });
		const archived = await sessions("kestrel", {
			scope: { subagents: false, system: false, tools: false, archived: true },
		});
		expect(asAdmin.items.map((s) => s.id)).toEqual(["mine"]);
		expect(asOther.items).toEqual([]);
		expect(archived.items.map((s) => s.id)).toEqual(["mine"]);
	});

	it("jumps to a page through the route", async () => {
		for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
			seedNarrator(id);
			seedMessage(id, "kestrel", day(3));
		}
		const app = appFor("admin", "admin");
		const read = async (page: number) => {
			const response = await app.request(
				`/api/search?q=kestrel&sections=sessions&limit=2&page=${page}`,
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				sections: { sessions: { items: { id: string }[]; total: number } };
			};
			return body.sections.sessions;
		};
		const pages = await Promise.all([read(1), read(2), read(3)]);
		expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);
		expect(new Set(pages.flatMap((p) => p.items.map((i) => i.id))).size).toBe(5);
		expect((await read(4)).items).toEqual([]);
		const invalid = await app.request("/api/search?q=kestrel&sections=sessions&page=0");
		expect(invalid.status).toBe(400);
	});
});

describe("filters and scope", () => {
	beforeEach(() => {
		seedNarrator("a-mine", { projectId: "proj-a", owner: OWNER });
		seedMessage("a-mine", "kestrel early", day(3));
		seedNarrator("b-theirs", { projectId: "proj-b", owner: OTHER });
		seedMessage("b-theirs", "kestrel late", day(20));
		seedNarrator("archived", { status: "archived" });
		seedMessage("archived", "kestrel archived", day(5));
	});

	const ids = async (options: Partial<Parameters<typeof searchService.searchSections>[0]>) =>
		(await sessions("kestrel", options)).items.map((s) => s.id).sort();

	it("narrows sessions by project, time and owner", async () => {
		expect(await ids({})).toEqual(["a-mine", "b-theirs"]);
		expect(await ids({ filters: { projectId: "proj-b" } })).toEqual(["b-theirs"]);
		expect(await ids({ filters: { projectId: "proj-a" } })).toEqual(["a-mine"]);
		expect(await ids({ filters: { from: day(10) } })).toEqual(["b-theirs"]);
		expect(await ids({ filters: { to: day(10) } })).toEqual(["a-mine"]);
		expect(await ids({ filters: { ownerUserId: OWNER } })).toEqual(["a-mine"]);
	});

	it("leaves archived sessions out unless asked", async () => {
		expect(await ids({})).not.toContain("archived");
		expect(
			await ids({ scope: { subagents: false, system: false, tools: false, archived: true } }),
		).toEqual(["a-mine", "archived", "b-theirs"]);
	});
});

describe("over HTTP", () => {
	it("returns every section by default and honours filters and include", async () => {
		seedNarrator("mine", { owner: OWNER });
		seedMessage("mine", "kestrel", day(3));
		seedNarrator("theirs", { owner: OTHER });
		seedMessage("theirs", "kestrel", day(3));
		seedNarrator("old", { status: "archived", owner: OWNER });
		seedMessage("old", "kestrel", day(3));

		const app = appFor(OWNER);
		const all = (await (await app.request("/api/search?q=kestrel")).json()) as {
			sections: Record<string, { items: { id: string }[]; total: number }>;
		};
		expect(Object.keys(all.sections).sort()).toEqual(["knowledge", "sessions"]);
		expect(all.sections.sessions.items.map((s) => s.id).sort()).toEqual(["mine", "theirs"]);

		const mine = (await (
			await app.request("/api/search?q=kestrel&sections=sessions&mine=1&include=archived")
		).json()) as { sections: { sessions: { items: { id: string }[] } } };
		expect(mine.sections.sessions.items.map((s) => s.id).sort()).toEqual(["mine", "old"]);

		const bad = await app.request("/api/search?q=kestrel&from=not-a-date");
		expect(bad.status).toBe(400);
	});

	it("never shows sessions or hits the viewer may not read", async () => {
		seedNarrator("secret", { owner: OWNER, visibility: "private" });
		seedMessage("secret", "kestrel secret", day(3));
		const app = appFor(OTHER);
		const body = (await (await app.request("/api/search?q=kestrel&sections=sessions")).json()) as {
			sections: { sessions: { items: unknown[] } };
		};
		expect(body.sections.sessions.items).toEqual([]);
		const hits = (await (
			await app.request("/api/search/sessions/secret/hits?q=kestrel")
		).json()) as {
			hits: unknown[];
		};
		expect(hits.hits).toEqual([]);
	});
});

describe("session ranking", () => {
	const NOW = Date.parse(day(30));
	const candidate = (
		id: string,
		overrides: Partial<Parameters<typeof mergeSessionCandidates>[0][number]> = {},
	) =>
		mergeSessionCandidates(
			[
				{
					narratorId: id,
					bestRank: -1,
					hitCount: 1,
					lastHitAt: day(29),
					title: null,
					type: "primary",
					subagentType: null,
					status: "idle",
					projectId: null,
					projectName: null,
					lastMessageAt: null,
					createdAt: null,
					updatedAt: null,
					latestHits: [],
					...overrides,
				},
			],
			[],
		)[0] as ReturnType<typeof mergeSessionCandidates>[number];

	it("prefers stronger matches, title matches, more hits and recent activity", () => {
		const order = (cands: ReturnType<typeof candidate>[]) =>
			rankSessions(cands, "relevance", NOW).map(({ candidate: c }) => c.narratorId);
		expect(
			order([candidate("weak", { bestRank: -1 }), candidate("strong", { bestRank: -5 })]),
		).toEqual(["strong", "weak"]);
		expect(order([candidate("plain"), { ...candidate("titled"), titleMatch: true }])).toEqual([
			"titled",
			"plain",
		]);
		expect(order([candidate("few", { hitCount: 1 }), candidate("many", { hitCount: 40 })])).toEqual(
			["many", "few"],
		);
		expect(
			order([candidate("old", { lastHitAt: day(1) }), candidate("new", { lastHitAt: day(29) })]),
		).toEqual(["new", "old"]);
	});

	it("orders by latest activity for the time sort", () => {
		const ranked = rankSessions(
			[
				candidate("strong-old", { bestRank: -9, hitCount: 50, lastHitAt: day(1) }),
				candidate("weak-new", { bestRank: -1, lastHitAt: day(20) }),
			],
			"time",
			NOW,
		);
		expect(ranked.map(({ candidate: c }) => c.narratorId)).toEqual(["weak-new", "strong-old"]);
	});

	it("scores within 0..1", () => {
		const ranked = rankSessions(
			[candidate("a"), candidate("b", { bestRank: -3 })],
			"relevance",
			NOW,
		);
		for (const { score } of ranked) {
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});
});

describe("cursors", () => {
	it("round-trip and read malformed input as the first page", () => {
		expect(decodeSearchCursor(encodeSearchCursor(40))).toBe(40);
		expect(decodeSearchCursor(undefined)).toBe(0);
		expect(decodeSearchCursor("not-a-cursor")).toBe(0);
		expect(decodeSearchCursor(Buffer.from('{"o":-3}').toString("base64url"))).toBe(0);
	});
});

describe("short queries search recent history by default", () => {
	const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

	beforeEach(() => {
		seedNarrator("recent");
		seedMessage("recent", "登录失败", daysAgo(5));
		seedNarrator("old");
		seedMessage("old", "登录超时", daysAgo(200));
	});

	it("limits a query of only short terms to the recent window and says so", async () => {
		const page = await sessions("登录");
		expect(page.items.map((s) => s.id)).toEqual(["recent"]);
		expect(page.recentDays).toBe(SHORT_QUERY_RECENT_DAYS);
	});

	it("searches everything when asked, or when the caller set its own time bound", async () => {
		const full = await sessions("登录", { fullHistory: true });
		expect(full.items.map((s) => s.id).sort()).toEqual(["old", "recent"]);
		expect(full.recentDays).toBeUndefined();

		const ranged = await sessions("登录", { filters: { from: daysAgo(365) } });
		expect(ranged.items.map((s) => s.id).sort()).toEqual(["old", "recent"]);
		expect(ranged.recentDays).toBeUndefined();
	});

	it("leaves queries the index can serve alone", async () => {
		seedMessage("old", "登录 kestrel", daysAgo(200));
		const page = await sessions("登录 kestrel");
		expect(page.items.map((s) => s.id)).toEqual(["old"]);
		expect(page.recentDays).toBeUndefined();
	});

	it("applies the same window when a card's hits are expanded", async () => {
		seedMessage("old", "登录重试", daysAgo(3));
		const recent = await searchService.searchSessionHits({
			query: "登录",
			narratorId: "old",
			principal: ADMIN,
		});
		expect(recent.hits).toHaveLength(1);
		const full = await searchService.searchSessionHits({
			query: "登录",
			narratorId: "old",
			principal: ADMIN,
			fullHistory: true,
		});
		expect(full.hits).toHaveLength(2);
	});

	it("rounds the window to the UTC day", () => {
		const morning = Date.parse("2026-10-23T01:00:00.000Z");
		const evening = Date.parse("2026-10-23T23:00:00.000Z");
		const at = (now: number) => sessionSearchWindow("登录", undefined, false, now).filters?.from;
		expect(at(morning)).toBe("2026-07-25T00:00:00.000Z");
		expect(at(evening)).toBe(at(morning));
		expect(sessionSearchWindow("登录", { projectId: "p" }, false, morning).filters).toMatchObject({
			projectId: "p",
		});
	});
});
