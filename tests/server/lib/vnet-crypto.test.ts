import { describe, expect, it } from "bun:test";
import {
	decryptPacket,
	deriveNetworkId,
	derivePacketKey,
	encryptPacket,
	hmacSha256,
	verifyHmac,
} from "../../../server/lib/vnet/crypto";

const metadata = {
	fromPeerId: "a",
	toPeerId: "b",
	srcIp: "10.88.0.1",
	dstIp: "10.88.0.2",
	seq: 1,
};

describe("vnet crypto", () => {
	it("derives stable network ids without exposing the raw secret", async () => {
		const first = await deriveNetworkId("demo", "secret");
		const second = await deriveNetworkId("demo", "secret");
		const different = await deriveNetworkId("demo", "other-secret");

		expect(first).toBe(second);
		expect(first).not.toBe(different);
		expect(first).not.toContain("secret");
	});

	it("encrypts and decrypts packets with metadata-bound AAD", async () => {
		const key = await derivePacketKey("secret", "demo");
		const encrypted = await encryptPacket(key, metadata, "hello");
		const decrypted = await decryptPacket(key, metadata, encrypted.nonce, encrypted.ciphertext);

		expect(new TextDecoder().decode(decrypted)).toBe("hello");
		await expect(
			decryptPacket(key, { ...metadata, seq: 2 }, encrypted.nonce, encrypted.ciphertext),
		).rejects.toThrow();
	});

	it("fails to decrypt with another secret", async () => {
		const key = await derivePacketKey("secret", "demo");
		const wrongKey = await derivePacketKey("wrong", "demo");
		const encrypted = await encryptPacket(key, metadata, "hello");

		await expect(
			decryptPacket(wrongKey, metadata, encrypted.nonce, encrypted.ciphertext),
		).rejects.toThrow();
	});

	it("signs and verifies HMAC tags", async () => {
		const tag = await hmacSha256("udp-token", "payload");
		expect(await verifyHmac("udp-token", "payload", tag)).toBe(true);
		expect(await verifyHmac("udp-token", "tampered", tag)).toBe(false);
		expect(await verifyHmac("other-token", "payload", tag)).toBe(false);
	});
});
