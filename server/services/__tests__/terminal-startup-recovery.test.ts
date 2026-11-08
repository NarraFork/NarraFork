import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { narrators, narratorWorktreeResources, projects, terminals, users } from "../../db/schema";
import { logger } from "../../lib/logger";
import type { SafeSpawnResult } from "../../lib/spawn";
import * as spawnModule from "../../lib/spawn";
import { BufferManager } from "../../terminal/buffer-manager";
import { dtachService } from "../../terminal/dtach-service";
import { terminalService } from "../terminal-service";

const now = "2026-01-01T00:00:00.000Z";
const buffers = new Set<BufferManager>();
const servers: Server[] = [];
let daemons: string[] = [];
let scanResult: Partial<SafeSpawnResult> = {};
let loadFailure = false;
let attachFailure = false;
let loading = 0;
let maxLoading = 0;
let loads = 0;

const scan = spyOn(spawnModule, "safeSpawn").mockImplementation(async () => ({
	stdout: [
		"1 init /sbin/init",
		...daemons.map(
			(id, i) => `${i + 10} dtach dtach -n ${dtachService.getSocketPath(id)} -z /bin/bash -li`,
		),
	].join("\n"),
	stderr: "",
	exitCode: 0,
	...scanResult,
}));
const available = spyOn(dtachService, "isAvailable").mockResolvedValue(true);
const runtimeProbe = spyOn(dtachService, "isSocketAlive").mockResolvedValue(true);
const attach = spyOn(dtachService, "attachSession").mockImplementation(() => {
	if (attachFailure) {
		attachFailure = false;
		throw new Error("fixture PTY failure");
	}
	return {
		pid: 123,
		write() {},
		resize() {},
		close() {},
		kill() {},
		exited: new Promise<number | null>(() => {}),
	};
});
async function defaultLoad(this: BufferManager) {
	buffers.add(this);
	loads++;
	loading++;
	maxLoading = Math.max(maxLoading, loading);
	try {
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
		if (loadFailure && loads <= 4) {
			loadFailure = false;
			throw new Error("fixture buffer failure");
		}
		return true;
	} finally {
		loading--;
	}
}
const load = spyOn(BufferManager.prototype, "loadFromDisk").mockImplementation(defaultLoad);
const flush = spyOn(BufferManager.prototype, "startPeriodicFlush");
const save = spyOn(BufferManager.prototype, "saveToDisk").mockResolvedValue(0);
const deleteBuffer = spyOn(BufferManager.prototype, "deleteFromDisk");
const info = spyOn(logger, "info").mockImplementation(() => {});
const warn = spyOn(logger, "warn").mockImplementation(() => {});

beforeEach(() => {
	daemons = [];
	scanResult = {};
	loadFailure = false;
	attachFailure = false;
	loading = 0;
	maxLoading = 0;
	loads = 0;
	for (const spy of [
		scan,
		available,
		runtimeProbe,
		attach,
		load,
		flush,
		save,
		deleteBuffer,
		info,
		warn,
	])
		spy.mockClear();
	available.mockResolvedValue(true);
	load.mockImplementation(defaultLoad);
	mkdirSync(dtachService.socketsDir, { recursive: true });
});
afterEach(async () => {
	await terminalService.shutdownAll();
	for (const buffer of buffers) await buffer.dispose(true);
	buffers.clear();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	cleanDb(sqlite);
});
afterAll(() => mock.restore());

async function socket(id: string) {
	const server = createServer();
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(dtachService.getSocketPath(id), resolve);
	});
}
async function row(
	id: string,
	status: "running" | "exited" = "running",
	resource = false,
	hasDtach = true,
) {
	await db.insert(terminals).values({
		id,
		name: id,
		status,
		dtachSocket: hasDtach ? dtachService.getSocketPath(id) : null,
		worktreeResourceId: resource ? "resource" : null,
		createdAt: now,
	});
}
async function status(id: string) {
	return (await db.query.terminals.findFirst({ where: eq(terminals.id, id) }))?.status;
}
function summary() {
	return info.mock.calls.find(
		([message]) => message === "Terminal startup recovery completed",
	)?.[1];
}
async function resource() {
	await db
		.insert(users)
		.values({ id: "owner", username: "owner", passwordHash: "fixture", createdAt: now });
	await db.insert(projects).values({
		id: "project",
		name: "fixture",
		gitPath: "/fixture",
		ownerUserId: "owner",
		createdAt: now,
		updatedAt: now,
	});
	await db
		.insert(narrators)
		.values({ id: "source", ownerUserId: "owner", createdAt: now, updatedAt: now });
	await db.insert(narratorWorktreeResources).values({
		id: "resource",
		ownerNarratorId: "source",
		deviceId: "local",
		repositoryKey: "repo",
		worktreePath: "/fixture",
		state: "ready",
		createRequestId: "create",
		scopeKind: "project",
		scopeProjectId: "project",
		scopeOwnerUserId: "owner",
		ownershipRevision: 3,
	});
}

describe.skipIf(process.platform === "win32")(
	"terminal startup recovery with isolated DB and real socket files",
	() => {
		test("85 terminals share one snapshot, limit parallel loads to four, yield, and are reentrant/idempotent", async () => {
			for (let id = 0; id < 85; id++) {
				const terminalId = `batch-${id}`;
				await row(terminalId);
				await socket(terminalId);
				daemons.push(terminalId);
			}
			let attachedAtTimer = -1;
			const timer = setTimeout(() => {
				attachedAtTimer = attach.mock.calls.length;
			}, 0);
			const started = performance.now();
			const first = terminalService.recoverOnStartup();
			const second = terminalService.recoverOnStartup();
			expect(first).toBe(second);
			await Promise.all([first, second]);
			clearTimeout(timer);
			expect(terminalService.getAttachedSet().size).toBe(85);
			expect(scan).toHaveBeenCalledTimes(1);
			expect(runtimeProbe).toHaveBeenCalledTimes(0);
			expect(attach).toHaveBeenCalledTimes(85);
			expect(load).toHaveBeenCalledTimes(85);
			expect(maxLoading).toBe(4);
			expect(attachedAtTimer).toBeGreaterThanOrEqual(0);
			expect(attachedAtTimer).toBeLessThan(85);
			expect(summary()).toMatchObject({
				recovered: 85,
				marked: 0,
				unknown: 0,
				failed: 0,
				processProbes: 1,
				socketChecks: 85,
				concurrency: 4,
				snapshotComplete: true,
			});
			expect((summary() as { yieldedBatches: number }).yieldedBatches).toBeGreaterThanOrEqual(22);
			console.info(
				`terminal recovery fixture: 85 terminals, ${Math.round(performance.now() - started)}ms, scans=${scan.mock.calls.length}, peakLoads=${maxLoading}`,
			);
			await terminalService.recoverOnStartup();
			expect(scan).toHaveBeenCalledTimes(1);
			expect(attach).toHaveBeenCalledTimes(85);
		});

		for (const winner of ["startup", "on-demand"] as const) {
			test(`${winner} winning a startup/on-demand load race owns the only runtime and flush timer`, async () => {
				await row("racing");
				await socket("racing");
				daemons = ["racing"];
				function gate() {
					let resolve!: () => void;
					const promise = new Promise<void>((done) => {
						resolve = done;
					});
					return { promise, resolve };
				}
				const entered = [gate(), gate()];
				const release = [gate(), gate()];
				const contenders: BufferManager[] = [];
				load.mockImplementation(async function (this: BufferManager) {
					buffers.add(this);
					const index = contenders.push(this) - 1;
					entered[index].resolve();
					await release[index].promise;
					return true;
				});
				const recovery = terminalService.recoverOnStartup();
				await entered[0].promise;
				const demand = terminalService.ensureAttached("racing");
				await entered[1].promise;
				const winningIndex = winner === "startup" ? 0 : 1;
				const losingIndex = 1 - winningIndex;
				const losingDispose = spyOn(contenders[losingIndex], "dispose");
				try {
					release[winningIndex].resolve();
					await (winner === "startup" ? recovery : demand);
					expect(terminalService.getActiveBuffer("racing")).toBe(contenders[winningIndex]);
					release[losingIndex].resolve();
					await Promise.all([recovery, demand]);
					expect(terminalService.getActiveBuffer("racing")).toBe(contenders[winningIndex]);
					expect(attach).toHaveBeenCalledTimes(1);
					expect(flush).toHaveBeenCalledTimes(1);
					expect(losingDispose).toHaveBeenCalledTimes(1);
					expect(losingDispose.mock.calls[0]).toEqual([]);
					expect(deleteBuffer).toHaveBeenCalledTimes(0);
					expect(await status("racing")).toBe("running");
				} finally {
					for (const blocked of release) blocked.resolve();
					await Promise.allSettled([recovery, demand]);
					losingDispose.mockRestore();
				}
			});
		}

		test("alive/dead sockets and exited revival share a scan without adopting resources or unknown rows", async () => {
			await resource();
			for (const [id, state, owned] of [
				["live", "running", false],
				["dead", "running", false],
				["revive", "exited", false],
				["exited-dead", "exited", false],
				["resource-running", "running", true],
				["resource-exited", "exited", true],
			] as const) {
				await row(id, state, owned);
				await socket(id);
			}
			await row("missing");
			await row("direct", "running", false, false);
			await socket("untracked");
			daemons = ["live", "revive", "resource-running", "resource-exited", "untracked"];
			await terminalService.recoverOnStartup();
			expect(await status("live")).toBe("running");
			expect(await status("dead")).toBe("exited");
			expect(await status("missing")).toBe("exited");
			expect(await status("direct")).toBe("exited");
			expect(await status("revive")).toBe("running");
			expect(await status("exited-dead")).toBe("exited");
			expect(await status("resource-running")).toBe("running");
			expect(await status("resource-exited")).toBe("exited");
			expect(await status("untracked")).toBeUndefined();
			expect(terminalService.getAttachedSet()).toEqual(new Set(["live", "revive"]));
			expect(scan).toHaveBeenCalledTimes(1);
			expect(runtimeProbe).toHaveBeenCalledTimes(0);
			expect(summary()).toMatchObject({
				recovered: 1,
				marked: 3,
				revivedFromExited: 1,
				socketChecks: 5,
			});
		});

		for (const [name, result] of [
			["failed", { exitCode: 1 }],
			["truncated", { stdoutTruncated: true }],
			["timed out", { terminationReason: "timeout" }],
		] as const) {
			test(`${name} snapshot neither exits live terminals nor revives exited rows`, async () => {
				await row("uncertain");
				await socket("uncertain");
				await row("exited", "exited");
				await socket("exited");
				daemons = ["uncertain", "exited"];
				scanResult = result;
				await terminalService.recoverOnStartup();
				expect(await status("uncertain")).toBe("running");
				expect(await status("exited")).toBe("exited");
				expect(terminalService.getAttachedSet().size).toBe(0);
				expect(attach).toHaveBeenCalledTimes(0);
				expect(scan).toHaveBeenCalledTimes(1);
				expect(summary()).toMatchObject({
					unknown: 2,
					marked: 0,
					failed: 0,
					snapshotComplete: false,
				});
			});
		}

		for (const failure of ["load", "attach"] as const) {
			test(`an individual ${failure} failure is isolated and retriable without marking the live terminal exited`, async () => {
				for (let id = 0; id < 9; id++) {
					await row(`failure-${id}`);
					await socket(`failure-${id}`);
					daemons.push(`failure-${id}`);
				}
				loadFailure = failure === "load";
				attachFailure = failure === "attach";
				await terminalService.recoverOnStartup();
				expect(terminalService.getAttachedSet().size).toBe(8);
				expect(maxLoading).toBeLessThanOrEqual(4);
				expect(summary()).toMatchObject({ recovered: 8, failed: 1, marked: 0 });
				expect(warn).toHaveBeenCalledTimes(1);
				expect(deleteBuffer).toHaveBeenCalledTimes(0);
				for (const id of daemons) expect(await status(id)).toBe("running");
				await terminalService.recoverOnStartup();
				expect(terminalService.getAttachedSet().size).toBe(9);
				expect(scan).toHaveBeenCalledTimes(2);
			});
		}

		test("without dtach only legacy running records are marked exited, no scan or buffer load", async () => {
			await resource();
			await row("resource", "running", true);
			await row("legacy");
			available.mockResolvedValue(false);
			await terminalService.recoverOnStartup();
			expect(await status("legacy")).toBe("exited");
			expect(await status("resource")).toBe("running");
			expect(scan).toHaveBeenCalledTimes(0);
			expect(load).toHaveBeenCalledTimes(0);
		});

		test("a stale regular file does not count as a socket even with matching process args", async () => {
			await row("regular");
			writeFileSync(join(dtachService.socketsDir, "terminal-regular.sock"), "not a socket");
			daemons = ["regular"];
			await terminalService.recoverOnStartup();
			expect(await status("regular")).toBe("exited");
			expect(attach).toHaveBeenCalledTimes(0);
		});
	},
);
