import { describe, expect, test } from "bun:test";
import {
	createOptionalExecutionTimeout,
	normalizeOptionalExecutionTimeout,
	resolveOptionalExecutionTimeout,
} from "../execution-timeout";

describe("optional execution timeout", () => {
	test("does not create a deadline for omitted or zero timeout", () => {
		expect(createOptionalExecutionTimeout(undefined, "test")).toBeNull();
		expect(createOptionalExecutionTimeout(0, "test")).toBeNull();
		expect(normalizeOptionalExecutionTimeout(undefined)).toBeUndefined();
		expect(normalizeOptionalExecutionTimeout(0)).toBeUndefined();
	});

	test("uses the default while preserving explicit unlimited and large values", () => {
		expect(resolveOptionalExecutionTimeout(undefined, 18_000_000)).toBe(18_000_000);
		expect(resolveOptionalExecutionTimeout(0, 18_000_000)).toBeUndefined();
		expect(resolveOptionalExecutionTimeout(2_147_483_648, 18_000_000)).toBe(2_147_483_648);
	});

	test("aborts and reports an explicit timeout", async () => {
		const deadline = createOptionalExecutionTimeout(20, "test timeout");
		expect(deadline).not.toBeNull();
		await Bun.sleep(50);
		expect(deadline?.signal.aborted).toBe(true);
		expect(deadline?.didTimeout()).toBe(true);
		deadline?.dispose();
	});

	test("dispose prevents a pending timeout", async () => {
		const deadline = createOptionalExecutionTimeout(30, "test timeout");
		deadline?.dispose();
		await Bun.sleep(60);
		expect(deadline?.signal.aborted).toBe(false);
		expect(deadline?.didTimeout()).toBe(false);
	});

	test("supports delays beyond the single setTimeout 32-bit limit", () => {
		const timeoutMs = 2_147_483_648;
		const deadline = createOptionalExecutionTimeout(timeoutMs, "long timeout");
		expect(deadline?.timeoutMs).toBe(timeoutMs);
		expect(deadline?.signal.aborted).toBe(false);
		deadline?.dispose();
	});
});
