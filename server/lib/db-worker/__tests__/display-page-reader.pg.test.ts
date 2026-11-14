import { expect, test } from "bun:test";
import { SQL } from "bun";
import { getTableColumns } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../../tests/db/pg-test-harness";
import { createPostgresClient } from "../../../db/postgres-client";
import { narratorMessages, narratorToolCalls } from "../../../db/postgres-schema";
import {
	createPostgresNarratorDisplayPagePort,
	readNarratorDisplayMessages,
} from "../../../services/narrator-display-page-reader";
import { AppError } from "../../errors";
import { DISPLAY_MESSAGE_COLUMNS, DISPLAY_TOOL_COLUMNS } from "../display-page-query";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runReadTask,
	shutdownDbWorkerPool,
} from "../pool";

const failureOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

// This test runs even without a PG container; constructor/connection failures are the
// branches most likely to accidentally expose a connection URL through ErrorEvent.
test("PG display port invalid URL/connection errors never expose credential sentinels", async () => {
	const secret = "PG_DISPLAY_SECRET_SENTINEL";
	const previous = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	await resetDbWorkerPoolForTest();
	try {
		for (const url of [`not-a-url-${secret}`, `postgres://user:${secret}@127.0.0.1:1/invalid`]) {
			const failure = await failureOf(
				readNarratorDisplayMessages(
					{ backend: "postgres", port: createPostgresNarratorDisplayPagePort(url) },
					["message"],
					{ ioBudget: 32, timeoutMs: 3000 },
				),
			);
			expect(failure).toMatchObject({ statusCode: 503, code: "DISPLAY_PAGE_READER_UNAVAILABLE" });
			expect(String((failure as Error).message)).not.toContain(secret);
			expect(String((failure as Error).stack)).not.toContain(secret);
			expect(JSON.stringify(failure)).not.toContain(secret);
		}
		const failure = await failureOf(
			runReadTask("not-a-url-PG_DISPLAY_SECRET_SENTINEL", {
				kind: "displayPageMessagesPostgres",
				messageIds: ["message"],
				ioBudget: 32,
				deadlineAt: Date.now() + 3000,
			}),
		);
		expect(failure).toMatchObject({ code: "DISPLAY_PAGE_READER_UNAVAILABLE" });
		expect(String((failure as Error).message)).not.toContain(secret);
	} finally {
		await shutdownDbWorkerPool();
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previous;
	}
}, 30_000);

(process.env.PG_INTEGRATION === "1" ? test : test.skip)(
	"shipped PG schema supports real off-main readonly display DTO, budgets, snapshot/caller-ref guard and cancellation",
	async () => {
		let callbackError: unknown;
		const previous = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
		await resetDbWorkerPoolForTest();
		try {
			const result = await withPostgres(async ({ port, credentials }) => {
				const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
				const client = createPostgresClient({ driver: "bun-sql", url, max: 1 });
				const inspector = new SQL(url, { max: 1 });
				const source = {
					backend: "postgres" as const,
					port: createPostgresNarratorDisplayPagePort(url),
				};
				const read = (
					ids = ["shared"],
					options: { signal?: AbortSignal; timeoutMs?: number; maxRawBytes?: number } = {},
				) => readNarratorDisplayMessages(source, ids, { ioBudget: 8192, ...options });
				const active = async () =>
					Number(
						(
							await inspector.unsafe(
								"SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name='narrafork-display-page-reader' AND state='active'",
							)
						)[0].count,
					);
				const waitActive = async (wanted: boolean) => {
					const end = Date.now() + 2500;
					while ((await active()) > 0 !== wanted) {
						if (Date.now() >= end)
							throw new Error("PG display statement did not reach expected active state");
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
				};
				const installView = async (delay: number, readonly = false) => {
					await client.sql.unsafe(
						"ALTER TABLE narrator_messages RENAME TO display_messages_source",
					);
					const columns = DISPLAY_MESSAGE_COLUMNS.map(({ column, field }) =>
						field === "contentJson"
							? `(SELECT m.content_json FROM pg_sleep(${delay})) AS "${column}"`
							: `m."${column}"`,
					).join(", ");
					await client.sql.unsafe(
						`CREATE VIEW narrator_messages AS SELECT ${columns} FROM display_messages_source m ${readonly ? "WHERE current_setting('transaction_read_only')='on' AND current_setting('transaction_isolation')='repeatable read'" : ""}`,
					);
				};
				const removeView = async () => {
					await client.sql.unsafe("DROP VIEW narrator_messages");
					await client.sql.unsafe(
						"ALTER TABLE display_messages_source RENAME TO narrator_messages",
					);
				};
				try {
					await migrate(client.db, { migrationsFolder: "drizzle-postgres" } as Parameters<
						typeof migrate
					>[1]);
					await client.sql.unsafe(
						"INSERT INTO narrators(id,created_at,updated_at) VALUES ('owner','now','now'),('fork','now','now'),('private','now','now')",
					);
					await client.sql.unsafe(
						"INSERT INTO users(id,username,password_hash,avatar_color,avatar_image_id,created_at) VALUES ('human','中文 Alice','PRIVATE_CREATOR_PASSWORD','indigo','avatar','now')",
					);
					await client.sql.unsafe(
						`INSERT INTO narrator_messages(id,narrator_id,parent_tool_use_id,role,content_json,created_by,created_at) VALUES ('shared','owner','inline-parent','assistant','[{"type":"text","text":"original"}]','human','now'),('private-message','private',null,'assistant','[{"type":"text","text":"PRIVATE_MESSAGE"}]',null,'now')`,
					);
					await client.sql.unsafe(
						"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('owner-ref','owner','shared',0),('fork-ref','fork','shared',3),('private-ref','private','private-message',0)",
					);
					await client.sql.unsafe(
						`INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,execution_attempt,created_at) VALUES ('old','owner','shared','use','Bash','{}',repeat('DISCARDED_BAD_JSON',1200000),'success',1,'now'),('a','owner','shared','use','Bash','{}','null','pending',10,'now'),('z','owner','shared','use','Bash','{}','{}','success',10,'now')`,
					);
					await client.sql.unsafe(
						"UPDATE narrator_tool_calls SET execution_identity_version=1,execution_origin_tool_call_id='origin',execution_segment_id='segment',execution_device_id='exact-device',execution_cwd='/真实/cwd',execution_path_flavor='posix',resolved_file_path='/真实/cwd/file',canonical_file_path='/canonical/file',runtime_generation=2,device_selection_source='explicit',is_background=true,permission_suggestions='[]',owned_paths_json='[]',cost_missing_fields='[]' WHERE id='z'",
					);
					for (const [descriptors, table] of [
						[DISPLAY_MESSAGE_COLUMNS, narratorMessages],
						[DISPLAY_TOOL_COLUMNS, narratorToolCalls],
					] as const) {
						const columns = getTableColumns(table) as Record<string, { name: string }>;
						for (const descriptor of descriptors)
							expect(descriptor.column).toBe(columns[descriptor.field].name);
					}
					const rows = await read();
					expect(rows[0].parentToolUseId).toBe("inline-parent");
					expect(rows[0].narratorId).toBe("owner");
					expect(rows[0].creator).toEqual({
						id: "human",
						username: "中文 Alice",
						avatarColor: "indigo",
						avatarImageId: "avatar",
					});
					for (const descriptor of DISPLAY_MESSAGE_COLUMNS)
						expect(Object.hasOwn(rows[0], descriptor.field)).toBe(true);
					for (const descriptor of DISPLAY_TOOL_COLUMNS)
						expect(Object.hasOwn(rows[0].toolCalls[0], descriptor.field)).toBe(true);
					expect(rows[0].toolCalls).toHaveLength(1);
					expect(rows[0].toolCalls[0]).toMatchObject({
						id: "z",
						executionAttempt: 10,
						executionIdentityVersion: 1,
						executionOriginToolCallId: "origin",
						executionSegmentId: "segment",
						isBackground: true,
						permissionSuggestions: [],
						ownedPathsJson: [],
						executionTarget: {
							deviceId: "exact-device",
							cwd: "/真实/cwd",
							canonicalPath: "/canonical/file",
							runtimeGeneration: 2,
						},
					});
					expect(JSON.stringify(rows)).not.toContain("PRIVATE_CREATOR_PASSWORD");

					const cjk = "真实PG大字段😀".repeat(100_000);
					const input = { command: "pwd", body: `PG_RAW_DISPLAY_SENTINEL${cjk}` };
					const content = [
						{
							type: "thinking",
							thinking: "",
							providerMetadata: { openai: { reasoningEncryptedContent: "cipher".repeat(100_000) } },
						},
						{ type: "tool_use", id: "use", name: "Bash", input },
					];
					await client.sql.unsafe(
						"UPDATE narrator_messages SET content_json=$1 WHERE id='shared'",
						[JSON.stringify(content)],
					);
					await client.sql.unsafe(
						"UPDATE narrator_tool_calls SET input_json=$1,output_json=$2 WHERE id='z'",
						[JSON.stringify(input), JSON.stringify({ _text: cjk, _metadata: { ok: true } })],
					);
					const originalParse = JSON.parse;
					let mainRawParses = 0;
					let beats = 0;
					JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
						if (text.length > 256 * 1024 && text.includes("PG_RAW_DISPLAY_SENTINEL")) {
							mainRawParses++;
							throw new Error("PG raw JSON parsed on main");
						}
						return originalParse(text, reviver);
					}) as typeof JSON.parse;
					const timer = setInterval(() => beats++, 1);
					try {
						const [row] = await read();
						expect((row.contentJson as Array<Record<string, unknown>>)[0].providerMetadata).toEqual(
							{ hasEncryptedReasoning: true },
						);
						expect(row.toolCalls[0].inputJson).toMatchObject({
							command: "pwd",
							body: { _truncated: true, fullLength: input.body.length },
						});
						expect(row.toolCalls[0].outputJson).toMatchObject({ _metadata: { ok: true } });
						expect(mainRawParses).toBe(0);
						expect(beats).toBeGreaterThan(0);
					} finally {
						clearInterval(timer);
						JSON.parse = originalParse;
					}
					expect(
						(await client.sql.unsafe("SELECT input_json FROM narrator_tool_calls WHERE id='z'"))[0]
							.input_json,
					).toBe(JSON.stringify(input));
					expect(await failureOf(read(["shared"], { maxRawBytes: 4 * 1024 * 1024 }))).toMatchObject(
						{ statusCode: 413 },
					);
					await client.sql.unsafe(
						"UPDATE narrator_tool_calls SET input_json=repeat('中',6000000) WHERE id='z'",
					);
					expect(await failureOf(read())).toMatchObject({
						statusCode: 413,
						code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
					});
					await client.sql.unsafe(
						"UPDATE narrator_tool_calls SET input_json=$1,output_json='null' WHERE id='z'",
						[JSON.stringify({ dense: Array.from({ length: 17_000 }, () => false) })],
					);
					expect(await failureOf(read())).toMatchObject({
						statusCode: 413,
						code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
					});
					await client.sql.unsafe(
						"UPDATE narrator_tool_calls SET input_json='{}',output_json='null' WHERE id='z'",
					);
					await client.sql.unsafe(
						"UPDATE narrator_messages SET content_json=$1 WHERE id='shared'",
						[JSON.stringify([{ type: "text", text: "中".repeat(1_500_000) }])],
					);
					expect(await failureOf(read())).toMatchObject({
						statusCode: 413,
						code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
					});
					await client.sql.unsafe(
						"UPDATE narrator_messages SET content_json='[]' WHERE id='shared'",
					);
					await installView(0, true);
					expect(await read()).toHaveLength(1); // View admits ONLY real readonly/repeatable-read transactions.
					await removeView();

					// Caller authorization is a separate bounded metadata stage; the worker never
					// guesses a caller narrator from the canonical message's original owner.
					const refs = async () =>
						(await client.sql.unsafe(
							"SELECT message_id,seq FROM narrator_message_refs WHERE narrator_id='fork' AND segment_compact_id IS NULL ORDER BY seq LIMIT 501",
						)) as Array<{ message_id: string; seq: number }>;
					const before = await refs();
					expect(before).toEqual([{ message_id: "shared", seq: 3 }]);
					const authorized = await read(before.map((row) => row.message_id));
					expect(authorized.map((row) => row.id)).toEqual(["shared"]);
					expect(JSON.stringify(authorized)).not.toContain("PRIVATE_MESSAGE");
					await installView(0.2);
					const inFlight = read(before.map((row) => row.message_id));
					await waitActive(true);
					await client.sql.unsafe("UPDATE narrator_message_refs SET seq=4 WHERE id='fork-ref'");
					await inFlight;
					const after = await refs();
					const callerGuard = () => {
						if (
							after.some(
								(row, index) =>
									row.message_id !== before[index]?.message_id || row.seq !== before[index]?.seq,
							)
						)
							throw new AppError("History refs changed", 409, "HISTORY_AGGREGATE_UNAVAILABLE");
					};
					expect(callerGuard).toThrow("History refs changed");
					await removeView();

					await installView(10);
					const controller = new AbortController();
					const cancelling = failureOf(read(["shared"], { signal: controller.signal }));
					await waitActive(true);
					expect(getDbWorkerPoolStats().busy).toBe(1);
					controller.abort();
					expect(await cancelling).toMatchObject({
						statusCode: 499,
						code: "DISPLAY_PAGE_CANCELLED",
					});
					await waitActive(false); // Actual remote SQL stopped, not just HTTP detached.
					await removeView();
					expect(await read()).toHaveLength(1);
					await installView(10);
					expect(await failureOf(read(["shared"], { timeoutMs: 100 }))).toMatchObject({
						statusCode: 504,
						code: "DISPLAY_PAGE_DEADLINE",
					});
					await waitActive(false);
					await removeView();
					expect(await read()).toHaveLength(1);
					await client.sql.unsafe("ALTER TABLE narrator_tool_calls DROP COLUMN model_revision");
					const unsupported = await failureOf(read());
					expect(unsupported).toMatchObject({
						statusCode: 503,
						code: "DISPLAY_PAGE_READER_UNAVAILABLE",
					});
					expect(String((unsupported as Error).message)).not.toContain(credentials.password);
					return { status: "verified" as const };
				} catch (error) {
					callbackError = error;
					throw error;
				} finally {
					await client.close();
					await inspector.close();
				}
			});
			if (callbackError) throw callbackError;
			expect(result.status).toBe("verified");
		} finally {
			await shutdownDbWorkerPool();
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
			else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previous;
		}
	},
	120_000,
);
