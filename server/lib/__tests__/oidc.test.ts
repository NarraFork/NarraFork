import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generatePkce, randomToken } from "../oidc";

/** Recompute the expected S256 challenge for a verifier. */
function expectedChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

describe("oidc pkce", () => {
	test("generatePkce produces a verifier and matching S256 challenge", () => {
		const { verifier, challenge } = generatePkce();
		// base64url alphabet, no padding.
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		// The challenge must be the S256 hash of the verifier (RFC 7636).
		expect(challenge).toBe(expectedChallenge(verifier));
	});

	test("generatePkce is random per call", () => {
		const a = generatePkce();
		const b = generatePkce();
		expect(a.verifier).not.toBe(b.verifier);
		expect(a.challenge).not.toBe(b.challenge);
	});

	test("randomToken returns unique, URL-safe opaque tokens", () => {
		const a = randomToken();
		const b = randomToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(a.length).toBeGreaterThanOrEqual(24);
		expect(a).not.toBe(b);
	});
});
