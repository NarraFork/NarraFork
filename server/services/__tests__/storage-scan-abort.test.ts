/**
 * Cancellation tests for the storage scan progress pump.
 *
 * `drain()` only ends when the pump is closed, and `close()` is normally driven by the scan promise's
 * `finally`. If an abort prevented that promise from settling — or if the settling happened after the
 * consumer had already given up — the SSE generator would park forever. These tests pin the exit
 * conditions.
 */

import { describe, expect, test } from "bun:test";
import { createProgressPump } from "../storage-service";

async function collectWithTimeout<T>(
	iterate: () => Promise<T>,
	timeoutMs = 2_000,
): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	try {
		return await Promise.race([iterate(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("createProgressPump", () => {
	test("drain ends when the pump is closed normally", async () => {
		const pump = createProgressPump();
		pump.push({ done: 1, total: 3, tableName: "a" });
		const seen: string[] = [];
		const outcome = await collectWithTimeout(async () => {
			for await (const progress of pump.drain()) {
				seen.push(progress.tableName);
				pump.close();
			}
			return "done" as const;
		});
		expect(outcome).toBe("done");
		expect(seen).toEqual(["a"]);
	});

	/**
	 * The hang this guards. Without abort-driven closing, `drain()` would await a notification that
	 * never arrives once the scan stops calling `push` and its promise never settles.
	 */
	test("drain ends when the signal aborts, even if close() is never called", async () => {
		const controller = new AbortController();
		const pump = createProgressPump(controller.signal);
		// Nothing ever calls pump.close(): the abort must be sufficient on its own.
		setTimeout(() => controller.abort(), 20).unref?.();
		const outcome = await collectWithTimeout(async () => {
			for await (const _progress of pump.drain()) {
				// no progress will arrive
			}
			return "done" as const;
		});
		expect(outcome).toBe("done");
	});

	test("drain returns immediately for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const pump = createProgressPump(controller.signal);
		const outcome = await collectWithTimeout(async () => {
			for await (const _progress of pump.drain()) {
				// no progress will arrive
			}
			return "done" as const;
		});
		expect(outcome).toBe("done");
	});

	test("progress already queued before an abort is still delivered once", async () => {
		const controller = new AbortController();
		const pump = createProgressPump(controller.signal);
		pump.push({ done: 5, total: 9, tableName: "narrator_messages" });
		controller.abort();
		const seen: number[] = [];
		const outcome = await collectWithTimeout(async () => {
			for await (const progress of pump.drain()) seen.push(progress.done);
			return "done" as const;
		});
		expect(outcome).toBe("done");
		expect(seen).toEqual([5]);
	});

	test("coalesces progress so a slow consumer only sees the latest value", async () => {
		const pump = createProgressPump();
		pump.push({ done: 1, total: 10, tableName: "a" });
		pump.push({ done: 2, total: 10, tableName: "b" });
		pump.push({ done: 3, total: 10, tableName: "c" });
		pump.close();
		const seen: number[] = [];
		for await (const progress of pump.drain()) seen.push(progress.done);
		expect(seen).toEqual([3]);
	});
});
