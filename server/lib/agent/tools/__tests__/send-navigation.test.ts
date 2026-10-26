import { afterAll, expect, mock, test } from "bun:test";
import type { ToolContext } from "../../types";

const realCommunication = { ...(await import("@server/services/agent-communication")) };
const realWebsocket = { ...(await import("@server/websocket/narrator-ws")) };
const frames: unknown[] = [];
let release: (() => void) | undefined;
let frameReceived: (() => void) | undefined;
const deliveryTargets = [
	{ id: "child-a", deliveryMessageId: "reserved-a" },
	{ id: "child-b", deliveryMessageId: "reserved-b" },
];

mock.module("@server/services/agent-communication", () => ({
	...realCommunication,
	sendSubagentMessageDetailed: async (input: {
		onTargetsResolved?: (count: number) => void;
		onDeliveryResolved?: (target: { id: string; deliveryMessageId: string }) => void;
	}) => {
		if (deliveryTargets.length) input.onTargetsResolved?.(deliveryTargets.length);
		for (const target of deliveryTargets) input.onDeliveryResolved?.(target);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			output: "Delivered",
			targets: deliveryTargets,
		};
	},
}));
mock.module("@server/websocket/narrator-ws", () => ({
	...realWebsocket,
	broadcastToNarrator: (_id: string, frame: unknown) => {
		frames.push(frame);
		frameReceived?.();
	},
}));
const { sendTool } = await import("../send");

afterAll(() => {
	release?.();
	mock.module("@server/services/agent-communication", () => realCommunication);
	mock.module("@server/websocket/narrator-ws", () => realWebsocket);
});

test("queued receipts stream before completion and remain in final target metadata", async () => {
	frames.length = 0;
	const received = new Promise<void>((resolve) => {
		frameReceived = () => {
			if (frames.length === 3) resolve();
		};
	});
	let completed = false;
	const waiting = sendTool
		.execute({ ids: ["worker-a", "worker-b"], message: "Please reply" }, {
			narratorId: "primary",
			currentToolUseId: "send-fanout",
			signal: new AbortController().signal,
			locale: "en",
		} as ToolContext)
		.then((result) => {
			completed = true;
			return result;
		});
	await received;
	expect(completed).toBe(false);
	expect(frames).toEqual(
		[[], [deliveryTargets[0]], [deliveryTargets[1]]].map((targets) => ({
			type: "send_delivery_resolved",
			narratorId: "primary",
			toolUseId: "send-fanout",
			targetCount: 2,
			targets,
		})),
	);
	release?.();
	const result = await waiting;
	expect(result.metadata?.targets).toEqual(deliveryTargets);
	expect(result.metadata?.targetCount).toBe(2);
});
