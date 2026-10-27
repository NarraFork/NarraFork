import { afterEach, describe, expect, test } from "bun:test";
import { clearMeasureCache } from "./measure";
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

afterEach(() => {
	setMeasureWorkerFactoryForTests(null);
	clearMeasureCache();
});

describe("measuring ahead in a Worker", () => {
	test("a body the Worker cannot measure is no longer in flight: it can be sent again", async () => {
		const { w, posted } = fakeWorker((req) => ({ out: [], failed: req.items.map((i) => i.key) }));
		setMeasureWorkerFactoryForTests(() => w);
		const failedBefore = prewarmStats.failed;
		await prewarmBodies([{ content: "cannot measure", labelOf: plain }]);
		expect(prewarmStats.failed - failedBefore).toBe(1);
		await prewarmBodies([{ content: "cannot measure", labelOf: plain }]);
		expect(posted.flatMap((r) => r.items.map((i) => i.content))).toEqual([
			"cannot measure",
			"cannot measure",
		]);
	});

	test("a measured body is not sent again; one in flight is not sent twice", async () => {
		const { w, posted } = fakeWorker((req) => ({
			out: req.items.map((i) => [i.key, 100, 22] as [string, number, number]),
			failed: [],
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
							failed: [],
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
});
