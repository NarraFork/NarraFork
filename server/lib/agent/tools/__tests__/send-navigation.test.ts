import { afterAll, expect, mock, test } from "bun:test";
import type { ToolContext } from "../../types";

const realCommunication = { ...(await import("@server/services/agent-communication")) };
const realWebsocket = { ...(await import("@server/websocket/narrator-ws")) };
const frames: unknown[] = [];
const showIntents: Array<boolean | undefined> = [];
let pauseDelivery = true;
let release: (() => void) | undefined;
let frameReceived: (() => void) | undefined;
const deliveryTargets = [
	{ id: "child-a", deliveryMessageId: "reserved-a" },
	{ id: "child-b", deliveryMessageId: "reserved-b" },
];

mock.module("@server/services/agent-communication", () => ({
	...realCommunication,
	sendSubagentMessageDetailed: async (input: {
		showToUser?: boolean;
		onTargetsResolved?: (count: number) => void;
		onDeliveryResolved?: (target: { id: string; deliveryMessageId: string }) => void;
	}) => {
		showIntents.push(input.showToUser);
		if (deliveryTargets.length) input.onTargetsResolved?.(deliveryTargets.length);
		for (const target of deliveryTargets) input.onDeliveryResolved?.(target);
		if (pauseDelivery)
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
	expect(showIntents.at(-1)).toBe(false);
});

test.each([
	undefined,
	false,
	true,
])("tool schema accepts optional display intent %s and sends a concrete boolean", async (showToUser) => {
	const args = {
		id: "worker-a",
		message: "Report",
		...(showToUser === undefined ? {} : { show_to_user: showToUser }),
	};
	expect(sendTool.parameters.safeParse(args).success).toBe(true);
	pauseDelivery = false;
	try {
		const result = await sendTool.execute(args, {
			narratorId: "primary",
			currentToolUseId: "display-intent",
			signal: new AbortController().signal,
			locale: "en",
		} as ToolContext);
		expect(result.isError).toBeFalsy();
		expect(showIntents.at(-1)).toBe(showToUser ?? false);
		expect(result.metadata?.targets).toEqual(deliveryTargets);
	} finally {
		pauseDelivery = true;
	}
});

test("raw and Zod schemas agree on optional boolean display intent", () => {
	const raw = sendTool.rawJsonSchema;
	expect((raw?.properties as Record<string, unknown>).show_to_user).toMatchObject({
		type: "boolean",
	});
	expect(raw?.required as string[]).not.toContain("show_to_user");
	for (const value of ["false", "true", 0, 1, null])
		expect(sendTool.parameters.safeParse({ message: "Report", show_to_user: value }).success).toBe(
			false,
		);
	const description = (raw?.properties as Record<string, { description: string }>).show_to_user
		.description;
	// States WHEN to set it, in terms the sender can judge, and that it is display only.
	expect(description).toContain("Set true when");
	expect(description).toContain("a finding, a conclusion, a decision, a blocker");
	expect(description).toContain("expandable");
	expect(description).toContain("delivery, permissions");
	// The tool description itself names the flag, so it is seen without opening the schema.
	expect(sendTool.description).toContain("show_to_user: true");
	expect(sendTool.description).toContain("ContextAsk");
});
