import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { narrators } from "../../db/schema";
import * as pool from "../../lib/db-worker/pool";
import {
	captureWorkerRejection,
	getNarratorWorkerTestDb,
} from "../__tests__/narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const realDb = { ...(await import("../../db")) };
const sqliteDb = {
	...realDb,
	db: fixture.db,
	sqlite: fixture.sqlite,
	activeDatabaseBackend: "sqlite",
};
mock.module("../../db", () => sqliteDb);
const { recallConversation, recallToolCallDetail, recallMessage, recallToolCallPage } =
	await import("./recall-store");
afterEach(() => {
	mock.restore();
	mock.module("../../db", () => sqliteDb);
});
afterAll(async () => {
	await fixture.close();
	mock.module("../../db", () => realDb);
});

test("recall store reads committed SQLite rows and misses without owning-thread SQL", async () => {
	await fixture.db.insert(narrators).values({
		id: "recall-store",
		title: "Recall store",
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	});
	const prepare = spyOn(fixture.sqlite, "prepare");
	const query = spyOn(fixture.sqlite, "query");
	expect(
		(await recallConversation({ narratorId: "recall-store", messageId: null, limit: 5 })).narrator
			?.title,
	).toBe("Recall store");
	expect(await recallConversation({ narratorId: "missing", messageId: null, limit: 5 })).toEqual({
		narrator: null,
		messageMissing: false,
		rows: [],
		tools: [],
		pagination: { hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null },
	});
	expect(await recallToolCallDetail({ toolCallId: "missing", narratorId: null })).toBeNull();
	expect(
		await recallMessage({
			narratorId: "recall-store",
			messageId: "missing",
			offset: 0,
			maxChars: 10,
		}),
	).toBeNull();
	expect(
		await recallToolCallPage({
			toolCallId: "missing",
			narratorId: null,
			part: "both",
			offset: 0,
			maxChars: 10,
		}),
	).toBeNull();
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});

for (const fault of ["spawn", "crash", "timeout", "disabled", "cancelled", "deadline"] as const) {
	test(`recall store propagates ${fault} without inline retry`, async () => {
		const previous = process.env.NARRAFORK_DB_WORKER;
		if (fault === "disabled") process.env.NARRAFORK_DB_WORKER = "off";
		const error =
			fault === "spawn"
				? new pool.WorkersUnavailableError("spawn failed")
				: fault === "timeout"
					? new pool.DbReadTaskTimeoutError("timed out")
					: new Error("worker crashed");
		if (["spawn", "crash", "timeout"].includes(fault))
			spyOn(pool, "runReadTask").mockRejectedValue(error);
		const prepare = spyOn(fixture.sqlite, "prepare"),
			query = spyOn(fixture.sqlite, "query");
		const options = {
			signal: fault === "cancelled" ? AbortSignal.abort() : undefined,
			deadlineAt: fault === "deadline" ? Date.now() - 1 : Date.now() + 30_000,
		};
		try {
			for (const work of [
				() =>
					recallMessage(
						{ narratorId: "recall-store", messageId: "missing", offset: 0, maxChars: 10 },
						undefined,
						options,
					),
				() =>
					recallToolCallPage(
						{ toolCallId: "missing", narratorId: null, part: "both", offset: 0, maxChars: 10 },
						undefined,
						options,
					),
				() => recallToolCallDetail({ toolCallId: "missing", narratorId: null }, undefined, options),
				() =>
					recallConversation(
						{ narratorId: "recall-store", messageId: null, limit: 5 },
						undefined,
						options,
					),
			])
				expect(await captureWorkerRejection(work())).toBeInstanceOf(Error);
			expect(prepare).not.toHaveBeenCalled();
			expect(query).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
	});
}

function pgMock(read: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) {
	return mock(async (sql: string, params: unknown[]) => {
		const rows = await read(sql, params);
		if (!sql.includes("recall_marked_results")) return rows;
		return rows.length
			? rows.map((row) => ({ recall_lineage_valid: true, recall_row_present: 1, ...row }))
			: [{ recall_lineage_valid: true, recall_row_present: null }];
	});
}

test("PG conversation uses shared filter-before-limit plan and normalized page metadata", async () => {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const unsafe = pgMock(async (sql: string, params: unknown[]) => {
		calls.push({ sql, params });
		if (sql.startsWith("WITH RECURSIVE lineage"))
			return [{ id: "pg", refs_inherited_from: null, refs_backfill_cursor: null }];
		if (sql.includes("FROM narrators WHERE"))
			return [{ id: "pg", title: "PG", model: "model", source_bytes: 7 }];
		if (sql.includes("SELECT 1 FROM effective_recall_refs"))
			return sql.includes("(r.seq, m.id) <") ? [{}] : [];
		return [
			{
				id: "m",
				role: "user",
				origin: null,
				content_prefix: "原文😄",
				truncated: false,
				created_at: "2026",
				seq: "400",
			},
		];
	});
	mock.module("../../db", () => ({
		...sqliteDb,
		activeDatabaseBackend: "postgres",
		postgresRuntime: { closed: false, executor: { unsafe } },
	}));
	const result = await recallConversation({
		narratorId: "pg",
		messageId: null,
		limit: 1,
		roles: ["user"],
		origins: ["unknown"],
		createdFrom: "2026-01-01",
		cursor: 500,
	});
	expect(result.rows[0]).toMatchObject({ seq: 400, origin: null, content_text: "原文😄" });
	expect(result.pagination).toEqual({
		hasOlder: true,
		hasNewer: false,
		olderCursor: { seq: 400, messageId: "m" },
		newerCursor: { seq: 400, messageId: "m" },
	});
	const select = calls.find((call) => call.sql.includes("content_prefix"));
	expect(select?.sql).toContain("m.role IN ($5)");
	expect(select?.sql).toContain("m.origin IS NULL");
	expect(select?.sql).toContain("m.created_at >= $6");
	expect(select?.sql).toContain("r.seq < $7 ORDER BY r.seq DESC, m.id DESC LIMIT $8");
	expect(select?.params).toEqual(["pg", null, null, null, "user", "2026-01-01", 500, 1]);
	expect(calls.every((call) => !call.sql.includes("narrator_tool_calls"))).toBe(true);
});

test("PG tool summaries are fetched in 128-row keyset batches with bounded Ask headers", async () => {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	let batches = 0;
	const unsafe = pgMock(async (sql: string, params: unknown[]) => {
		calls.push({ sql, params });
		if (sql.startsWith("WITH RECURSIVE lineage"))
			return [{ id: "pg", refs_inherited_from: null, refs_backfill_cursor: null }];
		if (sql.includes("FROM narrators WHERE"))
			return [{ id: "pg", title: "PG", model: "model", source_bytes: 7 }];
		if (sql.includes("SELECT 1 FROM effective_recall_refs")) return [];
		if (sql.includes("content_prefix"))
			return [
				{
					id: "m",
					role: "assistant",
					origin: null,
					content_prefix: "page",
					truncated: false,
					created_at: "2026",
					seq: 1,
				},
			];
		if (sql.includes("count(*) AS count"))
			return [{ count: 129, bytes: 1024, max_metadata_bytes: 20 }];
		const start = batches++ * 128;
		return Array.from({ length: start === 0 ? 128 : 1 }, (_, i) => ({
			id: `t${String(start + i).padStart(3, "0")}`,
			created_at: "2026",
			tool_use_id: `use${start + i}`,
			tool_name: "AskUserQuestion",
			status: "success",
			message_id: "m",
			recall_summary_input: JSON.stringify({ questions: [{ header: "选择方案" }] }),
			recall_summary_oversized: false,
		}));
	});
	mock.module("../../db", () => ({
		...sqliteDb,
		activeDatabaseBackend: "postgres",
		postgresRuntime: { closed: false, executor: { unsafe } },
	}));
	const result = await recallConversation({
		narratorId: "pg",
		messageId: null,
		limit: 1,
		includeToolCalls: true,
	});
	expect(result.tools).toHaveLength(129);
	expect(result.tools.every((tool) => tool.summary === "选择方案")).toBe(true);
	const toolReads = calls.filter((call) => call.sql.includes("recall_summary_input"));
	expect(toolReads).toHaveLength(2);
	for (const call of toolReads) {
		expect(call.sql).toContain("LIMIT 128");
		expect(call.sql).not.toContain("::json");
		expect(call.sql).toContain("recall_summary_oversized");
	}
	expect(toolReads[1].params.slice(-2)).toEqual(["2026", "t127"]);
});

test("PG message sends bounded raw TEXT to its Worker without JSON casts or origin labels", async () => {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const unsafe = pgMock(async (sql: string, params: unknown[]) => {
		calls.push({ sql, params });
		if (sql.startsWith("WITH RECURSIVE lineage"))
			return [{ id: "pg", refs_inherited_from: null, refs_backfill_cursor: null }];
		if (sql.includes("recall_body AS MATERIALIZED"))
			return [
				{
					messageId: "m",
					narratorId: "pg",
					narratorTitle: "PG",
					role: "user",
					origin: "user",
					originLabel: null,
					createdAt: "2026",
					seq: "20",
					bodyRevision: "3",
					contentJson: JSON.stringify([
						{ type: "text", text: "前缀原文😄后面的尾巴" },
						{ type: "image", data: "omitted\0" },
					]),
					bytes: 100,
					metadata_bytes: 50,
				},
			];
		return [];
	});
	mock.module("../../db", () => ({
		...sqliteDb,
		activeDatabaseBackend: "postgres",
		postgresRuntime: { closed: false, executor: { unsafe } },
	}));
	const result = await recallMessage({ narratorId: "pg", messageId: "m", offset: 2, maxChars: 3 });
	expect(result).toMatchObject({
		text: "原文😄",
		offset: 2,
		totalChars: 10,
		nextOffset: 5,
		hasMore: true,
		seq: 20,
		bodyRevision: 3,
		omittedBlocks: ["image"],
	});
	const body = calls.find((call) => call.sql.includes("recall_body AS MATERIALIZED"));
	expect(body?.sql).toContain('m.content_json AS "contentJson"');
	expect(body?.sql).toContain("bytes <= 41943040");
	expect(body?.sql).not.toContain("::json");
	expect(body?.sql).not.toContain("origin_label");
	expect(body?.params).toEqual(["pg", null, null, null, "pg", "m"]);
	expect(result).not.toHaveProperty("originLabel");
});

test("PG Worker preserves large safe-integer offsets without PostgreSQL int4 slicing", async () => {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const original = "原文😄";
	const points = Array.from(original);
	const unsafe = pgMock(async (sql: string, params: unknown[]) => {
		calls.push({ sql, params });
		if (sql.startsWith("WITH RECURSIVE lineage"))
			return [{ id: "pg", refs_inherited_from: null, refs_backfill_cursor: null }];
		if (sql.includes("recall_body AS MATERIALIZED")) {
			return [
				{
					messageId: "m",
					narratorId: "pg",
					narratorTitle: "PG",
					role: "user",
					origin: "user",
					originLabel: null,
					createdAt: "2026",
					seq: "1",
					bodyRevision: "3",
					contentJson: JSON.stringify([{ type: "text", text: original }]),
					bytes: 100,
					metadata_bytes: 50,
				},
			];
		}
		return [];
	});
	mock.module("../../db", () => ({
		...sqliteDb,
		activeDatabaseBackend: "postgres",
		postgresRuntime: { closed: false, executor: { unsafe } },
	}));
	for (const offset of [2147483647, 2147483648, Number.MAX_SAFE_INTEGER]) {
		const result = await recallMessage({
			narratorId: "pg",
			messageId: "m",
			offset,
			maxChars: 20000,
		});
		expect(result).toMatchObject({
			offset,
			text: "",
			totalChars: points.length,
			hasMore: false,
			nextOffset: null,
		});
		const pageQuery = calls
			.filter((call) => call.sql.includes("recall_body AS MATERIALIZED"))
			.at(-1);
		expect(pageQuery?.sql).not.toContain("substr(");
		expect(pageQuery?.params).toEqual(["pg", null, null, null, "pg", "m"]);
	}
});

test("PG message fails closed on changed or missing lineage envelopes instead of missing/ancestor success", async () => {
	for (const envelope of [
		[{ recall_lineage_valid: false, recall_row_present: null }],
		[{ recall_row_present: 1 }],
		[{ recall_lineage_valid: true }],
		[],
	]) {
		const unsafe = mock(async (sql: string) => {
			if (sql.startsWith("WITH RECURSIVE lineage"))
				return [{ id: "pg", refs_inherited_from: null, refs_backfill_cursor: null }];
			expect(sql).toContain("recall_lineage_guard");
			expect(sql).toContain("recall_body AS MATERIALIZED");
			return envelope;
		});
		mock.module("../../db", () => ({
			...sqliteDb,
			activeDatabaseBackend: "postgres",
			postgresRuntime: { closed: false, executor: { unsafe } },
		}));
		const failure = await captureWorkerRejection(
			recallMessage({ narratorId: "pg", messageId: "ancestor-m2", offset: 0, maxChars: 10 }),
		);
		expect(failure).toMatchObject({ code: "DB_READ_PROTOCOL" });
		expect(String((failure as Error).message)).toContain("lineage");
		expect(unsafe).toHaveBeenCalledTimes(2);
	}
});

test("PostgreSQL misses and source-budget failures do not touch SQLite", async () => {
	let oversized = false;
	const unsafe = pgMock(async () => (oversized ? [{ bytes: 41 * 1024 * 1024 }] : []));
	mock.module("../../db", () => ({
		...sqliteDb,
		activeDatabaseBackend: "postgres",
		postgresRuntime: { closed: false, executor: { unsafe } },
	}));
	const prepare = spyOn(fixture.sqlite, "prepare");
	expect(await recallToolCallDetail({ toolCallId: "missing", narratorId: null })).toBeNull();
	expect(
		await recallMessage({
			narratorId: "recall-store",
			messageId: "missing",
			offset: 0,
			maxChars: 10,
		}),
	).toBeNull();
	expect(
		await recallToolCallPage({
			toolCallId: "missing",
			narratorId: null,
			part: "both",
			offset: 0,
			maxChars: 10,
		}),
	).toBeNull();
	expect(
		(await recallConversation({ narratorId: "missing", messageId: null, limit: 5 })).narrator,
	).toBeNull();
	oversized = true;
	expect(
		await captureWorkerRejection(recallToolCallDetail({ toolCallId: "large", narratorId: null })),
	).toMatchObject({ code: "DB_READ_BUDGET" });
	expect(prepare).not.toHaveBeenCalled();
});
