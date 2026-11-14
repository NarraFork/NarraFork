import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../lib/logger";
import { modelHistoryManifest, queryModelHistoryDelta } from "./model-history-delta";
import { modelHistoryFixtureSql } from "./model-history-fixture";
import {
	type HistoryQuery,
	type ModelHistoryQueryOptions,
	type ModelHistorySource,
	type ModelSourceRowBuilder,
	type ModelToolSourceRow,
	queryModelHistory,
	sqliteHistoryQuery,
} from "./model-history-query";
import * as revisionModule from "./model-history-revision";
import { readSqliteModelHistorySignature } from "./model-history-revision";
import { renderModelHistoryRevisionSql } from "./model-history-revision-sql";
import {
	clearModelHistorySourceCacheForTest,
	loadModelHistorySource,
	ModelHistorySourceCache,
	modelHistorySourceStats,
	modelHistoryWorkerSpecifiers,
} from "./model-history-source";

const connections: Database[] = [];
const directories: string[] = [];
// bun:test's spy type models callable functions, not constructor-only globals.
const workerGlobal = globalThis as unknown as {
	Worker: (...args: ConstructorParameters<typeof Worker>) => Worker;
};
function fixture(file = false) {
	const directory = file ? mkdtempSync(join(tmpdir(), "nf-model-history-")) : null;
	if (directory) directories.push(directory);
	const db = new Database(directory ? join(directory, "fixture.db") : ":memory:");
	connections.push(db);
	db.run("PRAGMA journal_mode = WAL");
	db.run(modelHistoryFixtureSql);
	db.run(renderModelHistoryRevisionSql("sqlite"));
	db.run(
		"INSERT INTO narrators (id, title) VALUES ('owner', 'Owner'), ('fork', 'Fork'), ('other', 'Other')",
	);
	db.run("INSERT INTO users (id, username) VALUES ('human', 'Alice')");
	return db;
}
function message(db: Database, id: string, seq: number, extra = "", role = "user") {
	const content = `${id}${extra}`;
	db.query(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_by) VALUES (?, 'owner', ?, ?, ?, 'human')",
	).run(id, role, JSON.stringify([{ type: "text", text: content }]), content);
	db.query(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'owner', ?, ?)",
	).run(`ref:${id}`, id, seq);
}
/** Runs `mutate` right after the main thread's first signature read, before the worker starts. */
function afterFirstSignature(mutate: () => void) {
	const realRead = revisionModule.readSqliteModelHistorySignature;
	let reads = 0;
	const spy = spyOn(revisionModule, "readSqliteModelHistorySignature").mockImplementation(
		(connection, id) => {
			const signature = realRead(connection, id);
			if (++reads === 1) mutate();
			return signature;
		},
	);
	return () => spy.mockRestore();
}
function revision(db: Database, id = "owner") {
	return readSqliteModelHistorySignature(db, id).revision;
}
afterEach(() => {
	clearModelHistorySourceCacheForTest();
	for (const db of connections.splice(0)) db.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

type DeltaEvent =
	| { type: "reuseBodies"; ids: string[] }
	| { type: "page"; rows: ModelSourceRowBuilder[] }
	| { type: "reuseTools"; rows: Array<{ id: string; messageId: string }> }
	| { type: "tools"; rows: Array<ModelToolSourceRow & { messageId: string }> }
	| { type: "order"; reset: boolean; ids: string[] };

function present<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing expected test value");
	return value;
}

/** Apply the worker protocol to a fresh snapshot; never mutate the previous one. */
async function readDelta(
	query: HistoryQuery,
	previous: ModelHistorySource,
	options: Partial<ModelHistoryQueryOptions> = {},
): Promise<ModelHistorySource> {
	const old = new Map(previous.messages.map((row) => [row.id, row]));
	const oldTools = new Map(
		previous.messages.flatMap((row) => row.toolCalls.map((tool) => [tool.id, tool] as const)),
	);
	const rows = new Map<string, ModelSourceRowBuilder>();
	const order: string[] = [];
	const result = await queryModelHistoryDelta(
		query,
		{ narratorId: "owner", ...options },
		modelHistoryManifest(previous),
		async (value) => {
			const event = value as DeltaEvent;
			switch (event.type) {
				case "reuseBodies":
					for (const id of event.ids) rows.set(id, { ...present(old.get(id)), toolCalls: [] });
					break;
				case "page":
					for (const row of event.rows) rows.set(row.id, row);
					break;
				case "reuseTools":
					for (const tool of event.rows)
						present(rows.get(tool.messageId)).toolCalls.push(present(oldTools.get(tool.id)));
					break;
				case "tools":
					for (const { messageId, ...tool } of event.rows)
						present(rows.get(messageId)).toolCalls.push(tool);
					break;
				case "order":
					if (event.reset) order.length = 0;
					order.push(...event.ids);
			}
		},
	);
	return {
		...result,
		messages: order.map((id) => {
			const row = present(rows.get(id));
			row.toolCalls.sort((a, b) => a.id.localeCompare(b.id));
			return row;
		}),
	};
}

function traceQuery(db: Database) {
	const calls: Array<{ sql: string; parameters: unknown[] }> = [];
	const query: HistoryQuery = async <T>(sql: string, parameters: unknown[] = []) => {
		calls.push({ sql, parameters });
		return sqliteHistoryQuery(db)<T>(sql, parameters);
	};
	return { query, calls };
}

describe("delta metadata and allocation accounting", () => {
	test("unchanged refs/tools never scan body lengths; only changed IDs are measured", async () => {
		const db = fixture();
		db.transaction(() => {
			for (let index = 0; index < 205; index++) message(db, `m${index}`, index);
			for (let index = 0; index < 205; index++)
				db.query(
					"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,input_json,output_json) VALUES (?,'owner','m0','{}','null')",
				).run(`t${String(index).padStart(3, "0")}`);
		})();
		const original = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		const unchangedTrace = traceQuery(db);
		const unchanged = await readDelta(unchangedTrace.query, original);
		expect(unchanged.messages).toEqual(original.messages);
		expect(unchanged.counters.preparedBytes).toBe(original.counters.preparedBytes);
		expect(unchanged.counters.sourceBytes).toBe(0);
		expect(unchanged.counters.reusedBodies).toBe(205);
		expect(unchanged.counters.reusedTools).toBe(205);
		expect(
			unchangedTrace.calls.every(
				({ sql }) => !/length\(|content_json|input_json|output_json/.test(sql),
			),
		).toBe(true);

		db.run(`UPDATE narrator_messages SET content_json='[{"text":"变化"}]' WHERE id='m200'`);
		db.run(`UPDATE narrator_tool_calls SET output_json='{"changed":true}' WHERE id='t004'`);
		message(db, "appended", 205);
		const changedTrace = traceQuery(db);
		const changed = await readDelta(changedTrace.query, unchanged);
		const cold = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		expect(changed.messages).toEqual(cold.messages);
		expect(changed.counters.preparedBytes).toBe(cold.counters.preparedBytes);
		expect(changed.counters.reusedBodies).toBe(204);
		expect(changed.counters.reusedTools).toBe(204);
		const sizeQueries = changedTrace.calls.filter(({ sql }) => /length\(/.test(sql));
		expect(sizeQueries).toHaveLength(2);
		expect(
			sizeQueries.find(({ sql }) => sql.includes("FROM narrator_messages"))?.parameters,
		).toEqual(["m200", "appended"]);
		expect(
			sizeQueries.find(({ sql }) => sql.includes("FROM narrator_tool_calls"))?.parameters,
		).toEqual(["t004"]);
		expect(
			changedTrace.calls
				.filter(({ sql }) => /ORDER BY/.test(sql))
				.every(({ sql }) => !/length\(/.test(sql)),
		).toBe(true);
		const expectedReadBytes =
			cold.messages
				.filter((row) => ["m200", "appended"].includes(row.id))
				.reduce((sum, row) => sum + present(row.rawBytes), 0) +
			present(cold.messages[0].toolCalls.find((tool) => tool.id === "t004")?.rawBytes);
		expect(changed.counters.sourceBytes).toBe(expectedReadBytes);
	});

	test("UTF-8, NUL, empty text and NULL preserve raw costs across cold and reuse", async () => {
		const db = fixture();
		const values = [
			{
				json: JSON.stringify([{ text: "中文\u0000尾" }]),
				text: "中文\u0000尾",
				input: '{"中文":"\\u0000"}',
				output: null,
			},
			{ json: null, text: "中文\u0000尾", input: null, output: '""' },
			{ json: "[]", text: "", input: "{}", output: "null" },
			{ json: "null", text: null, input: null, output: null },
		];
		for (const [index, value] of values.entries()) {
			message(db, `m${index}`, index);
			db.query("UPDATE narrator_messages SET content_json=?,content_text=? WHERE id=?").run(
				value.json,
				value.text,
				`m${index}`,
			);
			db.query(
				"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,input_json,output_json) VALUES (?,'owner',?,?,?)",
			).run(`t${index}`, `m${index}`, value.input, value.output);
		}
		const cold = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		for (const [index, value] of values.entries()) {
			expect(cold.messages[index].rawBytes).toBe(
				Buffer.byteLength(value.json ?? "") + Buffer.byteLength(value.text ?? ""),
			);
			expect(cold.messages[index].toolCalls[0].rawBytes).toBe(
				Buffer.byteLength(value.input ?? "") + Buffer.byteLength(value.output ?? ""),
			);
		}
		const reused = await readDelta(sqliteHistoryQuery(db), cold);
		expect(reused.messages).toEqual(cold.messages);
		expect(reused.counters.preparedBytes).toBe(cold.counters.preparedBytes);
		expect(reused.counters.sourceBytes).toBe(0);
		const legacy = {
			...cold,
			messages: cold.messages.map((row) => ({
				...row,
				rawBytes: undefined,
				toolCalls: row.toolCalls.map((tool) => ({ ...tool, rawBytes: undefined })),
			})),
		};
		const trace = traceQuery(db);
		const measured = await readDelta(trace.query, legacy);
		expect(measured.messages).toEqual(cold.messages);
		expect(measured.counters.sourceBytes).toBe(cold.counters.sourceBytes);
		expect(measured.counters.preparedBytes).toBe(cold.counters.preparedBytes);
		expect(measured.counters.reusedBodies).toBe(0);
		expect(measured.counters.reusedTools).toBe(0);
		expect(trace.calls.filter(({ sql }) => /length\(/.test(sql))).toHaveLength(2);
	});

	test("author metadata is refreshed and deleted tool rows disappear exactly as in a cold read", async () => {
		const db = fixture();
		message(db, "m", 0);
		db.run(
			"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,input_json) VALUES ('t','owner','m','{}')",
		);
		let previous = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		for (const statement of [
			"UPDATE users SET username='新名字' WHERE id='human'",
			"UPDATE narrators SET title='新标题' WHERE id='owner'",
			"DELETE FROM narrator_tool_calls WHERE id='t'",
		]) {
			db.run(statement);
			const current = await readDelta(sqliteHistoryQuery(db), previous);
			const cold = await queryModelHistory(sqliteHistoryQuery(db), {
				narratorId: "owner",
				versioned: true,
			});
			expect(current.messages).toEqual(cold.messages);
			expect(current.counters.preparedBytes).toBe(cold.counters.preparedBytes);
			expect(current.counters.reusedBodies).toBe(statement.startsWith("DELETE") ? 1 : 0);
			previous = current;
		}
	});

	test("reused rows pay the complete budget and cancellation wins before any body fetch", async () => {
		const db = fixture();
		message(db, "m", 0, "中文".repeat(100));
		db.run(
			"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,input_json,output_json) VALUES ('t','owner','m','{}','{}')",
		);
		const cold = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		const maxBytes = present(cold.counters.preparedBytes);
		expect(
			(await readDelta(sqliteHistoryQuery(db), cold, { maxBytes })).counters.preparedBytes,
		).toBe(maxBytes);
		await expect(
			readDelta(sqliteHistoryQuery(db), cold, { maxBytes: maxBytes - 1 }),
		).rejects.toThrow(`estimated ${maxBytes - 1} byte budget`);
		await expect(
			queryModelHistory(sqliteHistoryQuery(db), {
				narratorId: "owner",
				versioned: true,
				maxBytes: maxBytes - 1,
			}),
		).rejects.toThrow(/byte budget/);
		const trace = traceQuery(db);
		await expect(
			readDelta(trace.query, cold, {
				maxBytes: 0,
				signal: AbortSignal.abort(new Error("cancel first")),
			}),
		).rejects.toThrow("cancel first");
		expect(trace.calls).toHaveLength(0);
		const controller = new AbortController();
		const cancelOnMetadata: HistoryQuery = async <T>(sql: string, parameters?: unknown[]) => {
			const result = await trace.query<T>(sql, parameters);
			if (sql.includes('m.body_revision AS "bodyRevision"'))
				controller.abort(new Error("cancel metadata"));
			return result;
		};
		await expect(
			readDelta(cancelOnMetadata, cold, { maxBytes: 0, signal: controller.signal }),
		).rejects.toThrow("cancel metadata");
		expect(trace.calls.every(({ sql }) => !/length\(|content_json/.test(sql))).toBe(true);
	});

	test("block payload/state costs are charged once on change and reused without reading blocks", async () => {
		const db = fixture();
		message(db, "block", 0);
		const payload = JSON.stringify({ raw: [{ type: "text", text: "中文" }] });
		const state = JSON.stringify({ raw: [{ finished: true }] });
		db.query(
			"UPDATE narrator_messages SET content_json=NULL,body_format=2,body_bytes=? WHERE id='block'",
		).run(Buffer.byteLength(payload) + Buffer.byteLength(state));
		db.query(
			"INSERT INTO narrator_blocks (id,message_id,ordinal,kind,payload,state) VALUES ('b','block',0,'text',?,?)",
		).run(payload, state);
		const options = { narratorId: "owner", versioned: true, bodiesFromBlocks: true };
		const cold = await queryModelHistory(sqliteHistoryQuery(db), options);
		const trace = traceQuery(db);
		const reused = await readDelta(trace.query, cold, options);
		expect(reused.messages).toEqual(cold.messages);
		expect(reused.counters.preparedBytes).toBe(cold.counters.preparedBytes);
		expect(reused.counters.sourceBytes).toBe(0);
		expect(trace.calls.every(({ sql }) => !/length\(|narrator_blocks/.test(sql))).toBe(true);
		const legacy = {
			...cold,
			messages: cold.messages.map((row) => ({ ...row, rawBytes: undefined })),
		};
		const changed = await readDelta(sqliteHistoryQuery(db), legacy, {
			...options,
			maxBytes: cold.counters.preparedBytes,
		});
		expect(changed.messages).toEqual(cold.messages);
		expect(changed.counters.preparedBytes).toBe(cold.counters.preparedBytes);
		expect(changed.counters.sourceBytes).toBe(cold.counters.sourceBytes);
	});

	test("changed body/tool rows retain the 4MiB batching target and 128MiB cap", async () => {
		const db = fixture();
		message(db, "a", 0);
		message(db, "b", 1);
		const before = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		for (const id of ["a", "b"]) {
			const text = "x".repeat(1_100_000);
			db.query("UPDATE narrator_messages SET content_json=?,content_text=? WHERE id=?").run(
				JSON.stringify([{ text }]),
				text,
				id,
			);
		}
		for (let index = 0; index < 3; index++)
			db.query(
				"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,input_json,output_json) VALUES (?,'owner','a','{}',?)",
			).run(`t${index}`, JSON.stringify("x".repeat(1_500_000)));
		const delta = await readDelta(sqliteHistoryQuery(db), before);
		const cold = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		expect(delta.messages).toEqual(cold.messages);
		expect(delta.counters.bodyQueries).toBe(2);
		expect(delta.counters.maxBodyBatchBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(delta.counters.maxToolBatchBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(delta.counters.preparedBytes).toBe(cold.counters.preparedBytes);
		const tooLarge = {
			...cold,
			messages: cold.messages.map((row) => ({ ...row, rawBytes: 128 * 1024 * 1024 })),
		};
		const trace = traceQuery(db);
		await expect(readDelta(trace.query, tooLarge, { maxBytes: 256 * 1024 * 1024 })).rejects.toThrow(
			"estimated 134217728 byte budget",
		);
		expect(trace.calls.every(({ sql }) => !/length\(|content_json/.test(sql))).toBe(true);
	});

	test("delta has no old time window and rejects compact, removal and reordered refs", async () => {
		const db = fixture();
		for (let index = 0; index < 205; index++) message(db, `m${index}`, index);
		const cold = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
			versioned: true,
		});
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const slow: HistoryQuery = async <T>(sql: string, parameters?: unknown[]) => {
			now += 11_000;
			return sqliteHistoryQuery(db)<T>(sql, parameters);
		};
		try {
			expect((await readDelta(slow, cold)).messages).toEqual(cold.messages);
		} finally {
			clock.mockRestore();
		}
		for (const statement of [
			"UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='m100'",
			"DELETE FROM narrator_message_refs WHERE message_id='m204'",
			"UPDATE narrator_message_refs SET seq=999 WHERE message_id='m0'",
		]) {
			db.run("SAVEPOINT structure_test");
			db.run(statement);
			await expect(readDelta(sqliteHistoryQuery(db), cold)).rejects.toThrow(
				"delta structure changed",
			);
			db.run("ROLLBACK TO structure_test");
			db.run("RELEASE structure_test");
		}
	});
});

describe("complete bounded model source", () => {
	test("keysets >2000 refs without truncation and independently pages >200 tools", async () => {
		const db = fixture();
		db.transaction(() => {
			for (let index = 0; index < 2105; index++) message(db, `m${index}`, index);
			for (let index = 0; index < 405; index++)
				db.query(
					"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,execution_attempt,created_at) VALUES (?,'owner','m2000',?,'Read','{}','\"ok\"','success',1,'now')",
				).run(`tool:${String(index).padStart(4, "0")}`, `use:${index}`);
		})();
		const source = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
		});
		expect(source.messages).toHaveLength(2105);
		expect(source.messages[2104].id).toBe("m2104");
		expect(source.messages[2000].toolCalls).toHaveLength(405);
		expect(source.counters.maxRefsPerQuery).toBe(200);
		expect(source.counters.refQueries).toBe(12);
		expect(source.counters.toolRows).toBe(405);
	});
	test("compact/segment/fork interval and source ordering are preserved", async () => {
		const db = fixture();
		for (let index = 0; index < 205; index++) message(db, `m${index}`, index);
		db.run("UPDATE narrator_message_refs SET is_compact = 1 WHERE message_id = 'm200'");
		db.run(
			"UPDATE narrator_message_refs SET segment_compact_id = 'm200' WHERE message_id = 'm202'",
		);
		message(db, "display", 206, "", "disp");
		db.run(
			"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq,is_compact,segment_compact_id) SELECT 'fork:' || id,'fork',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE seq <= 203",
		);
		expect(
			(await queryModelHistory(sqliteHistoryQuery(db), { narratorId: "owner" })).messages.map(
				(row) => row.id,
			),
		).toEqual(["m201", "m203", "m204"]);
		expect(
			(await queryModelHistory(sqliteHistoryQuery(db), { narratorId: "fork" })).messages.map(
				(row) => row.id,
			),
		).toEqual(["m201", "m203"]);
	});
	test("bytes split body batches, budget fails rather than adopting partial history", async () => {
		const db = fixture();
		message(db, "large-a", 0, "x".repeat(1_300_000));
		message(db, "large-b", 1, "x".repeat(1_300_000));
		const source = await queryModelHistory(sqliteHistoryQuery(db), {
			narratorId: "owner",
		});
		expect(source.counters.bodyQueries).toBe(2);
		expect(source.counters.maxBodyBatchBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		await expect(
			queryModelHistory(sqliteHistoryQuery(db), {
				narratorId: "owner",
				maxBytes: 1024,
			}),
		).rejects.toThrow("estimated 1024 byte budget");
		await expect(
			queryModelHistory(sqliteHistoryQuery(db), {
				narratorId: "owner",
				signal: AbortSignal.abort(new Error("cancel model query")),
			}),
		).rejects.toThrow("cancel model query");
	});
	test("real worker completes all pages after the clock crosses the former ten-second cutoff", async () => {
		const db = fixture(true);
		for (let index = 0; index < 205; index++)
			message(db, `slow:${index}`, index, " PRIVATE_BODY_SECRET /private/PRIVATE_PATH_SECRET");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const startedAt = Date.now();
		let now = startedAt;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const RealWorker = globalThis.Worker;
		let pages = 0;
		const worker = spyOn(workerGlobal, "Worker").mockImplementation((specifier, options) => {
			const instance = new RealWorker(specifier, options);
			instance.addEventListener("message", (event) => {
				if (event.data.type === "page") {
					pages++;
					now += 11_000;
				}
			});
			return instance;
		});
		try {
			const source = await loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner");
			expect(pages).toBeGreaterThan(1);
			expect(now - startedAt).toBeGreaterThan(10_000);
			expect(source.messages).toHaveLength(205);
			expect(Object.isFrozen(source.messages[204].contentJson)).toBe(false);
			expect(modelHistorySourceStats().workers).toBe(0);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]).toEqual([
				"Slow model history preparation",
				expect.objectContaining({ narratorId: "owner", phase: "worker", refs: 205 }),
			]);
			const diagnostic = warn.mock.calls[0][1];
			expect(Object.keys(diagnostic ?? {}).sort()).toEqual([
				"backend",
				"elapsedMs",
				"narratorId",
				"phase",
				"queued",
				"refs",
				"sourceBytes",
				"toolRows",
				"workers",
			]);
			for (const value of Object.values(diagnostic ?? {}))
				expect(typeof value === "string" || typeof value === "number").toBe(true);
			const logs = JSON.stringify(warn.mock.calls);
			for (const secret of [
				"slow:204",
				"PRIVATE_BODY_SECRET",
				"PRIVATE_PATH_SECRET",
				db.filename,
				import.meta.dir,
			])
				expect(logs).not.toContain(secret);
		} finally {
			warn.mockRestore();
			worker.mockRestore();
			clock.mockRestore();
		}
	});
	test("cancelling an active worker rejects and releases its slot without caching partial pages", async () => {
		const db = fixture(true);
		for (let index = 0; index < 205; index++) message(db, `cancel:${index}`, index);
		const controller = new AbortController();
		const RealWorker = globalThis.Worker;
		const worker = spyOn(workerGlobal, "Worker").mockImplementation((specifier, options) => {
			const instance = new RealWorker(specifier, options);
			instance.addEventListener("message", () => controller.abort(), { once: true });
			return instance;
		});
		try {
			await expect(
				loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner", {
					signal: controller.signal,
				}),
			).rejects.toThrow("cancelled");
			expect(modelHistorySourceStats().workers).toBe(0);
			expect(modelHistorySourceStats().cacheEntries).toBe(0);
		} finally {
			worker.mockRestore();
		}
	});
	test("a real worker query error rejects immediately instead of waiting for a timeout", async () => {
		const db = fixture(true);
		message(db, "broken", 0);
		const restore = afterFirstSignature(() => db.run("DROP TABLE narrator_tool_calls"));
		try {
			await expect(
				loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner"),
			).rejects.toThrow("Model history read-only worker failed");
			expect(modelHistorySourceStats().workers).toBe(0);
			expect(modelHistorySourceStats().cacheEntries).toBe(0);
		} finally {
			restore();
		}
	});
	test("a real worker closing without a result rejects and releases its slot", async () => {
		const db = fixture(true);
		const RealWorker = globalThis.Worker;
		// Bun workers have no self.close(); process.exit exits only this isolated worker.
		const url = URL.createObjectURL(
			new Blob(["process.exit(0)"], { type: "application/javascript" }),
		);
		const worker = spyOn(workerGlobal, "Worker").mockImplementation(() => new RealWorker(url));
		try {
			await expect(
				loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner"),
			).rejects.toThrow("closed before completion");
			expect(modelHistorySourceStats().workers).toBe(0);
			expect(modelHistorySourceStats().cacheEntries).toBe(0);
		} finally {
			worker.mockRestore();
			URL.revokeObjectURL(url);
		}
	});
	test.each([
		"request",
		"ack",
	])("synchronous worker %s dispatch failure cleans up and permits a later read", async (phase) => {
		const db = fixture(true);
		message(db, "dispatch", 0);
		const controller = new AbortController();
		const removeListener = spyOn(controller.signal, "removeEventListener");
		const RealWorker = globalThis.Worker;
		let terminations = 0;
		let failedDispatches = 0;
		const worker = spyOn(workerGlobal, "Worker").mockImplementation((specifier, options) => {
			const instance = new RealWorker(specifier, options);
			const send = instance.postMessage.bind(instance);
			const terminate = instance.terminate.bind(instance);
			spyOn(instance, "postMessage").mockImplementation((message) => {
				if ((message.type === "ack") === (phase === "ack")) {
					failedDispatches++;
					throw new Error("fixture dispatch failure");
				}
				send(message);
			});
			spyOn(instance, "terminate").mockImplementation(() => {
				terminations++;
				return terminate();
			});
			return instance;
		});
		try {
			await expect(
				loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner", {
					signal: controller.signal,
				}),
			).rejects.toThrow("worker dispatch failed");
			expect(failedDispatches).toBe(1);
			expect(terminations).toBe(1);
			expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
			expect(modelHistorySourceStats().workers).toBe(0);
			expect(modelHistorySourceStats().cacheEntries).toBe(0);
		} finally {
			worker.mockRestore();
			removeListener.mockRestore();
		}
		expect(
			(await loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner")).messages,
		).toHaveLength(1);
	});
	test("worker message deserialization failure rejects without a timeout", async () => {
		const db = fixture(true);
		const RealWorker = globalThis.Worker;
		const worker = spyOn(workerGlobal, "Worker").mockImplementation((specifier, options) => {
			const instance = new RealWorker(specifier, options);
			const dispatch = instance.postMessage.bind(instance);
			spyOn(instance, "postMessage").mockImplementation((message) => {
				if (message && "narratorId" in message)
					instance.dispatchEvent(new MessageEvent("messageerror"));
				else dispatch(message);
			});
			return instance;
		});
		try {
			await expect(
				loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner"),
			).rejects.toThrow("worker message failed");
			expect(modelHistorySourceStats().workers).toBe(0);
		} finally {
			worker.mockRestore();
		}
	});
	test("read-only worker yields main timers, skips graph freezing and invalidates across connections", async () => {
		const db = fixture(true);
		message(db, "shared", 0, "字".repeat(100_000));
		db.run(
			"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('fork:shared','fork','shared',0)",
		);
		const other = new Database(db.filename);
		connections.push(other);
		let ticks = 0;
		const timer = setInterval(() => ticks++, 1);
		try {
			const backend = { backend: "sqlite" as const, sqlite: db };
			const first = await loadModelHistorySource(backend, "fork");
			expect(ticks).toBeGreaterThan(0);
			expect(Object.isFrozen(first.messages[0].contentJson)).toBe(false);
			const stats = modelHistorySourceStats();
			expect(await loadModelHistorySource(backend, "fork")).toBe(first);
			expect(modelHistorySourceStats().signatureReads).toBe(stats.signatureReads + 1);
			other.run("UPDATE narrator_messages SET sdk_message_uuid = 'final-uuid' WHERE id = 'shared'");
			const second = await loadModelHistorySource(backend, "fork");
			expect(second).not.toBe(first);
			expect(second.messages[0].messageUuid).toBe("final-uuid");
			other.run("UPDATE narrator_messages SET tokens_in = 50 WHERE id = 'shared'");
			expect(await loadModelHistorySource(backend, "fork")).toBe(second);
		} finally {
			clearInterval(timer);
		}
	});
	test("append/body/tool delta reuses immutable rows and reads only changed payloads; reorder rebuilds", async () => {
		const db = fixture(true);
		db.transaction(() => {
			for (let index = 0; index < 250; index++) message(db, `m${index}`, index, "x".repeat(1000));
			for (let index = 0; index < 10; index++)
				db.query(
					"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,execution_attempt,created_at) VALUES (?,'owner','m200',?,'Read','{}',?,'success',1,'now')",
				).run(`tool${index}`, `use${index}`, JSON.stringify("output".repeat(7000)));
		})();
		const backend = { backend: "sqlite" as const, sqlite: db };
		const cold = await loadModelHistorySource(backend, "owner");
		message(db, "appended", 250);
		const appended = await loadModelHistorySource(backend, "owner");
		expect(appended.messages).toHaveLength(251);
		expect(appended.messages[0].contentJson).toBe(cold.messages[0].contentJson);
		expect(appended.counters.reusedBodies).toBe(250);
		expect(appended.counters.sourceBytes).toBeLessThan(cold.counters.sourceBytes / 1000);
		db.query("UPDATE narrator_tool_calls SET output_json=? WHERE id='tool3'").run(
			JSON.stringify("changed".repeat(6000)),
		);
		const toolChanged = await loadModelHistorySource(backend, "owner");
		expect(toolChanged.counters.bodyQueries).toBe(0);
		expect(toolChanged.counters.reusedBodies).toBe(251);
		expect(toolChanged.counters.reusedTools).toBe(9);
		expect(toolChanged.counters.sourceBytes).toBeLessThan(cold.counters.sourceBytes / 10);
		expect(
			toolChanged.messages[200].toolCalls.find((tool) => tool.id === "tool3")?.outputJson,
		).toBe("changed".repeat(6000));
		db.run(
			`UPDATE narrator_messages SET content_json='[{"type":"text","text":"body edit"}]' WHERE id='m10'`,
		);
		const bodyChanged = await loadModelHistorySource(backend, "owner");
		expect(bodyChanged.counters.bodyQueries).toBe(1);
		expect(bodyChanged.counters.reusedBodies).toBe(250);
		expect(bodyChanged.counters.reusedTools).toBe(10);
		db.run("UPDATE narrator_message_refs SET seq=999 WHERE message_id='m0'");
		const reordered = await loadModelHistorySource(backend, "owner");
		expect(reordered.counters.reusedBodies ?? 0).toBe(0);
		expect(reordered.messages.at(-1)?.id).toBe("m0");
	});
	test("a write landing between the signature and the read is labelled by the worker snapshot", async () => {
		const db = fixture(true);
		message(db, "first", 0);
		const restore = afterFirstSignature(() => {
			const writer = new Database(db.filename);
			try {
				message(writer, "late", 1);
			} finally {
				writer.close();
			}
		});
		try {
			const source = await loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner");
			expect(source.messages.map((row) => row.id)).toEqual(["first", "late"]);
			expect(await loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner")).toBe(source);
		} finally {
			restore();
		}
	});
	test("revision coverage lost before the snapshot fails instead of signing unversioned rows", async () => {
		const db = fixture(true);
		message(db, "shared", 0);
		const restore = afterFirstSignature(() => {
			const writer = new Database(db.filename);
			try {
				writer.run("DROP TRIGGER model_history_v3_tool_update");
			} finally {
				writer.close();
			}
		});
		try {
			await expect(
				loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner"),
			).rejects.toThrow("trust changed");
			expect(modelHistorySourceStats().cacheEntries).toBe(0);
		} finally {
			restore();
		}
	});
	test("an untrusted snapshot cannot be promoted when triggers return before the read", async () => {
		const db = fixture(true);
		message(db, "shared", 0);
		db.run(
			"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,created_at) VALUES ('tool','owner','shared','use','Read','{}','\"old\"','success','now')",
		);
		db.run("DROP TRIGGER model_history_v3_tool_update");
		// A second connection changes rows while coverage is disabled, then restores catalog
		// trust without a body/tool bump. The read started untrusted and must stay untrusted.
		const restore = afterFirstSignature(() => {
			const writer = new Database(db.filename);
			try {
				writer.run(`UPDATE narrator_tool_calls SET output_json='"new"' WHERE id='tool'`);
				const trigger = renderModelHistoryRevisionSql("sqlite")
					.split("--> statement-breakpoint")
					.find((statement) =>
						statement.trim().startsWith("CREATE TRIGGER model_history_v3_tool_update"),
					);
				if (!trigger) throw new Error("missing fixture trigger");
				writer.run(trigger);
			} finally {
				writer.close();
			}
		});
		try {
			const source = await loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner");
			expect(source.messages[0].toolCalls[0].modelRevision).toBe(0);
			expect(modelHistorySourceStats().cacheEntries).toBe(0);
		} finally {
			restore();
		}
	});
	test("JSON object overhead is rejected before parsing an oversized graph", async () => {
		const db = fixture(true);
		message(db, "graph", 0);
		const inner = `[${Array(6000).fill("{}").join(",")}]`;
		db.query("UPDATE narrator_messages SET content_json=? WHERE id='graph'").run(
			`[${Array(100).fill(inner).join(",")}]`,
		);
		await expect(
			loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner"),
		).rejects.toThrow(/remaining \d+ byte budget/);
		expect(modelHistorySourceStats().cacheEntries).toBe(0);
	});
	test("cancelled and unversioned sources never enter trusted cache", async () => {
		const db = fixture(true);
		message(db, "small", 0);
		const backend = { backend: "sqlite" as const, sqlite: db };
		await expect(
			loadModelHistorySource(backend, "owner", { signal: AbortSignal.abort() }),
		).rejects.toThrow();
		const controller = new AbortController();
		const pending = loadModelHistorySource(backend, "owner", { signal: controller.signal });
		const cancel = setTimeout(() => controller.abort(), 0);
		await expect(pending).rejects.toThrow("cancelled");
		clearTimeout(cancel);
		db.run("DROP TRIGGER model_history_v3_tool_update");
		expect(readSqliteModelHistorySignature(db, "owner").trusted).toBe(false);
		const first = await loadModelHistorySource(backend, "owner");
		expect(await loadModelHistorySource(backend, "owner")).not.toBe(first);
		expect(modelHistorySourceStats().cacheEntries).toBe(0);
	});
});

describe("hot source signature lifecycle", () => {
	let reload = 0;
	const reevaluate = (): Promise<typeof import("./model-history-source")> =>
		import(`./model-history-source.ts?reload=${++reload}`);
	test.each([
		`UPDATE narrator_messages SET content_json='[{"type":"text","text":"late-body"}]' WHERE id='shared'`,
		`UPDATE narrator_tool_calls SET output_json='"late-tool"' WHERE id='tool'`,
	])("a real reevaluation cold-reads once, then uses revisions to validate the new cache: %s", async (mutation) => {
		const db = fixture(true);
		message(db, "shared", 0);
		db.run(
			`INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,created_at) VALUES ('tool','owner','shared','use','Read','{}','"old"','success','now')`,
		);
		const backend = { backend: "sqlite" as const, sqlite: db };
		const source = await loadModelHistorySource(backend, "owner");
		const loadedBefore = modelHistorySourceStats().loads;
		const reloaded = await reevaluate();
		const warm = await reloaded.loadModelHistorySource(backend, "owner");
		expect(warm).not.toBe(source);
		expect(warm.messages).toEqual(source.messages);
		expect(reloaded.modelHistorySourceStats().loads).toBe(loadedBefore + 1);
		expect(await reloaded.loadModelHistorySource(backend, "owner")).toBe(warm);
		db.run(mutation);
		expect(await reloaded.loadModelHistorySource(backend, "owner")).not.toBe(warm);
	});
	test("legacy cache without metadata cold-reads and never stamps unknown stale source", async () => {
		const db = fixture(true);
		message(db, "shared", 0);
		const backend = { backend: "sqlite" as const, sqlite: db };
		const source = await loadModelHistorySource(backend, "owner");
		const unknown = {
			...source,
			messages: source.messages.map((row) => ({
				...row,
				contentJson: [{ type: "text", text: "stale legacy body" }],
			})),
		};
		const legacyKey = Symbol.for("narrator.modelHistorySource.v1");
		const legacyCache = new Map([["stale", unknown]]);
		Reflect.set(globalThis, legacyKey, { cache: legacyCache });
		const reloaded = await reevaluate();
		expect(legacyCache.size).toBe(0);
		expect(Reflect.has(globalThis, legacyKey)).toBe(false);
		const before = reloaded.modelHistorySourceStats();
		const current = await reloaded.loadModelHistorySource(backend, "owner");
		expect(current).not.toBe(unknown);
		expect(current.messages[0].contentJson).toEqual([{ type: "text", text: "shared" }]);
		expect(current.counters.reusedBodies ?? 0).toBe(0);
		expect(reloaded.modelHistorySourceStats().loads).toBe(before.loads + 1);
		expect(reloaded.modelHistorySourceStats().signatureReads).toBe(before.signatureReads + 1);
	});
	test("reloaded warm hits preserve caller cancellation", async () => {
		const db = fixture(true);
		message(db, "shared", 0);
		const backend = { backend: "sqlite" as const, sqlite: db };
		await loadModelHistorySource(backend, "owner");
		const reloaded = await reevaluate();
		await expect(
			reloaded.loadModelHistorySource(backend, "owner", { signal: AbortSignal.abort() }),
		).rejects.toThrow();
		expect((await reloaded.loadModelHistorySource(backend, "owner")).messages).toHaveLength(1);
	});
});

test("source LRU has only a 64MiB budget, accounts for empty entries and retains one revision", () => {
	const cache = new ModelHistorySourceCache();
	const source: Awaited<ReturnType<typeof queryModelHistory>> = {
		messages: [],
		counters: {
			refQueries: 0,
			bodyQueries: 0,
			toolQueries: 0,
			refs: 0,
			toolRows: 0,
			sourceBytes: 0,
			maxRefsPerQuery: 0,
			maxBodyBatchBytes: 0,
			maxToolBatchBytes: 0,
			preparedBytes: 0,
		},
	};
	const signature = { revision: "1", catalogIdentity: "catalog" };
	const MiB = 1024 * 1024;
	cache.set("large", source, signature, 20 * MiB);
	expect(cache.get("large", signature)).toBe(source);
	for (let index = 0; index < 12; index++) cache.set(`empty-${index}`, source, signature, 0);
	expect(cache.size).toBe(13);
	expect(cache.retainedBytes).toBeGreaterThan(20 * MiB + 13 * 1024);
	cache.clear();
	cache.set("a", source, signature, 24 * MiB);
	cache.set("b", source, signature, 24 * MiB);
	expect(cache.get("a", signature)).toBe(source);
	cache.set("c", source, signature, 24 * MiB);
	expect(cache.get("b", signature)).toBeUndefined();
	expect(cache.get("a", signature)).toBe(source);
	expect(cache.retainedBytes).toBeLessThanOrEqual(64 * MiB);
	const replacement = { ...source, compactSeq: 1 };
	const next = { ...signature, revision: "2" };
	cache.set("a", replacement, next, 24 * MiB);
	expect(cache.size).toBe(2);
	expect(cache.get("a", signature)).toBeUndefined();
	expect(cache.get("a", next)).toBe(replacement);
	expect(cache.previous("a", signature.catalogIdentity)).toBe(replacement);
	expect(cache.previous("a", "different-catalog")).toBeUndefined();
	cache.set("a", source, next, 65 * MiB);
	expect(cache.previous("a", signature.catalogIdentity)).toBeUndefined();
	cache.clear();
	for (let index = 0; index < 70_000; index++) cache.set(`empty-${index}`, source, signature, 0);
	expect(cache.size).toBeLessThan(70_000);
	expect(cache.retainedBytes).toBeLessThanOrEqual(64 * MiB);
	expect(cache.get("empty-0", signature)).toBeUndefined();
	expect(cache.get("empty-69999", signature)).toBe(source);
	cache.clear();
	expect(cache.size).toBe(0);
	expect(cache.retainedBytes).toBe(0);
});

test.each([
	{ rawMiB: 2.5, cached: true },
	{ rawMiB: 9, cached: false },
])("real source of $rawMiB MiB text completes with cache admission=$cached", async ({
	rawMiB,
	cached,
}) => {
	const db = fixture(true);
	message(db, "large", 0, "x".repeat(rawMiB * 1024 * 1024));
	const backend = { backend: "sqlite" as const, sqlite: db };
	const first = await loadModelHistorySource(backend, "owner");
	expect(first.counters.preparedBytes).toBeGreaterThan(16 * 1024 * 1024);
	if (cached) expect(first.counters.preparedBytes).toBeLessThan(64 * 1024 * 1024);
	else expect(first.counters.preparedBytes).toBeGreaterThan(64 * 1024 * 1024);
	const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
	try {
		const second = await loadModelHistorySource(backend, "owner");
		expect(second === first).toBe(cached);
		expect(second.messages[0].contentText).toBe(first.messages[0].contentText);
		expect(modelHistorySourceStats().cacheEntries).toBe(cached ? 1 : 0);
	} finally {
		clock.mockRestore();
	}
});

test("SQLite rechecks trigger/contract qualification only after schema_version changes", () => {
	const db = fixture(true);
	message(db, "shared", 0);
	const other = new Database(db.filename);
	connections.push(other);
	const trigger = db
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='model_history_v3_tool_update'",
		)
		.get();
	if (!trigger) throw new Error("Fixture trigger is missing");
	const query = spyOn(db, "query");
	const qualifications = () =>
		query.mock.calls.filter(([sql]) => sql.includes("FROM sqlite_schema")).length;
	try {
		const first = readSqliteModelHistorySignature(db, "owner");
		expect(first.trusted).toBe(true);
		expect(readSqliteModelHistorySignature(db, "owner")).toEqual(first);
		expect(readSqliteModelHistorySignature(db, "fork").trusted).toBe(true);
		expect(qualifications()).toBe(1);
		other.run("UPDATE narrator_messages SET content_text='changed' WHERE id='shared'");
		expect(readSqliteModelHistorySignature(db, "owner").revision).not.toBe(first.revision);
		expect(qualifications()).toBe(1);
		other.run("DROP TRIGGER model_history_v3_tool_update");
		const dropped = readSqliteModelHistorySignature(db, "owner");
		expect(dropped.trusted).toBe(false);
		expect(dropped.catalogIdentity).not.toBe(first.catalogIdentity);
		expect(qualifications()).toBe(2);
		other.run(trigger.sql);
		expect(readSqliteModelHistorySignature(db, "owner").trusted).toBe(true);
		expect(qualifications()).toBe(3);
	} finally {
		query.mockRestore();
	}
});

test("transactional revisions cover shared bodies, final UUID, reorder/compact/segment, tool attempts and authors; not usage", () => {
	const db = fixture();
	message(db, "shared", 0);
	db.run(
		"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('fork:shared','fork','shared',0)",
	);
	db.run(
		"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,input_json,output_json,status,execution_attempt,created_at) VALUES ('tool','owner','shared','use','Read','{}','null','pending',1,'now')",
	);
	for (const mutation of [
		'UPDATE narrator_messages SET content_json = \'[{"type":"text","text":"edited"}]\' WHERE id = \'shared\'',
		"UPDATE narrator_messages SET sdk_message_uuid = 'final' WHERE id = 'shared'",
		"UPDATE narrator_tool_calls SET input_json = '{\"path\":\"new\"}', status = 'running', execution_attempt = 2 WHERE id = 'tool'",
		"UPDATE narrator_tool_calls SET output_json = '\"result\"', status = 'success' WHERE id = 'tool'",
		"UPDATE users SET username = 'Bob' WHERE id = 'human'",
		"UPDATE narrators SET title = 'New owner' WHERE id = 'owner'",
	]) {
		const before = [revision(db), revision(db, "fork")];
		db.run(mutation);
		expect(Number(revision(db))).toBeGreaterThan(Number(before[0]));
		expect(Number(revision(db, "fork"))).toBeGreaterThan(Number(before[1]));
	}
	for (const mutation of ["seq = 2", "is_compact = 1", "segment_compact_id = 'compact'"]) {
		const before = revision(db, "fork");
		db.run(`UPDATE narrator_message_refs SET ${mutation} WHERE id = 'fork:shared'`);
		expect(revision(db, "fork")).not.toBe(before);
	}
	const before = revision(db);
	db.run("UPDATE narrator_messages SET tokens_in = 123 WHERE id = 'shared'");
	db.run("UPDATE narrator_tool_calls SET input_tokens = 234 WHERE id = 'tool'");
	expect(revision(db)).toBe(before);
	const body = db
		.query<{ body_revision: number }, []>(
			"SELECT body_revision FROM narrator_messages WHERE id='shared'",
		)
		.get();
	expect(body?.body_revision).toBe(3);
	const original = revision(db);
	try {
		db.transaction(() => {
			db.run("UPDATE narrator_messages SET sdk_message_uuid='rollback' WHERE id='shared'");
			throw new Error("rollback");
		})();
	} catch {}
	expect(revision(db)).toBe(original);
});

test("compiled runtimes probe every worker path shape, source runtimes resolve the development path", () => {
	expect(modelHistoryWorkerSpecifiers(true, "file:///$bunfs/root/narrafork.exe")).toEqual([
		"file:///$bunfs/root/services/agent-runtime/model-history-worker.js",
		"file:///$bunfs/root/server/services/agent-runtime/model-history-worker.js",
		"file:///$bunfs/root/model-history-worker.js",
	]);
	expect(
		modelHistoryWorkerSpecifiers(
			false,
			"file:///repo/server/services/agent-runtime/model-history-source.ts",
		),
	).toEqual(["file:///repo/server/services/agent-runtime/model-history-worker.ts"]);
});

function observeSlowTimers(advance?: () => void) {
	// Spy on the call signature, not Node's additional setTimeout.__promisify__ property.
	const timerGlobal = globalThis as unknown as {
		setTimeout: (
			handler: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) => ReturnType<typeof setTimeout>;
	};
	const realTimeout = timerGlobal.setTimeout;
	const timers: Array<ReturnType<typeof setTimeout>> = [];
	const fire: Array<() => void> = [];
	const spy = spyOn(timerGlobal, "setTimeout").mockImplementation((handler, delay, ...args) => {
		// Readiness has the same production budget but is a separate failure boundary.
		if (delay !== 10_000 || handler.name !== "warnIfSlow")
			return realTimeout(handler, delay, ...args);
		const callback = () => handler(...args);
		fire.push(callback);
		const timer = realTimeout(
			() => {
				advance?.();
				callback();
			},
			advance ? 0 : delay,
		);
		timers.push(timer);
		return timer;
	});
	return { timers, fire, restore: () => spy.mockRestore() };
}

describe("slow history diagnostics and worker admission", () => {
	test.each([
		false,
		true,
	])("a warning while reading never rejects the request (sink throws: %s)", async (sinkThrows) => {
		const db = fixture(true);
		message(db, "only", 0);
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const warn = spyOn(logger, "warn").mockImplementation(() => {
			if (sinkThrows) throw new Error("logging sink failed");
		});
		const timers = observeSlowTimers(() => {
			now += 10_001;
		});
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			const source = await loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner");
			expect(source.messages).toHaveLength(1);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][1]).toMatchObject({ narratorId: "owner", phase: "worker" });
			expect(timers.timers).toHaveLength(1);
			expect(clear).toHaveBeenCalledWith(timers.timers[0]);
		} finally {
			clear.mockRestore();
			timers.restore();
			warn.mockRestore();
			clock.mockRestore();
		}
	});
	test.each([
		"success",
		"cancel",
		"failure",
	] as const)("fast %s clears the warning timer without warning", async (mode) => {
		const db = fixture(true);
		message(db, "only", 0);
		if (mode === "failure") db.run("DROP TABLE narrator_message_refs");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const timers = observeSlowTimers();
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			const pending = loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner", {
				signal: mode === "cancel" ? AbortSignal.abort(new Error("cancel before read")) : undefined,
			});
			if (mode === "success") expect((await pending).messages).toHaveLength(1);
			else
				await expect(pending).rejects.toThrow(
					mode === "cancel" ? "cancel before read" : "worker failed",
				);
			expect(warn).not.toHaveBeenCalled();
			expect(timers.timers).toHaveLength(1);
			expect(clear).toHaveBeenCalledWith(timers.timers[0]);
			expect(modelHistorySourceStats().workers).toBe(0);
		} finally {
			clear.mockRestore();
			timers.restore();
			warn.mockRestore();
		}
	});
	test("queued readers are warned, cancelled and awakened without polling or leaking slots", async () => {
		const db = fixture(true);
		message(db, "only", 0);
		const backend = { backend: "sqlite" as const, sqlite: db };
		const all = new AbortController();
		const cancelled = new AbortController();
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const timers = observeSlowTimers();
		const sleep = spyOn(Bun, "sleep");
		const RealWorker = globalThis.Worker;
		const releaseRequests: Array<() => void> = [];
		const second = Promise.withResolvers<void>();
		const third = Promise.withResolvers<void>();
		const worker = spyOn(workerGlobal, "Worker").mockImplementation((specifier, options) => {
			const instance = new RealWorker(specifier, options);
			const dispatch = instance.postMessage.bind(instance);
			spyOn(instance, "postMessage").mockImplementation((message) => {
				if (message && "narratorId" in message) {
					releaseRequests.push(() => dispatch(message));
					if (releaseRequests.length === 2) second.resolve();
					if (releaseRequests.length === 3) third.resolve();
				} else dispatch(message);
			});
			return instance;
		});
		const pending: Array<ReturnType<typeof loadModelHistorySource>> = [];
		const load = (id: string, signal = all.signal) => {
			const result = loadModelHistorySource(backend, id, { limit: 1, signal });
			void result.catch(() => {});
			pending.push(result);
			return result;
		};
		try {
			const first = load("owner");
			const other = load("fork");
			await second.promise;
			const dropped = load("other", cancelled.signal);
			const next = load("owner");
			await Promise.resolve();
			expect(modelHistorySourceStats()).toMatchObject({ workers: 2, queued: 2 });
			now += 10_001;
			timers.fire[2]();
			cancelled.abort(new Error("cancel queued reader"));
			await expect(dropped).rejects.toThrow("cancel queued reader");
			expect(modelHistorySourceStats()).toMatchObject({ workers: 2, queued: 1 });
			releaseRequests[0]();
			await third.promise;
			expect(modelHistorySourceStats()).toMatchObject({ workers: 2, queued: 0 });
			releaseRequests[1]();
			releaseRequests[2]();
			await Promise.all([first, other, next]);
			expect(worker).toHaveBeenCalledTimes(3);
			expect(sleep).not.toHaveBeenCalledWith(1);
			expect(modelHistorySourceStats()).toMatchObject({ workers: 0, queued: 0 });
			const queuedWarnings = warn.mock.calls.filter(([, data]) => data?.narratorId === "other");
			expect(queuedWarnings).toHaveLength(1);
			expect(queuedWarnings[0][1]).toMatchObject({ phase: "queue", elapsedMs: 10_001 });
		} finally {
			all.abort();
			cancelled.abort();
			await Promise.allSettled(pending);
			worker.mockRestore();
			sleep.mockRestore();
			timers.restore();
			warn.mockRestore();
			clock.mockRestore();
		}
	});
});
