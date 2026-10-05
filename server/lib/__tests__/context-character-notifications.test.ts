import { afterAll, beforeEach, expect, mock, test } from "bun:test";

type Call = { id: string; ids: readonly string[] | undefined; full: boolean };
const calls: Call[] = [];
let gate: Promise<void> | undefined;
let active = 0;
let peak = 0;
let overflowCalls = 0;
mock.module("../../services/narrator-context-composition", () => ({
	async invalidateContextCharacterOverflow() {
		overflowCalls++;
		await gate;
	},
	async invalidateContextCharacterBatch(
		id: string,
		ids?: readonly string[],
		options?: { full?: boolean },
	) {
		calls.push({ id, ids, full: !!options?.full });
		active++;
		peak = Math.max(peak, active);
		try {
			await gate;
		} finally {
			active--;
		}
	},
	invalidateContextCharacterCache: async () => {
		throw new Error("batch export must be used");
	},
}));
const { queueContextCharacterRefresh, hasPendingContextCharacterRefresh } = await import(
	"../context-characters"
);
async function drain() {
	for (let i = 0; i < 100 && hasPendingContextCharacterRefresh(); i++)
		await new Promise((resolve) => setTimeout(resolve, 1));
	expect(hasPendingContextCharacterRefresh()).toBe(false);
}
beforeEach(async () => {
	gate = undefined;
	await drain();
	calls.length = 0;
	active = 0;
	peak = 0;
	overflowCalls = 0;
});
afterAll(async () => {
	gate = undefined;
	await drain();
});

test("one burst marks each narrator once with deduplicated dirty message IDs", async () => {
	for (let i = 0; i < 100; i++) queueContextCharacterRefresh("n", `m${i % 2}`);
	queueContextCharacterRefresh("other", "m3");
	expect(hasPendingContextCharacterRefresh("n")).toBe(true);
	await drain();
	expect(calls).toEqual([
		{ id: "n", ids: ["m0", "m1"], full: false },
		{ id: "other", ids: ["m3"], full: false },
	]);
});

test("history-wide invalidation wins without losing shared message fanout", async () => {
	queueContextCharacterRefresh("n", "m1");
	queueContextCharacterRefresh("n");
	queueContextCharacterRefresh("n", "m2");
	await drain();
	expect(calls).toEqual([{ id: "n", ids: ["m1", "m2"], full: true }]);
});

test("in-flight notifications remain stale and new bursts do not overlap fanout", async () => {
	let release: (() => void) | undefined;
	gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	queueContextCharacterRefresh("n", "first");
	for (let i = 0; i < 100 && calls.length === 0; i++)
		await new Promise((resolve) => setTimeout(resolve, 1));
	expect(calls).toHaveLength(1);
	expect(hasPendingContextCharacterRefresh("n")).toBe(true);
	queueContextCharacterRefresh("n", "second");
	queueContextCharacterRefresh("n", "third");
	release?.();
	gate = undefined;
	await drain();
	expect(peak).toBe(1);
	expect(calls).toEqual([
		{ id: "n", ids: ["first"], full: false },
		{ id: "n", ids: ["second", "third"], full: false },
	]);
});

for (const scenario of ["actors", "messages"] as const) {
	test(`${scenario} overflow collapses to one bounded global mark instead of losing shared holders`, async () => {
		for (let i = 0; i < (scenario === "actors" ? 1000 : 10_000); i++)
			queueContextCharacterRefresh(scenario === "actors" ? `n${i}` : "n", `m${i}`);
		expect(hasPendingContextCharacterRefresh("not-in-local-batch")).toBe(true);
		await drain();
		expect(overflowCalls).toBe(1);
		expect(calls).toEqual([]);
	});
}
