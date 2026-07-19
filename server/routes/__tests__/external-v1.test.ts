import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Frozen phase-two contract tests for the OAuth-only External v1 resource API.
 *
 * The suite boots the real migrations in an isolated NARRAFORK_HOME, then mounts
 * the resource router behind the same dual-mode requireAuth middleware used by
 * production. No reduced/minimal tables are materialized here: schema drift must
 * fail loudly against the checked-in migrations.
 */
const previousHome = process.env.NARRAFORK_HOME;
const previousAllowMultiple = process.env.NARRAFORK_ALLOW_MULTIPLE;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-external-v1-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const [
	{ Hono },
	{ sign },
	drizzle,
	{ db },
	schema,
	{ generateId },
	{ settings },
	{ issueTokenPair },
	{ buildAppErrorResponse },
	{ requireAuth },
	{ externalV1Routes },
	{ hashDeviceToken, verifyDeviceToken },
	{ consumeOAuthWsTicket },
] = await Promise.all([
	import("hono"),
	import("hono/jwt"),
	import("drizzle-orm"),
	import("../../db"),
	import("../../db/schema"),
	import("../../lib/id"),
	import("../../lib/settings"),
	import("../../lib/oauth-provider"),
	import("../../lib/app-error-response"),
	import("../../middleware/auth"),
	import("../external-v1"),
	import("../../services/device-service"),
	import("../../services/oauth-ws-ticket-service"),
]);

const { and, eq, inArray } = drizzle;
const {
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narrators,
	narratorToolCalls,
	oauthAccessTokens,
	oauthClients,
	oauthGrantEvents,
	oauthGrantProjects,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} = schema;

const ALL_EXTERNAL_SCOPES = [
	"project:read",
	"device:read",
	"device:provision",
	"device:rotate",
	"narrator:read",
	"narrator:subscribe",
	"narrator:provision",
	"narrator:message",
	"narrator:interrupt",
];

const DEFAULT_POLICY = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
} as const;

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/external/v1", externalV1Routes);
app.onError(
	(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
);

const cleanup = {
	clientDbIds: new Set<string>(),
	grantIds: new Set<string>(),
	narratorIds: new Set<string>(),
	projectIds: new Set<string>(),
	userIds: new Set<string>(),
	deviceIds: new Set<string>(),
};

interface TestClient {
	id: string;
	clientId: string;
	policy: Record<string, unknown>;
}

interface TestGrant {
	id: string;
	client: TestClient;
	userId: string;
	projectIds: string[];
	scopes: string[];
}

interface DeviceProvisionResponse {
	created: boolean;
	device: {
		id: string;
		name: string;
		scope: "global" | "project";
		projectId: string | null;
		[key: string]: unknown;
	};
	credential: { token: string } | null;
}

interface NarratorProvisionResponse {
	created: boolean;
	narrator: {
		id: string;
		permissionMode: string;
		defaultDeviceId: string | null;
		projectId?: string | null;
		contextProjectId?: string | null;
		[key: string]: unknown;
	};
}

interface MessagePage {
	items: Array<{
		id: string;
		seq: number;
		role: string;
		text: string | null;
		createdAt: string;
		textTruncated?: boolean;
		[key: string]: unknown;
	}>;
	nextCursor: string | null;
}

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Record<string, string> {
	return { ...bearer(token), "Content-Type": "application/json" };
}

async function responseCode(response: Response): Promise<string | undefined> {
	const body = (await response.json().catch(() => ({}))) as { code?: unknown };
	return typeof body.code === "string" ? body.code : undefined;
}

async function createSessionJwt(userId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: userId, role: "user", iat: now, exp: now + 3600 }, settings.auth.jwtSecret);
}

async function createUser(label: string): Promise<string> {
	const id = generateId();
	cleanup.userIds.add(id);
	await db.insert(users).values({
		id,
		username: `external-v1-${label}-${id}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function createProject(label: string): Promise<string> {
	const id = generateId();
	cleanup.projectIds.add(id);
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: `External v1 ${label}`,
		description: `Project ${label} description`,
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function createClient(
	label: string,
	policy: Record<string, unknown> = DEFAULT_POLICY,
): Promise<TestClient> {
	const id = generateId();
	const clientId = `external-v1-${label}-${id}`;
	cleanup.clientDbIds.add(id);
	const now = new Date().toISOString();
	await db.insert(oauthClients).values({
		id,
		clientId,
		name: `External v1 ${label}`,
		redirectUris: ["http://127.0.0.1:9876/oauth/callback"],
		scopes: ALL_EXTERNAL_SCOPES,
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		policyJson: policy,
		createdAt: now,
		updatedAt: now,
	});
	return { id, clientId, policy };
}

async function createGrant(input: {
	client: TestClient;
	label: string;
	legacyUnscoped?: boolean;
	policy?: Record<string, unknown>;
	projectIds?: string[];
	scopes?: string[];
	userId?: string;
}): Promise<TestGrant> {
	const userId = input.userId ?? (await createUser(input.label));
	const id = generateId();
	const scopes = input.scopes ?? ALL_EXTERNAL_SCOPES;
	const projectIds = input.projectIds ?? [];
	cleanup.grantIds.add(id);
	const now = new Date().toISOString();
	await db.insert(oauthGrants).values({
		id,
		oauthClientId: input.client.id,
		userId,
		scopes,
		policyJson: input.policy ?? input.client.policy,
		legacyUnscoped: input.legacyUnscoped ?? false,
		consentedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	if (projectIds.length > 0) {
		await db.insert(oauthGrantProjects).values(
			projectIds.map((projectId) => ({
				id: generateId(),
				grantId: id,
				projectId,
				createdAt: now,
			})),
		);
	}
	return { id, client: input.client, userId, projectIds, scopes };
}

async function oauthToken(grant: TestGrant, scopes: string[] = grant.scopes): Promise<string> {
	const pair = await issueTokenPair({
		clientId: grant.client.clientId,
		oauthClientId: grant.client.id,
		grantId: grant.id,
		userId: grant.userId,
		scopes,
	});
	return pair.accessToken;
}

async function oauthTokenWithoutGrant(input: {
	client: TestClient;
	userId: string;
	scopes?: string[];
}): Promise<string> {
	const pair = await issueTokenPair({
		clientId: input.client.clientId,
		oauthClientId: input.client.id,
		grantId: null,
		userId: input.userId,
		scopes: input.scopes ?? ALL_EXTERNAL_SCOPES,
	});
	return pair.accessToken;
}

async function provisionDevice(
	token: string,
	provisionKey: string,
	body: Record<string, unknown>,
): Promise<{ response: Response; body: DeviceProvisionResponse }> {
	const response = await app.request(
		`/api/external/v1/devices/provisions/${encodeURIComponent(provisionKey)}`,
		{
			method: "PUT",
			headers: jsonHeaders(token),
			body: JSON.stringify(body),
		},
	);
	const parsed = (await response.json()) as DeviceProvisionResponse;
	if (parsed.device?.id) cleanup.deviceIds.add(parsed.device.id);
	return { response, body: parsed };
}

async function provisionNarrator(
	token: string,
	provisionKey: string,
	body: Record<string, unknown>,
): Promise<{ response: Response; body: NarratorProvisionResponse }> {
	const response = await app.request(
		`/api/external/v1/narrators/provisions/${encodeURIComponent(provisionKey)}`,
		{
			method: "PUT",
			headers: jsonHeaders(token),
			body: JSON.stringify(body),
		},
	);
	const parsed = (await response.json()) as NarratorProvisionResponse;
	if (parsed.narrator?.id) cleanup.narratorIds.add(parsed.narrator.id);
	return { response, body: parsed };
}

function expectNoDeviceSecrets(value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const forbidden of [
		"tokenHash",
		"token_hash",
		"oauthOwnerGrantId",
		"oauthProvisionKey",
		"createdBy",
	]) {
		expect(serialized).not.toContain(forbidden);
	}
}

function expectNoNarratorSecrets(value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const forbidden of [
		"systemPrompt",
		"system_prompt",
		"oauthPolicySnapshotJson",
		"oauthOwnerGrantId",
		"oauthProvisionKey",
		"cwd",
	]) {
		expect(serialized).not.toContain(forbidden);
	}
}

describe("External v1 authentication and scopes", () => {
	test("rejects session JWTs plus grantless and legacy OAuth bearers", async () => {
		const projectId = await createProject("auth-boundary");
		const client = await createClient("auth-boundary");
		const userId = await createUser("auth-boundary-session");

		const sessionResponse = await app.request("/api/external/v1/projects", {
			headers: bearer(await createSessionJwt(userId)),
		});
		expect(sessionResponse.status).toBe(401);
		expect(await responseCode(sessionResponse)).toBe("OAUTH_REQUIRED");

		const grantlessResponse = await app.request("/api/external/v1/projects", {
			headers: bearer(await oauthTokenWithoutGrant({ client, userId })),
		});
		expect(grantlessResponse.status).toBe(403);

		const legacy = await createGrant({
			client,
			label: "auth-boundary-legacy",
			legacyUnscoped: true,
			projectIds: [projectId],
		});
		const legacyResponse = await app.request("/api/external/v1/projects", {
			headers: bearer(await oauthToken(legacy)),
		});
		expect(legacyResponse.status).toBe(403);
	});

	test("checks scope before resource lookup and returns 403", async () => {
		const projectId = await createProject("missing-scope");
		const client = await createClient("missing-scope");
		const grant = await createGrant({ client, label: "missing-scope", projectIds: [projectId] });
		const token = await oauthToken(grant, []);
		const requests = [
			app.request("/api/external/v1/projects", { headers: bearer(token) }),
			app.request("/api/external/v1/devices", { headers: bearer(token) }),
			app.request("/api/external/v1/devices/missing", { headers: bearer(token) }),
			app.request("/api/external/v1/devices/missing/credentials/rotate", {
				method: "POST",
				headers: bearer(token),
			}),
			app.request("/api/external/v1/devices/provisions/missing-scope", {
				method: "PUT",
				headers: jsonHeaders(token),
				body: JSON.stringify({ projectId }),
			}),
			app.request("/api/external/v1/narrators/missing", { headers: bearer(token) }),
			app.request("/api/external/v1/narrators/provisions/missing-scope", {
				method: "PUT",
				headers: jsonHeaders(token),
				body: JSON.stringify({ projectId, deviceId: "missing" }),
			}),
			app.request("/api/external/v1/narrators/missing/messages", { headers: bearer(token) }),
			app.request("/api/external/v1/narrators/missing/messages", {
				method: "POST",
				headers: jsonHeaders(token),
				body: JSON.stringify({ message: "hello" }),
			}),
			app.request("/api/external/v1/narrators/missing/interrupt", {
				method: "POST",
				headers: bearer(token),
			}),
		];
		for (const response of await Promise.all(requests)) {
			expect(response.status).toBe(403);
			expect(await responseCode(response)).toBe("INSUFFICIENT_SCOPE");
		}
	});
});

describe("External v1 WebSocket tickets", () => {
	test("fails closed on rollout and requires live read plus subscribe scopes", async () => {
		const projectId = await createProject("ws-ticket");
		const client = await createClient("ws-ticket");
		const grant = await createGrant({ client, label: "ws-ticket", projectIds: [projectId] });
		const fullToken = await oauthToken(grant);
		const runtimeSettings = settings as unknown as {
			oauth?: {
				externalWebSocket?: {
					enabled?: boolean;
					readEnabled?: boolean;
					ticketTtlMs?: number;
					maxTickets?: number;
				};
			};
		};
		const previousOauth = runtimeSettings.oauth;

		try {
			runtimeSettings.oauth = {
				externalWebSocket: { enabled: false, readEnabled: true },
			};
			const disabled = await app.request("/api/external/v1/ws-tickets", {
				method: "POST",
				headers: bearer(fullToken),
			});
			expect(disabled.status).toBe(403);
			expect(await responseCode(disabled)).toBe("OAUTH_EXTERNAL_WS_DISABLED");

			runtimeSettings.oauth.externalWebSocket = { enabled: true, readEnabled: false };
			const readDisabled = await app.request("/api/external/v1/ws-tickets", {
				method: "POST",
				headers: bearer(fullToken),
			});
			expect(readDisabled.status).toBe(403);
			expect(await responseCode(readDisabled)).toBe("OAUTH_EXTERNAL_WS_DISABLED");

			runtimeSettings.oauth.externalWebSocket = {
				enabled: true,
				readEnabled: true,
				ticketTtlMs: 30_000,
				maxTickets: 10,
			};
			for (const scopes of [["narrator:read"], ["narrator:subscribe"]]) {
				const insufficient = await app.request("/api/external/v1/ws-tickets", {
					method: "POST",
					headers: bearer(await oauthToken(grant, scopes)),
				});
				expect(insufficient.status).toBe(403);
				expect(await responseCode(insufficient)).toBe("INSUFFICIENT_SCOPE");
			}

			const issuedResponse = await app.request("/api/external/v1/ws-tickets", {
				method: "POST",
				headers: bearer(fullToken),
			});
			expect(issuedResponse.status).toBe(200);
			const issued = (await issuedResponse.json()) as { ticket: string; expiresIn: number };
			expect(Object.keys(issued).sort()).toEqual(["expiresIn", "ticket"]);
			expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(issued.expiresIn).toBe(30);

			const consumed = consumeOAuthWsTicket(issued.ticket);
			expect(consumed).toMatchObject({
				channel: "external-narrators",
				auth: {
					type: "oauth",
					user: { sub: grant.userId },
					oauth: {
						clientId: client.clientId,
						oauthClientId: client.id,
						grantId: grant.id,
					},
				},
			});
			expect(consumed?.auth.oauth.scopes).toEqual(expect.arrayContaining(ALL_EXTERNAL_SCOPES));
			expect(consumeOAuthWsTicket(issued.ticket)).toBeNull();
		} finally {
			if (previousOauth === undefined) delete runtimeSettings.oauth;
			else runtimeSettings.oauth = previousOauth;
		}
	});
});

describe("External v1 project allow-list", () => {
	test("lists only allowed projects and treats an empty list as deny-all", async () => {
		const allowedProjectId = await createProject("allowed");
		const deniedProjectId = await createProject("denied");
		const client = await createClient("project-allowlist");
		const allowedGrant = await createGrant({
			client,
			label: "project-allowlist",
			projectIds: [allowedProjectId],
		});
		const allowedToken = await oauthToken(allowedGrant);

		const listResponse = await app.request("/api/external/v1/projects", {
			headers: bearer(allowedToken),
		});
		expect(listResponse.status).toBe(200);
		const list = (await listResponse.json()) as {
			items: Array<Record<string, unknown>>;
			nextCursor: string | null;
		};
		expect(list.nextCursor).toBeNull();
		expect(list.items).toHaveLength(1);
		expect(list.items[0]).toMatchObject({ id: allowedProjectId, status: "active" });
		expect(Object.keys(list.items[0]).sort()).toEqual(["description", "id", "name", "status"]);

		const directDenied = await provisionDevice(allowedToken, "forbidden-project", {
			projectId: deniedProjectId,
			name: "must-not-exist",
		});
		expect(directDenied.response.status).toBe(403);

		const emptyGrant = await createGrant({
			client,
			label: "project-empty",
			projectIds: [],
		});
		const emptyToken = await oauthToken(emptyGrant);
		const emptyList = await app.request("/api/external/v1/projects", {
			headers: bearer(emptyToken),
		});
		expect(emptyList.status).toBe(200);
		expect(await emptyList.json()).toEqual({ items: [], nextCursor: null });
		const emptyDirect = await provisionDevice(emptyToken, "empty-deny-all", {
			projectId: allowedProjectId,
		});
		expect(emptyDirect.response.status).toBe(403);
	});
});

describe("External v1 device provisioning", () => {
	test("is idempotent per grant+provisionKey while distinct keys may share a name", async () => {
		const projectId = await createProject("device-idempotency");
		const client = await createClient("device-idempotency");
		const grant = await createGrant({
			client,
			label: "device-idempotency",
			projectIds: [projectId],
		});
		const token = await oauthToken(grant);
		const request = { projectId, name: "Same display name", description: "first" };

		const first = await provisionDevice(token, "stable-key", request);
		expect(first.response.status).toBe(201);
		expect(first.body.created).toBe(true);
		expect(first.body.credential?.token.startsWith("rdev_")).toBe(true);
		expectNoDeviceSecrets(first.body.device);
		const detailResponse = await app.request(`/api/external/v1/devices/${first.body.device.id}`, {
			headers: bearer(token),
		});
		expect(detailResponse.status).toBe(200);
		const detail = (await detailResponse.json()) as Record<string, unknown>;
		expectNoDeviceSecrets(detail);
		expect("credential" in detail).toBe(false);

		const second = await provisionDevice(token, "stable-key", {
			...request,
			description: "ignored on idempotent replay",
		});
		expect(second.response.status).toBe(200);
		expect(second.body).toMatchObject({ created: false, credential: null });
		expect(second.body.device.id).toBe(first.body.device.id);

		const otherKey = await provisionDevice(token, "other-key", request);
		expect(otherKey.response.status).toBe(201);
		expect(otherKey.body.device.id).not.toBe(first.body.device.id);
		expect(otherKey.body.device.name).toBe(first.body.device.name);
	});

	test("serializes concurrent requests for one key into exactly one resource", async () => {
		const projectId = await createProject("device-concurrency");
		const client = await createClient("device-concurrency");
		const grant = await createGrant({
			client,
			label: "device-concurrency",
			projectIds: [projectId],
		});
		const token = await oauthToken(grant);
		const attempts = await Promise.all(
			Array.from({ length: 8 }, () =>
				provisionDevice(token, "concurrent-key", {
					projectId,
					name: "Concurrent device",
				}),
			),
		);
		const ids = new Set(attempts.map((attempt) => attempt.body.device.id));
		expect(ids.size).toBe(1);
		expect(attempts.filter((attempt) => attempt.response.status === 201)).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.body.created)).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.body.credential !== null)).toHaveLength(1);

		const rows = await db.query.remoteDevices.findMany({
			where: and(
				eq(remoteDevices.oauthOwnerGrantId, grant.id),
				eq(remoteDevices.oauthProvisionKey, "concurrent-key"),
			),
		});
		expect(rows).toHaveLength(1);
	});

	test("returns a credential only on create, rotates explicitly, and invalidates the old hash", async () => {
		const projectId = await createProject("device-credential");
		const client = await createClient("device-credential");
		const grant = await createGrant({
			client,
			label: "device-credential",
			projectIds: [projectId],
		});
		const token = await oauthToken(grant);
		const first = await provisionDevice(token, "credential-key", { projectId });
		const oldToken = first.body.credential?.token as string;
		const firstRow = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, first.body.device.id),
		});
		expect(firstRow?.tokenHash).toBe(hashDeviceToken(oldToken));

		const replay = await provisionDevice(token, "credential-key", { projectId });
		expect(replay.response.status).toBe(200);
		expect(replay.body.credential).toBeNull();
		const replayRow = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, first.body.device.id),
		});
		expect(replayRow?.tokenHash).toBe(firstRow?.tokenHash);

		const rotate = await app.request(
			`/api/external/v1/devices/${first.body.device.id}/credentials/rotate`,
			{ method: "POST", headers: bearer(token) },
		);
		expect(rotate.status).toBe(200);
		const rotated = (await rotate.json()) as { credential: { token: string } };
		expect(rotated.credential.token.startsWith("rdev_")).toBe(true);
		expect(rotated.credential.token).not.toBe(oldToken);
		const rotatedRow = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, first.body.device.id),
		});
		expect(rotatedRow?.tokenHash).toBe(hashDeviceToken(rotated.credential.token));
		expect(rotatedRow?.tokenHash).not.toBe(hashDeviceToken(oldToken));
		expect(await verifyDeviceToken(first.body.device.id, oldToken)).toBeNull();
		expect(await verifyDeviceToken(first.body.device.id, rotated.credential.token)).toBeTruthy();
	});

	test("enforces the client policy before allowing global devices", async () => {
		const projectId = await createProject("global-device-policy");
		const deniedClient = await createClient("global-device-denied");
		const deniedGrant = await createGrant({
			client: deniedClient,
			label: "global-device-denied",
			projectIds: [projectId],
		});
		const denied = await provisionDevice(await oauthToken(deniedGrant), "global-denied", {
			projectId,
			scope: "global",
		});
		expect(denied.response.status).toBe(403);

		const allowedPolicy = { ...DEFAULT_POLICY, allowGlobalDevice: true };
		const allowedClient = await createClient("global-device-allowed", allowedPolicy);
		const allowedGrant = await createGrant({
			client: allowedClient,
			label: "global-device-allowed",
			projectIds: [projectId],
			policy: allowedPolicy,
		});
		const allowed = await provisionDevice(await oauthToken(allowedGrant), "global-allowed", {
			projectId,
			scope: "global",
		});
		expect(allowed.response.status).toBe(201);
		expect(allowed.body.device).toMatchObject({ scope: "global", projectId });
	});
});

describe("External v1 grant/client isolation", () => {
	test("isolates resources across grants and clients and hides them behind 404", async () => {
		const projectId = await createProject("isolation");
		const sharedClient = await createClient("isolation-shared-client");
		const ownerGrant = await createGrant({
			client: sharedClient,
			label: "isolation-owner",
			projectIds: [projectId],
		});
		const otherGrant = await createGrant({
			client: sharedClient,
			label: "isolation-other-grant",
			projectIds: [projectId],
		});
		const otherClient = await createClient("isolation-other-client");
		const otherClientGrant = await createGrant({
			client: otherClient,
			label: "isolation-other-client",
			projectIds: [projectId],
		});
		const ownerToken = await oauthToken(ownerGrant);
		const ownerDevice = await provisionDevice(ownerToken, "owner-device", { projectId });
		const ownerNarrator = await provisionNarrator(ownerToken, "owner-narrator", {
			projectId,
			deviceId: ownerDevice.body.device.id,
		});
		expect(ownerNarrator.response.status).toBe(201);
		const ownerDetailResponse = await app.request(
			`/api/external/v1/narrators/${ownerNarrator.body.narrator.id}`,
			{ headers: bearer(ownerToken) },
		);
		expect(ownerDetailResponse.status).toBe(200);
		expectNoNarratorSecrets(await ownerDetailResponse.json());

		for (const attackerToken of [
			await oauthToken(otherGrant),
			await oauthToken(otherClientGrant),
		]) {
			const deviceGet = await app.request(
				`/api/external/v1/devices/${ownerDevice.body.device.id}`,
				{ headers: bearer(attackerToken) },
			);
			expect(deviceGet.status).toBe(404);
			const narratorGet = await app.request(
				`/api/external/v1/narrators/${ownerNarrator.body.narrator.id}`,
				{ headers: bearer(attackerToken) },
			);
			expect(narratorGet.status).toBe(404);
		}

		const otherList = await app.request("/api/external/v1/devices", {
			headers: bearer(await oauthToken(otherGrant)),
		});
		expect(otherList.status).toBe(200);
		const list = (await otherList.json()) as { items: Array<{ id: string }> };
		expect(list.items.some((device) => device.id === ownerDevice.body.device.id)).toBe(false);
	});
});

describe("External v1 narrator provisioning and policy", () => {
	test("cannot bind a device owned by another grant or scoped to another project", async () => {
		const projectA = await createProject("narrator-project-a");
		const projectB = await createProject("narrator-project-b");
		const client = await createClient("narrator-binding");
		const ownerGrant = await createGrant({
			client,
			label: "narrator-device-owner",
			projectIds: [projectA, projectB],
		});
		const otherGrant = await createGrant({
			client,
			label: "narrator-other-grant",
			projectIds: [projectA, projectB],
		});
		const ownerToken = await oauthToken(ownerGrant);
		const deviceA = await provisionDevice(ownerToken, "device-a", { projectId: projectA });
		const deviceB = await provisionDevice(ownerToken, "device-b", { projectId: projectB });

		const otherGrantBind = await provisionNarrator(
			await oauthToken(otherGrant),
			"other-grant-bind",
			{ projectId: projectA, deviceId: deviceA.body.device.id },
		);
		expect(otherGrantBind.response.status).toBe(404);

		const wrongProjectBind = await provisionNarrator(ownerToken, "wrong-project-bind", {
			projectId: projectA,
			deviceId: deviceB.body.device.id,
		});
		expect(wrongProjectBind.response.status).toBe(404);
	});

	test("keeps narrator provision keys idempotent under replay and concurrency", async () => {
		const projectId = await createProject("narrator-idempotency");
		const client = await createClient("narrator-idempotency");
		const grant = await createGrant({
			client,
			label: "narrator-idempotency",
			projectIds: [projectId],
		});
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "narrator-idempotency-device", { projectId });
		const request = {
			projectId,
			deviceId: device.body.device.id,
			title: "Same narrator title",
		};

		const first = await provisionNarrator(token, "stable-narrator-key", request);
		expect(first.response.status).toBe(201);
		expect(first.body.created).toBe(true);
		const replay = await provisionNarrator(token, "stable-narrator-key", {
			...request,
			title: "Ignored replay title",
		});
		expect(replay.response.status).toBe(200);
		expect(replay.body.created).toBe(false);
		expect(replay.body.narrator.id).toBe(first.body.narrator.id);

		const otherKey = await provisionNarrator(token, "other-narrator-key", request);
		expect(otherKey.response.status).toBe(201);
		expect(otherKey.body.narrator.id).not.toBe(first.body.narrator.id);
		expect(otherKey.body.narrator.title).toBe(first.body.narrator.title);

		const concurrent = await Promise.all(
			Array.from({ length: 8 }, () => provisionNarrator(token, "concurrent-narrator-key", request)),
		);
		expect(new Set(concurrent.map((attempt) => attempt.body.narrator.id)).size).toBe(1);
		expect(concurrent.filter((attempt) => attempt.response.status === 201)).toHaveLength(1);
		expect(concurrent.filter((attempt) => attempt.body.created)).toHaveLength(1);
		const rows = await db.query.narrators.findMany({
			where: and(
				eq(narrators.oauthOwnerGrantId, grant.id),
				eq(narrators.oauthProvisionKey, "concurrent-narrator-key"),
			),
		});
		expect(rows).toHaveLength(1);
	});

	test("applies permissionMode and systemPrompt policy snapshots", async () => {
		const projectId = await createProject("narrator-policy");
		const managedClient = await createClient("narrator-managed-policy");
		const managedGrant = await createGrant({
			client: managedClient,
			label: "narrator-managed-policy",
			projectIds: [projectId],
		});
		const managedToken = await oauthToken(managedGrant);
		const managedDevice = await provisionDevice(managedToken, "managed-device", { projectId });
		const managed = await provisionNarrator(managedToken, "managed-narrator", {
			projectId,
			deviceId: managedDevice.body.device.id,
		});
		expect(managed.response.status).toBe(201);
		expect(managed.body.narrator.permissionMode).toBe("readOnly");
		expectNoNarratorSecrets(managed.body.narrator);
		const managedRow = await db.query.narrators.findFirst({
			where: eq(narrators.id, managed.body.narrator.id),
		});
		expect(managedRow).toMatchObject({
			permissionMode: "readOnly",
			defaultDeviceId: managedDevice.body.device.id,
			contextProjectId: projectId,
			oauthOwnerGrantId: managedGrant.id,
			oauthProvisionKey: "managed-narrator",
		});
		expect(managedRow?.systemPrompt).toBeNull();
		expect(managedRow?.oauthPolicySnapshotJson).toEqual({
			version: 1,
			policy: DEFAULT_POLICY,
			permissionMode: "readOnly",
			systemPrompt: null,
			projectId,
			deviceId: managedDevice.body.device.id,
		});

		const disallowedMode = await provisionNarrator(managedToken, "bad-permission", {
			projectId,
			deviceId: managedDevice.body.device.id,
			permissionMode: "dontAsk",
		});
		expect(disallowedMode.response.status).toBe(403);
		expect((disallowedMode.body as unknown as { code?: string }).code).toBe(
			"OAUTH_POLICY_FORBIDDEN",
		);
		const managedPrompt = await provisionNarrator(managedToken, "bad-managed-prompt", {
			projectId,
			deviceId: managedDevice.body.device.id,
			systemPrompt: "client must not replace the managed prompt",
		});
		expect(managedPrompt.response.status).toBe(403);
		expect((managedPrompt.body as unknown as { code?: string }).code).toBe(
			"OAUTH_POLICY_FORBIDDEN",
		);

		const appendPolicy = {
			...DEFAULT_POLICY,
			defaultPermissionMode: "dontAsk",
			allowedPermissionModes: ["readOnly", "dontAsk"],
			systemPromptMode: "append",
			maxSystemPromptChars: 8,
		};
		const appendClient = await createClient("narrator-append-policy", appendPolicy);
		const appendGrant = await createGrant({
			client: appendClient,
			label: "narrator-append-policy",
			projectIds: [projectId],
			policy: appendPolicy,
		});
		const appendToken = await oauthToken(appendGrant);
		const appendDevice = await provisionDevice(appendToken, "append-device", { projectId });
		const appended = await provisionNarrator(appendToken, "append-narrator", {
			projectId,
			deviceId: appendDevice.body.device.id,
			systemPrompt: "12345678",
		});
		expect(appended.response.status).toBe(201);
		const appendedRow = await db.query.narrators.findFirst({
			where: eq(narrators.id, appended.body.narrator.id),
		});
		expect(appendedRow?.permissionMode).toBe("dontAsk");
		expect(appendedRow?.systemPrompt).toContain("12345678");
		expect(appendedRow?.oauthPolicySnapshotJson).toEqual({
			version: 1,
			policy: { ...appendPolicy, allowedPermissionModes: ["dontAsk", "readOnly"] },
			permissionMode: "dontAsk",
			systemPrompt: "12345678",
			projectId,
			deviceId: appendDevice.body.device.id,
		});

		const tooLong = await provisionNarrator(appendToken, "append-too-long", {
			projectId,
			deviceId: appendDevice.body.device.id,
			systemPrompt: "123456789",
		});
		expect(tooLong.response.status).toBe(400);
	});
});

describe("External v1 narrator messages", () => {
	test("uses bounded cursor pagination and never returns raw tool payloads", async () => {
		const projectId = await createProject("messages");
		const client = await createClient("messages");
		const grant = await createGrant({ client, label: "messages", projectIds: [projectId] });
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "messages-device", { projectId });
		const provisioned = await provisionNarrator(token, "messages-narrator", {
			projectId,
			deviceId: device.body.device.id,
		});
		const narratorId = provisioned.body.narrator.id;
		const interrupt = await app.request(`/api/external/v1/narrators/${narratorId}/interrupt`, {
			method: "POST",
			headers: bearer(token),
		});
		expect(interrupt.status).toBe(200);
		expect(await interrupt.json()).toEqual({ success: true });
		const oversizedMessage = await app.request(
			`/api/external/v1/narrators/${narratorId}/messages`,
			{
				method: "POST",
				headers: jsonHeaders(token),
				body: JSON.stringify({ message: "x".repeat(10_001) }),
			},
		);
		expect(oversizedMessage.status).toBe(400);

		const now = Date.now();
		const messageRows = Array.from({ length: 3 }, (_, index) => ({
			id: generateId(),
			narratorId,
			role: index === 1 ? ("assistant" as const) : ("user" as const),
			contentJson:
				index === 1
					? [
							{ type: "text", text: "safe assistant text" },
							{
								type: "tool_use",
								id: "external-tool-use",
								name: "Bash",
								input: { command: "raw-input-secret" },
							},
						]
					: [{ type: "text", text: `message-${index}` }],
			contentText: index === 1 ? "safe assistant text" : `message-${index}`,
			createdAt: new Date(now + index).toISOString(),
		}));
		await db.insert(narratorMessages).values(messageRows);
		await db.insert(narratorMessageRefs).values(
			messageRows.map((message, index) => ({
				id: generateId(),
				narratorId,
				messageId: message.id,
				seq: index + 1,
			})),
		);
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId,
			messageId: messageRows[1].id,
			toolUseId: "external-tool-use",
			toolName: "Bash",
			inputJson: { command: "raw-input-secret" },
			outputJson: { stdout: "raw-output-secret" },
			status: "success",
			createdAt: new Date(now + 1).toISOString(),
		});

		const firstResponse = await app.request(
			`/api/external/v1/narrators/${narratorId}/messages?limit=2`,
			{ headers: bearer(token) },
		);
		expect(firstResponse.status).toBe(200);
		const first = (await firstResponse.json()) as MessagePage;
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();

		const secondResponse = await app.request(
			`/api/external/v1/narrators/${narratorId}/messages?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
			{ headers: bearer(token) },
		);
		expect(secondResponse.status).toBe(200);
		const second = (await secondResponse.json()) as MessagePage;
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		expect([...first.items, ...second.items].map((message) => message.seq)).toEqual([1, 2, 3]);

		const serialized = JSON.stringify({ first, second });
		for (const forbidden of [
			"raw-input-secret",
			"raw-output-secret",
			"inputJson",
			"outputJson",
			"contentJson",
			"toolCalls",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
		for (const item of [...first.items, ...second.items]) {
			expect(item).toMatchObject({
				id: expect.any(String),
				seq: expect.any(Number),
				role: expect.any(String),
				createdAt: expect.any(String),
			});
			expect(
				Object.keys(item).every((key) =>
					["id", "seq", "role", "text", "createdAt", "textTruncated"].includes(key),
				),
			).toBe(true);
		}

		const maxAccepted = await app.request(
			`/api/external/v1/narrators/${narratorId}/messages?limit=50`,
			{ headers: bearer(token) },
		);
		expect(maxAccepted.status).toBe(200);
		const overLimit = await app.request(
			`/api/external/v1/narrators/${narratorId}/messages?limit=51`,
			{ headers: bearer(token) },
		);
		expect(overLimit.status).toBe(400);
		const oversizedCursor = await app.request(
			`/api/external/v1/narrators/${narratorId}/messages?cursor=${"x".repeat(4097)}`,
			{ headers: bearer(token) },
		);
		expect(oversizedCursor.status).toBe(400);
	});
});

describe("External v1 immediate revocation", () => {
	test("invalidates the same bearer after grant revocation", async () => {
		const projectId = await createProject("grant-revoke");
		const client = await createClient("grant-revoke");
		const grant = await createGrant({ client, label: "grant-revoke", projectIds: [projectId] });
		const token = await oauthToken(grant);
		const before = await app.request("/api/external/v1/projects", { headers: bearer(token) });
		expect(before.status).toBe(200);

		await db
			.update(oauthGrants)
			.set({ revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
			.where(eq(oauthGrants.id, grant.id));
		const after = await app.request("/api/external/v1/projects", { headers: bearer(token) });
		expect(after.status).toBe(401);
	});

	test("applies project removal immediately to lists and direct resource access", async () => {
		const projectId = await createProject("project-removal");
		const client = await createClient("project-removal");
		const grant = await createGrant({ client, label: "project-removal", projectIds: [projectId] });
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "project-removal-device", { projectId });
		expect(device.response.status).toBe(201);

		await db
			.delete(oauthGrantProjects)
			.where(
				and(eq(oauthGrantProjects.grantId, grant.id), eq(oauthGrantProjects.projectId, projectId)),
			);
		const projectsAfter = await app.request("/api/external/v1/projects", {
			headers: bearer(token),
		});
		expect(projectsAfter.status).toBe(200);
		expect(await projectsAfter.json()).toEqual({ items: [], nextCursor: null });
		const devicesAfter = await app.request("/api/external/v1/devices", {
			headers: bearer(token),
		});
		expect(devicesAfter.status).toBe(200);
		const deviceList = (await devicesAfter.json()) as { items: Array<{ id: string }> };
		expect(deviceList.items.some((item) => item.id === device.body.device.id)).toBe(false);
		const directAfter = await app.request(`/api/external/v1/devices/${device.body.device.id}`, {
			headers: bearer(token),
		});
		expect(directAfter.status).toBe(404);
	});

	test("applies project removal immediately to global devices through their project anchor", async () => {
		const projectId = await createProject("global-project-removal");
		const policy = { ...DEFAULT_POLICY, allowGlobalDevice: true };
		const client = await createClient("global-project-removal", policy);
		const grant = await createGrant({
			client,
			label: "global-project-removal",
			projectIds: [projectId],
			policy,
		});
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "global-project-removal-device", {
			projectId,
			scope: "global",
		});
		expect(device.response.status).toBe(201);
		expect(device.body.device.projectId).toBe(projectId);

		await db
			.delete(oauthGrantProjects)
			.where(
				and(eq(oauthGrantProjects.grantId, grant.id), eq(oauthGrantProjects.projectId, projectId)),
			);
		const directAfter = await app.request(`/api/external/v1/devices/${device.body.device.id}`, {
			headers: bearer(token),
		});
		expect(directAfter.status).toBe(404);
	});
});

afterAll(async () => {
	const narratorIds = [...cleanup.narratorIds];
	if (narratorIds.length > 0) {
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, narratorIds));
		await db.delete(narratorSidecars).where(inArray(narratorSidecars.narratorId, narratorIds));
		await db
			.delete(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.narratorId, narratorIds));
		await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, narratorIds));
		await db.delete(narrators).where(inArray(narrators.id, narratorIds));
	}
	const deviceIds = [...cleanup.deviceIds];
	if (deviceIds.length > 0) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, deviceIds));
	}
	const clientDbIds = [...cleanup.clientDbIds];
	if (clientDbIds.length > 0) {
		await db.delete(oauthAccessTokens).where(inArray(oauthAccessTokens.oauthClientId, clientDbIds));
		await db.delete(oauthGrantEvents).where(inArray(oauthGrantEvents.oauthClientId, clientDbIds));
	}
	const grantIds = [...cleanup.grantIds];
	if (grantIds.length > 0) {
		await db.delete(oauthGrantProjects).where(inArray(oauthGrantProjects.grantId, grantIds));
		await db.delete(oauthGrants).where(inArray(oauthGrants.id, grantIds));
	}
	if (clientDbIds.length > 0) {
		await db.delete(oauthClients).where(inArray(oauthClients.id, clientDbIds));
	}
	const projectIds = [...cleanup.projectIds];
	if (projectIds.length > 0) await db.delete(projects).where(inArray(projects.id, projectIds));
	const userIds = [...cleanup.userIds];
	if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));

	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	if (previousAllowMultiple === undefined) delete process.env.NARRAFORK_ALLOW_MULTIPLE;
	else process.env.NARRAFORK_ALLOW_MULTIPLE = previousAllowMultiple;
	rmSync(testHome, { recursive: true, force: true });
});
