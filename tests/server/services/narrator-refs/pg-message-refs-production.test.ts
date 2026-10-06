import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
} from "../../../../server/db/postgres-schema";
import type { RefMessageInput } from "../../../../server/services/narrator-refs/port";
import { createPostgresNarratorMessageRefsPort } from "../../../../server/services/narrator-refs/postgres-store";
import { bindNarratorMessageRefs } from "../../../../server/services/narrator-refs/store";
import { withPostgres } from "../../../db/pg-test-harness";
import { getTestDb } from "../../../setup";
import { migrationSql } from "../read/pg-parity-matrix";

const local = getTestDb();
const realDb = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => local);
const realWs = { ...(await import("../../../../server/websocket/narrator-ws")) };
const broadcastRecipients: string[] = [];
mock.module("../../../../server/websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (id: string) => {
		broadcastRecipients.push(id);
	},
}));
await import("../../../../server/services/narrator-service");
const { narratorPersistence } = await import("../../../../server/services/narrator-persistence");
const clearContextCapturedBeforeBinding = narratorPersistence.clearContext;
afterAll(() => {
	bindNarratorMessageRefs(undefined);
	mock.module("../../../../server/db", () => realDb);
	mock.module("../../../../server/websocket/narrator-ws", () => realWs);
	mock.restore();
});
const now = "2026-09-17T00:00:00.000Z";
function message(
	id: string,
	narratorId = "parent",
	role: RefMessageInput["role"] = "user",
): RefMessageInput {
	return {
		id,
		narratorId,
		role,
		contentJson: [{ type: "text", text: `searchable-${id}` }],
		contentText: `searchable-${id}`,
		createdAt: now,
	};
}

// Opt-in is explicitly skipped, never represented as PG evidence. PG_INTEGRATION=1 cannot skip.
const integration = process.env.PG_INTEGRATION === "1" ? test : test.skip;
integration(
	"PG17 full journal: production entrypoints, 20 append races, shift, fork, rollback, cursor and FTS",
	async () => {
		const outcome = await withPostgres(async ({ exec, port, credentials }) => {
			for (const migration of await migrationSql()) {
				const applied = await exec(migration);
				expect(applied.code, applied.stderr).toBe(0);
			}
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`,
				max: 24,
			});
			try {
				const [{ server_version: version }] = await client.sql.unsafe("SHOW server_version");
				expect(String(version).startsWith("17.")).toBe(true);
				await ensurePgFts(client.sql);
				await client.db.insert(narrators).values(
					["parent", "child", "rollback", "entry"].map((id) => ({
						id,
						createdAt: now,
						updatedAt: now,
					})),
				);
				const store = createPostgresNarratorMessageRefsPort(client.db);
				// Nonempty fixture before exercising concurrency.
				const first = await store.append(message("fixture"));
				expect(first.seq).toBe(0);
				const results = await Promise.all(
					Array.from({ length: 20 }, (_, i) => store.append(message(`parallel-${i}`))),
				);
				expect(results.map((row) => row.seq).sort((a, b) => a - b)).toEqual(
					Array.from({ length: 20 }, (_, i) => i + 1),
				);
				await Promise.all([
					store.append(message("racing-append")),
					store.insertBefore(message("shift", "parent", "system"), first.id),
				]);
				const parent = await client.db
					.select({
						seq: narrators.nextSeq,
						count: narrators.messageCount,
						version: narrators.messageVersion,
						structure: narrators.messageStructureVersion,
					})
					.from(narrators)
					.where(eq(narrators.id, "parent"));
				expect(parent[0]).toEqual({ seq: 23, count: 23, version: 23, structure: 1 });
				const copied = await store.copyRefs({
					sourceId: "parent",
					targetId: "child",
					fromSeq: 0,
					untilSeq: 23,
					limit: 10,
				});
				expect(copied.copied).toBe(10);
				expect(copied.nextCursor).not.toBeNull();
				// Append between copy windows cannot allocate into the not-yet-materialized window.
				expect((await store.append(message("child-own", "child"))).seq).toBe(23);
				let cursor = copied.nextCursor;
				while (cursor) {
					const next = await store.copyRefs({
						sourceId: "parent",
						targetId: "child",
						fromSeq: 0,
						untilSeq: 23,
						limit: 10,
						cursor,
					});
					cursor = next.nextCursor;
				}
				expect((await store.append(message("child-after-copy", "child"))).seq).toBe(24);
				const child = await client.db
					.select({
						next: narrators.nextSeq,
						count: narrators.messageCount,
						version: narrators.messageVersion,
					})
					.from(narrators)
					.where(eq(narrators.id, "child"));
				expect(child[0]).toEqual({ next: 25, count: 25, version: 5 });
				// Production summary pagination is seq+id and bounded, including legacy duplicate seq.
				await client.db
					.update(narratorMessageRefs)
					.set({ seq: 1 })
					.where(eq(narratorMessageRefs.messageId, "parallel-0"));
				const seen: { id: string; seq: number }[] = [];
				let pageCursor: { id: string; seq: number } | undefined;
				for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
					const page = await store.page("parent", pageCursor, 3);
					seen.push(...page.rows);
					if (!page.nextCursor) break;
					pageCursor = page.nextCursor;
				}
				expect(seen).toHaveLength(23);
				expect(new Set(seen.map((row) => row.id)).size).toBe(23);
				const expected = await client.db
					.select({ id: narratorMessageRefs.id, seq: narratorMessageRefs.seq })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, "parent"))
					.orderBy(narratorMessageRefs.seq, narratorMessageRefs.id);
				expect(seen.map(({ id, seq }) => ({ id, seq }))).toEqual(expected);
				// Test-only failure injection, confined to the throwaway database. Message INSERT succeeds first.
				await client.sql.unsafe(
					"CREATE FUNCTION reject_ref_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.narrator_id = 'rollback' THEN PERFORM pg_sleep(0.025); RAISE EXCEPTION 'ref fixture rejected' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
				);
				await client.sql.unsafe(
					"CREATE TRIGGER reject_ref_fixture BEFORE INSERT ON narrator_message_refs FOR EACH ROW EXECUTE FUNCTION reject_ref_fixture()",
				);
				await expect(store.append(message("doomed", "rollback"))).rejects.toThrow();
				expect(
					await client.db
						.select({ id: narratorMessages.id })
						.from(narratorMessages)
						.where(eq(narratorMessages.id, "doomed")),
				).toHaveLength(0);
				expect(
					await client.sql.unsafe(
						"SELECT id FROM search_narrator_messages WHERE id = 'doomed' LIMIT 1",
					),
				).toHaveLength(0);
				const [rolledBack] = await client.db
					.select({
						next: narrators.nextSeq,
						count: narrators.messageCount,
						version: narrators.messageVersion,
					})
					.from(narrators)
					.where(eq(narrators.id, "rollback"));
				expect(rolledBack).toEqual({ next: 0, count: 0, version: 0 });
				await client.sql.unsafe("DROP TRIGGER reject_ref_fixture ON narrator_message_refs");
				expect((await store.append(message("after-rollback", "rollback"))).seq).toBe(0);
				const fts = await client.sql.unsafe(
					"SELECT id FROM search_narrator_messages WHERE content_text ILIKE '%searchable-parallel-%' LIMIT 21",
				);
				expect(fts).toHaveLength(20);
				await client.db.insert(narrators).values(
					["stale-child", "occupied-child", "filtered-parent", "filtered-child"].map((id) => ({
						id,
						createdAt: now,
						updatedAt: now,
					})),
				);
				const window = await store.copyRefs({
					sourceId: "parent",
					targetId: "stale-child",
					fromSeq: 0,
					untilSeq: 23,
					limit: 1,
				});
				expect(window.nextCursor).not.toBeNull();
				await store.insertBefore(message("second-shift", "parent", "system"), first.id);
				await expect(
					store.copyRefs({
						sourceId: "parent",
						targetId: "stale-child",
						fromSeq: 0,
						untilSeq: 23,
						cursor: window.nextCursor ?? undefined,
					}),
				).rejects.toThrow("changed between copy windows");
				await store.append(message("own-before-copy", "occupied-child"));
				await expect(
					store.copyRefs({
						sourceId: "parent",
						targetId: "occupied-child",
						fromSeq: 0,
						untilSeq: 23,
					}),
				).rejects.toThrow("overlaps target-owned history");
				await store.append({
					...message("pending-compact", "filtered-parent", "system"),
					contentJson: [{ type: "compact", status: "compacting" }],
				});
				await store.append(message("stable-after-pending", "filtered-parent"));
				const filtered = await store.copyRefs({
					sourceId: "filtered-parent",
					targetId: "filtered-child",
					fromSeq: 0,
					untilSeq: 2,
				});
				expect(filtered.copied).toBe(1);
				expect((await store.page("filtered-child")).rows.map((row) => row.messageId)).toEqual([
					"stable-after-pending",
				]);
				expect((await store.append(message("filtered-own", "filtered-child"))).seq).toBe(2);
				bindNarratorMessageRefs({ backend: "postgres", port: store });
				const user = await narratorPersistence.persistUserMessage(
					"entry",
					"user through real entry",
				);
				const system = await narratorPersistence.persistSystemMessage(
					"entry",
					"system through real entry",
				);
				const assistant = await narratorPersistence.persistAssistantMessage("entry", {
					uuid: "assistant-entry",
					session_id: "session",
					message: { content: [{ type: "text", text: "assistant through real entry" }] },
				});
				const partial = await narratorPersistence.createPartialAssistantMessage("entry", {
					uuid: "partial-entry",
					session_id: "session",
				});
				expect([user.seq, system.seq, assistant.seq, partial.seq]).toEqual([0, 1, 2, 3]);
				expect((await store.page("entry")).rows.map((row) => row.role)).toEqual([
					"user",
					"sys",
					"assistant",
					"assistant",
				]);
				await expect(narratorPersistence.clearContext("entry")).rejects.toThrow("unavailable");
				await expect(clearContextCapturedBeforeBinding("entry")).rejects.toThrow("unavailable");
				await expect(
					narratorPersistence.persistUserMessage(
						"entry",
						"unsupported",
						undefined,
						undefined,
						undefined,
						undefined,
						{ onPersist: () => undefined },
					),
				).rejects.toThrow("unavailable");
				expect(
					local.sqlite
						.query("SELECT id FROM narrator_messages WHERE narrator_id = 'entry' LIMIT 1")
						.all(),
				).toHaveLength(0);
				const abort = new AbortController();
				abort.abort();
				await expect(
					store.append(message("cancelled"), { signal: abort.signal }),
				).rejects.toThrow();
				await expect(store.page("parent", undefined, 401)).rejects.toThrow();
				// SQLSTATE injected only in this disposable database, AFTER message insert and
				// an awaited server delay. nextval is deliberately nontransactional evidence of retries.
				await client.sql.unsafe("CREATE SEQUENCE ref_retry_attempts");
				await client.sql.unsafe(
					"CREATE FUNCTION retry_ref_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.narrator_id = TG_ARGV[0] AND nextval('ref_retry_attempts') = 1 THEN PERFORM pg_sleep(0.025); RAISE EXCEPTION 'retry fixture' USING ERRCODE = TG_ARGV[1]; END IF; RETURN NEW; END $$",
				);
				for (const code of ["40001", "40P01"]) {
					const target = `retry-${code}`;
					await client.db.insert(narrators).values({ id: target, createdAt: now, updatedAt: now });
					await client.sql.unsafe("ALTER SEQUENCE ref_retry_attempts RESTART WITH 1");
					await client.sql.unsafe(
						`CREATE TRIGGER retry_ref_fixture BEFORE INSERT ON narrator_message_refs FOR EACH ROW EXECUTE FUNCTION retry_ref_fixture('${target}', '${code}')`,
					);
					const result = await narratorPersistence.persistDisplayMessage(target, `retry-${code}`);
					expect(result.seq).toBe(0);
					expect(broadcastRecipients.filter((id) => id === target)).toHaveLength(1);
					expect((await store.page(target)).rows).toHaveLength(1);
					const [state] = await client.db
						.select({
							next: narrators.nextSeq,
							count: narrators.messageCount,
							version: narrators.messageVersion,
						})
						.from(narrators)
						.where(eq(narrators.id, target));
					expect(state).toEqual({ next: 1, count: 1, version: 1 });
					const [attempts] = await client.sql.unsafe(
						"SELECT last_value::int AS value FROM ref_retry_attempts",
					);
					expect(attempts.value).toBe(2);
					const messages = await client.db
						.select({ id: narratorMessages.id })
						.from(narratorMessages)
						.where(eq(narratorMessages.narratorId, target));
					expect(messages).toHaveLength(1);
					await client.sql.unsafe("DROP TRIGGER retry_ref_fixture ON narrator_message_refs");
				}
				return "verified";
			} finally {
				bindNarratorMessageRefs(undefined);
				await client.close();
			}
		});
		expect(outcome).toBe("verified");
	},
	300_000,
);

integration(
	"PG17 existing baseline refs upgraded by complete journal continue from migrated next_seq",
	async () => {
		const outcome = await withPostgres(async ({ exec, port, credentials }) => {
			const migrations = await migrationSql();
			expect(migrations.length).toBeGreaterThan(1);
			const baseline = await exec(migrations[0]);
			expect(baseline.code, baseline.stderr).toBe(0);
			const fixture = await exec(
				`INSERT INTO narrators (id, created_at, updated_at) VALUES ('legacy', '${now}', '${now}'); INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at) VALUES ('legacy-message', 'legacy', 'user', '[]', 'legacy', '${now}'); INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('legacy-ref', 'legacy', 'legacy-message', 41);`,
			);
			expect(fixture.code, fixture.stderr).toBe(0);
			for (const migration of migrations.slice(1)) {
				const applied = await exec(migration);
				expect(applied.code, applied.stderr).toBe(0);
			}
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`,
			});
			try {
				const store = createPostgresNarratorMessageRefsPort(client.db);
				expect((await store.append(message("after-upgrade", "legacy"))).seq).toBe(42);
				await client.db
					.delete(narratorMessageRefs)
					.where(eq(narratorMessageRefs.messageId, "after-upgrade"));
				expect((await store.append(message("after-tail-removal", "legacy"))).seq).toBe(43);
				return "verified";
			} finally {
				await client.close();
			}
		});
		expect(outcome).toBe("verified");
	},
	300_000,
);
