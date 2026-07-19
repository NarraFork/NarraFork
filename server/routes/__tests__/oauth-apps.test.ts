import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { db } from "../../db";
import { oauthClients, users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { requireAuth } from "../../middleware/auth";
import { oauthAppRoutes } from "../oauth-apps";

const ADMIN_USERNAME = "oauth-apps-admin";
const USER_USERNAME = "oauth-apps-user";
const PREFIX = "oauth-apps-test-";

const app = new Hono();
// Mirror production: global requireAuth, then the admin-gated router.
app.use("/api/*", requireAuth);
app.route("/api/oauth-apps", oauthAppRoutes);
app.onError(
	(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
);

const createdIds = new Set<string>();
let adminId = "";
let userId = "";

interface OAuthClientPolicy extends Record<string, unknown> {
	defaultPermissionMode: "readOnly" | "dontAsk";
	allowedPermissionModes: Array<"readOnly" | "dontAsk">;
	systemPromptMode: "managed" | "append";
	maxSystemPromptChars: number;
	allowGlobalDevice: boolean;
	allowKnowledgeWrite: boolean;
}

const DEFAULT_POLICY: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
};

async function ensureUser(username: string, role: "admin" | "user"): Promise<string> {
	const existing = await db.query.users.findFirst({ where: eq(users.username, username) });
	if (existing) {
		if (existing.role !== role) {
			await db.update(users).set({ role }).where(eq(users.id, existing.id));
		}
		return existing.id;
	}
	const id = generateId();
	await db.insert(users).values({
		id,
		username,
		passwordHash: "not-a-real-hash",
		role,
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function ensureActors(): Promise<void> {
	if (!adminId) adminId = await ensureUser(ADMIN_USERNAME, "admin");
	if (!userId) userId = await ensureUser(USER_USERNAME, "user");
}

async function jwtFor(sub: string, role: "admin" | "user"): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub, role, iat: now, exp: now + 3600 }, settings.auth.jwtSecret);
}

async function adminHeader(): Promise<Record<string, string>> {
	await ensureActors();
	return {
		Authorization: `Bearer ${await jwtFor(adminId, "admin")}`,
		"Content-Type": "application/json",
	};
}

async function userHeader(): Promise<Record<string, string>> {
	await ensureActors();
	return {
		Authorization: `Bearer ${await jwtFor(userId, "user")}`,
		"Content-Type": "application/json",
	};
}

afterEach(async () => {
	const ids = [...createdIds];
	if (ids.length > 0) {
		await db.delete(oauthClients).where(inArray(oauthClients.id, ids));
	}
	createdIds.clear();
});

describe("oauth-apps admin CRUD", () => {
	test("non-admin is rejected with 403", async () => {
		const list = await app.request("/api/oauth-apps", { headers: await userHeader() });
		expect(list.status).toBe(403);

		const create = await app.request("/api/oauth-apps", {
			method: "POST",
			headers: await userHeader(),
			body: JSON.stringify({
				name: `${PREFIX}denied`,
				redirectUris: ["http://127.0.0.1:1/cb"],
				scopes: ["device:manage"],
			}),
		});
		expect(create.status).toBe(403);
	});

	test("admin can create, list, update and soft-revoke a client", async () => {
		const createRes = await app.request("/api/oauth-apps", {
			method: "POST",
			headers: await adminHeader(),
			body: JSON.stringify({
				clientId: `${PREFIX}robot-assistant`,
				name: `${PREFIX}robot`,
				redirectUris: ["http://127.0.0.1:0/oauth/callback"],
				scopes: ["device:manage", "narrator:use"],
			}),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as {
			id: string;
			clientId: string;
			name: string;
			redirectUris: string[];
			scopes: string[];
			publicClient: boolean;
			policy: OAuthClientPolicy;
			lastUsedAt: string | null;
			revokedAt: string | null;
			revokedByUserId: string | null;
			revokedReason: string | null;
		};
		createdIds.add(created.id);
		expect(created.clientId).toBe(`${PREFIX}robot-assistant`);
		expect(created.name).toBe(`${PREFIX}robot`);
		expect(created.redirectUris).toEqual(["http://127.0.0.1:0/oauth/callback"]);
		expect(created.scopes).toEqual(["device:manage", "narrator:use"]);
		expect(created.publicClient).toBe(true);
		expect(created.policy).toEqual(DEFAULT_POLICY);
		expect(created.lastUsedAt).toBeNull();
		expect(created.revokedAt).toBeNull();
		expect(created.revokedByUserId).toBeNull();
		expect(created.revokedReason).toBeNull();
		expect("clientSecret" in created).toBe(false);
		expect("secret" in created).toBe(false);

		const listRes = await app.request("/api/oauth-apps", { headers: await adminHeader() });
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as Array<{ id: string }>;
		expect(list.some((c) => c.id === created.id)).toBe(true);

		const patchRes = await app.request(`/api/oauth-apps/${created.id}`, {
			method: "PATCH",
			headers: await adminHeader(),
			body: JSON.stringify({
				name: `${PREFIX}robot-renamed`,
				redirectUris: ["http://127.0.0.1:9876/oauth/callback", "http://localhost:3000/cb"],
				scopes: ["device:manage"],
			}),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()) as {
			name: string;
			redirectUris: string[];
			scopes: string[];
			policy: OAuthClientPolicy;
		};
		expect(patched.name).toBe(`${PREFIX}robot-renamed`);
		expect(patched.redirectUris).toHaveLength(2);
		expect(patched.scopes).toEqual(["device:manage"]);
		expect(patched.policy).toEqual(DEFAULT_POLICY);

		const lastUsedAt = "2026-07-17T12:00:00.000Z";
		await db.update(oauthClients).set({ lastUsedAt }).where(eq(oauthClients.id, created.id));

		const delRes = await app.request(`/api/oauth-apps/${created.id}`, {
			method: "DELETE",
			headers: await adminHeader(),
		});
		expect(delRes.status).toBe(200);
		const revoked = (await delRes.json()) as {
			success: boolean;
			lastUsedAt: string | null;
			revokedAt: string | null;
			revokedByUserId: string | null;
			revokedReason: string | null;
		};
		expect(revoked.success).toBe(true);
		expect(revoked.lastUsedAt).toBe(lastUsedAt);
		expect(revoked.revokedAt).not.toBeNull();
		expect(revoked.revokedByUserId).toBe(adminId);
		expect(revoked.revokedReason).toBe("Revoked by administrator");

		const revokedRow = await db.query.oauthClients.findFirst({
			where: eq(oauthClients.id, created.id),
		});
		expect(revokedRow?.revokedAt).toBe(revoked.revokedAt);
		expect(revokedRow?.revokedByUserId).toBe(adminId);
		expect(revokedRow?.revokedReason).toBe("Revoked by administrator");

		// Soft-revoked clients disappear from the list and reject further ops.
		const listAfter = (await (
			await app.request("/api/oauth-apps", { headers: await adminHeader() })
		).json()) as Array<{ id: string }>;
		expect(listAfter.some((c) => c.id === created.id)).toBe(false);

		const patchGone = await app.request(`/api/oauth-apps/${created.id}`, {
			method: "PATCH",
			headers: await adminHeader(),
			body: JSON.stringify({ name: "nope" }),
		});
		expect(patchGone.status).toBe(400);
	});

	test("create applies policy defaults and update accepts a legal policy", async () => {
		const legalPolicy: OAuthClientPolicy = {
			defaultPermissionMode: "dontAsk",
			allowedPermissionModes: ["readOnly", "dontAsk"],
			systemPromptMode: "append",
			maxSystemPromptChars: 4096,
			allowGlobalDevice: true,
			allowKnowledgeWrite: true,
		};
		const createRes = await app.request("/api/oauth-apps", {
			method: "POST",
			headers: await adminHeader(),
			body: JSON.stringify({
				clientId: `${PREFIX}legal-policy-${generateId()}`,
				name: `${PREFIX}legal-policy`,
				redirectUris: ["http://127.0.0.1:0/oauth/callback"],
				scopes: ["narrator:use"],
				policy: legalPolicy,
			}),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { id: string; policy: OAuthClientPolicy };
		createdIds.add(created.id);
		expect(created.policy).toEqual(legalPolicy);

		const patchRes = await app.request(`/api/oauth-apps/${created.id}`, {
			method: "PATCH",
			headers: await adminHeader(),
			body: JSON.stringify({
				policy: {
					defaultPermissionMode: "readOnly",
					maxSystemPromptChars: 1000,
					allowKnowledgeWrite: false,
				},
			}),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()) as { policy: OAuthClientPolicy };
		expect(patched.policy).toEqual({
			...legalPolicy,
			defaultPermissionMode: "readOnly",
			maxSystemPromptChars: 1000,
			allowKnowledgeWrite: false,
		});

		const dangerousPatch = await app.request(`/api/oauth-apps/${created.id}`, {
			method: "PATCH",
			headers: await adminHeader(),
			body: JSON.stringify({
				policy: { allowedPermissionModes: ["readOnly", "bypassPermissions"] },
			}),
		});
		expect(dangerousPatch.status).toBe(400);
	});

	test("create rejects dangerous, inconsistent and extra policy fields", async () => {
		const invalidPolicies: unknown[] = [
			{ ...DEFAULT_POLICY, defaultPermissionMode: "bypassPermissions" },
			{ ...DEFAULT_POLICY, allowedPermissionModes: ["readOnly", "acceptEdits"] },
			{
				...DEFAULT_POLICY,
				defaultPermissionMode: "dontAsk",
				allowedPermissionModes: ["readOnly"],
			},
			{ ...DEFAULT_POLICY, systemPromptMode: "replace" },
			{ ...DEFAULT_POLICY, maxSystemPromptChars: 10_001 },
			{ ...DEFAULT_POLICY, dangerouslyAllowEverything: true },
		];

		for (const [index, policy] of invalidPolicies.entries()) {
			const response = await app.request("/api/oauth-apps", {
				method: "POST",
				headers: await adminHeader(),
				body: JSON.stringify({
					clientId: `${PREFIX}invalid-policy-${index}-${generateId()}`,
					name: `${PREFIX}invalid-policy-${index}`,
					redirectUris: ["http://127.0.0.1:0/oauth/callback"],
					scopes: ["narrator:use"],
					policy,
				}),
			});
			if (response.status === 201) {
				createdIds.add(((await response.json()) as { id: string }).id);
			}
			expect(response.status).toBe(400);
		}
	});

	test("list is bounded to at most 100 active clients", async () => {
		await ensureActors();
		const now = new Date().toISOString();
		const rows = Array.from({ length: 101 }, (_, index) => {
			const id = generateId();
			createdIds.add(id);
			return {
				id,
				clientId: `${PREFIX}limit-${index}-${generateId()}`,
				name: `${PREFIX}limit-${index}`,
				redirectUris: ["http://127.0.0.1:0/oauth/callback"],
				scopes: ["narrator:use"],
				grantTypes: ["authorization_code", "refresh_token"],
				publicClient: true,
				policyJson: DEFAULT_POLICY,
				createdBy: adminId,
				createdAt: now,
				updatedAt: now,
			};
		});
		await db.insert(oauthClients).values(rows);

		const listRes = await app.request("/api/oauth-apps", { headers: await adminHeader() });
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as Array<{ id: string }>;
		expect(list).toHaveLength(100);
	});

	test("create accepts a stable clientId and rejects duplicates", async () => {
		const first = await app.request("/api/oauth-apps", {
			method: "POST",
			headers: await adminHeader(),
			body: JSON.stringify({
				clientId: `${PREFIX}stable-client`,
				name: `${PREFIX}stable`,
				redirectUris: ["robot-assistant://oauth/callback", "http://127.0.0.1:0/callback"],
				scopes: ["device:manage", "narrator:use"],
			}),
		});
		expect(first.status).toBe(201);
		const created = (await first.json()) as { id: string; clientId: string };
		createdIds.add(created.id);
		expect(created.clientId).toBe(`${PREFIX}stable-client`);

		const duplicate = await app.request("/api/oauth-apps", {
			method: "POST",
			headers: await adminHeader(),
			body: JSON.stringify({
				clientId: `${PREFIX}stable-client`,
				name: `${PREFIX}stable-again`,
				redirectUris: ["http://127.0.0.1:0/callback"],
				scopes: ["device:manage"],
			}),
		});
		expect(duplicate.status).toBe(400);
	});

	test("create rejects unknown scopes and empty redirect URIs", async () => {
		const badScope = await app.request("/api/oauth-apps", {
			method: "POST",
			headers: await adminHeader(),
			body: JSON.stringify({
				name: `${PREFIX}bad`,
				redirectUris: ["http://127.0.0.1/cb"],
				scopes: ["root:all"],
			}),
		});
		expect(badScope.status).toBe(400);

		const emptyUris = await app.request("/api/oauth-apps", {
			method: "POST",
			headers: await adminHeader(),
			body: JSON.stringify({
				name: `${PREFIX}bad`,
				redirectUris: [],
				scopes: ["device:manage"],
			}),
		});
		expect(emptyUris.status).toBe(400);
	});
});
