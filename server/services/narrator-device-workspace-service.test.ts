import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativePathDescriptorV2 } from "@shared/target-native-path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError } from "zod";
import { db } from "../db";
import {
	aclGrants,
	chapters,
	integrationAuthorities,
	integrationResourceBindings,
	narratorBlacklistDirs,
	narratorDeviceWorkspaces,
	narrators,
	oauthClients,
	projects,
	remoteDevices,
	users,
} from "../db/schema";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { DEFAULT_OAUTH_CLIENT_POLICY } from "../lib/oauth-client-policy";
import * as narratorWs from "../websocket/narrator-ws";
import * as connections from "./device-connection-service";
import { revokeDevice } from "./device-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import { integrationAuthorityService } from "./integration-authority-service";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { endpointDeviceAuthorityFingerprint } from "./narrator-device-workspace-authority";
import {
	narratorDeviceWorkspaceService as service,
	type WorkspaceEndpointDeviceAuthority,
} from "./narrator-device-workspace-service";
import {
	deviceWorkspaceBindingContext,
	insertInitialDeviceWorkspaceBinding,
	readDeviceWorkspaceBinding,
} from "./narrator-device-workspace-store";
import * as session from "./narrator-session";
import { type ActiveNarrator, activeNarrators, compactLocks } from "./narrator-session-state";
import * as oauthDeviceRuntime from "./oauth-device-runtime-policy";
import * as oauthRuntime from "./oauth-narrator-runtime-policy";
import * as projectAccess from "./project-acl";
import {
	assertWorkspaceSelectionInstalled,
	prepareWorkspaceContext,
	workspaceContextService,
	workspaceSelectionInstallationStatus,
} from "./workspace-context-service";

const { narratorRoutes } = await import("../routes/narrators");
let root: string;
let owner: string;
let admin: string;
let n1: string;
let n2: string;
let devices: {
	id: string;
	name: string;
	slug: string;
	scope: "global";
	online: boolean;
	defaultCwd: string;
}[];
let restore: () => void;
const backends = new Map<string, ReturnType<typeof makeBackend>>();
function makeBackend(deviceId: string) {
	const dirs = new Set(["/repo/a", "/repo/b", "/default"]);
	return Object.assign(Object.create(localBackend), {
		kind: "remote" as const,
		deviceId,
		defaultCwd: "/default",
		runtimeGeneration: 1,
		supportsGitWorkspace: false,
		resolvePathIdentity: async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path,
			exists: dirs.has(path),
			runtimeGeneration: 1,
		}),
		statFile: async (path: string) =>
			dirs.has(path) ? { isDirectory: true, isFile: false, size: 0, resolvedPath: path } : null,
	});
}
function options(userId = owner) {
	return { origin: "http" as const, userId };
}
function set(
	deviceId: string,
	cwd = "/repo/a",
	expectedBindingRevision = 0,
	extra: Record<string, unknown> = {},
) {
	return service.set(
		n1,
		{ requestId: generateId(), deviceId, cwd, expectedBindingRevision, ...extra },
		options(),
	);
}
function app(actor = owner) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", {
			sub: actor,
			role: actor === admin ? "admin" : "user",
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		});
		await next();
	});
	app.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "TEST_ERROR",
				}),
				{
					status:
						error instanceof AppError ? error.statusCode : error instanceof ZodError ? 400 : 500,
					headers: { "content-type": "application/json" },
				},
			),
	);
	app.route("/api/narrators", narratorRoutes);
	return app;
}
const base = () => `/api/narrators/${n1}/device-workspaces`;
function json(method: string, body: unknown) {
	return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "device-workspace-test-"));
	await mkdir(join(root, "a"));
	await mkdir(join(root, "b"));
	owner = generateId();
	admin = generateId();
	n1 = generateId();
	n2 = generateId();
	const now = new Date().toISOString();
	await db.insert(users).values([
		{ id: owner, username: owner, passwordHash: "fixture", createdAt: now },
		{ id: admin, username: admin, passwordHash: "fixture", role: "admin", createdAt: now },
	]);
	await db.insert(narrators).values(
		[n1, n2].map((id) => ({
			id,
			title: "binding fixture",
			ownerUserId: owner,
			cwd: join(root, "a"),
			createdAt: now,
			updatedAt: now,
		})),
	);
	backends.clear();
	for (const id of ["d1", "d2"]) backends.set(id, makeBackend(id));
	devices = [...backends.keys()].map((id) => ({
		id,
		name: id,
		slug: id,
		scope: "global",
		online: true,
		defaultCwd: "/default",
	}));
	const spy = spyOn(connections, "getSessionDevices").mockImplementation(async (_project, actor) =>
		actor === owner || actor === admin ? devices : [],
	);
	setRemoteBackendResolver((id) => backends.get(id) ?? null);
	restore = () => {
		spy.mockRestore();
		setRemoteBackendResolver(null);
	};
});
afterEach(async () => {
	restore();
	for (const id of [n1, n2]) {
		activeNarrators.delete(id);
		compactLocks.delete(id);
		executionPolicyEngine.invalidate(id);
		await db.delete(narrators).where(eq(narrators.id, id));
	}
	for (const id of ["d1", "d2"]) {
		await db.delete(remoteDevices).where(eq(remoteDevices.id, id));
		await db
			.delete(integrationResourceBindings)
			.where(eq(integrationResourceBindings.resourceId, id));
	}
	for (const id of [owner, admin]) await db.delete(users).where(eq(users.id, id));
	await rm(root, { recursive: true, force: true });
});

describe("narrator/device binding persistence and selection", () => {
	test("N1D1/N1D2/N2D1 are isolated; inactive edit never changes default", async () => {
		await set("d1");
		await set("d2", "/repo/b");
		await service.set(
			n2,
			{ requestId: generateId(), deviceId: "d1", cwd: "/repo/b", expectedBindingRevision: 0 },
			options(),
		);
		expect((await service.resolve(n1, "d1", options()))?.cwd).toBe("/repo/a");
		expect((await service.resolve(n1, "d2", options()))?.cwd).toBe("/repo/b");
		expect((await service.resolve(n2, "d1", options()))?.cwd).toBe("/repo/b");
		await set("d1", "/repo/b", 1);
		expect(readDeviceWorkspaceBinding(db, n1, "d2")?.bindingRevision).toBe(1);
		expect(readDeviceWorkspaceBinding(db, n2, "d1")?.bindingRevision).toBe(1);
		expect((await workspaceContextService.get(n1)).deviceId).toBe("local");
		expect((await workspaceContextService.get(n1)).revision).toBe(0);
	});
	test("A→B→A restores the session's directory, ignoring device default", async () => {
		await set("d1", "/repo/b");
		await set("d2", "/repo/a");
		for (const [deviceId, expectedSelectionRevision] of [
			["d1", 0],
			["d2", 1],
			["d1", 2],
		] as const) {
			const result = await service.select(
				n1,
				{
					requestId: generateId(),
					deviceId,
					expectedBindingRevision: 1,
					expectedSelectionRevision,
				},
				options(),
			);
			expect(result.binding.context.cwd).toBe(deviceId === "d1" ? "/repo/b" : "/repo/a");
		}
		expect(readDeviceWorkspaceBinding(db, n1, "d1")?.bindingRevision).toBe(1);
		expect((await workspaceContextService.get(n1)).revision).toBe(3);
		await workspaceContextService.switchDevice(n1, "local", options());
		expect((await workspaceContextService.get(n1)).cwd).toBe(join(root, "a"));
		await workspaceContextService.switchDevice(n1, "d1", options());
		expect((await workspaceContextService.get(n1)).cwd).toBe("/repo/b");
	});
	test("unknown legacy remote cannot mint a binding from backend defaultCwd or host cwd", async () => {
		await db
			.update(narrators)
			.set({ defaultDeviceId: "d1", workspaceContext: null })
			.where(eq(narrators.id, n1));
		expect(await service.get(n1, "d1", options())).toBeNull();
		expect(await workspaceContextService.get(n1, options())).toMatchObject({
			deviceId: "d1",
			cwd: "",
			availability: "needs_initialization",
		});
		expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
		expect(readDeviceWorkspaceBinding(db, n1, "local")).toBeNull();
		await expect(workspaceContextService.switchDevice(n1, "d1", options())).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_NOT_CONFIGURED",
		});
	});
	test("missing B never prepares legacy A and an unconfigured local selection never invents host home", async () => {
		const legacyRead = spyOn(workspaceContextService, "get").mockRejectedValue(
			new Error("Unexpected legacy filesystem preparation"),
		);
		try {
			expect(await service.get(n1, "d1", options())).toBeNull();
			expect(legacyRead).not.toHaveBeenCalled();
			await db
				.update(narrators)
				.set({ cwd: null, defaultDeviceId: null, workspaceContext: null })
				.where(eq(narrators.id, n1));
			expect(await service.resolve(n1, "local", options())).toBeNull();
			expect(legacyRead).not.toHaveBeenCalled();
			expect(readDeviceWorkspaceBinding(db, n1, "local")).toBeNull();
		} finally {
			legacyRead.mockRestore();
		}
	});
	test("relative legacy local sources cannot enter filesystem preparation or mint a binding", async () => {
		const legacyRead = spyOn(workspaceContextService, "get").mockRejectedValue(
			new Error("Unexpected legacy preparation"),
		);
		try {
			for (const cwd of ["relative/repo", "./repo", "../repo", "C:drive-relative"]) {
				await db
					.update(narrators)
					.set({ cwd, defaultDeviceId: null, workspaceContext: null })
					.where(eq(narrators.id, n1));
				expect(await service.resolve(n1, "local", options())).toBeNull();
				expect(legacyRead).not.toHaveBeenCalled();
			}
			expect(readDeviceWorkspaceBinding(db, n1, "local")).toBeNull();
		} finally {
			legacyRead.mockRestore();
		}
	});
	test("trusted legacy committed endpoint lazily migrates only itself without changing contextKey/revision", async () => {
		const context = await prepareWorkspaceContext(
			{ deviceId: "d1", cwd: "/repo/b" },
			7,
			undefined,
			{ narratorId: n1, userId: owner },
		);
		await db
			.update(narrators)
			.set({ workspaceContext: context, workspaceRevision: 7 })
			.where(eq(narrators.id, n1));
		const binding = await service.get(n1, "d1", options());
		expect(binding?.context).toMatchObject({
			contextKey: context.contextKey,
			revision: 7,
			cwd: "/repo/b",
		});
		expect(binding?.bindingRevision).toBe(1);
		expect(readDeviceWorkspaceBinding(db, n1, "d2")).toBeNull();
		expect(readDeviceWorkspaceBinding(db, n1, "local")).toBeNull();
	});
	test("initial transaction helper strips parent reference and keeps original context identity", async () => {
		const parent = await workspaceContextService.get(n1, options());
		const child = db.transaction((tx) =>
			insertInitialDeviceWorkspaceBinding(tx, {
				narratorId: n2,
				context: parent,
				createdAt: new Date().toISOString(),
			}),
		);
		expect(child.contextKey).toBe(parent.contextKey);
		expect(child.revision).toBe(parent.revision);
		expect(child.binding?.bindingId).not.toBe(parent.binding?.bindingId);
		expect(child.binding?.narratorId).toBe(n2);
		expect(child.binding?.bindingRevision).toBe(1);
	});
	test("same pair creation races have one winner and expected zero cannot overwrite", async () => {
		const results = await Promise.allSettled([set("d1"), set("d1", "/repo/b")]);
		expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(readDeviceWorkspaceBinding(db, n1, "d1")?.bindingRevision).toBe(1);
		await expect(set("d1")).rejects.toMatchObject({ statusCode: 409 });
	});
	test("active set requires selection CAS and atomically advances only its own binding", async () => {
		await workspaceContextService.get(n1, options());
		await expect(set("local", join(root, "b"), 1)).rejects.toMatchObject({ statusCode: 409 });
		await expect(
			set("local", join(root, "b"), 1, { expectedSelectionRevision: 8 }),
		).rejects.toMatchObject({ statusCode: 409 });
		const result = await set("local", join(root, "b"), 1, { expectedSelectionRevision: 0 });
		expect(result.binding.bindingRevision).toBe(2);
		expect(result.selection?.current.revision).toBe(1);
		expect((await workspaceContextService.get(n1)).binding?.bindingKey).toBe(
			result.binding.context.binding?.bindingKey,
		);
	});
	test("same-kind same-actor retries are idempotent; kind, actor and legacy receipt domains cannot be reused", async () => {
		const request = {
			requestId: "same-id",
			deviceId: "d1",
			cwd: "/repo/a",
			expectedBindingRevision: 0,
		};
		const first = await service.set(n1, request, options());
		expect(await service.set(n1, request, options())).toEqual(first);
		await expect(service.set(n1, request, options(admin))).rejects.toMatchObject({
			code: "WORKSPACE_REQUEST_CONFLICT",
		});
		await expect(
			service.select(
				n1,
				{
					requestId: request.requestId,
					deviceId: "d1",
					expectedBindingRevision: 1,
					expectedSelectionRevision: 0,
				},
				options(),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_REQUEST_CONFLICT" });
		await expect(
			workspaceContextService.switch(
				n1,
				{
					requestId: request.requestId,
					expectedRevision: 0,
					target: { deviceId: "d1", cwd: "/repo/a" },
				},
				options(),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_REQUEST_CONFLICT" });
		const legacy = {
			requestId: "legacy-id",
			expectedRevision: 0,
			target: { deviceId: "d1", cwd: "/repo/a" },
		};
		await workspaceContextService.switch(n1, legacy, options());
		await expect(
			service.set(n1, { ...request, requestId: legacy.requestId }, options()),
		).rejects.toMatchObject({ code: "WORKSPACE_REQUEST_CONFLICT" });
	});
	test("install failure remains pending/paused and recovery reuses original binding and selection revisions", async () => {
		await set("d1");
		const active = {
			alive: true,
			cwd: join(root, "a"),
			_loopRunning: false,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(n1, active);
		const install = spyOn(session, "updateActiveNarratorCwdAndSkillContext").mockRejectedValueOnce(
			new Error("installation failure"),
		);
		const request = {
			requestId: "pending",
			deviceId: "d1",
			expectedBindingRevision: 1,
			expectedSelectionRevision: 0,
		};
		try {
			await expect(service.select(n1, request, options())).rejects.toMatchObject({
				code: "WORKSPACE_CONTEXT_INSTALL_FAILED",
			});
			expect((await service.getRequest(n1, request.requestId, options()))?.installState).toBe(
				"pending",
			);
			expect(active._workspaceInstallFailed).toBe(true);
			const recovered = await service.select(n1, request, options());
			expect(recovered.selection?.current.revision).toBe(1);
			expect(recovered.binding.bindingRevision).toBe(1);
			expect((await service.getRequest(n1, request.requestId, options()))?.installState).toBe(
				"installed",
			);
			expect(active._workspaceInstallFailed).toBe(false);
		} finally {
			install.mockRestore();
		}
	});
});

describe("live authority, identity and HTTP", () => {
	test("binding reference is not an authorization token; cross-narrator and changed revision fail", async () => {
		const result = await set("d1");
		await expect(
			service.assertCurrent(n2, result.binding.context, options()),
		).rejects.toMatchObject({ statusCode: 409 });
		await db
			.update(narratorDeviceWorkspaces)
			.set({ bindingRevision: 2 })
			.where(eq(narratorDeviceWorkspaces.id, result.binding.id));
		expect(() => service.assertCurrentSync(n1, result.binding.context, options())).toThrow(
			"identity changed",
		);
	});
	test("unauthorized actor, removed ACL/device and offline endpoint never reveal cwd or mutate", async () => {
		await set("d1");
		const stranger = generateId();
		await expect(service.get(n1, "d1", { userId: stranger })).rejects.toMatchObject({
			statusCode: 403,
		});
		devices = [];
		expect((await service.list(n1, {}, options())).items).toEqual([]);
		await expect(service.get(n1, "d1", options())).rejects.toMatchObject({
			code: "WORKSPACE_ACCESS_DENIED",
		});
		devices = [
			{ id: "d1", name: "d1", slug: "d1", scope: "global", online: false, defaultCwd: "/default" },
		];
		await expect(set("d1", "/repo/b", 1)).rejects.toMatchObject({
			code: "WORKSPACE_DEVICE_OFFLINE",
		});
		expect(readDeviceWorkspaceBinding(db, n1, "d1")?.bindingRevision).toBe(1);
	});
	test("device revocation during preparation rejects without binding or receipt", async () => {
		const backend = backends.get("d1");
		if (!backend) throw new Error("Fixture backend is missing");
		const original = backend.resolvePathIdentity;
		const probe = spyOn(backend, "resolvePathIdentity").mockImplementation(async (path: string) => {
			const result = await original(path);
			devices = [];
			return result;
		});
		try {
			await expect(set("d1")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
			expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
		} finally {
			probe.mockRestore();
		}
	});
	test("connection generation replacement while preparing rejects without mutation", async () => {
		const backend = backends.get("d1");
		if (!backend) throw new Error("Fixture backend is missing");
		const original = backend.resolvePathIdentity;
		const probe = spyOn(backend, "resolvePathIdentity").mockImplementation(async (path: string) => {
			const result = await original(path);
			backend.runtimeGeneration++;
			return result;
		});
		try {
			await expect(set("d1")).rejects.toMatchObject({ statusCode: 409 });
			expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
		} finally {
			probe.mockRestore();
		}
	});
	test("stored root evidence cannot be replaced by newly observed root evidence on select", async () => {
		const result = await set("d1");
		const context = {
			...result.binding.context,
			nativeRootDescriptor: {
				version: 2,
				platform: "windows",
				pathSlotKey: "a".repeat(64),
				componentKeys: ["repo", "a"],
				volumeId: "volume",
				ancestors: [],
				parent: {
					canonicalPath: "C:\\repo",
					object: { volumeId: "volume", fileId: "a".repeat(32), creationTime: "1" },
					caseSensitive: false,
				},
				missingSuffix: [],
				object: { volumeId: "volume", fileId: "b".repeat(32), creationTime: "1" },
			} satisfies NativePathDescriptorV2,
		};
		await db
			.update(narratorDeviceWorkspaces)
			.set({ workspaceContext: context })
			.where(eq(narratorDeviceWorkspaces.id, result.binding.id));
		await expect(
			service.select(
				n1,
				{
					requestId: generateId(),
					deviceId: "d1",
					expectedBindingRevision: 1,
					expectedSelectionRevision: 0,
				},
				options(),
			),
		).rejects.toMatchObject({ statusCode: 409 });
		expect((await workspaceContextService.get(n1)).revision).toBe(0);
	});
	test("narrator ACL revocation after prepare is rechecked before any durable binding", async () => {
		const backend = backends.get("d1");
		if (!backend) throw new Error("Missing fixture backend");
		const original = backend.resolvePathIdentity;
		const probe = spyOn(backend, "resolvePathIdentity").mockImplementation(async (path: string) => {
			const result = await original(path);
			await db
				.update(narrators)
				.set({ ownerUserId: admin, visibility: "private", writeAudience: "owner" })
				.where(eq(narrators.id, n1));
			return result;
		});
		try {
			await expect(set("d1")).rejects.toMatchObject({ statusCode: 404 });
			expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
		} finally {
			probe.mockRestore();
		}
	});
	test("filtered directory rows neither create empty cursor pages nor disclose their IDs", async () => {
		await set("d1");
		await set("d2", "/repo/b");
		await db.insert(narratorBlacklistDirs).values({
			id: generateId(),
			narratorId: n1,
			path: "/repo",
			targetKind: "device",
			targetValue: "d1",
			createdAt: new Date().toISOString(),
		});
		executionPolicyEngine.invalidate(n1);
		const page = await service.list(n1, { limit: 1 }, options());
		expect(page.items.map((item) => item.deviceId)).toEqual(["d2"]);
		expect(page.nextCursor).toBeNull();
		await db.insert(narratorBlacklistDirs).values({
			id: generateId(),
			narratorId: n1,
			path: "/repo/b",
			targetKind: "device",
			targetValue: "d2",
			createdAt: new Date().toISOString(),
		});
		executionPolicyEngine.invalidate(n1);
		expect(await service.list(n1, { limit: 1 }, options())).toEqual({
			items: [],
			nextCursor: null,
		});
	});
	test("current directory deny rules prevent binding mutation and hide list summaries", async () => {
		await set("d1");
		await db.insert(narratorBlacklistDirs).values({
			id: generateId(),
			narratorId: n1,
			path: "/repo",
			targetKind: "device",
			targetValue: "d1",
			createdAt: new Date().toISOString(),
		});
		executionPolicyEngine.invalidate(n1);
		await expect(set("d1", "/repo/b", 1)).rejects.toMatchObject({
			code: "WORKSPACE_ACCESS_DENIED",
		});
		expect((await service.list(n1, {}, options())).items).toEqual([]);
		expect(readDeviceWorkspaceBinding(db, n1, "d1")?.bindingRevision).toBe(1);
	});
	test("new binding mutation cannot broaden OAuth configuration or device authority", async () => {
		await set("d1");
		const runtime = spyOn(oauthRuntime, "resolveOAuthNarratorRuntimePolicy").mockResolvedValue({
			allowedTools: new Set(["Read"]),
			allowLocalExecution: false,
			deviceIds: [],
			clientId: "client",
			grantId: "grant",
			policy: { deviceAccess: { host: "denied", global: "denied", selfRegistered: "denied" } },
		} as never);
		try {
			await expect(set("d2")).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
			await expect(
				service.select(
					n1,
					{
						requestId: generateId(),
						deviceId: "d1",
						expectedBindingRevision: 1,
						expectedSelectionRevision: 0,
					},
					options(),
				),
			).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
			expect(readDeviceWorkspaceBinding(db, n1, "d2")).toBeNull();
			expect(
				(await db.query.narrators.findFirst({ where: eq(narrators.id, n1) }))?.workspaceRevision,
			).toBe(0);
		} finally {
			runtime.mockRestore();
		}
	});
	test("legacy same-directory success stores its binding without changing selection revision", async () => {
		const result = await workspaceContextService.switch(
			n1,
			{
				requestId: generateId(),
				expectedRevision: 0,
				target: { deviceId: "local", cwd: join(root, "a") },
			},
			options(),
		);
		expect(result.changed).toBe(false);
		expect(result.current.revision).toBe(0);
		expect(result.current.binding?.bindingRevision).toBe(1);
		expect(readDeviceWorkspaceBinding(db, n1, "local")?.context.contextKey).toBe(
			result.current.contextKey,
		);
	});
	test("inactive set still respects conservative compact/history admission", async () => {
		compactLocks.set(n1, {
			kind: "history",
			promise: Promise.resolve({ kind: "history", compacted: false }),
		});
		await expect(set("d1")).rejects.toMatchObject({ statusCode: 409 });
		expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
	});
	test("HTTP list/get/put/select run behind ACL and reject caller binding refs and oversized bodies", async () => {
		const body = { requestId: "http-set", cwd: "/repo/b", expectedBindingRevision: 0 };
		const response = await app().request(`${base()}/d1`, json("PUT", body));
		expect(response.status).toBe(200);
		expect((await app().request(`${base()}/d1`)).status).toBe(200);
		const list = await (await app().request(`${base()}?limit=1`)).json();
		expect(list.items[0]).toMatchObject({ cwd: "/repo/b", deviceId: "d1" });
		expect(JSON.stringify(list)).not.toContain("nativeRootDescriptor");
		expect(
			(
				await app().request(
					`${base()}/select`,
					json("POST", {
						requestId: "http-select",
						deviceId: "d1",
						expectedBindingRevision: 1,
						expectedSelectionRevision: 0,
					}),
				)
			).status,
		).toBe(200);
		expect(
			(await app().request(`${base()}/d2`, json("PUT", { ...body, binding: { narratorId: n2 } })))
				.status,
		).toBe(400);
		expect(
			(await app().request(`${base()}/d2`, json("PUT", { ...body, cwd: "x".repeat(17000) })))
				.status,
		).toBe(413);
		expect((await app().request(`${base()}?limit=33`)).status).toBe(400);
		const stranger = generateId();
		expect((await app(stranger).request(base())).status).toBe(404);
	});
	test("cursor pages are bounded summaries and no backend resolver fallback leaks offline cwd", async () => {
		await set("d1");
		await set("d2", "/repo/b");
		const first = await service.list(n1, { limit: 1 }, options());
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).toBe("d1");
		const second = await service.list(
			n1,
			{ limit: 1, cursor: first.nextCursor ?? undefined },
			options(),
		);
		expect(second.items.map((item) => item.deviceId)).toEqual(["d2"]);
		expect(second.nextCursor).toBeNull();
		setRemoteBackendResolver(null);
		expect((await service.list(n1, {}, options())).items).toEqual([]);
	});
});

async function seedEndpointDevice() {
	const now = new Date().toISOString();
	await db.insert(remoteDevices).values({
		id: "d1",
		name: "endpoint",
		slug: "endpoint-d1",
		tokenHash: "fixture",
		tokenPrefix: "fixture",
		createdBy: owner,
		scope: "global",
		ownerScope: "shared",
		status: "online",
		createdAt: now,
		updatedAt: now,
	});
}

async function seedOAuthEndpointDevices() {
	await seedEndpointDevice();
	const now = new Date().toISOString();
	const clientId = generateId();
	const grantId = generateId();
	const policy = {
		...DEFAULT_OAUTH_CLIENT_POLICY,
		deviceAccess: {
			host: "denied" as const,
			global: "readWrite" as const,
			selfRegistered: "readWrite" as const,
		},
	};
	await db.insert(oauthClients).values({
		id: clientId,
		clientId,
		name: "endpoint dependency fixture",
		redirectUris: [],
		scopes: ["narrator.send_message"],
		publicClient: true,
		policyJson: policy,
		createdBy: owner,
		createdAt: now,
		updatedAt: now,
	});
	await integrationAuthorityService.create({
		id: grantId,
		kind: "oauth_grant",
		integrationType: "oauth_client",
		integrationId: clientId,
		ownerUserId: owner,
		policyJson: policy,
		grants: [
			{
				capabilityId: "narrator.send_message",
				scope: { type: "global" },
				createdBy: { type: "user", id: owner },
			},
		],
	});
	await db.insert(remoteDevices).values({
		id: "d2",
		name: "peer endpoint",
		slug: "endpoint-d2",
		tokenHash: "fixture",
		tokenPrefix: "fixture",
		createdBy: owner,
		scope: "global",
		ownerScope: "shared",
		status: "online",
		createdAt: now,
		updatedAt: now,
	});
	for (const [resourceType, resourceId] of [
		["narrator", n1],
		["device", "d1"],
		["device", "d2"],
	] as const) {
		await integrationResourceBindingService.create({
			resourceType,
			resourceId,
			sourceType: "oauth_client",
			sourceId: clientId,
			authorityType: "oauth_grant",
			authorityId: grantId,
			state: "active",
		});
	}
	await db
		.update(narrators)
		.set({
			defaultDeviceId: "d1",
			oauthPolicySnapshotJson: {
				version: 3,
				policy,
				permissionMode: "readOnly",
				systemPrompt: null,
				projectId: null,
				defaultDeviceId: "d1",
				deviceIds: ["d1", "d2"],
			},
		})
		.where(eq(narrators.id, n1));
	return {
		clientId,
		grantId,
		cleanup: async () => {
			await db
				.delete(integrationResourceBindings)
				.where(eq(integrationResourceBindings.authorityId, grantId));
			await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, grantId));
			await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
		},
	};
}

describe("binding-free endpoint live device authority", () => {
	for (const change of ["revoke", "delete", "provenance"] as const) {
		test(`D1 proof fences the entire OAuth device snapshot after D2 ${change}`, async () => {
			const fixture = await seedOAuthEndpointDevices();
			const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
			try {
				const proof = await service.assertEndpointDeviceCurrent(n1, "d1", options());
				proof.assertStillCurrent();
				if (change === "revoke") expect(await revokeDevice("d2")).toBe(true);
				else if (change === "delete")
					await db.delete(remoteDevices).where(eq(remoteDevices.id, "d2"));
				else
					await db
						.update(integrationResourceBindings)
						.set({ authorityId: "replacement-grant", revision: 2 })
						.where(eq(integrationResourceBindings.resourceId, "d2"));
				await expect(
					oauthRuntime.resolveOAuthNarratorRuntimePolicy(n1, owner),
				).rejects.toMatchObject({ code: "OAUTH_RUNTIME_FORBIDDEN" });
				expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			} finally {
				online.mockRestore();
				await fixture.cleanup();
			}
		});
	}
	test("OAuth snapshot dependency overflow fails closed before device enumeration or RPC", async () => {
		const fixture = await seedOAuthEndpointDevices();
		try {
			await db
				.update(narrators)
				.set({
					oauthPolicySnapshotJson: {
						version: 3,
						policy: DEFAULT_OAUTH_CLIENT_POLICY,
						permissionMode: "readOnly",
						systemPrompt: null,
						projectId: null,
						defaultDeviceId: "d1",
						deviceIds: ["d1", ...Array.from({ length: 16 }, (_, index) => `peer-${index}`)],
					},
				})
				.where(eq(narrators.id, n1));
			expect(() => endpointDeviceAuthorityFingerprint(n1, "d1", owner)).toThrow(
				"exceeds its bound",
			);
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				code: "WORKSPACE_CONTEXT_CONFLICT",
			});
			expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
		} finally {
			await fixture.cleanup();
		}
	});
	for (const change of ["revoke-project-read", "move-chapter-project"] as const) {
		test(`chapter-only authority cannot accept a post-await ${change} snapshot`, async () => {
			await seedEndpointDevice();
			const p1 = generateId();
			const p2 = generateId();
			const chapterId = generateId();
			const grantId = generateId();
			const now = new Date().toISOString();
			await db.insert(projects).values(
				[p1, p2].map((id) => ({
					id,
					name: "private project",
					ownerUserId: admin,
					visibility: "private" as const,
					createdAt: now,
					updatedAt: now,
				})),
			);
			await db.insert(chapters).values({
				id: chapterId,
				projectId: p1,
				title: "chapter-only fixture",
				branch: "main",
				baseBranch: "main",
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(aclGrants).values({
				id: grantId,
				scopeType: "project",
				scopeId: p1,
				principalType: "user",
				principalId: owner,
				capability: "read",
				createdAt: now,
			});
			await db
				.update(narrators)
				.set({ chapterId, contextProjectId: null, workspaceContext: null })
				.where(eq(narrators.id, n1));
			const original = projectAccess.loadProjectForAccess;
			const load = spyOn(projectAccess, "loadProjectForAccess").mockImplementation(
				async (id, principal, need) => {
					const accepted = await original(id, principal, need);
					if (change === "revoke-project-read")
						await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
					else await db.update(chapters).set({ projectId: p2 }).where(eq(chapters.id, chapterId));
					return accepted;
				},
			);
			const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
			try {
				await expect(
					service.assertEndpointDeviceCurrent(n1, "d1", options()),
				).rejects.toBeInstanceOf(AppError);
				expect(load).toHaveBeenCalled();
			} finally {
				load.mockRestore();
				online.mockRestore();
				await db.update(narrators).set({ chapterId: null }).where(eq(narrators.id, n1));
				await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
				await db.delete(chapters).where(eq(chapters.id, chapterId));
				for (const id of [p1, p2]) await db.delete(projects).where(eq(projects.id, id));
			}
		});
	}
	test("one indexed device authorization plus its final fence performs zero workspace/FS/RPC and no device-list scan", async () => {
		await seedEndpointDevice();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const workspace = spyOn(workspaceContextService, "get").mockRejectedValue(
			new Error("Unexpected workspace IO"),
		);
		const backend = backends.get("d1");
		if (!backend) throw new Error("Missing backend");
		const resolve = spyOn(backend, "resolvePathIdentity").mockRejectedValue(
			new Error("Unexpected path RPC"),
		);
		const stat = spyOn(backend, "statFile").mockRejectedValue(new Error("Unexpected stat RPC"));
		const scan = spyOn(connections, "getSessionDevices");
		try {
			const proof = await service.assertEndpointDeviceCurrent(n1, "d1", options());
			proof.assertStillCurrent();
			const localProof = await service.assertEndpointDeviceCurrent(n1, "local", options());
			localProof.assertStillCurrent();
			expect(workspace).not.toHaveBeenCalled();
			expect(resolve).not.toHaveBeenCalled();
			expect(stat).not.toHaveBeenCalled();
			expect(scan).not.toHaveBeenCalled();
			expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
			expect(readDeviceWorkspaceBinding(db, n1, "local")).toBeNull();
		} finally {
			online.mockRestore();
			workspace.mockRestore();
			resolve.mockRestore();
			stat.mockRestore();
		}
	});
	test("permission-pending shared-to-private ownership change invalidates the old final proof and fresh authorization", async () => {
		await seedEndpointDevice();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			const proof = await service.assertEndpointDeviceCurrent(n1, "d1", options());
			await db
				.update(remoteDevices)
				.set({ ownerScope: "private", createdBy: admin })
				.where(eq(remoteDevices.id, "d1"));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
			expect(readDeviceWorkspaceBinding(db, n1, "d1")).toBeNull();
		} finally {
			online.mockRestore();
		}
	});
	test("unknown, offline, revoked and deleted endpoint devices cannot reuse a stale authorization", async () => {
		await seedEndpointDevice();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			await expect(service.assertEndpointDeviceCurrent(n1, "d2", options())).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
			const proof = await service.assertEndpointDeviceCurrent(n1, "d1", options());
			online.mockReturnValue(false);
			expect(() => proof.assertStillCurrent()).toThrow("offline");
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				code: "WORKSPACE_DEVICE_OFFLINE",
			});
			online.mockReturnValue(true);
			await db
				.update(remoteDevices)
				.set({ revokedAt: new Date().toISOString() })
				.where(eq(remoteDevices.id, "d1"));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
			await db.delete(remoteDevices).where(eq(remoteDevices.id, "d1"));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
		} finally {
			online.mockRestore();
		}
	});
	test("scope cannot be granted by a caller's project hint and narrator ACL changes invalidate the no-await fence", async () => {
		await seedEndpointDevice();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			await expect(
				service.assertEndpointDeviceCurrent(n1, "d1", {
					userId: owner,
					contextProjectId: "caller-project",
				}),
			).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
			const proof = await service.assertEndpointDeviceCurrent(n1, "d1", options());
			await db
				.update(remoteDevices)
				.set({ scope: "project", projectId: null })
				.where(eq(remoteDevices.id, "d1"));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
			await db.update(remoteDevices).set({ scope: "global" }).where(eq(remoteDevices.id, "d1"));
			await db
				.update(narrators)
				.set({ ownerUserId: admin, visibility: "private", writeAudience: "owner" })
				.where(eq(narrators.id, n1));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				statusCode: 404,
			});
		} finally {
			online.mockRestore();
		}
	});
	test("device privacy revocation during asynchronous OAuth verification is caught before returning a proof", async () => {
		await seedEndpointDevice();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const oauth = spyOn(
			oauthDeviceRuntime,
			"resolveOAuthDeviceRuntimeAuthorization",
		).mockImplementation(async () => {
			await db
				.update(remoteDevices)
				.set({ ownerScope: "private", createdBy: admin })
				.where(eq(remoteDevices.id, "d1"));
			return { oauthOwned: false, allowed: true };
		});
		try {
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
		} finally {
			online.mockRestore();
			oauth.mockRestore();
		}
	});
	test("new OAuth provenance and inactive device grants invalidate stale endpoint proofs", async () => {
		await seedEndpointDevice();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			const proof = await service.assertEndpointDeviceCurrent(n1, "d1", options());
			const now = new Date().toISOString();
			await db.insert(integrationResourceBindings).values({
				id: generateId(),
				resourceType: "device",
				resourceId: "d1",
				sourceType: "oauth_client",
				sourceId: "client",
				authorityType: "oauth_grant",
				authorityId: "grant",
				state: "revoked",
				revision: 1,
				createdAt: now,
				updatedAt: now,
			});
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(service.assertEndpointDeviceCurrent(n1, "d1", options())).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
		} finally {
			online.mockRestore();
		}
	});
	test("indexed authority fence expires OAuth roots by the actual instant rather than timestamp spelling", async () => {
		await seedEndpointDevice();
		const authorityId = generateId();
		const now = new Date().toISOString();
		await db.insert(integrationAuthorities).values({
			id: authorityId,
			kind: "oauth_grant",
			integrationType: "oauth_client",
			integrationId: "client",
			ownerUserId: owner,
			state: "active",
			expiresAt: "2026-10-11T19:00:00+01:00",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(integrationResourceBindings).values({
			id: generateId(),
			resourceType: "device",
			resourceId: "d1",
			sourceType: "oauth_client",
			sourceId: "client",
			authorityType: "oauth_grant",
			authorityId,
			state: "active",
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});
		const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-11T17:59:00Z"));
		try {
			expect(typeof endpointDeviceAuthorityFingerprint(n1, "d1", owner)).toBe("string");
			clock.mockReturnValue(Date.parse("2026-10-11T18:01:00Z"));
			expect(() => endpointDeviceAuthorityFingerprint(n1, "d1", owner)).toThrow("expired");
		} finally {
			clock.mockRestore();
			await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, authorityId));
		}
	});
	test("local endpoint authority honors the current OAuth host ceiling without needing a binding", async () => {
		const runtime = spyOn(oauthRuntime, "resolveOAuthNarratorRuntimePolicy").mockResolvedValue({
			allowedTools: new Set(["Read"]),
			allowLocalExecution: false,
			deviceIds: [],
			clientId: "client",
			grantId: "grant",
			policy: { deviceAccess: { host: "readOnly", global: "denied", selfRegistered: "denied" } },
		} as never);
		try {
			await expect(
				service.assertEndpointDeviceCurrent(n1, "local", options()),
			).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
			expect(readDeviceWorkspaceBinding(db, n1, "local")).toBeNull();
		} finally {
			runtime.mockRestore();
		}
	});
});

function originalAuthority(
	originalProjectId: string | null | undefined,
	actor = owner,
): Promise<WorkspaceEndpointDeviceAuthority> {
	return service.assertOriginalEndpointDeviceCurrent(n1, "d1", {
		userId: actor,
		// Deliberately retain the undefined test case at the runtime boundary.
		originalProjectId: originalProjectId as string | null,
	});
}

async function seedOriginalProjectResource() {
	await seedEndpointDevice();
	const projectA = generateId();
	const projectB = generateId();
	const grantId = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values(
		[projectA, projectB].map((id) => ({
			id,
			name: "resource project",
			ownerUserId: admin,
			visibility: "private" as const,
			createdAt: now,
			updatedAt: now,
		})),
	);
	await db.insert(aclGrants).values({
		id: grantId,
		scopeType: "project",
		scopeId: projectA,
		principalType: "user",
		principalId: owner,
		capability: "read",
		createdAt: now,
	});
	await db
		.update(remoteDevices)
		.set({ scope: "project", projectId: projectA })
		.where(eq(remoteDevices.id, "d1"));
	const source = db.transaction((tx) =>
		insertInitialDeviceWorkspaceBinding(tx, {
			narratorId: n1,
			createdAt: now,
			context: {
				revision: 0,
				deviceId: "d1",
				cwd: "/repo/a",
				pathFlavor: "posix",
				contextKey: "original-resource-a",
				contextProjectId: projectA,
				capabilities: { switchDirectory: true },
			},
		}),
	);
	await db
		.update(narrators)
		.set({
			contextProjectId: projectA,
			defaultDeviceId: "d1",
			cwd: source.cwd,
			workspaceContext: source,
		})
		.where(eq(narrators.id, n1));
	return {
		projectA,
		projectB,
		grantId,
		source,
		cleanup: async () => {
			await db
				.update(narrators)
				.set({ contextProjectId: null, workspaceContext: null })
				.where(eq(narrators.id, n1));
			await db
				.update(remoteDevices)
				.set({ scope: "global", projectId: null })
				.where(eq(remoteDevices.id, "d1"));
			await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
			for (const id of [projectA, projectB]) await db.delete(projects).where(eq(projects.id, id));
		},
	};
}

test("selection status HTTP rechecks live roles rather than trusting stale admin JWT and performs no endpoint probes", async () => {
	const adminRouter = app(admin);
	const ownerRouter = app(owner);
	const workspace = spyOn(workspaceContextService, "get").mockRejectedValue(
		new Error("Unexpected workspace context read"),
	);
	const scan = spyOn(connections, "getSessionDevices");
	const backend = backends.get("d1");
	if (!backend) throw new Error("Missing backend");
	const path = spyOn(backend, "resolvePathIdentity").mockRejectedValue(
		new Error("Unexpected path RPC"),
	);
	const stat = spyOn(backend, "statFile").mockRejectedValue(new Error("Unexpected stat RPC"));
	try {
		const ownerStatus = await ownerRouter.request(`${base()}/selection-status`);
		expect(ownerStatus.status).toBe(200);
		expect(await ownerStatus.json()).toEqual({ revision: 0, installed: true });
		const authorized = await adminRouter.request(`${base()}/selection-status`);
		expect(authorized.status).toBe(200);
		expect(await authorized.json()).toEqual({ revision: 0, installed: true });
		await db.update(users).set({ role: "user" }).where(eq(users.id, admin));
		// app(admin) still supplies role:admin in the JWT fixture, but the canonical user is no longer admin.
		const denied = await adminRouter.request(`${base()}/selection-status`);
		expect(denied.status).toBe(404);
		const body = await denied.json();
		expect(body).not.toHaveProperty("revision");
		expect(body).not.toHaveProperty("installed");
		await expect(
			service.getSelectionInstallationStatus(n1, { userId: admin }),
		).rejects.toMatchObject({ statusCode: 404 });
		const absent = await adminRouter.request(
			`/api/narrators/${generateId()}/device-workspaces/selection-status`,
		);
		expect(absent.status).toBe(404);
		expect(workspace).not.toHaveBeenCalled();
		expect(scan).not.toHaveBeenCalled();
		expect(path).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
	} finally {
		workspace.mockRestore();
		path.mockRestore();
		stat.mockRestore();
	}
});

describe("durable device binding summary notices", () => {
	test("inactive commits emit only narrator-id invalidation, while conflicts and receipt replay emit nothing", async () => {
		const events: unknown[] = [];
		const emit = spyOn(narratorWs, "broadcastToNarrator").mockImplementation((_id, event) => {
			events.push(event);
		});
		try {
			const request = {
				requestId: "notice-inactive",
				deviceId: "d1",
				cwd: "/repo/a",
				expectedBindingRevision: 0,
			};
			await service.set(n1, request, options());
			expect(events).toEqual([{ type: "device_workspace_bindings_changed", narratorId: n1 }]);
			expect(JSON.stringify(events)).not.toContain("/repo");
			expect(JSON.stringify(events)).not.toContain("bindingRevision");
			events.length = 0;
			await service.set(n1, request, options());
			expect(events).toEqual([]);
			await expect(
				service.set(n1, { ...request, requestId: "notice-conflict", cwd: "/repo/b" }, options()),
			).rejects.toBeInstanceOf(AppError);
			expect(events).toEqual([]);
		} finally {
			emit.mockRestore();
		}
	});
	test("selection install failure emits durable invalidation but never a fake installed workspace context", async () => {
		await set("d1");
		const events: unknown[] = [];
		const emit = spyOn(narratorWs, "broadcastToNarrator").mockImplementation((_id, event) => {
			events.push(event);
		});
		activeNarrators.set(n1, {
			alive: true,
			cwd: join(root, "a"),
			_loopRunning: false,
			abortController: new AbortController(),
		} as ActiveNarrator);
		const install = spyOn(session, "updateActiveNarratorCwdAndSkillContext").mockRejectedValueOnce(
			new Error("notice install failure"),
		);
		try {
			await expect(
				service.select(
					n1,
					{
						requestId: "notice-install-fail",
						deviceId: "d1",
						expectedBindingRevision: 1,
						expectedSelectionRevision: 0,
					},
					options(),
				),
			).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_INSTALL_FAILED" });
			expect(events).toEqual([{ type: "device_workspace_bindings_changed", narratorId: n1 }]);
			expect((await service.getRequest(n1, "notice-install-fail", options()))?.installState).toBe(
				"pending",
			);
		} finally {
			install.mockRestore();
			emit.mockRestore();
		}
	});
});

test("real HTTP select pending projection and same-id recovery never become installed merely by reading current B", async () => {
	await seedEndpointDevice();
	await set("d1", "/repo/b");
	const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
	const active = {
		alive: true,
		cwd: join(root, "a"),
		_loopRunning: false,
		abortController: new AbortController(),
	} as ActiveNarrator;
	activeNarrators.set(n1, active);
	const install = spyOn(session, "updateActiveNarratorCwdAndSkillContext").mockRejectedValueOnce(
		new Error("HTTP pending install failure"),
	);
	const router = app();
	const requestId = "http-select-pending";
	const request = {
		requestId,
		deviceId: "d1",
		expectedBindingRevision: 1,
		expectedSelectionRevision: 0,
	};
	try {
		const response = await router.request(`${base()}/select`, json("POST", request));
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "WORKSPACE_CONTEXT_INSTALL_FAILED" });
		const stored = await db.query.narrators.findFirst({ where: eq(narrators.id, n1) });
		expect(stored?.workspaceContext).toMatchObject({ deviceId: "d1", cwd: "/repo/b", revision: 1 });
		expect(stored?.workspaceRevision).toBe(1);
		expect(active._workspaceInstallFailed).toBe(true);
		const pendingResponse = await router.request(`${base()}/requests/${requestId}`);
		expect(pendingResponse.status).toBe(200);
		const pending = await pendingResponse.json();
		expect(pending).toMatchObject({
			requestId,
			kind: "select",
			installState: "pending",
			result: { selection: { current: { deviceId: "d1", cwd: "/repo/b", revision: 1 } } },
		});
		const current = await router.request(`/api/narrators/${n1}/workspace-context`);
		expect(current.status).toBe(200);
		expect(await current.json()).toMatchObject({ deviceId: "d1", cwd: "/repo/b", revision: 1 });
		expect(active._workspaceInstallFailed).toBe(true);
		expect((await service.getRequest(n1, requestId, options()))?.installState).toBe("pending");
		// The real actor already passed the HTTP narrator/receipt ACL above. This
		// scalar gate is not itself an authorization, and reading current B is not recovery.
		expect(workspaceSelectionInstallationStatus(n1)).toEqual({ revision: 1, installed: false });
		const pendingStatus = await router.request(`${base()}/selection-status`);
		expect(pendingStatus.status).toBe(200);
		expect(await pendingStatus.json()).toEqual({ revision: 1, installed: false });
		let blocked: unknown;
		try {
			assertWorkspaceSelectionInstalled(n1);
		} catch (error) {
			blocked = error;
		}
		expect(blocked).toMatchObject({ statusCode: 409, code: "WORKSPACE_CONTEXT_INSTALL_PENDING" });
		activeNarrators.delete(n1);
		expect(workspaceSelectionInstallationStatus(n1)).toEqual({ revision: 1, installed: false });
		const persistedPendingStatus = await router.request(`${base()}/selection-status`);
		expect(persistedPendingStatus.status).toBe(200);
		expect(await persistedPendingStatus.json()).toEqual({ revision: 1, installed: false });
		blocked = undefined;
		try {
			assertWorkspaceSelectionInstalled(n1);
		} catch (error) {
			blocked = error;
		}
		expect(blocked).toMatchObject({ statusCode: 409, code: "WORKSPACE_CONTEXT_INSTALL_PENDING" });
		// An existing server-owned original resource must not acquire the current
		// selection installation/map lock merely because the durable projection is B.
		(
			await service.assertOriginalEndpointDeviceCurrent(n1, "d1", {
				userId: owner,
				originalProjectId: null,
			})
		).assertStillCurrent();
		activeNarrators.set(n1, active);
		const recovered = await router.request(
			`${base()}/requests/${requestId}/recover`,
			json("POST", {}),
		);
		expect(recovered.status).toBe(200);
		expect(await recovered.json()).toEqual(pending.result);
		const installedResponse = await router.request(`${base()}/requests/${requestId}`);
		expect(installedResponse.status).toBe(200);
		expect(await installedResponse.json()).toMatchObject({
			requestId,
			installState: "installed",
			result: pending.result,
		});
		expect(active._workspaceInstallFailed).toBe(false);
		expect(workspaceSelectionInstallationStatus(n1)).toEqual({ revision: 1, installed: true });
		const installedStatus = await router.request(`${base()}/selection-status`);
		expect(installedStatus.status).toBe(200);
		expect(await installedStatus.json()).toEqual({ revision: 1, installed: true });
		expect(() => assertWorkspaceSelectionInstalled(n1)).not.toThrow();
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, n1) }))?.workspaceRevision,
		).toBe(1);
		expect(readDeviceWorkspaceBinding(db, n1, "d1")?.bindingRevision).toBe(1);
		const replay = await router.request(`${base()}/select`, json("POST", request));
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(pending.result);
		expect(readDeviceWorkspaceBinding(db, n1, "d1")?.id).toBe(pending.result.binding.id);
	} finally {
		install.mockRestore();
		online.mockRestore();
	}
});

describe("server-owned original resource endpoint authority", () => {
	test("A remains authorized after current binding/project moves to B, while strict new-tool hints still reject A", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			(await originalAuthority(fixture.projectA)).assertStillCurrent();
			const replacement = deviceWorkspaceBindingContext(
				n1,
				fixture.source.binding?.bindingId ?? "missing",
				2,
				{
					...fixture.source,
					cwd: "/repo/b",
					contextKey: "current-b",
					contextProjectId: fixture.projectB,
				},
			);
			await db
				.update(narratorDeviceWorkspaces)
				.set({ bindingRevision: 2, workspaceContext: replacement, cwd: replacement.cwd })
				.where(eq(narratorDeviceWorkspaces.narratorId, n1));
			await db
				.update(narrators)
				.set({
					workspaceContext: replacement,
					workspaceRevision: 1,
					contextProjectId: fixture.projectB,
					cwd: replacement.cwd,
				})
				.where(eq(narrators.id, n1));
			await expect(
				service.assertEndpointDeviceCurrent(n1, "d1", {
					userId: owner,
					contextProjectId: fixture.projectA,
				}),
			).rejects.toBeInstanceOf(AppError);
			(await originalAuthority(fixture.projectA)).assertStillCurrent();
			expect(fixture.source.cwd).toBe("/repo/a");
			expect(fixture.source.binding?.bindingRevision).toBe(1);
		} finally {
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("explicit standalone null is not replaced by the current project; unknown source never borrows it", async () => {
		await seedEndpointDevice();
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "current private project",
			ownerUserId: admin,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
		await db.update(narrators).set({ contextProjectId: projectId }).where(eq(narrators.id, n1));
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			(await originalAuthority(null)).assertStillCurrent();
			await expect(originalAuthority(undefined)).rejects.toMatchObject({
				code: "WORKSPACE_ORIGINAL_CONTEXT_REQUIRED",
			});
		} finally {
			online.mockRestore();
			await db.update(narrators).set({ contextProjectId: null }).where(eq(narrators.id, n1));
			await db.delete(projects).where(eq(projects.id, projectId));
		}
	});
	test("original proof survives unrelated default selection and same-device binding revisions without filesystem or device-list IO", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const workspace = spyOn(workspaceContextService, "get").mockRejectedValue(
			new Error("Unexpected current workspace read"),
		);
		const backend = backends.get("d1");
		if (!backend) throw new Error("Missing backend");
		const resolve = spyOn(backend, "resolvePathIdentity").mockRejectedValue(
			new Error("Unexpected filesystem RPC"),
		);
		const stat = spyOn(backend, "statFile").mockRejectedValue(new Error("Unexpected stat RPC"));
		const scan = spyOn(connections, "getSessionDevices");
		try {
			const proof = await originalAuthority(fixture.projectA);
			await db
				.update(narratorDeviceWorkspaces)
				.set({ bindingRevision: 20, cwd: "/repo/b" })
				.where(eq(narratorDeviceWorkspaces.narratorId, n1));
			await db
				.update(narrators)
				.set({ defaultDeviceId: "d2", workspaceRevision: 20, cwd: "/repo/b" })
				.where(eq(narrators.id, n1));
			proof.assertStillCurrent();
			(await originalAuthority(fixture.projectA)).assertStillCurrent();
			expect(workspace).not.toHaveBeenCalled();
			expect(resolve).not.toHaveBeenCalled();
			expect(stat).not.toHaveBeenCalled();
			expect(scan).not.toHaveBeenCalled();
		} finally {
			online.mockRestore();
			workspace.mockRestore();
			resolve.mockRestore();
			stat.mockRestore();
			await fixture.cleanup();
		}
	});
	test("standalone original null cannot borrow a matching current project to use a project-scoped device", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			(
				await service.assertEndpointDeviceCurrent(n1, "d1", {
					userId: owner,
					contextProjectId: fixture.projectA,
				})
			).assertStillCurrent();
			await expect(originalAuthority(null)).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
		} finally {
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("original project Read grant revocation at the final no-await fence rejects even when the narrator remains readable", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			const proof = await originalAuthority(fixture.projectA);
			await db.delete(aclGrants).where(eq(aclGrants.id, fixture.grantId));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(originalAuthority(fixture.projectA)).rejects.toBeInstanceOf(AppError);
		} finally {
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("original project Read revocation inside an accepted authorization await cannot mint a proof", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const originalLoad = projectAccess.loadProjectForAccess;
		const load = spyOn(projectAccess, "loadProjectForAccess").mockImplementation(
			async (id, principal, need) => {
				const accepted = await originalLoad(id, principal, need);
				if (id === fixture.projectA)
					await db.delete(aclGrants).where(eq(aclGrants.id, fixture.grantId));
				return accepted;
			},
		);
		try {
			await expect(originalAuthority(fixture.projectA)).rejects.toBeInstanceOf(AppError);
			expect(load).toHaveBeenCalled();
		} finally {
			load.mockRestore();
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("actor and original project stay frozen against caller options mutation and admin role loss invalidates an original proof", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const request = { userId: owner, originalProjectId: fixture.projectA };
		const originalLoad = projectAccess.loadProjectForAccess;
		const load = spyOn(projectAccess, "loadProjectForAccess").mockImplementation(
			async (id, principal, need) => {
				const accepted = await originalLoad(id, principal, need);
				request.userId = admin;
				request.originalProjectId = fixture.projectB;
				return accepted;
			},
		);
		try {
			const proof = await service.assertOriginalEndpointDeviceCurrent(n1, "d1", request);
			proof.assertStillCurrent();
			load.mockRestore();
			const adminProof = await originalAuthority(fixture.projectA, admin);
			await db.update(users).set({ role: "user" }).where(eq(users.id, admin));
			expect(() => adminProof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(originalAuthority(fixture.projectA, admin)).rejects.toBeInstanceOf(AppError);
			await expect(
				service.assertOriginalEndpointDeviceCurrent(n1, "d1", {
					originalProjectId: fixture.projectA,
				} as { userId: string; originalProjectId: string }),
			).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
		} finally {
			load.mockRestore();
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("admin role loss during an original project authorization await cannot reuse the earlier privileged Read", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const originalLoad = projectAccess.loadProjectForAccess;
		const load = spyOn(projectAccess, "loadProjectForAccess").mockImplementation(
			async (id, principal, need) => {
				const accepted = await originalLoad(id, principal, need);
				await db.update(users).set({ role: "user" }).where(eq(users.id, admin));
				return accepted;
			},
		);
		try {
			await expect(originalAuthority(fixture.projectA, admin)).rejects.toBeInstanceOf(AppError);
			expect(load).toHaveBeenCalled();
		} finally {
			load.mockRestore();
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("live narrator Read ACL remains required even when original project Read and device authority still hold", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			const proof = await originalAuthority(fixture.projectA);
			await db
				.update(narrators)
				.set({ ownerUserId: admin, visibility: "private" })
				.where(eq(narrators.id, n1));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(originalAuthority(fixture.projectA)).rejects.toMatchObject({ statusCode: 404 });
		} finally {
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("device scope, private owner and offline changes invalidate original resources rather than borrowing a new project/default", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		try {
			const proof = await originalAuthority(fixture.projectA);
			online.mockReturnValue(false);
			expect(() => proof.assertStillCurrent()).toThrow("offline");
			online.mockReturnValue(true);
			await db
				.update(remoteDevices)
				.set({ ownerScope: "private", createdBy: admin })
				.where(eq(remoteDevices.id, "d1"));
			expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
			await expect(originalAuthority(fixture.projectA)).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
			await db
				.update(remoteDevices)
				.set({ ownerScope: "shared", projectId: fixture.projectB })
				.where(eq(remoteDevices.id, "d1"));
			await expect(originalAuthority(fixture.projectA)).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
		} finally {
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	test("device privacy change during OAuth verification is rejected before an original resource proof returns", async () => {
		const fixture = await seedOriginalProjectResource();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const oauth = spyOn(
			oauthDeviceRuntime,
			"resolveOAuthDeviceRuntimeAuthorization",
		).mockImplementation(async () => {
			await db
				.update(remoteDevices)
				.set({ ownerScope: "private", createdBy: admin })
				.where(eq(remoteDevices.id, "d1"));
			return { oauthOwned: false, allowed: true };
		});
		try {
			await expect(originalAuthority(fixture.projectA)).rejects.toMatchObject({
				code: "WORKSPACE_ACCESS_DENIED",
			});
		} finally {
			oauth.mockRestore();
			online.mockRestore();
			await fixture.cleanup();
		}
	});
	for (const change of ["peer-revoke", "client-revoke"] as const) {
		test(`original standalone resources still honor all live OAuth dependencies at the tail: ${change}`, async () => {
			const fixture = await seedOAuthEndpointDevices();
			const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
			try {
				const proof = await originalAuthority(null);
				proof.assertStillCurrent();
				if (change === "peer-revoke") await revokeDevice("d2");
				else
					await db
						.update(oauthClients)
						.set({ revokedAt: new Date().toISOString() })
						.where(eq(oauthClients.id, fixture.clientId));
				expect(() => proof.assertStillCurrent()).toThrow("no longer authorized");
				await expect(originalAuthority(null)).rejects.toBeInstanceOf(AppError);
			} finally {
				online.mockRestore();
				await fixture.cleanup();
			}
		});
	}
	test("original resources cannot hide OAuth revocation during an authorization await or an over-limit snapshot", async () => {
		const fixture = await seedOAuthEndpointDevices();
		const online = spyOn(connections, "isDeviceOnline").mockReturnValue(true);
		const originalOAuth = oauthDeviceRuntime.resolveOAuthDeviceRuntimeAuthorization;
		const oauth = spyOn(
			oauthDeviceRuntime,
			"resolveOAuthDeviceRuntimeAuthorization",
		).mockImplementation(async (device) => {
			const accepted = await originalOAuth(device);
			await revokeDevice("d2");
			return accepted;
		});
		try {
			await expect(originalAuthority(null)).rejects.toBeInstanceOf(AppError);
			oauth.mockRestore();
			await db
				.update(narrators)
				.set({
					oauthPolicySnapshotJson: {
						version: 3,
						policy: DEFAULT_OAUTH_CLIENT_POLICY,
						permissionMode: "readOnly",
						systemPrompt: null,
						projectId: null,
						defaultDeviceId: "d1",
						deviceIds: ["d1", ...Array.from({ length: 16 }, (_, index) => `peer-${index}`)],
					},
				})
				.where(eq(narrators.id, n1));
			await expect(originalAuthority(null)).rejects.toMatchObject({
				code: "WORKSPACE_CONTEXT_CONFLICT",
			});
		} finally {
			oauth.mockRestore();
			online.mockRestore();
			await fixture.cleanup();
		}
	});
});
