import { afterAll, expect, mock, test } from "bun:test";
import type { ToolContext } from "../../types";

const realCommunication = { ...(await import("@server/services/agent-communication")) };
const realWebsocket = { ...(await import("@server/websocket/narrator-ws")) };
const frames: unknown[] = [];
let release: (() => void) | undefined;
let frameReceived: (() => void) | undefined;

mock.module("@server/services/agent-communication", () => ({
	...realCommunication,
	sendSubagentMessageDetailed: async (input: { onTargetResolved?: (id: string) => void }) => {
		input.onTargetResolved?.("resolved-child");
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { output: "Reply received", targets: [{ id: "resolved-child", label: "worker" }] };
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
