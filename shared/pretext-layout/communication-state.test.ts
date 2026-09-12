import { describe, expect, test } from "bun:test";
import { getSummary } from "../../frontend/components/narrator/tool-call/tool-display";
import {
	communicationTargetLabel,
	deriveCommunicationState,
	formatCommunicationState,
	resolveCommunicationTargets,
} from "./communication-state";

const labels = {
	communicationRunning: "发送中",
	communicationNoRecipients: "无收件人",
	communicationSuccess: "已发送",
	communicationReceived: "已收到",
	communicationWaiting: "等待中",
	communicationReplyReceived: "已等到回复",
	communicationTimeout: "已超时",
	communicationCancelled: "已取消",
	communicationError: "发送失败",
};
const render = (input: Parameters<typeof deriveCommunicationState>[0]) =>
	formatCommunicationState(deriveCommunicationState(input), labels);
const queued = { id: "a", deliveryMessageId: "m", status: "queued" };
const received = { ...queued, injectionConsumedAt: "2026-09-09T00:00:00Z" };
const replied = { ...received, status: "completed", awaited: true };

describe("Send independent delivery/reply axes", () => {
	test("the resolved target count wins over duplicate selectors without shrinking partial fanout", () => {
		expect(render({ targets: [received], selectorCount: 2, targetCount: 1 })).toBe("已收到");
		expect(render({ targets: [received], selectorCount: 2, targetCount: 3 })).toBe("已收到 1/3");
		expect(render({ targets: [received], selectorCount: 2 })).toBe("已收到 1/2");
	});
	test("a completed explicit empty target set is terminal, not sending or received", () => {
		for (const status of ["success", "completed"]) {
			const state = deriveCommunicationState({ targets: [], targetCount: 0, status });
			expect(formatCommunicationState(state, labels)).toBe("无收件人");
			expect(formatCommunicationState(state)).toBe("No recipients");
			expect(state).toMatchObject({ sentCount: 0, receivedCount: 0, replyCount: 0 });
		}
		expect(render({ targets: [], targetCount: 0, status: "running" })).toBe("发送中");
		expect(render({ targets: [], targetCount: 0, status: "failed" })).toBe("发送失败");
		expect(render({ targets: [], status: "success" })).not.toBe("无收件人");
		expect(getSummary("Send", {}, { targets: [], targetCount: 0, status: "success" }, labels)).toBe(
			"to subagent · 无收件人",
		);
	});
	test("prefers current title, then label, then short id", () => {
		expect(
			communicationTargetLabel({ id: "abcdefghijk", label: "alias", title: "Current name" }),
		).toBe("Current name");
		expect(communicationTargetLabel({ id: "abcdefghijk", label: "alias", title: " " })).toBe(
			"alias",
		);
		expect(communicationTargetLabel({ id: "abcdefghijk" })).toBe("abcdefgh");
	});
	test("queue message and success/completed never fabricate consumption", () => {
		for (const status of ["success", "completed"]) {
			expect(render({ targets: [queued], status })).toBe("已发送");
			expect(render({ targets: [queued], status, awaitReply: true })).toBe("已发送 · 等待中");
		}
		expect(render({ targets: [received] })).toBe("已收到");
		expect(render({ targets: [replied], awaitReply: false })).toBe("已收到");
	});
	test("await starts sending, queues, consumes, then receives a matched reply", () => {
		expect(render({ selectorCount: 1, awaitReply: true })).toBe("发送中");
		expect(render({ targets: [queued], awaitReply: true })).toBe("已发送 · 等待中");
		expect(render({ targets: [received], awaitReply: true })).toBe("已收到 · 等待中");
		expect(render({ targets: [replied], awaitReply: true })).toBe("已收到 · 已等到回复");
		expect(
			render({ targets: [{ ...replied, injectionConsumedAt: undefined }], awaitReply: true }),
		).toBe("已发送 · 已等到回复");
		for (const awaited of [undefined, false])
			expect(render({ targets: [{ ...replied, awaited }], awaitReply: true })).toBe(
				"已收到 · 等待中",
			);
	});
	test("partial runtime targets cannot complete a selector or broadcast fanout", () => {
		expect(render({ targets: [received], selectorCount: 3 })).toBe("已收到 1/3");
		expect(render({ targets: [received, { ...received, id: "b" }], targetCount: 3 })).toBe(
			"已收到 2/3",
		);
		expect(
			render({
				targets: [replied, { ...queued, id: "b" }, { ...queued, id: "c" }],
				awaitReply: true,
			}),
		).toBe("已收到 1/3 · 已等到回复 1/3");
		expect(render({ targets: [], status: "success" })).not.toContain("已收到");
	});
	test("timeout, cancel, fail remain explicit without implying reception", () => {
		for (const [status, expected] of [
			["timeout", "已超时"],
			["aborted", "已取消"],
			["failed", "发送失败"],
		]) {
			expect(render({ targets: [{ ...queued, status }], awaitReply: true })).toBe(
				`已发送 · ${expected}`,
			);
		}
	});
	test("matching runtime consumption enriches final results without replacing errors or replies", () => {
		const metadata = { targets: [{ ...replied, title: "Old", injectionConsumedAt: undefined }] };
		expect(
			resolveCommunicationTargets(metadata, [{ ...received, title: "Current" }])[0],
		).toMatchObject({
			status: "completed",
			awaited: true,
			title: "Current",
			injectionConsumedAt: received.injectionConsumedAt,
		});
		expect(
			resolveCommunicationTargets(metadata, [{ ...received, deliveryMessageId: "other" }])[0]
				?.injectionConsumedAt,
		).toBeUndefined();
		expect(metadata.targets[0]?.title).toBe("Old");
		expect(resolveCommunicationTargets({ targets: [] }, [received])).toEqual([]);
	});
	test("stable COW receipts update navigation without losing consumption or final results", () => {
		for (const status of ["completed", "failed"]) {
			for (const consumedInFinal of [false, true]) {
				const final = {
					...queued,
					deliveryId: "delivery",
					recipientRefId: "ref",
					revision: 1,
					status,
					awaited: true,
					error: "final error",
					interrupted: true,
					...(consumedInFinal ? { injectionConsumedAt: "adopted" } : {}),
				};
				const live = {
					...queued,
					deliveryId: "delivery",
					recipientRefId: "ref",
					revision: 1,
					deliveryMessageId: "cow",
					receiptDisposition: "superseded",
					...(!consumedInFinal ? { injectionConsumedAt: "adopted" } : {}),
				};
				const [result] = resolveCommunicationTargets({ targets: [final] }, [live]);
				expect(result).toMatchObject({
					deliveryId: "delivery",
					recipientRefId: "ref",
					revision: 1,
					deliveryMessageId: "cow",
					injectionConsumedAt: "adopted",
					receiptDisposition: "superseded",
					status,
					awaited: true,
					error: "final error",
					interrupted: true,
				});
				expect(final.deliveryMessageId).toBe("m");
			}
		}
	});

	test("revision changes neither inherit old consumption nor accept stale addresses", () => {
		const old = { ...received, deliveryId: "delivery", revision: 1 };
		const current = {
			...queued,
			deliveryId: "delivery",
			revision: 2,
			deliveryMessageId: "cow",
			recipientRefId: "new-ref",
			receiptDisposition: "recipient_deleted",
		};
		for (const [final, live] of [
			[old, current],
			[current, old],
		]) {
			const [result] = resolveCommunicationTargets({ targets: [{ ...final, status: "failed" }] }, [
				live,
			]);
			expect(result).toMatchObject({ ...current, status: "failed" });
			expect(result.injectionConsumedAt).toBeUndefined();
		}
	});

	test("different stable deliveries cannot share consumption even at the same message address", () => {
		const final = { ...queued, deliveryId: "final", revision: 1 };
		const [result] = resolveCommunicationTargets({ targets: [final] }, [
			{ ...received, deliveryId: "unrelated", revision: 1 },
			{ ...received, id: "other" },
		]);
		expect(result).toMatchObject(final);
		expect(result.injectionConsumedAt).toBeUndefined();
		expect(resolveCommunicationTargets({ targets: [final] }, [received])).toHaveLength(1);
	});

	test("runtime-only and matching legacy snapshots retain stable protocol fields", () => {
		const stable = {
			...received,
			deliveryId: "delivery",
			revision: 2,
			recipientRefId: "ref",
			receiptDisposition: "recipient_deleted" as const,
		};
		expect(resolveCommunicationTargets(undefined, [stable])).toEqual([stable]);
		expect(resolveCommunicationTargets({ targets: [stable] }, [queued])[0]).toMatchObject(stable);
		expect(resolveCommunicationTargets({ targets: [queued] }, [stable])[0]).toMatchObject(stable);
	});

	test("fold summaries show title and evidence, never async mode", () => {
		for (const awaitValue of [false, undefined]) {
			const summary = getSummary(
				"Send",
				{ id: "alias", await: awaitValue },
				{ targets: [{ ...received, title: "Current" }], await: false },
				labels,
			);
			expect(summary).toBe("to Current · 已收到");
			expect(summary).not.toMatch(/async|不等待|Do not wait/);
		}
		expect(getSummary("Send", { id: "alias", await: true }, { targets: [replied] }, labels)).toBe(
			"to a · 已收到 · 已等到回复",
		);
	});
});
