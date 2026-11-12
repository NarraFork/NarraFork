import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import * as convert from "../editor/convert";
import {
	bodySize,
	clearMeasureCache,
	hasMeasured,
	mapType,
	measureKey,
	measureStats,
	NODE,
} from "./measure";
import type { MeasureReply, MeasureRequest } from "./measure.worker";
import { prewarmBodies, prewarmStats, setMeasureWorkerFactoryForTests } from "./prewarm";

/** A Worker stand-in: answers each request with `answer`, asynchronously. */
function fakeWorker(answer: (req: MeasureRequest) => Omit<MeasureReply, "id" | "ms">) {
	const posted: MeasureRequest[] = [];
	const w = {
		onmessage: null as ((e: MessageEvent<MeasureReply>) => void) | null,
		onerror: null as (() => void) | null,
		postMessage(req: MeasureRequest) {
			posted.push(req);
			queueMicrotask(() =>
				w.onmessage?.({
					data: { id: req.id, ms: 0, ...answer(req) },
				} as MessageEvent<MeasureReply>),
			);
		},
		terminate() {},
	};
	return { w: w as unknown as Worker, posted };
}

const plain = (ref: string, label: string | null) => label ?? ref;

let mainBefore = 0;
let parser: ReturnType<typeof spyOn<typeof convert, "parseToPM">>;
beforeEach(() => {
	mainBefore = measureStats.misses;
	parser = spyOn(convert, "parseToPM").mockImplementation(() => {
		throw new Error("UI must not parse for measuring");
	});
});

afterEach(() => {
	expect(measureStats.misses).toBe(mainBefore);
	expect(parser).not.toHaveBeenCalled();
	parser.mockRestore();
	setMeasureWorkerFactoryForTests(null);
	clearMeasureCache();
	resetTypographyForTest();
});

describe("measuring ahead in a Worker", () => {
	test("a body the Worker cannot measure is no longer in flight: it can be sent again", async () => {
		const { w, posted } = fakeWorker(() => ({ out: [] }));
		setMeasureWorkerFactoryForTests(() => w);
		const failedBefore = prewarmStats.failed;
		expect(await prewarmBodies([{ content: "cannot measure", labelOf: plain }])).toEqual({
			status: "partial",
			measured: 0,
			failed: 1,
		});
		expect(prewarmStats.failed - failedBefore).toBe(1);
		expect(bodySize("cannot measure")).toEqual({ w: NODE.maxBody, h: mapType().lineH });
		await prewarmBodies([{ content: "cannot measure", labelOf: plain }]);
		expect(posted.flatMap((r) => r.items.map((i) => i.content))).toEqual([
			"cannot measure",
			"cannot measure",
		]);
	});

	test("a measured body is not sent again; one in flight is not sent twice", async () => {
		const { w, posted } = fakeWorker((req) => ({
			out: req.items.map((i) => [i.key, 100, 22] as [string, number, number]),
		}));
		setMeasureWorkerFactoryForTests(() => w);
		const first = prewarmBodies([
			{ content: "a", labelOf: plain },
			{ content: "b", labelOf: plain },
		]);
		// In flight: not sent again.
		const second = prewarmBodies([{ content: "a", labelOf: plain }]);
		await Promise.all([first, second]);
		// Measured: not sent again either.
		await prewarmBodies([
			{ content: "a", labelOf: plain },
			{ content: "c", labelOf: plain },
		]);
		expect(posted.flatMap((r) => r.items.map((i) => i.content))).toEqual(["a", "b", "c"]);
	});

	test("a call whose bodies another call sent is done only when those are measured", async () => {
		let answer: (() => void) | null = null;
		const w = {
			onmessage: null as ((e: MessageEvent<MeasureReply>) => void) | null,
			onerror: null as (() => void) | null,
			postMessage(req: MeasureRequest) {
				answer = () =>
					w.onmessage?.({
						data: {
							id: req.id,
							ms: 0,
							out: req.items.map((i) => [i.key, 90, 22] as [string, number, number]),
						},
					} as unknown as MessageEvent<MeasureReply>);
			},
			terminate() {},
		};
		setMeasureWorkerFactoryForTests(() => w as unknown as Worker);
		let firstDone = false;
		let secondDone = false;
		void prewarmBodies([{ content: "slow", labelOf: plain }]).then(() => {
			firstDone = true;
		});
		void prewarmBodies([{ content: "slow", labelOf: plain }]).then(() => {
			secondDone = true;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect({ firstDone, secondDone }).toEqual({ firstDone: false, secondDone: false });
		(answer as (() => void) | null)?.();
		await new Promise((r) => setTimeout(r, 0));
		expect({ firstDone, secondDone }).toEqual({ firstDone: true, secondDone: true });
	});

	test("each batch carries the reader's typography; a new setting measures everything again", async () => {
		const { w, posted } = fakeWorker((req) => ({
			out: req.items.map((i) => [i.key, 100, 24] as [string, number, number]),
		}));
		setMeasureWorkerFactoryForTests(() => w);
		await prewarmBodies([{ content: "正文 body", labelOf: plain }]);
		expect(posted[0]?.typography).toMatchObject({
			fontScalePercent: 100,
			lineHeightScalePercent: 100,
			letterSpacingPercent: 0,
		});
		expect(hasMeasured("正文 body")).toBe(true);

		// The Worker has its own typography module: it is told the setting with every batch,
		// and the sizes measured under the old setting are not served under the new one.
		setTypography({ fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 });
		expect(hasMeasured("正文 body")).toBe(false);
		await prewarmBodies([{ content: "正文 body", labelOf: plain }]);
		expect(posted).toHaveLength(2);
		expect(posted[1]?.typography).toMatchObject({
			fontScalePercent: 115,
			lineHeightScalePercent: 110,
			letterSpacingPercent: 2,
		});
		expect(posted[1]?.items[0]?.key).not.toBe(posted[0]?.items[0]?.key);
	});

	for (const failure of ["disabled", "construct", "send", "error", "timeout"] as const) {
		test(`${failure} never authorizes UI parsing or exact measuring, including later requests`, async () => {
			let terminated = 0;
			const w = {
				onmessage: null as ((e: MessageEvent<MeasureReply>) => void) | null,
				onerror: null as (() => void) | null,
				postMessage() {
					if (failure === "send") throw new Error("cannot send");
				},
				terminate() {
					terminated++;
				},
			};
			setMeasureWorkerFactoryForTests(
				failure === "disabled"
					? null
					: () => {
							if (failure === "construct") throw new Error("cannot construct");
							return w as unknown as Worker;
						},
			);
			const content = "[[target|标题]] **bold** text";
			const request = prewarmBodies([{ content, labelOf: plain }], { timeoutMs: 5 });
			if (failure === "error") w.onerror?.();
			const result = await request;
			expect(result.status).toBe(
				failure === "timeout"
					? "timeout"
					: failure === "send" || failure === "error"
						? "failed"
						: "unavailable",
			);
			expect(hasMeasured(content)).toBe(false);
			expect(bodySize(content)).toEqual({ w: NODE.maxBody, h: mapType().lineH });
			const later = prewarmBodies([{ content: "later", labelOf: plain }], { timeoutMs: 5 });
			expect((await later).status).toBe(failure === "timeout" ? "timeout" : "unavailable");
			expect(hasMeasured("later")).toBe(false);
			if (["send", "error", "timeout"].includes(failure)) expect(terminated).toBeGreaterThan(0);
		});
	}

	test("no Worker API leaves a plain placeholder rather than measuring locally", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		Object.defineProperty(globalThis, "Worker", { value: undefined, configurable: true });
		try {
			setMeasureWorkerFactoryForTests(() => {
				throw new Error("must not construct");
			});
			expect((await prewarmBodies([{ content: "cold", labelOf: plain }])).status).toBe(
				"unavailable",
			);
			expect(bodySize("cold")).toEqual({ w: NODE.maxBody, h: mapType().lineH });
		} finally {
			if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor);
			else Reflect.deleteProperty(globalThis, "Worker");
		}
	});

	test("a partial reply caches only its exact successes, and a healthy retry fills the rest", async () => {
		const { w } = fakeWorker((req) => ({
			out: [[req.items[0].key, 80, 48]],
		}));
		setMeasureWorkerFactoryForTests(() => w);
		expect(
			await prewarmBodies([
				{ content: "good", labelOf: plain },
				{ content: "bad", labelOf: plain },
			]),
		).toEqual({ status: "partial", measured: 1, failed: 1 });
		expect(bodySize("good")).toEqual({ w: 80, h: 48 });
		expect(hasMeasured("bad")).toBe(false);
		expect(bodySize("bad")).toEqual({ w: NODE.maxBody, h: mapType().lineH });
		expect((await prewarmBodies([{ content: "bad", labelOf: plain }])).status).toBe("ready");
		expect(bodySize("bad")).toEqual({ w: 80, h: 48 });
	});

	test("replacing a hung Worker cancels old jobs and ignores even a queued late callback", async () => {
		const posted: MeasureRequest[] = [];
		const old = {
			onmessage: null as ((e: MessageEvent<MeasureReply>) => void) | null,
			onerror: null,
			postMessage(request: MeasureRequest) {
				posted.push(request);
			},
			terminate() {},
		};
		setMeasureWorkerFactoryForTests(() => old as unknown as Worker);
		const pending = prewarmBodies([{ content: "same", labelOf: plain }]);
		const late = old.onmessage;
		const { w } = fakeWorker((req) => ({ out: [[req.items[0].key, 111, 33]] }));
		setMeasureWorkerFactoryForTests(() => w);
		expect((await pending).status).toBe("cancelled");
		const recovered = prewarmBodies([{ content: "same", labelOf: plain }]);
		late?.({
			data: { id: posted[0].id, out: [[posted[0].items[0].key, 999, 999]], ms: 0 },
		} as unknown as MessageEvent<MeasureReply>);
		expect(hasMeasured("same")).toBe(false);
		await recovered;
		expect(bodySize("same")).toEqual({ w: 111, h: 33 });
	});

	test("a stale A -> B -> A reply cannot replace a newer generation", async () => {
		const { w } = fakeWorker((req) => ({
			out: req.items.map((it) => [it.key, 900, 900]),
		}));
		setMeasureWorkerFactoryForTests(() => w);
		const old = prewarmBodies([{ content: "same", labelOf: plain }]);
		setTypography({ fontScalePercent: 115 });
		setTypography({ fontScalePercent: 100 });
		expect((await old).status).toBe("cancelled");
		expect(hasMeasured("same")).toBe(false);
	});

	test("oversized inputs stay unmeasured, without sending an unbounded request", async () => {
		const { w, posted } = fakeWorker(() => ({ out: [] }));
		setMeasureWorkerFactoryForTests(() => w);
		const huge = "x".repeat(64_001);
		expect((await prewarmBodies([{ content: huge, labelOf: plain }])).status).toBe("limited");
		expect(posted).toHaveLength(0);
		expect(hasMeasured(huge)).toBe(false);
	});

	test("pending payload budget is shared across calls and is released on cancellation", async () => {
		let posted = 0;
		const w = {
			onmessage: null,
			onerror: null,
			postMessage() {
				posted++;
			},
			terminate() {},
		};
		setMeasureWorkerFactoryForTests(() => w as unknown as Worker);
		const first = prewarmBodies(
			Array.from({ length: 30 }, (_, i) => ({
				content: `${i}${"x".repeat(32_000)}`,
				labelOf: plain,
			})),
		);
		expect(posted).toBe(1);
		const second = await prewarmBodies([{ content: "y".repeat(64_000), labelOf: plain }]);
		expect(second.status).toBe("limited");
		expect(posted).toBe(1);
		const healthy = fakeWorker((req) => ({
			out: req.items.map((it) => [it.key, 100, 24]),
		}));
		setMeasureWorkerFactoryForTests(() => healthy.w);
		expect((await first).status).toBe("cancelled");
		expect((await prewarmBodies([{ content: "y".repeat(64_000), labelOf: plain }])).status).toBe(
			"ready",
		);
	});

	test("only accepted keys are remembered; budget-limited work can follow a healthy reply", async () => {
		const { w, posted } = fakeWorker((req) => ({
			out: req.items.map((it) => [it.key, 100, 24]),
		}));
		setMeasureWorkerFactoryForTests(() => w);
		const accepted: string[] = [];
		const items = Array.from({ length: 60 }, (_, i) => ({
			content: `${i}${"x".repeat(32_000)}`,
			labelOf: plain,
		}));
		const first = prewarmBodies(items, { onAccepted: (key) => accepted.push(key) });
		expect(accepted.length).toBeGreaterThan(0);
		expect(accepted.length).toBeLessThan(items.length);
		expect(accepted).toEqual(posted.flatMap((req) => req.items.map((it) => it.key)));
		await first;
		const remaining = items.filter((it) => !hasMeasured(it.content));
		expect(remaining.length).toBeGreaterThan(0);
		await prewarmBodies(remaining, { onAccepted: (key) => accepted.push(key) });
		expect(items.every((it) => hasMeasured(it.content))).toBe(true);
		expect(new Set(accepted).size).toBe(items.length);
	});

	test("joining an existing request also reports the key as accepted", async () => {
		const { w, posted } = fakeWorker((req) => ({
			out: req.items.map((it) => [it.key, 100, 24]),
		}));
		setMeasureWorkerFactoryForTests(() => w);
		const items = [{ content: "already pending", labelOf: plain }];
		const firstAccepted: string[] = [];
		const joined: string[] = [];
		const first = prewarmBodies(items, { onAccepted: (key) => firstAccepted.push(key) });
		const second = prewarmBodies(items, { onAccepted: (key) => joined.push(key) });
		expect(joined).toEqual(firstAccepted);
		expect(joined).toHaveLength(1);
		expect(posted).toHaveLength(1);
		await Promise.all([first, second]);
	});

	test("a failed send does not mark later chunks as accepted", async () => {
		const posted: MeasureRequest[] = [];
		const w = {
			onmessage: null,
			onerror: null,
			postMessage(request: MeasureRequest) {
				posted.push(request);
				throw new Error("send failed");
			},
			terminate() {},
		};
		setMeasureWorkerFactoryForTests(() => w as unknown as Worker);
		const accepted: string[] = [];
		const items = Array.from({ length: 600 }, (_, i) => ({ content: `${i}`, labelOf: plain }));
		expect((await prewarmBodies(items, { onAccepted: (key) => accepted.push(key) })).status).toBe(
			"failed",
		);
		expect(posted).toHaveLength(1);
		expect(accepted).toEqual(posted[0].items.map((it) => it.key));
		expect(accepted.length).toBeLessThan(items.length);
	});

	test("a permanently oversized key does not block later small bodies", async () => {
		const { w, posted } = fakeWorker((req) => ({
			out: req.items.map((it) => [it.key, 100, 24]),
		}));
		setMeasureWorkerFactoryForTests(() => w);
		const accepted: string[] = [];
		await prewarmBodies(
			[
				{ content: "[[target|title]]", labelOf: () => "x".repeat(2_000_001) },
				{ content: "small", labelOf: plain },
			],
			{ onAccepted: (key) => accepted.push(key) },
		);
		expect(posted.flatMap((req) => req.items.map((it) => it.content))).toEqual(["small"]);
		expect(accepted).toEqual([measureKey("small", plain).key]);
		expect(hasMeasured("small")).toBe(true);
	});

	test("a new A generation does not join an old A job still in flight", async () => {
		let created = 0;
		const old = { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
		const healthy = fakeWorker((req) => ({
			out: req.items.map((it) => [it.key, 70, 24]),
		}));
		setMeasureWorkerFactoryForTests(() =>
			++created === 1 ? (old as unknown as Worker) : healthy.w,
		);
		const first = prewarmBodies([{ content: "same", labelOf: plain }]);
		setTypography({ fontScalePercent: 115 });
		setTypography({ fontScalePercent: 100 });
		const second = prewarmBodies([{ content: "same", labelOf: plain }]);
		expect((await first).status).toBe("cancelled");
		expect((await second).status).toBe("ready");
		expect(created).toBe(2);
		expect(bodySize("same")).toEqual({ w: 70, h: 24 });
	});
});
