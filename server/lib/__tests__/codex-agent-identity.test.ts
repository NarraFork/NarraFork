import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";
import {
	buildAgentAssertion,
	decryptEncryptedTaskId,
	isAgentTaskInvalidMessage,
	isAgentTaskInvalidResponse,
	parseAgentPrivateKey,
	validateAgentPrivateKey,
} from "../codex-agent-identity";

function generatePkcs8Base64(): { base64: string; privateKey: crypto.KeyObject } {
	const kp = crypto.generateKeyPairSync("ed25519");
	const der = kp.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
	return { base64: der.toString("base64"), privateKey: kp.privateKey };
}

/** Mirror libsodium's crypto_box_seal against a curve key derived from an Ed25519 seed. */
function sealToEd25519PublicKey(privateKey: crypto.KeyObject, message: string): string {
	const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }) as Buffer);
	const seed = pkcs8.subarray(pkcs8.length - 32);
	const digest = crypto.createHash("sha512").update(Buffer.from(seed)).digest();
	const curvePriv = new Uint8Array(digest.subarray(0, 32));
	curvePriv[0] &= 248;
	curvePriv[31] &= 127;
	curvePriv[31] |= 64;
	const curvePub = nacl.scalarMult.base(curvePriv);
	const eph = nacl.box.keyPair();
	const nonce = blake2b(new Uint8Array([...eph.publicKey, ...curvePub]), { dkLen: 24 });
	const boxed = nacl.box(new TextEncoder().encode(message), nonce, curvePub, eph.secretKey);
	return Buffer.from(new Uint8Array([...eph.publicKey, ...boxed])).toString("base64");
}

describe("codex agent identity private key", () => {
	test("parses a valid PKCS#8 Ed25519 key", () => {
		const { base64 } = generatePkcs8Base64();
		expect(validateAgentPrivateKey(base64)).toBeNull();
		const key = parseAgentPrivateKey(base64);
		expect(key.asymmetricKeyType).toBe("ed25519");
	});

	test("rejects invalid base64", () => {
		expect(validateAgentPrivateKey("not valid base64 !!!")).not.toBeNull();
	});

	test("rejects an empty key", () => {
		expect(validateAgentPrivateKey("")).not.toBeNull();
	});

	test("rejects a non-Ed25519 key", () => {
		const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
		const der = kp.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
		expect(validateAgentPrivateKey(der.toString("base64"))).not.toBeNull();
	});
});

describe("buildAgentAssertion", () => {
	test("produces a verifiable AgentAssertion header", () => {
		const { base64, privateKey } = generatePkcs8Base64();
		const key = parseAgentPrivateKey(base64);
		const now = new Date("2026-04-01T12:00:00.000Z");
		const header = buildAgentAssertion(
			{ runtimeId: "rt-1", taskId: "task-1", privateKey: key },
			now,
		);
		expect(header.startsWith("AgentAssertion ")).toBe(true);

		const envelope = JSON.parse(
			Buffer.from(header.slice("AgentAssertion ".length), "base64url").toString(),
		) as Record<string, string>;
		expect(envelope.agent_runtime_id).toBe("rt-1");
		expect(envelope.task_id).toBe("task-1");
		expect(envelope.timestamp).toBe("2026-04-01T12:00:00Z");

		const payload = new TextEncoder().encode(`rt-1:task-1:${envelope.timestamp}`);
		const verified = crypto.verify(
			null,
			Buffer.from(payload),
			privateKey,
			Buffer.from(envelope.signature, "base64"),
		);
		expect(verified).toBe(true);
	});

	test("throws when task id is missing", () => {
		const { base64 } = generatePkcs8Base64();
		const key = parseAgentPrivateKey(base64);
		expect(() => buildAgentAssertion({ runtimeId: "rt-1", privateKey: key })).toThrow();
	});
});

describe("decryptEncryptedTaskId", () => {
	test("decrypts a sealed task id round-trip", () => {
		const { base64, privateKey } = generatePkcs8Base64();
		const key = parseAgentPrivateKey(base64);
		const sealed = sealToEd25519PublicKey(privateKey, "task-xyz-789");
		expect(decryptEncryptedTaskId(key, sealed)).toBe("task-xyz-789");
	});

	test("throws on invalid ciphertext", () => {
		const { base64 } = generatePkcs8Base64();
		const key = parseAgentPrivateKey(base64);
		expect(() => decryptEncryptedTaskId(key, Buffer.from("short").toString("base64"))).toThrow();
	});
});

describe("isAgentTaskInvalidResponse", () => {
	test("detects invalid task id markers on 401", () => {
		expect(isAgentTaskInvalidResponse(401, '{"code":"invalid_task_id"}')).toBe(true);
		expect(isAgentTaskInvalidResponse(401, "the task expired")).toBe(true);
		expect(isAgentTaskInvalidResponse(401, "task not found")).toBe(true);
	});

	test("ignores non-401 or unrelated errors", () => {
		expect(isAgentTaskInvalidResponse(403, '{"code":"invalid_task_id"}')).toBe(false);
		expect(isAgentTaskInvalidResponse(401, "some other error")).toBe(false);
	});

	test("message variant requires a 401/unauthorized hint", () => {
		expect(isAgentTaskInvalidMessage("401 Unauthorized invalid task_id")).toBe(true);
		expect(isAgentTaskInvalidMessage("invalid task_id")).toBe(false);
	});
});
