import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { type DeviceOperationLevel, normalizeOAuthClientPolicy } from "../lib/oauth-client-policy";
import {
	insertInitialDeviceWorkspaceBinding,
	saveLegacyDeviceWorkspaceBinding,
} from "./narrator-device-workspace-store";

// The DB, device/narrator OAuth resolvers and ACLs are real. Transport, PTY,
// workspace-history admission and buffer IO are mocked: this is not native E2E.
const sqlite = new Database(":memory:");
const dialect = new SQLiteSyncDialect();
const tables = [
	schema.users,
	schema.projects,
	schema.chapters,
	schema.narrators,
	schema.terminals,
	schema.remoteDevices,
	schema.oauthClients,
	schema.integrationAuthorities,
	schema.integrationCapabilityGrants,
	schema.integrationResourceBindings,
	schema.aclGrants,
	schema.narratorDeviceWorkspaces,
	schema.narratorDeviceWorkspaceRequests,
	schema.workspaceSwitchRequests,
];
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
mock.module("../websocket/narrator-ws", () => ({
	broadcastToNarrator: () => {},
	broadcastToUser: () => {},
	broadcastToAll: () => {},
	broadcastToAdmins: () => {},
}));
mock.module("./narrator-session-state", () => ({
	activeNarrators: new Map(),
	compactLocks: new Set(),
	pendingDangerReflections: new Map(),
	pendingPermissions: new Map(),
	isNarratorRevertAdmissionBlocked: () => false,
	withNarratorMutationAdmission: async (_id: string, body: () => Promise<unknown>) => body(),
}));

let deviceId: string;
let actorId: string;
let narratorId: string;
let clientId: string;
let grantId: string;
let context: WorkspaceContext;
let afterIdentity: (() => Promise<void>) | undefined;
let afterCompile: (() => Promise<void>) | undefined;
let identityRequests: string[] = [];
let detachedLocal = false;
let afterSocketAlive: (() => Promise<void>) | undefined;
let afterDetachedDiscovery: (() => Promise<void>) | undefined;
let afterDetachedSignal: (() => Promise<void>) | undefined;
const detachedKill = mock(() => {});
const detachedKillSession = mock(
	async (_id: string, beforeDispatch?: () => void, onDispatch?: () => void) => {
		await afterDetachedDiscovery?.();
		beforeDispatch?.();
		onDispatch?.();
		detachedKill();
		await afterDetachedSignal?.();
	},
);
const write = mock((_data: string) => {});
const resize = mock((_cols: number, _rows: number) => {});
const kill = mock(() => {});
const nativePty = mock((_device: string, _options: unknown) => ({
	write,
	resize,
	kill,
	close: () => {},
	ready: Promise.resolve(),
	exited: new Promise<number | null>(() => {}),
}));
const hostPty = mock(() => {
	throw new Error("Must not fall back to host");
});
const registerActivity = mock(async (_input: unknown) => {});
const registerTerminalActivity = mock(async (_input: unknown) => {});
const finishActivity = mock(async (_input: unknown) => {});
const readBuffer = mock(async () => "original scrollback");
mock.module("./remote-tree-snapshot-hooks", () => ({
	registerRemoteActivity: registerActivity,
	registerRemoteTerminalActivity: registerTerminalActivity,
	finishRemoteActivity: finishActivity,
	markRemoteActivityRunning: mock((_input: unknown) => {}),
}));
mock.module("./workspace-context-service", () => ({
	assertWorkspaceSelectionInstalled: () => {}, // Installation admission has its own real HTTP/core partition.
	workspaceSelectionInstallationStatus: (id: string) => ({
		revision:
			db
				.select({ revision: schema.narrators.workspaceRevision })
				.from(schema.narrators)
				.where(eq(schema.narrators.id, id))
				.get()?.revision ?? 0,
		installed: true,
	}),
	assertSwitchAdmission: () => {},
	assertTargetAllowed: async () => {},
	assertWorkspaceContextFresh: async () => {},
	authorizeWorkspaceDevice: async () => {},
	installWorkspaceContext: async () => {},
	pauseWorkspace: () => {},
	prepareWorkspaceContext: async () => context,
	runtimeDeviceClass: async (id: string, _device: string, actor: string) => ({
		runtime: await resolveOAuthNarratorRuntimePolicy(id, actor),
	}),
	workspaceContextService: {
		get: async () => context,
		withRevision: async (
			_id: string,
			_revision: number,
			_key: unknown,
			action: (frozen: WorkspaceContext) => Promise<unknown>,
		) => action(structuredClone(context)),
	},
}));
mock.module("../lib/narrator-custom-traits", () => ({ getDisabledToolSet: () => new Set() }));
mock.module("./trait-layer-service", () => ({
	resolveEffectiveTraits: async () => [],
	resolveNarratorProjectId: async () => null,
}));
mock.module("./workspace-file-access", () => ({
	createNarratorWorkspaceFileAccess: () => {
		throw new Error("PTY tests must not request artifact IO");
	},
}));
mock.module("./execution-policy/engine", () => ({
	executionPolicyRevision: 0,
	executionPolicyEngine: {
		compile: async () => {
			await afterCompile?.();
			return { evaluatePath: () => ({ decision: "allow" }) };
		},
	},
}));
mock.module("../lib/agent/execution/registry", () => ({
	localBackend: { kind: "local", deviceId: "local", paths: posixPathSemantics },
	ExecutionTargetError: AppError,
	resolveBackend: ({ requested }: { requested: string }) => {
		if (requested !== deviceId && !(detachedLocal && requested === "local"))
			throw new Error("Unknown backend: no host fallback");
		return {
			kind: requested === "local" ? "local" : "remote",
			deviceId: requested,
			paths: posixPathSemantics,
			pathFlavor: "posix",
			runtimeGeneration: 7,
			resolvePathIdentity: async (path: string) => {
				identityRequests.push(path);
				await afterIdentity?.();
				return { exists: true, canonicalPath: path, runtimeGeneration: 7 };
			},
		};
	},
}));
mock.module("./device-connection-service", () => ({
	getSessionDevices: async (projectId: string | null, actor: string) => {
		const device = await db.query.remoteDevices.findFirst({
			where: eq(schema.remoteDevices.id, deviceId),
		});
		const { isDeviceAuthorized } = await import("./device-service");
		return device && !device.revokedAt && isDeviceAuthorized(device, { projectId, userId: actor })
			? [{ ...device, online: true }]
			: [];
	},
	isDeviceOnline: () => true,
	getConnectedDeviceHello: () => ({
		defaultCwd: "/remote/selected",
		platform: { os: "linux", shellPath: "/bin/sh" },
		capabilities: { pty: true, features: ["pty.ready.v1"] },
	}),
	sendRpc: mock(async () => ({})),
}));
mock.module("../terminal/runtime-remote", () => ({
	REMOTE_PTY_READY_FEATURE: "pty.ready.v1",
	REMOTE_PTY_CONPTY_FEATURE: "pty.conpty.v1",
	REMOTE_PTY_LIFECYCLE_FEATURE: "pty.lifecycle-evidence.v1",
	REMOTE_PTY_BOUNDED_IO_FEATURE: "pty.bounded-io.v1",
	spawnRemotePty: nativePty,
}));
mock.module("../terminal/runtime-bun", () => ({ spawnBunTerminal: hostPty }));
mock.module("../terminal/runtime-pty", () => ({ spawnPortablePty: hostPty }));
mock.module("../terminal/dtach-service", () => ({
	dtachService: {
		isAvailable: async () => detachedLocal,
		isSocketAlive: async () => {
			await afterSocketAlive?.();
			return true;
		},
		killSession: detachedKillSession,
		attachSession: (options: unknown) => nativePty("local", options),
	},
	findProcessesByArg: async () => [],
	getDescendantPids: async () => [],
	ProcessSnapshot: class {},
}));
mock.module("../terminal/buffer-manager", () => ({
	BufferManager: class {
		cols = 80;
		rows = 24;
		startPeriodicFlush() {}
		async dispose() {}
		async deleteFromDisk() {}
		async resize() {}
		async loadFromDisk() {
			return true;
		}
		getContents = readBuffer;
		getState() {
			return { mouseTracking: false, cursorVisible: true };
		}
	},
}));
mock.module("../lib/agent/tools/terminal", () => ({ resetCursorForTerminal: () => {} }));
const { terminalService } = await import("./terminal-service");
const { resolveOAuthDeviceRuntimeAuthorization } = await import("./oauth-device-runtime-policy");
const { resolveOAuthNarratorRuntimePolicy } = await import("./oauth-narrator-runtime-policy");
const { getDevice } = await import("./device-service");
const { terminalRoutes } = await import("../routes/terminals");
const { handleTerminalWS, sendToTerminal } = await import("../websocket/terminal-ws");

function policy(level: DeviceOperationLevel) {
	return normalizeOAuthClientPolicy({
		deviceAccess: { host: "denied", global: "readWrite", selfRegistered: level },
	});
}
async function setLevel(level: DeviceOperationLevel, source: "client" | "grant" = "client") {
	if (source === "client")
		await db
			.update(schema.oauthClients)
			.set({ policyJson: policy(level) })
			.where(eq(schema.oauthClients.id, clientId));
	else
		await db
			.update(schema.integrationAuthorities)
			.set({ policyJson: policy(level) })
			.where(eq(schema.integrationAuthorities.id, grantId));
}
const sockets: Array<Parameters<typeof handleTerminalWS.message>[0]> = [];
function socket() {
	const frames: Array<{ type: string; code?: string; data?: string }> = [];
	const ws = {
		data: {
			sessionUserId: actorId,
			userRole: "admin", // live user row must win over this stale role.
			subscribedTerminals: new Set<string>(),
			lastPongAt: 0,
		},
		send: (data: string) => frames.push(JSON.parse(data)),
		getBufferedAmount: () => 0,
		close: () => {},
	} as unknown as Parameters<typeof handleTerminalWS.message>[0];
	handleTerminalWS.open(ws);
	sockets.push(ws);
	return { ws, frames };
}
function app() {
	const value = new Hono();
	value.use("*", async (c, next) => {
		c.set("user", { sub: actorId, role: "admin", iat: 0, exp: 9999999999 });
		await next();
	});
	value.onError(
		(error) =>
			new Response(JSON.stringify({ code: error instanceof AppError ? error.code : "ERROR" }), {
				status: error instanceof AppError ? error.statusCode : 500,
			}),
	);
	value.route("/terminals", terminalRoutes);
	return value;
}
function create() {
	return terminalService.create({ narratorId, principal: { userId: actorId, isAdmin: false } });
}
async function projectFixture() {
	const projectId = generateId();
	const chapterId = generateId();
	const writeGrant = generateId();
	const now = new Date().toISOString();
	await db.insert(schema.projects).values({
		id: projectId,
		name: "Public read project",
		ownerUserId: "other-project-owner",
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.chapters).values({
		id: chapterId,
		projectId,
		title: "Remote chapter",
		branch: "fixture",
		baseBranch: "main",
		worktreePath: context.cwd,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.aclGrants).values({
		id: writeGrant,
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: actorId,
		capability: "write",
		createdAt: now,
	});
	context = saveLegacyDeviceWorkspaceBinding(db, narratorId, {
		...context,
		contextKey: `project:${projectId}`,
		contextProjectId: projectId,
	});
	await db
		.update(schema.narrators)
		.set({ contextProjectId: projectId, workspaceContext: context })
		.where(eq(schema.narrators.id, narratorId));
	return { projectId, chapterId, writeGrant };
}
beforeEach(async () => {
	for (const table of tables) sqlite.run(`DELETE FROM "${getTableConfig(table).name}"`);
	[deviceId, actorId, narratorId, clientId, grantId] = Array.from({ length: 5 }, generateId);
	afterIdentity = undefined;
	afterCompile = undefined;
	identityRequests = [];
	detachedLocal = false;
	afterSocketAlive = undefined;
	afterDetachedDiscovery = undefined;
	afterDetachedSignal = undefined;
	detachedKill.mockClear();
	detachedKillSession.mockClear();
	for (const fn of [
		write,
		resize,
		kill,
		nativePty,
		hostPty,
		registerActivity,
		registerTerminalActivity,
		finishActivity,
		readBuffer,
	])
		fn.mockClear();
	context = {
		revision: 3,
		contextKey: "frozen",
		deviceId,
		cwd: "/remote/selected",
		pathFlavor: "posix",
		capabilities: { switchDirectory: true },
	};
	const now = new Date().toISOString();
	await db.insert(schema.users).values({
		id: actorId,
		username: actorId,
		passwordHash: "fixture",
		role: "user",
		createdAt: now,
	});
	await db.insert(schema.narrators).values({
		id: narratorId,
		ownerUserId: actorId,
		cwd: context.cwd,
		defaultDeviceId: deviceId,
		visibility: "private",
		writeAudience: "owner",
		createdAt: now,
		updatedAt: now,
	});
	context = insertInitialDeviceWorkspaceBinding(db, { narratorId, context, createdAt: now });
	await db
		.update(schema.narrators)
		.set({ workspaceContext: context, workspaceRevision: context.revision })
		.where(eq(schema.narrators.id, narratorId));
	await db.insert(schema.oauthClients).values({
		id: clientId,
		clientId,
		name: "device fixture",
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
		name: "self-owned global device",
		slug: deviceId,
		tokenHash: "fixture",
		tokenPrefix: "fixture",
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
});
afterEach(() => {
	for (const ws of sockets.splice(0)) handleTerminalWS.close(ws);
});
afterAll(() => sqlite.close());

describe("live OAuth-owned device Terminal ceiling through production HTTP/WS", () => {
	for (const phase of ["before-signals", "after-signals"] as const)
		test(`attached dtach close revocation ${phase} preserves the correct input lifecycle`, async () => {
			detachedLocal = true;
			const id = generateId();
			const original: WorkspaceContext = {
				revision: 0,
				contextKey: "active-original",
				deviceId: "local",
				cwd: "/local/original",
				pathFlavor: "posix",
				capabilities: { switchDirectory: false },
				...{ terminalOrigin: { version: 1, projectId: null, runtimeGeneration: 7 } },
			};
			await db.insert(schema.terminals).values({
				id,
				narratorId,
				name: "Active original",
				cwd: original.cwd,
				workspaceContext: original,
				dtachSocket: "/mock/dtach.sock",
				status: "running",
				createdAt: new Date().toISOString(),
			});
			expect(await terminalService.reattach(id)).toBe(true);
			const revoke = async () => {
				await db
					.update(schema.narrators)
					.set({ ownerUserId: "other-owner" })
					.where(eq(schema.narrators.id, narratorId));
			};
			if (phase === "before-signals") afterDetachedDiscovery = revoke;
			else afterDetachedSignal = revoke;
			const response = await app().request(`/terminals/${id}`, { method: "DELETE" });
			expect(response.status, JSON.stringify(await response.clone().json())).toBe(403);
			expect(detachedKill).toHaveBeenCalledTimes(phase === "before-signals" ? 0 : 1);
			expect(kill).not.toHaveBeenCalled();
			afterDetachedDiscovery = undefined;
			afterDetachedSignal = undefined;
			await db
				.update(schema.narrators)
				.set({ ownerUserId: actorId })
				.where(eq(schema.narrators.id, narratorId));
			const authority = await terminalService.authorizeTargetAccess(
				id,
				{ userId: actorId, isAdmin: false },
				"write",
			);
			terminalService.writeAuthorized(
				id,
				"still writable",
				async () => authority,
				authority.assertStillCurrent,
			);
			if (phase === "before-signals") expect(write).toHaveBeenCalledWith("still writable");
			else expect(write).not.toHaveBeenCalled();
			const retry = await app().request(`/terminals/${id}`, { method: "DELETE" });
			expect(retry.status).toBe(200);
			expect(detachedKill).toHaveBeenCalledTimes(1);
			expect(kill).toHaveBeenCalledTimes(phase === "before-signals" ? 1 : 0);
		});
	for (const phase of ["socket discovery", "process discovery"] as const) {
		test(`detached kill rechecks the original authority after ${phase} await`, async () => {
			const { projectId, writeGrant } = await projectFixture();
			detachedLocal = true;
			const id = generateId();
			const original: WorkspaceContext = {
				revision: 0,
				contextKey: "detached-original",
				deviceId: "local",
				cwd: "/local/original",
				pathFlavor: "posix",
				contextProjectId: projectId,
				capabilities: { switchDirectory: false },
			};
			await db.insert(schema.terminals).values({
				id,
				narratorId,
				name: "Detached original",
				deviceId: null,
				cwd: original.cwd,
				workspaceContext: original,
				dtachSocket: "/mock/dtach.sock",
				status: "running",
				createdAt: new Date().toISOString(),
			});
			if (phase === "socket discovery")
				afterSocketAlive = async () => {
					await db.delete(schema.aclGrants).where(eq(schema.aclGrants.id, writeGrant));
				};
			else
				afterDetachedDiscovery = async () => {
					await db
						.update(schema.narrators)
						.set({ ownerUserId: "other-owner" })
						.where(eq(schema.narrators.id, narratorId));
				};
			const response = await app().request(`/terminals/${id}`, { method: "DELETE" });
			expect(detachedKill).not.toHaveBeenCalled();
			expect(response.status).toBe(403);
			const stored = await db.query.terminals.findFirst({ where: eq(schema.terminals.id, id) });
			expect(stored?.status).toBe("running");
		});
	}
	test("explicit inactive pair creates through HTTP without changing selection", async () => {
		const selected = {
			...context,
			deviceId: "selected-other",
			cwd: "/other/selected",
			contextKey: "other",
		};
		await db
			.update(schema.narrators)
			.set({ workspaceContext: selected, defaultDeviceId: selected.deviceId })
			.where(eq(schema.narrators.id, narratorId));
		const response = await app().request("/terminals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				narratorId,
				deviceId,
				bindingId: context.binding?.bindingId,
				expectedBindingRevision: context.binding?.bindingRevision,
			}),
		});
		expect(response.status).toBe(201);
		const terminal = await response.json();
		expect(terminal.cwd).toBe("/remote/selected");
		expect(terminal.workspaceContext.binding).toEqual(context.binding);
		expect(terminal.workspaceContext.terminalOrigin.projectId).toBeNull();
		const narrator = await db.query.narrators.findFirst({
			where: eq(schema.narrators.id, narratorId),
		});
		expect(narrator?.workspaceContext?.deviceId).toBe("selected-other");
		expect(nativePty).toHaveBeenCalledTimes(1);
	});
	test("unconfigured explicit pair refuses before any metadata, row or PTY", async () => {
		await db.delete(schema.narratorDeviceWorkspaces);
		await db
			.update(schema.narrators)
			.set({
				workspaceContext: { ...context, deviceId: "selected-other" },
				defaultDeviceId: "selected-other",
			})
			.where(eq(schema.narrators.id, narratorId));
		const response = await app().request("/terminals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ narratorId, deviceId }),
		});
		expect(response.status).toBe(409);
		expect(identityRequests).toEqual([]);
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(nativePty).not.toHaveBeenCalled();
	});
	test("binding changes at writer admission prevent PTY; old terminal remains at original source", async () => {
		const old = await create();
		const original = old.workspaceContext;
		const oldPin = context.binding?.bindingRevision;
		nativePty.mockClear();
		registerActivity.mockImplementationOnce(async () => {
			context = saveLegacyDeviceWorkspaceBinding(db, narratorId, {
				...context,
				cwd: "/remote/new",
				contextKey: "new",
				revision: 4,
			});
			await db
				.update(schema.narrators)
				.set({ workspaceContext: context, workspaceRevision: 4 })
				.where(eq(schema.narrators.id, narratorId));
		});
		await expect(create()).rejects.toThrow("binding identity changed");
		expect(nativePty).not.toHaveBeenCalled();
		const detail = await app().request(`/terminals/${old.id}`);
		expect(detail.status).toBe(200);
		expect((await detail.json()).workspaceContext).toEqual(original);
		const s = socket();
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [old.id] });
		await handleTerminalWS.message(s.ws, {
			type: "input",
			terminalId: old.id,
			data: "original-target",
		});
		expect(write).toHaveBeenCalledWith("original-target");
		await expect(
			terminalService.create({
				narratorId,
				deviceId,
				expectedBindingRevision: oldPin,
				principal: { userId: actorId, isAdmin: false },
			}),
		).rejects.toThrow("binding changed");
		expect(nativePty).not.toHaveBeenCalled();
	});
	test("old terminal retains original project authority after current selection moves to private project", async () => {
		const { projectId, writeGrant } = await projectFixture();
		const old = await create();
		const otherProject = generateId();
		const now = new Date().toISOString();
		await db.insert(schema.projects).values({
			id: otherProject,
			name: "Other private project",
			ownerUserId: "different-owner",
			createdAt: now,
			updatedAt: now,
		});
		await db
			.update(schema.narrators)
			.set({
				contextProjectId: otherProject,
				workspaceContext: {
					...context,
					contextProjectId: otherProject,
					deviceId: "selected-other",
				},
			})
			.where(eq(schema.narrators.id, narratorId));
		const original = await terminalService.authorizeTargetAccess(
			old.id,
			{ userId: actorId, isAdmin: false },
			"write",
		);
		expect(original.workspaceContext?.contextProjectId).toBe(projectId);
		await db.delete(schema.aclGrants).where(eq(schema.aclGrants.id, writeGrant));
		await expect(
			terminalService.authorizeTargetAccess(old.id, { userId: actorId, isAdmin: false }, "write"),
		).rejects.toThrow();
	});
	test("WS final resize notification cannot leave an accepted input ticket after live downgrade", async () => {
		const terminal = await create();
		const s = socket();
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [terminal.id] });
		const originalSend = s.ws.send.bind(s.ws);
		s.ws.send = ((payload: string) => {
			if (JSON.parse(payload).type === "requestResize")
				db.update(schema.oauthClients)
					.set({ policyJson: policy("readOnly") })
					.where(eq(schema.oauthClients.id, clientId))
					.run();
			return originalSend(payload);
		}) as typeof s.ws.send;
		await handleTerminalWS.message(s.ws, {
			type: "input",
			terminalId: terminal.id,
			data: "must-not-write",
		});
		expect(write).not.toHaveBeenCalled();
	});
	test("legacy narrator terminal without project/source evidence cannot borrow current binding", async () => {
		const id = generateId();
		await db.insert(schema.terminals).values({
			id,
			narratorId,
			name: "Unknown source",
			cwd: context.cwd,
			deviceId,
			workspaceContext: context,
			status: "running",
			createdAt: new Date().toISOString(),
		});
		expect((await app().request(`/terminals/${id}`)).status).toBe(409);
		expect(identityRequests).toEqual([]);
	});
	test("WS disconnect cancels creation while metadata is pending before PTY", async () => {
		let release!: () => void;
		afterIdentity = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const s = socket();
		const creating = handleTerminalWS.message(s.ws, {
			type: "create",
			requestId: "cancelled",
			narratorId,
			deviceId,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		handleTerminalWS.close(s.ws);
		release();
		await creating;
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(s.frames.some((frame) => frame.type === "created")).toBe(false);
	});
	for (const source of ["client", "grant"] as const) {
		test(`ordinary narrator refuses ${source} readOnly before row, claim or PTY even while allowed=true`, async () => {
			await setLevel("readOnly", source);
			expect(await resolveOAuthNarratorRuntimePolicy(narratorId)).toBeNull();
			const device = await getDevice(deviceId);
			expect(device).not.toBeNull();
			if (!device) throw new Error("Missing fixture device");
			expect(await resolveOAuthDeviceRuntimeAuthorization(device)).toMatchObject({
				allowed: true,
				oauthOwned: true,
				policy: { deviceAccess: { selfRegistered: "readOnly", global: "readWrite" } },
			});
			const response = await app().request("/terminals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ narratorId }),
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ code: "DEVICE_SCOPE_FORBIDDEN" });
			expect(await db.select().from(schema.terminals)).toHaveLength(0);
			expect(registerActivity).not.toHaveBeenCalled();
			expect(registerTerminalActivity).not.toHaveBeenCalled();
			expect(nativePty).not.toHaveBeenCalled();
			expect(hostPty).not.toHaveBeenCalled();
		});
	}
	test("standalone readOnly also refuses before partial origin row or writer admission", async () => {
		await setLevel("readOnly");
		await expect(
			terminalService.create({ deviceId, principal: { userId: actorId, isAdmin: false } }),
		).rejects.toThrow("live device authority");
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(registerTerminalActivity).not.toHaveBeenCalled();
		expect(nativePty).not.toHaveBeenCalled();
	});
	test("readOnly subscribe only reads existing remote scrollback and never reattaches or fabricates readiness", async () => {
		const id = generateId();
		await db.insert(schema.terminals).values({
			id,
			narratorId,
			name: "Detached",
			cwd: context.cwd,
			workspaceContext: {
				...context,
				...{ terminalOrigin: { version: 1, projectId: null, runtimeGeneration: 7 } },
			},
			deviceId,
			status: "running",
			createdAt: new Date().toISOString(),
		});
		await setLevel("readOnly");
		const s = socket();
		const attach = spyOn(terminalService, "ensureAttached");
		try {
			await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [id] });
			expect(s.ws.data.subscribedTerminals.has(id)).toBe(true);
			expect(s.frames).toContainEqual(
				expect.objectContaining({ type: "scrollback", data: "original scrollback" }),
			);
			expect(s.frames).toContainEqual(
				expect.objectContaining({ type: "lifecycle", state: "unknown", code: null }),
			);
			expect(s.frames.some((frame) => frame.type === "exit")).toBe(false);
			expect(attach).not.toHaveBeenCalled();
			expect(nativePty).not.toHaveBeenCalled();
			expect(hostPty).not.toHaveBeenCalled();
			await handleTerminalWS.message(s.ws, {
				type: "input",
				terminalId: id,
				data: "echo forbidden\r",
			});
			expect(write).not.toHaveBeenCalled();
			expect(s.frames).toContainEqual(
				expect.objectContaining({ type: "error", code: "DEVICE_SCOPE_FORBIDDEN" }),
			);
		} finally {
			attach.mockRestore();
		}
	});
	test("live user role/narrator ACL still deny a former owner despite a stale admin session", async () => {
		const terminal = await create();
		await db
			.update(schema.narrators)
			.set({ ownerUserId: "another-owner" })
			.where(eq(schema.narrators.id, narratorId));
		const s = socket();
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [terminal.id] });
		expect(s.ws.data.subscribedTerminals.has(terminal.id)).toBe(false);
		expect(readBuffer).not.toHaveBeenCalled();
		// The narrator ACL deliberately hides unauthorized private IDs with 404.
		expect((await app().request(`/terminals/${terminal.id}`)).status).toBe(404);
	});
	test("readWrite allows native admission and WS input without granting host authority", async () => {
		const terminal = await create();
		await terminalService.authorizeTargetAccess(
			terminal.id,
			{ userId: actorId, isAdmin: false },
			"write",
		);
		const s = socket();
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [terminal.id] });
		await handleTerminalWS.message(s.ws, {
			type: "input",
			terminalId: terminal.id,
			data: "allowed",
		});
		expect(nativePty).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("allowed");
		expect(s.frames.some((frame) => frame.type === "scrollback")).toBe(true);
		expect(hostPty).not.toHaveBeenCalled();
	});
	test("downgrade after spawn blocks input/resize/rename/kill, but still permits current read scrollback/output", async () => {
		const terminal = await create();
		await setLevel("readOnly");
		const s = socket();
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [terminal.id] });
		expect(s.ws.data.subscribedTerminals.has(terminal.id)).toBe(true);
		expect(
			s.frames.some((frame) => frame.type === "scrollback" && frame.data === "original scrollback"),
		).toBe(true);
		for (const message of [
			{ type: "input", terminalId: terminal.id, data: "forbidden" },
			{ type: "resize", terminalId: terminal.id, cols: 90, rows: 30 },
			{ type: "rename", terminalId: terminal.id, name: "forbidden" },
			{ type: "kill", terminalId: terminal.id },
		]) {
			s.ws.data.subscribedTerminals.add(terminal.id);
			await handleTerminalWS.message(s.ws, message);
		}
		expect(write).not.toHaveBeenCalled();
		expect(resize).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect((await terminalService.getById(terminal.id)).name).toBe("Terminal");
		for (const method of ["PATCH", "DELETE"])
			expect(
				(
					await app().request(`/terminals/${terminal.id}`, {
						method,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "forbidden" }),
					})
				).status,
			).toBe(403);
		expect((await app().request(`/terminals/${terminal.id}`)).status).toBe(200);
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [terminal.id] });
		s.frames.length = 0;
		sendToTerminal(terminal.id, { type: "output", terminalId: terminal.id, data: "read allowed" });
		await Bun.sleep(90);
		expect(s.frames.some((frame) => frame.type === "output")).toBe(true);
	});
	for (const revoke of ["denied", "grant", "client", "device", "binding"] as const) {
		test(`${revoke} revocation blocks live reads/output and writes without cached allowance`, async () => {
			const terminal = await create();
			const s = socket();
			await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: [terminal.id] });
			if (revoke === "denied") await setLevel("denied");
			if (revoke === "grant")
				await db
					.update(schema.integrationAuthorities)
					.set({ state: "revoked" })
					.where(eq(schema.integrationAuthorities.id, grantId));
			if (revoke === "client")
				await db
					.update(schema.oauthClients)
					.set({ revokedAt: new Date().toISOString() })
					.where(eq(schema.oauthClients.id, clientId));
			if (revoke === "device")
				await db
					.update(schema.remoteDevices)
					.set({ revokedAt: new Date().toISOString() })
					.where(eq(schema.remoteDevices.id, deviceId));
			if (revoke === "binding")
				await db
					.update(schema.integrationResourceBindings)
					.set({ state: "revoked" })
					.where(eq(schema.integrationResourceBindings.resourceId, deviceId));
			s.frames.length = 0;
			sendToTerminal(terminal.id, {
				type: "output",
				terminalId: terminal.id,
				data: "must not leak",
			});
			await Bun.sleep(90);
			expect(s.frames.some((frame) => frame.type === "output")).toBe(false);
			expect(s.ws.data.subscribedTerminals.has(terminal.id)).toBe(false);
			await handleTerminalWS.message(s.ws, {
				type: "input",
				terminalId: terminal.id,
				data: "forbidden",
			});
			expect(write).not.toHaveBeenCalled();
			expect((await app().request(`/terminals/${terminal.id}`)).status).not.toBe(200);
		});
	}
	test("downgrade while resolving target is rejected before persistent row/claim", async () => {
		afterIdentity = () => setLevel("readOnly");
		await expect(create()).rejects.toThrow("live device authority");
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(registerActivity).not.toHaveBeenCalled();
		expect(nativePty).not.toHaveBeenCalled();
	});
	test("writeAudience revocation during writer admission blocks PTY while public read remains", async () => {
		await db
			.update(schema.narrators)
			.set({
				ownerUserId: "other-owner",
				visibility: "public",
				writeAudience: "public",
			})
			.where(eq(schema.narrators.id, narratorId));
		const old = await create();
		nativePty.mockClear();
		registerActivity.mockImplementationOnce(async () => {
			await db
				.update(schema.narrators)
				.set({ writeAudience: "owner" })
				.where(eq(schema.narrators.id, narratorId));
		});
		await expect(create()).rejects.toThrow("Narrator");
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(1);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
		await expect(
			terminalService.authorizeTargetAccess(old.id, { userId: actorId, isAdmin: false }, "read"),
		).resolves.toMatchObject({ id: old.id });
		await expect(
			terminalService.authorizeTargetAccess(old.id, { userId: actorId, isAdmin: false }, "write"),
		).rejects.toThrow("Narrator");
	});
	test("explicit narrator write grant downgraded to read during admission cannot start PTY", async () => {
		await db
			.update(schema.narrators)
			.set({ ownerUserId: "other-owner", visibility: "public" })
			.where(eq(schema.narrators.id, narratorId));
		const writeGrant = generateId();
		await db.insert(schema.aclGrants).values({
			id: writeGrant,
			scopeType: "narrator",
			scopeId: narratorId,
			principalType: "user",
			principalId: actorId,
			capability: "write",
			createdAt: new Date().toISOString(),
		});
		registerActivity.mockImplementationOnce(async () => {
			await db
				.update(schema.aclGrants)
				.set({ capability: "read" })
				.where(eq(schema.aclGrants.id, writeGrant));
		});
		await expect(create()).rejects.toThrow("Narrator");
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
	});
	for (const standalone of [false, true]) {
		test(`${standalone ? "chapter standalone" : "linked narrator"} refreshes original project write after admission while project public read remains`, async () => {
			const { projectId, chapterId, writeGrant } = await projectFixture();
			const admission = standalone ? registerTerminalActivity : registerActivity;
			admission.mockImplementationOnce(async () => {
				await db
					.update(schema.aclGrants)
					.set({ capability: "read" })
					.where(eq(schema.aclGrants.id, writeGrant));
			});
			const creating = standalone
				? terminalService.create({
						chapterId,
						deviceId,
						principal: { userId: actorId, isAdmin: false },
					})
				: create();
			await expect(creating).rejects.toThrow("Project");
			expect(nativePty).not.toHaveBeenCalled();
			expect(hostPty).not.toHaveBeenCalled();
			expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
			expect(
				finishActivity.mock.calls.some(
					([input]) => (input as { outcome: string }).outcome === "unknown",
				),
			).toBe(false);
			const rows = await db.select().from(schema.terminals);
			expect(rows).toHaveLength(standalone ? 1 : 0);
			if (standalone) expect(rows[0]).toMatchObject({ status: "exited", exitCode: null });
			const { loadProjectForAccess } = await import("./project-acl");
			await expect(
				loadProjectForAccess(projectId, { userId: actorId, isAdmin: false }, "read"),
			).resolves.toMatchObject({ id: projectId });
		});
	}
	test("admin role downgraded during admission cannot reuse the options admin bit for project write", async () => {
		const { writeGrant } = await projectFixture();
		await db.delete(schema.aclGrants).where(eq(schema.aclGrants.id, writeGrant));
		await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, actorId));
		registerActivity.mockImplementationOnce(async () => {
			await db.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, actorId));
		});
		await expect(
			terminalService.create({ narratorId, principal: { userId: actorId, isAdmin: true } }),
		).rejects.toThrow("Project");
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
	});
	test("admin role downgraded during admission cannot reuse the options admin bit for narrator write", async () => {
		await db
			.update(schema.narrators)
			.set({ ownerUserId: "other-owner", visibility: "public" })
			.where(eq(schema.narrators.id, narratorId));
		await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, actorId));
		registerActivity.mockImplementationOnce(async () => {
			await db.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, actorId));
		});
		await expect(
			terminalService.create({ narratorId, principal: { userId: actorId, isAdmin: true } }),
		).rejects.toThrow("Narrator");
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
	});
	test("deleted live actor during admission cancels the claim before native dispatch", async () => {
		registerActivity.mockImplementationOnce(async () => {
			await db.delete(schema.users).where(eq(schema.users.id, actorId));
		});
		await expect(create()).rejects.toThrow("principal is unavailable");
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
	});
	test("write ACL revoked during path resolution refuses before writer admission or row", async () => {
		await db
			.update(schema.narrators)
			.set({ ownerUserId: "other-owner", visibility: "public", writeAudience: "public" })
			.where(eq(schema.narrators.id, narratorId));
		afterIdentity = async () => {
			await db
				.update(schema.narrators)
				.set({ writeAudience: "owner" })
				.where(eq(schema.narrators.id, narratorId));
		};
		await expect(create()).rejects.toThrow("Narrator");
		expect(registerActivity).not.toHaveBeenCalled();
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
	});
	test("downgrade during writer admission prevents dispatch and settles the unused claim", async () => {
		registerActivity.mockImplementationOnce(() => setLevel("readOnly"));
		await expect(create()).rejects.toThrow("live device authority");
		expect(nativePty).not.toHaveBeenCalled();
		expect(await db.select().from(schema.terminals)).toHaveLength(0);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
	});
	test("per-use downgrade during narrator policy compilation is rechecked before read/write returns", async () => {
		const terminal = await create();
		afterCompile = () => setLevel("denied");
		await expect(
			terminalService.authorizeTargetAccess(
				terminal.id,
				{ userId: actorId, isAdmin: false },
				"read",
			),
		).rejects.toThrow("live device authority");
	});
	test("a readWrite device cannot elevate narrower real narrator OAuth snapshot/tool restrictions", async () => {
		const terminal = await create();
		await db.insert(schema.integrationCapabilityGrants).values({
			id: generateId(),
			authorityId: grantId,
			capabilityId: "narrator.send_message",
			scopeType: "global",
			scopeKey: "global",
			createdByType: "user",
			createdById: actorId,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		await db.insert(schema.integrationResourceBindings).values({
			id: generateId(),
			resourceType: "narrator",
			resourceId: narratorId,
			sourceType: "oauth_client",
			sourceId: clientId,
			authorityType: "oauth_grant",
			authorityId: grantId,
			state: "active",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		await db
			.update(schema.narrators)
			.set({
				oauthPolicySnapshotJson: {
					version: 3,
					policy: policy("readOnly"),
					permissionMode: "readOnly",
					systemPrompt: null,
					projectId: null,
					defaultDeviceId: deviceId,
					deviceIds: [deviceId],
				},
			})
			.where(eq(schema.narrators.id, narratorId));
		const oauth = await resolveOAuthNarratorRuntimePolicy(narratorId);
		expect(oauth?.policy.deviceAccess.selfRegistered).toBe("readOnly");
		expect(oauth?.allowedTools.has("Terminal")).toBe(false);
		await expect(create()).rejects.toThrow("external runtime authority");
		await expect(
			terminalService.authorizeTargetAccess(
				terminal.id,
				{ userId: actorId, isAdmin: false },
				"write",
			),
		).rejects.toThrow("external runtime authority");
		expect(nativePty).toHaveBeenCalledTimes(1);
	});
});
