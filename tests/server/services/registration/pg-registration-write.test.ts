/**
 * The PostgreSQL registration write path, verified against a real PostgreSQL 17.
 *
 * The SQLite half of this capability is pinned by
 * `server/services/registration/__tests__/account-store-contract.test.ts` and
 * `server/lib/__tests__/register-with-code.test.ts`. This suite runs the SAME business
 * facts against the PostgreSQL adapter over a real network connection to a throwaway
 * container that has had every `drizzle-postgres` migration applied verbatim:
 *
 *   - the redemption contract: usable/spent/revoked/expired/bound codes produce the
 *     same AppError codes and statuses as the SQLite backend;
 *   - ATOMICITY: a failure after the account insert (a real unique violation on the
 *     preferences write) leaves no account, no preferences row and an unspent code;
 *   - CONCURRENCY, where the backends genuinely differ: two registrations of one
 *     username → one succeeds, one hears `USERNAME_TAKEN` (409) — via the unique
 *     constraint and 23505 classification, never a 500; many registrations with one
 *     invitation code → exactly one burns it, every loser hears `CODE_ALREADY_USED`
 *     (409). The claim is a guarded UPDATE, so the loser is decided by the row lock,
 *     not by a SELECT-then-write race.
 *   - the full `registerUser` path against the injected PG store, so the wiring in
 *     `lib/auth.ts` (conflict → re-read → 409) is proven on the real backend too.
 *
 * Rules, same as the read-parity suite:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run. A blocked harness is a
 *     failure in that mode, never a quiet pass;
 *   - migrations are applied EXACTLY as committed;
 *   - the container is the harness' own random name and only it is cleaned up.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { WriteConflictError } from "../../../../server/db/backend/write-port";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { AppError } from "../../../../server/lib/errors";
import { generateId } from "../../../../server/lib/id";
import type { RegistrationAccountDraft } from "../../../../server/services/registration/account-store";
import { hashInvitationCode } from "../../../../server/services/registration/code-hash";
import { createPostgresRegistrationAccountStore } from "../../../../server/services/registration/postgres-account-store";
import { withPostgres } from "../../../db/pg-test-harness";
import { cleanDb, getTestDb } from "../../../setup";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;
const HOUR_MS = 60 * 60 * 1000;

// `registerUser` pulls in `server/lib/auth.ts`, which imports the SQLite handle at module
// level. It is mocked over the isolated in-memory database exactly as the SQLite
// registration suites do — the PostgreSQL path under test never touches it, and the mock
// guarantees that by making any accidental SQLite write land in a scratch database.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db: sqliteDb, sqlite }));

const { registerUser } = await import("../../../../server/lib/auth");
const { setRegistrationAccountStore } = await import(
	"../../../../server/services/registration/store"
);
const { settings } = await import("../../../../server/lib/settings");

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

type PgStore = ReturnType<typeof createPostgresRegistrationAccountStore>;

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

/** Assertion helpers that produce text diffs inside the harness callback. */
function expectAppError(error: unknown, statusCode: number, code: string): void {
	expect(error).toBeInstanceOf(AppError);
	expect((error as AppError).statusCode).toBe(statusCode);
	expect((error as AppError).code).toBe(code);
}

describe("PostgreSQL registration write path", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"satisfies the registration contract, the race semantics and rollback on a real server",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, credentials }) => {
				expect(port).toBeGreaterThan(0);
				for (const statement of sqls) {
					const applied = await exec(statement);
					if (applied.code !== 0) {
						return {
							migrationError: applied.stderr
								.split("\n")
								.filter((line) => !line.startsWith("NOTICE:"))
								.join("\n")
								.slice(0, 400),
						};
					}
				}

				const client = createPostgresClient({
					driver: "bun-sql",
					url: `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
						credentials.password,
					)}@127.0.0.1:${port}/${credentials.database}`,
					// A real pool: the concurrency cases need two transactions genuinely in
					// flight at once, which a single-connection handle cannot produce.
					max: 8,
					connectTimeout: 10,
				});
				const pgDb: BunSQLDatabase = client.db;
				const store: PgStore = createPostgresRegistrationAccountStore(pgDb);
				const problems: string[] = [];
				const landmarks: Record<string, unknown> = {};

				const adminId = generateId();
				const deleteAccounts = async (): Promise<void> => {
					// Per-case isolation inside the shared container: remove everything the
					// cases created (the seeded admin stays so `countAccounts` never reads 0
					// except where a case arranges it). Codes go first: they hold foreign
					// keys to users on both sides.
					await pgDb.delete(pgSchema.registrationCodes);
					await pgDb.delete(pgSchema.userPreferences);
					await pgDb.delete(pgSchema.users);
					await pgDb.insert(pgSchema.users).values({
						id: adminId,
						username: `pg-admin-${adminId.slice(0, 6)}`,
						passwordHash: "x",
						role: "admin",
						createdAt: new Date().toISOString(),
					});
				};

				/** Run one case on a fresh dataset; record failures as text, never throw past the harness. */
				const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
					try {
						await deleteAccounts();
						await fn();
					} catch (error) {
						problems.push(
							`${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`.slice(
								0,
								600,
							),
						);
					}
				};
				const issueCode = async (
					options: {
						role?: "admin" | "user";
						boundUsername?: string;
						expiresInHours?: number;
						revoked?: boolean;
					} = {},
				): Promise<string> => {
					const code = `nfrc_${generateId(24)}`;
					await pgDb.insert(pgSchema.registrationCodes).values({
						id: generateId(),
						codeHash: hashInvitationCode(code),
						role: options.role ?? "user",
						boundUsername: options.boundUsername ?? null,
						expiresAt: new Date(
							Date.now() + (options.expiresInHours ?? 24) * HOUR_MS,
						).toISOString(),
						createdByUserId: adminId,
						revokedAt: options.revoked ? new Date().toISOString() : null,
						createdAt: new Date().toISOString(),
					});
					return code;
				};
				const consumedBy = async (code: string): Promise<string | null> => {
					const rows = await pgDb
						.select({ usedByUserId: pgSchema.registrationCodes.usedByUserId })
						.from(pgSchema.registrationCodes)
						.where(eq(pgSchema.registrationCodes.codeHash, hashInvitationCode(code)))
						.limit(1);
					return rows[0]?.usedByUserId ?? null;
				};
				const accountIds = async (): Promise<string[]> => {
					const rows = await pgDb.select({ id: pgSchema.users.id }).from(pgSchema.users);
					return rows.map((row) => row.id).filter((id) => id !== adminId);
				};

				try {
					// ── The redemption contract ────────────────────────────────────────

					await check(
						"usable invitation creates the account with its role and is consumed",
						async () => {
							const code = await issueCode({ role: "admin" });
							const result = await store.createAccount(
								draftFor({ invitationCode: code, defaultRole: "user" }),
							);
							expect(result.account.role).toBe("admin");
							expect(result.redeemedCodeId).toBeTruthy();
							expect(await consumedBy(code)).toBe(result.account.id);
							expect(await accountIds()).toEqual([result.account.id]);
						},
					);

					await check(
						"no invitation means the default role and no invitation is touched",
						async () => {
							const untouched = await issueCode();
							const result = await store.createAccount(
								draftFor({ username: "carol", defaultRole: "user" }),
							);
							expect(result.account.role).toBe("user");
							expect(result.redeemedCodeId).toBeNull();
							expect(await consumedBy(untouched)).toBeNull();
						},
					);

					await check(
						"an unknown invitation is CODE_INVALID (400) and creates nothing",
						async () => {
							const before = await accountIds();
							const error = await store
								.createAccount(draftFor({ username: "dave", invitationCode: "nfrc_not-issued" }))
								.catch((e: unknown) => e);
							expectAppError(error, 400, "CODE_INVALID");
							expect(await accountIds()).toEqual(before);
						},
					);

					await check("a spent invitation cannot admit a second account", async () => {
						const code = await issueCode();
						const first = await store.createAccount(
							draftFor({ username: "erin", invitationCode: code }),
						);
						const error = await store
							.createAccount(draftFor({ username: "frank", invitationCode: code }))
							.catch((e: unknown) => e);
						expectAppError(error, 409, "CODE_ALREADY_USED");
						expect(await consumedBy(code)).toBe(first.account.id);
						expect(await store.isUsernameTaken("frank")).toBe(false);
					});

					await check("a revoked invitation is CODE_REVOKED (400)", async () => {
						const code = await issueCode({ revoked: true });
						const error = await store
							.createAccount(draftFor({ username: "grace", invitationCode: code }))
							.catch((e: unknown) => e);
						expectAppError(error, 400, "CODE_REVOKED");
					});

					await check(
						"an expired invitation is CODE_EXPIRED (400) and stays unconsumed",
						async () => {
							const code = await issueCode({ expiresInHours: 1 });
							const later = new Date(Date.now() + 2 * HOUR_MS).toISOString();
							const error = await store
								.createAccount(draftFor({ username: "heidi", invitationCode: code, nowIso: later }))
								.catch((e: unknown) => e);
							expectAppError(error, 400, "CODE_EXPIRED");
							expect(await consumedBy(code)).toBeNull();
						},
					);

					await check(
						"a bound invitation rejects another username, then admits the bound one",
						async () => {
							const code = await issueCode({ boundUsername: "ivan" });
							const error = await store
								.createAccount(draftFor({ username: "judy", invitationCode: code }))
								.catch((e: unknown) => e);
							expectAppError(error, 400, "CODE_USERNAME_MISMATCH");
							const ok = await store.createAccount(
								draftFor({ username: "ivan", invitationCode: code }),
							);
							expect(await consumedBy(code)).toBe(ok.account.id);
						},
					);

					await check("counting and the username check see committed accounts only", async () => {
						const before = await store.countAccounts();
						expect(await store.isUsernameTaken("mallory")).toBe(false);
						await store.createAccount(draftFor({ username: "mallory" }));
						expect(await store.countAccounts()).toBe(before + 1);
						expect(await store.isUsernameTaken("mallory")).toBe(true);
					});

					// ── Rollback, where the failure is real ────────────────────────────

					await check("a failure after the account write leaves nothing behind", async () => {
						// The window the atomic section exists for: the account insert has
						// happened, the preferences write fails (a real 23505 on
						// `user_preferences_user_id_unique`), the invitation claim never runs.
						// EVERYTHING must roll back — and the invitation must still be usable.
						const code = await issueCode({ role: "admin" });
						const doomedId = generateId();
						await pgDb.insert(pgSchema.userPreferences).values({
							id: generateId(),
							userId: doomedId,
							language: "en",
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						});

						const error = await store
							.createAccount(draftFor({ userId: doomedId, username: "niaj", invitationCode: code }))
							.catch((e: unknown) => e);
						// 23505 crossed the port as vocabulary: WriteConflictError naming the
						// constraint, not a driver error and not a retried-into-success.
						expect(error).toBeInstanceOf(WriteConflictError);
						expect((error as WriteConflictError).constraint).toBe(
							"user_preferences_user_id_unique",
						);

						expect(await accountIds()).not.toContain(doomedId);
						expect(await store.isUsernameTaken("niaj")).toBe(false);
						expect(await consumedBy(code)).toBeNull();

						const retry = await store.createAccount(
							draftFor({ username: "niaj", invitationCode: code }),
						);
						expect(retry.account.role).toBe("admin");
						expect(await consumedBy(code)).toBe(retry.account.id);
					});

					// ── Concurrency: one username, two registrations ───────────────────

					await check(
						"concurrent same-username registrations: one wins, one gets the conflict",
						async () => {
							const attempts = await Promise.allSettled([
								store.createAccount(draftFor({ username: "olivia" })),
								store.createAccount(draftFor({ username: "olivia" })),
							]);
							const succeeded = attempts.filter((a) => a.status === "fulfilled");
							const failed = attempts.filter((a) => a.status === "rejected");
							expect(succeeded).toHaveLength(1);
							expect(failed).toHaveLength(1);
							const reason = (failed[0] as PromiseRejectedResult).reason;
							// The unique constraint on `users.username` decided the race, and 23505
							// arrived as port vocabulary — the same fact the SQLite loser surfaces
							// through `registerUser` as USERNAME_TAKEN (asserted end-to-end below).
							expect(reason).toBeInstanceOf(WriteConflictError);
							expect((reason as WriteConflictError).constraint).toBe("users_username_unique");
							expect(await store.isUsernameTaken("olivia")).toBe(true);
							landmarks.usernameRace =
								(failed[0] as PromiseRejectedResult).reason instanceof WriteConflictError
									? ((failed[0] as PromiseRejectedResult).reason as WriteConflictError).constraint
									: "not-a-conflict";
						},
					);

					// ── Concurrency: one invitation code, many registrations ───────────

					await check(
						"concurrent same-code registrations: exactly one burns the code",
						async () => {
							// Eight contenders make a fully serialized outcome (losers rejected at
							// resolve) statistically impossible — the guarded claim's row lock is
							// what decides at least some of the races. Every loser gets the same
							// domain error either way, which is the semantics being pinned.
							const code = await issueCode();
							const contenders = Array.from({ length: 8 }, (_, i) =>
								draftFor({ username: `racer-${i}`, invitationCode: code }),
							);
							const attempts = await Promise.allSettled(
								contenders.map((draft) => store.createAccount(draft)),
							);
							const succeeded = attempts.filter((a) => a.status === "fulfilled");
							const failed = attempts.filter((a) => a.status === "rejected");
							expect(succeeded).toHaveLength(1);
							expect(failed).toHaveLength(7);
							for (const failure of failed) {
								expectAppError((failure as PromiseRejectedResult).reason, 409, "CODE_ALREADY_USED");
							}
							const winner = (succeeded[0] as PromiseFulfilledResult<{ account: { id: string } }>)
								.value;
							expect(await consumedBy(code)).toBe(winner.account.id);
							// Every loser's account insert rolled back: the winner is the only
							// account the race added.
							expect(await accountIds()).toEqual([winner.account.id]);
							landmarks.codeRaceWinners = succeeded.length;
						},
					);

					// ── The full registerUser path against the injected PG store ───────

					await check(
						"registerUser on the PG store: the same races, the same domain answers",
						async () => {
							settings.auth.registrationOpen = true;
							setRegistrationAccountStore(store);
							try {
								// One username, two registrations → one success, one 409 USERNAME_TAKEN.
								const usernameAttempts = await Promise.allSettled([
									registerUser({ username: "peggy", password: "correct-horse-battery" }),
									registerUser({ username: "peggy", password: "another-passphrase" }),
								]);
								const succeeded = usernameAttempts.filter((a) => a.status === "fulfilled");
								const failed = usernameAttempts.filter((a) => a.status === "rejected");
								expect(succeeded).toHaveLength(1);
								expect(failed).toHaveLength(1);
								expectAppError((failed[0] as PromiseRejectedResult).reason, 409, "USERNAME_TAKEN");
								const peggys = await pgDb
									.select({ id: pgSchema.users.id })
									.from(pgSchema.users)
									.where(eq(pgSchema.users.username, "peggy"));
								expect(peggys).toHaveLength(1);

								// One code, two registrations → one burns it, one 409 CODE_ALREADY_USED.
								const code = await issueCode();
								const codeAttempts = await Promise.allSettled([
									registerUser({ username: "quentin", password: "correct-horse-battery", code }),
									registerUser({ username: "rupert", password: "another-passphrase", code }),
								]);
								const codeSucceeded = codeAttempts.filter((a) => a.status === "fulfilled");
								const codeFailed = codeAttempts.filter((a) => a.status === "rejected");
								expect(codeSucceeded).toHaveLength(1);
								expect(codeFailed).toHaveLength(1);
								expectAppError(
									(codeFailed[0] as PromiseRejectedResult).reason,
									409,
									"CODE_ALREADY_USED",
								);

								// The invitation's role flows through the full path too.
								const adminCode = await issueCode({ role: "admin" });
								const { user } = await registerUser({
									username: "sybil",
									password: "correct-horse-battery",
									code: adminCode,
								});
								expect(user.role).toBe("admin");
								expect(await consumedBy(adminCode)).toBe(user.id);
								landmarks.registerUserRaces = "1xUSERNAME_TAKEN+1xCODE_ALREADY_USED";
							} finally {
								setRegistrationAccountStore(undefined);
								settings.auth.registrationOpen = false;
							}
						},
					);

					landmarks.accountsAtEnd = await store.countAccounts();
				} finally {
					await client.close();
					cleanDb(sqlite);
				}

				return { problems, landmarks };
			});

			// A harness status here means PostgreSQL did not actually run the suite. With
			// PG_INTEGRATION=1 that is a failure, never a skip.
			if ("status" in (outcome as Record<string, unknown>)) {
				throw new Error(
					`PostgreSQL integration required but harness returned ${JSON.stringify(outcome)}`,
				);
			}
			const result = outcome as {
				problems?: string[];
				landmarks?: Record<string, unknown>;
				migrationError?: string;
			};
			if (result.migrationError) {
				throw new Error(`PostgreSQL migration failed: ${result.migrationError}`);
			}
			// Problems first: a failing case's own diff is more useful than a missing landmark.
			expect(result.problems ?? ["suite did not run"]).toEqual([]);
			// Landmarks, not just absence of failure: the races really happened and were
			// decided by the mechanisms this suite claims decided them.
			expect(result.landmarks?.usernameRace).toBe("users_username_unique");
			expect(result.landmarks?.codeRaceWinners).toBe(1);
			expect(result.landmarks?.registerUserRaces).toBe("1xUSERNAME_TAKEN+1xCODE_ALREADY_USED");
		},
		RUN_TIMEOUT_MS,
	);
});
