import { expect, mock, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { createPostgresClient } from "../../db/postgres-client";
import { modelHistoryFixtureSql } from "./model-history-fixture";
import { readPostgresModelHistorySignature } from "./model-history-revision";
import { renderModelHistoryRevisionSql } from "./model-history-revision-sql";
import {
	clearModelHistorySourceCacheForTest,
	loadModelHistorySource,
	modelHistorySourceStats,
} from "./model-history-source";

function deferredSignatureQuery() {
	let resolve!: (rows: unknown[]) => void;
	let reject!: (error: Error) => void;
	const cancel = mock(() => {});
	const pending = Object.assign(
		new Promise<unknown[]>((accept, fail) => {
			resolve = accept;
			reject = fail;
		}),
		{ cancel },
	);
	const unsafe = mock(() => pending);
	return { sql: { unsafe } as unknown as Pick<SQL, "unsafe">, unsafe, cancel, resolve, reject };
}

test("PG signature remains pending beyond ten seconds and accepts the eventual result", async () => {
	const query = deferredSignatureQuery();
	const controller = new AbortController();
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const timers = spyOn(globalThis, "setTimeout");
	try {
		const signature = readPostgresModelHistorySignature(query.sql, "owner", {
			signal: controller.signal,
		});
		now += 11_000;
		await Promise.resolve();
		// A wall-clock jump alone cannot fire a real timer: assert that no timer was
		// scheduled either, so the test also covers the former Promise.race timeout.
		expect(timers).not.toHaveBeenCalled();
		expect(query.cancel).not.toHaveBeenCalled();
		query.resolve([{ revision: "42", catalogIdentity: "catalog" }]);
		expect((await signature).revision).toBe("42");
		controller.abort();
		expect(query.cancel).not.toHaveBeenCalled();
	} finally {
		timers.mockRestore();
		clock.mockRestore();
	}
});

test("PG signature cancellation cancels the pending SQL even if the driver never settles", async () => {
	const query = deferredSignatureQuery();
	const controller = new AbortController();
	const signature = readPostgresModelHistorySignature(query.sql, "owner", {
		signal: controller.signal,
	});
	controller.abort();
	await expect(signature).rejects.toThrow("Model history preparation cancelled");
	expect(query.cancel).toHaveBeenCalledTimes(1);
	query.reject(new Error("late driver cancellation"));
	await Promise.resolve();
});

test("PG signature pre-cancellation skips SQL and driver failures stay sanitized", async () => {
	const cancelled = deferredSignatureQuery();
	await expect(
		readPostgresModelHistorySignature(cancelled.sql, "owner", {
			signal: AbortSignal.abort(new Error("already cancelled")),
		}),
	).rejects.toThrow("already cancelled");
	expect(cancelled.unsafe).not.toHaveBeenCalled();
	const failed = deferredSignatureQuery();
	const signature = readPostgresModelHistorySignature(failed.sql, "owner");
	failed.reject(new Error("postgres://private:secret@host"));
	await expect(signature).rejects.toThrow("Model history PostgreSQL signature failed");
});

(process.env.PG_INTEGRATION === "1" ? test : test.skip)(
	"PG persistent revisions and source cache invalidate across independent connections/shared holders",
	async () => {
		let callbackError: unknown;
		const result = await withPostgres(async ({ port, credentials }) => {
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
			const first = new SQL(url, { max: 1 });
			const second = new SQL(url, { max: 1 });
			try {
				for (const statement of modelHistoryFixtureSql.split(";"))
					if (statement.trim()) await first.unsafe(statement);
				for (const statement of renderModelHistoryRevisionSql("postgres").split(
					"--> statement-breakpoint",
				))
					await first.unsafe(statement);
				await first.unsafe(
					"INSERT INTO narrators (id,title) VALUES ('owner','Owner'),('fork','Fork')",
				);
				await first.unsafe("INSERT INTO users (id,username) VALUES ('human','Alice')");
				await first.unsafe(
					`INSERT INTO narrator_messages (id,narrator_id,role,content_json,content_text,created_by) VALUES ('shared','owner','user','[{"type":"text","text":"original"}]','original','human')`,
				);
				await first.unsafe(
					"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('owner-ref','owner','shared',0),('fork-ref','fork','shared',0)",
				);
				await first.unsafe(
					`INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,execution_attempt,created_at) VALUES ('tool','owner','shared','use','Read','{}','null','pending',1,'now')`,
				);
				const signature = () => readPostgresModelHistorySignature(first, "fork");
				expect((await signature()).trusted).toBe(true);
				const backend = { backend: "postgres" as const, sql: first, url };
				const original = await loadModelHistorySource(backend, "fork");
				expect(await loadModelHistorySource(backend, "fork")).toBe(original);
				const reloaded = await import(`./model-history-source.ts?pg-hot=${Date.now()}`);
				const reevaluated = await reloaded.loadModelHistorySource(backend, "fork");
				expect(reevaluated).not.toBe(original);
				expect(reevaluated.messages).toEqual(original.messages);
				expect(reevaluated.counters.reusedBodies ?? 0).toBe(0);
				expect(await reloaded.loadModelHistorySource(backend, "fork")).toBe(reevaluated);
				for (const mutation of [
					`UPDATE narrator_messages SET content_json='[{"type":"text","text":"body edit"}]' WHERE id='shared'`,
					"UPDATE narrator_messages SET sdk_message_uuid='final-uuid' WHERE id='shared'",
					`UPDATE narrator_tool_calls SET input_json='{"path":"new"}',output_json='"result"',status='success',execution_attempt=2 WHERE id='tool'`,
					"UPDATE narrator_tool_calls SET created_at='later' WHERE id='tool'",
					"UPDATE users SET username='Bob' WHERE id='human'",
					"UPDATE narrators SET title='Renamed' WHERE id='owner'",
				]) {
					const before = await signature();
					await second.unsafe(mutation);
					expect((await signature()).revision).not.toBe(before.revision);
				}
				const changed = await loadModelHistorySource(backend, "fork");
				expect(changed).not.toBe(reevaluated);
				expect(changed.messages[0].messageUuid).toBe("final-uuid");
				expect(changed.messages[0].toolCalls[0].executionAttempt).toBe(2);
				expect(changed.messages[0].creator?.username).toBe("Bob");
				await second.unsafe("UPDATE narrator_messages SET tokens_in=123 WHERE id='shared'");
				await second.unsafe("UPDATE narrator_tool_calls SET input_tokens=123 WHERE id='tool'");
				expect(await loadModelHistorySource(backend, "fork")).toBe(changed);
				await second.unsafe("CREATE SCHEMA other_tenant");
				for (const [kind, table] of [
					["message", "narrator_messages"],
					["tool", "narrator_tool_calls"],
					["ref", "narrator_message_refs"],
					["sender", "users"],
					["narrator", "narrators"],
				]) {
					await second.unsafe(`CREATE TABLE other_tenant.${table} (LIKE public.${table})`);
					await second.unsafe(
						`CREATE TRIGGER model_history_v3_${kind} BEFORE UPDATE ON other_tenant.${table} FOR EACH ROW EXECUTE FUNCTION public.model_history_v3_${kind}()`,
					);
				}
				expect((await signature()).trusted).toBe(true);
				expect(await loadModelHistorySource(backend, "fork")).toBe(changed);
				await second.unsafe(
					"ALTER TABLE narrator_tool_calls DISABLE TRIGGER model_history_v3_tool",
				);
				expect((await signature()).trusted).toBe(false);
				const hits = modelHistorySourceStats().hits;
				expect(await loadModelHistorySource(backend, "fork")).not.toBe(changed);
				expect(modelHistorySourceStats().hits).toBe(hits);
				const disabledRevision = (await signature()).revision;
				await second.unsafe(
					`UPDATE narrator_tool_calls SET output_json='"disabled result"' WHERE id='tool'`,
				);
				expect((await signature()).revision).toBe(disabledRevision);
				await second.unsafe("ALTER TABLE narrator_tool_calls ENABLE TRIGGER model_history_v3_tool");
				const restored = await loadModelHistorySource(backend, "fork");
				expect(restored.counters.reusedBodies ?? 0).toBe(0);
				expect(restored.messages[0].toolCalls[0].outputJson).toBe("disabled result");
				for (const assignment of ["seq=2", "is_compact=1", "segment_compact_id='compact'"]) {
					const before = await signature();
					await second.unsafe(`UPDATE narrator_message_refs SET ${assignment} WHERE id='fork-ref'`);
					expect((await signature()).revision).not.toBe(before.revision);
				}
				const before = await signature();
				try {
					await second.begin(async (tx) => {
						await tx.unsafe(
							"UPDATE narrator_messages SET sdk_message_uuid='rollback' WHERE id='shared'",
						);
						throw new Error("rollback");
					});
				} catch {}
				expect((await signature()).revision).toBe(before.revision);
				await second.unsafe("DROP TRIGGER model_history_v3_tool ON narrator_tool_calls");
				expect((await signature()).trusted).toBe(false);
				return { status: "verified" as const };
			} catch (error) {
				callbackError = error;
				throw error;
			} finally {
				clearModelHistorySourceCacheForTest();
				await first.close();
				await second.close();
			}
		});
		if (callbackError) throw callbackError;
		expect(result.status).toBe("verified");
	},
	120_000,
);

(process.env.PG_INTEGRATION === "1" ? test : test.skip)(
	"shipped PostgreSQL migration installs the complete readonly-worker/shared-holder contract",
	async () => {
		let callbackError: unknown;
		const result = await withPostgres(async ({ port, credentials }) => {
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
			const client = createPostgresClient({ driver: "bun-sql", url, max: 1 });
			const second = new SQL(url, { max: 1 });
			try {
				await migrate(client.db, { migrationsFolder: "drizzle-postgres" } as Parameters<
					typeof migrate
				>[1]);
				await client.sql.unsafe(
					"INSERT INTO narrators (id,created_at,updated_at) VALUES ('owner','now','now'),('fork','now','now')",
				);
				await client.sql.unsafe(
					`INSERT INTO narrator_messages (id,narrator_id,role,content_json,content_text,created_at) VALUES ('shared','owner','assistant','[{"type":"text","text":"original"}]','original','now')`,
				);
				await client.sql.unsafe(
					"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('owner-ref','owner','shared',0),('fork-ref','fork','shared',0)",
				);
				await client.sql.unsafe(
					`INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,execution_attempt,created_at) VALUES ('tool','owner','shared','use','Read','{}','null','pending',1,'now')`,
				);
				expect((await readPostgresModelHistorySignature(client.sql, "fork")).trusted).toBe(true);
				const backend = { backend: "postgres" as const, sql: client.sql, url };
				const original = await loadModelHistorySource(backend, "fork");
				expect(await loadModelHistorySource(backend, "fork")).toBe(original);
				await second.unsafe(
					`UPDATE narrator_messages SET sdk_message_uuid='final',content_json='[{"type":"text","text":"edited"}]' WHERE id='shared'`,
				);
				await second.unsafe(
					`UPDATE narrator_tool_calls SET execution_attempt=2,status='success',output_json='"result"' WHERE id='tool'`,
				);
				const edited = await loadModelHistorySource(backend, "fork");
				expect(edited).not.toBe(original);
				expect(edited.messages[0].messageUuid).toBe("final");
				expect(edited.messages[0].toolCalls[0].outputJson).toBe("result");
				expect(
					(
						await client.sql.unsafe("SELECT body_revision FROM narrator_messages WHERE id='shared'")
					)[0].body_revision,
				).toBe(2);
				expect(
					(
						await client.sql.unsafe(
							"SELECT model_revision FROM narrator_tool_calls WHERE id='tool'",
						)
					)[0].model_revision,
				).toBe(2);
				await second.unsafe("UPDATE narrator_messages SET tokens_in=12 WHERE id='shared'");
				expect(await loadModelHistorySource(backend, "fork")).toBe(edited);
				return { status: "verified" as const };
			} catch (error) {
				callbackError = error;
				throw error;
			} finally {
				clearModelHistorySourceCacheForTest();
				await client.close();
				await second.close();
			}
		});
		if (callbackError) throw callbackError;
		expect(result.status).toBe("verified");
	},
	120_000,
);
