/**
 * LDAP directory logins, with an injected client so no directory server is involved.
 *
 * The account policy is the interesting part and is what most of this file pins down:
 * an already-bound identity signs in regardless of the registration switch, a same-name
 * regular local account gets bound (and keeps its role), a same-name administrator is
 * never bound implicitly, and an unknown name is either
 * provisioned as an ordinary `user` or refused outright.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { userIdentities, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	createLdapClient,
	type LdapAuthClient,
	type LdapAuthOutcome,
	type LdapProbeResult,
} from "../../lib/ldap/client";
import { LDAP_PROVIDER_ID } from "../../lib/ldap/protocol";
import { settings } from "../../lib/settings";
import {
	authenticate,
	isLdapEnabled,
	LDAP_MAX_CONCURRENT_AUTHENTICATIONS,
	probe,
	resolveLocalUser,
	setLdapClientFactoryForTests,
	verifyLinkedUserPassword,
} from "../ldap-auth-service";

const createdUserIds: string[] = [];

function useDirectoryConfig(overrides: Record<string, unknown> = {}): void {
	settings.auth.ldap = {
		enabled: true,
		url: "ldaps://dc1.corp.example.com:636",
		searchBase: "dc=example,dc=com",
		mode: "search",
		...overrides,
	};
}

interface FakeClientCalls {
	authenticate: Array<{ username: string; password: string }>;
	probe: LdapProbeResult | undefined;
}

/** Install a fake directory client that always answers `outcome`. */
function useFakeClient(outcome: LdapAuthOutcome): FakeClientCalls {
	const calls: FakeClientCalls = { authenticate: [], probe: undefined };
	setLdapClientFactoryForTests(
		(): LdapAuthClient => ({
			async authenticate(username, password) {
				calls.authenticate.push({ username, password });
				return outcome;
			},
			async probe() {
				return calls.probe ?? { stage: "ok", ok: true, message: "ok" };
			},
			async close() {},
		}),
	);
	return calls;
}

async function makeUser(username: string, role: "admin" | "user" = "user"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username,
		passwordHash: "not-a-real-hash",
		role,
		createdAt: new Date().toISOString(),
	});
	createdUserIds.push(id);
	return id;
}

async function findUserByUsername(username: string) {
	return db.query.users.findFirst({ where: eq(users.username, username) });
}

async function findIdentity(subject: string) {
	return db.query.userIdentities.findFirst({
		where: and(eq(userIdentities.provider, LDAP_PROVIDER_ID), eq(userIdentities.subject, subject)),
	});
}

afterEach(async () => {
	setLdapClientFactoryForTests(undefined);
	for (const id of createdUserIds.splice(0)) {
		await db.delete(users).where(eq(users.id, id));
	}
});

describe("isLdapEnabled", () => {
	test("false without a directory configuration", () => {
		settings.auth.ldap = undefined;
		expect(isLdapEnabled()).toBe(false);
	});

	test("false when the switch is off", () => {
		useDirectoryConfig({ enabled: false });
		expect(isLdapEnabled()).toBe(false);
	});

	test("false when the configuration is structurally incomplete", () => {
		// A switched-on but half-filled configuration must not turn every wrong password
		// into a 503 — it simply stays off.
		useDirectoryConfig({ searchBase: "" });
		expect(isLdapEnabled()).toBe(false);
	});

	test("true for a complete configuration", () => {
		useDirectoryConfig();
		expect(isLdapEnabled()).toBe(true);
	});
});

describe("authenticate", () => {
	test("an empty password never reaches the directory", async () => {
		useDirectoryConfig();
		const calls = useFakeClient({ kind: "ok", entry: { dn: "uid=a", id: "a" } });

		expect(await authenticate("alice", "")).toEqual({ kind: "invalid" });
		// The unauthenticated-bind bypass: a non-empty DN with an empty password can
		// "succeed" without proving anything, so no request may be issued at all.
		expect(calls.authenticate).toHaveLength(0);
	});

	test("an empty username never reaches the directory", async () => {
		useDirectoryConfig();
		const calls = useFakeClient({ kind: "ok", entry: { dn: "uid=a", id: "a" } });

		expect(await authenticate("   ", "pw")).toEqual({ kind: "invalid" });
		expect(calls.authenticate).toHaveLength(0);
	});

	test("reports a directory with no matching entry as invalid", async () => {
		useDirectoryConfig();
		useFakeClient({ kind: "invalid" });
		expect(await authenticate("ghost", "pw")).toEqual({ kind: "invalid" });
	});

	test("keeps an unreachable directory distinct from a wrong password", async () => {
		useDirectoryConfig();
		useFakeClient({ kind: "unavailable", reason: "connect: Connection timeout" });
		expect(await authenticate("alice", "pw")).toEqual({
			kind: "unavailable",
			reason: "connect: Connection timeout",
		});
	});

	test("refuses beyond the concurrency cap without dialing out", async () => {
		useDirectoryConfig();
		let calls = 0;
		const releases: Array<() => void> = [];
		setLdapClientFactoryForTests(
			(): LdapAuthClient => ({
				async authenticate() {
					calls += 1;
					await new Promise<void>((resolve) => releases.push(resolve));
					return { kind: "invalid" };
				},
				async probe() {
					return { stage: "ok", ok: true, message: "ok" };
				},
				async close() {},
			}),
		);

		const pending = Array.from({ length: LDAP_MAX_CONCURRENT_AUTHENTICATIONS }, () =>
			authenticate("slow", "pw"),
		);
		expect(await authenticate("one-too-many", "pw")).toEqual({
			kind: "unavailable",
			reason: "LDAP_BUSY",
		});
		expect(calls).toBe(LDAP_MAX_CONCURRENT_AUTHENTICATIONS);

		for (const release of releases) release();
		await Promise.all(pending);
		// Slots are returned once the checks settle.
		useFakeClient({ kind: "invalid" });
		expect(await authenticate("after", "pw")).toEqual({ kind: "invalid" });
	});

	test("is unavailable (not invalid) when LDAP is off", async () => {
		settings.auth.ldap = undefined;
		useFakeClient({ kind: "ok", entry: { dn: "uid=a", id: "a" } });
		expect(await authenticate("alice", "pw")).toEqual({
			kind: "unavailable",
			reason: "LDAP_NOT_CONFIGURED",
		});
	});
});

describe("resolveLocalUser", () => {
	test("signs in an already-bound identity", async () => {
		useDirectoryConfig();
		const userId = await makeUser("bound-user");
		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			provider: LDAP_PROVIDER_ID,
			subject: "erin",
			createdAt: new Date().toISOString(),
		});

		const resolved = await resolveLocalUser({ dn: "uid=erin,dc=example,dc=com", id: "erin" });
		expect(resolved).toEqual({ userId, outcome: "existing_identity" });
	});

	test("an existing binding signs in even when registration is closed", async () => {
		useDirectoryConfig();
		settings.auth.registrationOpen = false;
		const userId = await makeUser("closed-user");
		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			provider: LDAP_PROVIDER_ID,
			subject: "frank",
			createdAt: new Date().toISOString(),
		});

		expect(await resolveLocalUser({ dn: "uid=frank", id: "frank" })).toEqual({
			userId,
			outcome: "existing_identity",
		});
	});

	test("binds a same-name local account instead of creating a duplicate", async () => {
		useDirectoryConfig();
		const userId = await makeUser("alice");

		const resolved = await resolveLocalUser({ dn: "uid=alice,dc=example,dc=com", id: "alice" });
		expect(resolved).toEqual({ userId, outcome: "linked_existing_account" });

		// The account keeps its role; only the credential source was added.
		const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
		expect(user?.role).toBe("user");
		const identity = await findIdentity("alice");
		expect(identity?.userId).toBe(userId);
	});

	test("never binds a same-name administrator implicitly", async () => {
		useDirectoryConfig();
		settings.auth.registrationOpen = true;
		const adminId = await makeUser("ldap-root", "admin");

		await expect(resolveLocalUser({ dn: "uid=ldap-root", id: "ldap-root" })).rejects.toMatchObject({
			statusCode: 403,
			code: "LDAP_ADMIN_LINK_REFUSED",
		});
		expect(await findIdentity("ldap-root")).toBeUndefined();
		const admin = await db.query.users.findFirst({ where: eq(users.id, adminId) });
		expect(admin?.role).toBe("admin");
	});

	test("a name that only collapses onto a local account after sanitizing is not bound to it", async () => {
		useDirectoryConfig();
		settings.auth.registrationOpen = true;
		const adminId = await makeUser("rootadm", "admin");

		// `root.adm` sanitizes to `rootadm`; it must get an account of its own, not the admin's.
		const resolved = await resolveLocalUser({ dn: "uid=root.adm", id: "root.adm" });
		createdUserIds.push(resolved.userId);
		expect(resolved.outcome).toBe("created");
		expect(resolved.userId).not.toBe(adminId);
		const created = await db.query.users.findFirst({ where: eq(users.id, resolved.userId) });
		expect(created?.role).toBe("user");
		expect(created?.username).not.toBe("rootadm");
		expect((await findIdentity("root.adm"))?.userId).toBe(resolved.userId);
	});

	test("matches a same-name account regardless of case", async () => {
		useDirectoryConfig();
		const userId = await makeUser("Bob");

		expect(await resolveLocalUser({ dn: "uid=bob", id: "bob" })).toEqual({
			userId,
			outcome: "linked_existing_account",
		});
	});

	test("provisions an ordinary user when registration is open", async () => {
		useDirectoryConfig();
		settings.auth.registrationOpen = true;

		const resolved = await resolveLocalUser({
			dn: "uid=carol,dc=example,dc=com",
			id: "carol",
			email: "carol@example.com",
			displayName: "Carol",
		});
		createdUserIds.push(resolved.userId);
		expect(resolved.outcome).toBe("created");

		const user = await db.query.users.findFirst({ where: eq(users.id, resolved.userId) });
		expect(user?.username).toBe("carol");
		// A directory account can never mint an administrator.
		expect(user?.role).toBe("user");

		const identity = await findIdentity("carol");
		expect(identity?.userId).toBe(resolved.userId);
		expect(identity?.email).toBe("carol@example.com");
		expect(identity?.displayName).toBe("Carol");
	});

	test("refuses with LDAP_ACCOUNT_REQUIRED when registration is closed", async () => {
		useDirectoryConfig();
		settings.auth.registrationOpen = false;

		await expect(resolveLocalUser({ dn: "uid=dave", id: "dave" })).rejects.toMatchObject({
			statusCode: 403,
			code: "LDAP_ACCOUNT_REQUIRED",
		});
		// Nothing was created for a refused login.
		expect(await findUserByUsername("dave")).toBeUndefined();
		expect(await findIdentity("dave")).toBeUndefined();
	});
});

describe("verifyLinkedUserPassword", () => {
	test("re-checks the bound directory account", async () => {
		useDirectoryConfig();
		const userId = await makeUser("step-up-user");
		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			provider: LDAP_PROVIDER_ID,
			subject: "grace",
			createdAt: new Date().toISOString(),
		});
		const calls = useFakeClient({ kind: "ok", entry: { dn: "uid=grace", id: "grace" } });

		expect(await verifyLinkedUserPassword(userId, "pw")).toBe(true);
		expect(calls.authenticate).toEqual([{ username: "grace", password: "pw" }]);
	});

	test("false when the password is wrong", async () => {
		useDirectoryConfig();
		const userId = await makeUser("step-up-bad");
		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			provider: LDAP_PROVIDER_ID,
			subject: "heidi",
			createdAt: new Date().toISOString(),
		});
		useFakeClient({ kind: "invalid" });

		expect(await verifyLinkedUserPassword(userId, "wrong")).toBe(false);
	});

	test("false for a user with no directory binding (no request is made)", async () => {
		useDirectoryConfig();
		const userId = await makeUser("local-only");
		const calls = useFakeClient({ kind: "ok", entry: { dn: "uid=x", id: "x" } });

		expect(await verifyLinkedUserPassword(userId, "pw")).toBe(false);
		expect(calls.authenticate).toHaveLength(0);
	});
});

describe("probe", () => {
	test("passes the unsaved form value through to the client", async () => {
		settings.auth.ldap = undefined;
		let seen: unknown;
		setLdapClientFactoryForTests((config) => {
			seen = config;
			return {
				async authenticate() {
					return { kind: "invalid" } as const;
				},
				async probe() {
					return { stage: "ok", ok: true, message: "connected" };
				},
				async close() {},
			};
		});

		const result = await probe({
			config: { enabled: false, url: "ldaps://dc9:636", searchBase: "dc=x" },
		});
		expect(result).toEqual({ stage: "ok", ok: true, message: "connected" });
		// Testing is how one decides to switch LDAP on, so `enabled: false` is allowed.
		expect(seen).toEqual({ enabled: false, url: "ldaps://dc9:636", searchBase: "dc=x" });
	});

	test("reports an unusable configuration instead of dialing out", async () => {
		settings.auth.ldap = undefined;
		let called = false;
		setLdapClientFactoryForTests((config) => {
			called = true;
			return createLdapClient(config);
		});

		const result = await probe({
			config: { enabled: true, url: "https://dc1", searchBase: "dc=x" },
		});
		expect(result.ok).toBe(false);
		expect(result.stage).toBe("config");
		expect(called).toBe(true);
	});

	test("says so when no directory is configured at all", async () => {
		settings.auth.ldap = undefined;
		await expect(probe({})).resolves.toEqual({
			stage: "config",
			ok: false,
			message: "No LDAP server is configured yet.",
		});
	});
});
