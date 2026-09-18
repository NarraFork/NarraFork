/**
 * Search parity: SQLite FTS5 and PostgreSQL pg_trgm answer the SAME queries with the SAME
 * rows, over one fixture seeded identically into both engines.
 *
 * WHY SET EQUALITY, NOT ORDER EQUALITY
 * ------------------------------------
 * The port (`port.ts`) gives each backend its own relevance signal: FTS5 `rank` vs
 * `1 - pg_trgm similarity()`. Those are different measurements, so cross-backend ORDER may
 * legitimately differ — the caller's score bands are calibrated per strategy, not per
 * backend. What may NOT differ is recall: which rows come back. Every comparison below is
 * therefore a SET comparison on ids, plus a pinned ordering boundary: each backend's own
 * ordering must be consistent with its own rank (non-decreasing), which is the only
 * ordering guarantee the contract makes.
 *
 * WHAT IS ALSO PINNED HERE
 * ------------------------
 *   - the ACL gates are embedded in the PG queries: a stranger must not find a private
 *     narrator's messages or title, exactly as on SQLite (a hit carries an excerpt, so a
 *     post-filtered leak would already have computed it);
 *   - a 2-character CJK query takes the substring strategy (the caller's decision — the
 *     store only honours it) and still hits, on both engines;
 *   - an unknown knowledge `field` is REJECTED with ValidationError by both backends;
 *   - Recall's `>>>/<<<` and knowledge's `[`/`]` snippet markers survive the backend swap.
 *
 * Gated by PG_INTEGRATION=1: when integration is requested, an unavailable database must
 * FAIL the test, never pass as "blocked".
 */
import { describe, expect, mock, test } from "bun:test";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { migrate } from "drizzle-orm/pg-proxy/migrator";
import { migrationScript, psqlProxyCallback } from "../../../../tests/db/pg-baseline-model";
import { withPostgres } from "../../../../tests/db/pg-test-harness";
import { getTestDb } from "../../../../tests/setup";
import type { PgExecutor } from "../../../db/pg-fts";
import type { SearchStore } from "../port";
import type {
	EntitySearchQuery,
	KnowledgeDraftSearchQuery,
	KnowledgeSearchQuery,
	RecallSearchQuery,
	TimelineSearchQuery,
} from "../types";

const { db, sqlite } = getTestDb();
mock.module("../../../db", () => ({ db, sqlite }));

// FTS virtual tables + sync triggers are runtime DDL on the SQLite side.
const { ensureFts } = await import("../../../db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { sqliteSearchStore } = await import("../sqlite-store");
const { createPostgresSearchStore } = await import("../postgres-store");
const { ensurePgFts } = await import("../../../db/pg-fts");
const { createPostgresClient } = await import("../../../db/postgres-client");

const MIGRATIONS_FOLDER = "drizzle-postgres";
const RUN_TIMEOUT_MS = 420_000;
const NOW = "2026-09-20T00:00:00.000Z";

// ─────────────────────────────────────────────────────────────────────────────
// The fixture: one logical dataset, two physical seedings
// ─────────────────────────────────────────────────────────────────────────────

const USERS = ["u-owner", "u-stranger", "u-author"];
const NOW_PARAMS = [NOW];

function seedSqlite(): void {
	const run = (sql: string, params: unknown[] = []) =>
		sqlite.prepare(sql).run(...(params as never[]));
	for (const u of USERS) {
		run(`INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`, [
			u,
			u,
			NOW,
		]);
	}
	run(
		`INSERT INTO projects (id, name, visibility, owner_user_id, created_at, updated_at)
		 VALUES ('p1', 'Private project', 'private', 'u-owner', ?, ?)`,
		NOW_PARAMS.concat(NOW),
	);
	run(
		`INSERT INTO projects (id, name, visibility, owner_user_id, created_at, updated_at)
		 VALUES ('p2', 'Public project', 'public', 'u-owner', ?, ?)`,
		NOW_PARAMS.concat(NOW),
	);
	const chapters: [string, string, string, string][] = [
		["ch1", "p1", "Authentication middleware overhaul", "Rework the auth flow for token refresh"],
		["ch2", "p2", "充电三阶段任务", "实现三阶段充电策略"],
		["ch3", "p2", "Middleware logging", "Add request logging to middleware"],
	];
	for (const [id, project, title, description] of chapters) {
		run(
			`INSERT INTO chapters (id, project_id, title, description, branch, base_branch, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'main', ?, ?)`,
			[id, project, title, description, `branch-${id}`, NOW, NOW],
		);
	}
	const narrators: [string, string, string | null, string][] = [
		["n1", "ch1", "Auth discussion session", "private"],
		["n2", "ch2", "Public brainstorm auth", "public"],
		["n3", "ch3", null, "public"],
		["n4", "ch2", "child session", "public"],
	];
	for (const [id, chapter, title, visibility] of narrators) {
		run(
			`INSERT INTO narrators (id, chapter_id, title, visibility, owner_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'u-owner', ?, ?)`,
			[id, chapter, title, visibility, NOW, NOW],
		);
	}
	const messages: [string, string, string, string][] = [
		["m1", "n1", "user", "the authentication middleware should rotate tokens"],
		["m2", "n2", "assistant", "middleware ordering matters for auth"],
		["m3", "n2", "assistant", "你好世界，这是三阶段充电方案"],
		["m4", "n1", "assistant", "unrelated content about databases"],
	];
	for (const [id, narrator, role, text] of messages) {
		run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at)
			 VALUES (?, ?, ?, '[]', ?, ?)`,
			[id, narrator, role, text, NOW],
		);
	}
	const refs: [string, string, number][] = [
		["n1", "m1", 1],
		["n1", "m4", 2],
		["n2", "m2", 1],
		["n2", "m3", 2],
	];
	for (const [narrator, message, seq] of refs) {
		run(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
			 VALUES (?, ?, ?, ?)`,
			[`ref-${narrator}-${message}`, narrator, message, seq],
		);
	}
	run(
		`INSERT INTO knowledge_collections (id, name, slug, project_id, created_at, updated_at)
		 VALUES ('kc1', 'Project knowledge', 'kc1', 'p1', ?, ?)`,
		NOW_PARAMS.concat(NOW),
	);
	run(
		`INSERT INTO knowledge_collections (id, name, slug, project_id, created_at, updated_at)
		 VALUES ('kc2', 'Global knowledge', 'kc2', NULL, ?, ?)`,
		NOW_PARAMS.concat(NOW),
	);
	const entries: [string, string, string, string, string, string | null][] = [
		[
			"ke1",
			"kc1",
			"Auth middleware runbook",
			"auth-runbook",
			"How to rotate tokens in the auth middleware",
			"auth middleware tokens",
		],
		["ke2", "kc2", "充电策略", "charging", "三阶段充电的实现细节", "充电 三阶段"],
		["ke3", "kc1", "Database notes", "db-notes", "WAL and checkpoints", null],
	];
	for (const [id, collection, title, slug, content, keywords] of entries) {
		run(
			`INSERT INTO knowledge_entries (id, collection_id, title, slug, current_content, current_keywords, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, collection, title, slug, content, keywords, NOW, NOW],
		);
	}
	const drafts: [string, string, string][] = [
		["kd1", "ke1", "draft: rotate tokens differently in middleware"],
		["kd2", "ke2", "草稿：三阶段充电的修订"],
	];
	for (const [id, entry, content] of drafts) {
		run(
			`INSERT INTO knowledge_drafts (id, entry_id, author_user_id, content, content_hash, status, created_at, updated_at)
			 VALUES (?, ?, 'u-author', ?, ?, 'active', ?, ?)`,
			[id, entry, content, `hash-${id}`, NOW, NOW],
		);
	}
}

async function seedPostgres(pg: PgExecutor): Promise<void> {
	for (const u of USERS) {
		await pg.unsafe(
			`INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, 'x', $3)`,
			[u, u, NOW],
		);
	}
	await pg.unsafe(
		`INSERT INTO projects (id, name, visibility, owner_user_id, created_at, updated_at)
		 VALUES ('p1', 'Private project', 'private', 'u-owner', $1, $1),
		        ('p2', 'Public project', 'public', 'u-owner', $1, $1)`,
		[NOW],
	);
	const chapters: [string, string, string, string][] = [
		["ch1", "p1", "Authentication middleware overhaul", "Rework the auth flow for token refresh"],
		["ch2", "p2", "充电三阶段任务", "实现三阶段充电策略"],
		["ch3", "p2", "Middleware logging", "Add request logging to middleware"],
	];
	for (const [id, project, title, description] of chapters) {
		await pg.unsafe(
			`INSERT INTO chapters (id, project_id, title, description, branch, base_branch, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'main', $6, $6)`,
			[id, project, title, description, `branch-${id}`, NOW],
		);
	}
	const narrators: [string, string, string | null, string][] = [
		["n1", "ch1", "Auth discussion session", "private"],
		["n2", "ch2", "Public brainstorm auth", "public"],
		["n3", "ch3", null, "public"],
		["n4", "ch2", "child session", "public"],
	];
	for (const [id, chapter, title, visibility] of narrators) {
		await pg.unsafe(
			`INSERT INTO narrators (id, chapter_id, title, visibility, owner_user_id, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'u-owner', $5, $5)`,
			[id, chapter, title, visibility, NOW],
		);
	}
	const messages: [string, string, string, string][] = [
		["m1", "n1", "user", "the authentication middleware should rotate tokens"],
		["m2", "n2", "assistant", "middleware ordering matters for auth"],
		["m3", "n2", "assistant", "你好世界，这是三阶段充电方案"],
		["m4", "n1", "assistant", "unrelated content about databases"],
	];
	for (const [id, narrator, role, text] of messages) {
		await pg.unsafe(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at)
			 VALUES ($1, $2, $3, '[]', $4, $5)`,
			[id, narrator, role, text, NOW],
		);
	}
	const refs: [string, string, number][] = [
		["n1", "m1", 1],
		["n1", "m4", 2],
		["n2", "m2", 1],
		["n2", "m3", 2],
	];
	for (const [narrator, message, seq] of refs) {
		await pg.unsafe(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
			 VALUES ($1, $2, $3, $4)`,
			[`ref-${narrator}-${message}`, narrator, message, seq],
		);
	}
	await pg.unsafe(
		`INSERT INTO knowledge_collections (id, name, slug, project_id, created_at, updated_at)
		 VALUES ('kc1', 'Project knowledge', 'kc1', 'p1', $1, $1),
		        ('kc2', 'Global knowledge', 'kc2', NULL, $1, $1)`,
		[NOW],
	);
	const entries: [string, string, string, string, string, string | null][] = [
		[
			"ke1",
			"kc1",
			"Auth middleware runbook",
			"auth-runbook",
			"How to rotate tokens in the auth middleware",
			"auth middleware tokens",
		],
		["ke2", "kc2", "充电策略", "charging", "三阶段充电的实现细节", "充电 三阶段"],
		["ke3", "kc1", "Database notes", "db-notes", "WAL and checkpoints", null],
	];
	for (const [id, collection, title, slug, content, keywords] of entries) {
		await pg.unsafe(
			`INSERT INTO knowledge_entries (id, collection_id, title, slug, current_content, current_keywords, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
			[id, collection, title, slug, content, keywords, NOW],
		);
	}
	const drafts: [string, string, string][] = [
		["kd1", "ke1", "draft: rotate tokens differently in middleware"],
		["kd2", "ke2", "草稿：三阶段充电的修订"],
	];
	for (const [id, entry, content] of drafts) {
		await pg.unsafe(
			`INSERT INTO knowledge_drafts (id, entry_id, author_user_id, content, content_hash, status, created_at, updated_at)
			 VALUES ($1, $2, 'u-author', $3, $4, 'active', $5, $5)`,
			[id, entry, content, `hash-${id}`, NOW],
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison helpers
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = { userId: "u-owner", isAdmin: false };
const STRANGER = { userId: "u-stranger", isAdmin: false };
const ADMIN = { userId: "u-stranger", isAdmin: true };

function entity(text: string, strategy: "index" | "substring", viewer = OWNER): EntitySearchQuery {
	return { text, strategy, limit: 50, viewer };
}

function knowledge(
	indexText: string,
	strategy: "index" | "substring",
	extra: Partial<KnowledgeSearchQuery> = {},
): KnowledgeSearchQuery {
	return {
		indexText,
		substringText: indexText,
		strategy,
		limit: 50,
		match: "and",
		...extra,
	};
}

function draftQuery(indexText: string, strategy: "index" | "substring"): KnowledgeDraftSearchQuery {
	return { ...knowledge(indexText, strategy), authorUserId: "u-author", draftStatus: "active" };
}

function ids(rows: readonly { id: string }[]): string[] {
	return rows.map((r) => r.id).sort();
}

function messageIds(rows: readonly { messageId: string }[]): string[] {
	return rows.map((r) => r.messageId).sort();
}

/**
 * The pinned ordering boundary: cross-backend order is unspecified, but each backend's own
 * index-strategy ordering must be consistent with its own rank values (non-decreasing —
 * lower rank is a better match on both engines).
 */
function expectRankOrdered(rows: readonly { rank: number | null }[], label: string): void {
	const ranks = rows.map((r) => r.rank);
	for (const rank of ranks) expect(rank, `${label}: index rows carry a rank`).not.toBeNull();
	for (let i = 1; i < ranks.length; i++) {
		expect(
			(ranks[i] as number) >= (ranks[i - 1] as number),
			`${label}: rank ordering is non-decreasing`,
		).toBe(true);
	}
}

describe("search parity: SQLite FTS5 vs PostgreSQL pg_trgm", () => {
	test.skipIf(process.env.PG_INTEGRATION !== "1")(
		"returns the same rows from both backends over one fixture",
		async () => {
			seedSqlite();
			const result = await withPostgres(async ({ port, exec }) => {
				const proxyDb = drizzleProxy(psqlProxyCallback(exec)) as unknown as PgRemoteDatabase;
				await migrate(
					proxyDb,
					async (queries) => {
						const applied = await exec(migrationScript(queries));
						if (applied.code !== 0) {
							throw new Error(`migration failed (${applied.code}): ${applied.stderr.slice(-400)}`);
						}
					},
					{ migrationsFolder: MIGRATIONS_FOLDER },
				);
				const password = "parity-test-password";
				await exec(`ALTER ROLE CURRENT_USER PASSWORD '${password}';`);
				const user = (await exec("SELECT current_user;")).stdout.trim();
				const client = createPostgresClient({
					driver: "bun-sql",
					url: `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/nf_harness`,
					max: 2,
					idleTimeout: 1,
					maxLifetime: 60,
					connectTimeout: 10,
				});
				const pg: PgExecutor = {
					unsafe: (query, params) =>
						client.sql.unsafe(query, params) as Promise<Record<string, unknown>[]>,
				};
				try {
					await ensurePgFts(pg);
					await seedPostgres(pg);
					const lite: SearchStore = sqliteSearchStore;
					const store: SearchStore = createPostgresSearchStore(pg);
					const failures: string[] = [];
					const check = (label: string, actual: unknown, expected: unknown) => {
						try {
							expect(actual).toEqual(expected);
						} catch {
							failures.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
						}
					};

					// ── chapters: phrase recall + project ACL gate ────────────────────────
					for (const [label, viewer, expected] of [
						["owner", OWNER, ["ch1", "ch3"]],
						["stranger (private project hidden)", STRANGER, ["ch3"]],
						["admin", ADMIN, ["ch1", "ch3"]],
					] as const) {
						const [a, b] = await Promise.all([
							lite.searchChapters(entity("middleware", "index", viewer)),
							store.searchChapters(entity("middleware", "index", viewer)),
						]);
						check(`chapters index middleware ${label} (sqlite)`, ids(a), expected);
						check(`chapters index middleware ${label} (postgres)`, ids(b), expected);
						expectRankOrdered(a, `sqlite chapters ${label}`);
						expectRankOrdered(b, `postgres chapters ${label}`);
					}

					// ── chapters: CJK index (3 chars) and substring (2 chars) ──────────────
					for (const [label, query, expected] of [
						["index 三阶段", entity("三阶段", "index"), ["ch2"]],
						["substring 充电", entity("充电", "substring"), ["ch2"]],
					] as const) {
						const [a, b] = await Promise.all([
							lite.searchChapters(query),
							store.searchChapters(query),
						]);
						check(`chapters ${label} (sqlite)`, ids(a), expected);
						check(`chapters ${label} (postgres)`, ids(b), expected);
					}

					// ── narrators: title recall + narrator ACL gate ───────────────────────
					for (const [label, viewer, expected] of [
						["owner", OWNER, ["n1", "n2"]],
						["stranger (private narrator hidden)", STRANGER, ["n2"]],
					] as const) {
						const [a, b] = await Promise.all([
							lite.searchNarrators(entity("auth", "index", viewer)),
							store.searchNarrators(entity("auth", "index", viewer)),
						]);
						check(`narrators index auth ${label} (sqlite)`, ids(a), expected);
						check(`narrators index auth ${label} (postgres)`, ids(b), expected);
						expectRankOrdered(a, `sqlite narrators ${label}`);
						expectRankOrdered(b, `postgres narrators ${label}`);
					}

					// ── messages: narrator ACL gate on transcript excerpts ────────────────
					for (const [label, viewer, expected] of [
						["owner", OWNER, ["m1", "m2"]],
						["stranger (private narrator's messages hidden)", STRANGER, ["m2"]],
						["admin", ADMIN, ["m1", "m2"]],
					] as const) {
						const [a, b] = await Promise.all([
							lite.searchMessages(entity("auth", "index", viewer)),
							store.searchMessages(entity("auth", "index", viewer)),
						]);
						check(`messages index auth ${label} (sqlite)`, ids(a), expected);
						check(`messages index auth ${label} (postgres)`, ids(b), expected);
						expectRankOrdered(a, `sqlite messages ${label}`);
						expectRankOrdered(b, `postgres messages ${label}`);
					}
					// The gate must hold on the substring path too — it is a different statement.
					for (const [label, viewer, expected] of [
						["owner", OWNER, ["m3"]],
						["stranger", STRANGER, ["m3"]],
					] as const) {
						const [a, b] = await Promise.all([
							lite.searchMessages(entity("充电", "substring", viewer)),
							store.searchMessages(entity("充电", "substring", viewer)),
						]);
						check(`messages substring 充电 ${label} (sqlite)`, ids(a), expected);
						check(`messages substring 充电 ${label} (postgres)`, ids(b), expected);
					}
					// A private narrator's message is invisible to a stranger even when it matches.
					for (const [backend, s] of [
						["sqlite", lite],
						["postgres", store],
					] as const) {
						const rows = await s.searchMessages(entity("tokens", "index", STRANGER));
						check(`messages index tokens stranger (${backend})`, ids(rows), []);
						const ownerRows = await s.searchMessages(entity("tokens", "index", OWNER));
						check(`messages index tokens owner (${backend})`, ids(ownerRows), ["m1"]);
					}

					// ── timeline: own refs and an inherited fork scope ────────────────────
					const timelineCases: [string, TimelineSearchQuery, string[]][] = [
						[
							"index middleware",
							{
								narratorId: "n2",
								text: "middleware",
								strategy: "index",
								limit: 20,
								inheritedScopes: [],
							},
							["m2"],
						],
						[
							"substring 充电",
							{
								narratorId: "n2",
								text: "充电",
								strategy: "substring",
								limit: 20,
								inheritedScopes: [],
							},
							["m3"],
						],
						[
							"inherited scope (child sees ancestor refs below the bound)",
							{
								narratorId: "n4",
								text: "middleware",
								strategy: "index",
								limit: 20,
								inheritedScopes: [{ narratorId: "n2", upperBoundSeq: 2 }],
							},
							["m2"],
						],
					];
					for (const [label, query, expected] of timelineCases) {
						const [a, b] = await Promise.all([
							lite.searchTimeline(query),
							store.searchTimeline(query),
						]);
						check(`timeline ${label} (sqlite)`, messageIds(a), expected);
						check(`timeline ${label} (postgres)`, messageIds(b), expected);
						// Timeline order IS contractual: newest first by seq.
						const seqs = b.map((r: { seq: number }) => r.seq);
						check(
							`timeline ${label} seq order (postgres)`,
							seqs,
							[...seqs].sort((x: number, y: number) => y - x),
						);
					}

					// ── recall: scoped, global, and the marked snippet ────────────────────
					const recallCases: [string, RecallSearchQuery, string[]][] = [
						[
							"scoped tokens",
							{ text: "tokens", strategy: "index", limit: 20, narratorId: "n1", previewChars: 240 },
							["m1"],
						],
						[
							"global middleware",
							{
								text: "middleware",
								strategy: "index",
								limit: 20,
								narratorId: null,
								previewChars: 240,
							},
							["m1", "m2"],
						],
						[
							"global substring 充电",
							{
								text: "充电",
								strategy: "substring",
								limit: 20,
								narratorId: null,
								previewChars: 240,
							},
							["m3"],
						],
					];
					for (const [label, query, expected] of recallCases) {
						const [a, b] = await Promise.all([
							lite.searchRecallMessages(query),
							store.searchRecallMessages(query),
						]);
						check(`recall ${label} (sqlite)`, messageIds(a), expected);
						check(`recall ${label} (postgres)`, messageIds(b), expected);
					}
					// Recall's output is read by a model: the match markers are its contract.
					for (const [backend, s] of [
						["sqlite", lite],
						["postgres", store],
					] as const) {
						const rows = await s.searchRecallMessages({
							text: "tokens",
							strategy: "index",
							limit: 5,
							narratorId: "n1",
							previewChars: 240,
						});
						expect(rows.length).toBe(1);
						expect(rows[0]?.snippet, `recall markers survive (${backend})`).toContain(">>>");
						expect(rows[0]?.snippet, `recall markers survive (${backend})`).toContain("<<<");
					}

					// ── knowledge entries: recall, field restriction, markers ──────────────
					const entryCases: [string, KnowledgeSearchQuery, string[]][] = [
						["index auth", knowledge("auth", "index"), ["ke1"]],
						["index middleware AND tokens", knowledge("middleware tokens", "index"), ["ke1"]],
						["index wal OR auth", knowledge("wal auth", "index", { match: "or" }), ["ke1", "ke3"]],
						["index 三阶段", knowledge("三阶段", "index"), ["ke2"]],
						["substring 充电", knowledge("充电", "substring"), ["ke2"]],
						[
							"field current_keywords tokens",
							knowledge("tokens", "index", { field: "current_keywords" }),
							["ke1"],
						],
						["project restriction", knowledge("auth", "index", { projectId: "p1" }), ["ke1"]],
						[
							"exclusion list",
							knowledge("middleware tokens", "index", { excludeEntryIds: ["ke1"] }),
							[],
						],
					];
					for (const [label, query, expected] of entryCases) {
						const [a, b] = await Promise.all([
							lite.searchKnowledgeEntries(query),
							store.searchKnowledgeEntries(query),
						]);
						check(`knowledge entries ${label} (sqlite)`, ids(a), expected);
						check(`knowledge entries ${label} (postgres)`, ids(b), expected);
					}
					for (const [backend, s] of [
						["sqlite", lite],
						["postgres", store],
					] as const) {
						const rows = await s.searchKnowledgeEntries(knowledge("tokens", "index"));
						expect(rows.length).toBe(1);
						expect(rows[0]?.snippet, `knowledge markers survive (${backend})`).toContain("[");
						expect(rows[0]?.snippet, `knowledge markers survive (${backend})`).toContain("]");
						// An unknown field is a ValidationError, never an interpolated identifier.
						await expect(
							s.searchKnowledgeEntries(knowledge("tokens", "index", { field: "body; DROP" })),
							`unknown knowledge field rejects (${backend})`,
						).rejects.toThrow(/Unsupported knowledge search field/);
					}

					// ── knowledge drafts: de-normalized title, shadowing ───────────────────
					const draftCases: [string, KnowledgeDraftSearchQuery, string[]][] = [
						["index middleware", draftQuery("middleware", "index"), ["ke1"]],
						["substring 充电", draftQuery("充电", "substring"), ["ke2"]],
					];
					for (const [label, query, expected] of draftCases) {
						const [a, b] = await Promise.all([
							lite.searchKnowledgeDrafts(query),
							store.searchKnowledgeDrafts(query),
						]);
						check(`knowledge drafts ${label} (sqlite)`, ids(a), expected);
						check(`knowledge drafts ${label} (postgres)`, ids(b), expected);
					}
					for (const [backend, s] of [
						["sqlite", lite],
						["postgres", store],
					] as const) {
						const shadowed = await s.listShadowedEntryIds({
							authorUserId: "u-author",
							draftStatus: "active",
							limit: 50,
						});
						check(`shadowed entry ids (${backend})`, [...shadowed].sort(), ["ke1", "ke2"]);
					}

					if (failures.length > 0) {
						throw new Error(`parity failures:\n${failures.join("\n")}`);
					}
					return "ok";
				} finally {
					await client.close();
				}
			});
			if (typeof result !== "string") {
				throw new Error(
					`search parity integration unavailable: ${result.status === "blocked" || result.status === "failed" ? result.reason : "unexpected harness result"}`,
				);
			}
			expect(result).toBe("ok");
		},
		RUN_TIMEOUT_MS,
	);
});
