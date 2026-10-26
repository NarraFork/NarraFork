import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError } from "zod";
import { blockIdAt } from "../../tests/block-ids";
import {
	narratorBlacklistDirs,
	narratorMessageRefs,
	narratorMessages,
	narratorProjectLinks,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../db/schema";
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
					status:
						error instanceof AppError ? error.statusCode : error instanceof ZodError ? 400 : 500,
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
const restorers: (() => void)[] = [];
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
	for (const restore of restorers.splice(0).reverse()) restore();
	activeNarrators.delete(id);
	executionPolicyEngine.invalidate(id);
	await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
	await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id));
	await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
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
	test("project-filtered pagination preserves narrator ACL and lists every linked project", async () => {
		const router = app(owner);
		const query = `/api/narrators?standalone=all&projectId=${projectId}&limit=10`;
		const first = await router.request(query);
		expect(first.status).toBe(200);
		expect((await first.json()).items.map((item: { id: string }) => item.id)).toContain(id);
		const otherProject = generateId();
		const otherQuery = `/api/narrators?standalone=all&projectId=${otherProject}&limit=10`;
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: otherProject,
			name: "linked project",
			gitPath: join(root, "other"),
			ownerUserId: owner,
			createdAt: now,
			updatedAt: now,
		});
		try {
			const unlinked = await router.request(otherQuery);
			expect(unlinked.status).toBe(200);
			expect((await unlinked.json()).items.map((item: { id: string }) => item.id)).not.toContain(
				id,
			);
			// An additional working directory in another project only adds it to that page.
			await db.insert(narratorProjectLinks).values({
				narratorId: id,
				projectId: otherProject,
				role: "additional",
				source: "cwd",
				directory: join(root, "other"),
				updatedAt: now,
			});
			const linked = await router.request(otherQuery);
			expect(linked.status).toBe(200);
			expect((await linked.json()).items.map((item: { id: string }) => item.id)).toContain(id);
			const primary = await router.request(query);
			expect((await primary.json()).items.map((item: { id: string }) => item.id)).toContain(id);
			const denied = await app("unrelated-user").request(query);
			expect([403, 404]).toContain(denied.status);
		} finally {
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
		const versionBefore = (
			await db.query.narrators.findFirst({
				where: eq(narrators.id, id),
				columns: { messageVersion: true },
			})
		)?.messageVersion;
		const revert = await router.request(`/api/narrators/${id}/revert`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageId: "__all__", scope: "workspace" }),
		});
		// The retired immediate restore entry point refuses before any file or history IO;
		// a restore now requires a confirmed plan ID and hash from an action preview.
		expect(revert.status).toBe(409);
		expect(await revert.json()).toMatchObject({ code: "REVERT_CONFIRMATION_REQUIRED" });
		expect((await workspaceContextService.get(id)).revision).toBe(2);
		expect(
			(
				await db.query.narrators.findFirst({
					where: eq(narrators.id, id),
					columns: { messageVersion: true },
				})
			)?.messageVersion,
		).toBe(versionBefore);
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

describe("history-only HTTP actions after a workspace switch", () => {
	async function fixture() {
		const user = generateId();
		const answer = generateId();
		const later = generateId();
		const toolUseId = generateId();
		const oldFile = join(root, "old", "kept.txt");
		const newFile = join(root, "new", "kept.txt");
		await writeFile(oldFile, "old workspace bytes\n");
		await writeFile(newFile, "new workspace bytes\n");
		const rows = [
			{
				id: user,
				role: "user" as const,
				contentText: "retry this request",
				contentJson: [{ type: "text", text: "retry this request" }],
			},
			{
				id: answer,
				role: "assistant" as const,
				contentText: null,
				contentJson: [
					{ type: "text", text: "keep this text" },
					{
						type: "tool_use",
						id: toolUseId,
						name: "Write",
						input: { file_path: oldFile, content: "changed" },
					},
				],
			},
			{
				id: later,
				role: "assistant" as const,
				contentText: "later response",
				contentJson: [{ type: "text", text: "later response" }],
			},
		];
		for (const [seq, row] of rows.entries()) {
			await db
				.insert(narratorMessages)
				.values({ ...row, narratorId: id, createdAt: new Date().toISOString() });
			await db
				.insert(narratorMessageRefs)
				.values({ id: generateId(), narratorId: id, messageId: row.id, seq });
		}
		// Deliberately no journal/snapshot evidence: a file preview cannot authorize
		// restoring this tool, but history-only actions must not need that evidence.
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId: id,
			messageId: answer,
			toolUseId,
			toolName: "Write",
			inputJson: { file_path: oldFile, content: "changed" },
			status: "success",
			executionDeviceId: "local",
			executionCwd: join(root, "old"),
			resolvedFilePath: oldFile,
			createdAt: new Date().toISOString(),
		});
		await change(join(root, "new"));
		const afterSwitch = await refs();
		expect(afterSwitch.slice(0, 3)).toEqual([user, answer, later]);
		expect(afterSwitch).toHaveLength(4);
		const workspaceReminder = afterSwitch[3];
		if (!workspaceReminder) throw new Error("Missing workspace switch reminder");
		const reminder = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, workspaceReminder),
			columns: { role: true },
		});
		expect(reminder?.role).toBe("disp");
		return { user, answer, later, oldFile, newFile, workspaceReminder };
	}

	type Fixture = Awaited<ReturnType<typeof fixture>>;
	type Action = "rollback" | "message" | "block" | "batch";
	async function request(f: Fixture, action: Action, skipRevert?: boolean) {
		const base = `/api/narrators/${id}`;
		const headers = { "content-type": "application/json" };
		const opts = skipRevert === undefined ? {} : { skipRevert };
		if (action === "message")
			return {
				path: `${base}/messages/${f.answer}${skipRevert ? "?skipRevert=1" : ""}`,
				init: { method: "DELETE" },
			};
		if (action === "rollback")
			return {
				path: `${base}/blocks/rollback`,
				init: {
					method: "POST",
					headers,
					body: JSON.stringify({ blockIds: [await blockIdAt(f.user, 0)], ...opts }),
				},
			};
		const blockIds =
			action === "batch"
				? [await blockIdAt(f.answer, 1), await blockIdAt(f.later, 0)]
				: [await blockIdAt(f.answer, 1)];
		return {
			path: `${base}/blocks`,
			init: { method: "DELETE", headers, body: JSON.stringify({ blockIds, ...opts }) },
		};
	}

	async function forbidFileRollback() {
		const preview = await import("./revert-planner-local-access");
		const scoped = await import("./narrator-scoped-revert");
		const forbidden = () => {
			throw new Error("History-only operation accessed file rollback");
		};
		const spies = [
			spyOn(preview, "prepareLocalRevertAction").mockImplementation(forbidden),
			spyOn(preview, "prepareLocalRevertPlan").mockImplementation(forbidden),
			spyOn(preview, "applyLocalRevertPlan").mockImplementation(forbidden),
			spyOn(scoped, "revertNarratorScopedForMessages").mockImplementation(forbidden),
		];
		for (const spy of spies) restorers.push(() => spy.mockRestore());
		return spies;
	}

	async function refs() {
		return (
			await db.query.narratorMessageRefs.findMany({
				where: eq(narratorMessageRefs.narratorId, id),
				columns: { messageId: true, segmentCompactId: true },
				orderBy: narratorMessageRefs.seq,
			})
		)
			.filter((row) => row.segmentCompactId === null)
			.map((row) => row.messageId);
	}
	async function assertFiles(f: Fixture) {
		expect(await readFile(f.oldFile, "utf8")).toBe("old workspace bytes\n");
		expect(await readFile(f.newFile, "utf8")).toBe("new workspace bytes\n");
	}

	test.each([
		"rollback",
		"message",
		"block",
		"batch",
	] as const)("%s with skipRevert changes only history despite missing file evidence", async (action) => {
		const f = await fixture();
		const spies = await forbidFileRollback();
		const req = await request(f, action, true);
		const response = await app(owner).request(req.path, req.init);
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(200);
		expect(body.ok).toBe(true);
		if (action === "rollback" || action === "message") expect(await refs()).toEqual([f.user]);
		else {
			// Deleting selected blocks must retain the unrelated manual-switch reminder.
			expect(await refs()).toEqual(
				action === "block"
					? [f.user, f.answer, f.later, f.workspaceReminder]
					: [f.user, f.answer, f.workspaceReminder],
			);
			const remaining = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, f.answer),
				columns: { contentJson: true },
			});
			expect(remaining?.contentJson).toEqual([{ type: "text", text: "keep this text" }]);
		}
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		await assertFiles(f);
	});

	for (const skipRevert of [undefined, false]) {
		test.each([
			"rollback",
			"message",
			"block",
			"batch",
		] as const)(`%s still refuses legacy file restoration (skipRevert=${skipRevert}) before interruption`, async (action) => {
			const f = await fixture();
			const before = await refs();
			const session = await import("./narrator-session");
			const interrupt = spyOn(session, "interruptAndWaitForIdle").mockRejectedValue(
				new Error("must not interrupt"),
			);
			restorers.push(() => interrupt.mockRestore());
			const req = await request(f, action, skipRevert);
			const response = await app(owner).request(req.path, req.init);
			expect(response.status).toBe(409);
			// A file-restoring rollback needs a confirmed plan and HTTP deletions are
			// history-only, so every action is refused at that gate before any IO.
			expect((await response.json()).code).toBe("REVERT_CONFIRMATION_REQUIRED");
			expect(interrupt).not.toHaveBeenCalled();
			expect(await refs()).toEqual(before);
			await assertFiles(f);
		});
	}

	test.each([
		"rollback",
		"message",
		"block",
		"batch",
	] as const)("%s history-only still requires write access", async (action) => {
		const f = await fixture();
		const before = await refs();
		const req = await request(f, action, true);
		const response = await app("unrelated-user").request(req.path, req.init);
		expect([403, 404]).toContain(response.status);
		expect(await refs()).toEqual(before);
		await assertFiles(f);
	});

	test("history-only requests do not bypass parameter validation or exclusive history admission", async () => {
		const f = await fixture();
		const before = await refs();
		const invalid = await app(owner).request(`/api/narrators/${id}/blocks/rollback`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ blockIds: [], skipRevert: true }),
		});
		expect(invalid.status).toBe(400);
		const { reserveNarratorRevertAdmission } = await import("./narrator-session-state");
		const reservation = reserveNarratorRevertAdmission(id);
		try {
			const req = await request(f, "message", true);
			const response = await app(owner).request(req.path, req.init);
			expect(response.status).toBe(409);
			expect((await response.json()).code).toBe("NARRATOR_REVERT_IN_PROGRESS");
		} finally {
			reservation.release();
		}
		expect(await refs()).toEqual(before);
		await assertFiles(f);
	});

	test("HTTP retry reaches the model start boundary without any file rollback dependency", async () => {
		const f = await fixture();
		const { narratorService } = await import("./narrator-service");
		// Simulate a previous history-only rollback; retry must preserve its file state.
		await narratorService.deleteMessagesAfter(id, f.user, { skipRevert: true });
		const before = await refs();
		const spies = await forbidFileRollback();
		activeNarrators.set(id, {
			narratorId: id,
			conversationId: "test",
			cwd: join(root, "new"),
			model: "test:model",
			provider: "test",
			systemPrompt: null,
			events: new EventEmitter(),
			alive: true,
			locale: "en",
			abortController: new AbortController(),
			_enabledOptionalTools: new Set(),
			_disabledTools: new Set(),
			_blockedSkills: { all: false, names: new Set() },
			_substatus: new Set(),
		} as ActiveNarrator);
		const reachedStart = new Error("test reached model start");
		const start = spyOn(narratorService, "updateStatus").mockImplementation(async (_id, status) => {
			expect(status).toBe("working");
			throw reachedStart;
		});
		restorers.push(() => start.mockRestore());
		const response = await app(owner).request(`/api/narrators/${id}/retry`, { method: "POST" });
		// Stop at the real start boundary so tests cannot dispatch a provider request.
		expect(response.status).toBe(500);
		expect((await response.json()).error).toBe(reachedStart.message);
		expect(start).toHaveBeenCalledTimes(1);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(await refs()).toEqual(before);
		await assertFiles(f);
	});
});
