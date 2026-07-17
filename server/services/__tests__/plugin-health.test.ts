import { describe, expect, test } from "bun:test";
import { PluginCircuitBreaker } from "../plugin-health";

describe("plugin health circuit breaker", () => {
	test("opens after failures and permits a half-open probe", () => {
		let now = 0;
		const breaker = new PluginCircuitBreaker("com.example.test", {
			failureThreshold: 2,
			openMs: 100,
			now: () => now,
		});
		breaker.record({ ok: false, durationMs: 1, at: new Date(now).toISOString() });
		breaker.record({ ok: false, durationMs: 2, at: new Date(now).toISOString() });
		expect(breaker.state).toBe("open");
		expect(breaker.allowRequest()).toBe(false);
		now = 101;
		expect(breaker.allowRequest()).toBe(true);
		breaker.record({ ok: true, durationMs: 3, at: new Date(now).toISOString() });
		expect(breaker.metrics().state).toBe("closed");
	});
});
