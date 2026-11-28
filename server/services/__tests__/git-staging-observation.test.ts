import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { GitStagingActionResult } from "../../../shared/git-staging-lists";
import type { GitStagingObservationState } from "../../../shared/git-workspace-events";
import { AppError } from "../../lib/errors";
import {
	assertGitStagingObservationClean,
	dirtyGitStagingObservation,
	type GitStagingObservationConsumer,
	gitStagingObservationState,
	publishGitStagingWrite,
	requestGitStagingObservation,
	serialGitStaging,
	subscribeGitStagingObservation,
} from "../git-staging-observation";

let sequence = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const fixtureIdentity = () => ({
	rootPath: `/observation-fixture-${++sequence}`,
	workspaceKey: `workspace-${sequence}`,
});
const applied: GitStagingActionResult = {
	outcome: "applied",
	affectedListIds: ["A"],
	generation: 2,
	observationId: "observation",
};
function deferred() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	cleanups.push(release);
	return { promise, release };
}
async function until(predicate: () => boolean) {
	const end = performance.now() + 2000;
	while (!predicate()) {
		if (performance.now() >= end) throw new Error("Observation fixture timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
function consumer(
	run: (signal: AbortSignal) => Promise<GitStagingActionResult>,
	options: { domain?: string; baseline?: string; scope?: string; signal?: AbortSignal } = {},
): GitStagingObservationConsumer {
	return {
		authorizationKey: options.domain ?? "owner:narrator",
		signal: options.signal,
		prepare: mock(async () => ({
			baseline: options.baseline ?? "2:observation:ready",
			scope: options.scope ?? "all-paths",
			run,
		})),
	};
}
function watch(
	identity: ReturnType<typeof fixtureIdentity>,
	writer?: GitStagingObservationConsumer,
) {
	const states: GitStagingObservationState[] = [];
	const stop = subscribeGitStagingObservation(identity, (state) => states.push(state), writer);
	cleanups.push(stop);
	return { states, stop };
}

test("manual requests independently authorize and share only the same epoch/baseline/scope/domain", async () => {
	const identity = fixtureIdentity();
	const run = mock(async () => applied);
	const one = consumer(run),
		two = consumer(run);
	const first = requestGitStagingObservation(identity, one);
	const second = requestGitStagingObservation(identity, two);
	const [a, b] = await Promise.all([first, second]);
	expect(run).toHaveBeenCalledTimes(1);
	expect(one.prepare).toHaveBeenCalledTimes(1);
	expect(two.prepare).toHaveBeenCalledTimes(1);
	expect(a.observationTargetEpoch).toBeLessThanOrEqual(a.observation?.completedEpoch ?? 0);
	expect(b.observation).toMatchObject({ status: "settled", epoch: 3, completedEpoch: 3 });
	await until(() => !gitStagingObservationState(identity));
});

test("a running observation cannot satisfy a later manual target; a hundred edits form one tail", async () => {
	const identity = fixtureIdentity();
	const held = deferred();
	let scans = 0;
	const writer = consumer(async () => {
		scans++;
		if (scans === 1) await held.promise;
		return applied;
	});
	const { states } = watch(identity, writer);
	dirtyGitStagingObservation(identity);
	await until(() => scans === 1);
	for (let index = 0; index < 100; index++) dirtyGitStagingObservation(identity);
	const manual = requestGitStagingObservation(
		identity,
		consumer(async () => {
			scans++;
			return applied;
		}),
	);
	expect(scans).toBe(1);
	held.release();
	const result = await manual;
	expect(scans).toBe(2);
	expect(result.observation?.completedEpoch).toBeGreaterThanOrEqual(
		result.observationTargetEpoch ?? Infinity,
	);
	expect(states.at(-1)).toMatchObject({ status: "settled" });
	expect(
		states.every((state, index) => !index || state.stateSequence > states[index - 1].stateSequence),
	).toBe(true);
});

test("a target waiter completes without waiting for continuous newer edits", async () => {
	const identity = fixtureIdentity();
	const first = deferred(),
		tail = deferred();
	let scans = 0;
	watch(
		identity,
		consumer(async () => {
			scans++;
			await tail.promise;
			return applied;
		}),
	);
	const request = requestGitStagingObservation(
		identity,
		consumer(async () => {
			scans++;
			await first.promise;
			return applied;
		}),
	);
	await until(() => scans === 1);
	dirtyGitStagingObservation(identity);
	first.release();
	const result = await request;
	expect(result.observation).toMatchObject({ status: "pending", epoch: 3, completedEpoch: 2 });
	expect(result.observationTargetEpoch).toBe(2);
	tail.release();
});

for (const different of [
	{ domain: "another-user:narrator" },
	{ scope: "restricted-paths" },
	{ baseline: "3:cli-publish:ready" },
])
	test(`different permission or baseline evidence cannot reuse another observation ${JSON.stringify(different)}`, async () => {
		const identity = fixtureIdentity();
		const run = mock(async () => applied);
		await Promise.all([
			requestGitStagingObservation(identity, consumer(run)),
			requestGitStagingObservation(identity, consumer(run, different)),
		]);
		expect(run).toHaveBeenCalledTimes(2);
	});

test("cancelling one waiter leaves a shared Worker task for the other authorized consumer", async () => {
	const identity = fixtureIdentity();
	const held = deferred();
	let runningSignal: AbortSignal | undefined;
	const run = mock(async (signal: AbortSignal) => {
		runningSignal = signal;
		await held.promise;
		return applied;
	});
	const cancelled = new AbortController();
	const first = requestGitStagingObservation(identity, consumer(run, { signal: cancelled.signal }));
	void first.catch(() => {});
	const second = requestGitStagingObservation(identity, consumer(run));
	await until(() => !!runningSignal);
	cancelled.abort(new Error("one waiter left"));
	await expect(first).rejects.toThrow("one waiter left");
	expect(runningSignal?.aborted).toBe(false);
	held.release();
	await second;
	expect(run).toHaveBeenCalledTimes(1);
});

test("cancelling the running subject does not reject a later independent manual target", async () => {
	const identity = fixtureIdentity();
	const abort = new AbortController();
	let started = false;
	const first = requestGitStagingObservation(
		identity,
		consumer(
			async (signal) => {
				started = true;
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				throw new AppError(
					"cancelled Worker result unknown",
					503,
					"GIT_STAGING_WORKER_UNAVAILABLE",
				);
			},
			{ signal: abort.signal },
		),
	);
	void first.catch(() => {});
	await until(() => started);
	const nextRun = mock(async () => applied);
	const next = requestGitStagingObservation(identity, consumer(nextRun));
	abort.abort(new Error("first subject left"));
	await expect(first).rejects.toThrow("first subject left");
	expect((await next).outcome).toBe("applied");
	expect(nextRun).toHaveBeenCalledTimes(1);
});

test("a prepared subject cancelled while another prepares cannot fail the remaining authorized waiter", async () => {
	const identity = fixtureIdentity();
	const held = deferred();
	const aSignal = new AbortController();
	const aRun = mock(async () => applied),
		bRun = mock(async () => applied);
	const a = consumer(aRun, { signal: aSignal.signal });
	const b = consumer(bRun);
	let preparingB = false;
	const original = b.prepare;
	b.prepare = async (signal) => {
		preparingB = true;
		await held.promise;
		return original(signal);
	};
	const first = requestGitStagingObservation(identity, a);
	void first.catch(() => {});
	const second = requestGitStagingObservation(identity, b);
	await until(() => preparingB);
	aSignal.abort(new Error("subject A left"));
	held.release();
	await expect(first).rejects.toThrow("subject A left");
	expect((await second).outcome).toBe("applied");
	expect(aRun).not.toHaveBeenCalled();
	expect(bRun).toHaveBeenCalledTimes(1);
});

test("revocation during final subject revalidation switches to another live independently authorized subject", async () => {
	const identity = fixtureIdentity();
	const held = deferred();
	let revalidating = false;
	const aRun = mock(async () => applied),
		bRun = mock(async () => applied);
	const a = consumer(aRun);
	const original = a.prepare;
	a.prepare = async (signal) => ({
		...(await original(signal)),
		revalidate: async () => {
			revalidating = true;
			await held.promise;
			throw new AppError("A revoked", 403, "FORBIDDEN");
		},
	});
	const first = requestGitStagingObservation(identity, a);
	void first.catch(() => {});
	const second = requestGitStagingObservation(identity, consumer(bRun));
	await until(() => revalidating);
	held.release();
	await expect(first).rejects.toThrow("A revoked");
	expect((await second).outcome).toBe("applied");
	expect(aRun).not.toHaveBeenCalled();
	expect(bRun).toHaveBeenCalledTimes(1);
});

test("a writer joining a readonly-established dirty epoch starts the first verification round", async () => {
	const identity = fixtureIdentity();
	watch(identity);
	dirtyGitStagingObservation(identity);
	expect(gitStagingObservationState(identity)).toMatchObject({ status: "pending", round: 0 });
	const run = mock(async () => applied);
	watch(identity, consumer(run));
	await until(() => gitStagingObservationState(identity)?.status === "settled");
	expect(run).toHaveBeenCalledTimes(1);
	expect(gitStagingObservationState(identity)?.round).toBe(1);
});

test("last consumer teardown cancels the task, removes its entry and resets instance lineage", async () => {
	const identity = fixtureIdentity();
	let signal: AbortSignal | undefined;
	const writer = consumer(async (value) => {
		signal = value;
		await new Promise<void>((resolve) =>
			value.addEventListener("abort", () => resolve(), { once: true }),
		);
		return applied;
	});
	const first = watch(identity, writer);
	const instance = first.states[0].instanceId;
	dirtyGitStagingObservation(identity);
	await until(() => !!signal);
	first.stop();
	expect(signal?.aborted).toBe(true);
	await until(() => !gitStagingObservationState(identity));
	const next = watch(identity);
	expect(next.states[0].status).toBe("pending");
	expect(next.states[0].completedEpoch).toBe(0);
	expect(next.states[0].instanceId).not.toBe(instance);
});

test("readonly subscribers receive pending state but never dispatch an observation", async () => {
	const identity = fixtureIdentity();
	const { states } = watch(identity);
	dirtyGitStagingObservation(identity);
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(states.map((state) => state.status)).toEqual(["pending", "pending"]);
	expect(gitStagingObservationState(identity)?.round).toBe(0);
});

test("transient busy/source failures retain dirty state and retry at most twice", async () => {
	const identity = fixtureIdentity();
	const run = mock(async () => {
		throw new AppError("still changing", 409, "GIT_STAGING_SOURCE_CHANGED");
	});
	const { states } = watch(identity);
	await expect(requestGitStagingObservation(identity, consumer(run))).rejects.toMatchObject({
		code: "GIT_STAGING_SOURCE_CHANGED",
	});
	expect(run).toHaveBeenCalledTimes(3);
	expect(states.at(-1)).toMatchObject({ status: "failed", completedEpoch: 0 });
	expect(states.at(-1)?.epoch).toBeGreaterThan(states.at(-1)?.completedEpoch ?? 0);
});

for (const stage of ["prepare", "run"] as const) {
	test(`unmarked concurrent ${stage} failures retain the existing outer retry budget`, async () => {
		const identity = fixtureIdentity();
		let preparations = 0,
			runs = 0;
		const subject = consumer(async () => {
			runs++;
			throw new AppError("Fixture outer source changed", 409, "GIT_STAGING_CONCURRENT_CHANGE");
		});
		const prepare = subject.prepare;
		subject.prepare = async (signal) => {
			preparations++;
			if (stage === "prepare")
				throw new AppError("Fixture preparation changed", 409, "GIT_STAGING_CONCURRENT_CHANGE");
			return prepare(signal);
		};
		watch(identity);
		await expect(requestGitStagingObservation(identity, subject)).rejects.toMatchObject({
			code: "GIT_STAGING_CONCURRENT_CHANGE",
		});
		expect(preparations).toBe(3);
		expect(runs).toBe(stage === "run" ? 3 : 0);
	});
}

test("concurrent scans use the observer budget without an outer retry multiplier", async () => {
	const identity = fixtureIdentity();
	const run = mock(async () => {
		throw Object.defineProperty(
			new AppError("Observer exhausted three scans", 409, "GIT_STAGING_CONCURRENT_CHANGE"),
			"observationRetriesExhausted",
			{ value: true },
		);
	});
	const { states } = watch(identity);
	await expect(requestGitStagingObservation(identity, consumer(run))).rejects.toMatchObject({
		code: "GIT_STAGING_CONCURRENT_CHANGE",
	});
	expect(run).toHaveBeenCalledTimes(1);
	expect(states.at(-1)).toMatchObject({ status: "failed", completedEpoch: 0 });
});

test("a newer dirty event retained during a permanently failing round receives one tail verification", async () => {
	const identity = fixtureIdentity();
	const held = deferred();
	let runs = 0;
	watch(
		identity,
		consumer(async () => {
			runs++;
			if (runs === 1) {
				await held.promise;
				throw new AppError("old over-budget source", 409, "GIT_STAGING_LIMIT");
			}
			return applied;
		}),
	);
	dirtyGitStagingObservation(identity);
	await until(() => runs === 1);
	dirtyGitStagingObservation(identity);
	held.release();
	await until(() => gitStagingObservationState(identity)?.status === "settled");
	expect(runs).toBe(2);
	expect(gitStagingObservationState(identity)).toMatchObject({ epoch: 3, completedEpoch: 3 });
});

test("permanent failure waits for an explicit retry and same-generation recovery publishes settled", async () => {
	const identity = fixtureIdentity();
	let failure = true;
	const run = mock(async () => {
		if (failure) throw new AppError("budget", 409, "GIT_STAGING_LIMIT");
		return applied;
	});
	const { states } = watch(identity);
	await expect(requestGitStagingObservation(identity, consumer(run))).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(run).toHaveBeenCalledTimes(1);
	failure = false;
	await requestGitStagingObservation(identity, consumer(run));
	expect(states.at(-1)).toMatchObject({
		status: "settled",
		generation: 2,
		observationId: "observation",
	});
});

test("a denied queued consumer cannot borrow a writable subscriber's authority", async () => {
	const identity = fixtureIdentity();
	const run = mock(async () => applied);
	watch(identity, consumer(run));
	const denied = consumer(run, { domain: "denied:narrator" });
	denied.prepare = async () => {
		throw new AppError("revoked", 403, "FORBIDDEN");
	};
	await expect(requestGitStagingObservation(identity, denied)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await until(() => run.mock.calls.length === 1);
	expect(run).toHaveBeenCalledTimes(1);
});

test("known dirty epochs and late events fence queued actions but do not undo applied writes", async () => {
	const identity = fixtureIdentity();
	watch(identity);
	await requestGitStagingObservation(
		identity,
		consumer(async () => applied),
	);
	const enqueued = gitStagingObservationState(identity);
	expect(() =>
		assertGitStagingObservationClean(identity, enqueued, {
			expectedGeneration: 2,
			observationId: "observation",
		}),
	).not.toThrow();
	dirtyGitStagingObservation(identity);
	expect(() =>
		assertGitStagingObservationClean(identity, enqueued, {
			expectedGeneration: 2,
			observationId: "observation",
		}),
	).toThrow("refresh");
	publishGitStagingWrite(identity, { ...applied, generation: 3 });
	expect(gitStagingObservationState(identity)).toMatchObject({
		status: "pending",
		generation: 3,
		epoch: 3,
		completedEpoch: 2,
	});
});

test("root serialization keeps observations and writes ordered and removes cancelled waiters", async () => {
	const root = fixtureIdentity().rootPath;
	const held = deferred();
	const entered: string[] = [];
	const first = serialGitStaging(root, async () => {
		entered.push("observe");
		await held.promise;
	});
	const controller = new AbortController();
	const cancelled = serialGitStaging(
		root,
		async () => {
			entered.push("cancelled");
		},
		controller.signal,
	);
	void cancelled.catch(() => {});
	const last = serialGitStaging(root, async () => {
		entered.push("move");
	});
	controller.abort(new Error("cancel queued"));
	await expect(cancelled).rejects.toThrow("cancel queued");
	expect(entered).toEqual(["observe"]);
	held.release();
	await Promise.all([first, last]);
	expect(entered).toEqual(["observe", "move"]);
});

test("different-root action queues have a global cap and cancelled queues release their slots", async () => {
	const controllers = Array.from({ length: 128 }, () => new AbortController());
	const calls = controllers.map((controller) =>
		serialGitStaging(fixtureIdentity().rootPath, async () => {}, controller.signal).catch(
			() => undefined,
		),
	);
	await expect(serialGitStaging(fixtureIdentity().rootPath, async () => {})).rejects.toMatchObject({
		code: "GIT_STAGING_BUSY",
	});
	for (const controller of controllers) controller.abort();
	await Promise.all(calls);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(await serialGitStaging(fixtureIdentity().rootPath, async () => "released")).toBe(
		"released",
	);
});

test("observation waiter timeout cancels an otherwise unconsumed task and cleans its entry", async () => {
	const original = globalThis.setTimeout;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
		handler: TimerHandler,
		delay?: number,
		...args: unknown[]
	) => original(handler, delay === 120_000 ? 1 : delay, ...args)) as typeof setTimeout);
	try {
		const identity = fixtureIdentity();
		const request = requestGitStagingObservation(
			identity,
			consumer(async (signal) => {
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				return applied;
			}),
		);
		await expect(request).rejects.toMatchObject({ code: "GIT_STAGING_TIMEOUT" });
		await until(() => !gitStagingObservationState(identity));
	} finally {
		timer.mockRestore();
	}
});

test("entry, subscription and pending-waiter capacities fail closed and release cleanly", async () => {
	const local: Array<() => void> = [];
	try {
		for (let index = 0; index < 128; index++)
			local.push(subscribeGitStagingObservation(fixtureIdentity(), () => {}));
		expect(() => subscribeGitStagingObservation(fixtureIdentity(), () => {})).toThrow("capacity");
	} finally {
		for (const stop of local) stop();
	}
	const identity = fixtureIdentity();
	for (let index = 0; index < 128; index++)
		local.push(subscribeGitStagingObservation(identity, () => {}));
	expect(() => subscribeGitStagingObservation(identity, () => {})).toThrow("capacity");
	for (const stop of local.splice(0)) stop();
	const controller = new AbortController();
	const run = mock(async () => applied);
	const pending = Array.from({ length: 128 }, () =>
		requestGitStagingObservation(identity, consumer(run, { signal: controller.signal })).catch(
			() => undefined,
		),
	);
	await expect(requestGitStagingObservation(identity, consumer(run))).rejects.toMatchObject({
		code: "GIT_STAGING_BUSY",
	});
	controller.abort();
	await Promise.all(pending);
	await until(() => !gitStagingObservationState(identity));
});
