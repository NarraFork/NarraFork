import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
	createPluginSignaturePayload,
	PluginTrustKeyring,
	verifyPluginSignature,
} from "../plugin-signature";

describe("plugin signatures", () => {
	test("verifies trusted Ed25519 signature bound to digest", () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const input = {
			algorithm: "ed25519" as const,
			keyId: "org-key",
			pluginId: "com.example.test",
			version: "1.0.0",
			packageDigest: "abc",
			files: [],
		};
		const signature = sign(null, createPluginSignaturePayload(input), privateKey).toString(
			"base64",
		);
		const result = verifyPluginSignature(
			{ ...input, signature },
			new PluginTrustKeyring([{ keyId: "org-key", publicKey }]),
		);
		expect(result.valid).toBe(true);
		expect(result.trusted).toBe(true);
	});
});
