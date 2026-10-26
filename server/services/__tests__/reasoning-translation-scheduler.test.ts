import { describe, expect, test } from "bun:test";
import type { ReasoningTranslationPart } from "@shared/reasoning-translation";
import {
	REASONING_TRANSLATION_LIMITS,
	ReasoningTranslationScheduler,
	reasoningTranslationDiagnosticId,
	reasoningTranslationDiagnosticNumber,
	type TranslationObservation,
	type TranslationTask,
	translationPrefixEnd,
} from "../reasoning-translation-scheduler";

async function tick(): Promise<void> {
	for (let index = 0; index < 16; index++) await Promise.resolve();
}
function fixture(scheduler = new ReasoningTranslationScheduler(), sessionId = "one") {
	const requests: Array<{
		task: TranslationTask;
		signal: AbortSignal;
		delta: (text: string) => void;
		resolve: (text: string) => void;
		reject: (error: Error) => void;
	}> = [];
	const parts: ReasoningTranslationPart[] = [];
	const observations: TranslationObservation[] = [];
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
		observe: (event) => observations.push(event),
	});
	const freeze = (
		text: string,
		reason: TranslationTask["reason"] = "tool",
		elementId = "element",
		generation = "g",
	) => scheduler.freeze(response, { text, reason, elementId, generation, messageId: "message" });
	return { scheduler, response, requests, parts, observations, freeze };
}
async function releaseAll(f: ReturnType<typeof fixture>): Promise<void> {
	let released = 0;
	while (f.response.pending > 0) {
		for (; released < f.requests.length; released++) f.requests[released].resolve("译文");
		await tick();
	}
}

describe("bounded reasoning translation scheduler", () => {
	test("production budgets and UTF-8 prefixes preserve surrogate pairs", () => {
		expect(REASONING_TRANSLATION_LIMITS).toEqual({
			concurrency: 4,
			queuedBlocks: 64,
			coalesceMs: 300,
			deadlineMs: 30_000,
			sourceBytes: 262144,
			tasks: 32,
			outputBytes: 524288,
		});
		expect(translationPrefixEnd("中😀A", 0, 4, 6)).toBe(1);
		expect(translationPrefixEnd("中😀A", 0, 4, 7)).toBe(3);
		expect(reasoningTranslationDiagnosticId("opaque-id:1")).toBe("opaque-id:1");
		expect(reasoningTranslationDiagnosticId("x".repeat(81))).toBeUndefined();
		expect(reasoningTranslationDiagnosticId("private\nbody")).toBeUndefined();
		for (const value of [NaN, Infinity, -1])
			expect(reasoningTranslationDiagnosticNumber(value)).toBe(0);
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
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 5,
		});
		const f = fixture(scheduler);
		f.freeze("A", "summary");
		f.freeze("AB", "summary");
		expect(f.requests).toHaveLength(0);
		await Bun.sleep(15);
		expect(f.requests.map((request) => request.task.sourceText)).toEqual(["AB"]);
		f.scheduler.settle(f.response);
		await releaseAll(f);
	});

	test("tool boundary flushes coalescing summaries immediately", async () => {
		const f = fixture();
		f.freeze("A", "summary");
		f.freeze("AB", "summary");
		f.freeze("AB", "tool");
		expect(f.requests.map((request) => request.task.sourceText)).toEqual(["AB"]);
		f.scheduler.settle(f.response);
		await releaseAll(f);
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
		expect(
			f.observations.find((event) => event.phase === "task" && event.status === "failed"),
		).toBeDefined();
	});

	test("four global slots, 64 queued elements and fair session rotation", async () => {
		const scheduler = new ReasoningTranslationScheduler();
		const one = fixture(scheduler, "one");
		const two = fixture(scheduler, "two");
		for (let i = 0; i < 4; i++) one.freeze("A", "tool", `active-${i}`);
		one.freeze("A", "tool", "queued-one");
		two.freeze("B", "tool", "queued-two");
		for (let i = 0; i < 63; i++) two.freeze("C", "tool", `pending-${i}`);
		expect(scheduler.stats()).toMatchObject({ active: 4, queued: 64 });
		expect(two.observations.filter((event) => event.reason === "queue_full")).toHaveLength(1);
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
		f.freeze(`${"😀".repeat(65536)}tail`);
		expect(f.response.sourceBytes).toBe(256 * 1024);
		f.scheduler.settle(f.response);
		await releaseAll(f);
		expect(f.requests).toHaveLength(16);
		for (const request of f.requests) {
			expect(Buffer.byteLength(request.task.sourceText)).toBe(16 * 1024);
			expect(request.task.start % 2).toBe(0);
			expect(request.task.end % 2).toBe(0);
		}
	});

	test("32 task ceiling includes completed and failed work", async () => {
		const f = fixture();
		for (let i = 1; i <= 33; i++) {
			f.freeze("A".repeat(i));
			if (i <= 32) {
				f.requests[i - 1].resolve("甲");
				await tick();
			}
		}
		expect(f.requests).toHaveLength(32);
		expect(f.observations.filter((event) => event.reason === "task_budget")).toHaveLength(1);
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
		expect(
			f.observations.find((event) => event.status === "timeout_or_output_budget"),
		).toMatchObject({ abortReason: "task_output_budget" });
		f.scheduler.settle(f.response);
	});

	test("simultaneous completions share the 512KiB cumulative output budget", async () => {
		const scheduler = new ReasoningTranslationScheduler();
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
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			concurrency: 1,
			deadlineMs: 10,
		});
		const f = fixture(scheduler);
		f.freeze("A", "tool", "active");
		f.freeze("B", "tool", "queued");
		await Bun.sleep(25);
		await tick();
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].signal.aborted).toBe(true);
		expect(scheduler.stats().active).toBe(0);
		expect(
			f.observations.find((event) => event.status === "timeout_or_output_budget"),
		).toMatchObject({ abortReason: "deadline" });
		f.requests[0].resolve("late");
		await tick();
		expect(f.parts).toHaveLength(0);
		scheduler.settle(f.response);
	});

	test("generation replacement cancels old work before translating the new source", async () => {
		const f = fixture();
		f.freeze("old");
		f.freeze("\n\nnew😀\n", "tool", "element", "new");
		expect(f.requests[0].signal.aborted).toBe(true);
		await tick();
		expect(f.requests).toHaveLength(2);
		expect(
			f.observations.find((event) => event.status === "timeout_or_output_budget"),
		).toMatchObject({ abortReason: "generation_replaced" });
		f.requests[0].resolve("late");
		f.requests[1].resolve("新😀");
		await tick();
		expect(f.parts).toHaveLength(1);
		expect(f.parts[0].generation).toBe("new");
		expect(f.parts[0].translatedText).toBe("\n\n新😀\n");
		f.scheduler.settle(f.response);
	});

	test("shutdown retains an awaited persistence callback until its cancellation settles", async () => {
		const scheduler = new ReasoningTranslationScheduler();
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

	test("freeze no-ops expose fixed reasons without changing business skip counters", async () => {
		const f = fixture();
		f.scheduler.freeze(f.response, {
			elementId: "element",
			messageId: "message",
			generation: "g",
			text: "😀",
			end: 1,
			reason: "summary",
		});
		f.freeze("A");
		f.freeze("A");
		expect(f.response.skips.size).toBe(0);
		f.scheduler.settle(f.response);
		f.freeze("AB");
		f.scheduler.cancel(f.response, "stream_reset");
		f.freeze("AB");
		await tick();
		await f.scheduler.stop();
		f.freeze("AB");
		expect(
			f.observations.filter((event) => event.status === "noop").map((event) => event.reason),
		).toEqual(["invalid_boundary", "no_new_range", "settled", "cancelled", "stopping"]);
		expect(
			f.observations.find((event) => event.phase === "task" && event.status === "cancelled"),
		).toMatchObject({ abortReason: "stream_reset", pending: 0, active: 0, queued: 0 });
		expect(f.requests).toHaveLength(1);
		expect(f.parts).toHaveLength(0);
		expect(f.response.skips.size).toBe(0);
	});

	test("settle and idle summaries see blocks and skip totals before cleanup", async () => {
		const f = fixture(
			new ReasoningTranslationScheduler({
				...REASONING_TRANSLATION_LIMITS,
				sourceBytes: 1,
			}),
		);
		const cleanupSnapshots: Array<{ blocks: number; skips: number }> = [];
		f.response.observe = (event) => {
			f.observations.push(event);
			if (event.status === "idle")
				cleanupSnapshots.push({
					blocks: f.response.blocks.size,
					skips: f.response.skips.size,
				});
		};
		f.freeze("AB");
		f.scheduler.settle(f.response, "final");
		expect(f.observations.find((event) => event.status === "started")).toMatchObject({
			pending: 1,
			active: 1,
			queued: 0,
		});
		expect(f.observations.find((event) => event.status === "settled")).toMatchObject({
			reason: "final",
			tasks: 1,
			blocks: 1,
			sourceBytes: 1,
			outputBytes: 0,
			skips: 1,
			sourceBudgetSkips: 1,
			pending: 1,
		});
		f.requests[0].resolve("甲");
		await tick();
		expect(f.observations.find((event) => event.status === "applied")).toMatchObject({
			pending: 0,
			active: 0,
			queued: 0,
		});
		expect(f.observations.find((event) => event.status === "idle")).toMatchObject({
			reason: "final",
			tasks: 1,
			blocks: 1,
			sourceBytes: 1,
			outputBytes: 3,
			skips: 1,
			sourceBudgetSkips: 1,
			pending: 0,
		});
		expect(cleanupSnapshots).toEqual([{ blocks: 1, skips: 1 }]);
		expect(f.response.blocks.size).toBe(0);
		expect(f.response.skips.size).toBe(0);
		f.scheduler.settle(f.response);
		expect(f.observations.filter((event) => event.status === "idle")).toHaveLength(1);
	});

	test("response diagnostics cap detail records, summarize suppression and exclude content", async () => {
		const f = fixture(
			new ReasoningTranslationScheduler({
				...REASONING_TRANSLATION_LIMITS,
				tasks: 60,
				coalesceMs: 0,
			}),
			"PRIVATE SESSION CREDENTIAL",
		);
		const source = "PRIVATE SOURCE BODY";
		const elementId = "PRIVATE ELEMENT WITH SPACES";
		for (let index = 0; index < 54; index++) {
			f.freeze(
				source + "a".repeat(index),
				(["tool", "summary", "final"] as const)[index % 3],
				elementId,
			);
			const request = f.requests[index];
			if (index === 0) {
				const count = f.observations.length;
				for (let delta = 0; delta < 1000; delta++) request.delta("x");
				expect(f.observations).toHaveLength(count);
			}
			const outcome = Math.floor(index / 3) % 3;
			if (outcome === 2) request.reject(new Error("PRIVATE EXCEPTION TEXT"));
			else request.resolve(outcome === 1 ? "" : "PRIVATE TRANSLATION BODY");
			await tick();
		}
		for (let index = 0; index < 1000; index++) f.freeze(source + "a".repeat(53), "tool", elementId);
		f.freeze("REPLACEMENT PRIVATE BODY", "tool", elementId, "new");
		f.scheduler.cancel(f.response, "error");
		await tick();
		const details = f.observations.filter((event) => event.phase !== "response");
		expect(details).toHaveLength(32);
		expect(details.filter((event) => event.reason === "no_new_range")).toHaveLength(2);
		expect(f.observations.length).toBeLessThanOrEqual(35);
		expect(f.response.diagnostics.counts.size).toBeLessThanOrEqual(32);
		expect(f.observations.find((event) => event.status === "idle")?.suppressed).toBeGreaterThan(
			1000,
		);
		const serialized = JSON.stringify(f.observations);
		for (const secret of [
			source,
			elementId,
			"PRIVATE SESSION",
			"PRIVATE EXCEPTION",
			"PRIVATE TRANSLATION",
			"REPLACEMENT PRIVATE",
		])
			expect(serialized).not.toContain(secret);
		for (const event of f.observations) {
			for (const value of Object.values(event)) {
				if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
			}
		}
	});

	test("throwing observers cannot prevent admission, apply, cancellation or cleanup", async () => {
		const f = fixture(
			new ReasoningTranslationScheduler({
				...REASONING_TRANSLATION_LIMITS,
				sourceBytes: 1,
			}),
		);
		let idle = 0;
		f.response.observe = () => {
			throw new Error("diagnostic failure");
		};
		f.response.onIdle = () => {
			idle++;
		};
		f.freeze("AB");
		expect(f.requests).toHaveLength(1);
		f.scheduler.settle(f.response);
		f.requests[0].resolve("甲");
		await tick();
		expect(f.parts).toHaveLength(1);
		expect(idle).toBeGreaterThan(0);
		expect(f.response.blocks.size).toBe(0);
		expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
		const cancelled = fixture();
		cancelled.response.observe = () => {
			throw new Error("diagnostic failure");
		};
		cancelled.freeze("A");
		cancelled.scheduler.cancel(cancelled.response);
		await tick();
		expect(cancelled.requests[0].signal.aborted).toBe(true);
		expect(cancelled.parts).toHaveLength(0);
		expect(cancelled.scheduler.stats()).toEqual({
			active: 0,
			queued: 0,
			responses: 0,
			sessions: 0,
		});
	});

	test("shutdown cancels queued and in-flight tasks and closes future admission", async () => {
		const f = fixture();
		f.freeze("A");
		f.freeze("AB", "summary");
		await f.scheduler.stop({ timeoutMs: 100 });
		f.requests[0].resolve("late");
		await tick();
		f.freeze("new", "tool", "new");
		expect(f.requests).toHaveLength(1);
		expect(f.parts).toHaveLength(0);
		expect(f.scheduler.stats()).toEqual({ active: 0, queued: 0, responses: 0, sessions: 0 });
	});
});
