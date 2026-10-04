/**
 * Recall-shape regressions for the search store, against a real FTS index.
 *
 * The four search paths do NOT agree on how a query becomes a match, and moving them behind
 * one port made "harmonize them" a one-line temptation. The differences are behaviour users
 * and models already depend on, so each one is pinned here against a real database — the
 * expression-level tests in `search.test.ts` pin the strings, these pin what the strings
 * actually retrieve.
 *
 * Every case below would still pass if the port were correct but a shape were "tidied":
 * that is why they exist.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	chapters,
	knowledgeCollections,
	knowledgeEntries,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../../../server/db/schema";
import { resetDbWorkerPoolForTest, shutdownDbWorkerPool } from "../../../server/lib/db-worker/pool";
import { createSqliteSearchQueryExecutor } from "../../../server/services/search/sqlite-worker-runner";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite }));

const { ensureFts } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { createSqliteSearchStore } = await import("../../../server/services/search/sqlite-store");
const searchStore = createSqliteSearchStore(async (sql, params) =>
	sqlite.prepare<Record<string, unknown>, Array<string | number | null>>(sql).all(...params),
);
mock.module("../../../server/services/search/backend", () => ({ searchStore }));
const { knowledgeService } = await import("../../../server/services/knowledge-service");
const { searchService, sortSearchResults } = await import(
	"../../../server/services/search-service"
);
const { searchRoutes } = await import("../../../server/routes/search");

const searchApp = new Hono();
searchApp.use("*", async (c, next) => {
	c.set("user", { sub: "shape-viewer", role: "user", iat: 0, exp: 2_000_000_000 });
	await next();
});
searchApp.route("/api/search", searchRoutes);

const NOW = "2026-07-19T00:00:00.000Z";
const ADMIN = { userId: "shape-admin", isAdmin: true };

function seedChapter(id: string, title: string, description: string) {
	db.insert(chapters)
		.values({
			id,
			projectId: "proj-shape",
			title,
			description,
			branch: `chapter/${id}`,
			baseBranch: "main",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedMessage(id: string, seq: number, text: string) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: "narr-shape",
			role: "assistant",
			contentJson: [{ type: "text", text }],
			contentText: text,
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId: "narr-shape", messageId: id, seq })
		.run();
}

beforeEach(() => {
	db.insert(projects)
		.values({
			id: "proj-shape",
			name: "Shapes",
			gitPath: "/tmp/proj-shape",
			visibility: "public",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedChapter("chap-shape", "Zephyr calibration harness", "描述充电流程与电池温度监控");
	db.insert(narrators)
		.values({
			id: "narr-shape",
			chapterId: "chap-shape",
			type: "primary",
			inheritMode: "fresh",
			visibility: "public",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedMessage("msg-shape", 1, "Zephyr calibration harness notes 充电流程说明");
});

afterEach(() => {
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of [
		"narrator_message_refs",
		"narrator_messages",
		"narrators",
		"chapters",
		"projects",
		"knowledge_entries",
		"knowledge_collections",
	]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
});

type TimeEntity = "chapters" | "messages" | "narrators";
const TIME_ENTITIES: TimeEntity[] = ["chapters", "messages", "narrators"];
const TIME_VIEWER = { userId: "shape-viewer", isAdmin: false };

/** Insert old hits first, then equal-time newest hits in reverse id order. */
function seedTimeCorpus(entity: TimeEntity) {
	const text = "PR chronometer";
	const oldTime = "2026-01-01T00:00:00.000Z";
	const newTime = "2026-09-01T00:00:00.000Z";
	const seed = (suffix: string, time: string, hidden = false) => {
		const id = `${entity}-${suffix}`;
		if (entity === "chapters") {
			db.insert(chapters)
				.values({
					id,
					projectId: hidden ? "proj-time-private" : "proj-shape",
					title: text,
					description: text,
					branch: `chapter/${id}`,
					baseBranch: "main",
					createdAt: oldTime,
					updatedAt: time,
				})
				.run();
		} else if (entity === "narrators") {
			db.insert(narrators)
				.values({
					id,
					chapterId: "chap-shape",
					title: text,
					type: "primary",
					inheritMode: "fresh",
					visibility: hidden ? "private" : "public",
					createdAt: oldTime,
					updatedAt: time,
					// lastMessageAt must not override the preferred updatedAt.
					lastMessageAt: "2029-01-01T00:00:00.000Z",
				})
				.run();
		} else {
			db.insert(narratorMessages)
				.values({
					id,
					narratorId: hidden ? "narr-time-private" : "narr-shape",
					role: "assistant",
					contentJson: [{ type: "text", text }],
					contentText: text,
					createdAt: time,
				})
				.run();
		}
	};
	db.insert(projects)
		.values({
			id: "proj-time-private",
			name: "Private time corpus",
			gitPath: "/tmp/proj-time-private",
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(narrators)
		.values({
			id: "narr-time-private",
			chapterId: "chap-shape",
			type: "primary",
			inheritMode: "fresh",
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	for (let i = 0; i < 5; i++) seed(`old-${i}`, oldTime);
	seed("new-z", newTime);
	seed("new-a", newTime);
	// Hidden hits would consume the entire limit if ACL were applied after retrieval.
	for (let i = 0; i < 3; i++) seed(`hidden-${i}`, "2028-01-01T00:00:00.000Z", true);
	return [`${entity}-new-a`, `${entity}-new-z`];
}

async function searchTimeStore(entity: TimeEntity, query: string, sort?: "time" | "relevance") {
	const options = {
		text: query,
		strategy: query.length < 3 ? ("substring" as const) : ("index" as const),
		limit: 2,
		viewer: TIME_VIEWER,
		sort,
	};
	if (entity === "chapters") return searchStore.searchChapters(options);
	if (entity === "messages") return searchStore.searchMessages(options);
	return searchStore.searchNarrators(options);
}

describe("global time search orders the full matching corpus before LIMIT", () => {
	for (const entity of TIME_ENTITIES) {
		for (const query of ["PR", "chronometer"]) {
			it(`${entity}: ${query} returns newest readable hits, and sort switches do not reuse the wrong statement`, async () => {
				const newest = seedTimeCorpus(entity);
				const relevance = (await searchTimeStore(entity, query)).map((r) => r.id);
				expect(relevance).toHaveLength(2);
				expect(relevance).not.toEqual(newest);
				for (let i = 0; i < 2; i++) {
					expect((await searchTimeStore(entity, query, "time")).map((r) => r.id)).toEqual(newest);
					expect((await searchTimeStore(entity, query, "relevance")).map((r) => r.id)).toEqual(
						relevance,
					);
				}
				expect(
					(
						await searchService.search({
							query,
							entities: [entity],
							limit: 2,
							sort: "time",
							principal: TIME_VIEWER,
						})
					).map((r) => r.id),
				).toEqual(newest);

				for (const sort of ["time", "relevance", "invalid", undefined]) {
					const params = new URLSearchParams({ q: query, entities: entity, limit: "2" });
					if (sort !== undefined) params.set("sort", sort);
					const response = await searchApp.request(`/api/search?${params}`);
					expect(response.status).toBe(200);
					const body = (await response.json()) as { results: { id: string }[] };
					const expected =
						sort === "time"
							? newest
							: (
									await searchService.search({
										query,
										entities: [entity],
										limit: 2,
										principal: TIME_VIEWER,
									})
								).map((r) => r.id);
					expect(body.results.map((r) => r.id)).toEqual(expected);
				}
			});
		}
	}

	it("all entity results interleave by time rather than putting narrators first", async () => {
		for (const [id, time] of [
			["n-all-old", "2026-01-01"],
			["n-all-mid", "2026-09-03"],
		]) {
			db.insert(narrators)
				.values({
					id,
					title: "PR chronometer",
					type: "primary",
					inheritMode: "fresh",
					chapterId: "chap-shape",
					visibility: "public",
					createdAt: time,
					updatedAt: time,
				})
				.run();
		}
		for (const [id, time] of [
			["m-all-new", "2026-09-04"],
			["m-all-mid", "2026-09-02"],
		]) {
			db.insert(narratorMessages)
				.values({
					id,
					narratorId: "narr-shape",
					role: "assistant",
					contentText: "PR chronometer",
					contentJson: [{ type: "text", text: "PR chronometer" }],
					createdAt: time,
				})
				.run();
		}
		for (const query of ["PR", "chronometer"]) {
			const response = await searchApp.request(`/api/search?q=${query}&sort=time`);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { results: { id: string; type: string }[] };
			expect(body.results.map((r) => r.id)).toEqual([
				"m-all-new",
				"n-all-mid",
				"m-all-mid",
				"n-all-old",
			]);
			expect(body.results.map((r) => r.type)).toEqual([
				"message",
				"narrator",
				"message",
				"narrator",
			]);
		}
	});

	it("time ignores scores, uses timestamp precedence and breaks ties by ID", () => {
		const hits = [
			{
				type: "message" as const,
				id: "old",
				snippet: "",
				matchScore: 9999,
				createdAt: "2020-01-01",
			},
			{
				type: "chapter" as const,
				id: "z",
				snippet: "",
				matchScore: 1,
				updatedAt: "2026-09-01",
				createdAt: "2029-01-01",
			},
			{
				type: "narrator" as const,
				id: "a",
				snippet: "",
				matchScore: 0,
				lastMessageAt: "2026-09-01",
			},
		];
		expect(sortSearchResults([...hits], "time").map((r) => r.id)).toEqual(["a", "z", "old"]);
		expect(sortSearchResults([...hits]).map((r) => r.id)).toEqual(["old", "z", "a"]);
	});
});

describe("global search matches a phrase, the timeline matches prefixes", () => {
	/**
	 * The asymmetry itself, demonstrated on one corpus with one query.
	 *
	 * "calibration harness" is contiguous in both rows, so both find it. "calibr harn" is
	 * contiguous in neither as full words — the timeline's prefix expansion still matches it,
	 * global search's phrase does not. If someone unified the two shapes, exactly one of these
	 * two assertions would flip, which is the signal this pair exists to produce.
	 */
	it("both find a contiguous phrase", async () => {
		const global = await searchStore.searchMessages({
			text: "calibration harness",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(global.map((r) => r.id)).toEqual(["msg-shape"]);

		const timeline = await searchStore.searchTimeline({
			narratorId: "narr-shape",
			text: "calibration harness",
			strategy: "index",
			limit: 10,
			inheritedScopes: [],
		});
		expect(timeline.map((r) => r.messageId)).toEqual(["msg-shape"]);
	});

	it("only the timeline matches truncated terms, because only it expands prefixes", async () => {
		const global = await searchStore.searchMessages({
			text: "calibr harn",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(global).toEqual([]);

		const timeline = await searchStore.searchTimeline({
			narratorId: "narr-shape",
			text: "calibr harn",
			strategy: "index",
			limit: 10,
			inheritedScopes: [],
		});
		expect(timeline.map((r) => r.messageId)).toEqual(["msg-shape"]);
	});
});

describe("CJK queries", () => {
	// Three Han characters form a trigram token, so the index path works on them.
	it("finds a 3-character CJK term through the index", async () => {
		const rows = await searchStore.searchMessages({
			text: "充电流",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(rows.map((r) => r.id)).toEqual(["msg-shape"]);
	});

	// Two Han characters cannot, which is why the caller must pick the substring path for
	// them. Asserting both halves: the index genuinely finds nothing, the substring path does.
	it("needs the substring path for a 2-character CJK term", async () => {
		const viaIndex = await searchStore.searchMessages({
			text: "充电",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(viaIndex).toEqual([]);

		const viaSubstring = await searchStore.searchMessages({
			text: "充电",
			strategy: "substring",
			limit: 10,
			viewer: ADMIN,
		});
		expect(viaSubstring.map((r) => r.id)).toEqual(["msg-shape"]);
	});

	it("matches a CJK chapter description on the substring path", async () => {
		const rows = await searchStore.searchChapters({
			text: "电池",
			strategy: "substring",
			limit: 10,
			viewer: ADMIN,
		});
		expect(rows.map((r) => r.id)).toEqual(["chap-shape"]);
	});
});

describe("snippets carry each path's own markup", () => {
	it("marks Recall hits so the model can see the match", async () => {
		const rows = await searchStore.searchRecallMessages({
			text: "calibration",
			strategy: "index",
			limit: 10,
			narratorId: "narr-shape",
			previewChars: 300,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].snippet).toContain(">>>");
		expect(rows[0].snippet).toContain("<<<");
	});

	it("leaves global-search snippets unmarked", async () => {
		const rows = await searchStore.searchMessages({
			text: "calibration",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].snippet).not.toContain(">>>");
	});
});

describe("knowledge substring matching escapes user-typed wildcards", () => {
	/**
	 * Knowledge is the one path that escapes `%`/`_`, so a user searching for a literal `%`
	 * gets rows containing `%` — not every row. The other three paths deliberately do not
	 * escape; that difference is pinned at the expression level in `search.test.ts`, and its
	 * consequence for knowledge is pinned here.
	 */
	beforeEach(() => {
		db.insert(knowledgeCollections)
			.values({
				id: "col-shape",
				name: "Shapes",
				slug: "col-shape",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		for (const [id, title, content] of [
			["kb-pct", "Discount rules", "apply a 50% cut"],
			["kb-plain", "Plain rules", "apply a flat cut"],
		]) {
			db.insert(knowledgeEntries)
				.values({
					id,
					collectionId: "col-shape",
					title,
					slug: id,
					currentContent: content,
					tagsJson: [],
					status: "active",
					createdAt: NOW,
					updatedAt: NOW,
				})
				.run();
		}
	});

	it("treats a typed % as a literal, not a wildcard", async () => {
		// Two characters, so this takes the substring path. An unescaped `%` here would match
		// both rows; escaped, it matches only the row that literally contains one.
		const ids = (await knowledgeService.search({ q: "0%", collectionId: "col-shape" })).map(
			(r) => r.id,
		);
		expect(ids).toEqual(["kb-pct"]);
	});
});

describe("the short-query cap bounds the unindexed scan", () => {
	/**
	 * The substring path is unindexed and runs on the main thread, so it takes a TIGHTER limit
	 * than the caller asked for. Previously each branch computed that cap itself; it is now
	 * derived once, which is cheaper to read and easier to drop by accident — hence this test.
	 *
	 * Asserted through the public service (both branches share the derivation) with a limit
	 * above the cap, and paired with the index path to show the cap is specific to the
	 * unindexed one rather than a blanket ceiling.
	 */
	const SHORT_QUERY_FALLBACK_LIMIT = 50;

	beforeEach(() => {
		db.insert(knowledgeCollections)
			.values({
				id: "col-cap",
				name: "Caps",
				slug: "col-cap",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		// More rows than the fallback cap, all matching both a 2-char and a 3-char needle.
		for (let i = 0; i < SHORT_QUERY_FALLBACK_LIMIT + 15; i++) {
			db.insert(knowledgeEntries)
				.values({
					id: `kb-cap-${i}`,
					collectionId: "col-cap",
					title: `Entry ${i}`,
					slug: `kb-cap-${i}`,
					currentContent: "zq zqx padding text",
					tagsJson: [],
					status: "active",
					createdAt: NOW,
					updatedAt: NOW,
				})
				.run();
		}
	});

	it("caps a short query below the caller's limit", async () => {
		const rows = await knowledgeService.search({ q: "zq", collectionId: "col-cap", limit: 100 });
		expect(rows.length).toBe(SHORT_QUERY_FALLBACK_LIMIT);
	});

	it("does not apply that cap to an indexed query", async () => {
		const rows = await knowledgeService.search({ q: "zqx", collectionId: "col-cap", limit: 100 });
		expect(rows.length).toBeGreaterThan(SHORT_QUERY_FALLBACK_LIMIT);
	});
});

describe("SQLite search executor boundary", () => {
	it("awaits every query path and forwards cancellation and operation names", async () => {
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>[]>();
		const controller = new AbortController();
		const operations: string[] = [];
		const store = createSqliteSearchStore(async (_sql, _params, options) => {
			expect(options?.signal).toBe(controller.signal);
			operations.push(options?.operation ?? "");
			return promise;
		});
		const pending: Promise<unknown>[] = [];
		for (const strategy of ["index", "substring"] as const) {
			const common = { text: "Zephyr", strategy, limit: 5, signal: controller.signal };
			const entity = { ...common, viewer: ADMIN };
			const knowledge = {
				...common,
				indexText: common.text,
				substringText: common.text,
				match: "and" as const,
				projectId: "proj-shape",
				excludeEntryIds: ["excluded"],
			};
			pending.push(
				store.searchChapters(entity),
				store.searchMessages(entity),
				store.searchNarrators(entity),
				store.searchTimeline({ ...common, narratorId: "narr-shape", inheritedScopes: [] }),
				store.searchTimeline({
					...common,
					narratorId: "narr-shape",
					inheritedScopes: [{ narratorId: "ancestor", upperBoundSeq: 3 }],
				}),
				store.searchRecallMessages({ ...common, narratorId: null, previewChars: 240 }),
				store.searchKnowledgeEntries(knowledge),
				store.searchKnowledgeDrafts({
					...knowledge,
					authorUserId: "author",
					draftStatus: "active",
				}),
				store.listShadowedEntryIds({
					...common,
					authorUserId: "author",
					draftStatus: "active",
				}),
			);
		}
		expect(operations).toEqual(
			Array.from({ length: 2 }, () => [
				"searchChapters",
				"searchMessages",
				"searchNarrators",
				"searchTimeline",
				"searchTimeline",
				"searchRecallMessages",
				"searchKnowledgeEntries",
				"searchKnowledgeDrafts",
				"listShadowedEntryIds",
			]).flat(),
		);
		let settled = false;
		const done = Promise.all(pending).then((rows) => {
			settled = true;
			return rows;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		resolve([]);
		expect(await done).toEqual(Array.from({ length: 18 }, () => []));
	});

	it("keeps identical SQL templates bound to each store's own executor", async () => {
		const first = createSqliteSearchStore(async () => [{ id: "first" }]);
		const second = createSqliteSearchStore(async () => [{ id: "second" }]);
		const query = { text: "Zephyr", strategy: "index" as const, limit: 5, viewer: ADMIN };
		expect((await first.searchChapters(query)).map((row) => row.id)).toEqual(["first"]);
		expect((await second.searchChapters(query)).map((row) => row.id)).toEqual(["second"]);
		expect((await first.searchChapters(query)).map((row) => row.id)).toEqual(["first"]);
	});
});

describe("knowledge field restriction", () => {
	/**
	 * The field name reaches an FTS5 column filter and a LIKE column reference, so it is an
	 * allow-list rather than a passthrough. An unrecognized name must be REJECTED: silently
	 * searching everything is the failure mode the restriction exists to prevent, since its
	 * only user is passive injection, which must fire on author-declared keywords and never on
	 * body text.
	 */
	it("accepts the keyword column", async () => {
		await expect(
			searchStore.searchKnowledgeEntries({
				indexText: "anything",
				substringText: "anything",
				strategy: "index",
				limit: 5,
				match: "or",
				field: "current_keywords",
			}),
		).resolves.toBeDefined();
	});

	it("rejects an unknown field instead of interpolating it", async () => {
		// The port is async, so the allow-list rejection surfaces as a REJECTED promise
		// rather than a synchronous throw — the same ValidationError, one await away.
		await expect(
			searchStore.searchKnowledgeEntries({
				indexText: "anything",
				substringText: "anything",
				strategy: "index",
				limit: 5,
				match: "and",
				field: "current_content} : (x) OR title:(",
			}),
		).rejects.toThrow(/Unsupported knowledge search field/);
	});
});

describe("real worker transport preserves the search store contract", () => {
	it("runs all query paths on a file snapshot and retains newest-before-limit ACL semantics", async () => {
		seedTimeCorpus("messages");
		const directory = mkdtempSync(join(tmpdir(), "narrafork-search-store-worker-"));
		const dbPath = join(directory, "fixture.db");
		resetDbWorkerPoolForTest();
		try {
			await Bun.write(dbPath, sqlite.serialize());
			const workerStore = createSqliteSearchStore(createSqliteSearchQueryExecutor(dbPath));
			for (const [text, strategy] of [
				["PR", "substring"],
				["chronometer", "index"],
			] as const) {
				const query = { text, strategy, sort: "time" as const, limit: 2, viewer: TIME_VIEWER };
				const rows = await workerStore.searchMessages(query);
				expect(rows).toEqual(await searchStore.searchMessages(query));
				expect(rows.map((row) => row.id)).toEqual(["messages-new-a", "messages-new-z"]);
			}
			for (const strategy of ["index", "substring"] as const) {
				const query = { text: "Zephyr", strategy, limit: 10, viewer: TIME_VIEWER };
				expect(await workerStore.searchChapters(query)).toEqual(
					await searchStore.searchChapters(query),
				);
				expect(await workerStore.searchNarrators(query)).toEqual(
					await searchStore.searchNarrators(query),
				);
				const timeline = { ...query, narratorId: "narr-shape", inheritedScopes: [] };
				expect(await workerStore.searchTimeline(timeline)).toEqual(
					await searchStore.searchTimeline(timeline),
				);
				const recall = { ...query, narratorId: "narr-shape", previewChars: 240 };
				expect(await workerStore.searchRecallMessages(recall)).toEqual(
					await searchStore.searchRecallMessages(recall),
				);
				const knowledge = {
					indexText: "Zephyr",
					substringText: "Ze",
					strategy,
					limit: 10,
					match: "and" as const,
				};
				expect(await workerStore.searchKnowledgeEntries(knowledge)).toEqual(
					await searchStore.searchKnowledgeEntries(knowledge),
				);
				const draft = { ...knowledge, authorUserId: "shape-user", draftStatus: "active" };
				expect(await workerStore.searchKnowledgeDrafts(draft)).toEqual(
					await searchStore.searchKnowledgeDrafts(draft),
				);
			}
			const shadow = { authorUserId: "shape-user", draftStatus: "active", limit: 200 };
			expect(await workerStore.listShadowedEntryIds(shadow)).toEqual(
				await searchStore.listShadowedEntryIds(shadow),
			);
		} finally {
			shutdownDbWorkerPool();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
