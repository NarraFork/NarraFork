import { describe, expect, it } from "bun:test";
import {
	base64UrlDecode,
	base64UrlEncode,
	canonicalJson,
	isVNetClientMessage,
	isVNetUdpClientPacket,
	jsonByteLength,
} from "../../../server/lib/vnet/protocol";

describe("vnet protocol", () => {
	it("round-trips base64url bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
		const encoded = base64UrlEncode(bytes);
		expect(encoded).not.toContain("+");
		expect(encoded).not.toContain("/");
		expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
	});

	it("canonicalizes object keys recursively", () => {
		expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
	});

	it("validates relay client messages", () => {
		expect(
			isVNetClientMessage({
				type: "hello",
				networkId: "net",
				peerId: "a",
				virtualIp: "10.88.0.1",
			}),
		).toBe(true);
		expect(
			isVNetClientMessage({
				type: "relay_packet",
				toPeerId: "b",
				seq: 1,
				nonce: "nonce",
				ciphertext: "ciphertext",
			}),
		).toBe(true);
		expect(isVNetClientMessage({ type: "hello", peerId: "missing-network" })).toBe(false);
	});

	it("validates authenticated UDP packets", () => {
		expect(
			isVNetUdpClientPacket({
				type: "register",
				sessionId: "s",
				networkId: "n",
				peerId: "p",
				timestamp: Date.now(),
				nonce: "n",
				authTag: "tag",
			}),
		).toBe(true);
		expect(isVNetUdpClientPacket({ type: "register", sessionId: "s" })).toBe(false);
	});

	it("measures json byte length", () => {
		expect(jsonByteLength({ hello: "世界" })).toBeGreaterThan(
			JSON.stringify({ hello: "世界" }).length,
		);
	});
});
