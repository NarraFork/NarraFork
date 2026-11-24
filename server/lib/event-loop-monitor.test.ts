import { describe, expect, spyOn, test } from "bun:test";
import { stallTimeBetween, startEventLoopMonitor, trackInFlight } from "./event-loop-monitor";
import { hotTimerClear } from "./hot-safe";
import { logger } from "./logger";

function block(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {}
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("event loop stall accounting", () => {
	test("attributes a synchronous block to the request that caused it", async () => {
		const warn = spyOn(logger, "warn");
		startEventLoopMonitor({ intervalMs: 10, warnThresholdMs: 100, warnThrottleMs: 0 });
		await tick(30);

		// Measured at request end, like the Slow API middleware: before the overdue tick has run.
		const startedAt = performance.now();
		const done = trackInFlight("GET /api/blocking");
		block(200);
		done();
		const endedAt = performance.now();
		const { stalledMs, maxStallMs } = stallTimeBetween(startedAt, endedAt);
		expect(stalledMs).toBeGreaterThanOrEqual(150);
		expect(maxStallMs).toBeGreaterThanOrEqual(150);
		expect(stalledMs).toBeLessThanOrEqual(endedAt - startedAt + 0.01);

		// Served right after the block, before the overdue tick: it overlaps but cannot be the cause.
		trackInFlight("GET /api/late")();
		await tick(30);

		// Recorded by the tick, the same window still reports the stall once.
		expect(stallTimeBetween(startedAt, endedAt).stalledMs).toBeCloseTo(stalledMs, -1);
		const lagWarning = warn.mock.calls.find(([message]) => message === "Event loop lag detected");
		const logged = JSON.stringify(lagWarning?.[1]);
		expect(logged).toContain("GET /api/blocking");
		expect(logged).not.toContain("GET /api/late");
		warn.mockRestore();

		const after = performance.now();
		await tick(30);
		expect(stallTimeBetween(after, performance.now()).stalledMs).toBeLessThan(50);
	});

	test("25 module reloads replace the monitor interval instead of accumulating timers", async () => {
		hotTimerClear("narrafork.eventLoopMonitor.timer");
		const create = spyOn(globalThis, "setInterval");
		const clear = spyOn(globalThis, "clearInterval");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		let latest = { startEventLoopMonitor, trackInFlight };
		try {
			for (let generation = 0; generation < 25; generation++) {
				const reloaded: typeof import("./event-loop-monitor") = await import(
					`./event-loop-monitor.ts?hot-reload=${generation}`
				);
				expect(reloaded.startEventLoopMonitor).not.toBe(latest.startEventLoopMonitor);
				latest = reloaded;
				latest.startEventLoopMonitor({ intervalMs: 10, warnThresholdMs: 100 });
				expect(create).toHaveBeenCalledTimes(generation + 1);
				expect(clear).toHaveBeenCalledTimes(generation);
				if (generation > 0)
					expect(clear).toHaveBeenLastCalledWith(create.mock.results[generation - 1].value);
				latest.startEventLoopMonitor();
				expect(create).toHaveBeenCalledTimes(generation + 1);
			}
			await tick(30);
			warn.mockClear();
			const done = latest.trackInFlight("GET /api/after-reload");
			block(200);
			done();
			await tick(30);
			const warnings = warn.mock.calls.filter(([message]) => message === "Event loop lag detected");
			expect(warnings).toHaveLength(1);
			expect(JSON.stringify(warnings[0][1])).toContain("GET /api/after-reload");
		} finally {
			hotTimerClear("narrafork.eventLoopMonitor.timer");
			for (const result of create.mock.results)
				if (result.type === "return") clearInterval(result.value);
			create.mockRestore();
			clear.mockRestore();
			warn.mockRestore();
		}
	});
});
