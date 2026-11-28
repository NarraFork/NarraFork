import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { CommunicationScope, CommunicationTopology } from "@shared/narrator-communication";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageCallback } from "../lib/narrator-ws-manager";

const callbacks = new Set<MessageCallback>();
const sent: Record<string, unknown>[] = [];
const manager = {
	connected: true,
	connect: () => {},
	getCredentialIdentity: () => 1,
	getConnectionCredentialIdentity: () => 1,
	onCredentialChange: () => () => {},
	send: (frame: Record<string, unknown>) => {
		sent.push(frame);
		return true;
	},
	addListener: (_options: unknown, callback: MessageCallback) => {
		callbacks.add(callback);
		return { _id: 1 };
	},
	removeListener: () => {
		callbacks.clear();
	},
	onConnectionChange: () => () => {},
};
mock.module("../lib/narrator-ws-manager", () => ({ narratorWSManager: manager }));
const { useCommunicationTopology } = await import("./useCommunicationTopology");
let root: Root;
let current: ReturnType<typeof useCommunicationTopology>;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const host = document.getElementById("root");
	if (!host) throw new Error("Missing test root");
	root = createRoot(host);
	sent.length = 0;
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals)
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	originals.clear();
});
function Harness({ scope, enabled = true }: { scope: CommunicationScope; enabled?: boolean }) {
	current = useCommunicationTopology(scope, enabled);
	return <span>{current.status}</span>;
}
const sentSubscriptions = () => sent.filter((frame) => frame.type === "communication_subscribe");
test("hook shares stable semantic scope, scopes/disable/unmount release and retry resubscribes", async () => {
	await act(async () => root.render(<Harness scope={{ kind: "narrator", narratorId: "one" }} />));
	expect(sentSubscriptions()).toHaveLength(1);
	const firstId = sentSubscriptions()[0].subscriptionId;
	const topology: CommunicationTopology = {
		scope: { kind: "narrator", narratorId: "one" },
		nodes: [],
		peers: [],
		truncated: false,
	};
	await act(async () => {
		for (const callback of callbacks)
			callback({
				type: "communication_snapshot",
				subscriptionId: firstId,
				epoch: "one",
				seq: 0,
				topology,
			});
	});
	expect(current.status).toBe("live");
	expect(current.topology).toEqual(topology);
	await act(async () => root.render(<Harness scope={{ kind: "narrator", narratorId: "one" }} />));
	expect(sentSubscriptions()).toHaveLength(1);
	await act(async () => current.retry());
	expect(sentSubscriptions()).toHaveLength(2);
	await act(async () =>
		root.render(<Harness scope={{ kind: "team", projectId: "p", teamId: "t" }} />),
	);
	expect(current.topology).toBeNull();
	expect(sentSubscriptions().at(-1)?.scope).toEqual({ kind: "team", projectId: "p", teamId: "t" });
	await act(async () =>
		root.render(<Harness scope={{ kind: "team", projectId: "p", teamId: "t" }} enabled={false} />),
	);
	expect(current.status).toBe("disconnected");
	expect(callbacks.size).toBe(0);
});
