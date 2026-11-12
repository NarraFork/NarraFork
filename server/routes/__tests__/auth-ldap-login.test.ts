/**
 * End-to-end login through the HTTP route with an LDAP directory behind it.
 *
 * Everything here is about the *seam between the two verifiers*: the local password must
 * always be tried first, the directory only hears about attempts that failed locally,
 * an outage must not look like a wrong password, and a whole attempt must still spend
 * exactly one unit of the throttle budget however many verifiers it consulted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { loginUser } from "../../lib/auth";
import { authAttemptLimiter } from "../../lib/auth-attempt-limiter";
import { generateId } from "../../lib/id";
import type { LdapAuthClient, LdapAuthOutcome } from "../../lib/ldap/client";
import { settings } from "../../lib/settings";
import type {
	AuthSessionStore,
	LoginCredential,
	SessionProfile,
} from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { setLdapClientFactoryForTests } from "../../services/ldap-auth-service";
import { authRoutes } from "../auth";

const app = new Hono();
app.route("/api/auth", authRoutes);
app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal" }, 500));

const LOCAL_USER_ID = "ldap-login-local-user";
const LOCAL_PASSWORD = "local-password-1";
let localPasswordHash = "";

const createdUserIds: string[] = [];
let ldapCalls: Array<{ username: string; password: string }> = [];

function profile(userId: string, username: string): SessionProfile {
	return {
		id: userId,
		username,
		role: "user",
		avatarColor: null,
		avatarImageId: null,
		gitUsername: null,
		gitEmail: null,
		createdAt: new Date().toISOString(),
		tokenVersion: 0,
		language: "en",
	};
}

/**
 * Install a session store double: credentials and profiles come from the test, sessions
 * are only recorded (no database write is needed to observe a successful login).
 */
function installSessionStore(options: {
	credential?: LoginCredential | null;
	profiles?: Record<string, SessionProfile>;
}): { sessions: string[] } {
	const sessions: string[] = [];
	const store: AuthSessionStore = {
		...authSessionStore,
		async findLoginCredential() {
			return options.credential ?? null;
		},
		async findSessionProfile(userId) {
			return options.profiles?.[userId] ?? null;
		},
		async createSession(session) {
			sessions.push(session.userId);
		},
	};
	setAuthStores({
		session: store,
		mfa: {
			...authMfaStore,
			async findMfaEnabled() {
				return false;
			},
		},
	});
	return { sessions };
}

/** Install a directory client that answers every bind with `outcome`. */
function useDirectory(outcome: LdapAuthOutcome): void {
	ldapCalls = [];
	setLdapClientFactoryForTests(
		(): LdapAuthClient => ({
			async authenticate(username, password) {
				ldapCalls.push({ username, password });
				return outcome;
			},
			async probe() {
				return { stage: "ok", ok: true, message: "ok" };
			},
			async close() {},
		}),
	);
}

function enableDirectory(): void {
	settings.auth.ldap = {
		enabled: true,
		url: "ldaps://dc1.corp.example.com:636",
		searchBase: "dc=example,dc=com",
		mode: "search",
	};
}

async function login(username: string, password: string): Promise<Response> {
	return app.request("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
}

async function createLocalAccount(username: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	createdUserIds.push(id);
	return id;
}

beforeEach(async () => {
	authAttemptLimiter.clearForTests();
	localPasswordHash = await Bun.password.hash(LOCAL_PASSWORD, { algorithm: "bcrypt", cost: 10 });
});

afterEach(async () => {
	setAuthStores(undefined);
	setLdapClientFactoryForTests(undefined);
	settings.auth.ldap = { enabled: false, url: "" };
	authAttemptLimiter.clearForTests();
	for (const id of createdUserIds.splice(0)) {
		await db.delete(users).where(eq(users.id, id));
	}
});

describe("POST /api/auth/login with LDAP configured", () => {
	test("the local password wins and the directory is never asked", async () => {
		enableDirectory();
		useDirectory({ kind: "ok", entry: { dn: "uid=alice", id: "alice" } });
		const { sessions } = installSessionStore({
			credential: { id: LOCAL_USER_ID, passwordHash: localPasswordHash, mfaEnabled: false },
			profiles: { [LOCAL_USER_ID]: profile(LOCAL_USER_ID, "alice") },
		});

		const response = await login("alice", LOCAL_PASSWORD);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { user: { id: string }; token: string };
		expect(body.user.id).toBe(LOCAL_USER_ID);
		expect(body.token).toStartWith("nfs_");
		expect(sessions).toEqual([LOCAL_USER_ID]);
		// The local account's own password answered; no directory round trip happened.
		expect(ldapCalls).toEqual([]);
	});

	test("a password the local account rejects falls back to the directory", async () => {
		enableDirectory();
		const directoryUserId = await createLocalAccount("directory-alice");
		useDirectory({
			kind: "ok",
			entry: { dn: "uid=alice,dc=example,dc=com", id: "directory-alice" },
		});
		const { sessions } = installSessionStore({
			// A local credential exists, but its password is not the one being submitted.
			credential: { id: LOCAL_USER_ID, passwordHash: localPasswordHash, mfaEnabled: false },
			profiles: { [directoryUserId]: profile(directoryUserId, "directory-alice") },
		});

		const response = await login("directory-alice", "directory-password");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { user: { id: string }; token: string };
		expect(body.user.id).toBe(directoryUserId);
		expect(body.token).toStartWith("nfs_");
		expect(sessions).toEqual([directoryUserId]);
		expect(ldapCalls).toEqual([{ username: "directory-alice", password: "directory-password" }]);
	});

	test("a wrong password on both sides is still 401", async () => {
		enableDirectory();
		useDirectory({ kind: "invalid" });
		installSessionStore({
			credential: { id: LOCAL_USER_ID, passwordHash: localPasswordHash, mfaEnabled: false },
			profiles: { [LOCAL_USER_ID]: profile(LOCAL_USER_ID, "alice") },
		});

		const response = await login("alice", "definitely-wrong");
		expect(response.status).toBe(401);
		expect((await response.json()) as { code: string }).toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
	});

	test("an unreachable directory is 503 LDAP_UNAVAILABLE, not a wrong password", async () => {
		enableDirectory();
		useDirectory({ kind: "unavailable", reason: "connect: Connection timeout" });
		installSessionStore({
			credential: { id: LOCAL_USER_ID, passwordHash: localPasswordHash, mfaEnabled: false },
			profiles: { [LOCAL_USER_ID]: profile(LOCAL_USER_ID, "alice") },
		});

		const response = await login("alice", "local-password-but-directory-down");
		expect(response.status).toBe(503);
		expect((await response.json()) as { code: string }).toMatchObject({ code: "LDAP_UNAVAILABLE" });
	});

	test("the local administrator can still sign in while the directory is down", async () => {
		enableDirectory();
		useDirectory({ kind: "unavailable", reason: "connect: ECONNREFUSED" });
		installSessionStore({
			credential: { id: LOCAL_USER_ID, passwordHash: localPasswordHash, mfaEnabled: false },
			profiles: { [LOCAL_USER_ID]: profile(LOCAL_USER_ID, "alice") },
		});

		// The local password answers first, so an outage never reaches the user.
		const response = await login("alice", LOCAL_PASSWORD);
		expect(response.status).toBe(200);
	});

	test("a directory login for an unknown account is refused with LDAP_ACCOUNT_REQUIRED", async () => {
		enableDirectory();
		settings.auth.registrationOpen = false;
		useDirectory({ kind: "ok", entry: { dn: "uid=nobody", id: "nobody-here" } });
		installSessionStore({ credential: null });

		const response = await login("nobody-here", "password");
		expect(response.status).toBe(403);
		expect((await response.json()) as { code: string }).toMatchObject({
			code: "LDAP_ACCOUNT_REQUIRED",
		});
	});

	test("a directory login provisions an account while registration is open", async () => {
		enableDirectory();
		settings.auth.registrationOpen = true;
		useDirectory({ kind: "ok", entry: { dn: "uid=newbie", id: "newbie" } });
		const store = installSessionStore({ credential: null });
		// The provisioned account becomes the profile the session is built from.
		setAuthStores({
			session: {
				...authSessionStore,
				async findLoginCredential() {
					return null;
				},
				async findSessionProfile(userId) {
					return profile(userId, "newbie");
				},
				async createSession(session) {
					store.sessions.push(session.userId);
				},
			},
			mfa: {
				...authMfaStore,
				async findMfaEnabled() {
					return false;
				},
			},
		});

		const response = await login("newbie", "password");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { user: { username: string } };
		expect(body.user.username).toBe("newbie");

		const created = await db.query.users.findFirst({ where: eq(users.username, "newbie") });
		expect(created).toBeDefined();
		if (created) createdUserIds.push(created.id);
	});

	test("failed attempts are counted once per attempt, including directory rejections", async () => {
		enableDirectory();
		useDirectory({ kind: "invalid" });

		// The (account, source) pair allows five failures, so the fifth answer is already
		// a throttle. One directory rejection per attempt — never two — keeps that count.
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) statuses.push((await login("throttled-user", "nope")).status);
		expect(statuses).toEqual([401, 401, 401, 401, 429]);
	});

	test("a directory outage still spends the budget of a locally rejected password", async () => {
		enableDirectory();
		useDirectory({ kind: "unavailable", reason: "connect: Connection timeout" });
		installSessionStore({
			credential: { id: LOCAL_USER_ID, passwordHash: localPasswordHash, mfaEnabled: false },
			profiles: { [LOCAL_USER_ID]: profile(LOCAL_USER_ID, "alice") },
		});

		// The local verifier already said "wrong", so an outage must not refund the guess:
		// otherwise local passwords could be guessed without limit while the directory is
		// down (503 = wrong, 200 = right).
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) statuses.push((await login("alice", `guess-${i}`)).status);
		expect(statuses).toEqual([503, 503, 503, 503, 429]);
		// Even the right password is throttled now.
		expect((await login("alice", LOCAL_PASSWORD)).status).toBe(429);
	});

	test("a slow directory does not hold the bcrypt slots other logins need", async () => {
		enableDirectory();
		const releases: Array<() => void> = [];
		setLdapClientFactoryForTests(
			(): LdapAuthClient => ({
				async authenticate() {
					await new Promise<void>((resolve) => releases.push(resolve));
					return { kind: "invalid" };
				},
				async probe() {
					return { stage: "ok", ok: true, message: "ok" };
				},
				async close() {},
			}),
		);
		installSessionStore({
			credential: { id: LOCAL_USER_ID, passwordHash: localPasswordHash, mfaEnabled: false },
			profiles: { [LOCAL_USER_ID]: profile(LOCAL_USER_ID, "alice") },
		});

		// More stalled directory checks than there are hash slots (4). Distinct accounts and
		// sources, so only the shared hash slots — not a per-source in-flight cap — are in play.
		// Started in waves: attempts that *start* together legitimately contend for the slots
		// while they hash; what matters is that a check parked on the network holds none.
		const settle = (i: number) =>
			loginUser(`stalled-${i}`, "wrong", `198.51.100.${i + 1}`).then(
				() => "ok",
				(error: { code?: string }) => error.code,
			);
		const waitForStalled = async (count: number) => {
			const deadline = Date.now() + 2_000;
			while (releases.length < count && Date.now() < deadline) await Bun.sleep(5);
			expect(releases.length).toBe(count);
		};
		const stalled = [0, 1, 2, 3].map(settle);
		await waitForStalled(4);
		stalled.push(settle(4), settle(5));
		await waitForStalled(6);

		// The local password still answers instead of AUTH_BUSY.
		expect((await login("alice", LOCAL_PASSWORD)).status).toBe(200);

		for (const release of releases) release();
		expect(await Promise.all(stalled)).toEqual(Array(6).fill("INVALID_CREDENTIALS"));
	});
});
