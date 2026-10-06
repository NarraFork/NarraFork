/**
 * Cross-language fixed-vector tests for the nonce/HMAC device auth implementation.
 *
 * These vectors are derived with the same Python reference script used to
 * generate the Go constants in remote-executor/internal/rpc/auth_vectors_test.go.
 * Both test suites must agree exactly — a divergence means the two implementations
 * would fail to authenticate against each other.
 *
 * Reference computation:
 *   token = "rdev_fixed_test_token"
 *   K = SHA-256(token)  # 32 raw bytes, stored as 64-hex in the DB (tokenHash)
 *   eNonce = "AAAA..." (43 base64url chars = base64url(bytes{0x00 * 32}))
 *   sNonce = "BBBB..." (43 base64url chars = base64url(bytes{0x01 * 32}))
 *   devRef = "test-device-1"
 *   server_proof  = base64url(HMAC-SHA256(K, transcript("server")))
 *   executor_proof = base64url(HMAC-SHA256(K, transcript("executor")))
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	buildDeviceAuthTranscript,
	createDeviceAuthProof,
	DEVICE_AUTH_NONCE_BYTES,
	DEVICE_AUTH_VERSION,
	deviceAuthKeyFromTokenHash,
	generateDeviceAuthNonce,
	isValidDeviceAuthNonce,
	verifyDeviceAuthProof,
} from "../device-auth";

// ── shared fixture ────────────────────────────────────────────────────────────

const VECTOR_TOKEN = "rdev_fixed_test_token";
const VECTOR_DEVICE_REF = "test-device-1";
// 43 base64url chars for 32-byte nonces (deterministic for vector tests only).
const VECTOR_EXECUTOR_NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VECTOR_SERVER_NONCE = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
// These must match the Go constants in auth_vectors_test.go.
const VECTOR_SERVER_PROOF = "Kb7gEurAwLU5FHDkWxbxSEgJmN3nOT5e4jNqw8pUaVU";
const VECTOR_EXECUTOR_PROOF = "SsyJQo2AsTUJN6TVDJTIr1-95rjCAXwH5WRxnK3-jjQ";
// SHA-256("rdev_fixed_test_token") as 64-char hex (what the DB stores as tokenHash).
const VECTOR_K_HEX = "fc36aa7c5f038924644397b4f9fda11750f22b8f92eb5b043cc9f1834664a7b0";

function getKey(): Uint8Array {
	const k = deviceAuthKeyFromTokenHash(VECTOR_K_HEX);
	if (!k) throw new Error("bad test vector K_HEX");
	return k;
}

// ── key derivation ────────────────────────────────────────────────────────────

describe("device auth – key derivation", () => {
	test("K = SHA-256(plaintext token) matches DB hex", () => {
		// The DB stores tokenHash = SHA-256(plaintext) in hex.
		const computedHex = createHash("sha256").update(VECTOR_TOKEN, "utf8").digest("hex");
		expect(computedHex).toBe(VECTOR_K_HEX);
	});

	test("deviceAuthKeyFromTokenHash converts 64-char hex to 32-byte key", () => {
		const k = deviceAuthKeyFromTokenHash(VECTOR_K_HEX);
		if (!k) throw new Error("expected non-null key");
		expect(k.byteLength).toBe(32);
		expect(Buffer.from(k).toString("hex")).toBe(VECTOR_K_HEX);
	});

	test("deviceAuthKeyFromTokenHash rejects invalid hex strings", () => {
		expect(deviceAuthKeyFromTokenHash("")).toBeNull();
		expect(deviceAuthKeyFromTokenHash("zz")).toBeNull();
		// 63 chars (odd length)
		expect(deviceAuthKeyFromTokenHash(VECTOR_K_HEX.slice(1))).toBeNull();
		// 65 chars (too long)
		expect(deviceAuthKeyFromTokenHash(`${VECTOR_K_HEX}0`)).toBeNull();
	});
});

// ── transcript format ─────────────────────────────────────────────────────────

describe("device auth – transcript format", () => {
	test("includes domain prefix", () => {
		const t = buildDeviceAuthTranscript({
			authVersion: 1,
			deviceRef: VECTOR_DEVICE_REF,
			executorNonce: VECTOR_EXECUTOR_NONCE,
			serverNonce: VECTOR_SERVER_NONCE,
			role: "server",
		});
		expect(Buffer.from(t).toString("utf8")).toContain("narrafork-device-auth-v1\n");
	});

	test("includes length-prefixed deviceRef to prevent delimiter injection", () => {
		// "test-device-1" is 13 bytes UTF-8.
		const t = Buffer.from(
			buildDeviceAuthTranscript({
				authVersion: 1,
				deviceRef: VECTOR_DEVICE_REF,
				executorNonce: VECTOR_EXECUTOR_NONCE,
				serverNonce: VECTOR_SERVER_NONCE,
				role: "server",
			}),
		).toString("utf8");
		expect(t).toContain("deviceRef=13:test-device-1");
	});

	test("server and executor transcripts are different (role separation)", () => {
		const base = {
			authVersion: 1 as const,
			deviceRef: VECTOR_DEVICE_REF,
			executorNonce: VECTOR_EXECUTOR_NONCE,
			serverNonce: VECTOR_SERVER_NONCE,
		};
		const srv = Buffer.from(buildDeviceAuthTranscript({ ...base, role: "server" })).toString(
			"utf8",
		);
		const exe = Buffer.from(buildDeviceAuthTranscript({ ...base, role: "executor" })).toString(
			"utf8",
		);
		expect(srv).not.toBe(exe);
	});
});

// ── fixed cross-language vectors ──────────────────────────────────────────────

describe("device auth – fixed cross-language vectors", () => {
	const baseInput = {
		authVersion: DEVICE_AUTH_VERSION,
		deviceRef: VECTOR_DEVICE_REF,
		executorNonce: VECTOR_EXECUTOR_NONCE,
		serverNonce: VECTOR_SERVER_NONCE,
	} as const;

	test("server proof matches Go vector", () => {
		const key = getKey();
		const proof = createDeviceAuthProof(key, { ...baseInput, role: "server" });
		expect(proof).toBe(VECTOR_SERVER_PROOF);
	});

	test("executor proof matches Go vector", () => {
		const key = getKey();
		const proof = createDeviceAuthProof(key, { ...baseInput, role: "executor" });
		expect(proof).toBe(VECTOR_EXECUTOR_PROOF);
	});

	test("verifyDeviceAuthProof accepts matching proof", () => {
		const key = getKey();
		expect(verifyDeviceAuthProof(key, { ...baseInput, role: "server" }, VECTOR_SERVER_PROOF)).toBe(
			true,
		);
		expect(
			verifyDeviceAuthProof(key, { ...baseInput, role: "executor" }, VECTOR_EXECUTOR_PROOF),
		).toBe(true);
	});
});

// ── security properties ───────────────────────────────────────────────────────

describe("device auth – security properties", () => {
	const baseInput = {
		authVersion: DEVICE_AUTH_VERSION,
		deviceRef: VECTOR_DEVICE_REF,
		executorNonce: VECTOR_EXECUTOR_NONCE,
		serverNonce: VECTOR_SERVER_NONCE,
	} as const;

	test("constant-time: single-char tampered proof is rejected", () => {
		const key = getKey();
		// Flip first character.
		const orig = VECTOR_SERVER_PROOF;
		const tampered = (orig[0] === "A" ? "B" : "A") + orig.slice(1);
		expect(verifyDeviceAuthProof(key, { ...baseInput, role: "server" }, tampered)).toBe(false);
	});

	test("role separation: server proof rejected as executor proof", () => {
		const key = getKey();
		expect(
			verifyDeviceAuthProof(key, { ...baseInput, role: "executor" }, VECTOR_SERVER_PROOF),
		).toBe(false);
	});

	test("nonce binding: changed executorNonce invalidates proof", () => {
		const key = getKey();
		const otherNonce = generateDeviceAuthNonce();
		expect(
			verifyDeviceAuthProof(
				key,
				{ ...baseInput, role: "server", executorNonce: otherNonce },
				VECTOR_SERVER_PROOF,
			),
		).toBe(false);
	});

	test("nonce binding: changed serverNonce invalidates proof", () => {
		const key = getKey();
		const otherNonce = generateDeviceAuthNonce();
		expect(
			verifyDeviceAuthProof(
				key,
				{ ...baseInput, role: "server", serverNonce: otherNonce },
				VECTOR_SERVER_PROOF,
			),
		).toBe(false);
	});

	test("wrong key rejects proof", () => {
		const wrongKey = Buffer.alloc(32, 0xff); // all-ones key
		expect(
			verifyDeviceAuthProof(wrongKey, { ...baseInput, role: "server" }, VECTOR_SERVER_PROOF),
		).toBe(false);
	});

	test("createDeviceAuthProof throws on wrong key length", () => {
		for (const badLen of [0, 1, 16, 31, 33, 64]) {
			const badKey = Buffer.alloc(badLen);
			expect(() => createDeviceAuthProof(badKey, { ...baseInput, role: "server" })).toThrow();
		}
	});

	test("verifyDeviceAuthProof rejects non-string proof", () => {
		const key = getKey();
		for (const badProof of [null, undefined, 42, {}, [], ""]) {
			expect(verifyDeviceAuthProof(key, { ...baseInput, role: "server" }, badProof)).toBe(false);
		}
	});
});

// ── nonce generation ──────────────────────────────────────────────────────────

describe("device auth – nonce generation and validation", () => {
	test("generateDeviceAuthNonce produces a valid 43-char base64url string", () => {
		const n = generateDeviceAuthNonce();
		expect(typeof n).toBe("string");
		expect(n.length).toBe(43);
		expect(isValidDeviceAuthNonce(n)).toBe(true);
		// Verify it decodes to DEVICE_AUTH_NONCE_BYTES bytes.
		const decoded = Buffer.from(n, "base64url");
		expect(decoded.length).toBe(DEVICE_AUTH_NONCE_BYTES);
	});

	test("isValidDeviceAuthNonce rejects invalid inputs", () => {
		expect(isValidDeviceAuthNonce(undefined)).toBe(false);
		expect(isValidDeviceAuthNonce(null)).toBe(false);
		expect(isValidDeviceAuthNonce("")).toBe(false);
		expect(isValidDeviceAuthNonce("A".repeat(42))).toBe(false); // too short
		expect(isValidDeviceAuthNonce("A".repeat(44))).toBe(false); // too long
		expect(isValidDeviceAuthNonce(`${"A".repeat(42)}=`)).toBe(false); // padding
		expect(isValidDeviceAuthNonce(42)).toBe(false); // not a string
	});

	test("generateDeviceAuthNonce produces distinct values (randomness)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const n = generateDeviceAuthNonce();
			expect(seen.has(n)).toBe(false);
			seen.add(n);
		}
	});
});
