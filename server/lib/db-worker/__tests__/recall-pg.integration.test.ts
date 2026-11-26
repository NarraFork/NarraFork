import { expect, spyOn, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../../tests/db/pg-test-harness";
import type { PgExecutor } from "../../../db/pg-fts";
import { createPostgresClient } from "../../../db/postgres-client";
import { readRecallMessagePg } from "../recall-pg-message-reader";
import { runRecallPgProjection } from "../recall-pg-projection-client";
import { type RecallConversationInput, recallConversationQueries } from "../recall-reader";
import { readRecallToolCallPagePg } from "../recall-tool-page";

const failureOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

(process.env.PG_INTEGRATION === "1" ? test : test.skip)(
	"real PG TEXT escaped NUL is projected off-main without loss, including inherited refs and Ask evidence",
	async () => {
		let callbackError: unknown;
		const result = await withPostgres(async ({ port, credentials }) => {
			console.info(`Recall PG disposable fixture port: ${port}`);
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
			const client = createPostgresClient({ driver: "bun-sql", url, max: 1 });
			const calls: string[] = [];
			const executor: PgExecutor = {
				unsafe: async (sql, params) => {
					calls.push(sql);
					return await client.sql.unsafe(sql, params as never);
				},
			};
			const read = (messageId: string, offset = 0, maxChars = 20000) =>
				readRecallMessagePg(executor, { narratorId: "fork", messageId, offset, maxChars });
			try {
				await migrate(client.db, { migrationsFolder: "drizzle-postgres" } as Parameters<
					typeof migrate
				>[1]);
				await client.sql.unsafe(
					"INSERT INTO narrators(id,created_at,updated_at) VALUES ('owner','now','now'),('private','now','now')",
				);
				await client.sql.unsafe(
					"INSERT INTO narrators(id,refs_inherited_from,refs_backfill_cursor,created_at,updated_at) VALUES ('fork','owner',10,'now','now')",
				);
				// The shipped compact_pending generated column independently casts TEXT to jsonb
				// on writes. Disable only that expression in this disposable fixture so legacy /
				// imported raw TEXT (including malformed JSON) can exercise the reader boundary.
				// This regression does not claim to fix PostgreSQL's separate write-path limit.
				await client.sql.unsafe(
					"ALTER TABLE narrator_messages ALTER COLUMN compact_pending DROP EXPRESSION",
				);
				const bodies = [
					[
						"omitted",
						JSON.stringify([
							{ type: "text", text: "original😄" },
							{ type: "image", source: { data: "PG_INTEGRATION_NUL_SENTINEL\0" } },
						]),
					],
					[
						"visible",
						JSON.stringify([
							{ type: "text", text: "A\0😄B" },
							{
								type: "system_injection",
								modelText: "native\0",
								body: { hidden: "PG_INTEGRATION_NUL_SENTINEL\0" },
							},
						]),
					],
					["invalid", "invalid json"],
					["nonarray", "{}"],
				] as const;
				for (let index = 0; index < bodies.length; index++) {
					const [id, raw] = bodies[index];
					await client.sql.unsafe(
						"INSERT INTO narrator_messages(id,narrator_id,role,content_json,origin_label,created_at) VALUES ($1,'owner','assistant',$2,'PRIVATE_ORIGIN_LABEL','now')",
						[id, raw],
					);
					await client.sql.unsafe(
						"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ($1,'owner',$2,$3)",
						[`ref-${id}`, id, index],
					);
				}
				await client.sql.unsafe(
					"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES ('oversized','owner','assistant',repeat('x',41943041),'now'),('not-visible','private','assistant','[]','now')",
				);
				await client.sql.unsafe(
					"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('over-ref','owner','oversized',5),('private-ref','private','not-visible',0)",
				);
				// Reproduce the exact PostgreSQL jsonb limitation on the shipped TEXT column.
				expect(
					await failureOf(
						client.sql.unsafe(
							"SELECT content_json::jsonb FROM narrator_messages WHERE id='omitted'",
						),
					),
				).toBeInstanceOf(Error);
				const parse = JSON.parse;
				let mainParses = 0;
				const parseSpy = spyOn(JSON, "parse").mockImplementation(
					(raw: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
						if (raw.includes("PG_INTEGRATION_NUL_SENTINEL")) mainParses++;
						return parse(raw, reviver);
					},
				);
				try {
					const omitted = await read("omitted");
					expect(omitted).toMatchObject({
						narratorId: "fork",
						text: "original😄",
						seq: 0,
						omittedBlocks: ["image"],
					});
					expect(omitted).not.toHaveProperty("originLabel");
					expect(JSON.stringify(omitted)).not.toContain("PRIVATE_ORIGIN_LABEL");
					expect(await read("visible", 1, 2)).toMatchObject({
						text: "\0😄",
						offset: 1,
						totalChars: 12,
						nextOffset: 3,
						hasMore: true,
					});
					expect(await read("visible", Number.MAX_SAFE_INTEGER)).toMatchObject({
						text: "",
						totalChars: 12,
						nextOffset: null,
						hasMore: false,
					});
					expect(await read("not-visible")).toBeNull();
					for (const id of ["invalid", "nonarray"])
						expect(await failureOf(read(id))).toMatchObject({ code: "DB_READ_PROTOCOL" });
					expect(await failureOf(read("oversized"))).toMatchObject({ code: "DB_READ_BUDGET" });
					expect(mainParses).toBe(0);
				} finally {
					parseSpy.mockRestore();
				}
				const ask = JSON.stringify({
					questions: [{ header: "选择\0😄", question: "exact\0question" }],
					answers: { key: "answer\0😄" },
				});
				await client.sql.unsafe(
					"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,created_at) VALUES ('ask','fork','visible','ask-use','AskUserQuestion',$1,$2,'success','now')",
					[ask, "output\0literal".replace("\0", "\\u0000")],
				);
				const legacyAskExtraction = await failureOf(
					client.sql.unsafe(
						"SELECT (input_json::json -> 'questions')::text FROM narrator_tool_calls WHERE id='ask'",
					),
				);
				expect(legacyAskExtraction).toBeInstanceOf(Error);
				const tool = await readRecallToolCallPagePg(executor, {
					narratorId: "fork",
					toolCallId: "ask-use",
					part: "both",
					offset: 0,
					maxChars: 20000,
				});
				const metadata = tool?.metadata as {
					question: { questions: { text: string }; answers: { text: string } };
					pages: { input: { text: string } };
				};
				expect(metadata.pages.input.text).toBe(ask);
				expect(JSON.parse(metadata.question.questions.text)).toEqual([
					{ header: "选择\0😄", question: "exact\0question" },
				]);
				expect(JSON.parse(metadata.question.answers.text)).toEqual({ key: "answer\0😄" });
				await client.sql.unsafe(
					"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES ('tie','fork','user','[]','now')",
				);
				await client.sql.unsafe(
					"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('tie-own','fork','tie',1)",
				);
				const conversation = async (options: Partial<RecallConversationInput>) => {
					const plan = recallConversationQueries(
						{ narratorId: "fork", messageId: null, limit: 1, ...options },
						true,
					);
					let step = plan.next();
					while (!step.done) {
						const query = step.value;
						const rows = query.sql.includes("recall_summary_input")
							? await runRecallPgProjection<Record<string, unknown>[]>(async () => ({
									kind: "summaries",
									rows: await executor.unsafe(query.sql, query.params),
								}))
							: await executor.unsafe(query.sql, query.params);
						step = plan.next(rows ?? []);
					}
					return step.value;
				};
				const around = await conversation({
					messageId: "visible",
					direction: "around",
					includeToolCalls: true,
				});
				expect(around.rows.map((row) => row.id)).toEqual(["visible"]);
				expect(around.pagination.olderCursor).toEqual({ seq: 1, messageId: "visible" });
				expect(around.tools[0]?.summary).toBe("选择\0😄");
				const older = await conversation({
					direction: "older",
					cursor: { seq: 1, messageId: "visible" },
				});
				expect(older.rows.map((row) => row.id)).toEqual(["tie"]);
				const newer = await conversation({
					direction: "newer",
					cursor: older.pagination.newerCursor ?? undefined,
				});
				expect(newer.rows.map((row) => row.id)).toEqual(["visible"]);
				expect(calls.every((sql) => !/::jsonb?\b/.test(sql))).toBe(true);
				expect(calls.every((sql) => !sql.includes("origin_label"))).toBe(true);
				// Exact race: capture B -> A, then B materializes its old prefix and clears
				// the pointer before A COW-replaces the same seq with a future/private m2.
				await client.sql.unsafe(
					"INSERT INTO narrators(id,created_at,updated_at) VALUES ('race-owner','now','now')",
				);
				await client.sql.unsafe(
					"INSERT INTO narrators(id,refs_inherited_from,refs_backfill_cursor,created_at,updated_at) VALUES ('race-fork','race-owner',2,'now','now')",
				);
				await client.sql.unsafe(
					"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES ('race-m1','race-owner','assistant',$1,'now'),('race-m2','race-owner','assistant',$2,'now')",
					[
						JSON.stringify([{ type: "text", text: "old m1\0😄" }]),
						JSON.stringify([{ type: "text", text: "ANCESTOR_COW_PRIVATE_M2" }]),
					],
				);
				await client.sql.unsafe(
					"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('race-owner-ref','race-owner','race-m1',0)",
				);
				const raceInput = {
					narratorId: "race-fork",
					messageId: "race-m1",
					offset: 0,
					maxChars: 20000,
				};
				expect(await readRecallMessagePg(executor, raceInput)).toMatchObject({
					messageId: "race-m1",
					text: "old m1\0😄",
				});
				let mutated = false;
				const bodyEnvelopes: Record<string, unknown>[][] = [];
				const racingExecutor: PgExecutor = {
					unsafe: async (sql, params) => {
						const rows = await executor.unsafe(sql, params);
						if (sql.startsWith("WITH RECURSIVE lineage") && !mutated) {
							await client.sql.begin(async (transaction) => {
								await transaction.unsafe(
									"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) SELECT 'race-fork-ref','race-fork',message_id,seq FROM narrator_message_refs WHERE id='race-owner-ref'",
								);
								await transaction.unsafe(
									"UPDATE narrators SET refs_inherited_from=NULL,refs_backfill_cursor=NULL WHERE id='race-fork'",
								);
								await transaction.unsafe(
									"UPDATE narrator_message_refs SET message_id='race-m2' WHERE id='race-owner-ref'",
								);
							});
							mutated = true;
						}
						if (sql.includes("recall_body AS MATERIALIZED")) bodyEnvelopes.push(rows);
						return rows;
					},
				};
				const changed = await failureOf(
					readRecallMessagePg(racingExecutor, { ...raceInput, messageId: "race-m2" }),
				);
				expect(mutated).toBe(true);
				expect(changed).toMatchObject({ code: "DB_READ_PROTOCOL" });
				expect(String((changed as Error).message)).toContain("lineage changed");
				expect(bodyEnvelopes).toHaveLength(1);
				expect(bodyEnvelopes[0][0]).toMatchObject({
					recall_lineage_valid: false,
					recall_row_present: null,
				});
				expect(JSON.stringify(bodyEnvelopes)).not.toContain("ANCESTOR_COW_PRIVATE_M2");
				expect(await readRecallMessagePg(executor, raceInput)).toMatchObject({
					messageId: "race-m1",
					text: "old m1\0😄",
				});
				expect(
					await readRecallMessagePg(executor, { ...raceInput, messageId: "race-m2" }),
				).toBeNull();
				const params = { narratorId: "fork", messageId: "visible", offset: 0, maxChars: 20 };
				expect(
					await failureOf(readRecallMessagePg(executor, params, AbortSignal.abort())),
				).toBeInstanceOf(Error);
				expect(
					await failureOf(readRecallMessagePg(executor, params, undefined, Date.now() - 1)),
				).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
				return { status: "verified" as const, port };
			} catch (error) {
				callbackError = error;
				throw error;
			} finally {
				await client.close();
			}
		});
		if (callbackError) throw callbackError;
		expect(result.status).toBe("verified");
	},
	120000,
);
