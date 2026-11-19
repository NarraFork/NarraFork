import { describe, expect, spyOn, test } from "bun:test";
import type { ReasoningTranslationPart } from "@shared/reasoning-translation";
import {
	REASONING_TRANSLATION_LIMITS,
	ReasoningTranslationScheduler,
	type TranslationTask,
	translationPrefixEnd,
} from "../reasoning-translation-scheduler";

async function tick(): Promise<void> {
	for (let index = 0; index < 16; index++) await Promise.resolve();
}
function fixture(
	scheduler = new ReasoningTranslationScheduler({ ...REASONING_TRANSLATION_LIMITS, coalesceMs: 0 }),
	sessionId = "one",
) {
	const requests: Array<{
		task: TranslationTask;
		signal: AbortSignal;
		delta: (text: string) => void;
		resolve: (text: string) => void;
		reject: (error: Error) => void;
	}> = [];
	const parts: ReasoningTranslationPart[] = [];
	const response = scheduler.create({
		sessionId,
		translate: (task, signal, delta) =>
			new Promise<string>((resolve, reject) => {
				requests.push({ task, signal, delta, resolve, reject });
			}),
		apply: async (_task, part) => {
			parts.push(part);
			return true;
		},
	});
	const freeze = (
		text: string,
		reason: TranslationTask["reason"] = "tool",
		elementId = "element",
		generation = "g",
		range: { start?: number; end?: number } = {},
	) =>
		scheduler.freeze(response, {
			text,
			reason,
			elementId,
			generation,
			messageId: "message",
			...range,
		});
	return { scheduler, response, requests, parts, freeze };
}
async function releaseAll(f: ReturnType<typeof fixture>): Promise<void> {
	let released = 0;
	while (f.response.pending > 0) {
		for (; released < f.requests.length; released++) f.requests[released].resolve("译文");
		await tick();
	}
}

function batchFixture(scheduler: ReasoningTranslationScheduler, key: string, sessionId = key) {
	const f = fixture(scheduler, sessionId);
	const batches: Array<{
		tasks: TranslationTask[];
		signal: AbortSignal;
		resolve: (text: string) => void;
	}> = [];
	f.response.batchKey = key;
	f.response.translateBatch = (tasks, signal) =>
		new Promise<string>((resolve) => {
			batches.push({ tasks: [...tasks], signal, resolve });
		});
	const complete = (index: number) => {
		const batch = batches[index];
		batch.resolve(
			JSON.stringify({
				parts: batch.tasks.map((task) => ({ id: task.id, translatedText: "译" })),
			}),
		);
	};
	return { ...f, batches, complete };
}

/** Advance registered callbacks and the scheduler's clock together, including async finally work. */
function controlledClock() {
	let now = 0;
	const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
	const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
	const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		run: () => void,
		delay = 0,
	) => {
		const timer = { unref: () => timer } as unknown as ReturnType<typeof setTimeout>;
		timers.set(timer, { at: now + delay, run });
		return timer;
	}) as typeof setTimeout);
	const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
		timers.delete(timer as ReturnType<typeof setTimeout>);
	});
	return {
		pending: () => timers.size,
		async advance(milliseconds: number) {
			const target = now + milliseconds;
			for (let steps = 0; ; steps++) {
				await tick();
				const next = [...timers]
					.filter(([, timer]) => timer.at <= target)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) {
					now = target;
					await tick();
					return;
				}
				if (steps >= 10_000) throw new Error("Clock did not reach its target");
				const [handle, timer] = next;
				now = timer.at;
				timers.delete(handle);
				timer.run();
			}
		},
		restore() {
			clearSpy.mockRestore();
			setSpy.mockRestore();
			nowSpy.mockRestore();
		},
	};
}

async function withClock(
	run: (
		clock: ReturnType<typeof controlledClock>,
		scheduler: ReasoningTranslationScheduler,
	) => Promise<void>,
	limits: Partial<NonNullable<ConstructorParameters<typeof ReasoningTranslationScheduler>[0]>> = {},
) {
	const clock = controlledClock();
	const scheduler = new ReasoningTranslationScheduler({
		...REASONING_TRANSLATION_LIMITS,
		...limits,
	});
	try {
		await run(clock, scheduler);
	} finally {
		try {
			await scheduler.stop();
			expect(clock.pending()).toBe(0);
		} finally {
			clock.restore();
		}
	}
}

describe("fixed reasoning translation windows", () => {
	test("completed sources at zero and nine seconds share the ten-second request", async () => {
		await withClock(async (clock, scheduler) => {
			const a = batchFixture(scheduler, "author:model:locale", "a");
			const b = batchFixture(scheduler, "author:model:locale", "b");
			a.freeze("A", "final");
			await clock.advance(9_000);
			b.freeze("B", "final");
			scheduler.configureBatch(a.response, "author:model:locale");
			a.freeze("A", "final");
			b.freeze("B", "final");
			await clock.advance(999);
			a.freeze("A", "tool");
			scheduler.settle(a.response);
			scheduler.settle(b.response);
			expect(a.batches).toHaveLength(0);
			expect(b.batches).toHaveLength(0);
			await clock.advance(1);
			expect(a.batches).toHaveLength(1);
			expect(a.batches[0].tasks.map((task) => task.sourceText)).toEqual(["A", "B"]);
			expect(b.batches).toHaveLength(0);
			expect(a.response.queuedAt).toBe(0);
			expect(b.response.queuedAt).toBe(9_000);
			a.complete(0);
			await tick();
			expect(a.parts.map((part) => part.sourceText)).toEqual(["A"]);
			expect(b.parts.map((part) => part.sourceText)).toEqual(["B"]);
			expect(clock.pending()).toBe(0);
		});
	});

	test("unkeyed final and tool tasks each wait for their own first admission", async () => {
		await withClock(async (clock, scheduler) => {
			const f = fixture(scheduler);
			f.freeze("A", "tool", "a");
			await clock.advance(9_000);
			f.freeze("B", "final", "b");
			await clock.advance(999);
			expect(f.requests).toHaveLength(0);
			await clock.advance(1);
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
			f.requests[0].resolve("甲");
			await clock.advance(8_999);
			expect(f.requests).toHaveLength(1);
			await clock.advance(1);
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "B"]);
			scheduler.settle(f.response);
			await releaseAll(f);
		});
	});

	test("author, model and locale batch keys retain independent windows", async () => {
		await withClock(async (clock, scheduler) => {
			const keys = ["a:m:zh", "b:m:zh", "a:n:zh", "a:m:en"];
			const groups = keys.map((key) => batchFixture(scheduler, key));
			for (let index = 0; index < groups.length; index++) {
				if (index) await clock.advance(1_000);
				groups[index].freeze(`${index}`, "final");
			}
			await clock.advance(6_999);
			expect(groups.map((group) => group.batches.length)).toEqual([0, 0, 0, 0]);
			await clock.advance(1);
			for (let index = 0; index < groups.length; index++) {
				if (index) await clock.advance(1_000);
				expect(groups.map((group) => group.batches.length)).toEqual(
					groups.map((_group, other) => Number(other <= index)),
				);
				expect(groups[index].batches[0].tasks.map((task) => task.sourceText)).toEqual([`${index}`]);
				groups[index].complete(0);
			}
		});
	});

	test("a source arriving after a finished batch starts a new fixed window", async () => {
		await withClock(async (clock, scheduler) => {
			const a = batchFixture(scheduler, "same");
			a.freeze("A", "final");
			await clock.advance(10_000);
			a.complete(0);
			await clock.advance(1);
			const b = batchFixture(scheduler, "same");
			b.freeze("B", "final");
			await clock.advance(9_999);
			expect(b.batches).toHaveLength(0);
			await clock.advance(1);
			expect(b.batches[0].tasks.map((task) => task.sourceText)).toEqual(["B"]);
			b.complete(0);
		});
	});

	test("32KiB leftovers stay ready while active-batch additions wait in the next window", async () => {
		await withClock(async (clock, scheduler) => {
			const f = batchFixture(scheduler, "same", "first");
			const other = batchFixture(scheduler, "same", "second");
			other.response.order = 1;
			const source = `${"😀".repeat(8192)}Z`;
			f.freeze(source, "final");
			await clock.advance(10_000);
			expect(f.batches).toHaveLength(1);
			expect(Buffer.byteLength(f.batches[0].tasks[0].sourceText)).toBe(32 * 1024);
			await clock.advance(1_000);
			f.freeze(`${source}tail`, "final");
			f.freeze("C", "final", "c");
			other.freeze("B", "final");
			await clock.advance(1_000);
			f.complete(0);
			await tick();
			expect(f.batches).toHaveLength(2);
			expect(f.batches[1].tasks.map((task) => task.sourceText)).toEqual(["Z"]);
			expect(f.batches[1].tasks[0]).toMatchObject({ start: 16384, end: 16385 });
			f.complete(1);
			await clock.advance(8_999);
			f.freeze(`${source}tail`, "final");
			expect(f.batches).toHaveLength(2);
			expect(other.batches).toHaveLength(0);
			await clock.advance(1);
			expect(f.batches).toHaveLength(3);
			expect(f.batches[2].tasks.map((task) => task.sourceText)).toEqual(["tail", "C", "B"]);
			expect(f.batches[2].tasks[0]).toMatchObject({ start: 16385, end: 16389 });
			f.complete(2);
			await tick();
			expect(f.response.tasks).toBe(3);
			expect(other.response.tasks).toBe(1);
		});
	});

	test("cancelling the first member preserves the admitted sibling's original window", async () => {
		await withClock(async (clock, scheduler) => {
			const a = batchFixture(scheduler, "same", "a");
			const b = batchFixture(scheduler, "same", "b");
			a.freeze("A", "final");
			await clock.advance(9_000);
			b.freeze("B", "final");
			scheduler.cancel(a.response);
			await clock.advance(1_000);
			expect(a.batches).toHaveLength(0);
			expect(b.batches[0].tasks.map((task) => task.sourceText)).toEqual(["B"]);
			b.complete(0);
		});
	});

	for (const invalidation of ["generation", "retain", "discard", "cancel"] as const) {
		test(`${invalidation} releases an empty group's window before new admission`, async () => {
			await withClock(async (clock, scheduler) => {
				const f = batchFixture(scheduler, "same");
				f.freeze("old", "final");
				await clock.advance(9_000);
				let next = f;
				if (invalidation === "generation") f.freeze("new", "final", "element", "new");
				else if (invalidation === "retain") {
					scheduler.retain(f.response, () => false);
					f.freeze("new", "final");
				} else if (invalidation === "discard") {
					scheduler.discardQueued(f.response);
					f.freeze("new", "final", "new");
				} else {
					scheduler.cancel(f.response);
					next = batchFixture(scheduler, "same");
					next.freeze("new", "final");
				}
				await clock.advance(1_000);
				expect(f.batches).toHaveLength(0);
				expect(next.batches).toHaveLength(0);
				await clock.advance(8_999);
				expect(next.batches).toHaveLength(0);
				await clock.advance(1);
				expect(next.batches[0].tasks.map((task) => task.sourceText)).toEqual(["new"]);
				next.complete(0);
			});
		});
	}

	test("authorization removes a denied member without delaying its valid sibling or later group", async () => {
		await withClock(async (clock, scheduler) => {
			const denied = batchFixture(scheduler, "same", "denied");
			const allowed = batchFixture(scheduler, "same", "allowed");
			denied.response.canTranslate = async () => false;
			denied.freeze("private", "final");
			await clock.advance(9_000);
			allowed.freeze("public", "final");
			await clock.advance(1_000);
			expect(denied.response.cancelled).toBe(true);
			expect(denied.batches).toHaveLength(0);
			expect(allowed.batches[0].tasks.map((task) => task.sourceText)).toEqual(["public"]);
			allowed.complete(0);
			await clock.advance(1_000);
			denied.freeze("private-more", "final");
			const later = batchFixture(scheduler, "same", "later");
			later.freeze("later", "final");
			await clock.advance(9_999);
			expect(later.batches).toHaveLength(0);
			await clock.advance(1);
			expect(later.batches).toHaveLength(1);
			later.complete(0);
		});
	});

	test("queued key changes join the destination window and preserve old siblings", async () => {
		await withClock(async (clock, scheduler) => {
			const moved = batchFixture(scheduler, "old", "moved");
			const old = batchFixture(scheduler, "old", "old");
			const destination = batchFixture(scheduler, "new", "new");
			destination.response.order = 1;
			moved.freeze("A", "final");
			await clock.advance(4_000);
			destination.freeze("C", "final");
			await clock.advance(4_000);
			old.freeze("B", "final");
			await clock.advance(1_000);
			scheduler.configureBatch(moved.response, "new");
			await clock.advance(1_000);
			expect(old.batches[0].tasks.map((task) => task.sourceText)).toEqual(["B"]);
			expect(moved.batches).toHaveLength(0);
			expect(destination.batches).toHaveLength(0);
			old.complete(0);
			await clock.advance(3_999);
			scheduler.configureBatch(moved.response, "new");
			expect(moved.batches).toHaveLength(0);
			await clock.advance(1);
			expect(moved.batches[0].tasks.map((task) => task.sourceText)).toEqual(["A", "C"]);
			moved.complete(0);
		});
	});

	test("an elapsed unsent window stays ready across key changes without admitting new sources", async () => {
		await withClock(async (clock, scheduler) => {
			const f = batchFixture(scheduler, "old");
			const release = scheduler.hold();
			f.freeze("A", "final", "a");
			await clock.advance(11_000);
			scheduler.configureBatch(f.response, "new");
			release();
			await tick();
			expect(f.batches[0].tasks.map((task) => task.sourceText)).toEqual(["A"]);
			f.freeze("B", "final", "b");
			f.complete(0);
			await clock.advance(9_999);
			expect(f.batches).toHaveLength(1);
			await clock.advance(1);
			expect(f.batches[1].tasks.map((task) => task.sourceText)).toEqual(["B"]);
			f.complete(1);
		});
	});

	for (const target of ["new", undefined]) {
		test(`mature 32KiB leftovers retain readiness after active migration to ${target}`, async () => {
			await withClock(async (clock, scheduler) => {
				const f = batchFixture(scheduler, "old");
				const source = `${"😀".repeat(8192)}Z`;
				f.freeze(source, "final");
				await clock.advance(10_000);
				expect(Buffer.byteLength(f.batches[0].tasks[0].sourceText)).toBe(32 * 1024);
				await clock.advance(500);
				f.freeze(`${source}tail`, "final");
				await clock.advance(500);
				scheduler.configureBatch(f.response, target);
				await clock.advance(1_000);
				f.complete(0);
				await tick();
				expect(f.response.batchKey).toBe(target);
				if (target) {
					expect(f.batches[1].tasks.map((task) => task.sourceText)).toEqual(["Z"]);
					expect(f.batches[1].tasks[0]).toMatchObject({ start: 16384, end: 16385 });
					f.complete(1);
				} else {
					expect(f.requests[0].task).toMatchObject({ sourceText: "Z", start: 16384, end: 16385 });
					f.requests[0].resolve("译");
				}
				await clock.advance(8_999);
				expect(f.batches).toHaveLength(target ? 2 : 1);
				expect(f.requests).toHaveLength(target ? 0 : 1);
				await clock.advance(1);
				if (target) {
					expect(f.batches[2].tasks.map((task) => task.sourceText)).toEqual(["tail"]);
					f.complete(2);
				} else {
					expect(f.requests[1].task.sourceText).toBe("tail");
					f.requests[1].resolve("译");
				}
				await tick();
				expect(f.response.tasks).toBe(3);
				expect(f.response.queuedAt).toBe(0);
			});
		});

		test(`active key migration to ${target} reassigns queued windows before finally`, async () => {
			await withClock(async (clock, scheduler) => {
				const f = batchFixture(scheduler, "old", "first");
				const peer = batchFixture(scheduler, "old", "peer");
				f.freeze("A", "final", "a");
				await clock.advance(10_000);
				await clock.advance(1_000);
				f.freeze("B", "final", "b");
				await clock.advance(1_000);
				scheduler.configureBatch(f.response, target);
				expect(f.response.batchKey).toBe("old");
				await clock.advance(1_000);
				peer.freeze("C", "final");
				await clock.advance(3_000);
				scheduler.configureBatch(f.response, target);
				f.complete(0);
				await tick();
				expect(f.response.batchKey).toBe(target);
				await clock.advance(5_999);
				expect(f.batches).toHaveLength(1);
				expect(f.requests).toHaveLength(0);
				expect(peer.batches).toHaveLength(0);
				await clock.advance(1);
				if (target) {
					expect(f.batches[1].tasks.map((task) => task.sourceText)).toEqual(["B"]);
					f.complete(1);
				} else {
					expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["B"]);
					f.requests[0].resolve("乙");
				}
				await clock.advance(999);
				expect(peer.batches).toHaveLength(0);
				await clock.advance(1);
				expect(peer.batches[0].tasks.map((task) => task.sourceText)).toEqual(["C"]);
				peer.complete(0);
				expect(f.response.queuedAt).toBe(0);
			});
		});
	}

	test("queue-full admissions never open a window or reopen their reserved prefix", async () => {
		await withClock(
			async (clock, scheduler) => {
				const f = fixture(scheduler);
				f.freeze("A", "final", "a");
				f.freeze("B", "final", "b");
				f.freeze("C", "final", "c");
				expect(scheduler.stats()).toMatchObject({ active: 0, queued: 2 });
				expect(f.response.sourceBytes).toBe(2);
				await clock.advance(10_000);
				expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
				f.freeze("C", "final", "c");
				f.requests[0].resolve("甲");
				await tick();
				expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "B"]);
				f.requests[1].resolve("乙");
				await tick();
				f.freeze("C", "final", "c");
				expect(f.response.sourceBytes).toBe(2);
				expect(f.response.pending).toBe(0);
				expect(clock.pending()).toBe(0);
			},
			{ concurrency: 1, queuedBlocks: 2 },
		);
	});

	test("four global slots dispatch mature groups without starting another wait", async () => {
		await withClock(async (clock, scheduler) => {
			const groups = Array.from({ length: 5 }, (_, index) => batchFixture(scheduler, `${index}`));
			for (const group of groups) group.freeze("A", "final");
			await clock.advance(9_999);
			expect(scheduler.stats().active).toBe(0);
			await clock.advance(1);
			expect(scheduler.stats()).toMatchObject({ active: 4, queued: 1 });
			expect(groups.map((group) => group.batches.length)).toEqual([1, 1, 1, 1, 0]);
			groups[0].complete(0);
			await tick();
			expect(groups[4].batches).toHaveLength(1);
			expect(scheduler.stats().active).toBe(4);
			for (const group of groups.slice(1)) group.complete(0);
		});
	});

	for (const batched of [false, true]) {
		test(`ten-second queueing remains inside the original thirty-second deadline (${batched})`, async () => {
			await withClock(async (clock, scheduler) => {
				const f = batchFixture(scheduler, "deadline");
				if (!batched) scheduler.configureBatch(f.response, undefined);
				f.freeze("A", "final", "a");
				await clock.advance(10_000);
				const signal = batched ? f.batches[0].signal : f.requests[0].signal;
				await clock.advance(15_000);
				f.freeze("B", "final", "b");
				await clock.advance(4_999);
				expect(signal.aborted).toBe(false);
				expect(scheduler.stats()).toMatchObject({ active: 1, queued: 1 });
				await clock.advance(1);
				expect(signal.aborted).toBe(true);
				expect(scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
				expect(clock.pending()).toBe(0);
				f.freeze("B", "final", "b");
				f.freeze("C", "final", "c");
				expect(f.response.sourceBytes).toBe(2);
				expect(f.response.queuedAt).toBe(0);
				if (batched) {
					expect(f.batches).toHaveLength(1);
					f.complete(0);
				} else {
					expect(f.requests).toHaveLength(1);
					f.requests[0].resolve("late");
				}
				await tick();
				expect(f.parts).toHaveLength(0);
			});
		});
	}

	test("the task ceiling drops mature batch leftovers without renewing their window", async () => {
		await withClock(
			async (clock, scheduler) => {
				const f = batchFixture(scheduler, "limited");
				const source = "A".repeat(3 * 32 * 1024);
				f.freeze(source, "final");
				await clock.advance(10_000);
				f.complete(0);
				await tick();
				expect(f.batches).toHaveLength(2);
				f.complete(1);
				await tick();
				expect(f.response.tasks).toBe(2);
				expect(f.response.pending).toBe(0);
				f.freeze(`${source}B`, "final");
				await clock.advance(10_000);
				expect(f.batches).toHaveLength(2);
				expect(f.parts.map((part) => part.sourceText).join("")).toHaveLength(2 * 32 * 1024);
				expect(clock.pending()).toBe(0);
			},
			{ tasks: 2 },
		);
	});
});

describe("bounded reasoning translation scheduler", () => {
	test("batch membership upgrades after singles and migrates after the captured old batch settles", async () => {
		const f = fixture();
		const batches: Array<{
			key?: string;
			tasks: TranslationTask[];
			resolve: (text: string) => void;
		}> = [];
		f.response.translateBatch = async (tasks) =>
			new Promise<string>((resolve) => {
				batches.push({ key: f.response.batchKey, tasks: [...tasks], resolve });
			});
		try {
			f.freeze("A", "final", "A");
			const queuedAt = f.response.queuedAt;
			f.scheduler.configureBatch(f.response, "run-one");
			f.freeze("B", "final", "B");
			f.freeze("C", "final", "C");
			f.scheduler.settle(f.response);
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
			expect(batches).toHaveLength(0);
			f.requests[0].resolve("甲");
			await tick();
			await tick();
			expect(
				batches.map((batch) => [batch.key, batch.tasks.map((task) => task.sourceText)]),
			).toEqual([["run-one", ["B", "C"]]]);
			f.scheduler.configureBatch(f.response, "run-two");
			expect(f.response.batchTransition?.key).toBe("run-two");
			f.scheduler.configureBatch(f.response, "run-one");
			expect(f.response.batchTransition).toBeUndefined();
			f.scheduler.configureBatch(f.response, "run-two");
			f.response.settled = false;
			f.freeze("D", "final", "D");
			f.scheduler.settle(f.response);
			await tick();
			expect(batches).toHaveLength(1);
			batches[0].resolve(
				JSON.stringify({
					parts: batches[0].tasks.map((task) => ({ id: task.id, translatedText: "译" })),
				}),
			);
			await tick();
			await tick();
			expect(batches.map((batch) => batch.key)).toEqual(["run-one", "run-two"]);
			expect(batches[1].tasks.map((task) => task.sourceText)).toEqual(["D"]);
			batches[1].resolve(
				JSON.stringify({
					parts: batches[1].tasks.map((task) => ({ id: task.id, translatedText: "译" })),
				}),
			);
			await tick();
			await tick();
			expect(f.parts.map((part) => part.sourceText)).toEqual(["A", "B", "C", "D"]);
			expect(f.response.queuedAt).toBe(queuedAt);
			expect(f.response.tasks).toBe(3);
			expect(f.response.sourceBytes).toBe(4);
			expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
		} finally {
			for (const batch of batches) batch.resolve("invalid");
			await f.scheduler.stop();
		}
	});

	test("a detached in-flight batch defers migration to undefined until its finally releases the old key", async () => {
		const f = fixture();
		const result = Promise.withResolvers<string>();
		let batches = 0;
		f.response.batchKey = "old";
		f.response.translateBatch = async () => {
			batches++;
			return result.promise;
		};
		try {
			const resume = f.scheduler.hold();
			f.freeze("B", "final", "B");
			f.freeze("C", "final", "C");
			f.scheduler.settle(f.response);
			resume();
			await tick();
			expect(batches).toBe(1);
			f.scheduler.retain(f.response, () => false);
			f.scheduler.configureBatch(f.response, undefined);
			expect(f.response.batchKey).toBe("old");
			f.response.settled = false;
			f.freeze("D", "final", "D");
			f.scheduler.settle(f.response);
			expect(f.requests).toHaveLength(0);
			await tick();
			await tick();
			expect(f.response.batchKey).toBeUndefined();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["D"]);
			f.requests[0].resolve("丁");
			await tick();
			await tick();
			expect(f.parts.map((part) => part.sourceText)).toEqual(["D"]);
			expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
		} finally {
			result.resolve("invalid");
			await f.scheduler.stop();
		}
	});

	test("range retain preserves an active prefix while replanning its invalid queued tail", async () => {
		const f = fixture();
		f.freeze("A", "final");
		f.freeze("ABC", "summary");
		f.scheduler.retain(f.response, (start, end) => start >= 0 && end <= 2);
		expect(f.requests[0].signal.aborted).toBe(false);
		f.freeze("ABC", "final", "element", "g", { start: 0, end: 2 });
		expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
		f.requests[0].resolve("甲");
		await tick();
		expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "B"]);
		f.requests[1].resolve("乙");
		f.scheduler.settle(f.response);
		await tick();
		expect(f.parts.map((part) => part.sourceText)).toEqual(["A", "B"]);
		expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
		await f.scheduler.stop();
	});

	test("batch authorization races filter only the reopened member before provider invocation", async () => {
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
		});
		const authorized = Promise.withResolvers<boolean>();
		let maxEnd = 3;
		const sent: string[][] = [];
		const applied: string[] = [];
		const response = scheduler.create({
			sessionId: "author",
			batchKey: "same-run",
			canTranslate: () => authorized.promise,
			permitsTask: (task) => task.end <= maxEnd,
			translate: async () => "unused",
			translateBatch: async (tasks) => {
				sent.push(tasks.map((task) => task.sourceText));
				return JSON.stringify({
					parts: tasks.map((task) => ({ id: task.id, translatedText: "译" })),
				});
			},
			apply: async (task) => {
				applied.push(task.sourceText);
				return true;
			},
		});
		const resume = scheduler.hold();
		for (const [start, end] of [
			[0, 1],
			[1, 3],
		])
			scheduler.freeze(response, {
				elementId: `r:${start}`,
				messageId: "message",
				generation: "g",
				text: "ABC",
				start,
				end,
				reason: "final",
			});
		scheduler.settle(response);
		resume();
		await tick();
		maxEnd = 1;
		scheduler.retain(response, (start, end) => start >= 0 && end <= maxEnd);
		authorized.resolve(true);
		await tick();
		expect(sent).toEqual([["A"]]);
		expect(applied).toEqual(["A"]);
		await scheduler.stop();
	});

	test("production budgets and UTF-8 prefixes preserve surrogate pairs", () => {
		expect(REASONING_TRANSLATION_LIMITS).toEqual({
			concurrency: 4,
			queuedBlocks: 64,
			coalesceMs: 10_000,
			deadlineMs: 30_000,
			sourceBytes: 262144,
			tasks: 32,
			outputBytes: 524288,
		});
		expect(translationPrefixEnd("中😀A", 0, 4, 6)).toBe(1);
		expect(translationPrefixEnd("中😀A", 0, 4, 7)).toBe(3);
		expect(translationPrefixEnd("已译😀中A", 2, 6, 6)).toBe(4);
		expect(translationPrefixEnd("已译😀中A", 2, 6, 7)).toBe(5);
	});

	test("one active task and merged tail reserve only new source", async () => {
		const f = fixture();
		f.freeze("A");
		f.freeze("AB", "summary");
		f.freeze("ABC", "final");
		f.freeze("ABC", "final");
		expect(f.requests.map((request) => request.task.sourceText)).toEqual(["A"]);
		expect(f.scheduler.stats()).toMatchObject({ active: 1, queued: 1 });
		f.requests[0].resolve("甲");
		await tick();
		expect(f.requests.map((request) => request.task.sourceText)).toEqual(["A", "BC"]);
		expect(f.requests[1].task).toMatchObject({
			elementId: "element",
			messageId: "message",
			start: 1,
			end: 3,
		});
		f.requests[1].resolve("乙丙");
		f.scheduler.settle(f.response);
		await tick();
		expect(f.parts.map((part) => part.translatedText)).toEqual(["甲", "乙丙"]);
		expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
		expect(f.response.blocks.size).toBe(0);
	});

	test("summary coalescing wakes without a final event while the foreground is awaiting", async () => {
		await withClock(async (clock, scheduler) => {
			const f = fixture(scheduler);
			f.freeze("A", "summary");
			await clock.advance(9_000);
			f.freeze("AB", "summary");
			await clock.advance(999);
			expect(f.requests).toHaveLength(0);
			await clock.advance(1);
			expect(f.requests.map((request) => request.task.sourceText)).toEqual(["AB"]);
			scheduler.settle(f.response);
			await releaseAll(f);
		});
	});

	test("tool and duplicate final events preserve the first summary window", async () => {
		await withClock(async (clock, scheduler) => {
			const f = fixture(scheduler);
			f.freeze("A", "summary");
			await clock.advance(5_000);
			f.freeze("AB", "summary");
			f.freeze("AB", "tool");
			await clock.advance(4_999);
			f.freeze("AB", "final");
			f.freeze("AB", "final");
			expect(f.requests).toHaveLength(0);
			scheduler.settle(f.response);
			expect(f.requests).toHaveLength(0);
			await clock.advance(1);
			expect(f.requests.map((request) => request.task.sourceText)).toEqual(["AB"]);
			expect(f.requests[0].task.reason).toBe("final");
			await releaseAll(f);
		});
	});

	test("failed ranges remain reserved while later intervals and independent elements continue", async () => {
		const f = fixture();
		f.freeze("A");
		f.requests[0].reject(new Error("synthetic failure"));
		await tick();
		f.freeze("A");
		f.freeze("AB");
		f.freeze("X", "tool", "independent");
		expect(f.requests.map((request) => request.task.sourceText)).toEqual(["A", "B", "X"]);
		f.scheduler.settle(f.response);
		await releaseAll(f);
		expect(f.parts.map((part) => part.sourceText)).toEqual(["B", "X"]);
		expect(f.response.tasks).toBe(3);
	});

	test("four global slots, 64 queued elements and fair session rotation", async () => {
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
		});
		const one = fixture(scheduler, "one");
		const two = fixture(scheduler, "two");
		for (let i = 0; i < 4; i++) one.freeze("A", "tool", `active-${i}`);
		one.freeze("A", "tool", "queued-one");
		two.freeze("B", "tool", "queued-two");
		for (let i = 0; i < 63; i++) two.freeze("C", "tool", `pending-${i}`);
		expect(scheduler.stats()).toMatchObject({ active: 4, queued: 64 });
		expect(two.response.pending).toBe(63);
		expect(two.response.sourceBytes).toBe(63);
		one.requests[0].resolve("甲");
		await tick();
		one.requests[1].resolve("甲");
		await tick();
		expect(two.requests[0].task.elementId).toBe("queued-two");
		scheduler.cancel(one.response);
		scheduler.cancel(two.response);
		await tick();
		expect(scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
	});

	test("16KiB task splits and the 256KiB source ceiling are exact", async () => {
		const f = fixture();
		const text = `已译${"😀".repeat(65536)}tail`;
		f.freeze(text, "final", "gap:2", "g", { start: 2 });
		expect(f.response.sourceBytes).toBe(256 * 1024);
		f.scheduler.settle(f.response);
		await releaseAll(f);
		expect(f.requests).toHaveLength(16);
		expect(f.requests[0].task.start).toBe(2);
		expect(f.requests.at(-1)?.task.end).toBe(131074);
		for (const request of f.requests) {
			expect(request.task.sourceText).toBe(text.slice(request.task.start, request.task.end));
			expect(Buffer.byteLength(request.task.sourceText)).toBe(16 * 1024);
			expect(request.task.start % 2).toBe(0);
			expect(request.task.end % 2).toBe(0);
		}
	});

	test("completed requests split only above 32KiB and preserve Unicode source coordinates", async () => {
		const f = fixture();
		const batches: TranslationTask[][] = [];
		f.response.batchKey = "completed";
		f.response.translateBatch = async (tasks) => {
			batches.push([...tasks]);
			return JSON.stringify({
				parts: [...tasks].reverse().map((task) => ({ id: task.id, translatedText: "译" })),
			});
		};
		const other = fixture(f.scheduler);
		other.response.batchKey = "completed";
		other.response.order = 1;
		other.response.translateBatch = f.response.translateBatch;
		const resume = f.scheduler.hold();
		const text = "😀".repeat(8193);
		f.freeze(text, "final");
		other.freeze("B", "final", "other");
		f.scheduler.settle(f.response);
		f.scheduler.settle(other.response);
		resume();
		await tick();
		await tick();
		expect(batches).toHaveLength(2);
		expect(
			batches.map((tasks) =>
				tasks.reduce((bytes, task) => bytes + Buffer.byteLength(task.sourceText), 0),
			),
		).toEqual([32768, 5]);
		expect(f.parts.map((part) => [part.start, part.end])).toEqual([
			[0, 16384],
			[16384, 16386],
		]);
		expect(f.parts.map((part) => part.sourceText).join("")).toBe(text);
		expect(other.parts.map((part) => part.sourceText)).toEqual(["B"]);
		expect(f.response.tasks).toBe(2);
		expect(other.response.tasks).toBe(1);
		await f.scheduler.stop();
	});

	test("a duplicate completed-result ID rejects the entire request before applying any part", async () => {
		const f = fixture();
		const resume = f.scheduler.hold();
		f.response.batchKey = "completed";
		f.response.translateBatch = async (tasks) =>
			JSON.stringify({ parts: tasks.map(() => ({ id: tasks[0].id, translatedText: "错误" })) });
		f.freeze("A", "final", "one");
		f.freeze("B", "final", "two");
		f.scheduler.settle(f.response);
		resume();
		await tick();
		expect(f.response.tasks).toBe(1);
		expect(f.parts).toEqual([]);
		expect(f.scheduler.stats()).toMatchObject({ active: 0, queued: 0 });
		await f.scheduler.stop();
	});

	test("32 task ceiling includes completed and failed work", async () => {
		const f = fixture();
		for (let i = 1; i <= 33; i++) {
			f.freeze("A".repeat(i));
			if (i <= 32) {
				if (i % 2 === 0) f.requests[i - 1].reject(new Error("synthetic failure"));
				else f.requests[i - 1].resolve("甲");
				await tick();
			}
		}
		expect(f.requests).toHaveLength(32);
		expect(f.response.tasks).toBe(32);
		expect(f.response.sourceBytes).toBe(32);
		expect(f.parts).toHaveLength(16);
		f.scheduler.settle(f.response);
	});

	test("streamed output over 64KiB aborts without applying a late result", async () => {
		const f = fixture();
		f.freeze("A");
		f.requests[0].delta("中".repeat(22000));
		expect(f.requests[0].signal.aborted).toBe(true);
		f.requests[0].resolve("late");
		await tick();
		expect(f.parts).toHaveLength(0);
		expect(f.response.pending).toBe(0);
		expect(f.scheduler.stats()).toMatchObject({ active: 0, queued: 0 });
		f.scheduler.settle(f.response);
	});

	test("empty and oversized completed output is rejected while exact 64KiB remains valid", async () => {
		const f = fixture();
		f.freeze("A");
		f.requests[0].resolve("");
		await tick();
		f.freeze("AB");
		f.requests[1].resolve("x".repeat(65537));
		await tick();
		expect(f.parts).toHaveLength(0);
		f.freeze("ABC");
		f.requests[2].resolve("x".repeat(65536));
		f.scheduler.settle(f.response);
		await tick();
		expect(f.parts).toHaveLength(1);
		expect(f.parts[0].sourceText).toBe("C");
		expect(Buffer.byteLength(f.parts[0].translatedText)).toBe(65536);
		expect(f.response.tasks).toBe(3);
	});

	test("streaming output shares one response budget and releases its queued work", async () => {
		const f = fixture(
			new ReasoningTranslationScheduler({
				...REASONING_TRANSLATION_LIMITS,
				coalesceMs: 0,
				concurrency: 2,
				outputBytes: 7,
			}),
		);
		f.freeze("A", "tool", "one");
		f.freeze("B", "tool", "two");
		f.freeze("C", "tool", "three");
		f.requests[0].delta("1234");
		f.requests[1].delta("5678");
		expect(f.requests[1].signal.aborted).toBe(true);
		await tick();
		f.requests[1].delta("late");
		f.requests[1].resolve("late");
		f.requests[0].resolve("甲");
		await tick();
		f.freeze("D", "tool", "four");
		expect(f.response.outputBytes).toBe(7);
		expect(f.requests).toHaveLength(2);
		expect(f.parts.map((part) => part.sourceText)).toEqual(["A"]);
		expect(f.response.pending).toBe(0);
		f.scheduler.settle(f.response);
	});

	test("simultaneous completions share the 512KiB cumulative output budget", async () => {
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
		});
		let applied = 0;
		const response = scheduler.create({
			sessionId: "budget",
			translate: async () => "x".repeat(65536),
			apply: async () => {
				applied++;
				return true;
			},
		});
		for (let i = 0; i < 9; i++)
			scheduler.freeze(response, {
				elementId: `${i}`,
				messageId: "m",
				generation: "g",
				text: "a",
				reason: "final",
			});
		scheduler.settle(response);
		await tick();
		await tick();
		expect(response.outputBytes).toBe(512 * 1024);
		expect(applied).toBe(8);
	});

	test("deadline includes queue time and releases providers ignoring abort", async () => {
		await withClock(
			async (clock, scheduler) => {
				const f = fixture(scheduler);
				f.freeze("A", "tool", "active");
				f.freeze("B", "tool", "queued");
				await clock.advance(10);
				expect(f.requests).toHaveLength(1);
				expect(f.requests[0].signal.aborted).toBe(true);
				expect(scheduler.stats().active).toBe(0);
				expect(f.response.pending).toBe(0);
				expect(scheduler.stats().queued).toBe(0);
				f.requests[0].resolve("late");
				await tick();
				expect(f.parts).toHaveLength(0);
				scheduler.settle(f.response);
			},
			{ coalesceMs: 0, concurrency: 1, deadlineMs: 10 },
		);
	});

	test("generation replacement cancels old work before translating the new source", async () => {
		const f = fixture();
		f.freeze("old");
		f.freeze("\n\nnew😀\n", "tool", "element", "new");
		expect(f.requests[0].signal.aborted).toBe(true);
		await tick();
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1].task.sourceText).toBe("\n\nnew😀\n");
		f.requests[0].resolve("late");
		f.requests[1].resolve("新😀");
		await tick();
		expect(f.parts).toHaveLength(1);
		expect(f.parts[0].generation).toBe("new");
		expect(f.parts[0].translatedText).toBe("\n\n新😀\n");
		f.scheduler.settle(f.response);
	});

	test("shutdown retains an awaited persistence callback until its cancellation settles", async () => {
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
		});
		const release = Promise.withResolvers<boolean>();
		let applySignal: AbortSignal | undefined;
		const response = scheduler.create({
			sessionId: "commit",
			translate: async () => "译文",
			apply: (_task, _part, signal) => {
				applySignal = signal;
				return release.promise;
			},
		});
		scheduler.freeze(response, {
			elementId: "element",
			messageId: "message",
			generation: "g",
			text: "A",
			reason: "tool",
		});
		await tick();
		expect(applySignal).toBeDefined();
		let stopped = false;
		const stopping = scheduler.stop({ timeoutMs: 100 }).then(() => {
			stopped = true;
		});
		await tick();
		expect(applySignal?.aborted).toBe(true);
		expect(stopped).toBe(false);
		release.resolve(false);
		await stopping;
		expect(stopped).toBe(true);
	});

	test("invalid UTF-16 ranges leave source and queue reservations unchanged", async () => {
		const f = fixture();
		for (const [start, end] of [
			[-1, 4],
			[0, 5],
			[1.5, 4],
			[0, Infinity],
			[NaN, 4],
			[0, NaN],
			[2, 4],
			[0, 2],
			[3, 1],
		])
			f.freeze("A😀B", "tool", "element", "g", { start, end });
		expect(f.requests).toHaveLength(0);
		expect(f.response.blocks.size).toBe(0);
		expect(f.response.sourceBytes).toBe(0);
		expect(f.response.pending).toBe(0);
		f.freeze("A😀B", "tool", "element", "g", { start: 1, end: 3 });
		f.freeze("A😀B", "tool", "element", "new", { start: 2, end: 4 });
		expect(f.requests[0].signal.aborted).toBe(false);
		expect(f.requests[0].task).toMatchObject({ start: 1, end: 3, sourceText: "😀" });
		f.freeze("AB😀C", "tool", "element", "g", { start: 1, end: 5 });
		f.freeze("A😀B", "tool", "element", "g", { start: 1, end: 3 });
		expect(f.requests).toHaveLength(1);
		expect(f.response.sourceBytes).toBe(4);
		f.scheduler.settle(f.response);
		f.freeze("A😀B", "tool", "element", "g", { start: 1, end: 4 });
		f.scheduler.cancel(f.response);
		f.freeze("A😀B", "tool", "element", "g", { start: 1, end: 4 });
		f.requests[0].resolve("迟到");
		await f.scheduler.stop();
		f.freeze("A😀B");
		expect(f.requests).toHaveLength(1);
		expect(f.parts).toHaveLength(0);
		expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
	});

	test("independent gaps preserve source offsets and share the response UTF-8 budget", async () => {
		const f = fixture(
			new ReasoningTranslationScheduler({
				...REASONING_TRANSLATION_LIMITS,
				coalesceMs: 0,
				sourceBytes: 7,
			}),
		);
		const text = "A😀B中C";
		f.freeze(text, "final", "gap:1", "g", { start: 1, end: 3 });
		f.freeze(text, "final", "gap:4", "g", { start: 4, end: 5 });
		f.freeze(text, "final", "gap:5", "g", { start: 5, end: 6 });
		f.freeze(text, "final", "gap:1", "g", { start: 1, end: 3 });
		expect(f.requests.map(({ task }) => [task.start, task.end, task.sourceText])).toEqual([
			[1, 3, "😀"],
			[4, 5, "中"],
		]);
		expect(f.response.sourceBytes).toBe(7);
		expect(f.response.pending).toBe(2);
		f.scheduler.settle(f.response);
		await releaseAll(f);
		expect(f.parts.map((part) => [part.start, part.end, part.sourceText])).toEqual([
			[1, 3, "😀"],
			[4, 5, "中"],
		]);
		expect(f.response.blocks.size).toBe(0);
		expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
	});

	test("an active range only coalesces an adjacent tail within its gap key", async () => {
		const f = fixture();
		const text = "ab😀cdEF😀gh";
		f.freeze(text, "tool", "gap:2", "g", { start: 2, end: 4 });
		f.freeze(text, "summary", "gap:2", "g", { start: 2, end: 5 });
		f.freeze(text, "final", "gap:2", "g", { start: 6, end: 8 });
		expect(f.response.sourceBytes).toBe(5);
		expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["😀"]);
		f.freeze(text, "final", "gap:6", "g", { start: 6, end: 8 });
		f.freeze(text, "final", "gap:2", "g", { start: 2, end: 5 });
		f.requests[0].resolve("甲");
		await tick();
		expect(f.requests.map(({ task }) => [task.start, task.end, task.sourceText])).toEqual([
			[2, 4, "😀"],
			[6, 8, "EF"],
			[4, 5, "c"],
		]);
		f.scheduler.settle(f.response);
		await releaseAll(f);
	});

	test("cancelled demand rebuilds only the remaining source in a fresh response", async () => {
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
		});
		const first = fixture(scheduler);
		const text = "ABCDE";
		first.freeze(text, "tool", "gap:0", "g", { start: 0, end: 1 });
		first.requests[0].resolve("甲");
		await tick();
		first.freeze(text, "tool", "gap:0", "g", { start: 0, end: 3 });
		first.freeze(text, "summary", "gap:0", "g", { start: 0, end: 5 });
		expect(scheduler.stats()).toMatchObject({ active: 1, queued: 1 });
		first.requests[1].resolve("迟到");
		scheduler.cancel(first.response);
		first.requests[1].delta("late");
		first.freeze(text);
		await tick();
		expect(first.parts.map((part) => part.sourceText)).toEqual(["A"]);
		expect(first.response.outputBytes).toBe(3);
		expect(first.requests[1].signal.aborted).toBe(true);
		expect(first.requests).toHaveLength(2);
		expect(first.response.blocks.size).toBe(0);
		const visible = fixture(scheduler);
		visible.freeze(text, "final", "gap:1", "g", { start: 1 });
		expect(visible.requests[0].task).toMatchObject({ start: 1, end: 5, sourceText: "BCDE" });
		scheduler.settle(visible.response);
		await releaseAll(visible);
		expect(visible.parts.map((part) => part.sourceText)).toEqual(["BCDE"]);
		expect(scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
	});

	test("blocked admissions retain bounded block identities without spending source bytes", async () => {
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
			concurrency: 1,
			queuedBlocks: 2,
			tasks: 2,
		});
		const f = fixture(scheduler);
		for (let index = 0; index < 100; index++) f.freeze("A", "tool", `gap:${index}`);
		expect(f.response.blocks.size).toBe(4);
		expect(f.response.sourceBytes).toBe(3);
		expect(f.response.pending).toBe(3);
		expect(scheduler.stats()).toMatchObject({ active: 1, queued: 2 });
		scheduler.settle(f.response);
		await releaseAll(f);
		expect(f.requests).toHaveLength(2);
		expect(f.parts).toHaveLength(2);
		expect(f.response.pending).toBe(0);
		expect(f.response.blocks.size).toBe(0);
	});

	test("coalesced gaps cannot start past the task budget when multiple slots open", async () => {
		await withClock(
			async (clock, scheduler) => {
				const f = fixture(scheduler);
				for (let index = 0; index < 3; index++) f.freeze("A", "summary", `gap:${index}`);
				scheduler.settle(f.response);
				await clock.advance(10_000);
				expect(f.requests).toHaveLength(2);
				expect(f.response.tasks).toBe(2);
				await releaseAll(f);
				expect(f.parts).toHaveLength(2);
				expect(f.response.pending).toBe(0);
			},
			{ tasks: 2 },
		);
	});

	test("cancelling one response keeps another response in the same session runnable", async () => {
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
			concurrency: 1,
		});
		const hidden = fixture(scheduler, "shared");
		const visible = fixture(scheduler, "shared");
		hidden.freeze("A");
		hidden.freeze("AB", "summary");
		visible.freeze("C");
		scheduler.cancel(hidden.response);
		await tick();
		expect(hidden.requests[0].signal.aborted).toBe(true);
		expect(hidden.response.pending).toBe(0);
		expect(visible.requests).toHaveLength(1);
		expect(visible.requests[0].signal.aborted).toBe(false);
		hidden.requests[0].resolve("迟到");
		visible.requests[0].resolve("丙");
		scheduler.settle(visible.response);
		await tick();
		expect(hidden.parts).toHaveLength(0);
		expect(visible.parts.map((part) => part.sourceText)).toEqual(["C"]);
		expect(scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
	});

	test("shutdown cancels queued and in-flight tasks and closes future admission", async () => {
		const f = fixture(
			new ReasoningTranslationScheduler({
				...REASONING_TRANSLATION_LIMITS,
				coalesceMs: 0,
				concurrency: 1,
			}),
		);
		f.freeze("A");
		f.freeze("AB", "summary");
		const queued = fixture(f.scheduler, "other");
		queued.freeze("C");
		const stopping = f.scheduler.stop({ timeoutMs: 100 });
		f.freeze("new", "tool", "new");
		const next = fixture(f.scheduler);
		next.freeze("new");
		expect(f.requests[0].signal.aborted).toBe(true);
		expect(f.scheduler.stats().queued).toBe(0);
		expect(next.requests).toHaveLength(0);
		expect(queued.requests).toHaveLength(0);
		expect(queued.response.pending).toBe(0);
		await stopping;
		f.requests[0].resolve("late");
		await tick();
		f.freeze("new", "tool", "new");
		expect(f.requests).toHaveLength(1);
		expect(f.parts).toHaveLength(0);
		expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
	});
});
