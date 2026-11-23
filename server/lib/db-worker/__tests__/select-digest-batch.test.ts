import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSelectDigestBatch } from "../../../db/worker-read";
import { drainDbWorkerPool, resetDbWorkerPoolForTest, runReadTask } from "../pool";
import type { SelectDigestBatchEntry, SelectDigestBatchParams } from "../protocol";
import {
	runSelectDigestBatch,
	sourceRowsCommitment,
	validateSelectDigestBatchResult,
} from "../select-digest-batch";

let home: string, path: string, writer: Database;
const strict = { executionPolicy: "worker-required" as const };
const query = "SELECT id, body FROM items ORDER BY id";
function observation(ordinal = 0, sql = query): SelectDigestBatchEntry {
	return { ordinal, query: sql, params: [], ...sourceRowsCommitment(writer.query(sql).all()) };
}
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "nf-select-digest-"));
	path = join(home, "fixture.db");
	writer = new Database(path);
	writer.run("PRAGMA journal_mode=WAL");
	writer.run("PRAGMA wal_autocheckpoint=0");
	writer.run("CREATE TABLE items(id INTEGER PRIMARY KEY, body TEXT)");
	resetDbWorkerPoolForTest();
});
afterEach(async () => {
	await drainDbWorkerPool({ timeoutMs: 20_000 });
	writer.close(true);
	rmSync(home, { recursive: true, force: true });
});

test("real worker verifies committed WAL using identical row JSON commitments without caller SELECT", async () => {
	await readSelectDigestBatch(writer, [], strict);
	writer.run("INSERT INTO items VALUES (1, 'private-one'), (2, '中文')");
	expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
	const entries = [observation(7), observation(19, "SELECT body, id FROM items ORDER BY id DESC")];
	const prepare = spyOn(writer, "prepare").mockImplementation(() => {
		throw new Error("Caller SELECT forbidden");
	});
	const nativeQuery = spyOn(writer, "query").mockImplementation(() => {
		throw new Error("Caller SELECT forbidden");
	});
	try {
		const result = await readSelectDigestBatch(writer, entries, strict);
		expect(result).toEqual({
			matches: true,
			entries: [
				{ ordinal: 7, matches: true },
				{ ordinal: 19, matches: true },
			],
		});
		expect(prepare).not.toHaveBeenCalled();
		expect(nativeQuery).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("private-one");
	} finally {
		prepare.mockRestore();
		nativeQuery.mockRestore();
	}
	writer.run("UPDATE items SET body='private-two' WHERE id=1");
	expect((await readSelectDigestBatch(writer, entries, strict)).matches).toBe(false);
});

test("empty sets remain verifiable and ordinal pairing is validated in both directions", async () => {
	expect(await readSelectDigestBatch(writer, [], strict)).toEqual({ matches: true, entries: [] });
	const empty = observation(4);
	expect((await readSelectDigestBatch(writer, [empty], strict)).matches).toBe(true);
	await expect(readSelectDigestBatch(writer, [empty, empty], strict)).rejects.toMatchObject({
		code: "DB_READ_INVALID",
	});
	const input: SelectDigestBatchParams = {
		kind: "selectDigestBatch",
		entries: [{ ...empty, params: [] }],
	};
	expect(() =>
		validateSelectDigestBatchResult(
			{ matches: true, entries: [{ ordinal: 5, matches: true }] },
			input,
		),
	).toThrow("ordinal");
	await expect(runReadTask(path, input, { dedupeKey: "forbidden" })).rejects.toMatchObject({
		code: "DB_READ_INVALID",
	});
});

test("a single real synchronous WAL snapshot spans all entries", () => {
	writer.run("INSERT INTO items VALUES (1, 'old')");
	const entries = [observation(1), observation(2)];
	const reader = new Database(path, { readonly: true });
	let prepares = 0,
		changed = false;
	const source = new Proxy(reader, {
		get(target, key) {
			if (key === "prepare")
				return (...args: Parameters<Database["prepare"]>) => {
					if (++prepares === 3) {
						writer.run("UPDATE items SET body='new' WHERE id=1");
						changed = true;
					}
					return Reflect.apply(target.prepare, target, args);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	try {
		expect(
			runSelectDigestBatch(
				source,
				{ kind: "selectDigestBatch", entries: entries.map((entry) => ({ ...entry, params: [] })) },
				new AbortController().signal,
				Date.now() + 5000,
			).matches,
		).toBe(true);
		expect(changed).toBe(true);
		expect(writer.query("SELECT body FROM items").get()).toEqual({ body: "new" });
	} finally {
		reader.close(true);
	}
});

test("SQL grammar stays enforced and aggregate SQL binds and batch count are observations", async () => {
	const original = observation();
	for (const sql of ["DELETE FROM items", "PRAGMA user_version", "SELECT 1; SELECT 2"]) {
		const failure = await readSelectDigestBatch(
			writer,
			[{ ...original, query: sql }],
			strict,
		).catch((error) => error);
		expect(failure).toMatchObject({ code: "DB_READ_INVALID" });
	}
	const wide = await readSelectDigestBatch(
		writer,
		Array.from({ length: 17 }, (_, ordinal) => ({ ...original, ordinal })),
		strict,
	);
	expect(wide.matches).toBe(true);
	expect(wide.entries).toHaveLength(17);
	const longSql = [0, 1].map((ordinal) =>
		observation(ordinal, `SELECT 1 AS value${" ".repeat(33_000)}`),
	);
	const sqlResult = await readSelectDigestBatch(writer, longSql, strict);
	expect(sqlResult.matches).toBe(true);
	const value = "x".repeat(70_000);
	const bound = [0, 1].map((ordinal) => ({
		ordinal,
		query: "SELECT ? AS value",
		params: [value],
		...sourceRowsCommitment([{ value }]),
	}));
	const boundResult = await readSelectDigestBatch(writer, bound, strict);
	expect(boundResult.matches).toBe(true);
	expect(boundResult).toEqual({
		matches: true,
		entries: [
			{ ordinal: 0, matches: true },
			{ ordinal: 1, matches: true },
		],
	});
});

test("cumulative row growth preserves mismatch detection above the shared row threshold", async () => {
	const frozen = observation(0);
	const insert = writer.prepare("INSERT INTO items VALUES (?, 'value')");
	try {
		writer.transaction(() => {
			for (let id = 1; id <= 6000; id++) insert.run(id);
		})();
	} finally {
		insert.finalize();
	}
	const changed = await readSelectDigestBatch(writer, [frozen, { ...frozen, ordinal: 1 }], strict);
	expect(changed).toEqual({
		matches: false,
		entries: [
			{ ordinal: 0, matches: false },
			{ ordinal: 1, matches: false },
		],
	});
	expect((await readSelectDigestBatch(writer, [observation(2)], strict)).matches).toBe(true);
});

test("caller cancellation stops a real batch without a caller-thread retry", async () => {
	await readSelectDigestBatch(writer, [], strict);
	const controller = new AbortController();
	const task = readSelectDigestBatch(
		writer,
		[
			{
				...observation(),
				query:
					"WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<3000000) SELECT sum(n) FROM t",
			},
		],
		{ ...strict, signal: controller.signal },
	).catch((error) => error);
	const timer = setTimeout(() => controller.abort(), 10);
	try {
		expect(await task).toMatchObject({ code: "DB_READ_ABORTED" });
	} finally {
		clearTimeout(timer);
	}
	expect((await readSelectDigestBatch(writer, [], strict)).matches).toBe(true);
});

test("current growth above cumulative bytes remains a genuine digest mismatch", async () => {
	writer.run("INSERT INTO items VALUES (1, 'small'), (2, 'small')");
	const entries = [
		observation(0, "SELECT body FROM items WHERE id=1"),
		observation(1, "SELECT body FROM items WHERE id=2"),
	];
	writer.run("UPDATE items SET body=?", ["x".repeat(2_200_000)]);
	const changed = await readSelectDigestBatch(writer, entries, strict);
	expect(changed.matches).toBe(false);
	const current = await readSelectDigestBatch(writer, [observation(0), observation(1)], strict);
	expect(current).toEqual({
		matches: true,
		entries: [
			{ ordinal: 0, matches: true },
			{ ordinal: 1, matches: true },
		],
	});
	expect(
		(
			await readSelectDigestBatch(
				writer,
				[observation(10, "SELECT body FROM items WHERE id=1")],
				strict,
			)
		).matches,
	).toBe(true);
});
