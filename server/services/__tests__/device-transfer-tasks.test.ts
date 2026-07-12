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
