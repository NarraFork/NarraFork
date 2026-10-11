import { expect, test } from "bun:test";
import { WindowsFirstCaptureReadIntents } from "./windows-first-capture-read-intents";

// Accounting/state fixture ONLY. Not native completion, signing, custody or recovery proof.
test("per-connection four and process64 are hard pending/tombstone accounting budgets", () => {
	const slots = new WindowsFirstCaptureReadIntents();
	for (let index = 0; index < 4; index++) slots.reserve(`op-${index}`, "connection", 0);
	expect(() => slots.reserve("fifth", "connection", 0)).toThrow("CAPACITY");
	expect(slots.size).toBe(4);
});

test("65 fresh operations continue after actual-completion state reaches original TTL; no permanent64 tombstone dead end", () => {
	const slots = new WindowsFirstCaptureReadIntents();
	for (let index = 0; index < 64; index++) {
		const intent = slots.reserve(`fresh-op-${index}`, `connection-${Math.floor(index / 4)}`, 0);
		// Test input models the state set ONLY after production completion/pending verification.
		intent.state = "captured";
	}
	expect(slots.size).toBe(64);
	expect(() => slots.reserve("fresh-op-65", "next-connection", 29999)).toThrow("CAPACITY");
	expect(slots.reserve("fresh-op-65", "next-connection", 30000).state).toBe("preauthorizing");
	expect(slots.size).toBe(1);
	// Cleanup is NOT a recovered success/cache/grant. Durable helper master independently
	// rejects old source/scope/op BEFORE issuing new preauth/ticket or native capture.
	expect(slots.reserve("fresh-op-0", "connection-0", 30000).state).toBe("preauthorizing");
});

for (const state of ["preauthorizing", "capturing", "unknown"] as const) {
	test(`${state} retains capacity after TTL/disconnect horizon, never a fake terminal`, () => {
		const slots = new WindowsFirstCaptureReadIntents();
		for (let index = 0; index < 4; index++)
			slots.reserve(`op-${index}`, "connection", 0).state = state;
		expect(() => slots.reserve("fresh", "connection", 999999)).toThrow("CAPACITY");
		expect(() => slots.reserve("op-0", "connection", 999999)).toThrow("ALREADY_CONSUMED");
		expect(slots.size).toBe(4);
	});
}

test("no-dispatch rollback is exact record identity and cannot discard Unknown work", () => {
	const slots = new WindowsFirstCaptureReadIntents();
	const intent = slots.reserve("op", "connection", 0);
	slots.discardBeforeDispatch("op", { ...intent });
	expect(slots.size).toBe(1);
	intent.state = "unknown";
	slots.discardBeforeDispatch("op", intent);
	expect(slots.size).toBe(1);
	const notSent = slots.reserve("before-dispatch", "connection", 0);
	slots.discardBeforeDispatch("before-dispatch", notSent);
	expect(slots.size).toBe(1);
});

test("captured terminal is not replayable in the still-live original token horizon", () => {
	const slots = new WindowsFirstCaptureReadIntents();
	slots.reserve("op", "connection", 0).state = "captured";
	expect(() => slots.reserve("op", "connection", 29999)).toThrow("ALREADY_CONSUMED");
});
