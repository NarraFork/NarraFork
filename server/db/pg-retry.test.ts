import { describe, expect, test } from "bun:test";
import { bunPgError } from "./__tests__/pg-test-factories";
import { withPgRetry } from "./pg-retry";

/** Instant, recording sleep: the backoff clock is the only thing these tests fake. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
	const delays: number[] = [];
	return {
		delays,
		sleep: (ms) => {
			delays.push(ms);
			return Promise.resolve();
		},
	};
}

describe("withPgRetry", () => {
	test("returns the section's value on first success without retrying", async () => {
		let calls = 0;
		const result = await withPgRetry(async () => {
			calls += 1;
			return "committed";
		});
		expect(result).toBe("committed");
		expect(calls).toBe(1);
	});

	test("replays the WHOLE section on retryable SQLSTATEs until it succeeds", async () => {
		const { sleep, delays } = recordingSleep();
		const entered: number[] = [];
		const result = await withPgRetry(
			async () => {
				entered.push(entered.length + 1);
				if (entered.length < 3) throw bunPgError("40001", "could not serialize access");
				return "third-time-committed";
			},
			{ sleep, label: "replay_test" },
		);
		expect(result).toBe("third-time-committed");
		expect(entered).toEqual([1, 2, 3]);
		// Two retries → two backoffs, each inside its full-jitter band.
		expect(delays).toHaveLength(2);
		expect(delays[0]).toBeGreaterThanOrEqual(50);
		expect(delays[0]).toBeLessThan(100);
		expect(delays[1]).toBeGreaterThanOrEqual(100);
		expect(delays[1]).toBeLessThan(200);
	});

	test("the third backoff uses the 200 ms band", async () => {
		const { sleep, delays } = recordingSleep();
		await expect(
			withPgRetry(
				async () => {
					throw bunPgError("40P01", "deadlock detected");
				},
				{ sleep, label: "backoff_test" },
			),
		).rejects.toBeDefined();
		expect(delays).toHaveLength(3);
		expect(delays[2]).toBeGreaterThanOrEqual(200);
		expect(delays[2]).toBeLessThan(400);
	});

	test("an idempotent section replayed after a COMMIT-time failure stores the fact once", async () => {
		// The dangerous case the contract names: the section's writes committed, then the
		// server answered 40001 at COMMIT. The section runs again. This is exactly why the
		// retried unit must be idempotent — modelled here as ON CONFLICT DO NOTHING semantics.
		const { sleep } = recordingSleep();
		const store = new Set<string>();
		let commitTimeFailureArmed = true;

		const section = async () => {
			store.add("fact-1"); // idempotent: a Set add, like INSERT … ON CONFLICT DO NOTHING
			if (commitTimeFailureArmed) {
				commitTimeFailureArmed = false;
				throw bunPgError("40001", "could not serialize access due to concurrent update");
			}
			return store.size;
		};

		const size = await withPgRetry(section, { sleep, label: "idempotent_replay" });
		expect(size).toBe(1);
		expect([...store]).toEqual(["fact-1"]);
	});

	test("side effects placed after the retry boundary happen exactly once", async () => {
		// The prescribed shape: withPgRetry resolves only once, so post-commit effects
		// (broadcasts, cache writes) attached AFTER it cannot be duplicated by a replay.
		const { sleep } = recordingSleep();
		const broadcasts: string[] = [];
		let attempts = 0;

		const outcome = await withPgRetry(
			async () => {
				attempts += 1;
				if (attempts < 3) throw bunPgError("55P03", "lock not available");
				return "tx-42";
			},
			{ sleep, label: "side_effect_test" },
		);
		broadcasts.push(`committed:${outcome}`);

		expect(attempts).toBe(3);
		expect(broadcasts).toEqual(["committed:tx-42"]);
	});

	test("rejects with the ORIGINAL error object once retries are exhausted", async () => {
		const { sleep, delays } = recordingSleep();
		const original = bunPgError("40001", "could not serialize access");
		let calls = 0;
		const failure = await withPgRetry(
			async () => {
				calls += 1;
				throw original;
			},
			{ sleep, label: "exhaustion_test" },
		).then(
			() => null,
			(error) => error,
		);
		expect(failure).toBe(original);
		expect(calls).toBe(4); // initial attempt + 3 retries
		expect(delays).toHaveLength(3);
	});

	test("maxRetries: 0 means a single attempt even for a retryable error", async () => {
		const { sleep, delays } = recordingSleep();
		const original = bunPgError("40P01", "deadlock detected");
		let calls = 0;
		await expect(
			withPgRetry(
				async () => {
					calls += 1;
					throw original;
				},
				{ sleep, maxRetries: 0, label: "no_retry_test" },
			),
		).rejects.toBe(original);
		expect(calls).toBe(1);
		expect(delays).toEqual([]);
	});

	test("a unique violation is never retried and never turned into a success", async () => {
		const { sleep, delays } = recordingSleep();
		const conflict = bunPgError("23505", "duplicate key value violates unique constraint");
		let calls = 0;
		const failure = await withPgRetry(
			async () => {
				calls += 1;
				throw conflict;
			},
			{ sleep, label: "unique_violation_test" },
		).then(
			() => null,
			(error) => error,
		);
		expect(failure).toBe(conflict); // original, unwrapped
		expect(calls).toBe(1);
		expect(delays).toEqual([]);
	});

	test("a unique violation AFTER a retried failure still stops the loop immediately", async () => {
		const { sleep, delays } = recordingSleep();
		const conflict = bunPgError("23505", "duplicate key value violates unique constraint");
		let calls = 0;
		await expect(
			withPgRetry(
				async () => {
					calls += 1;
					throw calls === 1 ? bunPgError("40001", "serialization failure") : conflict;
				},
				{ sleep, label: "mixed_failure_test" },
			),
		).rejects.toBe(conflict);
		expect(calls).toBe(2); // one retry for 40001, none for 23505
		expect(delays).toHaveLength(1);
	});

	test("non-retryable and unrecognized errors propagate on the first attempt", async () => {
		const { sleep, delays } = recordingSleep();
		for (const error of [
			bunPgError("42601", "syntax error"),
			bunPgError("23502", "null value violates not-null constraint"),
			new Error("deadlock detected"), // message only, no SQLSTATE
			"40001", // not even an Error
		]) {
			let calls = 0;
			await expect(
				withPgRetry(
					async () => {
						calls += 1;
						throw error;
					},
					{ sleep, label: "non_retryable_test" },
				),
			).rejects.toBe(error);
			expect(calls).toBe(1);
		}
		expect(delays).toEqual([]);
	});
});
