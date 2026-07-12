import { describe, expect, test } from "bun:test";
import { AuthAttemptLimiter } from "../auth-attempt-limiter";

function passwordFailure(limiter: AuthAttemptLimiter, username: string, sourceIp: string) {
	const attempt = limiter.beginPassword(username, sourceIp);
	expect(attempt.allowed).toBe(true);
	if (!attempt.allowed) throw new Error("password attempt unexpectedly blocked");
	return attempt.failure();
}

function mfaFailure(limiter: AuthAttemptLimiter, userId: string, sourceIp: string) {
	const attempt = limiter.beginMfa(userId, sourceIp, false);
	expect(attempt.allowed).toBe(true);
	if (!attempt.allowed) throw new Error("MFA attempt unexpectedly blocked");
	return attempt.failure();
}

describe("AuthAttemptLimiter password protection", () => {
	test("locks a username/source pair after five failures", () => {
		let now = 1_000;
		const limiter = new AuthAttemptLimiter(() => now);
		for (let i = 0; i < 4; i++) {
			expect(passwordFailure(limiter, "alice", "198.51.100.1").locked).toBe(false);
		}
		const fifth = passwordFailure(limiter, "alice", "198.51.100.1");
		expect(fifth.locked).toBe(true);
		expect(fifth.subjectLocked).toBe(true);
		expect(fifth.sourceLocked).toBe(false);
		expect(fifth.retryAfterMs).toBe(30_000);

		const blocked = limiter.beginPassword("alice", "198.51.100.1");
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) throw new Error("expected throttled password attempt");
		expect(blocked.reason).toBe("locked");
		expect(blocked.subjectLocked).toBe(true);

		now += 30_001;
		const recovered = limiter.beginPassword("alice", "198.51.100.1");
		expect(recovered.allowed).toBe(true);
		if (recovered.allowed) recovered.cancel();
	});

	test("protects one username across distributed sources", () => {
		const limiter = new AuthAttemptLimiter();
		let last = passwordFailure(limiter, "alice", "198.51.100.1");
		for (let i = 2; i <= 10; i++) {
			last = passwordFailure(limiter, "alice", `198.51.100.${i}`);
		}
		expect(last.locked).toBe(true);
		expect(last.subjectLocked).toBe(true);

		const blocked = limiter.beginPassword("alice", "203.0.113.50");
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) expect(blocked.subjectLocked).toBe(true);
	});

	test("limits password spraying across usernames from one source", () => {
		const limiter = new AuthAttemptLimiter();
		let last = passwordFailure(limiter, "user-0", "203.0.113.8");
		for (let i = 1; i < 30; i++) {
			last = passwordFailure(limiter, `user-${i}`, "203.0.113.8");
		}
		expect(last.locked).toBe(true);
		expect(last.subjectLocked).toBe(false);
		expect(last.sourceLocked).toBe(true);

		const blocked = limiter.beginPassword("another-user", "203.0.113.8");
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) expect(blocked.sourceLocked).toBe(true);
	});

	test("reserves the username before password verification", () => {
		const limiter = new AuthAttemptLimiter();
		const first = limiter.beginPassword("alice", "192.0.2.10");
		expect(first.allowed).toBe(true);

		const parallel = limiter.beginPassword("alice", "192.0.2.11");
		expect(parallel.allowed).toBe(false);
		if (!parallel.allowed) expect(parallel.reason).toBe("busy");

		if (first.allowed) first.cancel();
		const afterCancel = limiter.beginPassword("alice", "192.0.2.11");
		expect(afterCancel.allowed).toBe(true);
		if (afterCancel.allowed) afterCancel.cancel();
	});

	test("caps concurrent bcrypt work globally", () => {
		const limiter = new AuthAttemptLimiter();
		const leases = Array.from({ length: 4 }, (_, index) =>
			limiter.beginPassword(`user-${index}`, `192.0.2.${index + 1}`),
		);
		expect(leases.every((lease) => lease.allowed)).toBe(true);

		const fifth = limiter.beginPassword("user-5", "192.0.2.50");
		expect(fifth.allowed).toBe(false);
		if (!fifth.allowed) expect(fifth.reason).toBe("busy");
		for (const lease of leases) if (lease.allowed) lease.cancel();
	});

	test("a successful password clears subject failures but keeps source spray history", () => {
		const limiter = new AuthAttemptLimiter();
		for (let i = 0; i < 4; i++) passwordFailure(limiter, "alice", "198.51.100.9");

		const success = limiter.beginPassword("alice", "198.51.100.9");
		expect(success.allowed).toBe(true);
		if (success.allowed) success.success();

		for (let i = 0; i < 4; i++) {
			expect(passwordFailure(limiter, "alice", "198.51.100.9").locked).toBe(false);
		}
		expect(passwordFailure(limiter, "alice", "198.51.100.9").subjectLocked).toBe(true);

		for (let i = 0; i < 20; i++) {
			passwordFailure(limiter, `spray-${i}`, "198.51.100.9");
		}
		const sourceLock = passwordFailure(limiter, "spray-final", "198.51.100.9");
		expect(sourceLock.sourceLocked).toBe(true);
	});

	test("repeated lockouts use progressive cooldowns", () => {
		let now = 10_000;
		const limiter = new AuthAttemptLimiter(() => now);
		for (let i = 0; i < 5; i++) passwordFailure(limiter, "alice", "192.0.2.1");
		now += 30_001;
		let secondLock = passwordFailure(limiter, "alice", "192.0.2.1");
		for (let i = 1; i < 5; i++) {
			secondLock = passwordFailure(limiter, "alice", "192.0.2.1");
		}
		expect(secondLock.locked).toBe(true);
		expect(secondLock.retryAfterMs).toBe(60_000);
	});
});

describe("AuthAttemptLimiter MFA protection", () => {
	test("five failures lock the user across source addresses", () => {
		const limiter = new AuthAttemptLimiter();
		let last = mfaFailure(limiter, "user-1", "198.51.100.1");
		for (let i = 2; i <= 5; i++) {
			last = mfaFailure(limiter, "user-1", `198.51.100.${i}`);
		}
		expect(last.locked).toBe(true);
		expect(last.subjectLocked).toBe(true);

		const newChallenge = limiter.beginMfa("user-1", "203.0.113.10", false);
		expect(newChallenge.allowed).toBe(false);
		if (!newChallenge.allowed) expect(newChallenge.subjectLocked).toBe(true);
	});

	test("parallel guesses cannot pass the per-user budget check", () => {
		const limiter = new AuthAttemptLimiter();
		const first = limiter.beginMfa("user-1", "198.51.100.1", false);
		expect(first.allowed).toBe(true);
		const second = limiter.beginMfa("user-1", "198.51.100.2", false);
		expect(second.allowed).toBe(false);
		if (!second.allowed) expect(second.reason).toBe("busy");
		if (first.allowed) first.cancel();
	});

	test("invalid challenge tokens consume the source budget", () => {
		const limiter = new AuthAttemptLimiter();
		let last = limiter.beginMfaSource("203.0.113.20");
		if (!last.allowed) throw new Error("unexpected source lock");
		let status = last.failure();
		for (let i = 1; i < 15; i++) {
			last = limiter.beginMfaSource("203.0.113.20");
			if (!last.allowed) throw new Error("unexpected early source lock");
			status = last.failure();
		}
		expect(status.sourceLocked).toBe(true);
	});

	test("successful MFA clears the user budget but not source failures", () => {
		const limiter = new AuthAttemptLimiter();
		for (let i = 0; i < 4; i++) mfaFailure(limiter, "user-1", "192.0.2.44");
		const success = limiter.beginMfa("user-1", "192.0.2.44", false);
		expect(success.allowed).toBe(true);
		if (success.allowed) success.success();

		for (let i = 0; i < 4; i++) {
			expect(mfaFailure(limiter, "user-1", `198.51.100.${i + 1}`).locked).toBe(false);
		}
		for (let i = 0; i < 10; i++) {
			mfaFailure(limiter, `other-${i}`, "192.0.2.44");
		}
		const sourceLock = mfaFailure(limiter, "other-final", "192.0.2.44");
		expect(sourceLock.sourceLocked).toBe(true);
	});

	test("capacity overflow cannot evict a target subject's active failures", () => {
		const limiter = new AuthAttemptLimiter(Date.now, 2);
		for (let i = 0; i < 4; i++) {
			passwordFailure(limiter, "target-user", "192.0.2.1");
		}
		passwordFailure(limiter, "middle-user", "192.0.2.2");
		for (let i = 0; i < 20; i++) {
			const attempt = limiter.beginPassword(`spray-${i}`, `198.51.100.${i + 1}`);
			if (!attempt.allowed) break;
			attempt.failure();
		}

		const targetLock = passwordFailure(limiter, "target-user", "192.0.2.1");
		expect(targetLock.subjectLocked).toBe(true);
	});

	test("a success cannot clear shared overflow failures", () => {
		const limiter = new AuthAttemptLimiter(Date.now, 1);
		mfaFailure(limiter, "tracked-user", "192.0.2.1");
		mfaFailure(limiter, "overflow-user-1", "192.0.2.2");

		const success = limiter.beginMfa("overflow-user-success", "192.0.2.3", false);
		expect(success.allowed).toBe(true);
		if (success.allowed) success.success();

		mfaFailure(limiter, "overflow-user-2", "192.0.2.4");
		mfaFailure(limiter, "overflow-user-3", "192.0.2.5");
		mfaFailure(limiter, "overflow-user-4", "192.0.2.6");
		const overflowLock = mfaFailure(limiter, "overflow-user-5", "192.0.2.7");
		expect(overflowLock.subjectLocked).toBe(true);
	});
});
