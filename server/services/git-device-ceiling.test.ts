import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { GitWorkspace } from "@shared/git-workspace";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { type DeviceOperationLevel, normalizeOAuthClientPolicy } from "../lib/oauth-client-policy";

// Schema-derived in-memory DB, actual auth rows,
// actual OAuth/device/narrator/workspace/Git authorization and HTTP handlers.
// Only remote availability/path identity/Git RPC are simulated: no actual Git,
// shell commands, remote hardware, PTY, or policy/authorization mocks.
const sqlite = new Database(":memory:");
const dialect = new SQLiteSyncDialect();
const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
for (const table of tables) {
	const config = getTableConfig(table);
	const columns = config.columns.map((column) => {
		const value = column.default;
		let defaultSql = "";
		if (value !== undefined) {
			const literal =
				typeof value === "object" && value !== null && "queryChunks" in value
					? dialect.sqlToQuery(value as Parameters<typeof dialect.sqlToQuery>[0]).sql
					: typeof value === "string"
						? `'${value.replaceAll("'", "''")}'`
						: typeof value === "boolean"
							? Number(value)
							: value === null
								? "NULL"
								: typeof value === "object"
									? `'${JSON.stringify(value).replaceAll("'", "''")}'`
									: value;
			defaultSql = ` DEFAULT ${literal}`;
		}
		return `"${column.name}" ${column.getSQLType()} ${column.primary ? "PRIMARY KEY" : ""} ${column.notNull ? "NOT NULL" : ""}${defaultSql}`;
	});
	sqlite.run(`CREATE TABLE "${config.name}" (${columns.join(",")})`);
}
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
mock.module("../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const { insertInitialDeviceWorkspaceBinding } = await import(
	"../services/narrator-device-workspace-store"
);
const deviceConnection = await import("../services/device-connection-service");
const { setRemoteBackendResolver } = await import("../lib/agent/execution/registry");
const { narratorGitRoutes } = await import("../routes/git");
const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
const { resolveOAuthDeviceRuntimeAuthorization } = await import(
	"../services/oauth-device-runtime-policy"
);
const { resolveOAuthNarratorRuntimePolicy } = await import(
	"../services/oauth-narrator-runtime-policy"
);

let actorId: string;
let narratorId: string;
let deviceId: string;
let clientId: string;
let grantId: string;
let restoreOnline: (() => void) | undefined;
let operations: string[] = [];
let writeDispatches: string[] = [];
let revokeAfterProbe = 0;
const cwd = "/scratch/remote/repo";
function policy(level: DeviceOperationLevel) {
	return normalizeOAuthClientPolicy({
		deviceAccess: { host: "denied", global: "readWrite", selfRegistered: level },
	});
}

beforeEach(async () => {
	for (const table of tables) sqlite.run(`DELETE FROM "${getTableConfig(table).name}"`);
	[actorId, narratorId, deviceId, clientId, grantId] = Array.from({ length: 5 }, generateId);
	operations = [];
	writeDispatches = [];
	revokeAfterProbe = 0;
	const now = new Date().toISOString();
	await db.insert(schema.users).values({
		id: actorId,
		username: actorId,
		passwordHash: "fixture",
		role: "user",
		gitUsername: "Scratch actor",
		gitEmail: "scratch@example.invalid",
		createdAt: now,
	});
	await db.insert(schema.narrators).values({
		id: narratorId,
		ownerUserId: actorId,
		cwd,
		defaultDeviceId: deviceId,
		visibility: "private",
		writeAudience: "owner",
		createdAt: now,
		updatedAt: now,
	});
	let context: WorkspaceContext = {
		revision: 0,
		contextKey: `scratch:${narratorId}`,
		deviceId,
		cwd,
		pathFlavor: "posix",
		capabilities: { switchDirectory: true },
	};
	context = insertInitialDeviceWorkspaceBinding(db, { narratorId, context, createdAt: now });
	await db
		.update(schema.narrators)
		.set({
			workspaceContext: context,
			workspaceRevision: context.revision,
		})
		.where(eq(schema.narrators.id, narratorId));
	await db.insert(schema.oauthClients).values({
		id: clientId,
		clientId,
		name: "scratch device client",
		publicClient: true,
		redirectUris: [],
		scopes: ["device.provision", "narrator.send_message"],
		grantTypes: ["authorization_code"],
		policyJson: policy("readWrite"),
		createdBy: actorId,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.integrationAuthorities).values({
		id: grantId,
		kind: "oauth_grant",
		integrationType: "oauth_client",
		integrationId: clientId,
		ownerUserId: actorId,
		state: "active",
		policyJson: policy("readWrite"),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.remoteDevices).values({
		id: deviceId,
		name: "scratch OAuth-owned private device",
		slug: deviceId,
		tokenHash: "scratch",
		tokenPrefix: "scratch",
		scope: "global",
		ownerScope: "private",
		createdBy: actorId,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.integrationResourceBindings).values({
		id: generateId(),
		resourceType: "device",
		resourceId: deviceId,
		sourceType: "oauth_client",
		sourceId: clientId,
		authorityType: "oauth_grant",
		authorityId: grantId,
		state: "active",
		createdAt: now,
		updatedAt: now,
	});
	const online = spyOn(deviceConnection, "isDeviceOnline").mockReturnValue(true);
	restoreOnline = () => online.mockRestore();
	const backend = {
		kind: "remote",
		deviceId,
		paths: posixPathSemantics,
		pathFlavor: "posix",
		runtimeGeneration: 7,
		supportsGitWorkspace: true,
		resolvePathIdentity: async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path,
			exists: true,
			runtimeGeneration: 7,
		}),
		gitWorkspace: async (input: { cwd: string; operation: string }) => {
			expect(input.cwd).toBe(cwd);
			operations.push(input.operation);
			if (input.operation === "probe") {
				if (
					revokeAfterProbe &&
					operations.filter((op) => op === "probe").length === revokeAfterProbe
				) {
					await db
						.update(schema.oauthClients)
						.set({ policyJson: policy("readOnly") })
						.where(eq(schema.oauthClients.id, clientId));
					await db
						.update(schema.integrationAuthorities)
						.set({ policyJson: policy("readOnly") })
						.where(eq(schema.integrationAuthorities.id, grantId));
				}
				return { state: "ready", rootPath: cwd, repositoryPath: `${cwd}/.git`, branch: "main" };
			}
			if (input.operation === "stage" || input.operation === "commit") {
				writeDispatches.push(input.operation);
				return { stdout: input.operation === "commit" ? "a".repeat(40) : "" };
			}
			if (input.operation === "status") return { outputs: { status: "", branch: "main" } };
			throw new Error(`Unexpected simulated remote RPC: ${input.operation}`);
		},
	} as unknown as ExecutionBackend;
	setRemoteBackendResolver((id) => (id === deviceId ? backend : null));
});
afterEach(() => {
	restoreOnline?.();
	setRemoteBackendResolver(null);
});
afterAll(() => sqlite.close());

function app() {
	const result = new Hono();
	// Same authenticated route harness as git-workspace.test.ts: no OAuth
	// caller token. The real ordinary actor/narrator and device provenance rows
	// are independently loaded by production authorization, not this middleware.
	result.use("*", async (c, next) => {
		c.set("user", { sub: actorId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	result.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "TEST_ERROR",
				}),
				{
					status: error instanceof AppError ? error.statusCode : 500,
					headers: { "Content-Type": "application/json" },
				},
			),
	);
	result.route("/api/narrators", narratorGitRoutes);
	return result;
}

async function exercise(level: DeviceOperationLevel, operation: "stage" | "commit") {
	// Both live policy sources agree; authorization must enforce their ceiling.
	await db
		.update(schema.oauthClients)
		.set({ policyJson: policy(level) })
		.where(eq(schema.oauthClients.id, clientId));
	await db
		.update(schema.integrationAuthorities)
		.set({ policyJson: policy(level) })
		.where(eq(schema.integrationAuthorities.id, grantId));
	const device = await db.query.remoteDevices.findFirst({
		where: eq(schema.remoteDevices.id, deviceId),
	});
	if (!device) throw new Error("Missing real registered device");
	const authorization = await resolveOAuthDeviceRuntimeAuthorization(device);
	expect(authorization.oauthOwned).toBe(true);
	expect(authorization.policy?.deviceAccess.selfRegistered).toBe(level);
	expect(await resolveOAuthNarratorRuntimePolicy(narratorId, actorId)).toBeNull();
	const http = app();
	const base = `/api/narrators/${narratorId}/git`;
	const workspaceResponse = await http.request(`${base}/workspace`);
	const workspace = (await workspaceResponse.json()) as GitWorkspace;
	const response = await http.request(`${base}/${operation}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			workspaceKey: workspace.workspaceKey,
			...(operation === "stage" ? { all: true } : { message: "harmless simulated commit" }),
		}),
	});
	expect(workspaceResponse.status).toBe(level === "denied" ? 403 : 200);
	if (level !== "denied") {
		expect(workspace.capabilities).toMatchObject({ read: true, write: level === "readWrite" });
	} else {
		expect(operations).toEqual([]);
	}
	expect({ status: response.status, writes: writeDispatches.length }).toEqual({
		status: level === "readWrite" ? 200 : 403,
		writes: level === "readWrite" ? 1 : 0,
	});
}

describe("OAuth-owned device ceiling", () => {
	test("project endpoint still rejects explicit null and mismatched project hints", async () => {
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(schema.projects).values({
			id: projectId,
			name: "endpoint project",
			ownerUserId: actorId,
			createdAt: now,
			updatedAt: now,
		});
		await db
			.update(schema.narrators)
			.set({ contextProjectId: projectId })
			.where(eq(schema.narrators.id, narratorId));
		for (const contextProjectId of [null, "wrong-project"]) {
			await expect(
				narratorDeviceWorkspaceService.assertEndpointDeviceCurrent(narratorId, deviceId, {
					userId: actorId,
					contextProjectId,
				}),
			).rejects.toMatchObject({ statusCode: 403, code: "WORKSPACE_ACCESS_DENIED" });
		}
		await expect(
			narratorDeviceWorkspaceService.assertEndpointDeviceCurrent(narratorId, deviceId, {
				userId: actorId,
				contextProjectId: projectId,
			}),
		).resolves.toHaveProperty("assertStillCurrent");
	});
	test("standalone endpoint accepts an explicit null project source", async () => {
		await expect(
			narratorDeviceWorkspaceService.assertEndpointDeviceCurrent(narratorId, deviceId, {
				userId: actorId,
				contextProjectId: null,
			}),
		).resolves.toHaveProperty("assertStillCurrent");
	});
	test("device downgraded after initial write authorization cannot dispatch remote stage", async () => {
		const http = app();
		const base = `/api/narrators/${narratorId}/git`;
		const workspace = (await (await http.request(`${base}/workspace`)).json()) as GitWorkspace;
		revokeAfterProbe = 2;
		const response = await http.request(`${base}/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceKey: workspace.workspaceKey, all: true }),
		});
		expect(response.status).toBe(403);
		expect(writeDispatches).toEqual([]);
	});
	test("denied device cannot obtain a read endpoint proof", async () => {
		await db
			.update(schema.oauthClients)
			.set({ policyJson: policy("denied") })
			.where(eq(schema.oauthClients.id, clientId));
		await db
			.update(schema.integrationAuthorities)
			.set({ policyJson: policy("denied") })
			.where(eq(schema.integrationAuthorities.id, grantId));
		await expect(
			narratorDeviceWorkspaceService.assertEndpointDeviceCurrent(narratorId, deviceId, {
				userId: actorId,
			}),
		).rejects.toMatchObject({ statusCode: 403 });
	});
	test("readOnly device: stage is forbidden with zero write dispatch", () =>
		exercise("readOnly", "stage"));
	test("readOnly device: commit is forbidden with zero write dispatch", () =>
		exercise("readOnly", "commit"));
	test("denied device: stage is forbidden with zero write dispatch", () =>
		exercise("denied", "stage"));
	test("denied device: commit is forbidden with zero write dispatch", () =>
		exercise("denied", "commit"));
	test("readWrite device: stage succeeds with exactly one write dispatch", () =>
		exercise("readWrite", "stage"));
	test("readWrite device: commit succeeds with exactly one write dispatch", () =>
		exercise("readWrite", "commit"));
});
