import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	checkDomainBudget,
	createDomainReadParams,
	DOMAIN_READ_DEFINITIONS,
	validateDomainRead,
} from "./domain-protocol";
import { runDomainRead } from "./domain-task-registry";
import { ReadBudgetMeter } from "./read-budget";

describe("registered database read domains", () => {
	test("only foundation read tasks cross the fixed registry", () => {
		expect(createDomainReadParams("readerProbe", null)).toEqual({
			kind: "domainRead",
			task: "readerProbe",
			input: null,
		});
		expect(() => createDomainReadParams("readerProbe", {} as never)).toThrow();
		for (const task of [
			"narratorBodyTexts",
			"benchmarkSuiteListSnapshot",
			"databaseCleanupContext",
			"unregistered",
		]) {
			expect(Object.hasOwn(DOMAIN_READ_DEFINITIONS, task)).toBe(false);
			expect(() => validateDomainRead({ kind: "domainRead", task, input: {} } as never)).toThrow();
		}
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
