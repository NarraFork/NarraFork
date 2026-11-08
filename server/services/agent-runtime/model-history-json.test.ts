import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { DisplayJsonAllocationBudget } from "../../lib/db-worker/display-page-json-budget";
import { DISPLAY_PAGE_LIMITS } from "../../lib/db-worker/display-page-protocol";
import { modelHistoryManifest, queryModelHistoryDelta } from "./model-history-delta";
import { modelHistoryFixtureSql } from "./model-history-fixture";
import {
	ModelHistoryBudget,
	ModelJsonBudgetError,
	measureModelJsonShape,
} from "./model-history-json";
import { assembleBlockBodies, queryModelHistory, sqliteHistoryQuery } from "./model-history-query";
import { freezeModelHistorySource } from "./model-history-source";

describe("pre-parse graph allocation budget", () => {
	test("counts scalar slots and property slots, not punctuation within escaped strings", () => {
		const shape = measureModelJsonShape('[0,0,{"a":0,"b":"[,{}:\\"", "c":[1,2]}]', {});
		expect(shape).toEqual({
			containers: 3,
			slots: 8,
			maxContainerSlots: 3,
			bytes: 3 * 256 + 8 * 32,
		});
		expect(measureModelJsonShape("[]").slots).toBe(0);
		expect(measureModelJsonShape("{}").slots).toBe(0);
	});
	test("dense primitive arrays and wide objects fail BEFORE the production loader invokes JSON.parse", async () => {
		for (const raw of [
			`[${Array(2000).fill("0").join(",")}]`,
			JSON.stringify(
				Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`k${index}`, 0])),
			),
		]) {
			const db = new Database(":memory:");
			db.run(modelHistoryFixtureSql);
			db.run("INSERT INTO narrators (id) VALUES ('owner')");
			db.query(
				"INSERT INTO narrator_messages (id,narrator_id,role,content_json) VALUES ('m','owner','assistant',?)",
			).run(raw);
			db.run(
				"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('ref','owner','m',0)",
			);
			const parse = spyOn(JSON, "parse");
			try {
				await expect(
					queryModelHistory(sqliteHistoryQuery(db), {
						narratorId: "owner",
						maxBytes: 48_000,
					}),
				).rejects.toThrow(/remaining \d+ byte budget/);
				expect(parse).not.toHaveBeenCalled();
			} finally {
				parse.mockRestore();
				db.close();
			}
		}
	});
	test("single-container width fails even when wire/graph byte totals are small", () => {
		for (const raw of ["[0,0,0]", '{"a":0,"b":0,"c":0}'])
			expect(() => measureModelJsonShape(raw, { maxContainerSlots: 2 })).toThrow("container width");
		const escaped = JSON.stringify({ text: ",{}[]:\\".repeat(20_000) });
		expect(measureModelJsonShape(escaped, { maxContainerSlots: 2 }).slots).toBe(1);
	});
	test("accepted primitive slots yield to heartbeat without Object.values giant copies", async () => {
		const graph = {
			arrays: Array.from({ length: 20 }, () => Array(8192).fill(0)),
			wide: Object.fromEntries(Array.from({ length: 12_000 }, (_, index) => [`k${index}`, 0])),
		};
		expect(measureModelJsonShape(JSON.stringify(graph)).bytes).toBeLessThan(128 * 1024 * 1024);
		const values = spyOn(Object, "values").mockImplementation(() => {
			throw new Error("Object.values is forbidden while freezing");
		});
		let heartbeat = 0;
		const timer = setInterval(() => heartbeat++, 1);
		try {
			await freezeModelHistorySource(graph);
			expect(heartbeat).toBeGreaterThan(0);
			expect(Object.isFrozen(graph.arrays[0])).toBe(true);
			expect(Object.isFrozen(graph.wide)).toBe(true);
		} finally {
			clearInterval(timer);
			values.mockRestore();
		}
	});
});

describe("scanner checks belong to the caller", () => {
	test("allocation scanning does not read the clock", () => {
		const clock = spyOn(Date, "now").mockImplementation(() => {
			throw new Error("The allocation scanner must not own a time limit");
		});
		try {
			expect(measureModelJsonShape(JSON.stringify({ text: "x".repeat(40_000) })).slots).toBe(1);
			expect(clock).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});
	test("periodic caller cancellation is propagated without becoming a budget error", () => {
		const controller = new AbortController();
		const cancelled = new Error("caller cancelled the scan");
		let checks = 0;
		expect(() =>
			measureModelJsonShape(JSON.stringify({ text: "x".repeat(40_000) }), {
				check: () => {
					if (++checks === 2) controller.abort(cancelled);
					controller.signal.throwIfAborted();
				},
			}),
		).toThrow(cancelled);
		expect(checks).toBe(2);
	});
	test("allocation and width failures remain identifiable", () => {
		expect(() => measureModelJsonShape("[0]", { maxBytes: 1 })).toThrow(ModelJsonBudgetError);
		expect(() => measureModelJsonShape("[0,0]", { maxContainerSlots: 1 })).toThrow(
			ModelJsonBudgetError,
		);
	});
});

function queryFixture(): Database {
	const db = new Database(":memory:");
	db.run(modelHistoryFixtureSql);
	db.run("INSERT INTO narrators (id) VALUES ('owner')");
	db.query(
		"INSERT INTO narrator_messages (id,narrator_id,role,content_json) VALUES ('m','owner','assistant',?)",
	).run(JSON.stringify([{ type: "text", text: "history" }]));
	db.run(
		"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('ref','owner','m',0)",
	);
	return db;
}

describe("model queries remain bounded and cancellable without a time cutoff", () => {
	test("cold and delta reads complete across clock jumps beyond the former budget", async () => {
		const db = queryFixture();
		const base = sqliteHistoryQuery(db);
		let now = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const query = async <T>(statement: string, parameters?: unknown[]): Promise<T[]> => {
			now += 20_000;
			return base<T>(statement, parameters);
		};
		try {
			const source = await queryModelHistory(query, { narratorId: "owner" });
			expect(source.messages[0].contentJson).toEqual([{ type: "text", text: "history" }]);
			const pages: unknown[] = [];
			const delta = await queryModelHistoryDelta(
				query,
				{ narratorId: "owner" },
				modelHistoryManifest(source),
				async (page) => {
					pages.push(page);
				},
			);
			expect(delta.counters.reusedBodies).toBe(1);
			expect(pages).toContainEqual({ type: "reuseBodies", ids: ["m"] });
			expect(now).toBeGreaterThan(10_000);
		} finally {
			clock.mockRestore();
			db.close();
		}
	});
	test.each([
		"cold",
		"delta",
	] as const)("%s read stops when cancelled during a query", async (mode) => {
		const db = queryFixture();
		try {
			const base = sqliteHistoryQuery(db);
			const source = await queryModelHistory(base, { narratorId: "owner" });
			const controller = new AbortController();
			const cancelled = new Error("cancel during model query");
			let queries = 0;
			const query = async <T>(statement: string, parameters?: unknown[]): Promise<T[]> => {
				queries++;
				const rows = await base<T>(statement, parameters);
				controller.abort(cancelled);
				return rows;
			};
			const options = { narratorId: "owner", signal: controller.signal };
			const pending =
				mode === "cold"
					? queryModelHistory(query, options)
					: queryModelHistoryDelta(query, options, modelHistoryManifest(source), async () => {});
			await expect(pending).rejects.toBe(cancelled);
			expect(queries).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("display pages retain their own deadline and error classification", () => {
	test("a deadline reached inside the shared scanner remains a display deadline", () => {
		const clock = spyOn(Date, "now").mockReturnValue(0);
		try {
			const budget = new DisplayJsonAllocationBudget(1024, 10_000);
			// reserveJson's entry check passes; the scanner's first check sees the expired deadline.
			clock.mockReturnValueOnce(0).mockReturnValue(20_000);
			let failure: unknown;
			try {
				budget.reserveJson("[0]");
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: "DISPLAY_PAGE_DEADLINE" });
		} finally {
			clock.mockRestore();
		}
	});
	test("only real allocation/width failures become display budget errors", () => {
		for (const [ceiling, raw] of [
			[256, "[0]"],
			[
				128 * 1024 * 1024,
				`[${Array(DISPLAY_PAGE_LIMITS.maxContainerSlots + 1)
					.fill("0")
					.join(",")}]`,
			],
		] as const) {
			const budget = new DisplayJsonAllocationBudget(ceiling, Date.now() + 60_000);
			let failure: unknown;
			try {
				budget.reserveJson(raw);
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: "DISPLAY_PAGE_BUDGET_EXCEEDED" });
		}
	});
	test("a scanner ReferenceError is not relabelled as oversized history", () => {
		const budget = new DisplayJsonAllocationBudget(1024, Date.now() + 60_000);
		const failure = new ReferenceError("scanner implementation failed");
		const read = spyOn(String.prototype, "charCodeAt").mockImplementation(() => {
			throw failure;
		});
		try {
			let caught: unknown;
			try {
				budget.reserveJson("[0]");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(failure);
		} finally {
			read.mockRestore();
		}
	});
});

describe("one allocation ledger before every parse", () => {
	const blockCases = [
		["payload then state", [{ messageId: "m", payload: "[0]", state: "[0]" }]],
		[
			"two blocks in one message",
			[
				{ messageId: "m", payload: "[0]", state: null },
				{ messageId: "m", payload: "[0]", state: null },
			],
		],
		[
			"blocks in different messages",
			[
				{ messageId: "m", payload: "[0]", state: null },
				{ messageId: "n", payload: "[0]", state: null },
			],
		],
	] as const;
	for (const [name, rows] of blockCases) {
		test(`${name}: a second 288-byte graph cannot use the same remaining 300 bytes`, async () => {
			const budget = new ModelHistoryBudget(300);
			const parse = spyOn(JSON, "parse");
			try {
				await expect(
					assembleBlockBodies(async <T>() => [...rows] as T[], ["m", "n"], budget),
				).rejects.toThrow("remaining 12 byte budget");
				expect(parse).toHaveBeenCalledTimes(1);
				expect(parse).toHaveBeenCalledWith("[0]");
				expect(budget.preparedBytes).toBe(288);
			} finally {
				parse.mockRestore();
			}
		});
	}

	test("budget errors name the actual estimate and preserve parse/cancellation errors", () => {
		const budget = new ModelHistoryBudget(1200);
		budget.reserve(40, 1);
		expect(budget.preparedBytes).toBe(1184);
		expect(() => budget.reserve(5)).toThrow("estimated 1200 byte budget");
		expect(() => new ModelHistoryBudget(1024).parse("invalid JSON")).toThrow(SyntaxError);
		const controller = new AbortController();
		const reason = new Error("cancel before parsing");
		controller.abort(reason);
		expect(() => new ModelHistoryBudget(1024, controller.signal).parse("{}")).toThrow(reason);
	});

	test("cold block loading charges state before parsing it and does not charge assembled costs twice", async () => {
		const db = queryFixture();
		const payload = JSON.stringify({ raw: [{ type: "text", text: "hello" }] });
		const state = JSON.stringify({ raw: [{ finished: true }] });
		const rawBytes = Buffer.byteLength(payload) + Buffer.byteLength(state);
		const graphBytes = measureModelJsonShape(payload).bytes + measureModelJsonShape(state).bytes;
		db.query(
			"UPDATE narrator_messages SET body_format=2,body_bytes=?,content_json=NULL WHERE id='m'",
		).run(rawBytes);
		db.query(
			"INSERT INTO narrator_blocks (id,message_id,ordinal,kind,payload,state) VALUES ('b','m',0,'text',?,?)",
		).run(payload, state);
		const expected = 1024 + rawBytes * 4 + graphBytes;
		const parse = spyOn(JSON, "parse");
		try {
			await expect(
				queryModelHistory(sqliteHistoryQuery(db), {
					narratorId: "owner",
					bodiesFromBlocks: true,
					maxBytes: expected - 1,
				}),
			).rejects.toThrow(/byte budget/);
			expect(parse).toHaveBeenCalledTimes(1);
			expect(parse).toHaveBeenCalledWith(payload);
			parse.mockClear();
			const source = await queryModelHistory(sqliteHistoryQuery(db), {
				narratorId: "owner",
				bodiesFromBlocks: true,
				maxBytes: expected,
			});
			expect(parse).toHaveBeenCalledTimes(2);
			expect(source.counters.preparedBytes).toBe(expected);
			expect(source.messages[0].rawBytes).toBe(rawBytes);
			expect(source.messages[0].contentJson).toEqual([
				{ type: "text", text: "hello", finished: true },
			]);
		} finally {
			parse.mockRestore();
			db.close();
		}
	});
});

describe("cold metadata and stored-byte accounting", () => {
	test("200 tools of 100KB consume 200 metadata rows rather than refetching each batch tail", async () => {
		const db = queryFixture();
		try {
			const output = JSON.stringify("x".repeat(100_000));
			const insert = db.query(
				"INSERT INTO narrator_tool_calls (id,message_id,tool_use_id,tool_name,input_json,output_json,status) VALUES (?,'m',?,'Fixture','{}',?,'completed')",
			);
			db.transaction(() => {
				for (let index = 0; index < 200; index++) {
					const id = `tool-${String(index).padStart(3, "0")}`;
					insert.run(id, id, output);
				}
			})();
			const base = sqliteHistoryQuery(db);
			let metadataRows = 0;
			let metadataQueries = 0;
			const query = async <T>(statement: string, parameters?: unknown[]): Promise<T[]> => {
				const rows = await base<T>(statement, parameters);
				if (statement.includes("FROM narrator_tool_calls") && statement.includes(" AS bytes")) {
					metadataRows += rows.length;
					metadataQueries++;
				}
				return rows;
			};
			const source = await queryModelHistory(query, { narratorId: "owner" });
			expect(metadataRows).toBe(200);
			expect(metadataQueries).toBe(2);
			expect(source.counters.toolRows).toBe(200);
			expect(source.counters.toolQueries).toBe(7);
			expect(source.messages[0].toolCalls.map((tool) => tool.id)).toEqual(
				Array.from({ length: 200 }, (_, index) => `tool-${String(index).padStart(3, "0")}`),
			);
			expect(
				source.messages[0].toolCalls.every(
					(tool) => tool.rawBytes === Buffer.byteLength(output) + 2,
				),
			).toBe(true);
		} finally {
			db.close();
		}
	});

	test("UTF-8, embedded NUL, empty JSON strings and NULL fields retain their exact stored costs", async () => {
		const db = queryFixture();
		const text = "中文\u0000尾";
		const input = JSON.stringify({ name: "中文", zero: "\u0000" });
		try {
			db.query("UPDATE narrator_messages SET content_json=NULL,content_text=? WHERE id='m'").run(
				text,
			);
			db.query(
				"INSERT INTO narrator_tool_calls (id,message_id,input_json,output_json) VALUES ('a','m',?,?)",
			).run(input, JSON.stringify(""));
			db.run(
				"INSERT INTO narrator_tool_calls (id,message_id,input_json,output_json) VALUES ('b','m',NULL,NULL)",
			);
			const source = await queryModelHistory(sqliteHistoryQuery(db), { narratorId: "owner" });
			const expected = Buffer.byteLength(text) + Buffer.byteLength(input) + 2;
			expect(source.messages[0].rawBytes).toBe(Buffer.byteLength(text));
			expect(source.messages[0].toolCalls.map((tool) => tool.rawBytes)).toEqual([
				Buffer.byteLength(input) + 2,
				0,
			]);
			expect(source.messages[0].toolCalls[0].outputJson).toBe("");
			expect(source.messages[0].toolCalls[1].inputJson).toBeNull();
			expect(source.counters.sourceBytes).toBe(expected);
			expect(source.counters.preparedBytes).toBe(
				expected * 4 + 3 * 1024 + measureModelJsonShape(input).bytes,
			);
		} finally {
			db.close();
		}
	});
});

test("model histories accept wide containers within their allocation estimate", () => {
	const raw = `[${Array(20_000).fill("0").join(",")}]`;
	const budget = new ModelHistoryBudget(1024 * 1024);
	expect(budget.parse(raw).value).toHaveLength(20_000);
	expect(budget.preparedBytes).toBe(256 + 20_000 * 32);
	const display = new DisplayJsonAllocationBudget(1024 * 1024, Date.now() + 60_000);
	expect(() => display.reserveJson(raw)).toThrow();
});

test("the explicit freeze probe visits children under a shallow-frozen parent", async () => {
	const child = { values: [1, 2] };
	const root = Object.freeze({ child });
	await freezeModelHistorySource(root);
	expect(Object.isFrozen(child)).toBe(true);
	expect(Object.isFrozen(child.values)).toBe(true);
});
