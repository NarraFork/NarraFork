/**
 * Registration-code invariants: the plaintext never reaches storage or list
 * output, and a code can be redeemed exactly once.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { registrationCodes, userPreferences, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { registrationCodeService, hashRegistrationCode } = await import(
	"../registration-code-service"
);

const NOW = "2026-08-12T00:00:00.000Z";

let adminId: string;

async function seedAdmin(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `code-admin-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "admin",
		createdAt: NOW,
	});
	return id;
}

/** Create the account row a redemption would insert, so the FK can be satisfied. */
async function seedRedeemer(username: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	await db.insert(userPreferences).values({
		id: generateId(),
		userId: id,
		language: "en",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** Redeem exactly as `registerUser` does: resolve, then claim, in one transaction. */
function redeem(code: string, username: string, userId: string, nowIso = new Date().toISOString()) {
	return db.transaction((tx) => {
		const usable = registrationCodeService.resolveUsableCodeInTransaction(tx, {
			code,
			username,
			nowIso,
		});
		registrationCodeService.claimCodeInTransaction(tx, {
			codeId: usable.id,
			userId,
			nowIso,
		});
		return usable;
	});
}

beforeEach(async () => {
	cleanDb(sqlite);
	adminId = await seedAdmin();
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("code storage", () => {
	test("only the hash is persisted, never the plaintext", async () => {
		const { code, summary } = await registrationCodeService.createCode({
			createdByUserId: adminId,
			note: "for alice",
		});

		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, summary.id),
		});
		expect(row?.codeHash).toBe(hashRegistrationCode(code));
		expect(row?.codeHash).not.toContain(code);
		// The whole row, serialized, must not leak the plaintext anywhere.
		expect(JSON.stringify(row)).not.toContain(code);
	});

	test("list output exposes neither the plaintext nor the hash", async () => {
		const { code } = await registrationCodeService.createCode({ createdByUserId: adminId });
		const codes = await registrationCodeService.listCodes();
		const serialized = JSON.stringify(codes);
		expect(serialized).not.toContain(code);
		expect(serialized).not.toContain(hashRegistrationCode(code));
		expect(codes[0]).not.toHaveProperty("codeHash");
	});

	test("the summary reports the issuing administrator and an active status", async () => {
		const { summary } = await registrationCodeService.createCode({ createdByUserId: adminId });
		expect(summary.status).toBe("active");
		expect(summary.createdByUsername).toContain("code-admin-");
		expect(summary.usedByUsername).toBeNull();
	});
});

describe("redemption", () => {
	test("a valid code grants its role and is marked used", async () => {
		const { code, summary } = await registrationCodeService.createCode({
			createdByUserId: adminId,
			role: "admin",
		});
		const redeemerId = await seedRedeemer("alice");

		const result = redeem(code, "alice", redeemerId);
		expect(result.role).toBe("admin");

		const codes = await registrationCodeService.listCodes();
		const row = codes.find((c) => c.id === summary.id);
		expect(row?.status).toBe("used");
		expect(row?.usedByUsername).toBe("alice");
	});

	test("a code cannot be redeemed twice", async () => {
		const { code } = await registrationCodeService.createCode({ createdByUserId: adminId });
		const firstId = await seedRedeemer("alice");
		redeem(code, "alice", firstId);

		const secondId = await seedRedeemer("bob");
		expect(() => redeem(code, "bob", secondId)).toThrow("already been used");
	});

	test("an unknown code is rejected", async () => {
		const redeemerId = await seedRedeemer("alice");
		expect(() => redeem("nfrc_not-a-real-code", "alice", redeemerId)).toThrow(
			"Invalid registration code",
		);
	});

	test("an expired code is rejected", async () => {
		const { code } = await registrationCodeService.createCode({
			createdByUserId: adminId,
			expiresInHours: 1,
		});
		const redeemerId = await seedRedeemer("alice");
		const twoHoursLater = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
		expect(() => redeem(code, "alice", redeemerId, twoHoursLater)).toThrow("has expired");
	});

	test("a revoked code is rejected", async () => {
		const { code, summary } = await registrationCodeService.createCode({
			createdByUserId: adminId,
		});
		await registrationCodeService.revokeCode(summary.id);
		const redeemerId = await seedRedeemer("alice");
		expect(() => redeem(code, "alice", redeemerId)).toThrow("was revoked");
	});

	test("a bound code only works for its username", async () => {
		const { code } = await registrationCodeService.createCode({
			createdByUserId: adminId,
			boundUsername: "alice",
		});
		const bobId = await seedRedeemer("bob");
		expect(() => redeem(code, "bob", bobId)).toThrow("different username");

		const aliceId = await seedRedeemer("alice");
		expect(redeem(code, "alice", aliceId).role).toBe("user");
	});
});

describe("the redemption rules are shared, not re-derived here", () => {
	test("the SQLite lookup answers exactly as the dialect-free rules do", async () => {
		// `resolveUsableCodeInTransaction` must be a LOOKUP plus the shared decision. If it
		// grows its own copy of the precedence (revoked before used before expired), a second
		// backend reusing `assertInvitationRedeemable` would start disagreeing with this one
		// while both still "work" — the kind of divergence no single-backend test would show.
		const { assertInvitationRedeemable } = await import("../registration/invitation-rules");
		const { code, summary } = await registrationCodeService.createCode({
			createdByUserId: adminId,
			role: "admin",
			expiresInHours: 1,
		});
		await registrationCodeService.revokeCode(summary.id);
		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, summary.id),
		});
		if (!row) throw new Error("the issued code should exist");

		const twoHoursLater = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
		const params = { username: "alice", nowIso: twoHoursLater };
		// Revoked AND expired at once: both paths must name the revocation.
		const direct = (() => {
			try {
				return assertInvitationRedeemable(row, params);
			} catch (error) {
				return error instanceof AppError ? error.code : "UNKNOWN";
			}
		})();
		const viaLookup = (() => {
			try {
				return db.transaction((tx) =>
					registrationCodeService.resolveUsableCodeInTransaction(tx, { code, ...params }),
				);
			} catch (error) {
				return error instanceof AppError ? error.code : "UNKNOWN";
			}
		})();

		expect(direct).toBe("CODE_REVOKED");
		expect(viaLookup).toBe(direct);
	});

	test("a usable code resolves to the same accepted shape through both paths", async () => {
		const { assertInvitationRedeemable } = await import("../registration/invitation-rules");
		const { code, summary } = await registrationCodeService.createCode({
			createdByUserId: adminId,
			role: "admin",
		});
		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, summary.id),
		});
		if (!row) throw new Error("the issued code should exist");

		const params = { username: "alice", nowIso: new Date().toISOString() };
		const viaLookup = db.transaction((tx) =>
			registrationCodeService.resolveUsableCodeInTransaction(tx, { code, ...params }),
		);
		expect(viaLookup).toEqual(assertInvitationRedeemable(row, params));
		expect(viaLookup).toEqual({ id: summary.id, role: "admin" });
	});
});

describe("management", () => {
	test("revoking marks the code revoked", async () => {
		const { summary } = await registrationCodeService.createCode({ createdByUserId: adminId });
		const revoked = await registrationCodeService.revokeCode(summary.id);
		expect(revoked.status).toBe("revoked");
	});

	test("a used code cannot be revoked", async () => {
		const { code, summary } = await registrationCodeService.createCode({
			createdByUserId: adminId,
		});
		const redeemerId = await seedRedeemer("alice");
		redeem(code, "alice", redeemerId);
		expect(registrationCodeService.revokeCode(summary.id)).rejects.toThrow("already been used");
	});

	test("deleting removes the row", async () => {
		const { summary } = await registrationCodeService.createCode({ createdByUserId: adminId });
		await registrationCodeService.deleteCode(summary.id);
		expect(await registrationCodeService.listCodes()).toHaveLength(0);
		expect(registrationCodeService.deleteCode(summary.id)).rejects.toThrow("not found");
	});
});
