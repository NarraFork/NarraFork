import { afterAll, expect, mock, test } from "bun:test";
import type { ToolContext } from "../../types";

const realCommunication = { ...(await import("@server/services/agent-communication")) };
const realWebsocket = { ...(await import("@server/websocket/narrator-ws")) };
const frames: unknown[] = [];
let release: (() => void) | undefined;
let frameReceived: (() => void) | undefined;
let deliveryTargets: Array<{ id: string; deliveryMessageId: string }> = [];

mock.module("@server/services/agent-communication", () => ({
	...realCommunication,
	sendSubagentMessageDetailed: async (input: {
		onTargetResolved?: (id: string) => void;
		onDeliveryResolved?: (target: { id: string; deliveryMessageId: string }) => void;
	}) => {
		input.onTargetResolved?.("resolved-child");
		for (const target of deliveryTargets) input.onDeliveryResolved?.(target);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			output: "Reply received",
			targets: deliveryTargets.length
				? deliveryTargets
				: [{ id: "resolved-child", label: "worker" }],
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

test("Send broadcasts its resolved target before the reply wait completes", async () => {
	const received = new Promise<void>((resolve) => {
		frameReceived = resolve;
	});
	let completed = false;
	const waiting = sendTool
		.execute({ id: "worker", message: "Please reply", await: true }, {
			narratorId: "primary",
			currentToolUseId: "send-tool",
			signal: new AbortController().signal,
			locale: "en",
		} as ToolContext)
		.then((result) => {
			completed = true;
			return result;
		});
	await received;
	expect(completed).toBe(false);
	expect(frames).toEqual([
		{
			type: "await_agent_resolved",
			narratorId: "primary",
			toolUseId: "send-tool",
			subagentNarratorId: "resolved-child",
		},
	]);
	release?.();
	const result = await waiting;
	expect(result.output).toBe("Reply received");
	expect(result.metadata?.targets).toEqual([{ id: "resolved-child", label: "worker" }]);
});

test("queued receipts stream before completion and remain in final target metadata", async () => {
	frames.length = 0;
	deliveryTargets = [
		{ id: "child-a", deliveryMessageId: "reserved-a" },
		{ id: "child-b", deliveryMessageId: "reserved-b" },
	];
	const received = new Promise<void>((resolve) => {
		frameReceived = () => {
			if (frames.length === 2) resolve();
		};
	});
	let completed = false;
	const waiting = sendTool
		.execute({ ids: ["worker-a", "worker-b"], message: "Please reply", await: true }, {
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
	expect(frames).toEqual([
		{
			type: "send_delivery_resolved",
			narratorId: "primary",
			toolUseId: "send-fanout",
			targets: [deliveryTargets[0]],
		},
		{
			type: "send_delivery_resolved",
			narratorId: "primary",
			toolUseId: "send-fanout",
			targets: deliveryTargets,
		},
	]);
	release?.();
	const result = await waiting;
	expect(result.metadata?.targets).toEqual(deliveryTargets);
});
