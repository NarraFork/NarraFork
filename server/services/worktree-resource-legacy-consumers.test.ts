import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import * as schema from "../db/schema";
import { closeFileWorkerDatabase, openFileWorkerDatabase } from "./__tests__/file-worker-database";
import { fixtureDatabase } from "./__tests__/worktree-resource-fixture";

let fixture: ReturnType<typeof fixtureDatabase>;
let directory: string;
let runtimeInsertCount = 0;
const database = new Proxy(
	{},
	{
		get: (_, key) => {
			const value = Reflect.get(fixture.database, key);
			if (key === "insert")
				return (...args: unknown[]) => {
					runtimeInsertCount++;
					return value.apply(fixture.database, args);
				};
			return typeof value === "function" ? value.bind(fixture.database) : value;
		},
	},
);
mock.module("../db", () => ({ db: database, activeDatabaseBackend: "sqlite" }));
const command = mock(async (_options: unknown) => ({ exitCode: 0, stdout: "", stderr: "" }));
mock.module("../lib/spawn", () => ({ safeSpawn: command }));
mock.module("../lib/agent/shell", () => ({ detectShell: () => ({ path: "/fixture/shell" }) }));
mock.module("../lib/agent/tools/terminal", () => ({ resetCursorForTerminal: () => {} }));
// Exercise the real WS dispatch and real terminal service; only process/buffer/remote
// boundaries are stubbed. HTTP narrator access uses the real fixture-backed ACL.
mock.module("../middleware/auth", () => ({
	requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("./device-connection-service", () => ({
	getConnectedDeviceHello: () => null,
	isDeviceOnline: () => false,
}));
mock.module("./device-service", () => ({
	DeviceScopeError: class extends Error {},
	deviceHasFeature: () => false,
	requireAuthorizedDeviceForProject: async () => {
		throw new Error("unexpected remote device");
	},
}));
const loadBuffer = mock(async () => true);
const readBuffer = mock(async () => "legacy-buffer-secret");
class BufferStub {
	cols = 80;
	rows = 24;
	startPeriodicFlush() {}
	loadFromDisk() {
		return loadBuffer();
	}
	getContents() {
		return readBuffer();
	}
	getState() {
		return { mouseTracking: false, cursorVisible: true };
	}
	async dispose() {}
	async deleteFromDisk() {}
}
mock.module("../terminal/buffer-manager", () => ({ BufferManager: BufferStub }));
const kill = mock(() => {});
const pty = mock((_options: unknown) => ({
	pid: undefined,
	kill,
	close: () => {},
	write: () => {},
	resize: () => {},
	exited: new Promise<number>(() => {}),
}));
mock.module("../terminal/runtime-bun", () => ({ spawnBunTerminal: pty }));
mock.module("../terminal/runtime-pty", () => ({ spawnPortablePty: pty }));
mock.module("../terminal/runtime-remote", () => ({
	REMOTE_PTY_READY_FEATURE: "pty",
	spawnRemotePty: pty,
}));
const restore = mock(async () => {});
const dtach = {
	isAvailable: mock(async () => false),
	isSocketAlive: mock(async () => false),
	killSession: mock(async () => {}),
	attachSession: pty,
	createSession: restore,
	getSocketPath: (id: string) => `/fixture/${id}.sock`,
	socketsDir: "/nonexistent-fixture-sockets",
};
mock.module("../terminal/dtach-service", () => ({
	dtachService: dtach,
	findProcessesByArg: mock(async () => []),
	getDescendantPids: mock(async () => []),
	ProcessSnapshot: class {},
}));
const { terminalService } = await import("./terminal-service");
const { handleTerminalWS } = await import("../websocket/terminal-ws");
const { terminalRoutes } = await import("../routes/terminals");
const { AppError } = await import("../lib/errors");
const { createTerminalSchema } = await import("../lib/validators/terminals");
const { terminalWsMessageSchema } = await import("../lib/validators/websocket");
const { terminalViewService } = await import("./terminal-view-service");
const now = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
	const memory = fixtureDatabase();
	const sqlite = openFileWorkerDatabase(memory.sqlite);
	memory.sqlite.close(true);
	fixture = { sqlite, database: drizzle({ client: sqlite, schema }) };
	directory = mkdtempSync(join(tmpdir(), "resource-consumer-fixture-"));
	fixture.database
		.insert(schema.users)
		.values({ id: "owner", username: "owner", passwordHash: "fixture", createdAt: now })
		.run();
	fixture.database
		.insert(schema.projects)
		.values({
			id: "project",
			name: "fixture",
			gitPath: directory,
			ownerUserId: "owner",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	fixture.database
		.insert(schema.narrators)
		.values({ id: "source", ownerUserId: "owner", cwd: directory, createdAt: now, updatedAt: now })
		.run();
	fixture.database
		.insert(schema.narratorWorktreeResources)
		.values({
			id: "resource",
			ownerNarratorId: "source",
			deviceId: "local",
			repositoryKey: "repo",
			worktreePath: directory,
			state: "ready",
			createRequestId: "create",
			scopeKind: "project",
			scopeProjectId: "project",
			scopeOwnerUserId: "owner",
			ownershipRevision: 3,
		})
		.run();
	runtimeInsertCount = 0;
	command.mockClear();
	loadBuffer.mockClear();
	readBuffer.mockClear();
	pty.mockClear();
	restore.mockClear();
	kill.mockClear();
	dtach.isAvailable.mockClear();
	dtach.isSocketAlive.mockClear();
	dtach.killSession.mockClear();
});
afterEach(async () => {
	if (fixture) await closeFileWorkerDatabase(fixture.sqlite);
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function resourceTerminal() {
	fixture.database
		.insert(schema.terminals)
		.values({
			id: "rt",
			worktreeResourceId: "resource",
			name: "rt",
			status: "running",
			dtachSocket: "/fixture/rt.sock",
			createdAt: now,
		})
		.run();
}

describe("legacy compatibility routes resource rows away from runtime", () => {
	test("resource terminal rejects before PTY/dtach/filesystem actions", async () => {
		resourceTerminal();
		await expect(terminalService.create({ worktreeResourceId: "resource" })).rejects.toThrow(
			"WORKTREE_RESOURCE_RUNTIME_DISABLED",
		);
		await expect(terminalService.kill("rt")).rejects.toThrow("WORKTREE_RESOURCE_RUNTIME_DISABLED");
		await expect(terminalService.reattach("rt")).rejects.toThrow(
			"WORKTREE_RESOURCE_RUNTIME_DISABLED",
		);
		await expect(terminalService.reattachOrphan("rt")).rejects.toThrow(
			"WORKTREE_RESOURCE_RUNTIME_DISABLED",
		);
		await expect(terminalService.killOrphanSocket("rt")).rejects.toThrow(
			"WORKTREE_RESOURCE_RUNTIME_DISABLED",
		);
		expect(pty).toHaveBeenCalledTimes(0);
		expect(dtach.killSession).toHaveBeenCalledTimes(0);
		expect(restore).toHaveBeenCalledTimes(0);
		expect(command).toHaveBeenCalledTimes(0);
	});
	test("resource scrollback cannot read or send a same-ID leftover legacy buffer", async () => {
		resourceTerminal();
		let sent = 0;
		await expect(
			terminalService
				.ensureAttached("rt")
				.then(() => terminalService.getScrollback("rt"))
				.then((scrollback) => {
					if (scrollback) sent++;
				}),
		).rejects.toThrow("WORKTREE_RESOURCE_RUNTIME_DISABLED");
		expect(loadBuffer).toHaveBeenCalledTimes(0);
		expect(readBuffer).toHaveBeenCalledTimes(0);
		expect(sent).toBe(0);
	});
	test("legacy detached terminal still loads and returns its normal scrollback", async () => {
		fixture.database
			.insert(schema.terminals)
			.values({
				id: "legacy-buffer",
				name: "legacy",
				status: "exited",
				createdAt: now,
			})
			.run();
		expect(await terminalService.getScrollback("legacy-buffer")).toEqual({
			data: "legacy-buffer-secret",
			cols: 80,
			rows: 24,
		});
		expect(loadBuffer).toHaveBeenCalledTimes(1);
		expect(readBuffer).toHaveBeenCalledTimes(1);
	});
	test("tracked resource IDs in orphan socket files are never inspected or revived", async () => {
		resourceTerminal();
		writeFileSync(join(directory, "terminal-rt.sock"), "fixture-not-a-real-socket");
		dtach.socketsDir = directory;
		dtach.isAvailable.mockImplementation(async () => true);
		dtach.isSocketAlive.mockImplementation(async () => true);
		try {
			expect(await terminalService.listOrphanSockets()).toEqual([]);
			await terminalService.recoverOnStartup();
			await expect(terminalService.getShellPid("rt")).rejects.toThrow(
				"WORKTREE_RESOURCE_RUNTIME_DISABLED",
			);
			expect(dtach.isSocketAlive).toHaveBeenCalledTimes(0);
			expect(pty).toHaveBeenCalledTimes(0);
			expect(restore).toHaveBeenCalledTimes(0);
		} finally {
			dtach.isAvailable.mockImplementation(async () => false);
			dtach.isSocketAlive.mockImplementation(async () => false);
			dtach.socketsDir = "/nonexistent-fixture-sockets";
		}
	});
	test("legacy narrator terminal and global standalone creation keep old runtime commands (stubs only)", async () => {
		const legacy = await terminalService.create({ narratorId: "source", name: "legacy" });
		expect(legacy.narratorId).toBe("source");
		expect(legacy.worktreeResourceId).toBeNull();
		expect(pty).toHaveBeenCalledTimes(1);
		expect(pty.mock.calls[0]?.[0]).toMatchObject({ cmd: ["/fixture/shell", "-l"], cwd: directory });
		await terminalService.kill(legacy.id);
		const standalone = await terminalService.create({ name: "standalone" });
		expect(standalone.narratorId).toBeNull();
		await terminalService.kill(standalone.id);
	});
	test("legacy cleanup and startup refresh do not select or mutate resource terminal rows", async () => {
		resourceTerminal();
		fixture.database
			.insert(schema.terminals)
			.values({ id: "lt", narratorId: "source", name: "lt", status: "exited", createdAt: now })
			.run();
		await terminalService.cleanupForNarrator("source");
		await terminalService.recoverOnStartup();
		expect(fixture.sqlite.query("SELECT id,status FROM terminals").all()).toEqual([
			{ id: "rt", status: "running" },
		]);
		expect(pty).toHaveBeenCalledTimes(0);
		expect(dtach.killSession).toHaveBeenCalledTimes(0);
	});
	test("terminal layout selectors cannot silently fall through from resource to legacy", async () => {
		const legacy = await terminalViewService.upsert("owner", {
			narratorId: "source",
			layout: "quad",
		});
		expect(legacy?.narratorId).toBe("source");
		await expect(
			terminalViewService.get("owner", { narratorId: "source", worktreeResourceId: "resource" } as {
				narratorId: string;
			}),
		).rejects.toThrow("OWNER_SELECTOR_MIXED");
		await expect(
			terminalViewService.upsert("owner", { worktreeResourceId: "resource", layout: "single" } as {
				layout: string;
			}),
		).rejects.toThrow("WORKTREE_RESOURCE_RUNTIME_DISABLED");
	});
});

function terminalHttpApp(userId = "owner") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: 9999999999 });
		await next();
	});
	app.onError(
		(error) =>
			new Response(JSON.stringify({ message: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
				headers: { "Content-Type": "application/json" },
			}),
	);
	app.route("/terminals", terminalRoutes);
	return app;
}
/** A terminal socket of the fixtures' narrator owner: creating on a narrator needs write access. */
function fixtureWs() {
	const messages: Array<{ type: string; terminal?: { id: string } }> = [];
	const ws = {
		data: {
			subscribedTerminals: new Set<string>(),
			lastPongAt: 0,
			userId: "owner",
			userRole: "user",
		},
		send: (payload: string) => messages.push(JSON.parse(payload)),
	} as unknown as Parameters<typeof handleTerminalWS.message>[0];
	return { ws, messages };
}
const rejectedTerminalInputs = [
	{ worktreeResourceId: "resource" },
	{ worktreeResourceId: "resource", narratorId: "source" },
	{ worktreeResourceId: null },
	{ worktreeResourceId: "" },
	{ worktreeResourceId: 7 },
	{ worktreeResourceId: { id: "resource" } },
	{ worktreeResourceId: null, narratorId: "source" },
	{ narratorId: "" },
];
describe("HTTP/WS DTO to real terminal service fail closed before all runtime effects", () => {
	for (const [index, payload] of rejectedTerminalInputs.entries()) {
		test(`HTTP rejects selector ${index} without PTY, insert or attach`, async () => {
			const response = await terminalHttpApp().request("/terminals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(response.status).toBe(400);
			expect(pty).toHaveBeenCalledTimes(0);
			expect(dtach.isAvailable).toHaveBeenCalledTimes(0);
			expect(restore).toHaveBeenCalledTimes(0);
			expect(terminalService.getAttachedSet().size).toBe(0);
			expect(runtimeInsertCount).toBe(0);
			expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
		});
		test(`WS rejects selector ${index} with error and without PTY, insert or subscription`, async () => {
			const { ws, messages } = fixtureWs();
			await handleTerminalWS.message(ws, { type: "create", requestId: "request", ...payload });
			expect(messages).toHaveLength(1);
			expect(messages[0]?.type).toBe("error");
			expect(ws.data.subscribedTerminals.size).toBe(0);
			expect(pty).toHaveBeenCalledTimes(0);
			expect(dtach.isAvailable).toHaveBeenCalledTimes(0);
			expect(restore).toHaveBeenCalledTimes(0);
			expect(terminalService.getAttachedSet().size).toBe(0);
			expect(runtimeInsertCount).toBe(0);
			expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
		});
	}
	test("explicit undefined selector is rejected before either DTO strips it", async () => {
		const payload = { worktreeResourceId: undefined, narratorId: "source" };
		expect(createTerminalSchema.safeParse(payload).success).toBe(false);
		expect(
			terminalWsMessageSchema.safeParse({ type: "create", requestId: "request", ...payload })
				.success,
		).toBe(false);
		const { ws, messages } = fixtureWs();
		await handleTerminalWS.message(ws, { type: "create", requestId: "request", ...payload });
		expect(messages[0]?.type).toBe("error");
		expect(pty).toHaveBeenCalledTimes(0);
		expect(runtimeInsertCount).toBe(0);
		expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
	});
	for (const [name, payload] of [
		["standalone", { name: "standalone", clientCompatibilityField: true }],
		["narrator", { narratorId: "source" }],
		["no-cwd narrator", { narratorId: "source" }],
	] as const) {
		test(`HTTP retains legacy ${name}, with one PTY and no role/ACL mutation`, async () => {
			if (name === "no-cwd narrator")
				fixture.sqlite.exec("UPDATE narrators SET cwd=NULL WHERE id='source'");
			const before = fixture.sqlite
				.query("SELECT owner_user_id,visibility,write_audience FROM narrators WHERE id='source'")
				.get();
			const response = await terminalHttpApp().request("/terminals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(response.status).toBe(201);
			const terminal = (await response.json()) as { id: string; worktreeResourceId: null };
			expect(terminal.worktreeResourceId).toBeNull();
			expect(pty).toHaveBeenCalledTimes(1);
			expect(runtimeInsertCount).toBe(1);
			expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toHaveLength(1);
			expect(
				fixture.sqlite
					.query("SELECT owner_user_id,visibility,write_audience FROM narrators WHERE id='source'")
					.get(),
			).toEqual(before);
			await terminalService.kill(terminal.id);
		});
		test(`WS retains legacy ${name}, with one PTY and subscription`, async () => {
			if (name === "no-cwd narrator")
				fixture.sqlite.exec("UPDATE narrators SET cwd=NULL WHERE id='source'");
			const { ws, messages } = fixtureWs();
			await handleTerminalWS.message(ws, { type: "create", requestId: "request", ...payload });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(messages[0]?.type).toBe("created");
			const id = messages[0]?.terminal?.id;
			expect(id).toBeDefined();
			expect(pty).toHaveBeenCalledTimes(1);
			expect(ws.data.subscribedTerminals.size).toBe(1);
			expect(runtimeInsertCount).toBe(1);
			expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toHaveLength(1);
			if (id) await terminalService.kill(id);
		});
	}
	test("HTTP narrator shell still requires write ACL; non-owner cannot spawn", async () => {
		const response = await terminalHttpApp("not-owner").request("/terminals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ narratorId: "source" }),
		});
		expect(response.status).toBe(404);
		expect(pty).toHaveBeenCalledTimes(0);
		expect(runtimeInsertCount).toBe(0);
		expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
	});
});
