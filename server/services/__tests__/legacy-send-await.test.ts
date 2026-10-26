import { describe, expect, test } from "bun:test";
import {
	buildRetiredSendAwaitToolOutput,
	sendAwaitSnapshotFromPayload,
} from "../legacy-send-await";

const snapshot = {
	toolUseId: "send-1",
	requesterId: "parent",
	doInterrupt: false,
	prefixSections: [],
	prefixTargets: [],
	waiters: [
		{ responderId: "a", label: "alpha", deliveryNote: "Sent to alpha.", deliveryMessageId: "m-a" },
		{
			responderId: "b",
			deliveryNote: "Failed to send to b.",
			result: { status: "failed", error: "archived" },
		},
	],
};

describe("legacy Send await checkpoints", () => {
	test("accepts an old checkpoint payload and rejects a malformed one", () => {
		expect(sendAwaitSnapshotFromPayload({ sendAwait: snapshot })?.toolUseId).toBe("send-1");
		expect(sendAwaitSnapshotFromPayload({ sendAwait: { ...snapshot, waiters: null } })).toBeNull();
		expect(
			sendAwaitSnapshotFromPayload({ sendAwait: { ...snapshot, waiters: [null] } }),
		).toBeNull();
		expect(sendAwaitSnapshotFromPayload(null)).toBeNull();
	});

	test("an unanswered wait closes as delivered, a failure stays a failure", () => {
		const parsed = sendAwaitSnapshotFromPayload({ sendAwait: snapshot });
		if (!parsed) throw new Error("expected snapshot");
		const output = buildRetiredSendAwaitToolOutput(parsed);
		expect(output._text).toContain("Sent to alpha.\nThe reply wait ended");
		expect(output._text).toContain("Failed while waiting for b to reply: archived");
		expect(output._metadata).toEqual({
			kind: "send",
			doInterrupt: false,
			targets: [
				{ id: "a", label: "alpha", title: undefined, status: "queued", deliveryMessageId: "m-a" },
				{ id: "b", label: "b", title: undefined, status: "failed", error: "archived" },
			],
		});
	});
});
