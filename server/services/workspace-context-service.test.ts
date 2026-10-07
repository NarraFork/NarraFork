import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { Hono } from "hono";

let row: Record<string, unknown>;
let chapter: { worktreePath: string; projectId: string } | undefined;
let root = "";
let events: unknown[] = [];
let failInstall = false;
const findRow = async () => row;
mock.module("@server/db", () => ({
	activeDatabaseBackend: "sqlite",
	sqlite: {},
	db: {
		$client: {},
		get: () => undefined,
		query: {
			narrators: { findFirst: findRow },
			chapters: { findFirst: async () => chapter },
			projects: { findFirst: async () => undefined },
		},
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						row = { ...row, ...values };
						return [{ id: row.id }];
					},
				}),
			}),
		}),
	},
}));
mock.module("./oauth-narrator-runtime-policy", () => ({
	resolveOAuthNarratorRuntimePolicy: async () => null,
}));
mock.module("../websocket/narrator-ws", () => ({
	broadcastToNarrator: (_id: string, event: unknown) => events.push(event),
}));
mock.module("./narrator-session", () => ({
	updateActiveNarratorCwdAndSkillContext: async (id: string, cwd: string) => {
		if (failInstall) throw new Error("installation failed");
		const active = activeNarrators.get(id);
		if (active) active.cwd = cwd;
	},
}));
const displayMessages: Array<{ narratorId: string; text: string }> = [];
mock.module("./narrator-service", () => ({
	narratorService: {
		persistDisplayMessage: async (narratorId: string, text: string) => {
			displayMessages.push({ narratorId, text });
		},
	},
}));
mock.module("../lib/i18n", () => ({
	getUserLanguage: async () => "en",
}));
const { executionPolicyEngine } = await import("./execution-policy/engine");
const { activeNarrators, pendingPermissions, reserveNarratorRevertAdmission } = await import(
	"./narrator-session-state"
);
const { AppError } = await import("../lib/errors");
const {
	workspaceContextService,
	assertWorkspaceHistoryRevertSupported,
	prepareLocalWorkspaceContext,
	withWorkspaceRepositoryLock,
} = await import("./workspace-context-service");
const { narratorWorkspaceContextRoutes } = await import("../routes/narrator-workspace-context");
let policySpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "workspace-switch-test-"));
	await mkdir(join(root, "old"));
	await mkdir(join(root, "new"));
	row = {
		id: "narrator",
		cwd: join(root, "old"),
		workspaceRevision: 0,
		workspaceContext: null,
		defaultDeviceId: null,
		chapterId: null,
		contextProjectId: "same-project",
		variant: "primary",
		traits: [],
		status: "idle",
	};
	chapter = undefined;
	events = [];
	displayMessages.length = 0;
	failInstall = false;
	policySpy = spyOn(executionPolicyEngine, "compile").mockResolvedValue({
		evaluatePath: () => ({ decision: "allow" }),
	} as never);
});
afterEach(async () => {
	policySpy.mockRestore();
	activeNarrators.delete("narrator");
	pendingPermissions.clear();
	await rm(root, { recursive: true, force: true });
});
afterAll(() => mock.restore());
async function change(cwd = join(root, "new"), revision = 0) {
	return workspaceContextService.switch(
		"narrator",
		{ expectedRevision: revision, requestId: "request", target: { deviceId: "local", cwd } },
		{ origin: "http", userId: "owner" },
	);
}
function app() {
	const router = new Hono();
	router.use("*", async (c, next) => {
		c.set("user", { sub: "owner", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	router.onError((error, c) =>
		c.json({ error: error.message }, error instanceof AppError ? (error.statusCode as 409) : 400),
	);
	router.route("/api/narrators", narratorWorkspaceContextRoutes);
	return router;
}

describe("local authoritative workspace context", () => {
	test("a held workspace revision admission rejects a new switch instead of waiting behind its mutation", async () => {
		let started!: () => void;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writer = workspaceContextService.withRevision("narrator", 0, undefined, async () => {
			started();
			await held;
		});
		await ready;
		try {
			await expect(change()).rejects.toMatchObject({
				statusCode: 409,
				code: "WORKSPACE_CONTEXT_BUSY",
			});
			expect(row.workspaceRevision).toBe(0);
		} finally {
			release();
			await writer;
		}
	});
	test("Git and worktree repository admission is one fail-fast lock with reliable release", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writer = withWorkspaceRepositoryLock("repo", async () => {
			await held;
		});
		try {
			await expect(
				withWorkspaceRepositoryLock("repo", async () => "unexpected"),
			).rejects.toMatchObject({ code: "GIT_WORKSPACE_BUSY", statusCode: 409 });
		} finally {
			release();
			await writer;
		}
		expect(await withWorkspaceRepositoryLock("repo", async () => "released")).toBe("released");
	});
	test("a non-Git directory commits revision/cwd atomically and never changes contextProjectId", async () => {
		const result = await change();
		expect(result.changed).toBe(true);
		expect(result.current.git).toBeUndefined();
		expect(row.cwd).toBe(join(root, "new"));
		expect(row.workspaceRevision).toBe(1);
		expect(row.workspaceContext).toEqual(result.current);
		expect(row.contextProjectId).toBe("same-project");
		expect(events).toHaveLength(1);
		expect(await workspaceContextService.get("narrator")).toEqual(result.current);
	});
	test("manual HTTP cwd change writes the history reminder; agent switches skip it", async () => {
		const result = await change();
		expect(result.changed).toBe(true);
		expect(displayMessages).toEqual([
			{
				narratorId: "narrator",
				text: `Working directory updated: ${join(root, "old")} → ${join(root, "new")}`,
			},
		]);
		// Unchanged switch must not spam a second card.
		displayMessages.length = 0;
		await change(join(root, "new"), 1);
		expect(displayMessages).toEqual([]);
	});
	test("real concurrent service calls at one revision have a single winner", async () => {
		await mkdir(join(root, "other"));
		const result = await Promise.allSettled([change(), change(join(root, "other"))]);
		expect(result.filter((value) => value.status === "fulfilled")).toHaveLength(1);
		expect(row.workspaceRevision).toBe(1);
		expect(events).toHaveLength(1);
	});
	test("invalid directory, ordinary file and relative path leave prior state intact", async () => {
		await writeFile(join(root, "file"), "not a directory");
		for (const cwd of [join(root, "missing"), join(root, "file"), "relative"])
			await expect(change(cwd)).rejects.toThrow();
		expect(row.cwd).toBe(join(root, "old"));
		expect(row.workspaceRevision).toBe(0);
		expect(events).toEqual([]);
	});
	test("UI working/waiting and revert reservations return 409 without mutation", async () => {
		for (const status of ["working", "waiting"]) {
			row.status = status;
			await expect(change()).rejects.toMatchObject({ statusCode: 409 });
		}
		row.status = "idle";
		const reservation = reserveNarratorRevertAdmission("narrator");
		try {
			await expect(change()).rejects.toMatchObject({ statusCode: 409 });
		} finally {
			reservation.release();
		}
		expect(row.workspaceRevision).toBe(0);
	});
	test("remote arbitrary cwd and subagent/background directory changes fail closed", async () => {
		await expect(
			workspaceContextService.switch(
				"narrator",
				{
					expectedRevision: 0,
					requestId: "remote",
					target: { deviceId: "remote", cwd: "/remote" },
				},
				{ origin: "http" },
			),
		).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		for (const variant of ["subagent:general", "knowledge"]) {
			row.variant = variant;
			await expect(change()).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		}
		row.variant = "primary";
		row.traits = ["background"];
		await expect(change()).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		expect(row.workspaceRevision).toBe(0);
	});
	test("chapter worktree cannot be crossed even for accessible non-Git paths", async () => {
		row.chapterId = "chapter";
		chapter = { worktreePath: join(root, "old"), projectId: "same-project" };
		await expect(change()).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		expect(row.workspaceRevision).toBe(0);
	});
	test("M0 refuses historical file restoration after switching, before touching either directory", async () => {
		await assertWorkspaceHistoryRevertSupported("narrator");
		await change();
		await expect(assertWorkspaceHistoryRevertSupported("narrator")).rejects.toMatchObject({
			code: "WORKSPACE_REVERT_UNSUPPORTED",
			statusCode: 409,
		});
	});
	test("agent switch commits while its own loop is running, leaving existing children bound", async () => {
		const active = {
			alive: true,
			cwd: row.cwd,
			_loopRunning: true,
			abortController: new AbortController(),
		} as unknown as import("./narrator-session-state").ActiveNarrator;
		const child = {
			alive: true,
			cwd: row.cwd,
			_loopRunning: true,
		} as unknown as import("./narrator-session-state").ActiveNarrator;
		activeNarrators.set("narrator", active);
		activeNarrators.set("child", child);
		try {
			const result = await workspaceContextService.switch(
				"narrator",
				{
					expectedRevision: 0,
					requestId: "agent",
					target: { deviceId: "local", cwd: join(root, "new") },
				},
				{ origin: "agent", active },
			);
			expect(result.changed).toBe(true);
			expect(active._loopRunning).toBe(true);
			expect(active.cwd).toBe(join(root, "new"));
			expect(child.cwd).toBe(join(root, "old"));
			expect(active._workspacePassInvalidated).toBe(true);
			// Agent origin injects the pass-continuation text instead of a display card.
			expect(displayMessages).toEqual([]);
		} finally {
			activeNarrators.delete("child");
		}
	});
	test("agent permission wait refuses the switch without waiting for its loop", async () => {
		const active = {
			alive: true,
			cwd: row.cwd,
			_loopRunning: true,
			abortController: new AbortController(),
		} as unknown as import("./narrator-session-state").ActiveNarrator;
		activeNarrators.set("narrator", active);
		pendingPermissions.set("pending", { narratorId: "narrator" } as never);
		await expect(
			workspaceContextService.switch(
				"narrator",
				{
					expectedRevision: 0,
					requestId: "agent",
					target: { deviceId: "local", cwd: join(root, "new") },
				},
				{ origin: "agent", active },
			),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(row.workspaceRevision).toBe(0);
	});
	test("missing legacy cwd can be read and recovered by an explicit valid switch", async () => {
		row.cwd = join(root, "removed");
		const current = await workspaceContextService.get("narrator");
		expect(current.cwd).toBe(join(root, "removed"));
		await change();
		expect(row.workspaceRevision).toBe(1);
	});
	test("failed live installation keeps durable target and pauses instead of restoring stale cwd", async () => {
		const active = {
			alive: true,
			cwd: row.cwd,
			_loopRunning: false,
			abortController: new AbortController(),
			_workspaceContext: undefined,
		} as unknown as import("./narrator-session-state").ActiveNarrator;
		activeNarrators.set("narrator", active);
		failInstall = true;
		await expect(change()).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_INSTALL_FAILED" });
		expect(row.cwd).toBe(join(root, "new"));
		expect(row.workspaceRevision).toBe(1);
		expect(active._workspaceInstallFailed).toBe(true);
		expect(active.abortController.signal.aborted).toBe(true);
		expect((await workspaceContextService.get("narrator")).cwd).toBe(join(root, "new"));
		expect(events).toEqual([]);
	});
	test("HTTP read, switch and legacy PATCH all use the actual service", async () => {
		const router = app();
		const get = await router.request("/api/narrators/narrator/workspace-context");
		expect(get.status).toBe(200);
		const previous = (await get.json()) as WorkspaceContext;
		const switched = await router.request("/api/narrators/narrator/workspace-context/switch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				expectedRevision: previous.revision,
				requestId: "http",
				target: { deviceId: "local", cwd: join(root, "new") },
			}),
		});
		expect(switched.status).toBe(200);
		expect((await switched.json()).current.revision).toBe(1);
		const legacy = await router.request("/api/narrators/narrator/cwd", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: join(root, "old") }),
		});
		expect(legacy.status).toBe(200);
		expect((await legacy.json()).current.revision).toBe(2);
	});
	test("Git identity probe remains bounded and ordinary non-Git contexts carry no fabricated Git key", async () => {
		const context = await prepareLocalWorkspaceContext(join(root, "new"), 3, "same-project");
		expect(context.revision).toBe(3);
		expect(context.git).toBeUndefined();
		expect(context.contextKey.length).toBe(64);
	});
});
