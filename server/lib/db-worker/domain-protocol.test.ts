import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { readDatabaseCleanupContext } from "../../services/database-cleanup-read";
import {
	checkDomainBudget,
	createDomainReadParams,
	DOMAIN_READ_DEFINITIONS,
	isDomainReadStreamTask,
	validateDatabaseCleanupResult,
	validateDomainRead,
} from "./domain-protocol";
import { runDomainRead } from "./domain-task-registry";
import { ReadBudgetMeter } from "./read-budget";

describe("registered database read domains", () => {
	test("only current read tasks cross the fixed registry", () => {
		expect(createDomainReadParams("readerProbe", null)).toEqual({
			kind: "domainRead",
			task: "readerProbe",
			input: null,
		});
		for (const task of [
			"archiveReadRowsPage",
			"archiveReadTablePage",
			"worktreeLegacyOwners",
			"databaseCleanupSnapshot",
			"unregistered",
		]) {
			expect(Object.hasOwn(DOMAIN_READ_DEFINITIONS, task)).toBe(false);
			expect(() => validateDomainRead({ kind: "domainRead", task, input: {} } as never)).toThrow();
		}
		expect(isDomainReadStreamTask(createDomainReadParams("benchmarkSuiteListSnapshot", {}))).toBe(
			true,
		);
		expect(isDomainReadStreamTask(createDomainReadParams("databaseCleanupContext", {}))).toBe(
			false,
		);
	});

	test("body reads preserve caller byte gates and reject malformed ranges", () => {
		expect(() =>
			createDomainReadParams("narratorBodyTexts", {
				entries: [{ id: "m", maxBytes: 8 * 1024 * 1024 }],
			}),
		).not.toThrow();
		expect(() =>
			createDomainReadParams("narratorBodyTexts", {
				entries: [{ id: "m", maxBytes: 10, exactBytes: 11 }],
			}),
		).toThrow();
		expect(() =>
			createDomainReadParams("narratorBodyTexts", {
				entries: [{ id: "m", maxBytes: 129 * 1024 * 1024 }],
			}),
		).toThrow();
		expect(() => createDomainReadParams("readerProbe", {} as never)).toThrow();
		expect(() =>
			createDomainReadParams("databaseCleanupContext", { unexpected: "value" } as never),
		).toThrow();
	});

	test("numeric DTO thresholds observe complete results rather than truncate", () => {
		const meter = new ReadBudgetMeter();
		const value = { rows: Array.from({ length: 20 }, () => "payload") };
		expect(checkDomainBudget(value, 8, 2, meter)).toBeGreaterThan(8);
		expect(value.rows).toHaveLength(20);
		expect(meter.snapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "domainResultItems", actual: 20, threshold: 2 }),
				expect.objectContaining({ kind: "domainResultBytes", threshold: 8 }),
			]),
		);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => checkDomainBudget(cyclic, 1024, 100)).toThrow();
	});

	test("cleanup mock: live team DTO is required and included in result budgets", () => {
		const result = { narrators: [], runningTerminalIds: [], liveTeamIds: ["team-a"] };
		expect(validateDatabaseCleanupResult(result)).toBe(true);
		expect(validateDatabaseCleanupResult({ narrators: [], runningTerminalIds: [] })).toBe(false);
		expect(validateDatabaseCleanupResult({ ...result, liveTeamIds: [null] })).toBe(false);
		expect(validateDatabaseCleanupResult({ ...result, liveTeamIds: [""] })).toBe(false);
		expect(validateDatabaseCleanupResult({ ...result, liveTeamIds: new Set(["team-a"]) })).toBe(
			false,
		);
		const meter = new ReadBudgetMeter();
		checkDomainBudget(result, 1, 0, meter);
		expect(meter.snapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "domainResultItems", actual: 1, threshold: 0 }),
			]),
		);
	});

	test("cleanup mock: team probes stay paged inside the metadata transaction", async () => {
		const rows = Array.from({ length: 501 }, (_, index) => ({
			id: `team-${index.toString().padStart(3, "0")}`,
			traits: '["team"]',
		}));
		const batches: unknown[][] = [];
		const finalized: string[] = [];
		let transactionDepth = 0;
		const fake = {
			transaction: (work: () => unknown) => () => {
				transactionDepth++;
				try {
					return work();
				} finally {
					transactionDepth--;
				}
			},
			prepare: (sql: string) => ({
				all: (...params: unknown[]) => {
					expect(transactionDepth).toBeGreaterThan(0);
					if (sql.includes("FROM narrators"))
						return rows.filter((row) => row.id > String(params[0])).slice(0, 256);
					if (sql.includes("FROM terminals")) return [];
					expect(sql).toContain("EXISTS");
					expect(sql).toContain("state NOT IN");
					expect(sql).toContain("worktree_resource_id IS NOT NULL");
					batches.push(params);
					expect(params.slice(-2)).toEqual(["merged", "cancelled"]);
					return params.slice(0, -2).map((teamId) => ({ teamId }));
				},
				finalize: () => finalized.push(sql),
			}),
		} as unknown as Database;
		const result = await runDomainRead(
			fake,
			createDomainReadParams("databaseCleanupContext", {}),
			new AbortController().signal,
			Date.now() + 1_000,
		);
		expect(result).toEqual({
			narrators: rows,
			runningTerminalIds: [],
			liveTeamIds: rows.map((row) => row.id),
		});
		expect(batches.map((batch) => batch.length - 2)).toEqual([500, 1]);
		expect(finalized).toHaveLength(4);
		expect(transactionDepth).toBe(0);
	});

	test("cleanup mock: registry rejects malformed live team results", async () => {
		const fake = {
			transaction: (work: () => unknown) => work,
			prepare: (sql: string) => ({
				all: () =>
					sql.includes("FROM narrators")
						? [{ id: "team", traits: '["team"]' }]
						: sql.includes("FROM terminals")
							? []
							: [{ teamId: 42 }],
				finalize: () => {},
			}),
		} as unknown as Database;
		await expect(
			runDomainRead(
				fake,
				createDomainReadParams("databaseCleanupContext", {}),
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "DB_READ_INVALID" });
	});

	test("cleanup mock: cancellation and deadline checks release team statements", () => {
		for (const reason of ["abort", "timeout"] as const) {
			const controller = new AbortController();
			let now = 1;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			const finalized: string[] = [];
			const fake = {
				transaction: (work: () => unknown) => work,
				prepare: (sql: string) => ({
					all: () => {
						if (sql.includes("FROM narrators")) return [{ id: "team", traits: '["team"]' }];
						if (sql.includes("FROM terminals")) return [];
						if (reason === "abort") controller.abort();
						else now = 3;
						return [{ teamId: "team" }];
					},
					finalize: () => finalized.push(sql),
				}),
			} as unknown as Database;
			try {
				expect(() => readDatabaseCleanupContext(fake, {}, controller.signal, 2)).toThrow(
					reason === "abort" ? "Cleanup read cancelled" : "Cleanup read deadline expired",
				);
				expect(finalized).toHaveLength(3);
			} finally {
				clock.mockRestore();
			}
		}
	});

	test("the registry owns and releases one explicit read snapshot", async () => {
		const sqlite = new Database(":memory:");
		sqlite.run("PRAGMA query_only = ON");
		try {
			expect(
				await runDomainRead(
					sqlite,
					createDomainReadParams("readerProbe", null),
					new AbortController().signal,
					Date.now() + 1_000,
				),
			).toEqual({ ready: true });
			expect(sqlite.inTransaction).toBe(false);
			const controller = new AbortController();
			controller.abort();
			await expect(
				runDomainRead(sqlite, createDomainReadParams("readerProbe", null), controller.signal),
			).rejects.toMatchObject({ code: "DB_READ_ABORTED" });
			await expect(
				runDomainRead(
					sqlite,
					createDomainReadParams("readerProbe", null),
					new AbortController().signal,
					Date.now() - 1,
				),
			).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
			expect(sqlite.inTransaction).toBe(false);
		} finally {
			sqlite.close();
		}
	});
});
