import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { loadDetector } from "lmfpd-sdk";
import { WorkerHandle } from "../worker-runtime/lifecycle";
import { analyzeModelTrace, buildModelTraceChallenges, MODELTRACE_MAX_TEXT_LENGTH } from "./index";
import { makeModelTraceRunner } from "./worker-client";

function sample(
	expected_count: number,
	step: (i: number) => number = (i) => (i % 2 ? 9 + (i % 40) : 200 + (i % 100)),
) {
	return {
		text: Array.from({ length: expected_count }, (_, i) => step(i)).join(", "),
		expected_count,
	};
}

const full = [sample(298), sample(300), sample(309)];

test("embedded assets match the pinned SDK commit", async () => {
	// Upstream: Ikaleio/lm-detector at 1e58ed83c1cde17f88cba89560ad4d083042ae92.
	// data/unified_bank.json (SHA-256 167edd84bd310bf30775245672944e3201e5ae6b77c5aab40a516494f7cd39fd)
	// was projected in original order to built_at and models[{id, display_name,
	// family, family_name, response_count}], the same fields used by its SDK bundle.
	const assets = [
		["unified_bank.json", "427823368d3218332b8f00cd46a0689848d96c60f39839e4434e67de36f47179"],
		["shared_detector.bin", "6a102f86c3f8a9aeeb052edfbdf5edf6f9e891ac6693129a4e007139c74861f6"],
	];
	for (const [name, expected] of assets) {
		const content = await Bun.file(join(import.meta.dir, name)).arrayBuffer();
		expect(Bun.CryptoHasher.hash("sha256", content, "hex")).toBe(expected);
	}
});

test("generates one upstream challenge and asks the current model not to delegate", () => {
	const challenges = buildModelTraceChallenges();
	expect(challenges).toHaveLength(1);
	for (const { prompt, expectedCount } of challenges) {
		expect(expectedCount).toBeGreaterThanOrEqual(292);
		expect(expectedCount).toBeLessThanOrEqual(332);
		expect(prompt).toContain(String(expectedCount));
		expect(prompt).toContain("without tools, code execution, or delegation");
	}
});

test("generates three distinct challenges for calibration", () => {
	const challenges = buildModelTraceChallenges(3);
	expect(challenges).toHaveLength(3);
	expect(new Set(challenges.map(({ expectedCount }) => expectedCount)).size).toBe(3);
});

test("real Worker returns SDK decisions and softmax weights normalized over the full reference bank", async () => {
	const scored = await makeModelTraceRunner()(full);
	expect(scored.decision).toBe("scored");
	expect(scored.results).toHaveLength(5);
	expect(scored.results[0]?.probability).toBeGreaterThan(0);

	const partial = await makeModelTraceRunner()([
		full[0],
		{ text: "I cannot comply.", expected_count: 300 },
	]);
	expect(partial.decision).toBe("partial");
	expect(partial.results).toHaveLength(5);
	const sdk = await loadDetector({ source: import.meta.dir });
	const source = sdk.analyze([full[0]]).results;
	const best = Math.max(...source.map(({ score }) => score));
	const weights = source.map(({ score }) => Math.exp(score - best));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	expect(source.length).toBeGreaterThan(5);
	partial.results.forEach(({ model, probability }, index) => {
		expect(model).toBe(source[index].model);
		expect(probability).toBeCloseTo(weights[index] / total, 15);
	});
	expect(partial.results.reduce((sum, row) => sum + (row.probability ?? 0), 0)).toBeLessThan(1);

	expect(await makeModelTraceRunner()([{ text: "I cannot comply.", expected_count: 300 }])).toEqual(
		{ decision: "unscorable", results: [] },
	);
	expect(await makeModelTraceRunner()([sample(300, (i) => i + 1)])).toEqual({
		decision: "not_model",
		results: [],
	});
});

test("public adapter won't score an oversized sample", async () => {
	const result = await analyzeModelTrace(
		[{ text: "1".repeat(MODELTRACE_MAX_TEXT_LENGTH + 1), expected_count: 300 }],
		"en",
	);
	expect(result).toEqual({
		type: "modeltrace_result",
		decision: "unscorable",
		results: [],
		error: "Number samples exceed detection limits.",
	});
});

function fakeWorker(onPost: (worker: EventEmitter) => void = () => {}) {
	let exit!: (code: number) => void;
	let stopCalls = 0;
	const worker = Object.assign(new EventEmitter(), { postMessage: () => onPost(worker) });
	const done = new Promise<number>((resolve) => {
		exit = resolve;
	});
	const handle = new WorkerHandle(worker as unknown as Worker, done, () => {
		stopCalls++;
	});
	return {
		handle,
		exit,
		get stopCalls() {
			return stopCalls;
		},
	};
}

test("disabled and startup failures never rank otherwise scoreable answers", async () => {
	let launches = 0;
	const launch = async () => {
		launches++;
		throw new Error("injected startup fault");
	};
	await expect(makeModelTraceRunner({ launch, disabled: () => true })(full)).rejects.toHaveProperty(
		"name",
		"Disabled",
	);
	expect(launches).toBe(0);
	await expect(makeModelTraceRunner({ launch })(full)).rejects.toHaveProperty(
		"name",
		"StartFailed",
	);
	expect(launches).toBe(1);
});

for (const [name, fault] of [
	["crash", (worker: EventEmitter) => worker.emit("error", new Error("injected crash"))],
	[
		"malformed result",
		(worker: EventEmitter) =>
			worker.emit("message", {
				type: "ranked",
				ranking: {
					decision: "partial",
					results: [{ model: "bad", displayName: "bad", probability: 1.01 }],
				},
			}),
	],
	["load failure", (worker: EventEmitter) => worker.emit("message", { type: "unavailable" })],
] as const) {
	test(`${name} never ranks otherwise scoreable answers`, async () => {
		const fake = fakeWorker(fault);
		try {
			await expect(
				makeModelTraceRunner({ launch: async () => fake.handle })(full),
			).rejects.toHaveProperty("name", "WorkerFailed");
			expect(fake.stopCalls).toBe(1);
		} finally {
			fake.exit(1);
		}
	});
}

test("timeout and cancellation terminate the worker without returning a rank or freeing its slot before exit", async () => {
	const fake = fakeWorker();
	const run = makeModelTraceRunner({ launch: async () => fake.handle, timeoutMs: 20 });
	try {
		await expect(run(full)).rejects.toHaveProperty("code", "TASK_QUEUE_TIMEOUT");
		expect(fake.stopCalls).toBe(1);
		await expect(run(full)).rejects.toHaveProperty("code", "TASK_QUEUE_FULL");
	} finally {
		fake.exit(1);
	}
	const { promise: posted, resolve } = Promise.withResolvers<void>();
	const cancelled = fakeWorker(() => resolve());
	try {
		const signal = new AbortController();
		const request = makeModelTraceRunner({ launch: async () => cancelled.handle })(
			full,
			signal.signal,
		);
		await posted;
		signal.abort();
		await expect(request).rejects.toHaveProperty("name", "AbortError");
		expect(cancelled.stopCalls).toBe(1);
	} finally {
		cancelled.exit(1);
	}
});
