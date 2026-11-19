import { describe, expect, mock, spyOn, test } from "bun:test";
import {
	REASONING_TRANSLATION_VISIBILITY_LIMITS,
	type ReasoningTranslationPart,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";
import {
	REASONING_TRANSLATION_LIMITS,
	ReasoningTranslationScheduler,
	type TranslationTask,
} from "../reasoning-translation-scheduler";
import {
	ReasoningTranslationVisibility,
	type TranslationViewer,
	type VisibleTranslationDependencies,
	type VisibleTranslationSource,
} from "../reasoning-translation-visibility";

async function tick() {
	for (let index = 0; index < 100; index++) await Promise.resolve();
}
const target: ReasoningTranslationVisibilityTarget = {
	ownerNarratorId: "author",
	messageId: "message",
	blockId: "block",
	elementId: "reasoning",
};
function fixture(
	overrides: Partial<Record<keyof typeof REASONING_TRANSLATION_VISIBILITY_LIMITS, number>> = {},
	concurrency = 4,
	schedulerOverrides: Partial<Record<keyof typeof REASONING_TRANSLATION_LIMITS, number>> = {},
) {
	let enabled = true;
	let loadGate: Promise<void> | undefined;
	let source: VisibleTranslationSource = {
		target,
		text: "ABC",
		generation: "g",
		locale: "zh-CN",
		version: "v1",
		parts: [],
	};
	const requests: Array<{
		task: TranslationTask;
		signal: AbortSignal;
		resolve: (text: string) => void;
		reject: (error: Error) => void;
	}> = [];
	const applied: ReasoningTranslationPart[] = [];
	const published: string[] = [];
	let loads = 0;
	const scheduler = new ReasoningTranslationScheduler({
		...REASONING_TRANSLATION_LIMITS,
		coalesceMs: 0,
		concurrency,
		...schedulerOverrides,
	});
	const registry = new ReasoningTranslationVisibility(
		{
			enabled: () => enabled,
			completedRanges: () => source.allowedRanges ?? [{ start: 0, end: source.text.length }],
			load: async () => {
				loads++;
				const snapshot = { ...source, parts: [...(source.parts ?? [])] };
				if (loadGate) await loadGate;
				return snapshot;
			},
			translate: (_source, _viewer, task, signal) =>
				new Promise((resolve, reject) => requests.push({ task, signal, resolve, reject })),
			apply: async (_source, _viewer, part, signal) => {
				if (signal.aborted) return null;
				applied.push(part);
				source.parts = [...(source.parts ?? []), part];
				return { part };
			},
			publish: (viewer) => published.push(viewer.narratorId),
		},
		scheduler,
		{ ...REASONING_TRANSLATION_VISIBILITY_LIMITS, ...overrides },
	);
	const viewer = (narratorId = "view"): TranslationViewer => ({
		narratorId,
		userId: "user",
		isCurrent: () => true,
		authorize: async () => true,
	});
	return {
		registry,
		scheduler,
		requests,
		applied,
		published,
		viewer,
		get source() {
			return source;
		},
		get loads() {
			return loads;
		},
		disable() {
			enabled = false;
		},
		pauseSource() {
			let resolve = () => {};
			loadGate = new Promise<void>((done) => {
				resolve = done;
			});
			return resolve;
		},
		change(value: VisibleTranslationSource) {
			source = value;
		},
	};
}

function batchFixture(sources: VisibleTranslationSource[]) {
	const singles: TranslationTask[] = [];
	const batches: Array<{
		tasks: TranslationTask[];
		userId: string;
		locale: string;
		runKey?: string;
		signal: AbortSignal;
	}> = [];
	const controls: Required<Pick<VisibleTranslationDependencies, "translate" | "translateBatch">> = {
		translate: async () => "单项",
		translateBatch: async (_source, _viewer, tasks) =>
			JSON.stringify({ parts: tasks.map((task) => ({ id: task.id, translatedText: "译" })) }),
	};
	const registry = new ReasoningTranslationVisibility(
		{
			enabled: () => true,
			load: async (target) => {
				const source = sources.find(
					(source) =>
						source.target.elementId === target.elementId &&
						source.target.ownerNarratorId === target.ownerNarratorId,
				);
				return source ? { ...source, parts: [...(source.parts ?? [])] } : null;
			},
			completedRanges: (target) =>
				sources.find((source) => source.target.elementId === target.elementId)?.allowedRanges,
			translate: async (...args) => {
				singles.push(args[2]);
				return controls.translate(...args);
			},
			translateBatch: async (...args) => {
				batches.push({
					tasks: [...args[2]],
					userId: args[1].userId,
					locale: args[0].locale,
					runKey: args[0].runKey,
					signal: args[3],
				});
				return controls.translateBatch(...args);
			},
			apply: async (source, _viewer, part) => {
				const current = sources.find((entry) => entry.target.elementId === source.target.elementId);
				current?.parts?.push(part);
				return { part };
			},
			publish: () => {},
		},
		new ReasoningTranslationScheduler({ ...REASONING_TRANSLATION_LIMITS, coalesceMs: 0 }),
	);
	const viewer = (userId = "user"): TranslationViewer => ({
		narratorId: "author",
		userId,
		isCurrent: () => true,
		authorize: async () => true,
	});
	return { registry, singles, batches, controls, viewer };
}

function batchSource(overrides: Partial<VisibleTranslationSource> = {}): VisibleTranslationSource {
	return {
		target,
		text: "A\n\nB\n\nC",
		generation: "g",
		locale: "zh-CN",
		version: "v1",
		completed: false,
		allowedRanges: [],
		parts: [],
		runAnchor: target,
		runKey: "run",
		order: 0,
		...overrides,
	};
}

describe("visible reasoning translation demand", () => {
	test("released gaps of an active source share one batch while its pending tail is excluded", async () => {
		const source = batchSource({
			allowedRanges: [
				{ start: 0, end: 1 },
				{ start: 3, end: 4 },
			],
		});
		const f = batchFixture([source]);
		try {
			f.registry.replace({}, "body", f.viewer(), [target]);
			await tick();
			expect(f.singles).toHaveLength(0);
			expect(f.batches).toHaveLength(1);
			expect(f.batches[0].tasks.map((task) => task.sourceText)).toEqual(["A", "B"]);
			expect(source.parts?.map((part) => [part.start, part.end])).toEqual([
				[0, 1],
				[3, 4],
			]);
		} finally {
			await f.registry.stop();
		}
	});

	test("an observed active response with real allowedRanges upgrades batching on release and completion", async () => {
		const source = batchSource();
		const f = batchFixture([source]);
		try {
			f.registry.replace({}, "body", f.viewer(), [target]);
			await tick();
			expect(f.batches).toHaveLength(0);
			expect(f.singles).toHaveLength(0);
			source.allowedRanges = [
				{ start: 0, end: 1 },
				{ start: 3, end: 4 },
			];
			f.registry.notify("message");
			await tick();
			expect(f.singles).toHaveLength(0);
			expect(f.batches).toHaveLength(1);
			expect(f.batches[0].tasks.map((task) => task.sourceText)).toEqual(["A", "B"]);
			source.completed = true;
			source.allowedRanges = [{ start: 0, end: 7 }];
			f.registry.notify("message");
			await tick();
			expect(f.singles).toHaveLength(0);
			expect(f.batches).toHaveLength(2);
			expect(f.batches[1].tasks.map((task) => task.sourceText)).toEqual(["\n\nC"]);
		} finally {
			await f.registry.stop();
		}
	});

	test("batch eligibility upgrades after an in-flight single without replaying its prefix", async () => {
		const source = batchSource({ text: "A", allowedRanges: undefined });
		const f = batchFixture([source]);
		const first = Promise.withResolvers<string>();
		f.controls.translate = async () => first.promise;
		try {
			f.registry.replace({}, "body", f.viewer(), [target]);
			await tick();
			expect(f.singles.map((task) => task.sourceText)).toEqual(["A"]);
			source.text = "A\n\nB\n\nC\n\nD";
			source.allowedRanges = [
				{ start: 0, end: 1 },
				{ start: 3, end: 4 },
				{ start: 6, end: 7 },
			];
			f.registry.notify();
			await tick();
			expect(f.singles).toHaveLength(1);
			expect(f.batches).toHaveLength(0);
			first.resolve("甲");
			await tick();
			await tick();
			expect(f.singles).toHaveLength(1);
			expect(f.batches.map((batch) => batch.tasks.map((task) => task.sourceText))).toEqual([
				["B", "C"],
			]);
			expect(source.parts?.map((part) => part.sourceText)).toEqual(["A", "B", "C"]);
		} finally {
			first.resolve("甲");
			await f.registry.stop();
		}
	});

	test("a later verified run group replaces fallback membership before the next ready sources", async () => {
		const secondTarget = { ...target, blockId: "second-block", elementId: "second" };
		const first = batchSource({ allowedRanges: [{ start: 0, end: 1 }] });
		const second = batchSource({ target: secondTarget, text: "E tail", order: 1 });
		const f = batchFixture([first, second]);
		const connection = {};
		const viewer = f.viewer();
		try {
			f.registry.replace(connection, "body", viewer, [target, secondTarget]);
			await tick();
			expect(f.batches.map((batch) => batch.tasks.map((task) => task.sourceText))).toEqual([["A"]]);
			f.registry.replace(
				connection,
				"body",
				viewer,
				[target, secondTarget],
				[{ groupId: "run", anchor: target, targetIndexes: [0, 1] }],
			);
			await tick();
			first.allowedRanges = [
				{ start: 0, end: 1 },
				{ start: 3, end: 4 },
			];
			second.allowedRanges = [{ start: 0, end: 1 }];
			f.registry.notify();
			await tick();
			expect(f.singles).toHaveLength(0);
			expect(f.batches.map((batch) => batch.tasks.map((task) => task.sourceText))).toEqual([
				["A"],
				["B", "E"],
			]);
		} finally {
			await f.registry.stop();
		}
	});

	test("verified run grouping survives fold without granting a later off-screen range", async () => {
		const secondTarget = { ...target, blockId: "second-block", elementId: "second" };
		const first = batchSource({ text: "A" });
		const second = batchSource({ target: secondTarget, text: "B\n\nC\n\nD", order: 1 });
		const f = batchFixture([first, second]);
		const connection = {};
		const viewer = f.viewer();
		const result = Promise.withResolvers<string>();
		f.controls.translateBatch = async () => result.promise;
		const group = { groupId: "run", anchor: target, targetIndexes: [0, 1] };
		try {
			f.registry.replace(connection, "body", viewer, [target, secondTarget], [group]);
			await tick();
			first.completed = true;
			first.allowedRanges = [{ start: 0, end: 1 }];
			second.allowedRanges = [{ start: 0, end: 1 }];
			f.registry.complete(target);
			f.registry.complete(secondTarget);
			f.registry.replace(connection, "body", viewer, []);
			await tick();
			expect(f.singles).toHaveLength(0);
			expect(f.batches).toHaveLength(1);
			expect(f.batches[0].tasks.map((task) => task.sourceText)).toEqual(["A", "B"]);
			second.allowedRanges = [{ start: 0, end: 4 }];
			f.registry.complete(secondTarget);
			f.registry.notify();
			await tick();
			expect(f.batches).toHaveLength(1);
			result.resolve(
				JSON.stringify({
					parts: f.batches[0].tasks.map((task) => ({ id: task.id, translatedText: "译" })),
				}),
			);
			await tick();
			f.controls.translateBatch = async (_source, _viewer, tasks) =>
				JSON.stringify({ parts: tasks.map((task) => ({ id: task.id, translatedText: "译" })) });
			f.registry.replace(connection, "body", viewer, [target, secondTarget], [group]);
			await tick();
			expect(f.batches).toHaveLength(2);
			expect(f.batches[1].tasks.map((task) => task.sourceText)).toEqual(["\n\nC"]);
			expect(f.singles).toHaveLength(0);
		} finally {
			result.resolve("invalid");
			await f.registry.stop();
		}
	});

	test("simultaneous run batches isolate users, languages and persisted run identities", async () => {
		const makeTarget = (id: string) => ({ ...target, blockId: `block-${id}`, elementId: id });
		const a = makeTarget("A"),
			b = makeTarget("B"),
			c = makeTarget("C"),
			d = makeTarget("D"),
			e = makeTarget("E");
		const sources = [
			batchSource({ target: a, text: "A tail", runAnchor: a, order: 0 }),
			batchSource({ target: e, text: "E tail", runAnchor: a, order: 1 }),
			batchSource({ target: b, text: "B tail", runAnchor: a, order: 2 }),
			batchSource({ target: c, text: "C tail", runAnchor: a, order: 3, locale: "ja" }),
			batchSource({ target: d, text: "D tail", runAnchor: d, order: 4, runKey: "other-run" }),
		];
		for (const source of sources) source.allowedRanges = [{ start: 0, end: 1 }];
		const f = batchFixture(sources);
		try {
			f.registry.replace(
				{},
				"first",
				f.viewer("one"),
				[a, e, c, d],
				[
					{ groupId: "run", anchor: a, targetIndexes: [0, 1, 2] },
					{ groupId: "other", anchor: d, targetIndexes: [3] },
				],
			);
			f.registry.replace(
				{},
				"second",
				f.viewer("two"),
				[b],
				[{ groupId: "run", anchor: a, targetIndexes: [0] }],
			);
			await tick();
			expect(f.singles).toHaveLength(0);
			expect(
				f.batches
					.map(
						(batch) =>
							`${batch.userId}:${batch.locale}:${batch.runKey}:${batch.tasks.map((task) => task.sourceText).join("")}`,
					)
					.sort(),
			).toEqual(["one:ja:run:C", "one:zh-CN:other-run:D", "one:zh-CN:run:AE", "two:zh-CN:run:B"]);
		} finally {
			await f.registry.stop();
		}
	});

	test("a transcript subscription without current target visibility cannot start completion", async () => {
		const f = fixture();
		try {
			f.registry.watch({}, f.viewer("author"));
			f.registry.complete(target);
			f.registry.notify();
			await tick();
			expect(f.requests).toHaveLength(0);
			expect(f.loads).toBe(0);
		} finally {
			await f.registry.stop();
		}
	});

	test("visible completion captures its scope before a following body unmount", async () => {
		const f = fixture();
		const connection = {};
		const viewer = f.viewer("author");
		f.source.completed = false;
		f.source.allowedRanges = [];
		try {
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			expect(f.requests).toHaveLength(0);
			f.source.completed = true;
			f.source.allowedRanges = [{ start: 0, end: 3 }];
			f.registry.complete(target);
			// Completion wins this ordering even if its worker read has not returned.
			f.registry.replace(connection, "body", viewer, []);
			await tick();
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0].signal.aborted).toBe(false);
			f.requests[0].resolve("甲乙丙");
			await tick();
			expect(f.applied).toHaveLength(1);
			const loads = f.loads;
			f.registry.notify("message");
			await tick();
			expect(f.loads).toBe(loads);
		} finally {
			await f.registry.stop();
		}
	});

	test("leaving the viewport before completion revokes new work until the target returns", async () => {
		const f = fixture();
		const connection = {};
		const viewer = f.viewer("author");
		f.source.completed = false;
		f.source.allowedRanges = [];
		try {
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			f.registry.replace(connection, "body", viewer, []);
			f.source.completed = true;
			f.source.allowedRanges = [{ start: 0, end: 3 }];
			f.registry.complete(target);
			f.registry.notify();
			await tick();
			expect(f.requests).toHaveLength(0);
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			expect(f.requests).toHaveLength(1);
			f.registry.replace(connection, "body", viewer, []);
			expect(f.requests[0].signal.aborted).toBe(false);
			f.requests[0].resolve("甲乙丙");
			await tick();
			expect(f.applied).toHaveLength(1);
		} finally {
			await f.registry.stop();
		}
	});

	test("a failed completion request releases its one-shot holder without retrying", async () => {
		const f = fixture();
		try {
			const connection = {};
			const viewer = f.viewer("author");
			f.registry.replace(connection, "body", viewer, [target]);
			f.registry.complete(target);
			f.registry.replace(connection, "body", viewer, []);
			await tick();
			f.requests[0].reject(new Error("provider unavailable"));
			await tick();
			expect(f.applied).toHaveLength(0);
			const loads = f.loads;
			f.registry.notify();
			await tick();
			expect(f.loads).toBe(loads);
			expect(f.requests).toHaveLength(1);
		} finally {
			await f.registry.stop();
		}
	});

	test("completion timeout releases its holder and ignores a late result", async () => {
		const f = fixture();
		const fixedNow = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(fixedNow);
		const timers = spyOn(globalThis, "setTimeout");
		const clearedTimers = spyOn(globalThis, "clearTimeout");
		try {
			const connection = {};
			const viewer = f.viewer("author");
			f.registry.replace(connection, "body", viewer, [target]);
			f.registry.complete(target);
			f.registry.replace(connection, "body", viewer, []);
			await tick();
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0].task.queuedAt).toBe(fixedNow);
			// With a fixed clock, the live provider deadline is exactly its budget.
			// Queue wake-ups use that budget too, but pump() has already cleared them.
			const deadlines = timers.mock.calls.filter(([, delay], index) => {
				const scheduled = timers.mock.results[index];
				return (
					delay === REASONING_TRANSLATION_LIMITS.deadlineMs &&
					scheduled?.type === "return" &&
					!clearedTimers.mock.calls.some(([handle]) => handle === scheduled.value)
				);
			});
			expect(deadlines).toHaveLength(1);
			const expire = deadlines[0][0];
			if (typeof expire !== "function") throw new Error("Missing request deadline callback");
			expire();
			await tick();
			expect(f.requests[0].signal.aborted).toBe(true);
			const loads = f.loads;
			f.registry.notify();
			f.requests[0].resolve("迟到");
			await tick();
			expect(f.loads).toBe(loads);
			expect(f.applied).toHaveLength(0);
		} finally {
			clock.mockRestore();
			timers.mockRestore();
			clearedTimers.mockRestore();
			await f.registry.stop();
		}
	});

	test("summary A/B become eligible immediately while C stays untranslated", async () => {
		const f = fixture();
		const connection = {};
		const viewer = f.viewer("author");
		f.source.completed = false;
		f.source.allowedRanges = [];
		try {
			f.registry.watch(connection, viewer);
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			expect(f.requests).toHaveLength(0);
			f.source.allowedRanges = [{ start: 0, end: 1 }];
			f.registry.complete(target);
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
			f.source.allowedRanges = [{ start: 0, end: 2 }];
			f.registry.complete(target);
			f.registry.replace(connection, "body", viewer, []);
			// A later off-screen seal cannot expand the already-retained A/B scope.
			f.source.allowedRanges = [{ start: 0, end: 3 }];
			f.registry.complete(target);
			f.registry.notify();
			await tick();
			expect(f.requests[0].signal.aborted).toBe(false);
			f.requests[0].resolve("甲");
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "B"]);
			f.requests[1].resolve("乙");
			await tick();
			expect(f.applied.map((part) => [part.start, part.end])).toEqual([
				[0, 1],
				[1, 2],
			]);
			f.source.completed = true;
			f.registry.complete(target);
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "B"]);
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "B", "C"]);
			f.requests[2].resolve("丙");
			await tick();
		} finally {
			await f.registry.stop();
		}
	});

	test("returning to the viewport grants a newly sealed range while its older prefix is still running", async () => {
		const f = fixture();
		const connection = {};
		const viewer = f.viewer("author");
		f.source.completed = false;
		f.source.allowedRanges = [];
		try {
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			f.source.allowedRanges = [{ start: 0, end: 1 }];
			f.registry.complete(target);
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
			f.registry.replace(connection, "body", viewer, []);
			f.source.allowedRanges = [{ start: 0, end: 2 }];
			f.registry.complete(target);
			f.registry.notify();
			await tick();
			expect(f.requests).toHaveLength(1);
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			f.requests[0].resolve("甲");
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "B"]);
			f.registry.replace(connection, "body", viewer, []);
			expect(f.requests[1].signal.aborted).toBe(false);
			f.requests[1].resolve("乙");
			await tick();
			expect(f.applied.map((part) => part.sourceText)).toEqual(["A", "B"]);
		} finally {
			await f.registry.stop();
		}
	});

	for (const secondAllowed of [true, false]) {
		test(`two viewers authorize their own retained completion scopes (secondAllowed=${secondAllowed})`, async () => {
			const f = fixture();
			const firstConnection = {};
			const secondConnection = {};
			const firstViewer = f.viewer("author");
			let allowed = true;
			let secondChecks = 0;
			const secondViewer = {
				...f.viewer("author"),
				userId: "second-user",
				authorize: async () => {
					secondChecks++;
					return allowed;
				},
			};
			f.source.completed = false;
			f.source.allowedRanges = [];
			try {
				f.registry.replace(firstConnection, "body", firstViewer, [target]);
				await tick();
				f.source.allowedRanges = [{ start: 0, end: 1 }];
				f.registry.complete(target);
				await tick();
				expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
				f.registry.replace(firstConnection, "body", firstViewer, []);
				f.registry.replace(secondConnection, "body", secondViewer, [target]);
				await tick();
				const checksBeforeSeal = secondChecks;
				allowed = secondAllowed;
				f.source.allowedRanges = [{ start: 0, end: 2 }];
				f.registry.complete(target);
				f.registry.replace(secondConnection, "body", secondViewer, []);
				// Neither retained holder can promote the later off-screen C seal.
				f.source.allowedRanges = [{ start: 0, end: 3 }];
				f.registry.complete(target);
				f.registry.notify();
				await tick();
				expect(secondChecks).toBeGreaterThan(checksBeforeSeal);
				f.requests[0].resolve("甲");
				await tick();
				expect(f.requests.map(({ task }) => task.sourceText)).toEqual(
					secondAllowed ? ["A", "B"] : ["A"],
				);
				if (secondAllowed) {
					f.requests[1].resolve("乙");
					await tick();
				}
				expect(f.applied.map((part) => part.sourceText)).toEqual(
					secondAllowed ? ["A", "B"] : ["A"],
				);
			} finally {
				await f.registry.stop();
			}
		});
	}

	for (const firstResult of ["pending-prefix", "terminal-tail"] as const) {
		test(`terminal ranges exclude an in-flight prefix before either result writes (${firstResult})`, async () => {
			const f = fixture();
			const connection = {};
			const viewer = f.viewer("author");
			f.source.text = "A\n\nB\n\nC";
			f.source.completed = false;
			f.source.allowedRanges = [
				{ start: 0, end: 1 },
				{ start: 3, end: 4 },
			];
			f.source.parts = [
				{
					id: "accepted-A",
					generation: "g",
					start: 0,
					end: 1,
					sourceText: "A",
					translatedText: "甲",
				},
			];
			try {
				f.registry.replace(connection, "body", viewer, [target]);
				await tick();
				expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["B"]);
				f.source.completed = true;
				f.source.allowedRanges = [{ start: 0, end: 7 }];
				f.registry.complete(target);
				f.registry.notify();
				await tick();
				expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["B", "\n\nC"]);
				expect(f.requests.map(({ task }) => [task.start, task.end])).toEqual([
					[3, 4],
					[4, 7],
				]);
				f.registry.replace(connection, "body", viewer, []);
				const order = firstResult === "pending-prefix" ? [0, 1] : [1, 0];
				for (const index of order) {
					f.requests[index].resolve(index === 0 ? "乙" : "丙");
					await tick();
				}
				expect(f.applied).toHaveLength(2);
				expect(
					f.source.parts?.map((part) => [part.start, part.end]).sort((a, b) => a[0] - b[0]),
				).toEqual([
					[0, 1],
					[3, 4],
					[4, 7],
				]);
			} finally {
				await f.registry.stop();
			}
		});
	}

	test("terminal scope also subtracts a queued prefix reservation before releasing the scheduler", async () => {
		const f = fixture();
		const resume = f.scheduler.hold();
		f.source.text = "A\n\nB\n\nC";
		f.source.completed = false;
		f.source.allowedRanges = [{ start: 3, end: 4 }];
		f.source.parts = [
			{
				id: "accepted-A",
				generation: "g",
				start: 0,
				end: 1,
				sourceText: "A",
				translatedText: "甲",
			},
		];
		try {
			f.registry.replace({}, "body", f.viewer("author"), [target]);
			await tick();
			expect(f.requests).toHaveLength(0);
			expect(f.scheduler.stats().queued).toBe(1);
			f.source.completed = true;
			f.source.allowedRanges = [{ start: 0, end: 7 }];
			f.registry.complete(target);
			await tick();
			resume();
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["B", "\n\nC"]);
			for (const request of f.requests) request.resolve("译");
			await tick();
			expect(f.applied).toHaveLength(2);
		} finally {
			resume();
			await f.registry.stop();
		}
	});

	for (const invalidation of ["failed", "generation"] as const) {
		test(`an ${invalidation} prefix reservation cannot occupy the newly released terminal tail`, async () => {
			const f = fixture();
			f.source.text = "A\n\nB\n\nC";
			f.source.completed = false;
			f.source.allowedRanges = [{ start: 3, end: 4 }];
			f.source.parts = [
				{
					id: "accepted-A",
					generation: "g",
					start: 0,
					end: 1,
					sourceText: "A",
					translatedText: "甲",
				},
			];
			try {
				f.registry.replace({}, "body", f.viewer("author"), [target]);
				await tick();
				expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["B"]);
				if (invalidation === "failed") {
					f.requests[0].reject(new Error("prefix failed"));
					await tick();
				} else {
					f.change({ ...f.source, generation: "next", version: "next", parts: [] });
				}
				f.source.completed = true;
				f.source.allowedRanges = [{ start: 0, end: 7 }];
				f.registry.complete(target);
				f.registry.notify();
				await tick();
				expect(f.requests).toHaveLength(2);
				expect(f.requests[1].task.end).toBe(7);
				expect(f.requests[1].task.sourceText.endsWith("C")).toBe(true);
				if (invalidation === "generation") {
					expect(f.requests[0].signal.aborted).toBe(true);
					f.requests[0].resolve("迟到");
				}
				f.requests[1].resolve("乙丙");
				await tick();
				expect(f.applied).toHaveLength(1);
				expect(f.applied[0].end).toBe(7);
			} finally {
				await f.registry.stop();
			}
		});
	}

	test("closing subscriptions and disabling translation release completion work", async () => {
		for (const mode of ["subscription", "disable", "permission"] as const) {
			const f = fixture();
			const connection = {};
			let allowed = true;
			const viewer = { ...f.viewer("author"), authorize: async () => allowed };
			try {
				f.registry.replace(connection, "body", viewer, [target]);
				f.registry.complete(target);
				f.registry.replace(connection, "body", viewer, []);
				await tick();
				expect(f.requests).toHaveLength(1);
				if (mode === "subscription") f.registry.release(connection, undefined, "author");
				else {
					if (mode === "disable") f.disable();
					else allowed = false;
					f.registry.notify();
				}
				await tick();
				expect(f.requests[0].signal.aborted).toBe(true);
				f.requests[0].resolve("迟到");
				await tick();
				expect(f.applied).toHaveLength(0);
			} finally {
				await f.registry.stop();
			}
		}
	});

	test("reopening cancels an invalid tail but keeps a completed prefix in flight", async () => {
		const f = fixture();
		f.source.allowedRanges = [
			{ start: 0, end: 1 },
			{ start: 1, end: 3 },
		];
		try {
			f.registry.replace({}, "body", f.viewer(), [target]);
			await tick();
			expect(f.requests).toHaveLength(2);
			f.source.allowedRanges = [{ start: 0, end: 1 }];
			f.source.completed = false;
			f.registry.notify();
			await tick();
			expect(f.requests[0].signal.aborted).toBe(false);
			expect(f.requests[1].signal.aborted).toBe(true);
			f.requests[0].resolve("甲");
			f.requests[1].resolve("越界");
			await tick();
			expect(f.applied.map((part) => part.sourceText)).toEqual(["A"]);
		} finally {
			await f.registry.stop();
		}
	});

	test("durable writes without observers never read source or invoke a model", async () => {
		const f = fixture();
		f.registry.notify("message");
		f.registry.notify();
		await tick();
		expect(f.loads).toBe(0);
		expect(f.requests).toHaveLength(0);
		await f.registry.stop();
	});

	test("opening history translates only uncovered UTF-16 intervals without repeated work", async () => {
		const f = fixture();
		f.source.text = " \n!A B C";
		f.source.parts = [
			{ id: "prefix", generation: "g", start: 2, end: 3, sourceText: "!", translatedText: "！" },
			{ id: "existing", generation: "g", start: 5, end: 6, sourceText: "B", translatedText: "乙" },
		];
		const connection = {};
		f.registry.replace(connection, "panel", f.viewer(), [target]);
		await tick();
		expect(f.requests.map(({ task }) => [task.start, task.end, task.sourceText])).toEqual([
			[3, 5, "A "],
			[6, 8, " C"],
		]);
		f.registry.replace(connection, "panel", f.viewer(), [target]);
		f.registry.notify("message");
		await tick();
		expect(f.requests).toHaveLength(2);
		for (const request of f.requests) request.resolve("译");
		await tick();
		expect(f.applied).toHaveLength(2);
		f.registry.replace(connection, "panel", f.viewer(), [target]);
		await tick();
		expect(f.requests).toHaveLength(2);
		await f.registry.stop();
	});

	test("retaining scheduled completion work never creates a read or replaces a later revision refresh", async () => {
		const f = fixture();
		const connection = {};
		const viewer = f.viewer();
		f.source.allowedRanges = [{ start: 0, end: 3 }];
		try {
			f.registry.replace(connection, "body", viewer, [target]);
			await tick();
			expect(f.loads).toBe(1);
			expect(f.requests).toHaveLength(1);
			f.registry.replace(connection, "body", viewer, []);
			f.change({ ...f.source, version: "v2" });
			f.registry.notify("message");
			await tick();
			expect(f.loads).toBe(2);
			expect(f.requests[0].signal.aborted).toBe(false);
			f.requests[0].resolve("甲乙丙");
			await tick();
			expect(f.applied).toHaveLength(1);
			expect(f.loads).toBe(2);
		} finally {
			await f.registry.stop();
		}
	});

	test("revision-only durable writes preserve the in-flight translation", async () => {
		const f = fixture();
		try {
			f.registry.replace({}, "panel", f.viewer(), [target]);
			await tick();
			expect(f.requests).toHaveLength(1);
			f.change({ ...f.source, version: "v2" });
			f.registry.notify("message");
			await tick();
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0].signal.aborted).toBe(false);
			f.requests[0].resolve("甲乙丙");
			await tick();
			expect(f.applied.map((part) => part.sourceText)).toEqual(["ABC"]);
		} finally {
			for (const request of f.requests) request.resolve("译");
			await f.registry.stop();
		}
	});

	test("revision-only writes preserve both queued gaps and their active prefix", async () => {
		const f = fixture({}, 1);
		f.source.parts = [
			{ id: "middle", generation: "g", start: 1, end: 2, sourceText: "B", translatedText: "乙" },
		];
		try {
			f.registry.replace({}, "panel", f.viewer(), [target]);
			await tick();
			f.change({ ...f.source, version: "v2" });
			f.registry.notify("message");
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A"]);
			expect(f.requests[0].signal.aborted).toBe(false);
			f.requests[0].resolve("甲");
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "C"]);
			f.requests[1].resolve("丙");
			await tick();
			expect(f.applied.map((part) => part.sourceText)).toEqual(["A", "C"]);
		} finally {
			for (const request of f.requests) request.resolve("译");
			await f.registry.stop();
		}
	});

	test("revision-only writes do not reopen a failed frozen source", async () => {
		const f = fixture();
		try {
			f.registry.replace({}, "panel", f.viewer(), [target]);
			await tick();
			f.requests[0].resolve("");
			await tick();
			expect(f.applied).toHaveLength(0);
			for (const version of ["v2", "v3"]) {
				f.change({ ...f.source, version });
				f.registry.notify("message");
				await tick();
				expect(f.requests).toHaveLength(1);
			}
		} finally {
			for (const request of f.requests) request.resolve("译");
			await f.registry.stop();
		}
	});

	for (const phase of ["source read", "authorization"]) {
		for (const text of ["ABC", "ABCD"]) {
			test(`completion during ${phase} keeps ${text === "ABC" ? "same-source work" : "only the appended tail"}`, async () => {
				const f = fixture();
				const viewer = f.viewer();
				let resume = () => {};
				let paused = false;
				try {
					f.registry.replace({}, "panel", viewer, [target]);
					await tick();
					expect(f.requests).toHaveLength(1);
					f.change({ ...f.source, text, version: "v2" });
					if (phase === "source read") {
						resume = f.pauseSource();
					} else {
						const gate = new Promise<void>((resolve) => {
							resume = resolve;
						});
						viewer.authorize = async () => {
							if (f.loads === 2 && !paused) {
								paused = true;
								await gate;
							}
							return true;
						};
					}
					f.registry.notify("message");
					await tick();
					expect(f.loads).toBe(2);
					if (phase === "authorization") expect(paused).toBe(true);
					f.requests[0].resolve("甲乙丙");
					await tick();
					expect(f.applied.map((part) => part.sourceText)).toEqual(["ABC"]);
					resume();
					await tick();
					expect(f.requests.map(({ task }) => task.sourceText)).toEqual(
						text === "ABC" ? ["ABC"] : ["ABC", "D"],
					);
					if (text === "ABCD") {
						expect(f.loads).toBe(3);
						f.requests[1].resolve("丁");
						await tick();
						expect(f.applied.map((part) => part.sourceText)).toEqual(["ABC", "D"]);
					}
				} finally {
					resume();
					for (const request of f.requests) request.resolve("译");
					await f.registry.stop();
				}
			});
		}
	}

	for (const replacement of [{ text: "NEW" }, { generation: "g2" }, { locale: "ja" }]) {
		test(`changing ${Object.keys(replacement)[0]} cancels reused work even with the same version`, async () => {
			const f = fixture();
			try {
				f.registry.replace({}, "panel", f.viewer(), [target]);
				await tick();
				f.change({ ...f.source, version: "v2" });
				f.registry.notify("message");
				await tick();
				expect(f.requests[0].signal.aborted).toBe(false);
				f.change({ ...f.source, ...replacement });
				f.registry.notify("message");
				await tick();
				expect(f.requests).toHaveLength(2);
				expect(f.requests[0].signal.aborted).toBe(true);
				f.requests[0].resolve("旧译");
				f.requests[1].resolve("新译");
				await tick();
				expect(f.applied).toHaveLength(1);
				expect(f.applied[0]).toMatchObject({
					generation: f.source.generation,
					sourceText: f.source.text,
					translatedText: "新译",
				});
			} finally {
				for (const request of f.requests) request.resolve("译");
				await f.registry.stop();
			}
		});
	}

	test("independent clients and a shared fork holder cannot cancel each other's target", async () => {
		const f = fixture();
		const first = {},
			fork = {};
		f.registry.replace(first, "panel", f.viewer("original-view"), [target]);
		f.registry.replace(fork, "panel", f.viewer("fork-view-with-ref"), [target]);
		await tick();
		expect(f.requests).toHaveLength(1);
		f.registry.release(first);
		expect(f.requests[0].signal.aborted).toBe(false);
		f.requests[0].resolve("译");
		await tick();
		expect(f.applied).toHaveLength(1);
		expect(f.published).toEqual(["fork-view-with-ref"]);
		await f.registry.stop();
	});

	test("last observer cancels and reopening creates a new response from committed parts", async () => {
		const f = fixture();
		const connection = {};
		f.registry.replace(connection, "panel", f.viewer(), [target]);
		await tick();
		f.registry.replace(connection, "panel", f.viewer(), []);
		expect(f.requests[0].signal.aborted).toBe(true);
		f.requests[0].resolve("late");
		await tick();
		expect(f.applied).toHaveLength(0);
		f.source.parts = [
			{ id: "committed", generation: "g", start: 0, end: 1, sourceText: "A", translatedText: "甲" },
		];
		f.registry.replace(connection, "panel", f.viewer(), [target]);
		await tick();
		expect(f.requests[1].task).toMatchObject({ start: 1, end: 3, sourceText: "BC" });
		f.requests[1].resolve("乙丙");
		await tick();
		expect(f.applied).toHaveLength(1);
		await f.registry.stop();
	});

	test("hidden demand cannot survive asynchronous authorization or source reading", async () => {
		const f = fixture();
		const connection = {};
		let allow: ((allowed: boolean) => void) | undefined;
		const viewer = f.viewer();
		viewer.authorize = () =>
			new Promise((resolve) => {
				allow = resolve;
			});
		f.registry.replace(connection, "panel", viewer, [target]);
		f.registry.release(connection);
		allow?.(true);
		await tick();
		expect(f.loads).toBe(0);
		expect(f.requests).toHaveLength(0);
		await f.registry.stop();
	});

	test("hiding during an asynchronous source read cannot start a late model task", async () => {
		const f = fixture();
		const resume = f.pauseSource();
		const connection = {};
		f.registry.replace(connection, "panel", f.viewer(), [target]);
		await tick();
		expect(f.loads).toBe(1);
		f.registry.release(connection);
		resume();
		await tick();
		expect(f.requests).toHaveLength(0);
		await f.registry.stop();
	});

	test("last observer removes queued work before it can claim a model slot", async () => {
		const f = fixture({}, 1);
		const running = {},
			queued = {};
		f.registry.replace(running, "first", f.viewer(), [target]);
		f.registry.replace(queued, "second", f.viewer(), [{ ...target, blockId: "second" }]);
		await tick();
		expect(f.requests).toHaveLength(1);
		f.registry.release(queued);
		f.requests[0].resolve("译");
		await tick();
		expect(f.requests).toHaveLength(1);
		await f.registry.stop();
	});

	test("connection holders, global holders and unique targets have independent finite limits", async () => {
		const f = fixture({ holdersPerConnection: 1, holders: 2, uniqueTargets: 1 });
		const first = {},
			second = {};
		expect(f.registry.replace(first, "one", f.viewer(), [target])).toBe(true);
		expect(f.registry.replace(first, "two", f.viewer(), [target])).toBe(false);
		expect(f.registry.replace(second, "one", f.viewer(), [{ ...target, blockId: "other" }])).toBe(
			false,
		);
		expect(f.registry.replace(second, "one", f.viewer(), [target])).toBe(true);
		expect(f.registry.replace({}, "third", f.viewer(), [target])).toBe(false);
		f.registry.release(first);
		expect(f.registry.replace({}, "replacement", f.viewer(), [target])).toBe(true);
		await f.registry.stop();
	});

	test("revoked/forged holder never starts work or receives another holder's result", async () => {
		const f = fixture();
		const forged = f.viewer("forged-without-ref");
		forged.authorize = async () => false;
		f.registry.replace({}, "panel", forged, [target]);
		await tick();
		expect(f.requests).toHaveLength(0);
		const valid = f.viewer("valid");
		f.registry.replace({}, "panel", valid, [target]);
		await tick();
		valid.authorize = async () => false;
		f.registry.notify();
		await tick();
		expect(f.requests[0].signal.aborted).toBe(true);
		f.requests[0].resolve("late");
		await tick();
		expect(f.applied).toHaveLength(0);
		expect(f.published).toEqual([]);
		await f.registry.stop();
	});

	test("frequent appends preserve in-flight prefix work and coalesce one missing tail", async () => {
		const f = fixture();
		f.registry.replace({}, "panel", f.viewer(), [target]);
		await tick();
		for (const text of ["ABCD", "ABCDE", "ABCDEF"]) {
			f.change({ ...f.source, text, version: text });
			f.registry.notify("message");
			await tick();
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0].signal.aborted).toBe(false);
		}
		f.requests[0].resolve("甲乙丙");
		await tick();
		expect(f.applied.map((part) => part.sourceText)).toEqual(["ABC"]);
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1].task).toMatchObject({ start: 3, end: 6, sourceText: "DEF" });
		f.requests[1].resolve("丁戊己");
		await tick();
		expect(f.applied.map((part) => part.sourceText)).toEqual(["ABC", "DEF"]);
		await f.registry.stop();
	});

	for (const budget of [{ tasks: 2 }, { sourceBytes: 2 }, { outputBytes: 6 }]) {
		test(`independent gaps and append follow-ups share their ${Object.keys(budget)[0]} budget`, async () => {
			const f = fixture({}, 4, budget);
			f.source.parts = [
				{ id: "middle", generation: "g", start: 1, end: 2, sourceText: "B", translatedText: "乙" },
			];
			f.registry.replace({}, "panel", f.viewer(), [target]);
			await tick();
			expect(f.requests.map(({ task }) => task.sourceText)).toEqual(["A", "C"]);
			f.change({ ...f.source, text: "ABCD", version: "append" });
			f.registry.notify("message");
			await tick();
			for (const request of f.requests) request.resolve("译");
			await tick();
			expect(f.requests).toHaveLength(2);
			expect(f.applied).toHaveLength(2);
			await f.registry.stop();
		});
	}

	test("a rewrite immediately aborts a deferred append and rejects its late prefix result", async () => {
		const f = fixture();
		f.registry.replace({}, "panel", f.viewer(), [target]);
		await tick();
		f.change({ ...f.source, text: "ABCD", version: "append" });
		f.registry.notify("message");
		await tick();
		f.change({
			...f.source,
			text: "NEW",
			generation: "new-generation",
			version: "rewrite",
			parts: [],
		});
		f.registry.notify("message");
		await tick();
		expect(f.requests[0].signal.aborted).toBe(true);
		expect(f.requests[1].task.sourceText).toBe("NEW");
		f.requests[0].resolve("late");
		f.requests[1].resolve("current");
		await tick();
		expect(f.applied.map((part) => part.generation)).toEqual(["new-generation"]);
		expect(f.requests).toHaveLength(2);
		await f.registry.stop();
	});

	test("source replacement cancels the old generation and reads the new durable source", async () => {
		const f = fixture();
		f.registry.replace({}, "panel", f.viewer(), [target]);
		await tick();
		f.change({ ...f.source, text: "NEW", generation: "g2", version: "v2", parts: [] });
		f.registry.notify("message");
		await tick();
		expect(f.requests[0].signal.aborted).toBe(true);
		expect(f.requests[1].task).toMatchObject({ generation: "g2", sourceText: "NEW" });
		f.requests[0].resolve("old");
		f.requests[1].resolve("new");
		await tick();
		expect(f.applied.map((part) => part.generation)).toEqual(["g2"]);
		await f.registry.stop();
	});

	test("completion without a text change keeps the active 16KiB prefix and batches its remaining gaps", async () => {
		const source: VisibleTranslationSource = {
			target,
			text: "A".repeat(40 * 1024),
			generation: "g",
			locale: "zh-CN",
			version: "v",
			completed: false,
			parts: [],
		};
		const first = Promise.withResolvers<string>();
		const streaming: TranslationTask[] = [];
		const batches: TranslationTask[][] = [];
		const registry = new ReasoningTranslationVisibility(
			{
				enabled: () => true,
				load: async () => ({ ...source, parts: [...(source.parts ?? [])] }),
				translate: async (_source, _viewer, task) => {
					streaming.push(task);
					return first.promise;
				},
				translateBatch: async (_source, _viewer, tasks) => {
					batches.push([...tasks]);
					return JSON.stringify({
						parts: tasks.map((task) => ({ id: task.id, translatedText: "余下" })),
					});
				},
				apply: async (_source, _viewer, part) => {
					source.parts?.push(part);
					return { part };
				},
				publish: () => {},
			},
			new ReasoningTranslationScheduler({ ...REASONING_TRANSLATION_LIMITS, coalesceMs: 0 }),
		);
		try {
			registry.replace(
				{},
				"panel",
				{ narratorId: "view", userId: "user", isCurrent: () => true, authorize: async () => true },
				[target],
			);
			await tick();
			expect(streaming.map((task) => Buffer.byteLength(task.sourceText))).toEqual([16384]);
			source.completed = true;
			registry.notify("message");
			await tick();
			first.resolve("前缀");
			await tick();
			await tick();
			expect(streaming).toHaveLength(1);
			expect(batches).toHaveLength(1);
			expect(batches[0].map((task) => [task.start, Buffer.byteLength(task.sourceText)])).toEqual([
				[16384, 24 * 1024],
			]);
			expect(source.parts).toHaveLength(2);
		} finally {
			await registry.stop();
		}
	});

	test("first-visible completed elements share one initialized snapshot, batch and holder lifecycle", async () => {
		const worker = (await import("./narrator-worker-fixture")).getNarratorWorkerTestDb();
		await worker.ready;
		mock.module("../../db", () => ({
			db: worker.db,
			sqlite: worker.sqlite,
			activeDatabaseBackend: "sqlite",
			postgresRuntime: null,
		}));
		const prompt = { ...(await import("../../lib/prompt-i18n")) };
		mock.module("../../lib/prompt-i18n", () => ({
			...prompt,
			getUserLanguage: async () => "zh-CN",
		}));
		const sync = await import("../narrator-block-sync");
		const store = await import("../reasoning-translation-store");
		const { sqlite } = worker;
		const now = "2026-11-04T00:00:00.000Z";
		sqlite.run(
			"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('batch-owner', 'batch', ?, ?)",
			[now, now],
		);
		sqlite.run(
			"INSERT INTO narrator_messages (id, narrator_id, role, content_json, body_format, created_at) VALUES ('batch-message', 'batch-owner', 'assistant', ?, 2, ?)",
			[
				JSON.stringify([
					{ type: "reasoning", id: "first", text: "A".repeat(20 * 1024), completed: true },
					{ type: "thinking", id: "second", thinking: "B".repeat(10 * 1024) },
				]),
				now,
			],
		);
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('batch-ref', 'batch-owner', 'batch-message', 1)",
		);
		sync.syncEnvelopeNow("batch-message");
		const blocks = sqlite
			.query<{ id: string }, []>(
				"SELECT id FROM narrator_blocks WHERE message_id = 'batch-message' AND kind = 'reasoning' ORDER BY ordinal LIMIT 2",
			)
			.all();
		const targets = ["first", "second"].map((elementId, index) => ({
			ownerNarratorId: "batch-owner",
			messageId: "batch-message",
			blockId: blocks[index].id,
			elementId,
		}));
		const started = Promise.withResolvers<void>();
		const idle = Promise.withResolvers<void>();
		const result = Promise.withResolvers<string>();
		const authorizationWaiting = Promise.withResolvers<void>();
		const authorizeSecond = Promise.withResolvers<void>();
		let authorizationPaused = false;
		let snapshotLoads = 0;
		const requests: TranslationTask[][] = [];
		const states: string[] = [];
		let applied = 0;
		const scheduler = new ReasoningTranslationScheduler({
			...REASONING_TRANSLATION_LIMITS,
			coalesceMs: 0,
		});
		const registry = new ReasoningTranslationVisibility(
			{
				enabled: () => true,
				load: store.loadVisibleTranslationSource,
				loadMany: async (...args) => {
					snapshotLoads++;
					return store.loadVisibleTranslationSources(...args);
				},
				translate: async () => {
					throw new Error("completed sources require a batch");
				},
				translateBatch: async (_source, _viewer, tasks) => {
					requests.push([...tasks]);
					started.resolve();
					return result.promise;
				},
				apply: async (...args) => {
					const value = await store.applyVisibleTranslationPart(...args);
					if (value) applied++;
					return value;
				},
				publish: () => {},
			},
			scheduler,
		);
		try {
			registry.replace(
				{},
				"panel",
				{
					narratorId: "batch-owner",
					userId: "viewer",
					isCurrent: () => true,
					authorize: async (target) => {
						if (target.elementId === "second" && !authorizationPaused) {
							authorizationPaused = true;
							authorizationWaiting.resolve();
							await authorizeSecond.promise;
						}
						return true;
					},
					status: (frame) => {
						expect(frame.revision).toBe(7);
						const state = frame.groups[0]?.state;
						if (state) states.push(state);
						if (state === "idle" && states.includes("running")) idle.resolve();
					},
				},
				targets,
				[{ groupId: "run", anchor: targets[0], targetIndexes: [0, 1] }],
				7,
			);
			await authorizationWaiting.promise;
			await tick();
			expect(snapshotLoads).toBe(0);
			expect(requests).toHaveLength(0);
			authorizeSecond.resolve();
			await started.promise;
			expect(snapshotLoads).toBe(1);
			expect(requests).toHaveLength(1);
			expect(requests[0].map((task) => task.sourceText[0])).toEqual(["A", "B"]);
			result.resolve(
				JSON.stringify({
					parts: [...requests[0]].reverse().map((task) => ({
						id: task.id,
						translatedText: task.sourceText[0] === "A" ? "甲" : "乙",
					})),
				}),
			);
			await idle.promise;
			expect(applied).toBe(2);
			expect(states).toContain("queued");
			expect(states.at(-1)).toBe("idle");
			const reopened = await store.loadVisibleTranslationSources(
				targets,
				{
					narratorId: "batch-owner",
					userId: "viewer",
					isCurrent: () => true,
					authorize: async () => true,
				},
				new AbortController().signal,
			);
			expect(reopened.map((source) => source?.parts?.[0]?.translatedText)).toEqual(["甲", "乙"]);
		} finally {
			authorizeSecond.resolve();
			await registry.stop();
			sync.stopBlockSyncSweep();
			mock.module("../../lib/prompt-i18n", () => prompt);
			await worker.close();
		}
	});

	test("disabled translation, English sources, limits and shutdown preserve original content", async () => {
		const f = fixture();
		f.disable();
		f.registry.replace({}, "disabled", f.viewer(), [target]);
		await tick();
		expect(f.requests).toHaveLength(0);
		expect(
			f.registry.replace(
				{},
				"large",
				f.viewer(),
				Array.from({ length: 65 }, () => target),
			),
		).toBe(false);
		await f.registry.stop();
		expect(f.registry.replace({}, "closed", f.viewer(), [target])).toBe(false);
		const english = fixture();
		english.source.locale = "en";
		english.registry.replace({}, "english", english.viewer(), [target]);
		await tick();
		expect(english.requests).toHaveLength(0);
		await english.registry.stop();
	});
});
