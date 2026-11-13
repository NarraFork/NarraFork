/**
 * Step-up verification before credential export: password AND a second factor, and the
 * resulting grant works once, for one session and one purpose.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { userIdentities, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { LDAP_PROVIDER_ID } from "../../lib/ldap/protocol";
import { settings } from "../../lib/settings";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { mfaService } = await import("../mfa-service");
const { setLdapClientFactoryForTests } = await import("../ldap-auth-service");
const { consumeStepUp, resetStepUpForTests, STEP_UP_PURPOSES, stepUpMethods, verifyStepUp } =
	await import("../step-up-service");
const { stepUpSchema } = await import("../../lib/validators/auth");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const PASSWORD = "correct horse battery";
let userId: string;
let totpSecret: string;

const code = () => new TOTP({ secret: Secret.fromBase32(totpSecret) }).generate();
const base = () => ({
	userId,
	sessionId: "sess-1",
	sourceIp: "203.0.113.7",
	purpose: "credentials.export" as const,
	password: PASSWORD,
});

async function seedUser(withTotp: boolean): Promise<void> {
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: `step-${userId.slice(0, 6)}`,
		passwordHash: await Bun.password.hash(PASSWORD),
		role: "admin",
		createdAt: new Date().toISOString(),
	});
	if (!withTotp) return;
	const setup = await mfaService.beginSetup(userId);
	if (!("secret" in setup)) throw new Error("setup failed");
	totpSecret = setup.secret;
	const activated = await mfaService.activate(userId, code());
	if (!activated.ok) throw new Error("activation failed");
}

beforeEach(() => {
	cleanDb(sqlite);
	resetStepUpForTests();
});

describe("step-up verification", () => {
	test("an account without a second factor cannot step up", async () => {
		await seedUser(false);
		expect(await stepUpMethods(userId)).toEqual([]);
		await expect(verifyStepUp({ ...base(), method: "totp", code: "000000" })).rejects.toMatchObject(
			{
				code: "STEP_UP_MFA_REQUIRED",
			},
		);
	});

	test("needs both the password and the code", async () => {
		await seedUser(true);
		expect(await stepUpMethods(userId)).toEqual(["totp", "backup_code"]);
		await expect(
			verifyStepUp({ ...base(), password: "wrong", method: "totp", code: code() }),
		).rejects.toMatchObject({ code: "STEP_UP_FAILED" });
		await expect(verifyStepUp({ ...base(), method: "totp", code: "000000" })).rejects.toMatchObject(
			{ code: "STEP_UP_FAILED" },
		);
		const grant = await verifyStepUp({ ...base(), method: "totp", code: code() });
		expect(grant.token).toStartWith("nfsu_");
		expect(grant.expiresAt).toBeGreaterThan(Date.now());
	});

	test("a grant is single-use and bound to its user, session and purpose", async () => {
		await seedUser(true);
		const expected = { userId, sessionId: "sess-1", purpose: "credentials.export" as const };
		const { token } = await verifyStepUp({ ...base(), method: "totp", code: code() });
		expect(() => consumeStepUp(token, { ...expected, sessionId: "other" })).toThrow();
		expect(() => consumeStepUp(token, { ...expected, userId: "someone-else" })).toThrow();
		// A credential export grant does not unlock a data export with provider keys.
		expect(() =>
			consumeStepUp(token, { ...expected, purpose: "storage.export.providers" }),
		).toThrow();
		// A mismatched attempt does not burn the grant; the right one does.
		consumeStepUp(token, expected);
		expect(() => consumeStepUp(token, expected)).toThrow();
		expect(() => consumeStepUp(undefined, expected)).toThrow();
	});

	test("the route accepts exactly the purposes the service grants", () => {
		expect([...stepUpSchema.shape.purpose.options].sort()).toEqual([...STEP_UP_PURPOSES].sort());
	});

	test("an LDAP-only account steps up with its directory password", async () => {
		await seedUser(true);
		// Directory-only accounts carry a random, unguessable local hash: no local password
		// can ever match, so without the directory fallback this account could never export
		// its credentials.
		await db
			.update(users)
			.set({ passwordHash: await Bun.password.hash(randomBytes(32).toString("hex")) })
			.where(eq(users.id, userId));
		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			provider: LDAP_PROVIDER_ID,
			subject: "grace",
			createdAt: new Date().toISOString(),
		});
		settings.auth.ldap = {
			enabled: true,
			url: "ldaps://dc1.corp.example.com:636",
			searchBase: "dc=example,dc=com",
		};
		const calls: string[] = [];
		setLdapClientFactoryForTests(() => ({
			async authenticate(username, password) {
				calls.push(`${username}:${password}`);
				return password === "directory-password"
					? ({ kind: "ok", entry: { dn: "uid=grace", id: "grace" } } as const)
					: ({ kind: "invalid" } as const);
			},
			async probe() {
				return { stage: "ok", ok: true, message: "ok" };
			},
			async close() {},
		}));
		try {
			// A local password would not work; the directory's does.
			await expect(
				verifyStepUp({
					...base(),
					password: "not-the-directory-one",
					method: "totp",
					code: code(),
				}),
			).rejects.toMatchObject({ code: "STEP_UP_FAILED" });

			const grant = await verifyStepUp({
				...base(),
				password: "directory-password",
				method: "totp",
				code: code(),
			});
			expect(grant.token).toStartWith("nfsu_");
			expect(calls).toEqual(["grace:not-the-directory-one", "grace:directory-password"]);
		} finally {
			setLdapClientFactoryForTests(undefined);
			settings.auth.ldap = { enabled: false, url: "" };
		}
	});

	test("a local password never triggers a directory round trip", async () => {
		await seedUser(true);
		settings.auth.ldap = {
			enabled: true,
			url: "ldaps://dc1.corp.example.com:636",
			searchBase: "dc=example,dc=com",
		};
		const calls: string[] = [];
		setLdapClientFactoryForTests(() => ({
			async authenticate(username) {
				calls.push(username);
				return { kind: "invalid" } as const;
			},
			async probe() {
				return { stage: "ok", ok: true, message: "ok" };
			},
			async close() {},
		}));
		try {
			const grant = await verifyStepUp({ ...base(), method: "totp", code: code() });
			expect(grant.token).toStartWith("nfsu_");
			expect(calls).toEqual([]);
		} finally {
			setLdapClientFactoryForTests(undefined);
			settings.auth.ldap = { enabled: false, url: "" };
		}
	});
});
