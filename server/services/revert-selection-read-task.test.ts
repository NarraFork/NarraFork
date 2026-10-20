import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTransactionTask } from "../db/worker-read";
import { shutdownDbWorkerPool } from "../lib/db-worker/pool";
import {
	type AssociationPageRow,
	executeRevertSelectionReadTask,
	type RevertSelectionReadTask,
	sourceRowsDigest,
} from "./revert-selection-read-task";

let root: string | undefined;
let connection: Database | undefined;
afterEach(async () => {
	await shutdownDbWorkerPool();
	connection?.close();
	if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	root = await mkdtemp(join(tmpdir(), "nf-selection-read-"));
	connection = new Database(join(root, "fixture.sqlite"));
	connection.exec(
		"PRAGMA journal_mode=WAL; CREATE TABLE source(id TEXT PRIMARY KEY,value TEXT); INSERT INTO source VALUES ('present','original')",
	);
	return connection;
}
async function worker<T = { checkedCount: number }>(
	database: Database,
	task: RevertSelectionReadTask,
	onChunk?: (rows: unknown[]) => void,
) {
	return readTransactionTask<T>(
		{ $client: database },
		task,
		() => {
			throw new Error("file read used main-thread fallback");
		},
		{ onChunk },
	);
}
test("association transport preserves an empty page and a single large row", async () => {
	const db = await fixture();
	const value = "文".repeat(110_000);
	db.run("UPDATE source SET value=?", [value]);
	const chunks: AssociationPageRow[] = [];
	const query =
		"SELECT value AS id,rowid AS cursor FROM source WHERE id=? AND rowid>? ORDER BY rowid LIMIT ?";
	const task: RevertSelectionReadTask = {
		kind: "revertSelectionReadV1",
		action: "associationPages",
		deadlineAt: Date.now() + 30_000,
		queries: [
			{ query, params: ["missing", 0, 33], stopOnRows: false },
			{ query, params: ["present", 0, 33], stopOnRows: false },
		],
	};
	expect(
		await worker<{ pageCount: number }>(db, task, (rows) =>
			chunks.push(...(rows as AssociationPageRow[])),
		),
	).toEqual({ pageCount: 2 });
	expect(chunks).toEqual([{ pageIndex: 1, row: { id: value, cursor: 1 } }]);
});
test("one worker batch verifies 32 ordered commitments including empty end pages", async () => {
	const db = await fixture();
	const commitments = Array.from({ length: 32 }, (_, index) => ({
		query: "SELECT id,value FROM source WHERE id=? LIMIT 1",
		params: [index === 0 ? "present" : `empty-${index}`],
		digest: sourceRowsDigest(index === 0 ? [{ id: "present", value: "original" }] : []),
	}));
	const task: RevertSelectionReadTask = {
		kind: "revertSelectionReadV1",
		action: "verify",
		commitments,
		deadlineAt: Date.now() + 30_000,
	};
	expect(await worker(db, task)).toEqual({ checkedCount: 32 });
	db.run("INSERT INTO source VALUES ('empty-31','new')");
	const failure = await worker(db, task).catch((error: unknown) => error);
	expect(failure).toMatchObject({
		code: "REVERT_SELECTION_STALE",
		message: "Selected source metadata changed during collection",
	});
});
test("bounded verification observes later committed changes and checks cancellation between queries", async () => {
	const db = await fixture();
	const other = new Database(db.filename);
	const controller = new AbortController();
	let reads = 0;
	let cancel = false;
	const proxy = new Proxy(db, {
		get(target, key) {
			if (key === "prepare")
				return (...args: Parameters<Database["prepare"]>) => {
					expect(target.inTransaction).toBe(false);
					if (++reads === 2) {
						if (cancel) controller.abort(new Error("cancel verification"));
						else other.run("UPDATE source SET value='outside' WHERE id='present'");
					}
					return Reflect.apply(target.prepare, target, args);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const entry = {
		query: "SELECT value FROM source WHERE id=? LIMIT 1",
		params: ["present"],
		digest: sourceRowsDigest([{ value: "original" }]),
	};
	const task: RevertSelectionReadTask = {
		kind: "revertSelectionReadV1",
		action: "verify",
		commitments: [entry, entry],
		deadlineAt: Date.now() + 30_000,
	};
	try {
		expect(() => executeRevertSelectionReadTask(proxy, task, controller.signal)).toThrow(
			"Selected source metadata changed during collection",
		);
		expect(db.inTransaction).toBe(false);
		cancel = true;
		reads = 0;
		entry.digest = sourceRowsDigest([{ value: "outside" }]);
		expect(() => executeRevertSelectionReadTask(proxy, task, controller.signal)).toThrow(
			"cancel verification",
		);
		expect(reads).toBe(2);
		expect(db.inTransaction).toBe(false);
	} finally {
		other.close();
	}
});
test("streaming digest matches original array encoding and ordering", () => {
	const rows = [
		{ id: "中文\n", n: 1, nil: null },
		{ blob: new Uint8Array([1, 2]), text: '\\quoted"' },
	];
	const original = createHash("sha256");
	for (const row of rows) original.update(JSON.stringify(row)).update("\n");
	function* source() {
		yield* rows;
	}
	expect(sourceRowsDigest(source())).toBe(original.digest("hex"));
	expect(sourceRowsDigest([])).toBe(createHash("sha256").digest("hex"));
});
test("batch count and existing collection deadline are enforced before queries", async () => {
	const db = await fixture();
	const entry = {
		query: "SELECT id FROM source WHERE id=? LIMIT 1",
		params: ["missing"],
		digest: sourceRowsDigest([]),
	};
	const signal = new AbortController().signal;
	expect(() =>
		executeRevertSelectionReadTask(
			db,
			{
				kind: "revertSelectionReadV1",
				action: "verify",
				commitments: Array.from({ length: 33 }, () => entry),
				deadlineAt: Date.now() + 30_000,
			},
			signal,
		),
	).toThrow("source commitments");
	expect(() =>
		executeRevertSelectionReadTask(
			db,
			{
				kind: "revertSelectionReadV1",
				action: "verify",
				commitments: [entry],
				deadlineAt: Date.now() - 1,
			},
			signal,
		),
	).toThrow("timed out");
});
