import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerPool from "../../../lib/db-worker/pool";

const realDbModule = { ...(await import("../../../db")) };
const home = mkdtempSync(join(tmpdir(), "outline-worker-read-"));
const file = new Database(join(home, "outline.db"));
const memory = new Database(":memory:");
const ROWS = 2_050;

/** Only the structure-read tables: no application bootstrap or live user database. */
function seed(sqlite: Database): void {
	sqlite.exec(`
		CREATE TABLE outline_blocks (
			id TEXT PRIMARY KEY, sid TEXT, parent_id TEXT, order_key TEXT, alias TEXT,
			task_json TEXT, version_seq INTEGER, ask_json TEXT, page_id TEXT, deleted INTEGER
		);
		CREATE TABLE outline_block_versions (
			block_id TEXT, parent_id TEXT, order_key TEXT, alias TEXT, task_json TEXT,
			from_seq INTEGER, ask_json TEXT, page_id TEXT, to_seq INTEGER, deleted INTEGER
		);
		CREATE INDEX blocks_page ON outline_blocks(page_id, deleted);
		CREATE INDEX versions_page ON outline_block_versions(page_id, from_seq);
	`);
	const block = sqlite.prepare(
		"INSERT INTO outline_blocks VALUES (?, ?, NULL, ?, NULL, NULL, 1, NULL, ?, 0)",
	);
	const version = sqlite.prepare(
		"INSERT INTO outline_block_versions VALUES (?, NULL, ?, NULL, NULL, 1, NULL, ?, NULL, 0)",
	);
	sqlite.transaction(() => {
		for (const [page, count] of [
			["large", ROWS],
			["small", 3],
		] as const) {
			for (let i = 0; i < count; i++) {
				block.run(`${page}-${i}`, `sid-${i}`, `key-${i}`, page);
				version.run(`${page}-${i}`, `key-${i}`, page);
			}
		}
	})();
}
file.exec("PRAGMA journal_mode = WAL");
seed(file);
seed(memory);
const bindConnection = (sqlite: Database) =>
	mock.module("../../../db", () => ({ ...realDbModule, sqlite }));
bindConnection(file);
const { MAIN_THREAD_PAGE_ROWS, sqliteOutlineReads } = await import("../store/sqlite-read");
const { readSubtree } = await import("../read");

let previousWorker: string | undefined;
let previousConcurrency: string | undefined;
beforeEach(() => {
	previousWorker = process.env.NARRAFORK_DB_WORKER;
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	workerPool.resetDbWorkerPoolForTest();
	bindConnection(file);
});
afterEach(() => {
	workerPool.resetDbWorkerPoolForTest();
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	bindConnection(file);
});
afterAll(() => {
	workerPool.shutdownDbWorkerPool();
	mock.module("../../../db", () => realDbModule);
	file.close();
	memory.close();
	rmSync(home, { recursive: true, force: true });
});

const failures: Array<[string, Error]> = [
	["disabled", new workerPool.WorkersUnavailableError("disabled_by_env")],
	["zero concurrency", new workerPool.WorkersUnavailableError("concurrency_zero")],
	["creation failure", new workerPool.WorkersUnavailableError("worker_spawn_failed")],
	["ready failure", new workerPool.WorkersUnavailableError("worker_unavailable")],
	["exit", new Error("database worker closed")],
	["timeout", new workerPool.DbReadTaskTimeoutError("database read task timed out")],
	["cancel", new Error("database read task aborted")],
	["pool shutdown", new workerPool.WorkersUnavailableError("pool_shutdown")],
];

test("upstream subtree reads surface the same worker error instead of retrying or returning an empty page", async () => {
	const error = new workerPool.WorkersUnavailableError("disabled_by_env");
	const worker = spyOn(workerPool, "runReadTask").mockRejectedValue(error);
	const main = spyOn(file, "query");
	const structure = mock(sqliteOutlineReads.listPageStructure);
	// Only these store methods are reached before the structure reader fails.
	const store = {
		...sqliteOutlineReads,
		listPageStructure: structure,
		getBlock: mock(async () => ({ spaceId: "space", pageId: "large", deleted: false })),
		getSpace: mock(async () => ({ id: "space", nextSeq: 2 })),
	} as unknown as import("../store/port").OutlineStore;
	try {
		await expect(readSubtree("large", { store })).rejects.toBe(error);
		expect(structure).toHaveBeenCalledTimes(1);
		expect(worker).toHaveBeenCalledTimes(1);
		expect(main).toHaveBeenCalledTimes(1);
	} finally {
		worker.mockRestore();
		main.mockRestore();
	}
});

for (const asOf of [null, 1]) {
	describe(`Outline structure isolation (${asOf === null ? "current" : "as of"})`, () => {
		for (const [failure, error] of failures) {
			test(`${failure} propagates without a second main-thread query`, async () => {
				const worker = spyOn(workerPool, "runReadTask").mockRejectedValue(error);
				const main = spyOn(file, "query");
				try {
					await expect(
						sqliteOutlineReads.listPageStructure("large", { asOf, limit: 10_000 }),
					).rejects.toBe(error);
					expect(worker).toHaveBeenCalledTimes(1);
					expect(worker.mock.calls[0]?.[1]).toMatchObject({ kind: "selectRows", maxRows: 10_000 });
					expect(main).toHaveBeenCalledTimes(1); // Only the bounded 2001-row probe.
				} finally {
					worker.mockRestore();
					main.mockRestore();
				}
			});
		}

		test("a failed truncation probe also propagates without rereading inline", async () => {
			const worker = spyOn(workerPool, "runReadTask")
				.mockResolvedValueOnce({ rows: Array.from({ length: ROWS }, () => []) } as never)
				.mockRejectedValueOnce(new workerPool.WorkersUnavailableError("pool_shutdown"));
			const main = spyOn(file, "query");
			try {
				await expect(
					sqliteOutlineReads.listPageStructure("large", { asOf, limit: ROWS }),
				).rejects.toThrow("pool_shutdown");
				expect(worker).toHaveBeenCalledTimes(2);
				expect(worker.mock.calls[1]?.[1]).toMatchObject({ maxRows: 1 });
				expect(main).toHaveBeenCalledTimes(1);
			} finally {
				worker.mockRestore();
				main.mockRestore();
			}
		});

		test("healthy workers read large pages and report exact truncation", async () => {
			const all = await sqliteOutlineReads.listPageStructure("large", { asOf, limit: 10_000 });
			expect(all.rows).toHaveLength(ROWS);
			expect(all.truncated).toBe(false);
			expect(
				(await sqliteOutlineReads.listPageStructure("large", { asOf, limit: ROWS })).truncated,
			).toBe(false);
			const cut = await sqliteOutlineReads.listPageStructure("large", { asOf, limit: ROWS - 1 });
			expect(cut.rows).toHaveLength(ROWS - 1);
			expect(cut.truncated).toBe(true);
			expect(workerPool.getDbWorkerPoolStats().workers).toBeGreaterThan(0);
		}, 30_000);

		test("small reads and explicitly bounded large-page reads stay direct when workers are off", async () => {
			process.env.NARRAFORK_DB_WORKER = "off";
			const small = await sqliteOutlineReads.listPageStructure("small", { asOf, limit: 10_000 });
			expect(small.rows).toHaveLength(3);
			expect(small.truncated).toBe(false);
			const bounded = await sqliteOutlineReads.listPageStructure("large", {
				asOf,
				limit: MAIN_THREAD_PAGE_ROWS,
			});
			expect(bounded.rows).toHaveLength(MAIN_THREAD_PAGE_ROWS);
			expect(bounded.truncated).toBe(true);
			expect(workerPool.getDbWorkerPoolStats().workers).toBe(0);
		});

		test("large transaction reads reject rather than reading the full page inline", async () => {
			const worker = spyOn(workerPool, "runReadTask");
			const main = spyOn(file, "query");
			file.exec("BEGIN");
			try {
				await expect(
					sqliteOutlineReads.listPageStructure("large", { asOf, limit: 10_000 }),
				).rejects.toThrow("committed file-backed database");
				expect(main).toHaveBeenCalledTimes(1);
				expect(worker).not.toHaveBeenCalled();
				expect(
					(await sqliteOutlineReads.listPageStructure("small", { asOf, limit: 10_000 })).rows,
				).toHaveLength(3);
			} finally {
				file.exec("ROLLBACK");
				worker.mockRestore();
				main.mockRestore();
			}
		});

		test("large in-memory reads reject rather than reading the full page inline", async () => {
			bindConnection(memory);
			const worker = spyOn(workerPool, "runReadTask");
			const main = spyOn(memory, "query");
			try {
				await expect(
					sqliteOutlineReads.listPageStructure("large", { asOf, limit: 10_000 }),
				).rejects.toThrow("committed file-backed database");
				expect(main).toHaveBeenCalledTimes(1);
				expect(worker).not.toHaveBeenCalled();
				expect(
					(await sqliteOutlineReads.listPageStructure("small", { asOf, limit: 10_000 })).rows,
				).toHaveLength(3);
			} finally {
				worker.mockRestore();
				main.mockRestore();
			}
		});
	});
}
