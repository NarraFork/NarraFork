/**
 * Step-up verification before credential export: password AND a second factor, and the
 * resulting grant works once, for one session and one purpose.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { users } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { mfaService } = await import("../mfa-service");
const { consumeStepUp, resetStepUpForTests, stepUpMethods, verifyStepUp } = await import(
	"../step-up-service"
);

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
		// A mismatched attempt does not burn the grant; the right one does.
		consumeStepUp(token, expected);
		expect(() => consumeStepUp(token, expected)).toThrow();
		expect(() => consumeStepUp(undefined, expected)).toThrow();
	});
});
