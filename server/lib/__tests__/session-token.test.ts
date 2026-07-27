import { describe, expect, mock, test } from "bun:test";

/**
 * Session-token issuance and verification, exercised without the database.
 *
 * `server/lib/auth.ts` imports `../db` for the login/registration helpers, which
 * would run the whole migration stack. Only the JWT layer is under test here, so
 * the module is stubbed out.
 */
mock.module("../../db", () => ({ db: {} }));

const [
	{ createToken, isAuthenticSessionTokenIgnoringExpiry, renewToken, verifyToken },
	{ settings },
	{ SESSION_START_CLAIM, SESSION_TOKEN_TTL_SECONDS },
	{ sign },
] = await Promise.all([
	import("../auth"),
	import("../settings"),
	import("@shared/session-auth"),
	import("hono/jwt"),
]);

type Claims = Record<string, unknown>;

describe("createToken", () => {
	test("anchors a fresh login at the present and expires after the full TTL", async () => {
		const before = Math.floor(Date.now() / 1000);
		const payload = (await verifyToken(await createToken("user-1", "admin"))) as unknown as Claims;
		const anchor = payload[SESSION_START_CLAIM] as number;
		expect(anchor).toBeGreaterThanOrEqual(before);
		expect(payload.sub).toBe("user-1");
		expect(payload.role).toBe("admin");
		expect((payload.exp as number) - (payload.iat as number)).toBe(SESSION_TOKEN_TTL_SECONDS);
	});
});

describe("renewToken", () => {
	test("inherits the supplied session anchor instead of resetting it", async () => {
		const anchor = Math.floor(Date.now() / 1000) - 20 * 24 * 60 * 60;
		const payload = (await verifyToken(
			await renewToken("user-1", "user", anchor),
		)) as unknown as Claims;
		expect(payload[SESSION_START_CLAIM]).toBe(anchor);
		// The expiry still slides forward — only the anchor is frozen.
		expect(payload.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	test("signs the role it is given rather than any role from a previous token", async () => {
		const payload = (await verifyToken(
			await renewToken("user-1", "user", Math.floor(Date.now() / 1000)),
		)) as unknown as Claims;
		expect(payload.role).toBe("user");
	});
});

describe("verifyToken shape checks", () => {
	const now = () => Math.floor(Date.now() / 1000);

	test("rejects a correctly signed token with no exp", async () => {
		const token = await sign({ sub: "user-1", role: "user", iat: now() }, settings.auth.jwtSecret);
		// hono's verify skips an absent exp entirely, which would make this a
		// permanent credential that never enters renewal or the absolute ceiling.
		expect(verifyToken(token)).rejects.toThrow();
	});

	test("rejects a correctly signed token with a non-numeric exp", async () => {
		const token = await sign(
			{ sub: "user-1", role: "user", iat: now(), exp: "later" } as unknown as Claims,
			settings.auth.jwtSecret,
		);
		expect(verifyToken(token)).rejects.toThrow();
	});

	test("rejects a correctly signed token with a missing or blank sub", async () => {
		const noSub = await sign(
			{ role: "admin", iat: now(), exp: now() + 3600 },
			settings.auth.jwtSecret,
		);
		expect(verifyToken(noSub)).rejects.toThrow();

		const blankSub = await sign(
			{ sub: "   ", role: "admin", iat: now(), exp: now() + 3600 },
			settings.auth.jwtSecret,
		);
		expect(verifyToken(blankSub)).rejects.toThrow();
	});

	test("still rejects an intermediate MFA-stage token", async () => {
		const staged = await sign(
			{ sub: "user-1", role: "user", stage: "mfa", iat: now(), exp: now() + 300 },
			settings.auth.jwtSecret,
		);
		expect(verifyToken(staged)).rejects.toThrow();
	});
});

describe("isAuthenticSessionTokenIgnoringExpiry", () => {
	const now = () => Math.floor(Date.now() / 1000);

	test("accepts a token that only failed on exp", async () => {
		const expired = await sign(
			{
				sub: "user-1",
				role: "user",
				iat: now() - 7200,
				exp: now() - 3600,
				[SESSION_START_CLAIM]: now() - 7200,
			},
			settings.auth.jwtSecret,
		);
		expect(await isAuthenticSessionTokenIgnoringExpiry(expired)).toBe(true);
	});

	test("refuses a past-exp token signed with a foreign key", async () => {
		const forged = await sign(
			{ sub: "user-1", role: "admin", iat: now() - 7200, exp: now() - 3600 },
			"an-attacker-controlled-secret",
		);
		// This is what keeps a forgery from being reported as TOKEN_EXPIRED.
		expect(await isAuthenticSessionTokenIgnoringExpiry(forged)).toBe(false);
	});

	test("refuses garbage and OAuth access tokens", async () => {
		expect(await isAuthenticSessionTokenIgnoringExpiry("not-a-jwt")).toBe(false);
		expect(await isAuthenticSessionTokenIgnoringExpiry("nfat_abc123")).toBe(false);
	});

	test("refuses an unexpiring token even with a valid signature", async () => {
		const noExp = await sign({ sub: "user-1", role: "user", iat: now() }, settings.auth.jwtSecret);
		expect(await isAuthenticSessionTokenIgnoringExpiry(noExp)).toBe(false);
	});
});
