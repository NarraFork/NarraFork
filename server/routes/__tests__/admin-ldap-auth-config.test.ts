/**
 * Administering the LDAP directory, and the one identity a user may not drop.
 *
 * Two things are worth pinning here beyond "the endpoint works":
 *  - a save that carries the redacted password back (the UI always does) must keep the
 *    stored secret, not overwrite it with `********abcd`;
 *  - the "test connection" button must be able to test values that are not saved yet,
 *    without ever echoing a credential back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { userIdentities, users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import type { LdapAuthClient, LdapProbeResult } from "../../lib/ldap/client";
import { LDAP_PROVIDER_ID } from "../../lib/ldap/protocol";
import { settings } from "../../lib/settings";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { setLdapClientFactoryForTests } from "../../services/ldap-auth-service";
import { adminRoutes } from "../admin";
import { authRoutes } from "../auth";

const ADMIN_ID = "ldap-admin-id";
const USER_ID = "ldap-plain-user-id";
const SESSION_TOKEN = `nfs_${"b".repeat(43)}`;

const createdUserIds: string[] = [];

function appWith(mountPath: string, routes: Hono): Hono {
	const app = new Hono();
	app.route(mountPath, routes);
	app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal" }, 500));
	return app;
}

const adminApp = appWith("/api/admin", adminRoutes);
const authApp = appWith("/api/auth", authRoutes);

/**
 * Both `requireAuth` and `requireSessionAuth` insist on a real bearer token, so the seam
 * resolves any opaque token to a session for the given principal.
 */
function installSessionStore(principal: { userId: string; role: "admin" | "user" }): void {
	const store: AuthSessionStore = {
		...authSessionStore,
		async findSessionByTokenHash() {
			const now = Math.floor(Date.now() / 1000);
			return {
				id: "ldap-test-session",
				userId: principal.userId,
				role: principal.role,
				userTokenVersion: 0,
				sessionTokenVersion: 0,
				sessionStart: now,
				createdAt: now,
				expiresAt: now + 3600,
				revokedAt: null,
			};
		},
		async findSessionState(id) {
			return { id, role: principal.role, tokenVersion: 0 };
		},
	};
	setAuthStores({ session: store, mfa: authMfaStore });
}

function adminRequest(path: string, init: RequestInit = {}): Promise<Response> {
	return adminApp.request(`/api/admin${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${SESSION_TOKEN}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});
}

async function createUser(username: string): Promise<string> {
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

const submittedLdap = {
	enabled: true,
	url: "ldaps://dc1.corp.example.com:636",
	bindDn: "cn=svc,dc=example,dc=com",
	bindPassword: "the-real-bind-password",
	searchBase: "dc=example,dc=com",
	mode: "search" as const,
};

beforeEach(() => {
	installSessionStore({ userId: ADMIN_ID, role: "admin" });
});

afterEach(async () => {
	setAuthStores(undefined);
	setLdapClientFactoryForTests(undefined);
	settings.auth.ldap = { enabled: false, url: "" };
	for (const id of createdUserIds.splice(0)) {
		await db.delete(users).where(eq(users.id, id));
	}
});

describe("GET /api/admin/auth-config", () => {
	test("reports no directory when none is configured", async () => {
		settings.auth.ldap = undefined;
		const response = await adminRequest("/auth-config");
		expect(response.status).toBe(200);
		expect((await response.json()) as { ldap: unknown }).toMatchObject({ ldap: null });
	});

	test("masks the service-account password but keeps the form fields", async () => {
		settings.auth.ldap = submittedLdap;
		const response = await adminRequest("/auth-config");
		const body = (await response.json()) as {
			ldap: { bindPassword: string; url: string; bindDn: string };
		};
		expect(body.ldap.bindPassword).toBe("********word");
		expect(body.ldap.url).toBe(submittedLdap.url);
		expect(body.ldap.bindDn).toBe(submittedLdap.bindDn);
		expect(JSON.stringify(body)).not.toContain("the-real-bind-password");
	});
});

describe("PATCH /api/admin/auth-config", () => {
	test("stores the directory configuration", async () => {
		settings.auth.ldap = undefined;
		const response = await adminRequest("/auth-config", {
			method: "PATCH",
			body: JSON.stringify({ oidcProviders: [], ldap: submittedLdap }),
		});
		expect(response.status).toBe(200);
		expect(settings.auth.ldap?.url).toBe(submittedLdap.url);
		expect(settings.auth.ldap?.bindPassword).toBe("the-real-bind-password");
		expect(settings.auth.ldap?.mode).toBe("search");

		const body = (await response.json()) as { ldap: { bindPassword: string } };
		expect(body.ldap.bindPassword).toBe("********word");
	});

	test("a save carrying the masked password back keeps the stored secret", async () => {
		settings.auth.ldap = submittedLdap;
		const response = await adminRequest("/auth-config", {
			method: "PATCH",
			body: JSON.stringify({
				oidcProviders: [],
				ldap: { ...submittedLdap, bindPassword: "********word" },
			}),
		});
		expect(response.status).toBe(200);
		// Not `********word`: the next bind would fail with a password nobody can read.
		expect(settings.auth.ldap?.bindPassword).toBe("the-real-bind-password");
	});

	test("an omitted password keeps the stored secret", async () => {
		settings.auth.ldap = submittedLdap;
		const { bindPassword: _omitted, ...withoutPassword } = submittedLdap;
		await adminRequest("/auth-config", {
			method: "PATCH",
			body: JSON.stringify({ oidcProviders: [], ldap: withoutPassword }),
		});
		expect(settings.auth.ldap?.bindPassword).toBe("the-real-bind-password");
	});

	test("null clears the directory", async () => {
		settings.auth.ldap = submittedLdap;
		const response = await adminRequest("/auth-config", {
			method: "PATCH",
			body: JSON.stringify({ oidcProviders: [], ldap: null }),
		});
		expect(response.status).toBe(200);
		expect(settings.auth.ldap).toBeUndefined();
	});

	test("an omitted ldap key leaves the stored directory untouched", async () => {
		settings.auth.ldap = submittedLdap;
		await adminRequest("/auth-config", {
			method: "PATCH",
			body: JSON.stringify({ oidcProviders: [] }),
		});
		expect(settings.auth.ldap?.url).toBe(submittedLdap.url);
	});

	test("rejects a configuration the login path could not use", async () => {
		const response = await adminRequest("/auth-config", {
			method: "PATCH",
			body: JSON.stringify({
				oidcProviders: [],
				ldap: { ...submittedLdap, searchBase: "" },
			}),
		});
		expect(response.status).toBe(400);
		expect((await response.json()) as { code: string }).toMatchObject({
			code: "VALIDATION_ERROR",
		});
	});

	test("a non-admin cannot read or write the directory", async () => {
		setAuthStores(undefined);
		installSessionStore({ userId: USER_ID, role: "user" });
		expect((await adminRequest("/auth-config")).status).toBe(403);
		expect(
			(
				await adminRequest("/auth-config", {
					method: "PATCH",
					body: JSON.stringify({ oidcProviders: [], ldap: submittedLdap }),
				})
			).status,
		).toBe(403);
	});
});

describe("POST /api/admin/ldap/test", () => {
	function useProbe(result: LdapProbeResult): { seen: unknown[] } {
		const seen: unknown[] = [];
		setLdapClientFactoryForTests(
			(config): LdapAuthClient => ({
				async authenticate() {
					return { kind: "invalid" } as const;
				},
				async probe(input) {
					seen.push({ config, input });
					return result;
				},
				async close() {},
			}),
		);
		return { seen };
	}

	test("returns the stage it reached", async () => {
		settings.auth.ldap = submittedLdap;
		useProbe({ stage: "service_bind", ok: false, message: "resultCode 49: invalid credentials" });

		const response = await adminRequest("/ldap/test", { method: "POST", body: JSON.stringify({}) });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			stage: "service_bind",
			ok: false,
			message: "resultCode 49: invalid credentials",
		});
	});

	test("can probe unsaved form values, inheriting the stored password", async () => {
		settings.auth.ldap = submittedLdap;
		const { seen } = useProbe({ stage: "ok", ok: true, message: "connected" });

		const response = await adminRequest("/ldap/test", {
			method: "POST",
			body: JSON.stringify({
				config: {
					enabled: false,
					url: "ldaps://dc9.corp.example.com:636",
					bindDn: "cn=svc,dc=example,dc=com",
					bindPassword: "********word",
					searchBase: "dc=example,dc=com",
				},
				username: "alice",
				password: "test-password",
			}),
		});
		expect(response.status).toBe(200);
		const probe = seen[0] as { config: { url: string; bindPassword: string } };
		// The typed URL is tested, the redacted password is replaced by the stored one.
		expect(probe.config.url).toBe("ldaps://dc9.corp.example.com:636");
		expect(probe.config.bindPassword).toBe("the-real-bind-password");
	});

	test("a non-admin cannot run a connection test", async () => {
		settings.auth.ldap = submittedLdap;
		useProbe({ stage: "ok", ok: true, message: "connected" });
		setAuthStores(undefined);
		installSessionStore({ userId: USER_ID, role: "user" });

		expect(
			(await adminRequest("/ldap/test", { method: "POST", body: JSON.stringify({}) })).status,
		).toBe(403);
	});
});

describe("DELETE /api/auth/me/identities/:id", () => {
	test("refuses to unlink the directory login", async () => {
		const userId = await createUser("ldap-bound-user");
		installSessionStore({ userId, role: "user" });
		const identityId = generateId();
		await db.insert(userIdentities).values({
			id: identityId,
			userId,
			provider: LDAP_PROVIDER_ID,
			subject: "bound-user",
			createdAt: new Date().toISOString(),
		});

		const response = await authApp.request(`/api/auth/me/identities/${identityId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
		});
		expect(response.status).toBe(400);
		expect((await response.json()) as { code: string }).toMatchObject({
			code: "LDAP_IDENTITY_MANAGED",
		});
		// The binding is the person's login credential; it must still be there.
		const still = await db.query.userIdentities.findFirst({
			where: eq(userIdentities.id, identityId),
		});
		expect(still).toBeDefined();
	});

	test("still unlinks an ordinary SSO identity", async () => {
		const userId = await createUser("sso-bound-user");
		installSessionStore({ userId, role: "user" });
		const identityId = generateId();
		await db.insert(userIdentities).values({
			id: identityId,
			userId,
			provider: "corp-okta",
			subject: "okta-sub",
			createdAt: new Date().toISOString(),
		});

		const response = await authApp.request(`/api/auth/me/identities/${identityId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
		});
		expect(response.status).toBe(200);
		expect(
			await db.query.userIdentities.findFirst({ where: eq(userIdentities.id, identityId) }),
		).toBeUndefined();
	});
});
