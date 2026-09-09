import { describe, expect, test } from "bun:test";
import { beginAgentReplyWaitRun } from "../agent-reply-waiter";
import {
	attachActiveSendDeliveryTargets,
	SEND_DELIVERY_TARGETS_FIELD,
} from "../send-delivery-resolution";

function message(owner = "owner", toolUseId = "send-tool") {
	return {
		narratorId: owner,
		toolCalls: [{ id: "row", narratorId: owner, toolUseId }],
		contentJson: [
			{
				type: "tool_use",
				id: toolUseId,
				name: "Send",
				tcId: "row",
				status: "running",
				outputJson: null,
			},
		],
		children: [],
	};
}

describe("running Send delivery receipts", () => {
	test("old failed no-output attempts never receive a newer attempt's receipt", () => {
		const old = message();
		old.contentJson[0].status = "fail";
		const live = message();
		let calls = 0;
		const result = attachActiveSendDeliveryTargets([old, live], () => {
			calls++;
			return [{ id: "child", deliveryMessageId: "new-receipt" }];
		});
		expect(result[0]).toBe(old);
		expect(result[0].contentJson[0]._sendDeliveryTargets).toBeUndefined();
		expect(result[1].contentJson[0]._sendDeliveryTargets).toHaveLength(1);
		expect(calls).toBe(1);
	});

	test("binds receipt lookup and cache to the concrete tool row and execution attempt", () => {
		const first = message();
		const second = message();
		Object.assign(first.toolCalls[0], { executionAttempt: 1 });
		Object.assign(second.toolCalls[0], { executionAttempt: 2 });
		const seen: unknown[] = [];
		const result = attachActiveSendDeliveryTargets([first, second], (_owner, _tool, binding) => {
			seen.push(binding);
			return binding?.attempt === 2 ? [{ id: "child", deliveryMessageId: "new-receipt" }] : [];
		});
		expect(seen).toEqual([
			{ toolCallId: "row", attempt: 1 },
			{ toolCallId: "row", attempt: 2 },
		]);
		expect(result[0]).toBe(first);
		expect(result[1].contentJson[0]._sendDeliveryTargets).toHaveLength(1);
	});
	test("default lookup reads scoped active checkpoints and drops completed runs", () => {
		const run = beginAgentReplyWaitRun({ requesterId: "active-owner", toolUseId: "active-send" });
		try {
			run.markStable({
				prefixTargets: [{ id: "target", status: "queued", deliveryMessageId: "reserved" }],
			});
			const tree = [
				message("active-owner", "active-send"),
				message("wrong-owner", "active-send"),
				message("active-owner", "wrong-tool"),
			];
			const result = attachActiveSendDeliveryTargets(tree);
			expect(result[0].contentJson[0]._sendDeliveryTargets).toEqual([
				{ id: "target", deliveryMessageId: "reserved" },
			]);
			expect(result[1]).toBe(tree[1]);
			expect(result[2]).toBe(tree[2]);
			run.complete();
			expect(attachActiveSendDeliveryTargets(tree)).toBe(tree);
		} finally {
			run.complete();
		}
	});
	test("reserved ids are transported independently without pretending the delivery persisted", () => {
		const original = message();
		const tree = attachActiveSendDeliveryTargets([original], () => [
			{ id: "child", deliveryMessageId: "not-yet-persisted" },
		]);
		expect(tree[0].contentJson[0][SEND_DELIVERY_TARGETS_FIELD]).toEqual([
			{ id: "child", deliveryMessageId: "not-yet-persisted" },
		]);
		expect(tree[0].contentJson[0].status).toBe("running");
		expect(tree[0].contentJson[0].outputJson).toBeNull();
		expect(tree[0].contentJson[0]._metadata).toBeUndefined();
		expect(original.contentJson[0]).not.toHaveProperty(SEND_DELIVERY_TARGETS_FIELD);
	});

	test("queries the original tool owner and exact tool, not the viewing/forked narrator", () => {
		const original = message("source");
		original.narratorId = "fork-view";
		const calls: string[][] = [];
		const tree = attachActiveSendDeliveryTargets(
			[original, message("sibling", "send-tool")],
			(owner, toolUseId) => {
				calls.push([owner, toolUseId]);
				return owner === "source" ? [{ id: "child", deliveryMessageId: "receipt" }] : [];
			},
		);
		expect(calls).toEqual([
			["source", "send-tool"],
			["sibling", "send-tool"],
		]);
		expect(tree[0].contentJson[0]._sendDeliveryTargets).toHaveLength(1);
		expect(tree[1].contentJson[0]._sendDeliveryTargets).toBeUndefined();
	});

	test("does not scan finished tools or unrelated tools, and preserves unaffected tree identity", () => {
		const finished = message();
		const unrelated = message();
		unrelated.contentJson[0].name = "Await";
		const tree = [
			{
				...finished,
				contentJson: [{ ...finished.contentJson[0], outputJson: { _metadata: { targets: [] } } }],
			},
			unrelated,
		];
		let calls = 0;
		expect(
			attachActiveSendDeliveryTargets(tree, () => {
				calls++;
				return [];
			}),
		).toBe(tree);
		expect(calls).toBe(0);
	});

	test("nested and repeated rows share one lookup per owner/tool and exclude missing receipt ids", () => {
		const row = message();
		const tree = [row, { narratorId: "parent", children: [row] }];
		let calls = 0;
		const result = attachActiveSendDeliveryTargets(tree, () => {
			calls++;
			return [{ id: "unknown" }, { id: "child", deliveryMessageId: "reserved" }];
		});
		expect(calls).toBe(1);
		expect(result[1].children[0].contentJson[0]._sendDeliveryTargets).toEqual([
			{ id: "child", deliveryMessageId: "reserved" },
		]);
	});

	test("missing owner and failed lookup never break message loading", () => {
		const tree = [message()];
		expect(
			attachActiveSendDeliveryTargets(tree, () => {
				throw new Error("lookup failed");
			}),
		).toBe(tree);
		let calls = 0;
		attachActiveSendDeliveryTargets([{ contentJson: message().contentJson }], () => {
			calls++;
			return [];
		});
		expect(calls).toBe(0);
	});
});
