import { afterAll, describe, expect, mock, test } from "bun:test";
import type { PgExecutor } from "../../../db/pg-fts";
import { getNarratorWorkerTestDb } from "../../__tests__/narrator-worker-fixture";
import type { RecallSearchQuery } from "../types";

// All SQL runs against this temporary fixture, never the production DB.
const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
mock.module("../../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
const { ensureFts, replaceBlockIndexText } = await import("../../../db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });
const { createSqliteSearchStore } = await import("../sqlite-store");
const { createPostgresSearchStore } = await import("../postgres-store");
const NOW = "2026-10-01T00:00:00.000Z";
const OLD = "2026-09-01T00:00:00.000Z";
const NEW = "2026-11-01T00:00:00.000Z";
const TEXT = "needle 充电方案";
for (const id of ["owner", "fork", "other", "hidden"]) {
	sqlite.run(
		"INSERT INTO narrators (id, title, hidden_from_lists, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		[id, id, id === "hidden" ? 1 : 0, NOW, NOW],
	);
}
// Deliberately insert equal-time ids in reverse order; origin is independent of role.
const messages: [string, string, string | null, string, string, boolean][] = [
	["z-system", "user", "system", NEW, "owner", true],
	["y-unknown", "user", null, NEW, "owner", true],
	["x-assistant", "assistant", "assistant", NEW, "owner", true],
	["b-user", "user", "user", NOW, "owner", true],
	["a-user", "user", "user", NOW, "owner", true],
	["old-user", "user", "user", OLD, "owner", true],
	["legacy-user", "user", "user", OLD, "owner", false],
	["legacy-unknown", "user", null, NEW, "owner", false],
	["legacy-system", "user", "system", NEW, "owner", false],
	["other-user", "user", "user", NOW, "other", true],
	["hidden-user", "user", "user", NOW, "hidden", true],
];
for (const [seq, [id, role, origin, date, owner, hasBlock]] of messages.entries()) {
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, origin, content_json, content_text, created_at, body_format)
		 VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`,
		[id, owner, role, origin, TEXT, date, hasBlock ? 2 : 1],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)",
		[`r-${id}`, owner, id, seq],
	);
	if (owner === "owner") {
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'fork', ?, ?)",
			[`f-${id}`, id, seq],
		);
	}
	if (hasBlock) {
		sqlite.run(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, payload, created_at)
			 VALUES (?, ?, 0, 'output', ?, ?)`,
			[`block-${id}`, id, JSON.stringify({ text: TEXT }), date],
		);
		replaceBlockIndexText(sqlite, `block-${id}`, TEXT);
	}
}
// The owning narrator has rolled back: only fork histories retain the searchable refs.
for (const [id, hidden, traits] of [
	["history-b", 0, "[]"],
	["history-c", 0, "[]"],
	["00-hidden-history", 1, "[]"],
	["00-trace-history", 0, '["modeltrace"]'],
] as const) {
	sqlite.run(
		`INSERT INTO narrators (id, title, hidden_from_lists, traits, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[id, `title-${id}`, hidden, traits, NOW, NOW],
	);
}
const HISTORY_TEXT = "historytoken 历史";
for (const [id, owner, refs, hasBlock] of [
	[
		"history-block",
		"owner",
		["history-c", "00-hidden-history", "00-trace-history", "history-b"],
		true,
	],
	["history-legacy", "owner", ["history-c", "history-b"], false],
	["history-only-b", "owner", ["history-b"], true],
	["history-prefers-owner", "owner", ["history-b", "owner"], true],
	["history-no-refs", "owner", [], true],
	["history-hidden-only", "owner", ["00-hidden-history"], true],
	["history-trace-only", "owner", ["00-trace-history"], false],
	["history-hidden-owner", "hidden", ["history-b"], true],
	["history-trace-owner", "00-trace-history", ["history-b"], false],
] as const) {
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, origin, content_json, content_text, created_at, body_format)
		 VALUES (?, ?, 'user', 'user', '[]', ?, ?, ?)`,
		[id, owner, HISTORY_TEXT, NOW, hasBlock ? 2 : 1],
	);
	for (const narratorId of refs) {
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, 100)",
			[`history-ref-${narratorId}-${id}`, narratorId, id],
		);
	}
	if (hasBlock) {
		sqlite.run(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, payload, created_at)
			 VALUES (?, ?, 0, 'output', ?, ?)`,
			[`block-${id}`, id, JSON.stringify({ text: HISTORY_TEXT }), NOW],
		);
		replaceBlockIndexText(sqlite, `block-${id}`, HISTORY_TEXT);
	}
}
// Lazy full forks keep only new/partially copied refs until backfill catches up.
for (const [id, parent, cursor] of [
	["lazy-root", null, null],
	["lazy-middle", "lazy-root", 5],
	["lazy-child", "lazy-middle", 4],
] as const) {
	sqlite.run(
		`INSERT INTO narrators (id, title, refs_inherited_from, refs_backfill_cursor, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[id, `title-${id}`, parent, cursor, NOW, NOW],
	);
}
const LAZY_TEXT = "lazyneedle 祖先需求";
for (const [id, narratorId, seq, compacted, legacy] of [
	["lazy-before", "lazy-root", 0, false, true],
	["lazy-duplicate", "lazy-root", 1, false, false],
	["lazy-compacted", "lazy-root", 2, true, false],
	["lazy-boundary", "lazy-root", 4, false, false],
	["lazy-after", "lazy-root", 5, false, false],
	["lazy-middle-own", "lazy-middle", 3, false, false],
	["lazy-middle-after", "lazy-middle", 4, false, false],
	["lazy-child-own", "lazy-child", 21, false, false],
] as const) {
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, origin, content_json, content_text, created_at, body_format)
		 VALUES (?, ?, 'user', 'user', '[]', ?, ?, ?)`,
		[id, narratorId, LAZY_TEXT, NOW, legacy ? 1 : 2],
	);
	sqlite.run(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, segment_compact_id)
		 VALUES (?, ?, ?, ?, ?)`,
		[`ref-${id}`, narratorId, id, seq, compacted ? "marker" : null],
	);
	if (!legacy) {
		sqlite.run(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, payload, created_at)
			 VALUES (?, ?, 0, 'output', ?, ?)`,
			[`block-${id}`, id, JSON.stringify({ text: LAZY_TEXT }), NOW],
		);
		replaceBlockIndexText(sqlite, `block-${id}`, LAZY_TEXT);
	}
}
// Partial backfill: the child owns a ref already present in its grandparent.
sqlite.run(
	`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
	 VALUES ('partial-duplicate', 'lazy-child', 'lazy-duplicate', 20)`,
);
afterAll(() => fixture.close());

const query = (options: Partial<RecallSearchQuery> = {}): RecallSearchQuery => ({
	text: "needle",
	strategy: "index",
	limit: 20,
	narratorId: "owner",
	previewChars: 200,
	...options,
});
const ids = (rows: { messageId: string }[]) => rows.map((row) => row.messageId);

/** Exact inter-query schedule: fork materializes m1, then ancestor COW replaces its ref with m2. */
function lineageRaceFixture(prefix: string, hasBlock: boolean) {
	const owner = `${prefix}-A`;
	const child = `${prefix}-B`;
	const m1 = `${prefix}-m1`;
	const m2 = `${prefix}-m2`;
	for (const [id, parent, cursor] of [
		[owner, null, null],
		[child, owner, 2],
	] as const) {
		sqlite.run(
			`INSERT INTO narrators (id, title, refs_inherited_from, refs_backfill_cursor, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[id, id, parent, cursor, NOW, NOW],
		);
	}
	const insertMessage = (id: string, text: string) => {
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, origin, content_json, content_text, created_at, body_format)
			 VALUES (?, ?, 'user', 'user', '[]', ?, ?, ?)`,
			[id, owner, text, NOW, hasBlock ? 2 : 1],
		);
		if (hasBlock) {
			sqlite.run(
				`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, payload, created_at)
				 VALUES (?, ?, 0, 'output', ?, ?)`,
				[`block-${id}`, id, JSON.stringify({ text }), NOW],
			);
			replaceBlockIndexText(sqlite, `block-${id}`, text);
		}
	};
	insertMessage(m1, "raceguard 原文一");
	sqlite.run(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, 1)`,
		[`ref-${prefix}`, owner, m1],
	);
	const materializeThenCow = sqlite.transaction(() => {
		sqlite.run(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, 1)`,
			[`copy-${prefix}`, child, m1],
		);
		sqlite.run(
			"UPDATE narrators SET refs_inherited_from = NULL, refs_backfill_cursor = NULL WHERE id = ?",
			[child],
		);
		insertMessage(m2, "raceguard 新原文二");
		sqlite.run("UPDATE narrator_message_refs SET message_id = ? WHERE id = ?", [
			m2,
			`ref-${prefix}`,
		]);
	});
	return { child, m1, m2, materializeThenCow };
}

for (const blockOnly of [false, true]) {
	const store = createSqliteSearchStore(
		async (sql, params) =>
			sqlite.prepare<Record<string, unknown>, typeof params>(sql).all(...params),
		{ blockOnly: () => blockOnly },
	);
	for (const strategy of ["index", "substring"] as const) {
		describe(`Recall ${blockOnly ? "block-only + legacy" : "envelope"} ${strategy}`, () => {
			const q = (options: Partial<RecallSearchQuery> = {}) =>
				query({ strategy, text: strategy === "substring" ? "充电" : "needle", ...options });

			test("role and confirmed user origin filter before LIMIT 1", async () => {
				const rows = await store.searchRecallMessages(
					q({ roles: ["user", "assistant"], origins: ["user"], limit: 1 }),
				);
				expect(ids(rows)).toEqual(["a-user"]);
				expect(rows[0].origin).toBe("user");
				expect(
					await store.searchRecallMessages(q({ roles: ["user"], origins: ["assistant"] })),
				).toEqual([]);
				expect(
					ids(await store.searchRecallMessages(q({ roles: ["assistant"], limit: 1 }))),
				).toEqual(["x-assistant"]);
			});

			test("CJK indexed and mixed short-term predicates keep filter binding order", async () => {
				for (const text of ["充电方案", "needle 充电"]) {
					const filtered = q({
						text,
						origins: ["user"],
						roles: ["user"],
						createdFrom: NOW,
						limit: 1,
					});
					expect(ids(await store.searchRecallMessages(filtered))).toEqual(["a-user"]);
					expect(ids(await store.searchRecallMessages({ ...filtered, sort: "relevance" }))).toEqual(
						["a-user"],
					);
				}
			});

			test("unknown is NULL, never user; mixed origin arrays OR both cases", async () => {
				const unknown = await store.searchRecallMessages(q({ origins: ["unknown"], limit: 1 }));
				expect(ids(unknown)).toEqual([
					blockOnly && strategy === "index" ? "y-unknown" : "legacy-unknown",
				]);
				expect(unknown[0].origin).toBeNull();
				const mixed = ids(await store.searchRecallMessages(q({ origins: ["unknown", "user"] })));
				expect(mixed.sort()).toEqual([
					"a-user",
					"b-user",
					"legacy-unknown",
					"legacy-user",
					"old-user",
					"y-unknown",
				]);
				expect(await store.searchRecallMessages(q({ roles: [] }))).toEqual([]);
				expect(await store.searchRecallMessages(q({ origins: [] }))).toEqual([]);
			});

			test("time bounds apply to both indexed blocks and legacy branches", async () => {
				const filtered = q({ origins: ["user"], createdFrom: OLD, createdTo: OLD, limit: 1 });
				expect(ids(await store.searchRecallMessages(filtered))).toEqual([
					blockOnly && strategy === "index" ? "old-user" : "legacy-user",
				]);
				expect(ids(await store.searchRecallMessages({ ...filtered, limit: 20 })).sort()).toEqual([
					"legacy-user",
					"old-user",
				]);
				const legacy = await store.searchRecallMessages(
					q({ origins: ["unknown"], sort: "oldest" }),
				);
				expect(ids(legacy)).toContain("legacy-unknown");
			});

			test("fork searches use refs; global searches deduplicate by owning narrator", async () => {
				const inherited = await store.searchRecallMessages(
					q({ narratorId: "fork", origins: ["user"], limit: 1 }),
				);
				expect(ids(inherited)).toEqual(["a-user"]);
				expect(inherited[0].narratorId).toBe("fork");
				const global = await store.searchRecallMessages(q({ narratorId: null, origins: ["user"] }));
				expect(ids(global).filter((id) => id === "a-user")).toHaveLength(1);
				expect(global.find((row) => row.messageId === "a-user")?.narratorId).toBe("owner");
				expect(ids(global)).toContain("other-user");
				expect(ids(global)).not.toContain("hidden-user");
			});

			test("global hits name a retained history ref, preferring owner and hiding unreadable rows", async () => {
				const historyQuery = q({
					text: strategy === "index" ? "historytoken" : "历史",
					narratorId: null,
					sort: "newest",
				});
				const rows = await store.searchRecallMessages(historyQuery);
				expect(ids(rows)).toEqual([
					"history-block",
					"history-legacy",
					"history-only-b",
					"history-prefers-owner",
				]);
				for (const row of rows) {
					expect(row.ownerNarratorId).toBe("owner");
					expect(
						sqlite
							.prepare(
								"SELECT 1 FROM narrator_message_refs WHERE narrator_id = ? AND message_id = ?",
							)
							.get(row.narratorId, row.messageId),
					).toBeTruthy();
					const prefersOwner = row.messageId === "history-prefers-owner";
					expect(row.narratorId).toBe(prefersOwner ? "owner" : "history-b");
					expect(row.narratorTitle).toBe(prefersOwner ? "owner" : "title-history-b");
				}
				expect(ids(await store.searchRecallMessages({ ...historyQuery, limit: 1 }))).toEqual([
					"history-block",
				]);
				const scoped = await store.searchRecallMessages({ ...historyQuery, narratorId: "owner" });
				expect(ids(scoped)).toEqual(["history-prefers-owner"]);
				const fork = await store.searchRecallMessages({ ...historyQuery, narratorId: "history-c" });
				expect(ids(fork)).toEqual(["history-block", "history-legacy"]);
				expect(
					fork.every((row) => row.narratorId === "history-c" && row.ownerNarratorId === "owner"),
				).toBe(true);
			});

			test("scoped lazy forks search one/two inherited levels without materializing refs", async () => {
				const lazyQuery = q({
					text: strategy === "index" ? "lazyneedle" : "祖先",
					origins: ["user"],
					roles: ["user"],
					sort: "newest",
				});
				const middle = await store.searchRecallMessages({
					...lazyQuery,
					narratorId: "lazy-middle",
				});
				expect(ids(middle)).toEqual([
					"lazy-before",
					"lazy-boundary",
					"lazy-duplicate",
					"lazy-middle-after",
					"lazy-middle-own",
				]);
				const childQuery = { ...lazyQuery, narratorId: "lazy-child" };
				const child = await store.searchRecallMessages(childQuery);
				expect(ids(child)).toEqual([
					"lazy-before",
					"lazy-child-own",
					"lazy-duplicate",
					"lazy-middle-own",
				]);
				expect(
					child.every(
						(row) => row.narratorId === "lazy-child" && row.narratorTitle === "title-lazy-child",
					),
				).toBe(true);
				expect(child.find((row) => row.messageId === "lazy-before")?.ownerNarratorId).toBe(
					"lazy-root",
				);
				expect(ids(await store.searchRecallMessages({ ...childQuery, limit: 1 }))).toEqual([
					"lazy-before",
				]);
				expect(await store.searchRecallMessages({ ...childQuery, createdFrom: NEW })).toEqual([]);
				expect(
					sqlite
						.prepare(
							"SELECT COUNT(*) AS count FROM narrator_message_refs WHERE narrator_id = 'lazy-child'",
						)
						.get(),
				).toEqual({ count: 2 });
			});

			test("newest/oldest order before LIMIT, breaking equal timestamps by id", async () => {
				const newest = q({ origins: ["user"], sort: "newest", limit: 2 });
				expect(ids(await store.searchRecallMessages(newest))).toEqual(["a-user", "b-user"]);
				const oldest = q({ origins: ["user"], sort: "oldest", limit: 2 });
				expect(ids(await store.searchRecallMessages(oldest))).toEqual(["legacy-user", "old-user"]);
				// Same-shaped filters with new values must not reuse stale cache values/SQL.
				expect(
					ids(await store.searchRecallMessages(q({ origins: ["assistant"], limit: 1 }))),
				).toEqual(["x-assistant"]);
				expect(ids(await store.searchRecallMessages(newest))).toEqual(["a-user", "b-user"]);
			});
		});
	}
}

describe("scoped lineage changes fail closed in the final SQLite SQL snapshot", () => {
	for (const blockOnly of [false, true]) {
		for (const strategy of ["index", "substring"] as const) {
			for (const hasBlock of [false, true]) {
				test(`materialize then ancestor COW: blockOnly=${blockOnly}, ${strategy}, block=${hasBlock}`, async () => {
					const race = lineageRaceFixture(`race-${blockOnly}-${strategy}-${hasBlock}`, hasBlock);
					const controller = new AbortController();
					let mutateAfterLineage = false;
					let mutations = 0;
					const store = createSqliteSearchStore(
						async (sql, params, options) => {
							expect(options?.signal).toBe(controller.signal);
							const rows = sqlite
								.prepare<Record<string, unknown>, typeof params>(sql)
								.all(...params);
							if (mutateAfterLineage && sql.startsWith("WITH RECURSIVE lineage")) {
								mutateAfterLineage = false;
								race.materializeThenCow();
								mutations++;
							}
							return rows;
						},
						{ blockOnly: () => blockOnly },
					);
					const q = query({
						text: "raceguard",
						strategy,
						narratorId: race.child,
						signal: controller.signal,
					});
					expect(ids(await store.searchRecallMessages(q))).toEqual([race.m1]);
					mutateAfterLineage = true;
					await expect(store.searchRecallMessages(q)).rejects.toMatchObject({
						code: "DB_READ_PROTOCOL",
					});
					expect(mutations).toBe(1);
					expect(ids(await store.searchRecallMessages(q))).toEqual([race.m1]);
					expect(await store.searchRecallMessages({ ...q, text: "新原文" })).toEqual([]);
				});
			}
		}
	}
});

test("scoped lineage and effective-refs CTE both execute in the SQLite Worker with cancellation", async () => {
	const { createSqliteSearchQueryExecutor } = await import("../sqlite-worker-runner");
	const controller = new AbortController();
	const statements: string[] = [];
	const worker = createSqliteSearchQueryExecutor(sqlite.filename);
	const store = createSqliteSearchStore(
		async (sql, params, options) => {
			statements.push(sql);
			expect(options?.signal).toBe(controller.signal);
			return worker(sql, params, options);
		},
		{ blockOnly: () => true },
	);
	const rows = await store.searchRecallMessages(
		query({
			text: "lazyneedle",
			narratorId: "lazy-child",
			sort: "newest",
			signal: controller.signal,
		}),
	);
	expect(ids(rows)).toEqual(["lazy-before", "lazy-child-own", "lazy-duplicate", "lazy-middle-own"]);
	expect(statements).toHaveLength(2);
	expect(statements[0]).toContain("WITH RECURSIVE lineage");
	expect(statements[1]).toContain("effective_recall_refs AS");
	expect(statements[1]).toContain("recall_query_result AS (WITH hits AS");
	expect(statements[1]).toContain("recall_lineage_guard.valid AS recall_lineage_valid");
	controller.abort();
	await expect(
		store.searchRecallMessages(query({ narratorId: "lazy-child", signal: controller.signal })),
	).rejects.toMatchObject({ code: "SEARCH_QUERY_CANCELLED" });
});

// Execute PG callers against the same temporary SQL fixture: only dialect functions and
// numbered casts are adapted; lineage/guard/refs SQL and inter-query schedule are real.
sqlite.run(
	"CREATE TEMP VIEW search_narrator_messages AS SELECT id, content_text FROM narrator_messages",
);
const pgFixtureRows = (sql: string, params: unknown[]) =>
	sqlite
		.prepare<Record<string, unknown>, Array<string | number | null>>(
			sql
				.replace(/::(?:text|bigint)/g, "")
				.replace(/\$(\d+)/g, "?$1")
				.replace(/\bILIKE\b/g, "LIKE")
				.replace(/\(1 - GREATEST\([\s\S]*?\)\) AS rank_score/, "0 AS rank_score")
				.replace(
					/CASE\s+WHEN f\.content_text IS NULL THEN NULL[\s\S]*?END AS snippet/,
					"substr(f.content_text, 1, 66) AS snippet",
				),
		)
		.all(...(params as Array<string | number | null>));

describe("PostgreSQL Recall bound SQL contract (no database connection)", () => {
	for (const strategy of ["index", "substring"] as const) {
		test(`${strategy} final guard rejects materialization + ancestor COW between executor calls`, async () => {
			const race = lineageRaceFixture(`pg-race-${strategy}`, strategy === "index");
			let mutateAfterLineage = false;
			let mutations = 0;
			const store = createPostgresSearchStore({
				unsafe: async (sql: string, params: unknown[]) => {
					const rows = pgFixtureRows(sql, params);
					if (mutateAfterLineage && sql.startsWith("WITH RECURSIVE lineage")) {
						mutateAfterLineage = false;
						race.materializeThenCow();
						mutations++;
					}
					return rows;
				},
			} as unknown as PgExecutor);
			const q = query({ text: "raceguard", strategy, narratorId: race.child });
			expect(ids(await store.searchRecallMessages(q))).toEqual([race.m1]);
			mutateAfterLineage = true;
			await expect(store.searchRecallMessages(q)).rejects.toMatchObject({
				code: "DB_READ_PROTOCOL",
			});
			expect(mutations).toBe(1);
			expect(ids(await store.searchRecallMessages(q))).toEqual([race.m1]);
			expect(await store.searchRecallMessages({ ...q, text: "新原文" })).toEqual([]);
		});

		test(`${strategy} scoped lazy CTE binds lineage first and preserves target history identity`, async () => {
			const calls: { sql: string; params: unknown[] }[] = [];
			const store = createPostgresSearchStore({
				unsafe: async (sql: string, params: unknown[]) => {
					calls.push({ sql, params });
					if (sql.startsWith("WITH RECURSIVE lineage"))
						return [
							{ id: "lazy-child", refs_inherited_from: "lazy-middle", refs_backfill_cursor: 4 },
							{ id: "lazy-middle", refs_inherited_from: "lazy-root", refs_backfill_cursor: 5 },
							{ id: "lazy-root", refs_inherited_from: null, refs_backfill_cursor: null },
						];
					return [
						{
							recall_lineage_valid: true,
							recall_row_present: 1,
							id: "lazy-before",
							narrator_id: "lazy-child",
							narrator_title: "title-lazy-child",
							owner_narrator_id: "lazy-root",
							role: "user",
							origin: "user",
							created_at: NOW,
						},
					];
				},
			} as unknown as PgExecutor);
			const rows = await store.searchRecallMessages(
				query({
					strategy,
					narratorId: "lazy-child",
					origins: ["user"],
					createdFrom: OLD,
					limit: 1,
				}),
			);
			expect(calls).toHaveLength(2);
			expect(calls[0].params).toEqual(["lazy-child"]);
			expect(calls[0].sql).toContain("WHERE id = $1");
			expect(calls[0].sql).toContain("l.depth < 32");
			expect(calls[0].sql).toContain("LIMIT 33");
			const { sql, params } = calls[1];
			expect(params.slice(0, 12)).toEqual([
				"lazy-child",
				null,
				"lazy-middle",
				4,
				"lazy-middle",
				4,
				"lazy-root",
				5,
				"lazy-root",
				4,
				null,
				null,
			]);
			expect(sql).toContain(
				"VALUES ($1::text, $2::bigint, 0, $3::text, $4::bigint, 1),($5::text, $6::bigint, 1, $7::text, $8::bigint, 1),($9::text, $10::bigint, 2, $11::text, $12::bigint, 1)",
			);
			expect(sql).toContain(
				"observed.refs_inherited_from IS DISTINCT FROM captured.expected_parent",
			);
			expect(sql).toContain(
				"observed.refs_backfill_cursor IS DISTINCT FROM captured.expected_cursor",
			);
			expect(sql).toContain("WHERE (SELECT valid FROM recall_lineage_guard)");
			expect(sql).toContain("recall_lineage_guard.valid AS recall_lineage_valid");
			expect(sql).toContain("JOIN effective_recall_refs r ON r.message_id = m.id");
			expect(sql).toContain("n.id = (SELECT narrator_id FROM recall_ref_sources WHERE depth = 0)");
			expect(sql).toContain("r.seq < s.upper_bound AND r.segment_compact_id IS NULL");
			expect(sql).toContain("closer.depth < s.depth");
			expect(sql).toContain("n.hidden_from_lists = 0");
			expect(sql).not.toContain("?");
			expect(params.at(-1)).toBe(1);
			expect(Math.max(...Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])))).toBe(
				params.length,
			);
			expect(rows[0]).toMatchObject({
				narratorId: "lazy-child",
				narratorTitle: "title-lazy-child",
				ownerNarratorId: "lazy-root",
			});
		});

		test(`${strategy} global SQL chooses an existing history ref and preserves owner identity`, async () => {
			let statement = "";
			const store = createPostgresSearchStore({
				unsafe: async (sql: string) => {
					statement = sql;
					return [
						{
							id: "history-block",
							narrator_id: "history-b",
							narrator_title: "title-history-b",
							owner_narrator_id: "owner",
							role: "user",
							origin: "user",
							created_at: NOW,
						},
					];
				},
			} as unknown as PgExecutor);
			const rows = await store.searchRecallMessages(
				query({ strategy, narratorId: null, limit: 1 }),
			);
			expect(rows[0].narratorId).toBe("history-b");
			expect(rows[0].narratorTitle).toBe("title-history-b");
			expect(rows[0].ownerNarratorId).toBe("owner");
			const beforeLimit = statement.slice(0, statement.lastIndexOf("LIMIT"));
			expect(beforeLimit).toContain("JOIN narrators n ON n.id = COALESCE(");
			expect(beforeLimit).toContain(
				"WHERE hr.message_id = m.id AND hr.narrator_id = m.narrator_id",
			);
			expect(beforeLimit).toContain("SELECT MIN(n.id) FROM narrator_message_refs hr");
			expect(beforeLimit).toContain("m.narrator_id AS owner_narrator_id");
			expect(beforeLimit).toContain("n.title AS narrator_title");
			expect(beforeLimit).toContain("AND EXISTS (SELECT 1 FROM narrators n");
			// The owner gate, selected history, and fallback selection all retain the shared scope.
			expect(beforeLimit.match(/n\.hidden_from_lists = 0/g)).toHaveLength(3);
			expect(beforeLimit.match(/modeltrace/g)).toHaveLength(3);
		});

		test(`${strategy} filters, scopes, and sort are inside the limited query`, async () => {
			const calls: { sql: string; params: unknown[] }[] = [];
			const store = createPostgresSearchStore({
				unsafe: async (sql: string, params: unknown[]) => {
					calls.push({ sql, params });
					if (sql.startsWith("WITH RECURSIVE lineage"))
						return [{ id: "fork", refs_inherited_from: null, refs_backfill_cursor: null }];
					return [
						{
							recall_lineage_valid: true,
							recall_row_present: 1,
							id: "a",
							narrator_id: "fork",
							role: "user",
							origin: null,
							created_at: NOW,
						},
					];
				},
			} as unknown as PgExecutor);
			for (const sort of ["relevance", "newest", "oldest"] as const) {
				const rows = await store.searchRecallMessages(
					query({
						strategy,
						sort,
						narratorId: "fork",
						roles: ["user", "assistant"],
						origins: ["unknown", "user"],
						createdFrom: OLD,
						createdTo: NOW,
						limit: 1,
					}),
				);
				expect(rows[0].origin).toBeNull();
				const call = calls.at(-1);
				if (!call) throw new Error("Recall must execute its SQL query");
				const { sql, params } = call;
				const beforeLimit = sql.slice(0, sql.lastIndexOf("LIMIT"));
				expect(beforeLimit).toMatch(/m\.role IN \(\$\d+,\$\d+\)/);
				expect(beforeLimit).toMatch(/\(m\.origin IN \(\$\d+\) OR m\.origin IS NULL\)/);
				expect(beforeLimit).toContain("JOIN narrator_message_refs r");
				expect(beforeLimit).toContain("n.hidden_from_lists = 0");
				expect(beforeLimit).toMatch(/m\.created_at >= \$\d+/);
				expect(beforeLimit).toMatch(/m\.created_at <= \$\d+/);
				expect(params).toContain("fork");
				expect(params).toContain("assistant");
				expect(params).toContain("user");
				expect(params).not.toContain("unknown");
				expect(params.at(-1)).toBe(1);
				expect(beforeLimit).toContain(
					`m.created_at ${sort === "oldest" ? "ASC" : "DESC"}, m.id ASC`,
				);
				if (strategy === "index" && sort === "relevance") {
					expect(beforeLimit).toContain("ORDER BY rank_score ASC NULLS LAST");
				}
			}
			await store.searchRecallMessages(query({ strategy, origins: ["user"] }));
			expect(calls.at(-1)?.sql).not.toContain("m.origin IS NULL");
			await store.searchRecallMessages(query({ strategy, roles: [], origins: [] }));
			expect(calls.at(-1)?.sql).toContain("AND FALSE");
		});
	}
});
