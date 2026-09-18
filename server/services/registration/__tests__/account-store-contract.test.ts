/**
 * The registration capability's contract, verified against real SQLite and against a
 * second, non-SQLite implementation of the same port.
 *
 * WHAT IS BEING PINNED
 * --------------------
 * "Validate the invitation → create the account → burn the invitation" is one indivisible
 * business fact. The tests below assert it as such:
 *
 *   - a usable invitation produces an account with the invitation's role, and the
 *     invitation ends up consumed BY THAT ACCOUNT;
 *   - an unusable one (unknown, revoked, spent, expired, bound elsewhere) is rejected with
 *     its specific error code and writes nothing;
 *   - a storage failure AFTER the account row is written rolls the whole thing back: no
 *     account, no preferences, and the invitation is still usable afterwards.
 *
 * The last one is the interesting case and the reason the atomic section exists. It is
 * provoked with a real UNIQUE violation on `user_preferences.user_id`, i.e. a failure that
 * happens between the account insert and the invitation claim — exactly where a
 * non-atomic implementation would leave a half-created account or a spent invitation.
 *
 * WHY TWO BACKENDS
 * ----------------
 * `RegistrationAccountStore` exists so a second database can implement the same capability
 * without inheriting SQLite's schema or its transaction shape. A contract asserted against
 * one implementation cannot show that. The in-memory backend here is not a mock of the
 * SQLite one and shares no storage code with it: it keeps invitations in a `Map` and reuses
 * only `assertInvitationRedeemable`, which is the point — the accept/reject rules and their
 * error identities are one definition, the storage is not.
 *
 * It is deliberately NOT a general fake user store: it implements exactly the three
 * operations of the port and nothing else, because inventing a repository layer to
 * illustrate a slice would be a worse outcome than the slice itself.
 *
 * ISOLATION: the SQLite backend runs on `tests/setup`'s in-memory database, mocked over
 * `server/db`. No real NarraFork database is touched.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { registrationCodes, userPreferences, users } from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import type {
	RegistrationAccountDraft,
	RegistrationAccountStore,
} from "../../registration/account-store";
import { hashInvitationCode } from "../../registration/code-hash";
import {
	assertInvitationRedeemable,
	type InvitationState,
} from "../../registration/invitation-rules";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ db, sqlite }));

const { registrationCodeService, hashRegistrationCode } = await import(
	"../../registration-code-service"
);
const { sqliteRegistrationAccountStore } = await import("../../registration/sqlite-account-store");
const { registrationAccountStore } = await import("../../registration/store");

const HOUR_MS = 60 * 60 * 1000;

interface IssueOptions {
	role?: "admin" | "user";
	boundUsername?: string;
	expiresInHours?: number;
	revoked?: boolean;
}

/** One backend under test, plus the inspection it needs to prove what happened. */
interface Backend {
	readonly name: string;
	readonly store: RegistrationAccountStore;
	reset(): Promise<void>;
	/** Issue an invitation and return its plaintext code. */
	issue(options?: IssueOptions): Promise<string>;
	/** Account id that consumed the invitation, or null while it is unused. */
	consumedBy(code: string): Promise<string | null>;
	/** Account ids that exist, so "wrote nothing" is checkable. */
	accountIds(): Promise<string[]>;
	/**
	 * Arrange for a `createAccount` using `userId` to fail *after* the account row would
	 * have been written — the window in which a non-atomic implementation leaves a
	 * half-created account and a spent invitation. Both backends do it by occupying the
	 * preferences slot, which is the second write of the operation.
	 */
	poisonPreferences(userId: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend 1: real SQLite, through the production store
// ─────────────────────────────────────────────────────────────────────────────

let adminId: string;

async function seedAdmin(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `contract-admin-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "admin",
		createdAt: new Date().toISOString(),
	});
	return id;
}

const sqliteBackend: Backend = {
	name: "sqlite",
	store: sqliteRegistrationAccountStore,
	async reset() {
		cleanDb(sqlite);
		adminId = await seedAdmin();
	},
	async issue(options = {}) {
		const { code, summary } = await registrationCodeService.createCode({
			createdByUserId: adminId,
			role: options.role,
			boundUsername: options.boundUsername,
			expiresInHours: options.expiresInHours,
		});
		if (options.revoked) await registrationCodeService.revokeCode(summary.id);
		return code;
	},
	async consumedBy(code) {
		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.codeHash, hashRegistrationCode(code)),
			columns: { usedByUserId: true },
		});
		return row?.usedByUserId ?? null;
	},
	async accountIds() {
		const rows = await db.select({ id: users.id }).from(users);
		return rows.map((r) => r.id).filter((id) => id !== adminId);
	},
	async poisonPreferences(userId) {
		// A real row on `user_preferences.user_id`, whose unique index the store's second
		// insert then violates. No stubbing: the failure is the database's own.
		await db.insert(userPreferences).values({
			id: generateId(),
			userId,
			language: "en",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// Backend 2: the same capability with no SQLite anywhere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A second implementation of the port, standing in for the future PostgreSQL adapter.
 *
 * It shares nothing with the SQLite store but `assertInvitationRedeemable`, and its
 * "atomicity" is structural: it computes the whole outcome before mutating anything, so a
 * rejection cannot leave a partial write. A networked adapter reaches the same guarantee
 * with a real async transaction — which is safe there and is not safe on `bun:sqlite`.
 */
function createInMemoryBackend(): Backend {
	interface Invitation extends InvitationState {
		usedByUserId: string | null;
	}
	const invitations = new Map<string, Invitation>();
	const accounts = new Map<string, { username: string; role: "admin" | "user" }>();
	const preferenceUserIds = new Set<string>();

	const store: RegistrationAccountStore = {
		async countAccounts() {
			return accounts.size;
		},
		async isUsernameTaken(username) {
			return [...accounts.values()].some((a) => a.username === username);
		},
		async createAccount(draft: RegistrationAccountDraft) {
			const code = draft.invitationCode;
			const invitation = code
				? assertInvitationRedeemable(invitations.get(code) ?? null, {
						username: draft.username,
						nowIso: draft.nowIso,
					})
				: null;
			// Everything above only reads. The writes below happen once nothing else can
			// fail, which is how this backend reaches all-or-nothing without a transaction.
			if (preferenceUserIds.has(draft.userId)) {
				throw new Error("preferences already exist for this account id");
			}
			const role = invitation?.role ?? draft.defaultRole;
			accounts.set(draft.userId, { username: draft.username, role });
			preferenceUserIds.add(draft.userId);
			if (code && invitation) {
				const state = invitations.get(code);
				if (state) {
					invitations.set(code, { ...state, usedAt: draft.nowIso, usedByUserId: draft.userId });
				}
			}
			return {
				account: {
					id: draft.userId,
					username: draft.username,
					role,
					avatarColor: draft.avatarColor,
					avatarImageId: null,
					createdAt: draft.nowIso,
				},
				redeemedCodeId: invitation?.id ?? null,
			};
		},
	};

	return {
		name: "in-memory (stand-in for a second dialect)",
		store,
		async reset() {
			invitations.clear();
			accounts.clear();
			preferenceUserIds.clear();
		},
		async issue(options = {}) {
			const code = `mem_${generateId(12)}`;
			invitations.set(code, {
				id: generateId(),
				role: options.role ?? "user",
				boundUsername: options.boundUsername ?? null,
				expiresAt: new Date(Date.now() + (options.expiresInHours ?? 24) * HOUR_MS).toISOString(),
				usedAt: null,
				usedByUserId: null,
				revokedAt: options.revoked ? new Date().toISOString() : null,
			});
			return code;
		},
		async consumedBy(code) {
			return invitations.get(code)?.usedByUserId ?? null;
		},
		async accountIds() {
			return [...accounts.keys()];
		},
		async poisonPreferences(userId) {
			preferenceUserIds.add(userId);
		},
	};
}

const inMemoryBackend = createInMemoryBackend();

function draftFor(overrides: Partial<RegistrationAccountDraft> = {}): RegistrationAccountDraft {
	return {
		userId: generateId(),
		username: "alice",
		passwordHash: "not-a-real-hash",
		avatarColor: "indigo",
		language: "en",
		defaultRole: "user",
		nowIso: new Date().toISOString(),
		...overrides,
	};
}

afterAll(() => {
	mock.module("../../../db", () => realDbModule);
	mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// The contract, run against both backends
// ─────────────────────────────────────────────────────────────────────────────

for (const backend of [sqliteBackend, inMemoryBackend]) {
	describe(`RegistrationAccountStore contract — ${backend.name}`, () => {
		beforeEach(async () => {
			await backend.reset();
		});

		test("a usable invitation creates the account with its role and is consumed by it", async () => {
			const code = await backend.issue({ role: "admin" });

			const result = await backend.store.createAccount(
				draftFor({ invitationCode: code, defaultRole: "user" }),
			);

			// The invitation, not `defaultRole`, decides the role.
			expect(result.account.role).toBe("admin");
			expect(result.redeemedCodeId).toBeTruthy();
			expect(await backend.consumedBy(code)).toBe(result.account.id);
			expect(await backend.accountIds()).toEqual([result.account.id]);
		});

		test("no invitation means the default role and no invitation is touched", async () => {
			const untouched = await backend.issue();

			const result = await backend.store.createAccount(draftFor({ defaultRole: "admin" }));

			expect(result.account.role).toBe("admin");
			expect(result.redeemedCodeId).toBeNull();
			expect(await backend.consumedBy(untouched)).toBeNull();
		});

		test("an unknown invitation is rejected and creates nothing", async () => {
			const draft = draftFor({ invitationCode: "definitely-not-issued" });

			await expect(backend.store.createAccount(draft)).rejects.toThrow("Invalid registration code");
			expect(await backend.accountIds()).toEqual([]);
		});

		test("a spent invitation cannot admit a second account", async () => {
			const code = await backend.issue();
			const first = await backend.store.createAccount(draftFor({ invitationCode: code }));

			await expect(
				backend.store.createAccount(draftFor({ username: "bob", invitationCode: code })),
			).rejects.toThrow("already been used");
			// The first account survives; the second was never created.
			expect(await backend.accountIds()).toEqual([first.account.id]);
			expect(await backend.consumedBy(code)).toBe(first.account.id);
		});

		test("a revoked invitation is rejected as revoked, not as expired or spent", async () => {
			const code = await backend.issue({ revoked: true });

			await expect(backend.store.createAccount(draftFor({ invitationCode: code }))).rejects.toThrow(
				"was revoked",
			);
			expect(await backend.accountIds()).toEqual([]);
		});

		test("an expired invitation is rejected and stays unconsumed", async () => {
			const code = await backend.issue({ expiresInHours: 1 });
			const twoHoursLater = new Date(Date.now() + 2 * HOUR_MS).toISOString();

			await expect(
				backend.store.createAccount(draftFor({ invitationCode: code, nowIso: twoHoursLater })),
			).rejects.toThrow("has expired");
			expect(await backend.consumedBy(code)).toBeNull();
			expect(await backend.accountIds()).toEqual([]);
		});

		test("an invitation bound to another username is rejected", async () => {
			const code = await backend.issue({ boundUsername: "alice" });

			await expect(
				backend.store.createAccount(draftFor({ username: "bob", invitationCode: code })),
			).rejects.toThrow("different username");
			expect(await backend.accountIds()).toEqual([]);

			// Still usable by the person it was issued for.
			const ok = await backend.store.createAccount(
				draftFor({ username: "alice", invitationCode: code }),
			);
			expect(await backend.consumedBy(code)).toBe(ok.account.id);
		});

		test("a failure after the account write leaves no account and an unspent invitation", async () => {
			// The case the atomic section exists for: the operation fails BETWEEN writing the
			// account and burning the invitation. A non-atomic implementation gets this wrong
			// in both directions — a stranded account, or a code spent on a signup that failed.
			const code = await backend.issue({ role: "admin" });
			const doomedId = generateId();
			await backend.poisonPreferences(doomedId);

			await expect(
				backend.store.createAccount(
					draftFor({ userId: doomedId, username: "alice", invitationCode: code }),
				),
			).rejects.toThrow();

			expect(await backend.accountIds()).toEqual([]);
			expect(await backend.consumedBy(code)).toBeNull();
			expect(await backend.store.isUsernameTaken("alice")).toBe(false);

			// And the invitation is genuinely still usable, not merely unmarked.
			const retry = await backend.store.createAccount(
				draftFor({ username: "alice", invitationCode: code }),
			);
			expect(retry.account.role).toBe("admin");
			expect(await backend.consumedBy(code)).toBe(retry.account.id);
		});

		test("counting and the username check see committed accounts only", async () => {
			// Relative to whatever the backend starts with: the SQLite one also holds the
			// administrator that issues the invitations.
			const before = await backend.store.countAccounts();
			expect(await backend.store.isUsernameTaken("alice")).toBe(false);

			await backend.store.createAccount(draftFor({ username: "alice" }));

			expect(await backend.store.countAccounts()).toBe(before + 1);
			expect(await backend.store.isUsernameTaken("alice")).toBe(true);
			expect(await backend.store.isUsernameTaken("bob")).toBe(false);
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback, where the failure is real
// ─────────────────────────────────────────────────────────────────────────────

describe("SQLite rollback, at the row level", () => {
	beforeEach(async () => {
		await sqliteBackend.reset();
	});

	test("the rolled-back attempt adds no preferences row and writes the invitation nothing", async () => {
		// The shared contract already asserts "no account, invitation unspent". What only the
		// SQLite backend can show is that the transaction left the TABLES untouched — the
		// account insert really did execute and really was undone, rather than never having
		// run because a check happened to reject earlier.
		const code = await sqliteBackend.issue();
		const doomedId = generateId();
		await sqliteBackend.poisonPreferences(doomedId);

		await expect(
			sqliteRegistrationAccountStore.createAccount(
				draftFor({ userId: doomedId, username: "alice", invitationCode: code }),
			),
		).rejects.toThrow();

		expect(await db.query.users.findFirst({ where: eq(users.username, "alice") })).toBeUndefined();
		// Only the row this test seeded remains, so the atomic section contributed none.
		const prefs = await db.select({ userId: userPreferences.userId }).from(userPreferences);
		expect(prefs).toEqual([{ userId: doomedId }]);
		const invitation = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.codeHash, hashRegistrationCode(code)),
			columns: { usedAt: true, usedByUserId: true, revokedAt: true },
		});
		expect(invitation).toEqual({ usedAt: null, usedByUserId: null, revokedAt: null });
	});

	test("a successful creation writes the account, its preferences and the claim together", async () => {
		const code = await sqliteBackend.issue({ role: "admin" });
		const nowIso = "2026-08-12T00:00:00.000Z";

		const { account } = await sqliteRegistrationAccountStore.createAccount(
			draftFor({ username: "alice", invitationCode: code, nowIso, language: "zh-CN" }),
		);

		const prefs = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, account.id),
			columns: { language: true },
		});
		expect(prefs?.language).toBe("zh-CN");
		const invitation = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.codeHash, hashRegistrationCode(code)),
			columns: { usedAt: true, usedByUserId: true },
		});
		// One timestamp for the whole operation: the account and its redemption agree.
		expect(invitation).toEqual({ usedAt: nowIso, usedByUserId: account.id });
		expect(account.createdAt).toBe(nowIso);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The port stays dialect-free
// ─────────────────────────────────────────────────────────────────────────────

describe("the port and its rules carry no storage dependency", () => {
	const SERVICE_DIR = join(import.meta.dir, "..");

	/** Import specifiers only — prose mentioning SQLite is documentation, not coupling. */
	function importSpecifiers(file: string): string[] {
		const source = readFileSync(join(SERVICE_DIR, file), "utf8");
		return [...source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map(
			(m) => m[1] ?? m[2],
		);
	}

	test("account-store.ts and invitation-rules.ts import nothing database-specific", () => {
		for (const file of ["account-store.ts", "invitation-rules.ts"]) {
			const specifiers = importSpecifiers(file);
			// Guard against a vacuous pass if the regex ever stops matching.
			expect(specifiers.length, `${file} should have imports to inspect`).toBeGreaterThan(0);
			for (const specifier of specifiers) {
				expect(specifier, `${file} imports ${specifier}`).not.toBe("bun:sqlite");
				expect(specifier, `${file} imports ${specifier}`).not.toStartWith("drizzle-orm");
				expect(specifier, `${file} imports ${specifier}`).not.toMatch(
					/(?:^|\/)db(?:\/|$)|db\/schema$/,
				);
			}
		}
	});

	test("the hashing rule carries no storage dependency either", () => {
		// `code-hash.ts` is shared by both stores, so it obeys the same rule as the port:
		// nothing dialect-shaped, no storage module, nothing that opens a database.
		const specifiers = importSpecifiers("code-hash.ts");
		expect(specifiers.length, "code-hash.ts should have imports to inspect").toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect(specifier, `code-hash.ts imports ${specifier}`).not.toBe("bun:sqlite");
			expect(specifier, `code-hash.ts imports ${specifier}`).not.toStartWith("drizzle-orm");
			expect(specifier, `code-hash.ts imports ${specifier}`).not.toMatch(
				/(?:^|\/)db(?:\/|$)|db\/schema$/,
			);
		}
	});

	test("the PostgreSQL store carries no SQLite dependency", () => {
		// The second implementation must not inherit the first engine: importing the SQLite
		// handle, the SQLite schema, the SQLite dialect modules, or the registration-code
		// service (which imports the SQLite handle at its top level) would make the "second
		// backend" a caller of the first. PG-side modules — postgres-schema, pg-retry,
		// pg-errors, the write-port — are what it MAY import, and the assertions below
		// require at least two of them so the check is not vacuous.
		const specifiers = importSpecifiers("postgres-account-store.ts");
		expect(specifiers.length, "postgres-account-store.ts should have imports").toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect(specifier, `imports ${specifier}`).not.toBe("bun:sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm/bun-sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm/sqlite-core");
			// The SQLite connection/schema modules, in either alias or relative form.
			expect(specifier, `imports ${specifier}`).not.toMatch(/^(?:@server\/db|(?:\.\.?\/)+db)$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/(?:^|\/)db\/schema$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/db\/connection$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/registration-code-service$/);
		}
		expect(specifiers).toContain("@server/db/postgres-schema");
		expect(specifiers).toContain("@server/db/pg-retry");
		expect(specifiers).toContain("@server/db/backend/write-port");
	});

	test("both backends hash an invitation code identically", () => {
		// The hashing rule is one algorithm in two modules (the SQLite service cannot be
		// re-pointed without touching the existing write path). The equivalence is pinned
		// here because a drift would split every issued code between the backends.
		for (const code of ["nfrc_abc123XYZ-_", "  nfrc_padded  ", "plain", generateId(24)]) {
			expect(hashInvitationCode(code)).toBe(hashRegistrationCode(code));
		}
		// The trimmed forms must collide: lookup and issuance agree on what "the code" is.
		expect(hashInvitationCode(" nfrc_x ")).toBe(hashInvitationCode("nfrc_x"));
	});

	test("the redemption rules are decidable from plain data alone", () => {
		// No store, no row, no connection: the same call the SQLite lookup and the in-memory
		// backend both delegate to. This is what a second dialect reuses.
		const base: InvitationState = {
			id: "inv-1",
			role: "admin",
			boundUsername: null,
			expiresAt: "2026-01-02T00:00:00.000Z",
			usedAt: null,
			revokedAt: null,
		};
		const NOW = "2026-01-01T00:00:00.000Z";
		const at = (nowIso: string) => ({ username: "alice", nowIso });

		expect(assertInvitationRedeemable(base, at(NOW))).toEqual({ id: "inv-1", role: "admin" });

		const codeOf = (state: InvitationState | null, nowIso: string): string => {
			try {
				assertInvitationRedeemable(state, at(nowIso));
				return "ACCEPTED";
			} catch (error) {
				return error instanceof AppError ? error.code : "UNKNOWN";
			}
		};

		expect(codeOf(null, NOW)).toBe("CODE_INVALID");
		expect(codeOf({ ...base, expiresAt: NOW }, NOW)).toBe("CODE_EXPIRED");
		expect(codeOf({ ...base, usedAt: NOW }, NOW)).toBe("CODE_ALREADY_USED");
		expect(codeOf({ ...base, boundUsername: "bob" }, NOW)).toBe("CODE_USERNAME_MISMATCH");

		// Precedence, not just presence: a revoked code that has ALSO expired must still be
		// reported as revoked, otherwise the explanation silently changes once the mandatory
		// expiry passes.
		expect(codeOf({ ...base, revokedAt: NOW, expiresAt: NOW }, "2026-03-01T00:00:00.000Z")).toBe(
			"CODE_REVOKED",
		);
	});

	test("registration is wired to the SQLite implementation by default", () => {
		// With no explicit `NF_WRITE_BACKEND`, the selector resolves to SQLite — the
		// fail-closed default. Reaching a second dialect stays a deliberate, visible
		// configuration plus an injected adapter; the selection rules themselves are
		// pinned in `store-wiring.test.ts`.
		expect(registrationAccountStore).toBe(sqliteRegistrationAccountStore);
	});
});
