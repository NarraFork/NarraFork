/**
 * The PostgreSQL auth loop, end to end against a real PostgreSQL 17.
 *
 * The P3 claim, exercised through the PRODUCTION wiring rather than test-only injection:
 * a real `startPostgresRuntime` (connection probe → disk `drizzle-postgres` journal through
 * the production migrator dispatch → FTS catalog) feeding the real composition seam
 * (`composePostgresStores`), so the whole loop runs on the stores production itself would
 * hold:
 *
 *   register → login → session JWT → session-middleware verification → sliding
 *   renewal → MFA enrollment/status/enable → MFA-gated login → tokenVersion
 *   revocation — write and read never splitting across engines.
 *
 * The SQLite half of every semantic is pinned by
 * `server/services/auth/__tests__/` (store contracts) and the pre-existing auth
 * suites (`register-with-code`, `session-renewal.integration`, …), which keep
 * running against SQLite unchanged. This suite runs the SAME business facts
 * against the PostgreSQL adapters over a real network connection to a throwaway
 * container.
 *
 * Rules, same as the registration write suite:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run. A blocked harness is a
 *     failure in that mode, never a quiet pass;
 *   - migrations are applied by the production runtime, EXACTLY as the disk journal
 *     specifies (no psql relay, no hand-applied baseline);
 *   - the container is the harness' own random name and only it is cleaned up;
 *   - sensitive values (plaintext password, issued JWTs, backup codes, the TOTP
 *     secret, the connection URL) must not appear in any captured log line.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SESSION_RENEWAL_HEADER, SESSION_RENEWAL_THRESHOLD_SECONDS } from "@shared/session-auth";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { Secret, TOTP } from "otpauth";
import {
	DATABASE_BACKEND_ENV,
	DATABASE_URL_ENV,
	resolveDatabaseBackendConfig,
	startPostgresRuntime,
} from "../../../../server/db/postgres-runtime";
import { AppError } from "../../../../server/lib/errors";
import { withPostgres } from "../../../db/pg-test-harness";
import { cleanDb, getTestDb } from "../../../setup";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

// Poison both SQLite exports during the runtime/composition/auth exercise. Even a
// swallowed read failure increments the counter: empty tables alone cannot prove zero reads.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
let poisonSqlite = false;
let sqliteTouches = 0;
function poisonHandle<T extends object>(handle: T): T {
	return new Proxy(handle, {
		get(target, property, receiver) {
			if (poisonSqlite) {
				sqliteTouches += 1;
				throw new Error("P3 auth unexpectedly accessed SQLite");
			}
			return Reflect.get(target, property, receiver);
		},
	});
}
mock.module("../../../../server/db", () => ({
	...realDbModule,
	db: poisonHandle(sqliteDb),
	sqlite: poisonHandle(sqlite),
}));

const { buildSessionResult, loginUser, registerUser, revokeUserSessions, verifyToken } =
	await import("../../../../server/lib/auth");
const { composePostgresStores } = await import("../../../../server/services/postgres-composition");
const { setRegistrationAccountStore } = await import(
	"../../../../server/services/registration/store"
);
const authStores = await import("../../../../server/services/auth/store");
const { setAuthStores } = authStores;
const { setKnowledgeReadStore, setKnowledgeWriteStore } = await import(
	"../../../../server/services/knowledge/store"
);
const { setChapterWriteStore } = await import("../../../../server/services/chapter-write/store");
const { setProjectArchiveMainStore } = await import(
	"../../../../server/services/project-archive/store"
);
const { setProjectReadAdapter } = await import("../../../../server/services/read");
const { setPostgresRuntimeQueue } = await import(
	"../../../../server/services/agent-runtime/postgres-runtime-queue"
);
const { unbindPostgresSearchClientForTests } = await import(
	"../../../../server/services/search/postgres-store"
);
const { mfaService } = await import("../../../../server/services/mfa-service");
const { invalidateUserCache, requireSessionAuth } = await import(
	"../../../../server/middleware/auth"
);
const { consumeMfaToken, verifyMfaToken } = await import("../../../../server/lib/mfa");
const { settings } = await import("../../../../server/lib/settings");
const { logger } = await import("../../../../server/lib/logger");

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

const PASSWORD = "correct-horse-battery-staple";
const SOURCE_IP = "127.0.0.1";

/** Generate the currently-valid 6-digit code for a base32 secret (same parameters as lib/totp). */
function currentTotpCode(secretBase32: string): string {
	return new TOTP({
		algorithm: "SHA1",
		digits: 6,
		period: 30,
		secret: Secret.fromBase32(secretBase32),
	}).generate();
}

/**
 * A minimal Hono app with the real session middleware in front of a probe route —
 * the middleware itself is the code under test; the app only has to answer errors
 * the way the real error handler does (status + code).
 */
function createProbeApp() {
	const app = new Hono();
	app.onError((error, _c) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		throw error;
	});
	app.get("/probe", requireSessionAuth, (c) => c.json({ ok: true, sub: c.get("user").sub }));
	return app;
}

function expectAppError(error: unknown, statusCode: number, code: string): void {
	expect(error).toBeInstanceOf(AppError);
	expect((error as AppError).statusCode).toBe(statusCode);
	expect((error as AppError).code).toBe(code);
}

type LoopResult =
	| { problems: string[]; landmarks: Record<string, unknown> }
	| { migrationError: string };

/**
 * The whole loop, run inside the harness callback against the throwaway database.
 * Failures are recorded as text (never thrown past the harness, which would flatten
 * them into a generic "callback failed").
 */
async function runLoop(
	port: number,
	credentials: { user: string; password: string; database: string },
	capturedLogs: string[],
	secrets: string[],
): Promise<LoopResult> {
	const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/${credentials.database}`;
	secrets.push(url);
	const config = resolveDatabaseBackendConfig(
		{ [DATABASE_BACKEND_ENV]: "postgres", [DATABASE_URL_ENV]: url },
		undefined,
	);
	if (config.backend !== "postgres") {
		return { migrationError: "expected a postgres config from the harness URL" };
	}

	// The PRODUCTION startup path: connection probe → disk drizzle-postgres journal
	// through the drizzle migrator (no psql relay) → FTS catalog. A failure in any
	// stage rejects as PostgresStartupError and fails this suite via the harness.
	const runtime = await startPostgresRuntime(config);
	const problems: string[] = [];
	const landmarks: Record<string, unknown> = {};
	const registrationOpenBefore = settings.auth.registrationOpen;

	/** Run one step; record failures as text, never throw past the harness. */
	const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
		try {
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

	const app = createProbeApp();
	const authGet = async (token?: string) =>
		await app.request("/probe", {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});

	let adminId = "";
	let adminToken = "";

	try {
		// The sole production binding point; no individual adapter is injected by this test.
		composePostgresStores(runtime);
		const migrationsDir = resolve(import.meta.dir, "../../../../drizzle-postgres");
		const journal = JSON.parse(
			readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
		) as { entries: Array<{ tag: string }> };
		expect(journal.entries.length).toBeGreaterThan(0);
		const expectedHashes = journal.entries.map(({ tag }) =>
			createHash("sha256")
				.update(readFileSync(resolve(migrationsDir, `${tag}.sql`), "utf8"))
				.digest("hex"),
		);
		const ledger = await runtime.readMigrationState();
		expect(ledger.map((entry) => entry.hash)).toEqual(expectedHashes);
		landmarks.migrations = ledger.length;
		const [version] = await runtime.executor.unsafe("SHOW server_version_num");
		expect(Number(version.server_version_num)).toBeGreaterThanOrEqual(170000);
		expect(Number(version.server_version_num)).toBeLessThan(180000);
		landmarks.pgMajor = 17;
		// ── 1. Bootstrap registration lands on PG ────────────────────────────
		await check("bootstrap admin registers and is readable through the loop", async () => {
			const { user, token } = await registerUser({
				username: "p3-admin",
				password: PASSWORD,
			});
			expect(user.role).toBe("admin");
			adminId = user.id;
			adminToken = token;
			secrets.push(token);

			// Write-after-read on the SAME database: the account the write side just
			// created is what the read side finds — and the SQLite scratch database
			// saw none of it.
			const login = await loginUser("p3-admin", PASSWORD, SOURCE_IP);
			expect("user" in login && login.user.id).toBe(adminId);
			expect(await sqliteDb.query.users.findMany({ columns: { id: true } })).toEqual([]);
			landmarks.bootstrap = "admin-on-pg";
		});

		// ── 2. Bad credentials fail with the same domain errors ─────────────
		await check("wrong password and unknown user are both INVALID_CREDENTIALS", async () => {
			expectAppError(
				await loginUser("p3-admin", "not-the-password", SOURCE_IP).catch((e: unknown) => e),
				401,
				"INVALID_CREDENTIALS",
			);
			expectAppError(
				await loginUser("no-such-user", PASSWORD, SOURCE_IP).catch((e: unknown) => e),
				401,
				"INVALID_CREDENTIALS",
			);
		});

		// ── 3. The session middleware verifies the issued JWT ────────────────
		await check("the session gate accepts the JWT and rejects non-credentials", async () => {
			expect((await authGet(adminToken)).status).toBe(200);

			const noHeader = await authGet();
			expect(noHeader.status).toBe(401);

			// An authentic expired session takes the session-only failure path. Malformed
			// bearer tokens also probe OAuth, whose storage migration is outside P3.
			const expired = await sign(
				{ sub: adminId, role: "admin", exp: Math.floor(Date.now() / 1000) - 60 },
				settings.auth.jwtSecret,
			);
			secrets.push(expired);
			const rejected = await authGet(expired);
			expect(rejected.status).toBe(401);
			expect(await rejected.json()).toMatchObject({ code: "TOKEN_EXPIRED" });

			landmarks.middleware = "200+401+401";
		});

		// ── 4. Sliding renewal re-signs inside the window ────────────────────
		await check("a near-expiry token is renewed; the renewal authenticates", async () => {
			const now = Math.floor(Date.now() / 1000);
			const state = await authStores.authSessionStore.findSessionState(adminId);
			const nearlyExpired = await sign(
				{
					sub: adminId,
					role: "admin",
					iat: now - 4 * 24 * 60 * 60,
					exp: now + (SESSION_RENEWAL_THRESHOLD_SECONDS - 3600),
					sst: now - 4 * 24 * 60 * 60,
					sv: state?.tokenVersion ?? 0,
				},
				settings.auth.jwtSecret,
			);
			secrets.push(nearlyExpired);

			const renewed = (await authGet(nearlyExpired)).headers.get(SESSION_RENEWAL_HEADER);
			expect(renewed).toBeString();
			secrets.push(renewed as string);

			const payload = await verifyToken(renewed as string);
			expect(payload.sub).toBe(adminId);
			// The live role, not the presented one; the live generation too.
			expect(payload.role).toBe("admin");
			expect((await authGet(renewed as string)).status).toBe(200);
			landmarks.renewal = "header+200";
		});

		// ── 5. Revocation: a bumped generation strands the old token ─────────
		await check("revoke → old token is TOKEN_EXPIRED, re-login works", async () => {
			const before = await authGet(adminToken);
			expect(before.status).toBe(200);

			const bumped = await revokeUserSessions(adminId);
			expect(bumped).toBe(1);
			invalidateUserCache(adminId);

			const after = await authGet(adminToken);
			expect(after.status).toBe(401);
			expect(await after.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
			expect(after.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();

			const relogin = await loginUser("p3-admin", PASSWORD, SOURCE_IP);
			expect("token" in relogin).toBe(true);
			if (!("token" in relogin)) throw new Error("expected a session");
			secrets.push(relogin.token);
			expect((await verifyToken(relogin.token)).sub).toBe(adminId);
			expect((await authGet(relogin.token)).status).toBe(200);
			landmarks.revocation = `sv:${bumped}`;
		});

		// ── 6. MFA: enroll → status → enable → gated login → consume ─────────
		await check("the MFA lifecycle runs on PG end to end", async () => {
			// Enroll: pending secret → activate with a real code → 10 backup codes.
			const setup = await mfaService.beginSetup(adminId);
			if ("alreadyActive" in setup) throw new Error("unexpected alreadyActive");
			secrets.push(setup.secret);
			expect(await mfaService.isTotpActive(adminId)).toBe(false);

			const activated = await mfaService.activate(adminId, currentTotpCode(setup.secret));
			if (!activated.ok) throw new Error("activation rejected a current code");
			expect(activated.backupCodes).toHaveLength(10);
			secrets.push(...activated.backupCodes);
			expect(await mfaService.isTotpActive(adminId)).toBe(true);
			expect(await mfaService.hasAnyFactor(adminId)).toBe(true);

			// Status before the switch: factor enrolled, requirement still off, so a
			// password login still yields a full session.
			const before = await mfaService.getStatus(adminId);
			expect(before).toEqual({
				mfaEnabled: false,
				totpEnabled: true,
				backupCodesRemaining: 10,
			});
			const ungated = await loginUser("p3-admin", PASSWORD, SOURCE_IP);
			expect("token" in ungated).toBe(true);

			// Enable the requirement: the SAME login now stops at a challenge.
			await mfaService.setMfaEnabled(adminId, true);
			expect(await mfaService.isMfaEnabled(adminId)).toBe(true);
			const gated = await loginUser("p3-admin", PASSWORD, SOURCE_IP);
			if (!("mfaRequired" in gated)) throw new Error("expected an MFA challenge");
			secrets.push(gated.mfaToken);
			expect(gated.methods).toEqual(["totp", "backup_code"]);

			// Redeem the challenge with a current TOTP code: challenge token verifies,
			// the factor proves, the session is issued.
			const challenge = await verifyMfaToken(gated.mfaToken);
			expect(challenge?.sub).toBe(adminId);
			expect(await mfaService.verifyTotp(adminId, currentTotpCode(setup.secret))).toBe(true);
			if (challenge) consumeMfaToken(challenge);
			const session = await buildSessionResult(adminId);
			secrets.push(session.token);
			expect((await authGet(session.token)).status).toBe(200);

			// Backup codes: each consumes exactly once; the count follows.
			expect(await mfaService.consumeBackupCode(adminId, activated.backupCodes[0])).toBe(true);
			expect(await mfaService.consumeBackupCode(adminId, activated.backupCodes[0])).toBe(false);
			const after = await mfaService.getStatus(adminId);
			expect(after).toEqual({ mfaEnabled: true, totpEnabled: true, backupCodesRemaining: 9 });

			// Teardown: factors cleared, the requirement auto-drops, login is ungated again.
			await mfaService.disable(adminId);
			expect(await mfaService.isTotpActive(adminId)).toBe(false);
			expect(await mfaService.syncMfaEnabledAfterFactorChange(adminId)).toBe(true);
			expect(await mfaService.isMfaEnabled(adminId)).toBe(false);
			const ungatedAgain = await loginUser("p3-admin", PASSWORD, SOURCE_IP);
			expect("token" in ungatedAgain).toBe(true);
			landmarks.mfa = "enroll+gate+redeem+consume+teardown";
		});

		// ── 7. The username race keeps its domain answer on PG ───────────────
		await check("concurrent same-username registrations: one wins, one 409", async () => {
			settings.auth.registrationOpen = true;
			try {
				const attempts = await Promise.allSettled([
					registerUser({ username: "p3-racer", password: PASSWORD }),
					registerUser({ username: "p3-racer", password: PASSWORD }),
				]);
				const succeeded = attempts.filter((a) => a.status === "fulfilled");
				const failed = attempts.filter((a) => a.status === "rejected");
				expect(succeeded).toHaveLength(1);
				expect(failed).toHaveLength(1);
				expectAppError((failed[0] as PromiseRejectedResult).reason, 409, "USERNAME_TAKEN");
				// The race winner's token was captured for the log-safety sweep below.
				const winner = (succeeded[0] as PromiseFulfilledResult<{ token: string }>).value;
				secrets.push(winner.token);
				landmarks.usernameRace = "1xUSERNAME_TAKEN";
			} finally {
				settings.auth.registrationOpen = false;
			}
		});

		// ── 8. Nothing crossed engines, and nothing sensitive was logged ──────
		await check("the SQLite scratch stayed empty and the logs stayed clean", async () => {
			// The whole loop ran above: if any read or write had leaked onto the
			// SQLite handle, its rows would be here.
			expect(await sqliteDb.query.users.findMany({ columns: { id: true } })).toEqual([]);
			expect(await sqliteDb.query.userTotp.findMany({ columns: { id: true } })).toEqual([]);
			expect(await sqliteDb.query.userMfaBackupCodes.findMany({ columns: { id: true } })).toEqual(
				[],
			);
			expect(sqliteTouches).toBe(0);
			landmarks.sqliteTouches = sqliteTouches;
			landmarks.scratchEmpty = true;

			for (const line of capturedLogs) {
				for (const secret of secrets) {
					expect(line.includes(secret)).toBe(false);
				}
			}
			landmarks.logsSwept = capturedLogs.length;
		});
	} finally {
		// Restore every binding the composition seam swapped, so no later test file
		// in this process keeps a store pointed at the throwaway database.
		setRegistrationAccountStore(undefined);
		setAuthStores(undefined);
		setKnowledgeWriteStore(undefined);
		setKnowledgeReadStore(undefined);
		setChapterWriteStore(undefined);
		setProjectArchiveMainStore(undefined);
		setProjectReadAdapter(undefined);
		setPostgresRuntimeQueue(undefined);
		unbindPostgresSearchClientForTests();
		invalidateUserCache(adminId);
		settings.auth.registrationOpen = registrationOpenBefore;
		await runtime.close();
		cleanDb(sqlite);
	}

	return { problems, landmarks };
}

describe("PostgreSQL auth loop", () => {
	it.skipIf(!PG_ENABLED)(
		"register → login → session gate → renewal → MFA → revocation, all on one database",
		async () => {
			const outcome = await withPostgres(async ({ port, credentials }) => {
				// Log capture starts BEFORE the runtime boots, so the sweep at the end covers
				// the startup stages too: the connection URL and its password are the sensitive
				// values there, exactly as tokens and codes are later.
				const capturedLogs: string[] = [];
				const original = { ...logger };
				const secrets: string[] = [PASSWORD, credentials.password];
				for (const level of ["debug", "info", "warn", "error"] as const) {
					logger[level] = (msg: string, data?: Record<string, unknown>) => {
						capturedLogs.push(JSON.stringify({ msg, ...data }));
					};
				}

				sqliteTouches = 0;
				poisonSqlite = true;
				try {
					return await runLoop(port, credentials, capturedLogs, secrets);
				} finally {
					poisonSqlite = false;
					// Even a boot failure (which fails the suite through the harness) must not
					// leak the capture shim into other test files in this process.
					Object.assign(logger, original);
				}
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
			// Problems first: a failing step's own diff is more useful than a missing landmark.
			expect(result.problems ?? ["suite did not run"]).toEqual([]);
			// Landmarks, not just absence of failure: every stage of the loop really ran, and
			// the production journal really applied.
			expect(result.landmarks?.migrations).toBeGreaterThan(0);
			expect(result.landmarks?.pgMajor).toBe(17);
			expect(result.landmarks?.sqliteTouches).toBe(0);
			expect(result.landmarks?.bootstrap).toBe("admin-on-pg");
			expect(result.landmarks?.middleware).toBe("200+401+401");
			expect(result.landmarks?.renewal).toBe("header+200");
			expect(result.landmarks?.revocation).toBe("sv:1");
			expect(result.landmarks?.mfa).toBe("enroll+gate+redeem+consume+teardown");
			expect(result.landmarks?.usernameRace).toBe("1xUSERNAME_TAKEN");
			expect(result.landmarks?.scratchEmpty).toBe(true);
		},
		RUN_TIMEOUT_MS,
	);
});
