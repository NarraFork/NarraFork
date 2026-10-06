import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { db as applicationDb } from "../db";
import { deviceTransferTasks } from "../db/schema";
import type { TransferProgressUpdate } from "./device-transfer-service";

export type DeviceTransferTask = typeof deviceTransferTasks.$inferSelect;
export type DeviceTransferTaskInsert = typeof deviceTransferTasks.$inferInsert;
export type DeviceTransferTaskStopIntent = "paused" | "cancelled";

/**
 * Why a transfer is paused after an unclean shutdown.
 *
 * Exported because the `background_tasks` projection shows the SAME sentence in
 * the task drawer. Two hand-written copies would eventually describe the same
 * state differently, and the drawer is the half users actually read.
 */
export const TRANSFER_RESTART_PAUSE_NOTICE =
	"NarraFork restarted while the transfer was active; resume to continue.";

type TransferTaskDb = Pick<typeof applicationDb, "insert" | "update" | "select">;

export class DeviceTransferTaskStore {
	constructor(private readonly database: TransferTaskDb) {}

	async create(values: DeviceTransferTaskInsert): Promise<DeviceTransferTask> {
		const [task] = await this.database.insert(deviceTransferTasks).values(values).returning();
		return task;
	}

	/**
	 * Look up a transfer by id alone (no device scope).
	 *
	 * For callers holding only a transfer id — the `background_tasks` projection
	 * stores `transferTaskId` and nothing about the device. Every mutating method
	 * stays device-scoped; this is read-only resolution.
	 */
	async getById(taskId: string): Promise<DeviceTransferTask | null> {
		const [task] = await this.database
			.select()
			.from(deviceTransferTasks)
			.where(eq(deviceTransferTasks.id, taskId))
			.limit(1);
		return task ?? null;
	}

	async get(deviceId: string, taskId: string): Promise<DeviceTransferTask | null> {
		const [task] = await this.database
			.select()
			.from(deviceTransferTasks)
			.where(and(eq(deviceTransferTasks.id, taskId), eq(deviceTransferTasks.deviceId, deviceId)))
			.limit(1);
		return task ?? null;
	}

	async list(deviceId: string): Promise<DeviceTransferTask[]> {
		return this.database
			.select()
			.from(deviceTransferTasks)
			.where(eq(deviceTransferTasks.deviceId, deviceId))
			.orderBy(desc(deviceTransferTasks.createdAt))
			.limit(100);
	}

	async claim(
		taskId: string,
		generation: number,
		startedAt: string,
	): Promise<DeviceTransferTask | null> {
		const [task] = await this.database
			.update(deviceTransferTasks)
			.set({ status: "running", error: null, startedAt, updatedAt: startedAt })
			.where(
				and(
					eq(deviceTransferTasks.id, taskId),
					eq(deviceTransferTasks.runGeneration, generation),
					eq(deviceTransferTasks.status, "queued"),
				),
			)
			.returning();
		return task ?? null;
	}

	async updateTotals(
		taskId: string,
		generation: number,
		totalFiles: number,
		totalBytes: number,
	): Promise<void> {
		await this.database
			.update(deviceTransferTasks)
			.set({ totalFiles, totalBytes, updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(deviceTransferTasks.id, taskId),
					eq(deviceTransferTasks.runGeneration, generation),
					eq(deviceTransferTasks.status, "running"),
				),
			);
	}

	async updateProgress(
		taskId: string,
		generation: number,
		progress: TransferProgressUpdate,
	): Promise<void> {
		await this.database
			.update(deviceTransferTasks)
			.set({
				bytesTransferred: progress.bytesTransferred,
				totalBytes: progress.totalBytes,
				filesTransferred: progress.filesDone,
				totalFiles: progress.totalFiles,
				currentFile: progress.currentFile ?? null,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(deviceTransferTasks.id, taskId),
					eq(deviceTransferTasks.runGeneration, generation),
					eq(deviceTransferTasks.status, "running"),
				),
			);
	}

	/**
	 * Mark a running generation completed, reporting whether the write actually landed.
	 *
	 * The return value matters because `status = "running"` in the WHERE clause makes
	 * this a no-op after `pause()`/`cancel()`, and both of those change the row BEFORE
	 * aborting the run. With little work left (a small file, a final chunk) the transfer
	 * resolves normally before the abort is observed, so the row is already `paused` and
	 * this UPDATE matches nothing.
	 *
	 * Callers must not treat that silence as success: reporting "completed" for a row
	 * that says `paused` leaves the drawer and the device page permanently disagreeing,
	 * and a resume then re-sends a file that already arrived. Progress writes may stay
	 * silent no-ops — progress is self-correcting — but a terminal state cannot.
	 */
	async complete(
		taskId: string,
		generation: number,
		result: { filesTransferred: number; bytesTransferred: number },
	): Promise<boolean> {
		const completedAt = new Date().toISOString();
		const rows = await this.database
			.update(deviceTransferTasks)
			.set({
				status: "completed",
				filesTransferred: result.filesTransferred,
				bytesTransferred: result.bytesTransferred,
				totalFiles: result.filesTransferred,
				totalBytes: result.bytesTransferred,
				currentFile: null,
				completedAt,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(deviceTransferTasks.id, taskId),
					eq(deviceTransferTasks.runGeneration, generation),
					eq(deviceTransferTasks.status, "running"),
				),
			)
			.returning({ id: deviceTransferTasks.id });
		return rows.length > 0;
	}

	async finishStoppedOrFailed(input: {
		taskId: string;
		generation: number;
		stopIntent?: DeviceTransferTaskStopIntent;
		error?: string;
	}): Promise<void> {
		const status = input.stopIntent ?? "failed";
		await this.database
			.update(deviceTransferTasks)
			.set({
				status,
				error: input.stopIntent ? null : (input.error ?? "transfer failed"),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(deviceTransferTasks.id, input.taskId),
					eq(deviceTransferTasks.runGeneration, input.generation),
					inArray(
						deviceTransferTasks.status,
						input.stopIntent ? ["running", input.stopIntent] : ["running"],
					),
				),
			);
	}

	async pause(deviceId: string, taskId: string): Promise<DeviceTransferTask | null> {
		const current = await this.get(deviceId, taskId);
		if (!current) return null;
		const [task] = await this.database
			.update(deviceTransferTasks)
			.set({ status: "paused", error: null, updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(deviceTransferTasks.id, taskId),
					eq(deviceTransferTasks.deviceId, deviceId),
					eq(deviceTransferTasks.runGeneration, current.runGeneration),
					inArray(deviceTransferTasks.status, ["queued", "running"]),
				),
			)
			.returning();
		return task ?? null;
	}

	async cancel(deviceId: string, taskId: string): Promise<DeviceTransferTask | null> {
		const current = await this.get(deviceId, taskId);
		if (!current) return null;
		const [task] = await this.database
			.update(deviceTransferTasks)
			.set({ status: "cancelled", error: null, updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(deviceTransferTasks.id, taskId),
					eq(deviceTransferTasks.deviceId, deviceId),
					eq(deviceTransferTasks.runGeneration, current.runGeneration),
					inArray(deviceTransferTasks.status, ["queued", "running", "paused", "failed"]),
				),
			)
			.returning();
		return task ?? null;
	}

	async resume(deviceId: string, taskId: string): Promise<DeviceTransferTask | null> {
		const current = await this.get(deviceId, taskId);
		if (!current) return null;
		const [task] = await this.database
			.update(deviceTransferTasks)
			.set({
				status: "queued",
				runGeneration: sql`${deviceTransferTasks.runGeneration} + 1`,
				error: null,
				completedAt: null,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(deviceTransferTasks.id, taskId),
					eq(deviceTransferTasks.deviceId, deviceId),
					eq(deviceTransferTasks.runGeneration, current.runGeneration),
					inArray(deviceTransferTasks.status, ["paused", "failed"]),
				),
			)
			.returning();
		return task ?? null;
	}

	async recoverInterrupted(): Promise<void> {
		const active = await this.database
			.select({ id: deviceTransferTasks.id, runGeneration: deviceTransferTasks.runGeneration })
			.from(deviceTransferTasks)
			.where(inArray(deviceTransferTasks.status, ["queued", "running"]));
		for (const task of active) {
			await this.database
				.update(deviceTransferTasks)
				.set({
					status: "paused",
					error: TRANSFER_RESTART_PAUSE_NOTICE,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(deviceTransferTasks.id, task.id),
						eq(deviceTransferTasks.runGeneration, task.runGeneration),
						inArray(deviceTransferTasks.status, ["queued", "running"]),
					),
				);
		}
	}
}
