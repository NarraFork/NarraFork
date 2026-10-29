import { describe, expect, test } from "bun:test";
import {
	generateIdentity,
	hex,
	instanceId,
	sha256Hex,
	sign,
	transcript,
	unhex,
	verify,
} from "../../shared/remote-access/identity";
import {
	assertDirectSdp,
	assertStunUrls,
	decodeFrame,
	encodeFrame,
	FRAME_DATA,
	FRAME_END,
	LIMITS,
	ReceiveWindow,
	SendCredit,
} from "../../shared/remote-access/protocol";
import vectors from "../../shared/remote-access/vectors.json";

describe("remote access cross-language protocol", () => {
	test("SEC1 identity, transcript and P1363 signature match golden vectors", async () => {
		expect(await instanceId(vectors.publicKey)).toBe(vectors.instanceId);
		expect(hex(transcript(vectors.label, vectors.fields))).toBe(vectors.transcriptHex);
		expect(await verify(vectors.publicKey, vectors.signature, vectors.label, vectors.fields)).toBe(
			true,
		);
		expect(await sha256Hex(vectors.hashInput)).toBe(vectors.hash);
		expect(await verify(vectors.publicKey, vectors.signature, "offer", vectors.fields)).toBe(false);
		expect(
			await verify(vectors.publicKey, vectors.signature, vectors.label, [
				...vectors.fields,
				"other",
			]),
		).toBe(false);
	});
	test("runtime keys are nonextractable, fresh, and signatures bind fields", async () => {
		const first = await generateIdentity();
		const second = await generateIdentity();
		expect(first.publicKey).not.toBe(second.publicKey);
		expect(first.privateKey.extractable).toBe(false);
		const signature = await sign(first.privateKey, "hello", ["session", "中文"]);
		expect(await verify(first.publicKey, signature, "hello", ["session", "中文"])).toBe(true);
		expect(await verify(second.publicKey, signature, "hello", ["session", "中文"])).toBe(false);
		expect(hex(transcript("a", ["bc"]))).not.toBe(hex(transcript("ab", ["c"])));
	});
	test("invalid key encodings/points and signatures fail closed", async () => {
		expect(() => unhex("Aa")).toThrow("INVALID_HEX");
		expect(() => unhex("0")).toThrow("INVALID_HEX");
		await expect(instanceId(`04${"00".repeat(64)}`)).rejects.toThrow();
		expect(await verify(vectors.publicKey, "00", vectors.label, vectors.fields)).toBe(false);
	});
	test("24-byte frame matches golden bytes", () => {
		const frame = { ...vectors.frame, payload: unhex(vectors.frame.payloadHex) };
		expect(hex(encodeFrame(frame))).toBe(vectors.frameHex);
		const decoded = decodeFrame(unhex(vectors.frameHex));
		expect(decoded.streamId).toBe(7);
		expect(hex(decoded.payload)).toBe(vectors.frame.payloadHex);
	});
	test("malformed frames and oversized data are rejected before allocation", () => {
		for (const offset of [0, 4, 5, 6, 16, 20]) {
			const bytes = unhex(vectors.frameHex);
			bytes[offset] ^= 0xff;
			expect(() => decodeFrame(bytes)).toThrow();
		}
		expect(() => encodeFrame({ kind: 1, streamId: 0, sequence: 0 })).toThrow();
		expect(() =>
			encodeFrame({ kind: FRAME_END, streamId: 1, sequence: 0, payload: new Uint8Array(1) }),
		).toThrow();
		expect(() =>
			encodeFrame({
				kind: FRAME_DATA,
				streamId: 1,
				sequence: 0,
				payload: new Uint8Array(LIMITS.frameBytes),
			}),
		).toThrow();
		expect(() => decodeFrame(new Uint8Array(23))).toThrow();
	});
	test("credit cannot be manufactured with duplicated acknowledgements", () => {
		const sender = new SendCredit();
		sender.consume(LIMITS.windowBytes);
		expect(sender.bytes).toBe(0);
		expect(() => sender.consume(1)).toThrow();
		sender.update(100);
		expect(() => sender.update(LIMITS.windowBytes)).toThrow();
		expect(() => sender.update(-1)).toThrow();
	});
	test("receive sequence and EOF reject replay and unconsumed window overflow", () => {
		const receiver = new ReceiveWindow();
		receiver.accept({ kind: 1, streamId: 1, sequence: 0, payload: new Uint8Array(10) });
		expect(() => receiver.accept({ kind: 1, streamId: 1, sequence: 0 })).toThrow();
		expect(() => receiver.consumed(11)).toThrow();
		receiver.consumed(10);
		receiver.accept({ kind: 2, streamId: 1, sequence: 1 });
		expect(() => receiver.accept({ kind: 1, streamId: 1, sequence: 2 })).toThrow();
	});
	test("no TURN URL, relayed SDP or unbounded candidate gathering", () => {
		assertStunUrls(["stun:stun.example:3478", "stuns:stun.example:5349"]);
		expect(() => assertStunUrls(["turn:relay.example"])).toThrow("TURN_FORBIDDEN");
		assertDirectSdp("v=0\r\na=candidate:1 1 udp 1 127.0.0.1 1234 typ host\r\n");
		expect(() => assertDirectSdp("a=candidate:1 1 udp 1 127.0.0.1 1234 typ relay\r\n")).toThrow(
			"RELAY_FORBIDDEN",
		);
		expect(() => assertDirectSdp("a=candidate:1 typ host\n".repeat(129))).toThrow();
	});
});
