import { describe, expect, test } from "bun:test";
import { installWebCryptoGlobals } from "../webcrypto-globals";

/**
 * These tests pin the contract that authentication depends on: after installation,
 * `instanceof CryptoKey` must be usable and must stay semantically correct.
 *
 * On Bun the globals already exist, so installation is a no-op and these assertions verify
 * it does not corrupt a conforming runtime. On Cottontail the same assertions verify the
 * recovered constructors behave like the real ones.
 */
describe("installWebCryptoGlobals", () => {
	test("leaves the runtime with usable WebCrypto interface objects", async () => {
		await installWebCryptoGlobals();
		const g = globalThis as { CryptoKey?: unknown; SubtleCrypto?: unknown };
		expect(g.CryptoKey).toBeDefined();
		expect(g.SubtleCrypto).toBeDefined();
	});

	test("makes instanceof CryptoKey work for a real key", async () => {
		await installWebCryptoGlobals();
		const key = await crypto.subtle.importKey(
			"raw",
			new Uint8Array(32),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		// This is the exact guard hono/jwt performs before signing.
		expect(key instanceof (globalThis as { CryptoKey: new () => unknown }).CryptoKey).toBe(true);
	});

	test("still rejects values that are not keys", async () => {
		await installWebCryptoGlobals();
		const CryptoKeyCtor = (globalThis as { CryptoKey: new () => unknown }).CryptoKey;
		// A stand-in class would wrongly accept or reject; the genuine constructor must not.
		const notKeys: unknown[] = [{}, "not-a-key", 42];
		for (const value of notKeys) {
			expect(value instanceof CryptoKeyCtor).toBe(false);
		}
	});

	test("is idempotent", async () => {
		await installWebCryptoGlobals();
		const first = (globalThis as { CryptoKey?: unknown }).CryptoKey;
		await installWebCryptoGlobals();
		expect((globalThis as { CryptoKey?: unknown }).CryptoKey).toBe(first);
	});

	test("supports a full HMAC sign round trip", async () => {
		await installWebCryptoGlobals();
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode("secret-key-material-0123456789ab"),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
		const data = new TextEncoder().encode("payload");
		const signature = await crypto.subtle.sign("HMAC", key, data);
		expect(new Uint8Array(signature).length).toBe(32);
		expect(await crypto.subtle.verify("HMAC", key, signature, data)).toBe(true);
	});
});

describe("hono/jwt integration", () => {
	// The regression that motivated the shim: signing threw
	// "Right hand side of instanceof is not an object" on Cottontail.
	test("signs and verifies a token", async () => {
		await installWebCryptoGlobals();
		const { sign, verify } = await import("hono/jwt");
		const token = await sign(
			{ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 600 },
			"test-secret",
		);
		expect(token.split(".")).toHaveLength(3);
		const payload = (await verify(token, "test-secret", "HS256")) as { sub?: string };
		expect(payload.sub).toBe("user-1");
	});
});
