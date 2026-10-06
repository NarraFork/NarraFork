import { describe, expect, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from "../totp";

/** Recreate a valid current code for a secret, mirroring an authenticator app. */
function currentCode(secretBase32: string): string {
	return new TOTP({
		issuer: "NarraFork",
		label: "test",
		algorithm: "SHA1",
		digits: 6,
		period: 30,
		secret: Secret.fromBase32(secretBase32),
	}).generate();
}

describe("totp", () => {
	test("generateTotpSecret produces a non-trivial base32 secret", () => {
		const a = generateTotpSecret();
		const b = generateTotpSecret();
		expect(a).toMatch(/^[A-Z2-7]+$/); // base32 alphabet
		expect(a.length).toBeGreaterThanOrEqual(16);
		expect(a).not.toBe(b); // random
	});

	test("buildTotpUri returns a scannable otpauth URI", () => {
		const secret = generateTotpSecret();
		const uri = buildTotpUri(secret, "alice");
		expect(uri.startsWith("otpauth://totp/")).toBe(true);
		expect(uri).toContain("issuer=NarraFork");
		expect(uri).toContain("alice");
	});

	test("verifyTotpCode accepts a freshly generated code", () => {
		const secret = generateTotpSecret();
		expect(verifyTotpCode(secret, currentCode(secret))).toBe(true);
	});

	test("verifyTotpCode tolerates surrounding whitespace", () => {
		const secret = generateTotpSecret();
		const code = currentCode(secret);
		expect(verifyTotpCode(secret, ` ${code} `)).toBe(true);
	});

	test("verifyTotpCode rejects wrong / malformed codes", () => {
		const secret = generateTotpSecret();
		expect(verifyTotpCode(secret, "000000")).toBe(false);
		expect(verifyTotpCode(secret, "12345")).toBe(false); // too short
		expect(verifyTotpCode(secret, "abcdef")).toBe(false); // non-numeric
		expect(verifyTotpCode(secret, "")).toBe(false);
	});

	test("verifyTotpCode rejects a code from a different secret", () => {
		const secretA = generateTotpSecret();
		const secretB = generateTotpSecret();
		expect(verifyTotpCode(secretB, currentCode(secretA))).toBe(false);
	});
});
