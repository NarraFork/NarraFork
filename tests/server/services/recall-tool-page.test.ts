import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PgExecutor } from "../../../server/db/pg-fts";
import type { ToolResult } from "../../../server/lib/agent/types";
import { DbReadError } from "../../../server/lib/db-worker/errors";
import {
	readRecallToolCallPage,
	readRecallToolCallPagePg,
} from "../../../server/lib/db-worker/recall-tool-page";
import type { RecallTextPage, RecallToolCallPageInput } from "../../../server/lib/recall-contract";

let database: Database;
const request: RecallToolCallPageInput = {
	toolCallId: "use",
	narratorId: "owner",
	part: "both",
	offset: 0,
	maxChars: 8,
};
beforeEach(() => {
	database = new Database(":memory:");
	// Exact production column names; tool_call_id references the ledger id, NOT tool_use_id.
	database.exec(`CREATE TABLE narrators(id TEXT PRIMARY KEY, title TEXT);
	CREATE TABLE narrator_tool_calls(id TEXT PRIMARY KEY, tool_use_id TEXT, tool_name TEXT,
	status TEXT, duration_ms INTEGER, error_message TEXT, created_at TEXT, narrator_id TEXT,
	input_json TEXT, output_json TEXT, permission_decided_by TEXT, permission_decided_at TEXT);
	CREATE TABLE narrator_questions(id TEXT PRIMARY KEY, narrator_id TEXT, tool_call_id TEXT UNIQUE,
	tool_use_id TEXT, questions_json TEXT, answers_json TEXT, answer_message_id TEXT,
	decided_by TEXT, decided_at TEXT, status TEXT, origin TEXT, resolution_json TEXT);
	INSERT INTO narrators VALUES('owner','原会话'),('other','另一会话');
	INSERT INTO narrator_tool_calls VALUES('ledger','use','Read','success',123,NULL,'2026-07-01',
	'owner','{"path":"中文🌿.txt"}','{"_text":"你好🌿🌈abc"}',NULL,NULL);`);
});
afterEach(() => database.close());
function pages(result: ToolResult | null): Record<string, RecallTextPage> {
	expect(result).not.toBeNull();
	return result?.metadata?.pages as Record<string, RecallTextPage>;
}
function read(overrides: Partial<RecallToolCallPageInput> = {}) {
	return readRecallToolCallPage(database, { ...request, ...overrides });
}
function question() {
	return read({ maxChars: 20000 })?.metadata?.question as Record<string, unknown>;
}
function setAsk(decidedBy: string) {
	database
		.query(`UPDATE narrator_tool_calls SET tool_name='AskUserQuestion',
	input_json=?, permission_decided_by=?, permission_decided_at='2026-07-02'`)
		.run(
			JSON.stringify({
				questions: [{ question: "原问题🌿？", options: [] }],
				answers: { "原问题🌿？": "原答案" },
			}),
			decidedBy,
		);
}

test("stored input and output can be reconstructed exactly with Unicode code-point pages", () => {
	for (const part of ["input", "output"] as const) {
		const stored = (
			database.query(`SELECT ${part}_json AS text FROM narrator_tool_calls`).get() as {
				text: string;
			}
		).text;
		let offset = 0;
		let reconstructed = "";
		do {
			const result = read({ part, offset, maxChars: 3 });
			const current = pages(result)[part];
			expect(Object.keys(pages(result))).toEqual([part]);
			expect(current.offset).toBe(offset);
			expect(current.totalChars).toBe([...stored].length);
			expect(current.text).toBe([...stored].slice(offset, offset + 3).join(""));
			expect(current.text).not.toMatch(/[\uD800-\uDBFF]$/u);
			reconstructed += current.text;
			if (!current.hasMore) {
				expect(current.nextOffset).toBeNull();
				break;
			}
			expect(current.nextOffset).toBe(offset + 3);
			offset = current.nextOffset as number;
		} while (offset < 1000);
		expect(reconstructed).toBe(stored);
	}
	expect(read()?.metadata).toMatchObject({
		toolCallId: "ledger",
		toolUseId: "use",
		toolName: "Read",
		narratorId: "owner",
		narratorTitle: "原会话",
		status: "success",
		textFormat: "stored_json_or_text",
	});
	expect(read()?.metadata).not.toHaveProperty("input");
	expect(read()?.metadata).not.toHaveProperty("output");
});

test("long Chinese and emoji output is bounded per page and reconstructs without loss", () => {
	const stored = JSON.stringify({ _text: "中文🌿🌈\n".repeat(10000) });
	database.query("UPDATE narrator_tool_calls SET output_json=?").run(stored);
	const chunks: string[] = [];
	let offset = 0;
	for (;;) {
		const result = read({ part: "output", offset, maxChars: 8000 });
		const current = pages(result).output;
		expect([...current.text].length).toBeLessThanOrEqual(8000);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
		chunks.push(current.text);
		if (current.nextOffset === null) break;
		offset = current.nextOffset;
	}
	expect(chunks.length).toBeGreaterThan(5);
	expect(chunks.join("")).toBe(stored);
});

test("part both has independent pages; missing fields and beyond-end offsets have empty pages", () => {
	expect(Object.keys(pages(read()))).toEqual(["input", "output"]);
	expect(pages(read({ offset: Number.MAX_SAFE_INTEGER })).input).toMatchObject({
		text: "",
		hasMore: false,
		nextOffset: null,
	});
	database.exec("UPDATE narrator_tool_calls SET output_json=NULL");
	expect(pages(read({ part: "output" })).output).toEqual({
		text: "",
		offset: 0,
		totalChars: 0,
		hasMore: false,
		nextOffset: null,
	});
});

test("invalid JSON and primitive JSON remain exact text, not a fabricated parsed object", () => {
	for (const text of ["broken raw🌿", "false", "0", '"hello🌿"']) {
		database.query("UPDATE narrator_tool_calls SET output_json=?").run(text);
		expect(pages(read({ part: "output", maxChars: 100 })).output.text).toBe(text);
	}
});

test("scope is enforced before loading sources, with explicit global and not-found support", () => {
	expect(read({ narratorId: "other" })).toBeNull();
	expect(read({ toolCallId: "ledger" })).toBeNull();
	expect(read({ toolCallId: "absent", narratorId: null })).toBeNull();
	expect(read({ narratorId: null })?.metadata?.narratorId).toBe("owner");
});

test("synchronous Ask preserves original questions, answers and exact user/auto decision provenance", () => {
	for (const actor of ["user", "auto", "reflection", "policy"]) {
		setAsk(actor);
		const evidence = question();
		expect(JSON.parse((evidence.questions as RecallTextPage).text)).toEqual([
			{ question: "原问题🌿？", options: [] },
		]);
		expect(JSON.parse((evidence.answers as RecallTextPage).text)).toEqual({
			"原问题🌿？": "原答案",
		});
		expect(evidence.decidedBy).toBe(actor);
		expect(evidence.decidedAt).toBe("2026-07-02");
		expect(read()?.metadata?.permissionDecidedBy).toBe(actor);
		if (actor !== "user") expect(read()?.output).not.toContain("human");
	}
});

test("async question joins ledger id, returns saved answers and never mistakes resolve.note for an answer", () => {
	setAsk("auto");
	database
		.query(`INSERT INTO narrator_questions VALUES('question','owner','ledger','use',?,?,
	'answer-message','user','2026-07-03','answered','agent_async',?)`)
		.run(
			JSON.stringify([{ question: "异步原问题" }]),
			JSON.stringify({ 异步原问题: "用户真实答案" }),
			JSON.stringify({ note: "代理解释不是用户答案", answerMessageId: "answer-message" }),
		);
	const evidence = question();
	expect(evidence).toMatchObject({
		id: "question",
		answerMessageId: "answer-message",
		status: "answered",
		origin: "agent_async",
		decidedBy: "user",
		decidedAt: "2026-07-03",
	});
	expect(JSON.parse((evidence.answers as RecallTextPage).text)).toEqual({
		异步原问题: "用户真实答案",
	});
	expect(read()?.output).not.toContain("代理解释不是用户答案");
	// A stale input.answers must never be used when an async ledger row is still unanswered.
	database.exec(
		"UPDATE narrator_questions SET answers_json=NULL, decided_by=NULL, decided_at=NULL, answer_message_id=NULL, status='open'",
	);
	expect(question()).toMatchObject({
		answers: null,
		decidedBy: null,
		decidedAt: null,
		answerMessageId: null,
	});
});

test("long asynchronous saved answers resume via part input even after short input is exhausted", () => {
	setAsk("auto");
	database.query("UPDATE narrator_tool_calls SET input_json='{}'").run();
	const stored = JSON.stringify({ answer: "用户真实长答案😄".repeat(120) });
	database
		.query(
			`INSERT INTO narrator_questions VALUES('question','owner','ledger','use','[]',?,'answer-message','user','2026-07-03','answered','agent_async','{"note":"not an answer"}')`,
		)
		.run(stored);
	let offset = 0,
		joined = "",
		count = 0;
	for (;;) {
		const result = read({ part: "input", offset, maxChars: 11 });
		const answer = (result?.metadata?.question as { answers: RecallTextPage }).answers;
		if (offset > 2) expect(pages(result).input.hasMore).toBe(false);
		expect(answer.offset).toBe(offset);
		joined += answer.text;
		count++;
		if (!answer.hasMore) break;
		offset = answer.nextOffset as number;
	}
	expect(count).toBeGreaterThan(10);
	expect(joined).toBe(stored);
});

test("question evidence pages are bounded and a foreign narrator question is not joined", () => {
	setAsk("auto");
	database
		.query(`INSERT INTO narrator_questions VALUES('foreign','other','ledger','use',?,NULL,
	NULL,NULL,NULL,'open','agent_async',NULL)`)
		.run(JSON.stringify([{ question: "foreign" }]));
	const evidence = read({ maxChars: 3 })?.metadata?.question as Record<string, unknown>;
	expect(evidence.id).toBeNull();
	expect([...(evidence.questions as RecallTextPage).text]).toHaveLength(3);
	expect((evidence.questions as RecallTextPage).hasMore).toBe(true);
});

test("source and serialized-result budgets fail with explicit DbReadError after scope", () => {
	database
		.query("UPDATE narrator_tool_calls SET output_json=CAST(zeroblob(?) AS TEXT)")
		.run(40 * 1024 * 1024);
	expect(read({ narratorId: "other" })).toBeNull();
	expect(() => read()).toThrow(DbReadError);
	try {
		read();
	} catch (error) {
		expect(error).toMatchObject({ code: "DB_READ_BUDGET" });
	}
	database
		.query("UPDATE narrator_tool_calls SET output_json=NULL, error_message=?")
		.run("x".repeat(300 * 1024));
	expect(() => read()).toThrow("result exceeds its byte budget");
});

test("invalid pagination, cancellation and deadlines fail before querying", () => {
	for (const overrides of [
		{ offset: -1 },
		{ offset: 0.5 },
		{ maxChars: 0 },
		{ maxChars: 20001 },
		{ part: "invalid" },
		{ toolCallId: "" },
		{ narratorId: "" },
	]) {
		expect(() => read(overrides as Partial<RecallToolCallPageInput>)).toThrow(DbReadError);
	}
	const abort = new AbortController();
	abort.abort();
	expect(() => readRecallToolCallPage(database, request, abort.signal)).toThrow("cancelled");
	expect(() => readRecallToolCallPage(database, request, undefined, Date.now() - 1)).toThrow(
		"deadline",
	);
});

function pgRow(): Record<string, unknown> {
	return {
		id: "ledger",
		tool_use_id: "use",
		tool_name: "Read",
		status: "success",
		duration_ms: 123,
		error_message: null,
		created_at: "2026-07-01",
		narrator_id: "owner",
		narrator_title: "原会话",
		permission_decided_by: null,
		permission_decided_at: null,
		question_id: null,
		question_status: null,
		question_origin: null,
		answer_message_id: null,
		question_decided_by: null,
		question_decided_at: null,
		source_bytes: 1500,
		metadata_bytes: 150,
		input_text: "中文🌿",
		input_chars: 8,
		output_text: null,
		output_chars: null,
		questions_text: null,
		questions_chars: null,
		answers_text: null,
		answers_chars: null,
	};
}

test("PG projects text slices in SQL, uses production ledger join, and never returns full raw JSON columns", async () => {
	let sql = "";
	let bindings: unknown[] = [];
	const pg: PgExecutor = {
		unsafe: async (query, params) => {
			sql = query;
			bindings = params ?? [];
			return [pgRow()];
		},
	};
	const result = await readRecallToolCallPagePg(pg, {
		...request,
		part: "input",
		offset: 2,
		maxChars: 3,
	});
	expect(pages(result)).toEqual({
		input: { text: "中文🌿", offset: 2, totalChars: 8, hasMore: true, nextOffset: 5 },
	});
	expect(bindings).toEqual(["use", "owner", 3, 3]);
	expect(sql).toContain("q.tool_call_id = tc.id");
	expect(sql).toContain("q.narrator_id = tc.narrator_id");
	expect(sql).toContain("tc.narrator_id = $2");
	expect(sql).toContain("substring(input_json from $3::integer for $4::integer)");
	expect(sql).toContain("char_length(input_json)");
	expect(sql).toContain("input_json::json -> 'answers'");
	expect(sql).toContain("source_bytes <= 41943040");
	expect(sql).toContain("metadata_bytes <= 524288");
	expect(sql).not.toContain("resolution_json");
	const projection = sql.slice(sql.lastIndexOf("SELECT admitted.id"));
	expect(projection).not.toContain("input_json");
	expect(projection).not.toContain("output_json");
	await readRecallToolCallPagePg(pg, {
		...request,
		narratorId: null,
		offset: Number.MAX_SAFE_INTEGER,
	});
	expect(bindings).toEqual(["use", 41943041, 8]);
	expect(sql).not.toContain("tc.narrator_id = $2");
});

test("PG accepts bounded answer evidence without parsing page fragments as complete JSON", async () => {
	const row = {
		...pgRow(),
		tool_name: "AskUserQuestion",
		question_id: "question",
		question_status: "answered",
		question_origin: "agent_async",
		answer_message_id: "answer-message",
		question_decided_by: "auto",
		question_decided_at: "2026-07-03",
		questions_text: '[{"ques',
		questions_chars: 150,
		answers_text: '{"问🌿":',
		answers_chars: 80,
	};
	const pg: PgExecutor = { unsafe: async () => [row] };
	const result = await readRecallToolCallPagePg(pg, request);
	expect(result?.metadata?.question).toMatchObject({
		id: "question",
		decidedBy: "auto",
		answerMessageId: "answer-message",
		answers: { text: '{"问🌿":', totalChars: 80, hasMore: true },
	});
	expect(result?.output).not.toContain("human");
});

test("PG rejects source/result budgets explicitly and propagates failures with no inline fallback", async () => {
	const row = pgRow();
	const pg: PgExecutor = { unsafe: async () => [row] };
	row.source_bytes = 40 * 1024 * 1024 + 1;
	await expect(readRecallToolCallPagePg(pg, request)).rejects.toMatchObject({
		code: "DB_READ_BUDGET",
	});
	row.source_bytes = 1500;
	row.metadata_bytes = 524289;
	await expect(readRecallToolCallPagePg(pg, request)).rejects.toMatchObject({
		code: "DB_READ_BUDGET",
	});
	row.metadata_bytes = 150;
	row.error_message = "x".repeat(300 * 1024);
	await expect(readRecallToolCallPagePg(pg, request)).rejects.toThrow(
		"result exceeds its byte budget",
	);
	const error = new Error("PG failed");
	await expect(
		readRecallToolCallPagePg(
			{
				unsafe: async () => {
					throw error;
				},
			},
			request,
		),
	).rejects.toBe(error);
	expect(await readRecallToolCallPagePg({ unsafe: async () => [] }, request)).toBeNull();
});

test("PG rechecks cancellation/deadline after await, even for missing records", async () => {
	const controller = new AbortController();
	const pg: PgExecutor = {
		unsafe: async () => {
			controller.abort();
			return [];
		},
	};
	await expect(readRecallToolCallPagePg(pg, request, controller.signal)).rejects.toMatchObject({
		code: "DB_READ_ABORTED",
	});
	await expect(
		readRecallToolCallPagePg(pg, request, undefined, Date.now() - 1),
	).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
});
