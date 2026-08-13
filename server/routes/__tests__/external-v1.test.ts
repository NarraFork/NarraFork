import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";

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
	{ integrationAuthorityService },
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
	import("../../services/integration-authority-service"),
]);

const { and, eq, inArray } = drizzle;
const {
	integrationAuthorities,
	integrationResourceBindings,
	narratorMessageRefs,
	narratorMessages,
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
	"project.read",
	"device.read",
	"device.provision",
	"device.rotate",
	"narrator.read",
	"event.subscribe",
	"narrator.provision",
	"narrator.send_message",
	"narrator.interrupt",
	"message.summary.read",
	"message.content.read",
];

/** Scopes a client gets when the layered message read must NOT be authorized. */
const NO_MESSAGE_SCOPES = ALL_EXTERNAL_SCOPES.filter((scope) => !scope.startsWith("message."));

/** Scopes that authorize structure but not payloads. */
const SUMMARY_ONLY_SCOPES = ALL_EXTERNAL_SCOPES.filter((scope) => scope !== "message.content.read");

const DEFAULT_POLICY = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
	allowDangerReflectionPrompt: false,
	maxDangerReflectionPromptChars: 0,
	allowRobotDiagnosticPreset: false,
	deviceAccess: { host: "denied", global: "denied", selfRegistered: "denied" },
	// Matches the schema default: structure follows consent, payloads need an
	// explicit administrator decision.
	messageDetail: "summary",
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
	documentRevision?: number;
	detail?: string;
	detailRequested?: string;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
}

interface LayeredMessage {
	id: string;
	seq: number;
	role: string;
	createdAt: string;
	kind: string;
	textChars: number;
	text?: string;
	reasoning: {
		tokens: number | null;
		steps?: Array<{ title: string | null; chars: number; body?: string }>;
		stepsTruncated?: boolean;
		unavailable?: boolean;
	};
	tools: {
		count: number;
		running: number;
		failed: number;
		awaitingPermission: number;
		items?: Array<{
			toolUseId: string;
			name: string;
			target: string | null;
			status: string;
			inputBytes: number | null;
			outputBytes: number | null;
			hasDetail: boolean;
			input?: unknown;
			output?: unknown;
		}>;
	};
	subagents: { count: number; items?: Array<{ toolUseId: string; type: string | null }> };
}

interface LayeredMessagePage extends Omit<MessagePage, "items"> {
	items: LayeredMessage[];
	detail: string;
	documentRevision: number;
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
	if (!input.legacyUnscoped) {
		await integrationAuthorityService.create({
			id,
			kind: "oauth_grant",
			integrationId: input.client.id,
			ownerUserId: userId,
			policyJson: input.policy ?? input.client.policy,
			grants: (scopes as CanonicalCapabilityId[]).flatMap((capabilityId) => [
				{
					capabilityId,
					scope: { type: "integration" as const, id },
					createdBy: { type: "user" as const, id: userId },
				},
				...projectIds.map((projectId) => ({
					capabilityId,
					scope: { type: "project" as const, id: projectId },
					createdBy: { type: "user" as const, id: userId },
				})),
			]),
		});
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

async function replaceGrantProjects(grant: TestGrant, projectIds: string[]): Promise<void> {
	const authority = await integrationAuthorityService.requireSnapshot(grant.id);
	await integrationAuthorityService.replaceGrants({
		authorityId: grant.id,
		expectedRevision: authority.authority.revision,
		grants: (grant.scopes as CanonicalCapabilityId[]).flatMap((capabilityId) => [
			{
				capabilityId,
				scope: { type: "integration" as const, id: grant.id },
				createdBy: { type: "user" as const, id: grant.userId },
			},
			...projectIds.map((projectId) => ({
				capabilityId,
				scope: { type: "project" as const, id: projectId },
				createdBy: { type: "user" as const, id: grant.userId },
			})),
		]),
	});
	grant.projectIds = [...projectIds];
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
	const requestBody =
		typeof body.deviceId === "string" && !Object.hasOwn(body, "deviceIds")
			? { ...body, deviceIds: [body.deviceId] }
			: body;
	const response = await app.request(
		`/api/external/v1/narrators/provisions/${encodeURIComponent(provisionKey)}`,
		{
			method: "PUT",
			headers: jsonHeaders(token),
			body: JSON.stringify(requestBody),
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
	test("rejects session JWTs, grantless bearers, and authority-less grants", async () => {
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
		await expect(oauthToken(legacy)).rejects.toMatchObject({ oauthError: "invalid_grant" });
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
				body: JSON.stringify({ projectId, deviceId: "missing", deviceIds: ["missing"] }),
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
	test("requires live read plus subscribe scopes and issues a single-use ticket", async () => {
		const projectId = await createProject("ws-ticket");
		const client = await createClient("ws-ticket");
		const grant = await createGrant({ client, label: "ws-ticket", projectIds: [projectId] });
		const fullToken = await oauthToken(grant);
		const runtimeSettings = settings as unknown as {
			oauth?: {
				externalWebSocket?: {
					ticketTtlMs?: number;
					maxTickets?: number;
				};
			};
		};
		const previousOauth = runtimeSettings.oauth;

		try {
			runtimeSettings.oauth = {
				externalWebSocket: {
					ticketTtlMs: 30_000,
					maxTickets: 10,
				},
			};
			for (const scopes of [["narrator.read"], ["event.subscribe"]]) {
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

	test("paginates allowed projects with a stable cursor", async () => {
		const projectIds = await Promise.all([
			createProject("page-alpha"),
			createProject("page-beta"),
			createProject("page-gamma"),
		]);
		const client = await createClient("project-pagination");
		const grant = await createGrant({ client, label: "project-pagination", projectIds });
		const token = await oauthToken(grant);
		const firstResponse = await app.request("/api/external/v1/projects?limit=2", {
			headers: bearer(token),
		});
		const first = (await firstResponse.json()) as {
			items: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(firstResponse.status).toBe(200);
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		const secondResponse = await app.request(
			`/api/external/v1/projects?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
			{ headers: bearer(token) },
		);
		const second = (await secondResponse.json()) as {
			items: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(secondResponse.status).toBe(200);
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
			new Set(projectIds),
		);
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
		const provenance = await db.query.integrationResourceBindings.findFirst({
			where: and(
				eq(integrationResourceBindings.resourceType, "device"),
				eq(integrationResourceBindings.resourceId, first.body.device.id),
			),
		});
		expect(provenance).toMatchObject({
			sourceType: "oauth_client",
			sourceId: client.id,
			authorityType: "oauth_grant",
			authorityId: grant.id,
			state: "active",
			metadataJson: {
				provisionIdentity: {
					version: 1,
					algorithm: "sha256",
					digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			},
		});
		expect(
			await db.query.oauthGrantEvents.findMany({
				where: and(
					eq(oauthGrantEvents.grantId, grant.id),
					eq(oauthGrantEvents.eventType, "resource_provisioned"),
				),
			}),
		).toHaveLength(1);
		const detailResponse = await app.request(`/api/external/v1/devices/${first.body.device.id}`, {
			headers: bearer(token),
		});
		expect(detailResponse.status).toBe(200);
		const detail = (await detailResponse.json()) as Record<string, unknown>;
		expectNoDeviceSecrets(detail);
		expect("credential" in detail).toBe(false);

		const second = await provisionDevice(token, "stable-key", {
			...request,
			name: "Ignored replay display name",
			description: "ignored on idempotent replay",
		});
		expect(second.response.status).toBe(200);
		expect(second.body).toMatchObject({
			created: false,
			credential: null,
			device: { id: first.body.device.id, name: "Same display name", description: "first" },
		});

		const otherKey = await provisionDevice(token, "other-key", request);
		expect(otherKey.response.status).toBe(201);
		expect(otherKey.body.device.id).not.toBe(first.body.device.id);
		expect(otherKey.body.device.name).toBe(first.body.device.name);
	});

	test("rejects device provision replays with different project or scope semantics", async () => {
		const projectA = await createProject("device-identity-a");
		const projectB = await createProject("device-identity-b");
		const policy = { ...DEFAULT_POLICY, allowGlobalDevice: true };
		const client = await createClient("device-identity", policy);
		const grant = await createGrant({
			client,
			label: "device-identity",
			projectIds: [projectA, projectB],
			policy,
		});
		const token = await oauthToken(grant);
		const first = await provisionDevice(token, "device-identity", {
			projectId: projectA,
			scope: "project",
			name: "Original identity device",
		});
		expect(first.response.status).toBe(201);

		const changedProject = await provisionDevice(token, "device-identity", {
			projectId: projectB,
			scope: "project",
		});
		expect(changedProject.response.status).toBe(409);
		expect((changedProject.body as unknown as { code?: string }).code).toBe(
			"RESOURCE_PROVISION_CONFLICT",
		);
		const changedScope = await provisionDevice(token, "device-identity", {
			projectId: projectA,
			scope: "global",
		});
		expect(changedScope.response.status).toBe(409);
		expect((changedScope.body as unknown as { code?: string }).code).toBe(
			"RESOURCE_PROVISION_CONFLICT",
		);

		await db
			.update(integrationResourceBindings)
			.set({ metadataJson: { legacy: true } })
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "device"),
					eq(integrationResourceBindings.resourceId, first.body.device.id),
				),
			);
		const legacyReplay = await provisionDevice(token, "device-identity", {
			projectId: projectA,
			scope: "project",
		});
		expect(legacyReplay.response.status).toBe(409);
		expect((legacyReplay.body as unknown as { code?: string }).code).toBe(
			"RESOURCE_PROVISION_CONFLICT",
		);
	});

	test("paginates active devices and excludes orphaned provenance", async () => {
		const projectId = await createProject("device-pagination");
		const client = await createClient("device-pagination");
		const grant = await createGrant({
			client,
			label: "device-pagination",
			projectIds: [projectId],
		});
		const token = await oauthToken(grant);
		const devices = await Promise.all(
			["page-a", "page-b", "page-c"].map((key) => provisionDevice(token, key, { projectId })),
		);
		const firstResponse = await app.request("/api/external/v1/devices?limit=2", {
			headers: bearer(token),
		});
		const first = (await firstResponse.json()) as {
			items: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(firstResponse.status).toBe(200);
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		const secondResponse = await app.request(
			`/api/external/v1/devices?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
			{ headers: bearer(token) },
		);
		const second = (await secondResponse.json()) as {
			items: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(secondResponse.status).toBe(200);
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
			new Set(devices.map((item) => item.body.device.id)),
		);

		const orphanedId = devices[0].body.device.id;
		await db
			.update(integrationResourceBindings)
			.set({ state: "orphaned", orphanedAt: new Date().toISOString() })
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "device"),
					eq(integrationResourceBindings.resourceId, orphanedId),
				),
			);
		const after = (await (
			await app.request("/api/external/v1/devices", { headers: bearer(token) })
		).json()) as { items: Array<{ id: string }>; nextCursor: string | null };
		expect(after.items.some((item) => item.id === orphanedId)).toBe(false);
		const detail = await app.request(`/api/external/v1/devices/${orphanedId}`, {
			headers: bearer(token),
		});
		expect(detail.status).toBe(404);
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

		const bindings = await db.query.integrationResourceBindings.findMany({
			where: and(
				eq(integrationResourceBindings.authorityId, grant.id),
				eq(integrationResourceBindings.resourceType, "device"),
				eq(integrationResourceBindings.provisionKey, "concurrent-key"),
			),
		});
		expect(bindings).toHaveLength(1);
		const rows = await db.query.remoteDevices.findMany({
			where: eq(remoteDevices.id, bindings[0]?.resourceId ?? ""),
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ oauthOwnerGrantId: null, oauthProvisionKey: null });
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
		expect(
			await db.query.oauthGrantEvents.findMany({
				where: and(
					eq(oauthGrantEvents.grantId, grant.id),
					eq(oauthGrantEvents.eventType, "device_credential_rotated"),
				),
			}),
		).toHaveLength(1);
	});

	test("provisions a grant-owned global device regardless of allowGlobalDevice policy", async () => {
		// De-projectization: a device a grant provisions for itself is bounded by
		// grant ownership, not the allowGlobalDevice policy. allowGlobalDevice=false
		// no longer blocks provisioning a self-owned global device.
		const projectId = await createProject("global-device-policy");
		const deniedClient = await createClient("global-device-denied");
		const deniedGrant = await createGrant({
			client: deniedClient,
			label: "global-device-denied",
			projectIds: [projectId],
		});
		const selfOwned = await provisionDevice(await oauthToken(deniedGrant), "global-denied", {
			projectId,
			scope: "global",
		});
		expect(selfOwned.response.status).toBe(201);
		expect(selfOwned.body.device).toMatchObject({ scope: "global", projectId });

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

		// Cross-grant binding is still forbidden: grant ownership is the boundary.
		const otherGrantBind = await provisionNarrator(
			await oauthToken(otherGrant),
			"other-grant-bind",
			{ projectId: projectA, deviceId: deviceA.body.device.id },
		);
		expect(otherGrantBind.response.status).toBe(404);

		// De-projectization: a device owned by the same grant but anchored to another
		// project may now be bound (project is no longer an isolation boundary).
		const otherProjectBind = await provisionNarrator(ownerToken, "other-project-bind", {
			projectId: projectA,
			deviceId: deviceB.body.device.id,
		});
		expect(otherProjectBind.response.status).toBe(201);
	});

	test("provisions a deduplicated multi-device authorization set with a stable default", async () => {
		const projectId = await createProject("narrator-multi-device");
		const otherProjectId = await createProject("narrator-multi-device-other");
		const client = await createClient("narrator-multi-device");
		const grant = await createGrant({
			client,
			label: "narrator-multi-device",
			projectIds: [projectId, otherProjectId],
		});
		const token = await oauthToken(grant);
		const defaultDevice = await provisionDevice(token, "multi-default", { projectId });
		const secondaryDevice = await provisionDevice(token, "multi-secondary", { projectId });
		const otherProjectDevice = await provisionDevice(token, "multi-other-project", {
			projectId: otherProjectId,
		});
		const deviceIds = [defaultDevice.body.device.id, secondaryDevice.body.device.id].sort();

		const missingDeviceIds = await app.request(
			"/api/external/v1/narrators/provisions/multi-missing-device-ids",
			{
				method: "PUT",
				headers: jsonHeaders(token),
				body: JSON.stringify({ projectId, deviceId: defaultDevice.body.device.id }),
			},
		);
		expect(missingDeviceIds.status).toBe(400);

		const first = await provisionNarrator(token, "multi-narrator", {
			projectId,
			deviceId: defaultDevice.body.device.id,
			deviceIds: [
				secondaryDevice.body.device.id,
				defaultDevice.body.device.id,
				secondaryDevice.body.device.id,
			],
		});
		expect(first.response.status).toBe(201);
		expect(first.body.narrator.defaultDeviceId).toBe(defaultDevice.body.device.id);
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, first.body.narrator.id),
		});
		expect(row?.oauthPolicySnapshotJson).toMatchObject({
			version: 2,
			projectId,
			defaultDeviceId: defaultDevice.body.device.id,
			deviceIds,
		});

		const replay = await provisionNarrator(token, "multi-narrator", {
			projectId,
			deviceId: defaultDevice.body.device.id,
			deviceIds: [...deviceIds].reverse(),
		});
		expect(replay.response.status).toBe(200);
		expect(replay.body.narrator.id).toBe(first.body.narrator.id);

		const missingDefault = await provisionNarrator(token, "multi-missing-default", {
			projectId,
			deviceId: defaultDevice.body.device.id,
			deviceIds: [secondaryDevice.body.device.id],
		});
		expect(missingDefault.response.status).toBe(400);

		const tooMany = await provisionNarrator(token, "multi-too-many", {
			projectId,
			deviceId: defaultDevice.body.device.id,
			deviceIds: Array.from({ length: 17 }, () => defaultDevice.body.device.id),
		});
		expect(tooMany.response.status).toBe(400);

		// De-projectization: a device owned by the same grant may now be bound to a
		// narrator regardless of its project anchor. Grant ownership is the boundary.
		const otherProjectMember = await provisionNarrator(token, "multi-other-project-member", {
			projectId,
			deviceId: defaultDevice.body.device.id,
			deviceIds: [defaultDevice.body.device.id, otherProjectDevice.body.device.id],
		});
		expect(otherProjectMember.response.status).toBe(201);
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
		expect(replay.body).toMatchObject({
			created: false,
			narrator: { id: first.body.narrator.id, title: "Same narrator title" },
		});

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
		const bindings = await db.query.integrationResourceBindings.findMany({
			where: and(
				eq(integrationResourceBindings.authorityId, grant.id),
				eq(integrationResourceBindings.resourceType, "narrator"),
				eq(integrationResourceBindings.provisionKey, "concurrent-narrator-key"),
			),
		});
		expect(bindings).toHaveLength(1);
		const rows = await db.query.narrators.findMany({
			where: eq(narrators.id, bindings[0]?.resourceId ?? ""),
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ oauthOwnerGrantId: null, oauthProvisionKey: null });
	});

	test("rejects narrator replays with different critical provisioning semantics", async () => {
		const projectA = await createProject("narrator-identity-a");
		const projectB = await createProject("narrator-identity-b");
		const policy = {
			...DEFAULT_POLICY,
			defaultPermissionMode: "readOnly",
			allowedPermissionModes: ["readOnly", "dontAsk"],
			systemPromptMode: "append",
			maxSystemPromptChars: 100,
		};
		const client = await createClient("narrator-identity", policy);
		const grant = await createGrant({
			client,
			label: "narrator-identity",
			projectIds: [projectA, projectB],
			policy,
		});
		const token = await oauthToken(grant);
		const deviceA = await provisionDevice(token, "narrator-identity-device-a", {
			projectId: projectA,
		});
		const deviceA2 = await provisionDevice(token, "narrator-identity-device-a2", {
			projectId: projectA,
		});
		const deviceB = await provisionDevice(token, "narrator-identity-device-b", {
			projectId: projectB,
		});
		const base = {
			projectId: projectA,
			deviceId: deviceA.body.device.id,
			permissionMode: "readOnly",
			systemPrompt: "original prompt",
			title: "Original narrator title",
		};
		const first = await provisionNarrator(token, "narrator-identity", base);
		expect(first.response.status).toBe(201);
		const displayReplay = await provisionNarrator(token, "narrator-identity", {
			...base,
			title: "Ignored replay title",
		});
		expect(displayReplay.response.status).toBe(200);
		expect(displayReplay.body).toMatchObject({
			created: false,
			narrator: { id: first.body.narrator.id, title: "Original narrator title" },
		});
		const binding = await db.query.integrationResourceBindings.findFirst({
			where: and(
				eq(integrationResourceBindings.resourceType, "narrator"),
				eq(integrationResourceBindings.resourceId, first.body.narrator.id),
			),
		});
		expect(binding?.metadataJson).toMatchObject({
			provisionIdentity: {
				version: 1,
				algorithm: "sha256",
				digest: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(JSON.stringify(binding?.metadataJson)).not.toContain("original prompt");

		const mismatches = [
			{ ...base, projectId: projectB, deviceId: deviceB.body.device.id },
			{ ...base, deviceId: deviceA2.body.device.id },
			{ ...base, permissionMode: "dontAsk" },
			{ ...base, systemPrompt: "different prompt" },
		];
		for (const mismatch of mismatches) {
			const response = await provisionNarrator(token, "narrator-identity", mismatch);
			expect(response.response.status).toBe(409);
			expect((response.body as unknown as { code?: string }).code).toBe(
				"RESOURCE_PROVISION_CONFLICT",
			);
		}
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
			oauthOwnerGrantId: null,
			oauthProvisionKey: null,
		});
		const managedBinding = await db.query.integrationResourceBindings.findFirst({
			where: and(
				eq(integrationResourceBindings.resourceType, "narrator"),
				eq(integrationResourceBindings.resourceId, managed.body.narrator.id),
			),
		});
		expect(managedBinding).toMatchObject({
			authorityId: managedGrant.id,
			provisionKey: "managed-narrator",
			state: "active",
		});
		expect(managedRow?.systemPrompt).toBeNull();
		expect(managedRow?.oauthPolicySnapshotJson).toEqual({
			version: 2,
			policy: DEFAULT_POLICY,
			permissionMode: "readOnly",
			systemPrompt: null,
			// The policy leaves allowDangerReflectionPrompt closed, so nothing is frozen here.
			dangerReflectionPrompt: null,
			projectId,
			defaultDeviceId: managedDevice.body.device.id,
			deviceIds: [managedDevice.body.device.id],
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
			version: 2,
			policy: { ...appendPolicy, allowedPermissionModes: ["dontAsk", "readOnly"] },
			permissionMode: "dontAsk",
			systemPrompt: "12345678",
			dangerReflectionPrompt: null,
			projectId,
			defaultDeviceId: appendDevice.body.device.id,
			deviceIds: [appendDevice.body.device.id],
		});

		const tooLong = await provisionNarrator(appendToken, "append-too-long", {
			projectId,
			deviceId: appendDevice.body.device.id,
			systemPrompt: "123456789",
		});
		expect(tooLong.response.status).toBe(400);
	});

	// readOnly/dontAsk deny every call needing confirmation, which leaves a headless client
	// unable to run even read-only inspection. bypassPermissions is the opt-in that routes
	// those calls into the danger reflection loop instead.
	test("accepts bypassPermissions and a danger reflection prompt only when the policy opts in", async () => {
		const projectId = await createProject("narrator-bypass-policy");
		const bypassPolicy = {
			...DEFAULT_POLICY,
			defaultPermissionMode: "bypassPermissions",
			allowedPermissionModes: ["bypassPermissions", "readOnly"],
			allowDangerReflectionPrompt: true,
			maxDangerReflectionPromptChars: 32,
		};
		const client = await createClient("narrator-bypass-policy", bypassPolicy);
		const grant = await createGrant({
			client,
			label: "narrator-bypass-policy",
			projectIds: [projectId],
			policy: bypassPolicy,
		});
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "bypass-device", { projectId });

		const provisioned = await provisionNarrator(token, "bypass-narrator", {
			projectId,
			deviceId: device.body.device.id,
			permissionMode: "bypassPermissions",
			dangerReflectionPrompt: "field diagnostics",
		});
		expect(provisioned.response.status).toBe(201);
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, provisioned.body.narrator.id),
		});
		expect(row?.permissionMode).toBe("bypassPermissions");
		expect(row?.oauthPolicySnapshotJson).toMatchObject({
			permissionMode: "bypassPermissions",
			dangerReflectionPrompt: "field diagnostics",
		});

		const tooLong = await provisionNarrator(token, "bypass-prompt-too-long", {
			projectId,
			deviceId: device.body.device.id,
			permissionMode: "bypassPermissions",
			dangerReflectionPrompt: "x".repeat(33),
		});
		expect(tooLong.response.status).toBe(400);

		// A client without the capability may not smuggle the appendix in.
		const closedProjectId = await createProject("narrator-bypass-closed");
		const closedClient = await createClient("narrator-bypass-closed");
		const closedGrant = await createGrant({
			client: closedClient,
			label: "narrator-bypass-closed",
			projectIds: [closedProjectId],
		});
		const closedToken = await oauthToken(closedGrant);
		const closedDevice = await provisionDevice(closedToken, "closed-device", {
			projectId: closedProjectId,
		});
		const rejectedPrompt = await provisionNarrator(closedToken, "closed-prompt", {
			projectId: closedProjectId,
			deviceId: closedDevice.body.device.id,
			dangerReflectionPrompt: "should be refused",
		});
		expect(rejectedPrompt.response.status).toBe(403);

		// Likewise, a mode the policy never allowed stays refused.
		const rejectedMode = await provisionNarrator(closedToken, "closed-mode", {
			projectId: closedProjectId,
			deviceId: closedDevice.body.device.id,
			permissionMode: "bypassPermissions",
		});
		expect(rejectedMode.response.status).toBe(403);
	});
});

describe("External v1 narrator failure visibility", () => {
	test("exposes substatus and redacted errorMessage so a failed turn is not silent", async () => {
		const projectId = await createProject("failure-visibility");
		const client = await createClient("failure-visibility");
		const grant = await createGrant({
			client,
			label: "failure-visibility",
			projectIds: [projectId],
		});
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "failure-device", { projectId });
		const provisioned = await provisionNarrator(token, "failure-narrator", {
			projectId,
			deviceId: device.body.device.id,
		});
		const narratorId = provisioned.body.narrator.id;

		// A clean narrator reports no failure and no substatus tags.
		const clean = await app.request(`/api/external/v1/narrators/${narratorId}`, {
			headers: bearer(token),
		});
		expect(clean.status).toBe(200);
		// GET /narrators/:id returns the DTO directly, not wrapped in { narrator }.
		const cleanBody = (await clean.json()) as {
			substatus: string[];
			errorMessage: string | null;
		};
		expect(cleanBody.substatus).toEqual([]);
		expect(cleanBody.errorMessage).toBeNull();

		// Simulate what an upstream 429 / timeout leaves behind: status back to idle,
		// substatus ["error"], errorMessage set. Previously this facade reported plain
		// `idle` with no new assistant message, so clients rendered "done".
		await db
			.update(narrators)
			.set({
				status: "idle",
				substatus: JSON.stringify(["error"]),
				errorMessage: "Upstream rate limited: Authorization: Bearer super-secret-token",
			})
			.where(eq(narrators.id, narratorId));

		const failed = await app.request(`/api/external/v1/narrators/${narratorId}`, {
			headers: bearer(token),
		});
		expect(failed.status).toBe(200);
		const failedBody = (await failed.json()) as {
			status: string;
			substatus: string[];
			errorMessage: string | null;
			errorRetryable: boolean | null;
		};
		expect(failedBody.status).toBe("idle");
		expect(failedBody.substatus).toEqual(["error"]);
		expect(failedBody.errorMessage).toContain("Upstream rate limited");
		// The message may embed provider payloads, so it must be redacted on the way out.
		expect(failedBody.errorMessage).not.toContain("super-secret-token");
		// Unknown retryability must stay null rather than defaulting to a guess.
		expect(failedBody.errorRetryable).toBeNull();

		await db.update(narrators).set({ errorRetryable: true }).where(eq(narrators.id, narratorId));
		const retryable = await app.request(`/api/external/v1/narrators/${narratorId}`, {
			headers: bearer(token),
		});
		expect(((await retryable.json()) as { errorRetryable: boolean | null }).errorRetryable).toBe(
			true,
		);

		// Recovering clears both the message and the flag; a stale flag alone would mislead.
		await db
			.update(narrators)
			.set({ status: "idle", substatus: "[]", errorMessage: null })
			.where(eq(narrators.id, narratorId));
		const recovered = await app.request(`/api/external/v1/narrators/${narratorId}`, {
			headers: bearer(token),
		});
		const recoveredBody = (await recovered.json()) as {
			errorMessage: string | null;
			errorRetryable: boolean | null;
		};
		expect(recoveredBody.errorMessage).toBeNull();
		expect(recoveredBody.errorRetryable).toBeNull();
	});

	test("exposes bounded per-message usage without leaking payloads", async () => {
		const projectId = await createProject("usage");
		const client = await createClient("usage");
		const grant = await createGrant({ client, label: "usage", projectIds: [projectId] });
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "usage-device", { projectId });
		const provisioned = await provisionNarrator(token, "usage-narrator", {
			projectId,
			deviceId: device.body.device.id,
		});
		const narratorId = provisioned.body.narrator.id;
		const now = new Date().toISOString();

		const userMessageId = generateId();
		const assistantMessageId = generateId();
		await db.insert(narratorMessages).values([
			{
				id: userMessageId,
				narratorId,
				role: "user",
				contentJson: [{ type: "text", text: "查一下导航" }],
				contentText: "查一下导航",
				createdAt: now,
			},
			{
				id: assistantMessageId,
				narratorId,
				role: "assistant",
				contentJson: [{ type: "text", text: "已检查完成" }],
				contentText: "已检查完成",
				createdAt: now,
				tokensIn: 1_200,
				outputTokens: 340,
				reasoningTokens: 80,
				// Deliberately out of range: the projection must clamp it to 0-100.
				contextPercent: 142.5,
				durationMs: 4_100,
				ttftMs: 900,
			},
		]);
		await db.insert(narratorMessageRefs).values([
			{ id: generateId(), narratorId, messageId: userMessageId, seq: 0 },
			{ id: generateId(), narratorId, messageId: assistantMessageId, seq: 1 },
		]);

		const listed = await app.request(`/api/external/v1/narrators/${narratorId}/messages`, {
			headers: bearer(token),
		});
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as {
			items: Array<{
				role: string;
				usage?: {
					inputTokens?: number;
					outputTokens?: number;
					reasoningTokens?: number;
					contextPercent?: number;
					durationMs?: number;
					ttftMs?: number;
				};
			}>;
		};

		// A user message records nothing, so the key must be absent rather than an empty object.
		const user = body.items.find((item) => item.role === "user");
		expect(user).toBeDefined();
		expect(user?.usage).toBeUndefined();

		const assistant = body.items.find((item) => item.role === "assistant");
		expect(assistant?.usage).toEqual({
			inputTokens: 1_200,
			outputTokens: 340,
			reasoningTokens: 80,
			contextPercent: 100,
			durationMs: 4_100,
			ttftMs: 900,
		});
	});

	test("accepts an explicit locale and rejects unsupported values", async () => {
		const projectId = await createProject("locale");
		const client = await createClient("locale");
		const grant = await createGrant({ client, label: "locale", projectIds: [projectId] });
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "locale-device", { projectId });
		const provisioned = await provisionNarrator(token, "locale-narrator", {
			projectId,
			deviceId: device.body.device.id,
		});
		const narratorId = provisioned.body.narrator.id;

		// The locale selects the language of prompts injected into the narrator context,
		// so a Chinese session must be able to declare it instead of always getting "en".
		const accepted = await app.request(`/api/external/v1/narrators/${narratorId}/messages`, {
			method: "POST",
			headers: jsonHeaders(token),
			body: JSON.stringify({ message: "查一下导航日志", locale: "zh-CN" }),
		});
		expect(accepted.status).toBe(202);

		const rejected = await app.request(`/api/external/v1/narrators/${narratorId}/messages`, {
			method: "POST",
			headers: jsonHeaders(token),
			body: JSON.stringify({ message: "hello", locale: "klingon" }),
		});
		expect(rejected.status).toBe(400);
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
		// `interrupted: false` is the honest answer when nothing was running. Dropping this
		// boolean previously let clients render "stopped" for a stop that had no effect.
		expect(await interrupt.json()).toEqual({ success: true, interrupted: false });
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
					["id", "seq", "role", "text", "createdAt", "textTruncated", "usage"].includes(key),
				),
			).toBe(true);
		}
		// The envelope gained fields, but the default tier is still the legacy text
		// projection: a client written before the layered tiers existed must keep
		// getting exactly the item shape it parses today.
		expect(first.detail).toBe("text");
		expect(first.detailRequested).toBeUndefined();
		expect(typeof first.documentRevision).toBe("number");

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

describe("External v1 layered message detail", () => {
	interface LayeredFixture {
		narratorId: string;
		assistantMessageId: string;
		compactMessageId: string;
	}

	async function seedLayeredNarrator(
		label: string,
		options: { scopes?: string[]; policy?: Record<string, unknown> } = {},
	): Promise<LayeredFixture & { token: string }> {
		const projectId = await createProject(label);
		const client = await createClient(label, options.policy ?? DEFAULT_POLICY);
		const grant = await createGrant({
			client,
			label,
			projectIds: [projectId],
			...(options.scopes ? { scopes: options.scopes } : {}),
			...(options.policy ? { policy: options.policy } : {}),
		});
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, `${label}-device`, { projectId });
		const provisioned = await provisionNarrator(token, `${label}-narrator`, {
			projectId,
			deviceId: device.body.device.id,
		});
		const narratorId = provisioned.body.narrator.id;
		const now = Date.now();
		const userMessageId = generateId();
		const assistantMessageId = generateId();
		const compactMessageId = generateId();
		await db.insert(narratorMessages).values([
			{
				id: userMessageId,
				narratorId,
				role: "user" as const,
				contentJson: [{ type: "text", text: "please inspect the robot" }],
				contentText: "please inspect the robot",
				createdAt: new Date(now).toISOString(),
			},
			{
				id: assistantMessageId,
				narratorId,
				role: "assistant" as const,
				contentJson: [
					{ type: "thinking", thinking: "**Check the logs**\n\nThe drive reported a fault." },
					{ type: "text", text: "Running diagnostics." },
					{
						type: "tool_use",
						id: "layered-bash",
						name: "Bash",
						input: { command: "systemctl status robot" },
					},
					{
						type: "tool_use",
						id: "layered-agent",
						name: "Agent",
						input: { subagent_type: "explore", description: "trace the fault" },
					},
				],
				contentText: "Running diagnostics.",
				reasoningTokens: 128,
				createdAt: new Date(now + 1).toISOString(),
			},
			{
				id: compactMessageId,
				narratorId,
				role: "system" as const,
				contentJson: [{ type: "compact", status: "compacted", summary: "internal compact prose" }],
				contentText: "internal compact prose",
				createdAt: new Date(now + 2).toISOString(),
			},
		]);
		await db.insert(narratorMessageRefs).values([
			{ id: generateId(), narratorId, messageId: userMessageId, seq: 1 },
			{ id: generateId(), narratorId, messageId: assistantMessageId, seq: 2 },
			{ id: generateId(), narratorId, messageId: compactMessageId, seq: 3, isCompact: 1 },
		]);
		await db.insert(narratorToolCalls).values([
			{
				id: generateId(),
				narratorId,
				messageId: assistantMessageId,
				toolUseId: "layered-bash",
				toolName: "Bash",
				inputJson: { command: "systemctl status robot" },
				outputJson: { stdout: "layered-output-secret" },
				status: "success" as const,
				durationMs: 42,
				createdAt: new Date(now + 1).toISOString(),
				completedAt: new Date(now + 2).toISOString(),
			},
			{
				id: generateId(),
				narratorId,
				messageId: assistantMessageId,
				toolUseId: "layered-agent",
				toolName: "Agent",
				inputJson: { subagent_type: "explore", description: "trace the fault" },
				status: "running" as const,
				createdAt: new Date(now + 1).toISOString(),
			},
		]);
		return { narratorId, assistantMessageId, compactMessageId, token };
	}

	async function fetchPage(
		token: string,
		narratorId: string,
		query: string,
	): Promise<{ status: number; body: LayeredMessagePage }> {
		const response = await app.request(
			`/api/external/v1/narrators/${narratorId}/messages?${query}`,
			{ headers: bearer(token) },
		);
		return { status: response.status, body: (await response.json()) as LayeredMessagePage };
	}

	test("refuses structural tiers without message.summary.read", async () => {
		const fixture = await seedLayeredNarrator("no-msg-scope", { scopes: NO_MESSAGE_SCOPES });
		for (const detail of ["skeleton", "summary", "full"]) {
			const response = await app.request(
				`/api/external/v1/narrators/${fixture.narratorId}/messages?detail=${detail}`,
				{ headers: bearer(fixture.token) },
			);
			expect(response.status).toBe(403);
			expect(await responseCode(response)).toBe("INSUFFICIENT_SCOPE");
		}
		// The legacy tier stays reachable on narrator.read alone.
		const legacy = await fetchPage(fixture.token, fixture.narratorId, "limit=10");
		expect(legacy.status).toBe(200);
		expect(legacy.body.detail).toBe("text");
	});

	test("skeleton returns bounded scalars with no prose or payloads", async () => {
		const fixture = await seedLayeredNarrator("skeleton");
		const { status, body } = await fetchPage(
			fixture.token,
			fixture.narratorId,
			"detail=skeleton&limit=10",
		);
		expect(status).toBe(200);
		expect(body.detail).toBe("skeleton");
		const assistant = body.items.find((item) => item.id === fixture.assistantMessageId);
		expect(assistant).toBeDefined();
		expect(assistant?.textChars).toBe("Running diagnostics.".length);
		expect(assistant?.text).toBeUndefined();
		expect(assistant?.reasoning).toEqual({ tokens: 128 });
		// One Bash call plus one Agent spawn: the subagent is counted separately, not
		// as a tool, so a client's "N tool calls" line matches the UI's.
		expect(assistant?.tools).toEqual({
			count: 1,
			running: 0,
			failed: 0,
			awaitingPermission: 0,
		});
		expect(assistant?.subagents).toEqual({ count: 1 });
		const serialized = JSON.stringify(body);
		for (const forbidden of [
			"layered-output-secret",
			"systemctl status robot",
			"Check the logs",
			"Running diagnostics",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	test("summary exposes structure and identity but never payload bodies", async () => {
		const fixture = await seedLayeredNarrator("summary");
		const { status, body } = await fetchPage(
			fixture.token,
			fixture.narratorId,
			"detail=summary&limit=10",
		);
		expect(status).toBe(200);
		expect(body.detail).toBe("summary");
		const assistant = body.items.find((item) => item.id === fixture.assistantMessageId);
		expect(assistant?.text).toBe("Running diagnostics.");
		expect(assistant?.reasoning.steps).toEqual([
			{ title: "Check the logs", chars: "The drive reported a fault.".length },
		]);
		const bash = assistant?.tools.items?.find((item) => item.toolUseId === "layered-bash");
		expect(bash).toMatchObject({
			name: "Bash",
			target: "systemctl status robot",
			status: "success",
			hasDetail: true,
		});
		expect(bash?.input).toBeUndefined();
		expect(bash?.output).toBeUndefined();
		expect(bash?.outputBytes).toBeGreaterThan(0);
		expect(assistant?.subagents.items?.[0]).toMatchObject({
			toolUseId: "layered-agent",
			type: "explore",
		});
		// The reasoning STEP BODY is a payload-class field, so it stays absent here
		// even though the step title is present.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("layered-output-secret");
		expect(serialized).not.toContain("The drive reported a fault.");
	});

	test("system rows surface as compact markers without their internal prose", async () => {
		const fixture = await seedLayeredNarrator("compact-marker");
		const { body } = await fetchPage(fixture.token, fixture.narratorId, "detail=summary&limit=10");
		const compact = body.items.find((item) => item.id === fixture.compactMessageId);
		expect(compact).toMatchObject({ role: "system", kind: "compact" });
		expect(compact?.text).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("internal compact prose");
	});

	test("degrades full to summary when only the summary scope is held", async () => {
		const fixture = await seedLayeredNarrator("degrade-scope", {
			scopes: SUMMARY_ONLY_SCOPES,
			policy: { ...DEFAULT_POLICY, messageDetail: "full" },
		});
		const { status, body } = await fetchPage(
			fixture.token,
			fixture.narratorId,
			"detail=full&limit=5",
		);
		expect(status).toBe(200);
		expect(body.detail).toBe("summary");
		expect(body.detailRequested).toBe("full");
		expect(JSON.stringify(body)).not.toContain("layered-output-secret");
	});

	test("degrades full to summary when the policy ceiling stays at summary", async () => {
		const fixture = await seedLayeredNarrator("degrade-policy");
		const { body } = await fetchPage(fixture.token, fixture.narratorId, "detail=full&limit=5");
		expect(body.detail).toBe("summary");
		expect(body.detailRequested).toBe("full");
		expect(JSON.stringify(body)).not.toContain("layered-output-secret");
	});

	test("refuses structural tiers when the policy forbids them outright", async () => {
		const fixture = await seedLayeredNarrator("policy-none", {
			policy: { ...DEFAULT_POLICY, messageDetail: "none" },
		});
		const response = await app.request(
			`/api/external/v1/narrators/${fixture.narratorId}/messages?detail=summary`,
			{ headers: bearer(fixture.token) },
		);
		expect(response.status).toBe(403);
		expect(await responseCode(response)).toBe("OAUTH_POLICY_FORBIDDEN");
	});

	test("full returns projected payloads once both ceilings allow it", async () => {
		const fixture = await seedLayeredNarrator("full-tier", {
			policy: { ...DEFAULT_POLICY, messageDetail: "full" },
		});
		const { status, body } = await fetchPage(
			fixture.token,
			fixture.narratorId,
			"detail=full&limit=5",
		);
		expect(status).toBe(200);
		expect(body.detail).toBe("full");
		expect(body.detailRequested).toBeUndefined();
		const assistant = body.items.find((item) => item.id === fixture.assistantMessageId);
		const bash = assistant?.tools.items?.find((item) => item.toolUseId === "layered-bash");
		expect(bash?.input).toEqual({ command: "systemctl status robot" });
		expect(bash?.output).toEqual({ stdout: "layered-output-secret" });
		expect(assistant?.reasoning.steps?.[0]?.body).toBe("The drive reported a fault.");
	});

	test("truncates an oversized payload leaf instead of dropping or inlining it whole", async () => {
		const fixture = await seedLayeredNarrator("full-truncate", {
			policy: { ...DEFAULT_POLICY, messageDetail: "full" },
		});
		// Above the 4KB per-leaf budget but below the 64KB select guard, so the row is
		// read and projected rather than skipped.
		const huge = "z".repeat(8 * 1024);
		await db
			.update(narratorToolCalls)
			.set({ outputJson: { stdout: huge } })
			.where(
				and(
					eq(narratorToolCalls.narratorId, fixture.narratorId),
					eq(narratorToolCalls.toolUseId, "layered-bash"),
				),
			);
		const { body } = await fetchPage(fixture.token, fixture.narratorId, "detail=full&limit=5");
		const assistant = body.items.find((item) => item.id === fixture.assistantMessageId);
		const bash = assistant?.tools.items?.find((item) => item.toolUseId === "layered-bash");
		expect((bash as { outputTruncated?: boolean } | undefined)?.outputTruncated).toBe(true);
		const output = bash?.output as { stdout?: { _truncated?: boolean; fullLength?: number } };
		expect(output.stdout?._truncated).toBe(true);
		expect(output.stdout?.fullLength).toBe(huge.length);
	});

	test("caps the page size per tier", async () => {
		const fixture = await seedLayeredNarrator("tier-limits", {
			policy: { ...DEFAULT_POLICY, messageDetail: "full" },
		});
		const cases: Array<[string, number, number]> = [
			["skeleton", 50, 51],
			["summary", 30, 31],
			["full", 10, 11],
		];
		for (const [detail, accepted, rejected] of cases) {
			const ok = await app.request(
				`/api/external/v1/narrators/${fixture.narratorId}/messages?detail=${detail}&limit=${accepted}`,
				{ headers: bearer(fixture.token) },
			);
			expect(ok.status).toBe(200);
			const bad = await app.request(
				`/api/external/v1/narrators/${fixture.narratorId}/messages?detail=${detail}&limit=${rejected}`,
				{ headers: bearer(fixture.token) },
			);
			expect(bad.status).toBe(400);
		}
	});

	test("walks older messages with order=desc without overlap or gaps", async () => {
		const fixture = await seedLayeredNarrator("desc-order");
		const first = await fetchPage(
			fixture.token,
			fixture.narratorId,
			"detail=skeleton&order=desc&limit=2",
		);
		expect(first.body.items.map((item) => item.seq)).toEqual([3, 2]);
		expect(first.body.nextCursor).not.toBeNull();
		const second = await fetchPage(
			fixture.token,
			fixture.narratorId,
			`detail=skeleton&order=desc&limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
		);
		expect(second.body.items.map((item) => item.seq)).toEqual([1]);
		expect(second.body.nextCursor).toBeNull();
	});

	test("serves the tool drill-down only with the content scope and a full policy", async () => {
		const summaryOnly = await seedLayeredNarrator("drill-summary");
		const denied = await app.request(
			`/api/external/v1/narrators/${summaryOnly.narratorId}/tool-calls/layered-bash`,
			{ headers: bearer(summaryOnly.token) },
		);
		expect(denied.status).toBe(403);
		expect(await responseCode(denied)).toBe("OAUTH_POLICY_FORBIDDEN");

		const noScope = await seedLayeredNarrator("drill-no-scope", {
			scopes: SUMMARY_ONLY_SCOPES,
			policy: { ...DEFAULT_POLICY, messageDetail: "full" },
		});
		const missingScope = await app.request(
			`/api/external/v1/narrators/${noScope.narratorId}/tool-calls/layered-bash`,
			{ headers: bearer(noScope.token) },
		);
		expect(missingScope.status).toBe(403);
		expect(await responseCode(missingScope)).toBe("INSUFFICIENT_SCOPE");

		const allowed = await seedLayeredNarrator("drill-full", {
			policy: { ...DEFAULT_POLICY, messageDetail: "full" },
		});
		const response = await app.request(
			`/api/external/v1/narrators/${allowed.narratorId}/tool-calls/layered-bash`,
			{ headers: bearer(allowed.token) },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			toolUseId: "layered-bash",
			name: "Bash",
			status: "success",
			target: "systemctl status robot",
			input: { command: "systemctl status robot" },
			output: { stdout: "layered-output-secret" },
			inputTruncated: false,
			outputTruncated: false,
		});

		// A tool id belonging to another grant's narrator is a 404, not a 403: the
		// facade must not confirm that the resource exists.
		const crossGrant = await app.request(
			`/api/external/v1/narrators/${summaryOnly.narratorId}/tool-calls/layered-bash`,
			{ headers: bearer(allowed.token) },
		);
		expect(crossGrant.status).toBe(404);
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

		const authority = await integrationAuthorityService.requireSnapshot(grant.id);
		await integrationAuthorityService.revoke({
			authorityId: grant.id,
			expectedRevision: authority.authority.revision,
			reason: "test revocation",
		});
		const after = await app.request("/api/external/v1/projects", { headers: bearer(token) });
		expect(after.status).toBe(401);
	});

	test("keeps grant-owned devices accessible after project removal (grant-ownership boundary)", async () => {
		// De-projectization: removing a project from a grant no longer hides devices the
		// grant owns. Grant ownership (the resource binding), not the project allow-list,
		// is the isolation boundary. Only grant revocation tears down access.
		const projectId = await createProject("project-removal");
		const client = await createClient("project-removal");
		const grant = await createGrant({ client, label: "project-removal", projectIds: [projectId] });
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "project-removal-device", { projectId });
		expect(device.response.status).toBe(201);

		await replaceGrantProjects(
			grant,
			grant.projectIds.filter((candidate) => candidate !== projectId),
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
		expect(deviceList.items.some((item) => item.id === device.body.device.id)).toBe(true);
		const directAfter = await app.request(`/api/external/v1/devices/${device.body.device.id}`, {
			headers: bearer(token),
		});
		expect(directAfter.status).toBe(200);
	});

	test("keeps grant-owned global devices accessible after project removal", async () => {
		const projectId = await createProject("global-project-removal");
		const remainingProjectId = await createProject("global-project-remaining");
		const policy = { ...DEFAULT_POLICY, allowGlobalDevice: true };
		const client = await createClient("global-project-removal", policy);
		const grant = await createGrant({
			client,
			label: "global-project-removal",
			projectIds: [projectId, remainingProjectId],
			policy,
		});
		const token = await oauthToken(grant);
		const device = await provisionDevice(token, "global-project-removal-device", {
			projectId,
			scope: "global",
		});
		expect(device.response.status).toBe(201);
		expect(device.body.device.projectId).toBe(projectId);

		await replaceGrantProjects(
			grant,
			grant.projectIds.filter((candidate) => candidate !== projectId),
		);
		const listAfter = (await (
			await app.request("/api/external/v1/devices", { headers: bearer(token) })
		).json()) as { items: Array<{ id: string }>; nextCursor: string | null };
		// De-projectization: the grant-owned global device remains visible after its
		// anchor project is removed, since grant ownership (not project) is the boundary.
		expect(listAfter.items.some((item) => item.id === device.body.device.id)).toBe(true);
		const directAfter = await app.request(`/api/external/v1/devices/${device.body.device.id}`, {
			headers: bearer(token),
		});
		expect(directAfter.status).toBe(200);
	});
});

afterAll(async () => {
	const narratorIds = [...cleanup.narratorIds];
	const deviceIds = [...cleanup.deviceIds];
	const resourceIds = [...narratorIds, ...deviceIds];
	if (resourceIds.length > 0) {
		await db
			.delete(integrationResourceBindings)
			.where(inArray(integrationResourceBindings.resourceId, resourceIds));
	}
	if (narratorIds.length > 0) {
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, narratorIds));
		await db
			.delete(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.narratorId, narratorIds));
		await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, narratorIds));
		await db.delete(narrators).where(inArray(narrators.id, narratorIds));
	}
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
		await db.delete(integrationAuthorities).where(inArray(integrationAuthorities.id, grantIds));
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
