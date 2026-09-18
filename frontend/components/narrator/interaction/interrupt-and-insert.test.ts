import { describe, expect, test } from "bun:test";
import {
	interruptAndInsert,
	isInterruptNotSettledError,
	isSettledInterruptResponse,
} from "./interrupt-and-insert";

describe("interruptAndInsert", () => {
	test("inserts exactly once after the settled boundary", async () => {
		const calls: string[] = [];
		const result = await interruptAndInsert(
			async () => {
				calls.push("interrupt");
				return { interrupted: true, settled: true };
			},
			async () => {
				calls.push("insert");
				return "sent";
			},
		);

		expect(result).toBe("sent");
		expect(calls).toEqual(["interrupt", "insert"]);
	});

	test("does not insert when the server reports settled false", async () => {
		let insertCalls = 0;
		const result = await interruptAndInsert(
			async () => {
				throw { status: 409, data: { interrupted: true, settled: false } };
			},
			async () => {
				insertCalls++;
				return "sent";
			},
		);

		expect(result).toBeUndefined();
		expect(insertCalls).toBe(0);
	});

	test("does not insert for a non-settled success response", async () => {
		let insertCalls = 0;
		const result = await interruptAndInsert(
			async () => ({ interrupted: true, settled: false }),
			async () => {
				insertCalls++;
				return "sent";
			},
		);

		expect(result).toBeUndefined();
		expect(insertCalls).toBe(0);
	});

	test("rethrows unexpected interrupt errors", async () => {
		const error = new Error("offline");
		await expect(
			interruptAndInsert(
				async () => {
					throw error;
				},
				async () => "sent",
			),
		).rejects.toBe(error);
	});

	test("recognizes only the settled response and expected 409 shape", () => {
		expect(isSettledInterruptResponse({ settled: true })).toBe(true);
		expect(isSettledInterruptResponse({ settled: false })).toBe(false);
		expect(isSettledInterruptResponse({ interrupted: false })).toBe(false);
		expect(isInterruptNotSettledError({ status: 409, data: { settled: false } })).toBe(true);
		expect(isInterruptNotSettledError({ status: 500, data: { settled: false } })).toBe(false);
	});
});
