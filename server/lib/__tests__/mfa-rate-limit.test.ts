import { describe, expect, test } from "bun:test";
import { checkMfaLock, clearMfaFailures, recordMfaFailure } from "../mfa-rate-limit";

describe("mfa rate limit", () => {
	test("fresh user is not locked and has full budget", () => {
		const status = checkMfaLock("rl-fresh");
		expect(status.locked).toBe(false);
		expect(status.remaining).toBe(5);
	});

	test("remaining decrements with each failure", () => {
		const u = "rl-decrement";
		expect(recordMfaFailure(u).remaining).toBe(4);
		expect(recordMfaFailure(u).remaining).toBe(3);
		expect(checkMfaLock(u).remaining).toBe(3);
		clearMfaFailures(u);
	});

	test("locks out after 5 failures", () => {
		const u = "rl-lockout";
		let status = checkMfaLock(u);
		for (let i = 0; i < 4; i++) {
			status = recordMfaFailure(u);
			expect(status.locked).toBe(false);
		}
		status = recordMfaFailure(u); // 5th failure
		expect(status.locked).toBe(true);
		expect(status.lockedUntil).toBeGreaterThan(Date.now());
		// Subsequent checks report locked.
		expect(checkMfaLock(u).locked).toBe(true);
		clearMfaFailures(u);
	});

	test("clearMfaFailures resets state (successful verify path)", () => {
		const u = "rl-clear";
		recordMfaFailure(u);
		recordMfaFailure(u);
		clearMfaFailures(u);
		const status = checkMfaLock(u);
		expect(status.locked).toBe(false);
		expect(status.remaining).toBe(5);
	});

	test("per-user isolation: one user's failures don't affect another", () => {
		const a = "rl-iso-a";
		const b = "rl-iso-b";
		recordMfaFailure(a);
		recordMfaFailure(a);
		expect(checkMfaLock(b).remaining).toBe(5);
		clearMfaFailures(a);
	});
});
