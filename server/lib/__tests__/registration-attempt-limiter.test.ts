/**
 * Registration throttling: an instance-wide minimum interval on top of per-source
 * and global failure budgets.
 *
 * The interval is what makes code guessing impractical across rotating source
 * addresses, so its exact semantics (what advances it, what does not) are pinned
 * here rather than left to the implementation.
 */
import { describe, expect, test } from "bun:test";
import { AuthAttemptLimiter } from "../auth-attempt-limiter";

const IP = "198.51.100.7";

function lease(limiter: AuthAttemptLimiter, options?: { skipGlobalInterval?: boolean }) {
	const attempt = limiter.beginRegistration(IP, options);
	expect(attempt.allowed).toBe(true);
	if (!attempt.allowed) throw new Error("registration attempt unexpectedly blocked");
	return attempt;
}

describe("registration interval", () => {
	test("a success blocks the next attempt until the interval elapses", () => {
		let now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		lease(limiter).success();

		now += 1_000;
		const blocked = limiter.beginRegistration(IP);
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) throw new Error("expected the interval to block");
		// Reported as throttling (not transient busyness) so the client shows a countdown.
		expect(blocked.reason).toBe("locked");
		expect(blocked.retryAfterMs).toBe(2_000);

		now += 2_000;
		const recovered = limiter.beginRegistration(IP);
		expect(recovered.allowed).toBe(true);
		if (recovered.allowed) recovered.cancel();
	});

	test("a failure advances the interval too, so failure storms are paced", () => {
		let now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		lease(limiter).failure();

		now += 500;
		const blocked = limiter.beginRegistration(IP);
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) throw new Error("expected the interval to block after a failure");
		expect(blocked.reason).toBe("locked");
	});

	test("a cancelled lease does not advance the interval", () => {
		const now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		lease(limiter).cancel();

		// No registration was actually attempted, so the next one may proceed at once.
		const next = limiter.beginRegistration(IP);
		expect(next.allowed).toBe(true);
		if (next.allowed) next.cancel();
	});

	test("the very first attempt on a fresh instance is not delayed", () => {
		const limiter = new AuthAttemptLimiter(() => 1_000);
		const first = limiter.beginRegistration(IP);
		expect(first.allowed).toBe(true);
		if (first.allowed) first.cancel();
	});

	test("skipGlobalInterval waives the gap but keeps the failure budget", () => {
		let now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		lease(limiter, { skipGlobalInterval: true }).failure();
		// Immediately again: allowed, because bootstrap retries must not wait 3s.
		lease(limiter, { skipGlobalInterval: true }).failure();

		// The source budget is 10 failures; exhaust the rest and confirm it still locks.
		for (let i = 0; i < 8; i++) {
			now += 1;
			lease(limiter, { skipGlobalInterval: true }).failure();
		}
		const blocked = limiter.beginRegistration(IP, { skipGlobalInterval: true });
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) throw new Error("expected the source budget to lock");
		expect(blocked.reason).toBe("locked");
		expect(blocked.sourceLocked).toBe(true);
	});
});

describe("registration failure budgets", () => {
	test("ten failures from one source lock it with a retry hint", () => {
		let now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		let last = lease(limiter).failure();
		for (let i = 1; i < 10; i++) {
			now += 3_000;
			last = lease(limiter).failure();
		}
		expect(last.locked).toBe(true);
		expect(last.sourceLocked).toBe(true);
		expect(last.retryAfterMs).toBe(60_000);

		now += 3_000;
		const blocked = limiter.beginRegistration(IP);
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) throw new Error("expected the locked source to be refused");
		expect(blocked.sourceLocked).toBe(true);
	});

	test("the global budget survives rotating source addresses", () => {
		let now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		// Well under the 10-per-source limit each, but 30 in total trips the global bucket.
		for (let i = 0; i < 30; i++) {
			now += 3_000;
			const attempt = limiter.beginRegistration(`203.0.113.${i}`);
			expect(attempt.allowed).toBe(true);
			if (!attempt.allowed) throw new Error("unexpectedly blocked before the global limit");
			attempt.failure();
		}
		now += 3_000;
		const blocked = limiter.beginRegistration("203.0.113.200");
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) throw new Error("expected the global budget to lock");
		expect(blocked.subjectLocked).toBe(true);
	});

	test("a successful registration does not clear accumulated failures", () => {
		let now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		for (let i = 0; i < 9; i++) {
			now += 3_000;
			lease(limiter).failure();
		}
		now += 3_000;
		lease(limiter).success();

		// The tenth failure still trips the lock: one valid signup in the middle of an
		// attack must not reset the budget.
		now += 3_000;
		const tenth = lease(limiter).failure();
		expect(tenth.locked).toBe(true);
	});

	test("a saturated bcrypt slot is reported as busy, not as throttling", () => {
		const limiter = new AuthAttemptLimiter(() => 1_000);
		// Hold the four available hash slots with in-flight attempts from distinct sources.
		const held = [0, 1, 2, 3].map((i) => {
			const attempt = limiter.beginRegistration(`203.0.113.${i}`, { skipGlobalInterval: true });
			expect(attempt.allowed).toBe(true);
			if (!attempt.allowed) throw new Error("unexpectedly blocked while filling hash slots");
			return attempt;
		});

		const blocked = limiter.beginRegistration("203.0.113.99", { skipGlobalInterval: true });
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) throw new Error("expected a busy response");
		expect(blocked.reason).toBe("busy");

		for (const attempt of held) attempt.cancel();
		const recovered = limiter.beginRegistration("203.0.113.99", { skipGlobalInterval: true });
		expect(recovered.allowed).toBe(true);
		if (recovered.allowed) recovered.cancel();
	});
});
