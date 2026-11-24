import { describe, expect, test } from "bun:test";
import type { DbReadTaskParams } from "../protocol";
import { classifyReadTask, readSchedulingConfig } from "../scheduling";

describe("frozen main read scheduling configuration", () => {
	test("reserves a rounded quarter for every supported concurrency", () => {
		for (let concurrency = 2; concurrency <= 16; concurrency++) {
			const config = readSchedulingConfig(concurrency, undefined);
			expect(config.reservedCapacity).toBe(Math.max(1, Math.ceil(concurrency / 4)));
			expect(config.normalCapacity).toBe(concurrency - config.reservedCapacity);
			expect(Object.isFrozen(config)).toBe(true);
		}
		expect(() => readSchedulingConfig(1)).toThrow("at_least_2");
	});
	test("queue counts reserve a rounded quarter and retain fixed byte budgets", () => {
		for (const maxQueued of [0, 1, 2, 5, 64, 128, 1024]) {
			const config = readSchedulingConfig(4, String(maxQueued));
			expect(config.maxQueued).toBe(maxQueued);
			expect(config.reservedQueued).toBe(maxQueued ? Math.max(1, Math.ceil(maxQueued / 4)) : 0);
			expect(config.normalMaxQueued).toBe(maxQueued - config.reservedQueued);
			expect(config.maxQueuedBytes).toBe(8 * 1024 * 1024);
			expect(config.normalMaxQueuedBytes).toBe(6 * 1024 * 1024);
		}
		for (const raw of [undefined, "", "  "])
			expect(readSchedulingConfig(2, raw).maxQueued).toBe(64);
	});
	test("invalid queue configuration is rejected rather than coerced", () => {
		for (const raw of [
			"-1",
			"1.5",
			"1e2",
			"+2",
			"0x10",
			"64items",
			"NaN",
			"Infinity",
			"1025",
			"999999999999999999999999999999999",
		])
			expect(() => readSchedulingConfig(2, raw)).toThrow("decimal_0_to_1024");
	});
});

describe("trusted read scheduling classification", () => {
	const select: DbReadTaskParams = {
		kind: "selectRows",
		sql: "SELECT count(*) FROM large_table",
		params: [],
		maxRows: 1,
	};
	test("ordinary SQL stays normal regardless of result shape", () => {
		expect(classifyReadTask(select)).toEqual({ taskClass: "normal" });
		expect(classifyReadTask({ kind: "storageScanContext" })).toEqual({ taskClass: "normal" });
	});
	test("only auth selectRows and the fixed readerProbe are short", () => {
		expect(classifyReadTask(select, "auth-session")).toEqual({
			taskClass: "short",
			shortSource: "auth-session",
		});
		expect(classifyReadTask({ kind: "domainRead", task: "readerProbe", input: null })).toEqual({
			taskClass: "short",
			shortSource: "readerProbe",
		});
	});
	test("unknown or inapplicable hints fail explicitly", () => {
		for (const hint of ["short", "auth.session", "", null])
			expect(() => classifyReadTask(select, hint as "auth-session")).toThrow("scheduling hint");
		expect(() => classifyReadTask({ kind: "storageScanContext" }, "auth-session")).toThrow(
			"scheduling hint",
		);
	});
});
