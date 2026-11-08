import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { Hono } from "hono";

let row: Record<string, unknown>;
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
const { localBackend, setRemoteBackendResolver } = await import("../lib/agent/execution/registry");
const { windowsPathSemantics } = await import("../lib/agent/execution/path-semantics");
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
		contextProjectId: "same-project",
		variant: "primary",
		traits: [],
		status: "idle",
		apiConversationId: "stable-cache-identity",
	};
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
		expect(row.apiConversationId).toBe("stable-cache-identity");
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
			conversationId: "stable-cache-identity",
			_persistedConversationId: "stable-cache-identity",
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
			expect(active.conversationId).toBe("stable-cache-identity");
			expect(active._persistedConversationId).toBe("stable-cache-identity");
			expect(active._resetUpstreamSessionOnNextRequest).toBeUndefined();
			expect(row.apiConversationId).toBe("stable-cache-identity");
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
	test.each([
		null,
		"",
	])("unselected legacy cwd (%s) is recovery metadata, never executable", async (cwd) => {
		row.cwd = cwd;
		const before = { ...row };
		await expect(workspaceContextService.get("narrator")).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_REQUIRED",
		});
		const metadata = await workspaceContextService.getForDirectorySwitch("narrator");
		expect(metadata.cwd).toBe("");
		expect(metadata.revision).toBe(0);
		expect(metadata.git).toBeUndefined();
		expect(metadata.capabilities.switchDirectory).toBe(true);
		expect(await workspaceContextService.getForDirectorySwitch("narrator")).toEqual(metadata);
		expect(row).toEqual(before);
		await expect(workspaceContextService.get("narrator")).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_REQUIRED",
		});

		const result = await change();
		expect(result.previous).toEqual(metadata);
		expect(result.current.contextKey).not.toBe(metadata.contextKey);
		expect(result.current.revision).toBe(1);
		expect(await workspaceContextService.get("narrator")).toEqual(result.current);
		expect(row.cwd).toBe(join(root, "new"));
		expect(row.workspaceContext).toEqual(result.current);
		expect(events).toHaveLength(1);
		expect(displayMessages).toHaveLength(1);
	});
	test.each(["PATCH", "POST"])("HTTP %s repairs an unselected legacy cwd", async (method) => {
		row.cwd = null;
		const router = app();
		const get = await router.request("/api/narrators/narrator/workspace-context");
		expect(get.status).toBe(200);
		const previous = (await get.json()) as WorkspaceContext;
		expect(previous.cwd).toBe("");
		expect(row.workspaceContext).toBeNull();
		const response = await router.request(
			`/api/narrators/narrator/${method === "PATCH" ? "cwd" : "workspace-context/switch"}`,
			{
				method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					method === "PATCH"
						? { cwd: join(root, "new") }
						: {
								expectedRevision: previous.revision,
								requestId: "recovery",
								target: { deviceId: "local", cwd: join(root, "new") },
							},
				),
			},
		);
		expect(response.status).toBe(200);
		expect((await response.json()).changed).toBe(true);
		expect(row.cwd).toBe(join(root, "new"));
		expect(row.workspaceRevision).toBe(1);
		expect(displayMessages).toHaveLength(1);
	});
	test("unselected cwd recovery keeps target validation, revision and admission guards", async () => {
		row.cwd = null;
		const before = { ...row };
		await writeFile(join(root, "file"), "not a directory");
		for (const cwd of [join(root, "missing"), join(root, "file"), "relative"])
			await expect(change(cwd)).rejects.toThrow();
		await expect(change(join(root, "new"), 1)).rejects.toMatchObject({
			code: "WORKSPACE_CONTEXT_CONFLICT",
		});
		for (const status of ["working", "waiting"]) {
			row.status = status;
			await expect(change()).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_BUSY" });
		}
		row.status = "idle";
		const reservation = reserveNarratorRevertAdmission("narrator");
		try {
			await expect(change()).rejects.toMatchObject({ statusCode: 409 });
		} finally {
			reservation.release();
		}
		policySpy.mockResolvedValue({ evaluatePath: () => ({ decision: "deny" }) } as never);
		await expect(change()).rejects.toThrow();
		expect(row).toEqual(before);
		expect(events).toEqual([]);
		expect(displayMessages).toEqual([]);
	});
	test("unselected cwd does not enable switching specialized narrators or unreachable devices", async () => {
		row.cwd = null;
		for (const variant of ["subagent:general", "knowledge"]) {
			row.variant = variant;
			expect(
				(await workspaceContextService.getForDirectorySwitch("narrator")).capabilities
					.switchDirectory,
			).toBe(false);
			await expect(change()).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		}
		row.variant = "primary";
		row.traits = ["background"];
		await expect(change()).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		row.traits = [];
		row.defaultDeviceId = "offline-remote";
		// A device that cannot be resolved is never a switch target: only the device
		// itself can validate the path, so nothing may be committed for it.
		await expect(
			workspaceContextService.switch(
				"narrator",
				{
					expectedRevision: 0,
					requestId: "offline",
					target: { deviceId: "offline-remote", cwd: "/remote" },
				},
				{ origin: "http" },
			),
		).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		expect(row.cwd).toBeNull();
		expect(row.workspaceRevision).toBe(0);
		expect(row.workspaceContext).toBeNull();
		// …but a session parked on an unreachable device can always come back to local.
		const recovered = await change();
		expect(recovered.changed).toBe(true);
		expect(recovered.current.deviceId).toBe("local");
		expect(recovered.current.cwd).toBe(join(root, "new"));
		expect(row.cwd).toBe(join(root, "new"));
		expect(row.defaultDeviceId).toBeNull();
		expect(row.workspaceDirectories).toEqual({
			local: { cwd: join(root, "new"), pathFlavor: "posix" },
		});
	});
	test("concurrent unselected cwd recovery has a single winner", async () => {
		row.cwd = null;
		await mkdir(join(root, "other"));
		const results = await Promise.allSettled([change(), change(join(root, "other"))]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(row.workspaceRevision).toBe(1);
		expect(events).toHaveLength(1);
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
	test.each([
		false,
		true,
	])("HTTP ignores an obsolete mismatched worktree key (Git target: %s)", async (gitTarget) => {
		const cwd = join(root, "new");
		if (gitTarget) {
			const process = Bun.spawn(["git", "init", "--quiet", cwd], {
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await process.exited).toBe(0);
		}
		const response = await app().request("/api/narrators/narrator/workspace-context/switch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				expectedRevision: 0,
				requestId: "obsolete-key",
				target: { deviceId: "local", cwd },
				expectedWorktreeKey: "wrong-current-worktree-key",
			}),
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.changed).toBe(true);
		expect(result.current.cwd).toBe(cwd);
		expect(result.current.revision).toBe(1);
		expect(Boolean(result.current.git)).toBe(gitTarget);
		expect(row.cwd).toBe(cwd);
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

describe("per-device workspace directories", () => {
	const remote = "remote-win";
	const remoteBackend = () =>
		Object.assign(Object.create(localBackend), {
			kind: "remote" as const,
			deviceId: remote,
			defaultCwd: "C:\\device-default",
			pathFlavor: "windows" as const,
			paths: windowsPathSemantics,
			statFile: async (path: string) => {
				const isDirectory = path === "C:\\work" || path === "C:\\other";
				return { isDirectory, isFile: !isDirectory, size: 0 };
			},
		});
	beforeEach(() => {
		setRemoteBackendResolver((deviceId) => (deviceId === remote ? remoteBackend() : null));
	});
	afterEach(() => setRemoteBackendResolver(null));

	test("a device switch uses the device's recorded directory, not its default", async () => {
		row.workspaceDirectories = { [remote]: { cwd: "C:\\work", pathFlavor: "windows" } };
		const result = await workspaceContextService.switchDevice("narrator", remote, {
			origin: "http",
		});
		expect(result.current).toMatchObject({
			deviceId: remote,
			cwd: "C:\\work",
			pathFlavor: "windows",
			capabilities: { switchDirectory: true },
		});
		expect(row.cwd).toBe("C:\\work");
		expect(row.defaultDeviceId).toBe(remote);
		// The directory the session leaves is backfilled, so the switch is reversible
		// even though this row never recorded a `local` entry.
		expect(row.workspaceDirectories).toEqual({
			local: { cwd: join(root, "old"), pathFlavor: "posix" },
			[remote]: { cwd: "C:\\work", pathFlavor: "windows" },
		});
		expect(await workspaceContextService.get("narrator")).toMatchObject({
			deviceId: remote,
			cwd: "C:\\work",
		});
	});

	test("a device with no recorded directory is refused without committing anything", async () => {
		await expect(
			workspaceContextService.switchDevice("narrator", remote, { origin: "http" }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "WORKSPACE_DIRECTORY_REQUIRED",
			details: { deviceId: remote },
		});
		expect(row.workspaceRevision).toBe(0);
		expect(row.defaultDeviceId).toBeNull();
		expect(row.cwd).toBe(join(root, "old"));
		expect(events).toEqual([]);
	});

	test("switching a directory inside one device records it and keeps the other devices", async () => {
		row.workspaceDirectories = {
			local: { cwd: join(root, "old"), pathFlavor: "posix" },
			[remote]: { cwd: "C:\\work", pathFlavor: "windows" },
		};
		const first = await workspaceContextService.switch(
			"narrator",
			{ expectedRevision: 0, requestId: "one", target: { deviceId: remote, cwd: "C:\\work" } },
			{ origin: "http" },
		);
		expect(first.current).toMatchObject({ deviceId: remote, cwd: "C:\\work" });
		expect(row.defaultDeviceId).toBe(remote);
		const moved = await workspaceContextService.switch(
			"narrator",
			{ expectedRevision: 1, requestId: "two", target: { deviceId: remote, cwd: "C:\\other" } },
			{ origin: "http" },
		);
		expect(moved.current.cwd).toBe("C:\\other");
		expect(row.cwd).toBe("C:\\other");
		expect(row.workspaceDirectories).toEqual({
			local: { cwd: join(root, "old"), pathFlavor: "posix" },
			[remote]: { cwd: "C:\\other", pathFlavor: "windows" },
		});
	});

	test("a remote Windows path is validated with Windows rules, never as a relative POSIX path", async () => {
		const relative = await workspaceContextService
			.switch(
				"narrator",
				{ expectedRevision: 0, requestId: "rel", target: { deviceId: remote, cwd: "work" } },
				{ origin: "http" },
			)
			.catch((error: unknown) => error);
		expect(relative).toMatchObject({ statusCode: 400 });
		const missing = await workspaceContextService
			.switch(
				"narrator",
				{
					expectedRevision: 0,
					requestId: "missing",
					target: { deviceId: remote, cwd: "C:\\nope" },
				},
				{ origin: "http" },
			)
			.catch((error: unknown) => error);
		expect(missing).toMatchObject({ statusCode: 400 });
		expect(row.workspaceRevision).toBe(0);
	});

	test("local and remote round trips restore each device's own directory", async () => {
		row.workspaceDirectories = {
			local: { cwd: join(root, "new"), pathFlavor: "posix" },
			[remote]: { cwd: "C:\\work", pathFlavor: "windows" },
		};
		const there = await workspaceContextService.switchDevice("narrator", remote, {
			origin: "http",
		});
		expect(there.current).toMatchObject({ deviceId: remote, cwd: "C:\\work" });
		const back = await workspaceContextService.switchDevice("narrator", null, { origin: "http" });
		expect(back.current).toMatchObject({ deviceId: "local", cwd: join(root, "new") });
		expect(row.defaultDeviceId).toBeNull();
		expect(row.workspaceDirectories).toEqual({
			local: { cwd: join(root, "new"), pathFlavor: "posix" },
			[remote]: { cwd: "C:\\work", pathFlavor: "windows" },
		});
	});

	test("an unreachable device fails closed and never falls back to the local directory", async () => {
		row.workspaceDirectories = { offline: { cwd: "C:\\work", pathFlavor: "windows" } };
		row.defaultDeviceId = "offline";
		const context = await workspaceContextService.getForDirectorySwitch("narrator");
		expect(context).toMatchObject({
			deviceId: "offline",
			cwd: "C:\\work",
			pathFlavor: "windows",
			capabilities: { switchDirectory: false },
		});
		await expect(
			workspaceContextService.switchDevice("narrator", "offline", { origin: "http" }),
		).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_UNSUPPORTED" });
		expect(row.cwd).toBe(join(root, "old"));
		expect(row.defaultDeviceId).toBe("offline");
		expect(row.workspaceRevision).toBe(0);
	});
});
