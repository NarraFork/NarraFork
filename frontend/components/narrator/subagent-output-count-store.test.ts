import { describe, expect, test } from "bun:test";
import type { SubagentOutputCount } from "@shared/subagent-output-counts";
import {
	getSubagentOutputCount,
	replaceSubagentOutputCounts,
	retainSubagentOutputCounts,
	setSubagentOutputCount,
	subscribeSubagentOutputCount,
} from "./subagent-output-count-store";

const ref = { toolUseId: "wire", toolCallId: "call", executionAttempt: 0 };
const value = (patch: Partial<SubagentOutputCount> = {}): SubagentOutputCount => ({
	childNarratorId: "child",
	logicalRunId: "run-a",
	toolUseId: "wire",
	toolCallId: "call",
	attempt: 0,
	count: 0,
	active: true,
	...patch,
});

describe("subagent output count store", () => {
	test("keeps the first snapshot before a card subscribes and no-ops duplicate zero ticks", () => {
		const release = retainSubagentOutputCounts("initial");
		replaceSubagentOutputCounts("initial", [value()]);
		const first = getSubagentOutputCount("initial", ref);
		expect(first?.count).toBe(0);
		let notifications = 0;
		const unsubscribe = subscribeSubagentOutputCount("initial", ref, () => notifications++);
		try {
			setSubagentOutputCount("initial", value());
			expect(getSubagentOutputCount("initial", ref)).toBe(first);
			expect(notifications).toBe(0);
			setSubagentOutputCount("initial", value({ count: 30 }));
			expect(notifications).toBe(1);
		} finally {
			unsubscribe();
			release();
		}
	});

	test("isolates narrator, exact PK, attempt and mismatched wire ids", () => {
		const releases = [retainSubagentOutputCounts("left"), retainSubagentOutputCounts("right")];
		try {
			setSubagentOutputCount("left", value({ count: 12 }));
			setSubagentOutputCount("right", value({ count: 25 }));
			setSubagentOutputCount("left", value({ toolCallId: "other-call", count: 42 }));
			expect(getSubagentOutputCount("left", ref)?.count).toBe(12);
			expect(getSubagentOutputCount("right", ref)?.count).toBe(25);
			expect(getSubagentOutputCount("left", { ...ref, toolCallId: "other-call" })?.count).toBe(42);
			expect(getSubagentOutputCount("left", { toolUseId: "wire" })).toBeUndefined();
			expect(
				getSubagentOutputCount("left", { ...ref, toolUseId: "different-wire" }),
			).toBeUndefined();
			setSubagentOutputCount("left", value({ attempt: 1, logicalRunId: "new-attempt", count: 0 }));
			setSubagentOutputCount("left", value({ count: 999 }));
			expect(getSubagentOutputCount("left", { ...ref, executionAttempt: 1 })?.count).toBe(0);
			expect(getSubagentOutputCount("left", ref)?.active).not.toBe(true);
		} finally {
			for (const release of releases) release();
		}
	});

	test("retires A, starts B on the same attempt, and rejects late A frames", () => {
		const release = retainSubagentOutputCounts("runs");
		let notifications = 0;
		const unsubscribe = subscribeSubagentOutputCount("runs", ref, () => notifications++);
		try {
			setSubagentOutputCount("runs", value({ count: 120 }));
			setSubagentOutputCount("runs", value({ logicalRunId: "run-b", count: 999 }));
			expect(getSubagentOutputCount("runs", ref)?.logicalRunId).toBe("run-a");
			setSubagentOutputCount("runs", value({ active: false, count: 120 }));
			expect(getSubagentOutputCount("runs", ref)?.active).toBe(false);
			setSubagentOutputCount("runs", value({ logicalRunId: "run-b" }));
			expect(getSubagentOutputCount("runs", ref)).toMatchObject({
				logicalRunId: "run-b",
				count: 0,
				active: true,
			});
			const beforeLate = notifications;
			setSubagentOutputCount("runs", value({ count: 1000 }));
			setSubagentOutputCount("runs", value({ count: 1000, active: false }));
			expect(notifications).toBe(beforeLate);
			expect(getSubagentOutputCount("runs", ref)?.logicalRunId).toBe("run-b");
			setSubagentOutputCount("runs", value({ logicalRunId: "run-b", count: 50 }));
			setSubagentOutputCount("runs", value({ logicalRunId: "run-b", count: 1 }));
			expect(getSubagentOutputCount("runs", ref)?.count).toBe(1);
			replaceSubagentOutputCounts("runs", [value({ logicalRunId: "run-b", count: 0 })]);
			expect(getSubagentOutputCount("runs", ref)?.count).toBe(0);
		} finally {
			unsubscribe();
			release();
		}
	});

	test("empty reconnect clears subscribed badges and retires unmounted active entries", () => {
		const release = retainSubagentOutputCounts("reconnect");
		const unsubscribe = subscribeSubagentOutputCount("reconnect", ref, () => {});
		try {
			setSubagentOutputCount("reconnect", value({ count: 70 }));
			setSubagentOutputCount("reconnect", value({ toolCallId: "offscreen" }));
			replaceSubagentOutputCounts("reconnect", []);
			expect(getSubagentOutputCount("reconnect", ref)?.active).toBe(false);
			expect(
				getSubagentOutputCount("reconnect", { ...ref, toolCallId: "offscreen" }),
			).toBeUndefined();
			setSubagentOutputCount("reconnect", value({ count: 99 }));
			expect(getSubagentOutputCount("reconnect", ref)?.active).toBe(false);
			replaceSubagentOutputCounts("reconnect", [value({ logicalRunId: "run-new", count: 8 })]);
			expect(getSubagentOutputCount("reconnect", ref)?.count).toBe(8);
		} finally {
			unsubscribe();
			release();
		}
	});

	test("multiple panels share a lease and final release drops entries, listeners and retirement", () => {
		const releaseLeft = retainSubagentOutputCounts("panels");
		const releaseRight = retainSubagentOutputCounts("panels");
		let left = 0;
		let right = 0;
		const unsubscribeLeft = subscribeSubagentOutputCount("panels", ref, () => left++);
		const unsubscribeRight = subscribeSubagentOutputCount("panels", ref, () => right++);
		setSubagentOutputCount("panels", value({ count: 1 }));
		unsubscribeLeft();
		releaseLeft();
		setSubagentOutputCount("panels", value({ count: 2 }));
		expect(left).toBe(1);
		expect(right).toBe(2);
		expect(getSubagentOutputCount("panels", ref)?.count).toBe(2);
		setSubagentOutputCount("panels", value({ active: false, count: 2 }));
		unsubscribeRight();
		releaseRight();
		expect(getSubagentOutputCount("panels", ref)).toBeUndefined();
		const before = right;
		setSubagentOutputCount("panels", value({ count: 500 }));
		expect(right).toBe(before);
		const fresh = retainSubagentOutputCounts("panels");
		try {
			setSubagentOutputCount("panels", value());
			expect(getSubagentOutputCount("panels", ref)?.count).toBe(0);
			expect(left).toBe(1);
			expect(right).toBe(before);
		} finally {
			fresh();
		}
	});

	test("terminal frames are remembered without keeping an unmounted snapshot", () => {
		const release = retainSubagentOutputCounts("terminal");
		try {
			setSubagentOutputCount("terminal", value({ count: 60 }));
			setSubagentOutputCount("terminal", value({ count: 60, active: false }));
			setSubagentOutputCount("terminal", value({ count: 999 }));
			expect(getSubagentOutputCount("terminal", ref)).toBeUndefined();
			setSubagentOutputCount("terminal", value({ logicalRunId: "run-b" }));
			expect(getSubagentOutputCount("terminal", ref)?.logicalRunId).toBe("run-b");
		} finally {
			release();
		}
	});
});
