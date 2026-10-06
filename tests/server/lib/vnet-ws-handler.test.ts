import { afterEach, describe, expect, test } from "bun:test";
import { settings } from "../../../server/lib/settings";
import { wsHandlers } from "../../../server/websocket/ws-handler";

const originalVNet = settings.vnet
	? { ...settings.vnet, udp: { ...settings.vnet.udp } }
	: undefined;

afterEach(() => {
	settings.vnet = originalVNet ? { ...originalVNet, udp: { ...originalVNet.udp } } : undefined;
});

describe("VNet WebSocket handler", () => {
	test("rejects oversized payloads before JSON parsing", () => {
		settings.vnet = {
			enabled: true,
			allowAnonymousRelay: false,
			maxPeersPerNetwork: 64,
			maxMessageBytes: 8,
			udp: { enabled: false, host: "0.0.0.0", port: 0 },
		};
		const sent: unknown[] = [];
		let closeCode: number | undefined;
		const ws = {
			data: {
				channel: "vnet",
				connectedAt: Date.now(),
				lastPongAt: Date.now(),
				auth: { kind: "relay-token" },
			},
			send(data: string) {
				sent.push(JSON.parse(data));
			},
			close(code: number) {
				closeCode = code;
			},
		} as Parameters<typeof wsHandlers.message>[0];

		wsHandlers.message(
			ws,
			'{"type":"hello","networkId":"net","peerId":"a","virtualIp":"10.88.0.1"}',
		);

		expect((sent[0] as { code?: string }).code).toBe("MESSAGE_TOO_LARGE");
		expect(closeCode).toBe(1009);
	});
});
