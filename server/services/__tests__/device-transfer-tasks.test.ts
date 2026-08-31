import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema";
import { createDeviceTransferTaskManager } from "../device-transfer-service";
import { DeviceTransferTaskStore } from "../device-transfer-task-store";

const sqlite = new Database(":memory:");
sqlite.run("PRAGMA foreign_keys = ON");
sqlite.run("CREATE TABLE remote_devices (id TEXT PRIMARY KEY NOT NULL)");
sqlite.run(`
	CREATE TABLE device_transfer_tasks (
		id TEXT PRIMARY KEY NOT NULL,
		device_id TEXT NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
		direction TEXT NOT NULL,
		remote_path TEXT NOT NULL,
		local_path TEXT NOT NULL,
		recursive INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'queued',
		run_generation INTEGER NOT NULL DEFAULT 0,
		files_transferred INTEGER NOT NULL DEFAULT 0,
		bytes_transferred INTEGER NOT NULL DEFAULT 0,
		total_files INTEGER,
		total_bytes INTEGER,
		current_file TEXT,
		error TEXT,
		created_by TEXT,
		parent_narrator_id TEXT,
		tool_use_id TEXT,
		alias TEXT,
		created_at TEXT NOT NULL,
		started_at TEXT,
		updated_at TEXT NOT NULL,
		completed_at TEXT
	)
`);
const db = drizzle(sqlite, { schema });
const store = new DeviceTransferTaskStore(db);
const fileRoot = mkdtempSync(join(tmpdir(), "narrafork-transfer-task-test-"));

const deviceId = "task-test-device";
const otherDeviceId = "other-task-test-device";
sqlite.run("INSERT INTO remote_devices (id) VALUES (?), (?)", [deviceId, otherDeviceId]);
type TransferTaskInsert = typeof schema.deviceTransferTasks.$inferInsert;

function taskValues(
	id: string,
	status: NonNullable<TransferTaskInsert["status"]>,
): TransferTaskInsert {
	const now = new Date().toISOString();
	return {
		id,
		deviceId,
		direction: "download" as const,
		remotePath: `/remote/${id}`,
		localPath: `/local/${id}`,
		status,
		createdAt: now,
		updatedAt: now,
	};
}

afterAll(() => {
	sqlite.close();
	rmSync(fileRoot, { recursive: true, force: true });
});

describe("persistent device transfer tasks", () => {
	test("recovers interrupted work as paused without changing terminal states", async () => {
		await db
			.insert(schema.deviceTransferTasks)
			.values([
				taskValues("queued-task", "queued"),
				taskValues("running-task", "running"),
				taskValues("completed-task", "completed"),
			]);

		await store.recoverInterrupted();

		expect((await store.get(deviceId, "queued-task"))?.status).toBe("paused");
		expect((await store.get(deviceId, "running-task"))?.status).toBe("paused");
		expect((await store.get(deviceId, "completed-task"))?.status).toBe("completed");
	});

	test("persists pause and cancel transitions while rejecting terminal-state rewrites", async () => {
		await db
			.insert(schema.deviceTransferTasks)
			.values([
				taskValues("control-task", "queued"),
				taskValues("terminal-control-task", "completed"),
			]);
		expect((await store.pause(deviceId, "control-task"))?.status).toBe("paused");
		expect((await store.cancel(deviceId, "control-task"))?.status).toBe("cancelled");
		expect(await store.pause(deviceId, "terminal-control-task")).toBeNull();
		expect(await store.cancel(deviceId, "terminal-control-task")).toBeNull();

		const [stored] = await db
			.select()
			.from(schema.deviceTransferTasks)
			.where(eq(schema.deviceTransferTasks.id, "control-task"));
		expect(stored.status).toBe("cancelled");
	});

	test("scopes task mutations to the parent device", async () => {
		await db.insert(schema.deviceTransferTasks).values(taskValues("scoped-task", "queued"));

		expect(await store.pause(otherDeviceId, "scoped-task")).toBeNull();
		expect((await store.get(deviceId, "scoped-task"))?.status).toBe("queued");
	});

	test("waits for a paused generation to stop before starting its resumed generation", async () => {
		const localPath = join(fileRoot, "generation-source.txt");
		await Bun.write(localPath, "safe generation handoff");
		let starts = 0;
		let running = 0;
		let maxRunning = 0;
		const manager = createDeviceTransferTaskManager(store, {
			statRemote: async () => ({
				exists: false,
				isDirectory: false,
				size: 0,
				mtimeMs: 0,
			}),
			downloadFile: async () => ({ transferId: "unused-download", bytes: 0 }),
			uploadFile: async ({ signal }) => {
				starts++;
				running++;
				maxRunning = Math.max(maxRunning, running);
				try {
					if (starts === 1) {
						await new Promise<void>((_resolve, reject) => {
							const abort = () => reject(new Error("paused"));
							if (signal?.aborted) abort();
							else signal?.addEventListener("abort", abort, { once: true });
						});
					} else {
						await Bun.sleep(5);
					}
					return { transferId: `generation-${starts}`, bytes: 23 };
				} finally {
					running--;
				}
			},
			downloadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
			uploadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
			statLocal: stat,
		});
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/generation-source.txt",
			localPath,
		});

		await waitFor(() => starts === 1);
		expect((await manager.pause(deviceId, task.id))?.status).toBe("paused");
		const resumed = await manager.resume(deviceId, task.id);
		expect(resumed?.runGeneration).toBe(1);
		await waitFor(async () => (await manager.get(deviceId, task.id))?.status === "completed");

		const stored = await manager.get(deviceId, task.id);
		expect(stored?.runGeneration).toBe(1);
		expect(stored?.status).toBe("completed");
		expect(starts).toBe(2);
		expect(maxRunning).toBe(1);
	});
});

/**
 * The `background_tasks` projection contract.
 *
 * These assert the hooks the runner calls, not the task service itself: the
 * projection is what makes a transfer visible to Await and the task drawer, and
 * every failure mode here is silent (a card that never appears, one stuck at
 * "paused" forever, or a card in a drawer nobody asked for).
 */
describe("narrator-facing projection hooks", () => {
	interface ProjectionCall {
		kind: "claimed" | "paused" | "finished" | "progress";
		payload: unknown;
	}

	/**
	 * A manager whose transfer either succeeds, blocks until aborted, or — with
	 * `beforeUploadReturns` — runs an arbitrary step and THEN succeeds.
	 *
	 * That last hook exists to reproduce the pause/complete race, which
	 * `blockUntilAborted` cannot: it models a transfer whose remaining work finished
	 * before the abort was observed, so the run resolves normally against a row that
	 * has already left `running`.
	 */
	function makeManager(
		opts: { blockUntilAborted?: boolean; beforeUploadReturns?: () => Promise<void> } = {},
	) {
		const calls: ProjectionCall[] = [];
		const manager = createDeviceTransferTaskManager(store, {
			statRemote: async () => ({ exists: false, isDirectory: false, size: 0, mtimeMs: 0 }),
			downloadFile: async () => ({ transferId: "unused", bytes: 0 }),
			uploadFile: async ({ signal }) => {
				if (opts.blockUntilAborted) {
					await new Promise<void>((_resolve, reject) => {
						const abort = () => reject(new Error("stopped"));
						if (signal?.aborted) abort();
						else signal?.addEventListener("abort", abort, { once: true });
					});
				}
				// Deliberately ignores `signal`: the point is a transfer that completes its
				// work despite an abort having been requested.
				if (opts.beforeUploadReturns) await opts.beforeUploadReturns();
				return { transferId: "upload-1", bytes: 11 };
			},
			downloadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
			uploadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
			statLocal: stat,
			onTransferClaimed: async (payload) => {
				calls.push({ kind: "claimed", payload });
			},
			onTransferPaused: async (transferTaskId, reason) => {
				calls.push({ kind: "paused", payload: { transferTaskId, reason } });
			},
			onTransferFinished: async (transferTaskId, outcome) => {
				calls.push({ kind: "finished", payload: { transferTaskId, outcome } });
			},
			onTransferProgress: (transferTaskId, progress) => {
				calls.push({ kind: "progress", payload: { transferTaskId, progress } });
			},
		});
		return { manager, calls };
	}

	async function sourceFile(name: string): Promise<string> {
		const path = join(fileRoot, name);
		await Bun.write(path, "projection source");
		return path;
	}

	test("projects a claimed transfer and its completion", async () => {
		const { manager, calls } = makeManager();
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/projected.txt",
			localPath: await sourceFile("projected.txt"),
			parentNarratorId: "narrator-1",
			toolUseId: "tool-use-1",
		});
		await waitFor(async () => (await manager.get(deviceId, task.id))?.status === "completed");
		await waitFor(() => calls.some((c) => c.kind === "finished"));

		const claimed = calls.find((c) => c.kind === "claimed")?.payload as {
			parentNarratorId: string;
			transferTaskId: string;
			title: string;
			toolUseId?: string;
		};
		expect(claimed.parentNarratorId).toBe("narrator-1");
		expect(claimed.transferTaskId).toBe(task.id);
		expect(claimed.toolUseId).toBe("tool-use-1");
		// A readable label: the drawer row and the Await handle both show it.
		expect(claimed.title).toContain("projected.txt");

		const finished = calls.find((c) => c.kind === "finished")?.payload as {
			outcome: { status: string; summary?: string };
		};
		expect(finished.outcome.status).toBe("completed");
		expect(finished.outcome.summary).toContain("Uploaded");
	});

	test("an admin transfer with NO narrator gets no projection at all", async () => {
		// A transfer started from the devices page belongs to no conversation. A card
		// in some narrator's drawer for work it never requested would be worse than
		// no card, so the absence is the contract — not an oversight.
		const { manager, calls } = makeManager();
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/adminless.txt",
			localPath: await sourceFile("adminless.txt"),
		});
		await waitFor(async () => (await manager.get(deviceId, task.id))?.status === "completed");
		expect(calls.filter((c) => c.kind === "claimed")).toHaveLength(0);
		expect(calls.filter((c) => c.kind === "finished")).toHaveLength(0);
	});

	test("a PAUSE projects as paused, never as finished", async () => {
		// The distinguishing signal is `stopIntent`, not the thrown error: a pause, a
		// cancel and a real failure all surface as an abort. Reporting a pause as
		// finished would tell the model a resumable transfer is over.
		const { manager, calls } = makeManager({ blockUntilAborted: true });
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/paused-projection.txt",
			localPath: await sourceFile("paused-projection.txt"),
			parentNarratorId: "narrator-2",
		});
		await waitFor(() => calls.some((c) => c.kind === "claimed"));
		await manager.pause(deviceId, task.id);
		await waitFor(() => calls.some((c) => c.kind === "paused"));

		expect(calls.filter((c) => c.kind === "finished")).toHaveLength(0);
		expect((await manager.get(deviceId, task.id))?.status).toBe("paused");
	});

	test("a CANCEL projects as cancelled rather than failed", async () => {
		const { manager, calls } = makeManager({ blockUntilAborted: true });
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/cancelled-projection.txt",
			localPath: await sourceFile("cancelled-projection.txt"),
			parentNarratorId: "narrator-3",
		});
		await waitFor(() => calls.some((c) => c.kind === "claimed"));
		await manager.cancel(deviceId, task.id);
		await waitFor(() => calls.some((c) => c.kind === "finished"));

		const finished = calls.find((c) => c.kind === "finished")?.payload as {
			outcome: { status: string };
		};
		expect(finished.outcome.status).toBe("cancelled");
		expect(calls.filter((c) => c.kind === "paused")).toHaveLength(0);
	});

	test("cancelById resolves the device from the row", async () => {
		// Narrator-side callers hold a projection row carrying only `transferTaskId`;
		// making them look the device up is how they would get it wrong.
		const { manager } = makeManager({ blockUntilAborted: true });
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/cancel-by-id.txt",
			localPath: await sourceFile("cancel-by-id.txt"),
			parentNarratorId: "narrator-4",
		});
		await waitFor(async () => (await manager.get(deviceId, task.id))?.status === "running");
		expect((await manager.cancelById(task.id))?.status).toBe("cancelled");
		expect(await manager.cancelById("no-such-transfer")).toBeNull();
	});

	test("cancelling an ALREADY-PAUSED transfer still reports the terminal state", async () => {
		// A live run reports its own ending from `execute`'s catch block. A paused
		// transfer has no run left — its runner exited when it paused — so nobody would
		// report, and the projection would sit at `paused` forever while the checkpoint
		// it offers to resume from has just been discarded.
		const { manager, calls } = makeManager({ blockUntilAborted: true });
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/cancel-after-pause.txt",
			localPath: await sourceFile("cancel-after-pause.txt"),
			parentNarratorId: "narrator-6",
		});
		await waitFor(() => calls.some((c) => c.kind === "claimed"));
		await manager.pause(deviceId, task.id);
		await waitFor(() => calls.some((c) => c.kind === "paused"));
		expect(calls.filter((c) => c.kind === "finished")).toHaveLength(0);

		expect((await manager.cancelById(task.id))?.status).toBe("cancelled");
		await waitFor(() => calls.some((c) => c.kind === "finished"));
		const finished = calls.find((c) => c.kind === "finished")?.payload as {
			outcome: { status: string };
		};
		expect(finished.outcome.status).toBe("cancelled");
	});

	test("a transfer that finishes into a PAUSED row projects paused, not completed", async () => {
		// The race: `pause()` writes the row and only then aborts the run, so a transfer
		// with little work left resolves normally against an already-`paused` row.
		// `store.complete` is scoped to `status = "running"`, so it writes nothing — and
		// reporting "completed" regardless left the drawer claiming success for a row the
		// device page still offers to resume, where resuming re-sends the finished file.
		let pauseOnce: (() => Promise<void>) | null = null;
		const { manager, calls } = makeManager({
			beforeUploadReturns: async () => {
				const fn = pauseOnce;
				pauseOnce = null;
				if (fn) await fn();
			},
		});
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/pause-wins-race.txt",
			localPath: await sourceFile("pause-wins-race.txt"),
			parentNarratorId: "narrator-race",
		});
		pauseOnce = async () => {
			await manager.pause(deviceId, task.id);
		};

		await waitFor(() => calls.some((c) => c.kind === "paused"));
		// The owner keeps the state the user asked for: a resumable checkpoint.
		expect((await manager.get(deviceId, task.id))?.status).toBe("paused");
		// And no "completed" is ever reported for it.
		expect(calls.filter((c) => c.kind === "finished")).toHaveLength(0);
	});

	test("a transfer that finishes into a CANCELLED row projects cancelled", async () => {
		// Same race, worse ending: reporting "completed" for a cancelled transfer hands the
		// model the opposite of the terminal answer it asked for.
		let cancelOnce: (() => Promise<void>) | null = null;
		const { manager, calls } = makeManager({
			beforeUploadReturns: async () => {
				const fn = cancelOnce;
				cancelOnce = null;
				if (fn) await fn();
			},
		});
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/cancel-wins-race.txt",
			localPath: await sourceFile("cancel-wins-race.txt"),
			parentNarratorId: "narrator-race-2",
		});
		cancelOnce = async () => {
			await manager.cancelById(task.id);
		};

		await waitFor(() => calls.some((c) => c.kind === "finished"));
		const finished = calls.find((c) => c.kind === "finished")?.payload as {
			outcome: { status: string };
		};
		expect(finished.outcome.status).toBe("cancelled");
		expect((await manager.get(deviceId, task.id))?.status).toBe("cancelled");
	});

	test("an admin transfer paused then cancelled reports nothing", async () => {
		// No narrator, no projection — the cancel path must not invent a report for a
		// transfer nobody is watching.
		const { manager, calls } = makeManager({ blockUntilAborted: true });
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/admin-cancel-after-pause.txt",
			localPath: await sourceFile("admin-cancel-after-pause.txt"),
		});
		await waitFor(async () => (await manager.get(deviceId, task.id))?.status === "running");
		await manager.pause(deviceId, task.id);
		await waitFor(async () => (await manager.get(deviceId, task.id))?.status === "paused");
		expect((await manager.cancelById(task.id))?.status).toBe("cancelled");
		expect(calls.filter((c) => c.kind === "finished")).toHaveLength(0);
	});

	test("the alias is minted with the row's id and stored in the same INSERT", async () => {
		// The alias registry is keyed by the row id, which only exists inside `start`.
		// Writing it later would race the runner, which is scheduled immediately and
		// reads the row back to build its projection — so the handle has to be in the
		// original INSERT for the claim hook to carry it.
		const { manager, calls } = makeManager();
		const seen: string[] = [];
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/aliased.txt",
			localPath: await sourceFile("aliased.txt"),
			parentNarratorId: "narrator-7",
			registerAlias: (transferTaskId) => {
				seen.push(transferTaskId);
				return "upload-aliased-txt";
			},
		});
		// Called with the id the row was actually written under.
		expect(seen).toEqual([task.id]);
		expect((await manager.get(deviceId, task.id))?.alias).toBe("upload-aliased-txt");

		await waitFor(() => calls.some((c) => c.kind === "claimed"));
		const claimed = calls.find((c) => c.kind === "claimed")?.payload as { alias?: string };
		expect(claimed.alias).toBe("upload-aliased-txt");
	});

	test("a projection failure never fails the transfer", async () => {
		// The projection is a convenience view; the transfer is the work. A broken
		// drawer update must not turn a completed transfer into a failed one.
		const manager = createDeviceTransferTaskManager(store, {
			statRemote: async () => ({ exists: false, isDirectory: false, size: 0, mtimeMs: 0 }),
			downloadFile: async () => ({ transferId: "unused", bytes: 0 }),
			uploadFile: async () => ({ transferId: "upload-boom", bytes: 7 }),
			downloadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
			uploadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
			statLocal: stat,
			onTransferClaimed: async () => {
				throw new Error("projection unavailable");
			},
			onTransferFinished: async () => {
				throw new Error("projection unavailable");
			},
		});
		const task = await manager.start({
			deviceId,
			direction: "upload",
			remotePath: "/remote/projection-boom.txt",
			localPath: await sourceFile("projection-boom.txt"),
			parentNarratorId: "narrator-5",
		});
		await waitFor(async () => {
			const status = (await manager.get(deviceId, task.id))?.status;
			return status === "completed" || status === "failed";
		});
		expect((await manager.get(deviceId, task.id))?.status).toBe("completed");
	});
});

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for transfer task state");
		await Bun.sleep(5);
	}
}
