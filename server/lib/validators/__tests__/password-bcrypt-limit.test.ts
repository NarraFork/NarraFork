import { describe, expect, test } from "bun:test";
import { adminCreateUserSchema, adminUpdateUserSchema, loginSchema, registerSchema } from "../auth";

/**
 * bcrypt hashes only the first 72 bytes of its input.
 *
 * Beyond that, extra characters look like they strengthen the password but change
 * nothing: two passwords differing only after byte 72 hash identically. The schema
 * therefore rejects over-long passwords where one is CHOSEN, and deliberately does
 * NOT at login — an account created before this limit may hold a longer password, and
 * bcrypt will truncate and match it exactly as it did when the hash was written.
 */

const BYTES = 72;
const ascii = (n: number) => "a".repeat(n);
/** 3 bytes per character under UTF-8. */
const cjk = (chars: number) => "密".repeat(chars);

describe("password byte limit on the paths that SET a password", () => {
	const setters = [
		["register", (password: string) => registerSchema.safeParse({ username: "alice", password })],
		[
			"adminCreateUser",
			(password: string) => adminCreateUserSchema.safeParse({ username: "alice", password }),
		],
		["adminUpdateUser", (password: string) => adminUpdateUserSchema.safeParse({ password })],
	] as const;

	for (const [name, parse] of setters) {
		test(`${name} accepts exactly ${BYTES} bytes`, () => {
			expect(parse(ascii(BYTES)).success).toBe(true);
		});

		test(`${name} rejects one byte past the limit`, () => {
			expect(parse(ascii(BYTES + 1)).success).toBe(false);
		});

		test(`${name} counts bytes, not characters, for non-ASCII`, () => {
			// 24 CJK characters = 72 bytes (fits); 25 = 75 bytes (does not).
			expect(parse(cjk(24)).success).toBe(true);
			expect(parse(cjk(25)).success).toBe(false);
		});
	}

	test("the short-password floor still applies", () => {
		expect(registerSchema.safeParse({ username: "alice", password: "short" }).success).toBe(false);
	});
});

describe("login is intentionally NOT byte-capped", () => {
	test("a pre-existing over-long password can still be submitted", () => {
		// Refusing it here would lock out an account whose hash bcrypt can still match.
		expect(loginSchema.safeParse({ username: "alice", password: ascii(120) }).success).toBe(true);
	});
});
