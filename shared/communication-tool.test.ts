import { expect, test } from "bun:test";
import {
	isCommunicationTool,
	knownSendDeliveryTargets,
	mergeSendDeliveryTargetCount,
	mergeSendDeliveryTargets,
	shouldShowCommunicationBubble,
} from "./communication-tool";

test("communication fact is independent from compact bubble intent", () => {
	for (const tool of [
		{ toolName: "Send", inputJson: { id: "child", message: "internal" } },
		{ toolName: "TeamStatus", inputJson: { action: "send", message: "internal" } },
		{ toolName: "TeamStatus", inputJson: { action: "broadcast", message: "internal" } },
	]) {
		expect(isCommunicationTool(tool)).toBe(true);
		expect(shouldShowCommunicationBubble(tool, false)).toBe(true);
		expect(shouldShowCommunicationBubble(tool, true)).toBe(false);
		expect(
			shouldShowCommunicationBubble(
				{ ...tool, inputJson: { ...tool.inputJson, show_to_user: false } },
				true,
			),
		).toBe(false);
		expect(
			shouldShowCommunicationBubble(
				{ ...tool, inputJson: { ...tool.inputJson, show_to_user: true } },
				true,
			),
		).toBe(true);
	}
	expect(
		shouldShowCommunicationBubble({ toolName: "Send", inputJson: { user: "person" } }, true),
	).toBe(true);
	expect(
		shouldShowCommunicationBubble(
			{ toolName: "Send", inputJson: { _streamingFields: { show_to_user: true } } },
			true,
		),
	).toBe(true);
	expect(
		shouldShowCommunicationBubble(
			{
				toolName: "Send",
				inputJson: {
					show_to_user: true,
					_streamingFieldName: "show_to_user",
					_streamingFieldValue: false,
				},
			},
			true,
		),
	).toBe(false);
	expect(
		shouldShowCommunicationBubble({ toolName: "Read", inputJson: { show_to_user: true } }, true),
	).toBe(false);
});

test("stable receipt retains adopted revision while COW updates its address", () => {
	const [target] = mergeSendDeliveryTargets(
		[
			{
				id: "child",
				deliveryId: "delivery",
				deliveryMessageId: "original",
				revision: 1,
				injectionConsumedAt: "adopted",
			},
		],
		[
			{
				id: "child",
				deliveryId: "delivery",
				deliveryMessageId: "cow",
				recipientRefId: "ref",
				revision: 1,
			},
		],
	);
	expect(target).toMatchObject({
		deliveryMessageId: "cow",
		recipientRefId: "ref",
		injectionConsumedAt: "adopted",
		revision: 1,
	});
});
test("stale original revision frames cannot replace a newer revision or revive tombstones", () => {
	const current = {
		id: "child",
		deliveryId: "delivery",
		deliveryMessageId: "new",
		revision: 2,
		receiptDisposition: "recipient_deleted" as const,
	};
	expect(
		mergeSendDeliveryTargets(
			[current],
			[
				{
					id: "child",
					deliveryId: "delivery",
					deliveryMessageId: "old",
					revision: 1,
					injectionConsumedAt: "old",
				},
			],
		),
	).toEqual([current]);
	expect(
		mergeSendDeliveryTargets(
			[current],
			[
				{
					id: "child",
					deliveryId: "delivery",
					deliveryMessageId: "new",
					revision: 2,
					receiptDisposition: "active",
				},
			],
		)[0].receiptDisposition,
	).toBe("recipient_deleted");
	const [next] = mergeSendDeliveryTargets(
		[{ ...current, revision: 1, injectionConsumedAt: "old" }],
		[{ id: "child", deliveryId: "delivery", revision: 2 }],
	);
	expect(next.injectionConsumedAt).toBeUndefined();
});

test("another revision cannot inherit an older adoption", () => {
	const [target] = mergeSendDeliveryTargets(
		[
			{
				id: "child",
				deliveryId: "delivery",
				deliveryMessageId: "old",
				revision: 1,
				injectionConsumedAt: "adopted",
			},
		],
		[{ id: "child", deliveryId: "delivery", deliveryMessageId: "new", revision: 2 }],
	);
	expect(target.injectionConsumedAt).toBeUndefined();
	expect(target.revision).toBe(2);
});
test("negative disposition keeps original adopted fact but does not restore active navigation", () => {
	const [target] = mergeSendDeliveryTargets(
		[
			{
				id: "child",
				deliveryId: "delivery",
				deliveryMessageId: "original",
				revision: 1,
				injectionConsumedAt: "adopted",
			},
		],
		[
			{
				id: "child",
				deliveryId: "delivery",
				deliveryMessageId: "original",
				revision: 1,
				receiptDisposition: "recipient_deleted",
			},
		],
	);
	expect(target).toMatchObject({
		receiptDisposition: "recipient_deleted",
		injectionConsumedAt: "adopted",
	});
});
test("final tool metadata cannot overwrite a newer COW receipt or shrink fanout", () => {
	const tool = {
		status: "completed",
		outputJson: {
			_metadata: {
				targets: [
					{ id: "child", deliveryId: "delivery", deliveryMessageId: "original", revision: 1 },
					{ id: "other", deliveryMessageId: "other" },
				],
			},
		},
		_sendDeliveryTargets: [
			{
				id: "child",
				deliveryId: "delivery",
				deliveryMessageId: "cow",
				revision: 1,
				injectionConsumedAt: "adopted",
			},
		],
	};
	expect(knownSendDeliveryTargets(tool)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "child",
				deliveryMessageId: "cow",
				injectionConsumedAt: "adopted",
			}),
		]),
	);
	expect(knownSendDeliveryTargets(tool)).toHaveLength(2);
	expect(mergeSendDeliveryTargetCount(3, 1)).toBe(3);
	expect(tool.status).toBe("completed");
});
