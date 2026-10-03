import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { chapters, narratorBlacklistDirs, narrators, projects, users } from "../db/schema";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { switchDeviceTool } from "../lib/agent/tools/switch-device";
import type { ToolContext } from "../lib/agent/types";
import { AppError } from "../lib/errors";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { generateId } from "../lib/id";
import * as deviceConnections from "./device-connection-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import { applySessionDefaultDevice } from "./narrator-session";
import { type ActiveNarrator, activeNarrators } from "./narrator-session-state";
import { permissionPolicyChanges } from "./permission-rule-service";
import { workspaceContextService } from "./workspace-context-service";

// Test preload gives this real SQLite DB a temporary, process-isolated home.
const { db } = await import("../db");
const { narratorRoutes } = await import("../routes/narrators");
function app(actor: string) {
	const routes = new Hono();
	routes.use("*", async (c, next) => {
		c.set("user", { sub: actor, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	routes.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "TEST_ERROR",
				}),
				{
					status: error instanceof AppError ? error.statusCode : 500,
					headers: { "content-type": "application/json" },
				},
			),
	);
	routes.route("/api/narrators", narratorRoutes);
	return routes;
}
let root: string;
let id: string;
let owner: string;
let projectId: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "workspace-context-persistence-"));
	await mkdir(join(root, "old"));
	await mkdir(join(root, "new"));
	await mkdir(join(root, "other"));
	owner = generateId();
	projectId = generateId();
	id = generateId();
	await db.insert(users).values({
		id: owner,
		username: owner,
		passwordHash: "fixture",
		createdAt: new Date().toISOString(),
	});
	await db.insert(projects).values({
		id: projectId,
		name: "same project",
		gitPath: join(root, "old"),
		ownerUserId: owner,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	await db.insert(narrators).values({
		id,
		title: "context fixture",
		cwd: join(root, "old"),
		contextProjectId: projectId,
		ownerUserId: owner,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
});
afterEach(async () => {
	executionPolicyEngine.invalidate(id);
	await db.delete(narrators).where(eq(narrators.id, id));
	await db.delete(projects).where(eq(projects.id, projectId));
	await db.delete(users).where(eq(users.id, owner));
	await rm(root, { recursive: true, force: true });
});
function change(cwd: string, expectedRevision = 0) {
	return workspaceContextService.switch(
		id,
		{ expectedRevision, requestId: generateId(), target: { deviceId: "local", cwd } },
		{ origin: "http", userId: owner },
	);
}

describe("real SQLite workspace CAS", () => {
	test("production HTTP and model device switches publish CAS identities and preserve frozen children", async () => {
		const devices = [
			{
				id: "remote-fixture",
				slug: "remote-fixture",
				scope: "global" as const,
				name: "remote",
				online: true,
				defaultCwd: "/remote/default",
			},
		];
		const deviceSpy = spyOn(deviceConnections, "getSessionDevices").mockResolvedValue(devices);
		setRemoteBackendResolver((deviceId) =>
			deviceId === "remote-fixture"
				? Object.assign(Object.create(localBackend), {
						kind: "remote",
						deviceId,
						defaultCwd: "/remote/default",
					})
				: null,
		);
		const initial = await workspaceContextService.get(id);
		const active = {
			alive: true,
			cwd: initial.cwd,
			_defaultDeviceId: null,
			_workspaceContext: initial,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(id, active);
		// These are independent admitted identities, not references to mutable primary state.
		const child = { cwd: initial.cwd, _defaultDeviceId: null, _workspaceContext: initial };
		const terminal = { deviceId: "local", cwd: initial.cwd };
		const background = Object.freeze({
			deviceId: "local",
			cwd: initial.cwd,
			revision: initial.revision,
		});
		const broadcasts: Array<unknown> = [];
		const handler = (event: Extract<NarraForkEvent, { type: "narrator:message_broadcast" }>) => {
			if (event.narratorId === id) broadcasts.push(event.message);
		};
		eventBus.on("narrator:message_broadcast", handler);
		try {
			const router = app(owner);
			async function http(deviceId: string | null) {
				const response = await router.request(`/api/narrators/${id}/default-device`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ deviceId }),
				});
				expect(response.status).toBe(200);
				const contextResponse = await router.request(`/api/narrators/${id}/workspace-context`);
				expect(contextResponse.status).toBe(200);
				return await contextResponse.json();
			}
			const remote = await http("remote-fixture");
			expect(remote).toMatchObject({
				revision: 1,
				deviceId: "remote-fixture",
				cwd: "/remote/default",
				capabilities: { switchDirectory: false },
			});
			expect(remote.git).toBeUndefined();
			expect(remote.contextKey).not.toBe(initial.contextKey);
			expect(active._workspacePassInvalidated).toBe(true);
			expect(active._workspaceContext).toEqual(remote);
			const local = await http(null);
			expect(local).toMatchObject({ revision: 2, deviceId: "local", cwd: initial.cwd });
			for (const [device, revision] of [
				["remote-fixture", 3],
				["local", 4],
			] as const) {
				// Mimic a rebuilt pass: the real SwitchDevice body calls the production hook.
				active._workspacePassInvalidated = false;
				const result = await switchDeviceTool.execute({ device }, {
					availableDevices: devices,
					setDefaultDevice: (target) => applySessionDefaultDevice(id, active, target),
				} as ToolContext);
				expect(result.isError).not.toBe(true);
				const current = await workspaceContextService.get(id);
				expect(current.revision).toBe(revision);
				expect(current.deviceId).toBe(device);
				expect(current.cwd).toBe(device === "local" ? initial.cwd : "/remote/default");
			}
			const persisted = await db.query.narrators.findFirst({
				where: eq(narrators.id, id),
				columns: {
					cwd: true,
					defaultDeviceId: true,
					workspaceRevision: true,
					workspaceContext: true,
				},
			});
			expect(persisted?.cwd).toBe(initial.cwd);
			expect(persisted?.workspaceRevision).toBe(4);
			expect(persisted?.workspaceContext).toEqual(active._workspaceContext);
			expect(broadcasts).toHaveLength(4);
			expect(
				broadcasts.map((event) => (event as { current: { revision: number } }).current.revision),
			).toEqual([1, 2, 3, 4]);
			expect(child).toEqual({
				cwd: initial.cwd,
				_defaultDeviceId: null,
				_workspaceContext: initial,
			});
			expect(terminal).toEqual({ deviceId: "local", cwd: initial.cwd });
			expect(background).toEqual({ deviceId: "local", cwd: initial.cwd, revision: 0 });
			expect(initial.revision).toBe(0);
			await expect(
				workspaceContextService.withRevision(
					id,
					initial.revision,
					undefined,
					async () => "late-old",
				),
			).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_CONFLICT" });
		} finally {
			activeNarrators.delete(id);
			eventBus.off("narrator:message_broadcast", handler);
			deviceSpy.mockRestore();
			setRemoteBackendResolver(null);
		}
	});
	test("unknown or remote devices without a default cwd never create a local hybrid context", async () => {
		setRemoteBackendResolver((deviceId) =>
			Object.assign(Object.create(localBackend), { kind: "remote", deviceId, defaultCwd: "" }),
		);
		try {
			await expect(
				workspaceContextService.switchDevice(id, "no-cwd", { origin: "http" }),
			).rejects.toThrow("default working directory");
			expect((await workspaceContextService.get(id)).revision).toBe(0);
			await db.update(narrators).set({ defaultDeviceId: "offline" }).where(eq(narrators.id, id));
			setRemoteBackendResolver(null);
			const context = await workspaceContextService.get(id);
			expect(context.deviceId).toBe("offline");
			expect(context.cwd).toBe("");
			expect(context.git).toBeUndefined();
			expect(context.capabilities).toEqual({
				switchDirectory: false,
				reason: "Remote device is unavailable; no local fallback",
			});
		} finally {
			setRemoteBackendResolver(null);
		}
	});
	test("project-filtered pagination preserves narrator ACL and gives legacy chapter authority precedence", async () => {
		const router = app(owner);
		const query = `/api/narrators?standalone=all&projectId=${projectId}&limit=10`;
		const first = await router.request(query);
		expect(first.status).toBe(200);
		expect((await first.json()).items.map((item: { id: string }) => item.id)).toContain(id);
		const otherProject = generateId();
		const chapterId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: otherProject,
			name: "legacy project",
			gitPath: join(root, "other"),
			ownerUserId: owner,
			createdAt: now,
			updatedAt: now,
		});
		try {
			await db.insert(chapters).values({
				id: chapterId,
				projectId: otherProject,
				title: "legacy chapter",
				branch: "main",
				baseBranch: "main",
				worktreePath: join(root, "other"),
				createdAt: now,
				updatedAt: now,
			});
			await db.update(narrators).set({ chapterId }).where(eq(narrators.id, id));
			const original = await router.request(query);
			expect(original.status).toBe(200);
			expect((await original.json()).items.map((item: { id: string }) => item.id)).not.toContain(
				id,
			);
			const actual = await router.request(
				`/api/narrators?standalone=all&projectId=${otherProject}&limit=10`,
			);
			expect(actual.status).toBe(200);
			expect((await actual.json()).items.map((item: { id: string }) => item.id)).toContain(id);
			const denied = await app("unrelated-user").request(query);
			expect([403, 404]).toContain(denied.status);
		} finally {
			await db.update(narrators).set({ chapterId: null }).where(eq(narrators.id, id));
			await db.delete(chapters).where(eq(chapters.id, chapterId));
			await db.delete(projects).where(eq(projects.id, otherProject));
		}
	});
	test("the real HTTP surface enforces actor ACL, CAS, legacy PATCH and M0 refusal", async () => {
		const router = app(owner);
		const read = await router.request(`/api/narrators/${id}/workspace-context`);
		expect(read.status).toBe(200);
		expect((await read.json()).revision).toBe(0);
		const request = {
			expectedRevision: 0,
			requestId: "http",
			target: { deviceId: "local", cwd: join(root, "new") },
		};
		const body = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		};
		const denied = await app("unrelated-user").request(
			`/api/narrators/${id}/workspace-context/switch`,
			body,
		);
		expect([403, 404]).toContain(denied.status);
		expect((await workspaceContextService.get(id)).revision).toBe(0);
		const switched = await router.request(`/api/narrators/${id}/workspace-context/switch`, body);
		expect(switched.status).toBe(200);
		expect((await switched.json()).current.revision).toBe(1);
		const stale = await router.request(`/api/narrators/${id}/workspace-context/switch`, body);
		expect(stale.status).toBe(409);
		const legacy = await router.request(`/api/narrators/${id}/cwd`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: join(root, "old") }),
		});
		expect(legacy.status).toBe(200);
		expect((await legacy.json()).current.revision).toBe(2);
		const revert = await router.request(`/api/narrators/${id}/revert`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(revert.status).toBe(409);
		expect((await revert.json()).code).toBe("WORKSPACE_REVERT_UNSUPPORTED");
	});
	test("real HTTP busy/waiting records return 409 without incrementing revision", async () => {
		const router = app(owner);
		for (const status of ["working", "waiting"] as const) {
			await db.update(narrators).set({ status }).where(eq(narrators.id, id));
			const result = await router.request(`/api/narrators/${id}/workspace-context/switch`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: 0,
					requestId: status,
					target: { deviceId: "local", cwd: join(root, "new") },
				}),
			});
			expect(result.status).toBe(409);
			expect((await workspaceContextService.get(id)).revision).toBe(0);
		}
	});
	test("committed permission changes reach the actual typed narrator broadcast bridge", () => {
		const broadcasts: unknown[] = [];
		const handler = (event: Extract<NarraForkEvent, { type: "narrator:message_broadcast" }>) => {
			if (event.narratorId === id) broadcasts.push(event.message);
		};
		eventBus.on("narrator:message_broadcast", handler);
		const event = {
			type: "permission:policy_changed" as const,
			narratorId: id,
			ruleType: "directoryWhitelist" as const,
			ruleId: "rule",
			change: "created" as const,
			changedAt: new Date().toISOString(),
		};
		try {
			permissionPolicyChanges.emit(event);
			expect(broadcasts).toEqual([event]);
		} finally {
			eventBus.off("narrator:message_broadcast", handler);
		}
	});
	test("a committed non-Git context survives reread with the original project authority", async () => {
		const result = await change(join(root, "new"));
		const persisted = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
			columns: {
				cwd: true,
				workspaceRevision: true,
				workspaceContext: true,
				contextProjectId: true,
			},
		});
		expect(persisted?.cwd).toBe(result.current.cwd);
		expect(persisted?.workspaceRevision).toBe(1);
		expect(persisted?.workspaceContext).toEqual(result.current);
		expect(persisted?.contextProjectId).toBe(projectId);
		expect(await workspaceContextService.get(id)).toEqual(result.current);
	});
	test("racing revision-zero callers have one durable winner, and a stale retry stays 409", async () => {
		const outcomes = await Promise.allSettled([
			change(join(root, "new")),
			change(join(root, "other")),
		]);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
		const current = await workspaceContextService.get(id);
		expect(current.revision).toBe(1);
		await expect(change(join(root, "old"))).rejects.toMatchObject({ statusCode: 409 });
		expect((await workspaceContextService.get(id)).contextKey).toBe(current.contextKey);
	});
	test("the real directory deny policy is checked before cwd or revision can change", async () => {
		await db.insert(narratorBlacklistDirs).values({
			id: generateId(),
			narratorId: id,
			path: join(root, "new"),
			denyLevel: "denyAll",
			createdAt: new Date().toISOString(),
		});
		executionPolicyEngine.invalidate(id);
		await expect(change(join(root, "new"))).rejects.toMatchObject({ statusCode: 403 });
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
			columns: { cwd: true, workspaceRevision: true },
		});
		expect(row?.cwd).toBe(join(root, "old"));
		expect(row?.workspaceRevision).toBe(0);
	});
});
