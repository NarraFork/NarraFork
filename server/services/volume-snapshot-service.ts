import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	containerInstances,
	volumeSnapshotApplications,
	volumeSnapshots,
} from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { safeSpawn } from "../lib/spawn";

/**
 * Per-container mutex — guards snapshot create/apply/delete for the same chapter+service.
 * Lock ordering: always acquire snapshotLock BEFORE snapshotDeleteLock to avoid deadlocks.
 */
const snapshotLock = new AsyncMutex();

/**
 * Per-snapshot mutex — guards delete vs apply race on the same snapshot file.
 * Must only be acquired while already holding snapshotLock, or standalone in deleteSnapshot.
 * Never acquire snapshotLock while holding snapshotDeleteLock.
 */
const snapshotDeleteLock = new AsyncMutex();

const SNAPSHOTS_DIR = join(homedir(), ".narrafork", "snapshots");

function ensureSnapshotsDir(projectId: string): string {
	const dir = join(SNAPSHOTS_DIR, projectId);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function snapshotFilePath(projectId: string, snapshotId: string): string {
	return join(SNAPSHOTS_DIR, projectId, `${snapshotId}.tar.gz`);
}

/**
 * Find the podman container ID for a given chapter + service name.
 * Returns the container ID string or throws if not found / not running.
 */
async function resolveContainerId(chapterId: string, serviceName: string): Promise<string> {
	const instance = await db.query.containerInstances.findFirst({
		where: and(
			eq(containerInstances.chapterId, chapterId),
			and(
				eq(containerInstances.serviceName, serviceName),
				eq(containerInstances.status, "running"),
			),
		),
	});
	if (!instance?.containerId) {
		throw new ValidationError(
			`No running container found for service "${serviceName}" in this chapter`,
		);
	}
	return instance.containerId;
}

export const volumeSnapshotService = {
	/**
	 * Create a snapshot by archiving a container path.
	 */
	async createSnapshot(opts: {
		projectId: string;
		chapterId: string;
		serviceName: string;
		containerPath: string;
		name: string;
		description?: string;
		userId?: string;
	}) {
		const { projectId, chapterId, serviceName, containerPath, name, description, userId } = opts;

		// Verify chapter belongs to project
		const chapter = await db.query.chapters.findFirst({
			where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
		});
		if (!chapter) {
			throw new NotFoundError("Chapter", chapterId);
		}

		const lockKey = `${chapterId}:${serviceName}`;
		return snapshotLock.acquire(lockKey, async () => {
			logger.info(
				"Creating snapshot from a running container — data consistency is not guaranteed " +
					"if the application is actively writing to the target path",
				{ chapterId, serviceName, containerPath },
			);
			eventBus.emit({ type: "volume-snapshot:creating", projectId, chapterId });

			const containerId = await resolveContainerId(chapterId, serviceName);
			const snapshotId = generateId();
			const dir = ensureSnapshotsDir(projectId);
			const archivePath = join(dir, `${snapshotId}.tar.gz`);

			try {
				// Use `podman exec` to tar the path inside the container, then `podman cp` to extract
				// Step 1: Create tar.gz inside the container in /tmp
				const tmpArchive = `/tmp/_narrafork_snapshot_${snapshotId}.tar.gz`;
				const tarResult = await safeSpawn({
					cmd: ["podman", "exec", containerId, "tar", "czf", tmpArchive, "-C", containerPath, "."],
					timeout: 300_000, // 5 min
				});
				if (tarResult.exitCode !== 0) {
					throw new Error(`Failed to create archive in container: ${tarResult.stderr}`);
				}

				// Step 2: Copy archive from container to host
				const cpResult = await safeSpawn({
					cmd: ["podman", "cp", `${containerId}:${tmpArchive}`, archivePath],
					timeout: 300_000,
				});
				if (cpResult.exitCode !== 0) {
					throw new Error(`Failed to copy archive from container: ${cpResult.stderr}`);
				}

				// Step 3: Clean up temp file inside container
				await safeSpawn({
					cmd: ["podman", "exec", containerId, "rm", "-f", tmpArchive],
					timeout: 10_000,
				});

				// Get file size
				let sizeBytes: number | null = null;
				try {
					sizeBytes = statSync(archivePath).size;
				} catch {
					// non-critical
				}

				const now = new Date().toISOString();
				await db.insert(volumeSnapshots).values({
					id: snapshotId,
					projectId,
					name,
					description: description ?? null,
					sourceChapterId: chapterId,
					serviceName,
					containerPath,
					sizeBytes,
					createdBy: userId ?? null,
					createdAt: now,
					updatedAt: now,
				});

				eventBus.emit({ type: "volume-snapshot:created", projectId, snapshotId });
				logger.info("Volume snapshot created", { snapshotId, projectId, serviceName });

				return db.query.volumeSnapshots.findFirst({
					where: eq(volumeSnapshots.id, snapshotId),
				});
			} catch (err) {
				// Clean up partial file on failure
				try {
					if (existsSync(archivePath)) unlinkSync(archivePath);
				} catch {}
				const msg = err instanceof Error ? err.message : String(err);
				eventBus.emit({ type: "volume-snapshot:error", projectId, error: msg });
				throw err;
			}
		});
	},

	/**
	 * Apply a snapshot to a target chapter's container.
	 */
	async applySnapshot(opts: { snapshotId: string; targetChapterId: string; userId?: string }) {
		const { snapshotId, targetChapterId, userId } = opts;

		const snapshot = await db.query.volumeSnapshots.findFirst({
			where: eq(volumeSnapshots.id, snapshotId),
		});
		if (!snapshot) {
			throw new NotFoundError("VolumeSnapshot", snapshotId);
		}

		// Verify target chapter belongs to same project
		const chapter = await db.query.chapters.findFirst({
			where: and(eq(chapters.id, targetChapterId), eq(chapters.projectId, snapshot.projectId)),
		});
		if (!chapter) {
			throw new NotFoundError("Chapter", targetChapterId);
		}

		const lockKey = `${targetChapterId}:${snapshot.serviceName}`;
		return snapshotLock.acquire(lockKey, async () => {
			// Guard against concurrent deletion of this snapshot
			return snapshotDeleteLock.acquire(snapshotId, async () => {
				const archivePath = snapshotFilePath(snapshot.projectId, snapshotId);
				if (!existsSync(archivePath)) {
					throw new ValidationError("Snapshot archive file is missing");
				}

				logger.info(
					"Applying snapshot to a running container — if the application is actively " +
						"using the target path, data corruption may occur",
					{
						snapshotId,
						targetChapterId,
						serviceName: snapshot.serviceName,
						containerPath: snapshot.containerPath,
					},
				);

				eventBus.emit({
					type: "volume-snapshot:applying",
					snapshotId,
					targetChapterId,
				});

				const containerId = await resolveContainerId(targetChapterId, snapshot.serviceName);

				try {
					// Step 0: Ensure target path exists inside the container
					await safeSpawn({
						cmd: ["podman", "exec", containerId, "mkdir", "-p", snapshot.containerPath],
						timeout: 10_000,
					});

					// Step 1: Copy archive into container
					const tmpArchive = `/tmp/_narrafork_snapshot_${snapshotId}.tar.gz`;
					const cpResult = await safeSpawn({
						cmd: ["podman", "cp", archivePath, `${containerId}:${tmpArchive}`],
						timeout: 300_000,
					});
					if (cpResult.exitCode !== 0) {
						throw new Error(`Failed to copy archive to container: ${cpResult.stderr}`);
					}

					// Step 2: Extract archive into the target path
					const extractResult = await safeSpawn({
						cmd: [
							"podman",
							"exec",
							containerId,
							"tar",
							"xzf",
							tmpArchive,
							"-C",
							snapshot.containerPath,
						],
						timeout: 300_000,
					});
					if (extractResult.exitCode !== 0) {
						throw new Error(`Failed to extract archive in container: ${extractResult.stderr}`);
					}

					// Step 3: Clean up temp file
					await safeSpawn({
						cmd: ["podman", "exec", containerId, "rm", "-f", tmpArchive],
						timeout: 10_000,
					});

					// Record application
					const applicationId = generateId();
					await db.insert(volumeSnapshotApplications).values({
						id: applicationId,
						snapshotId,
						chapterId: targetChapterId,
						appliedAt: new Date().toISOString(),
						appliedBy: userId ?? null,
					});

					eventBus.emit({
						type: "volume-snapshot:applied",
						snapshotId,
						targetChapterId,
					});
					logger.info("Volume snapshot applied", {
						snapshotId,
						targetChapterId,
						serviceName: snapshot.serviceName,
					});

					return { success: true };
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					eventBus.emit({
						type: "volume-snapshot:error",
						projectId: snapshot.projectId,
						error: msg,
					});
					throw err;
				}
			});
		});
	},

	/**
	 * List snapshots for a project, optionally filtered.
	 */
	async listSnapshots(
		projectId: string,
		filters?: { serviceName?: string; containerPath?: string },
	) {
		const conditions = [eq(volumeSnapshots.projectId, projectId)];
		if (filters?.serviceName) {
			conditions.push(eq(volumeSnapshots.serviceName, filters.serviceName));
		}
		if (filters?.containerPath) {
			conditions.push(eq(volumeSnapshots.containerPath, filters.containerPath));
		}
		return db.query.volumeSnapshots.findMany({
			where: conditions.length === 1 ? conditions[0] : and(conditions[0], ...conditions.slice(1)),
			orderBy: [desc(volumeSnapshots.createdAt)],
		});
	},

	/**
	 * Get a single snapshot by ID.
	 */
	async getSnapshot(snapshotId: string) {
		const snapshot = await db.query.volumeSnapshots.findFirst({
			where: eq(volumeSnapshots.id, snapshotId),
		});
		if (!snapshot) {
			throw new NotFoundError("VolumeSnapshot", snapshotId);
		}
		return snapshot;
	},

	/**
	 * Update snapshot metadata (name / description).
	 */
	async updateSnapshot(snapshotId: string, data: { name?: string; description?: string | null }) {
		const snapshot = await db.query.volumeSnapshots.findFirst({
			where: eq(volumeSnapshots.id, snapshotId),
		});
		if (!snapshot) {
			throw new NotFoundError("VolumeSnapshot", snapshotId);
		}
		await db
			.update(volumeSnapshots)
			.set({ ...data, updatedAt: new Date().toISOString() })
			.where(eq(volumeSnapshots.id, snapshotId));
		return db.query.volumeSnapshots.findFirst({
			where: eq(volumeSnapshots.id, snapshotId),
		});
	},

	/**
	 * Delete a snapshot (DB record + archive file).
	 * Guarded by snapshotDeleteLock to prevent racing with applySnapshot.
	 */
	async deleteSnapshot(snapshotId: string) {
		const snapshot = await db.query.volumeSnapshots.findFirst({
			where: eq(volumeSnapshots.id, snapshotId),
		});
		if (!snapshot) {
			throw new NotFoundError("VolumeSnapshot", snapshotId);
		}

		await snapshotDeleteLock.acquire(snapshotId, async () => {
			// Delete archive file
			const archivePath = snapshotFilePath(snapshot.projectId, snapshotId);
			try {
				if (existsSync(archivePath)) unlinkSync(archivePath);
			} catch (err) {
				logger.warn("Failed to delete snapshot archive file", {
					snapshotId,
					path: archivePath,
					error: String(err),
				});
			}

			// Delete DB records (applications cascade)
			await db.delete(volumeSnapshots).where(eq(volumeSnapshots.id, snapshotId));
		});

		eventBus.emit({
			type: "volume-snapshot:deleted",
			projectId: snapshot.projectId,
			snapshotId,
		});
		logger.info("Volume snapshot deleted", { snapshotId });
	},

	/**
	 * Get application history for a snapshot or chapter.
	 */
	async getApplicationHistory(opts: { snapshotId?: string; chapterId?: string }) {
		if (opts.snapshotId) {
			return db.query.volumeSnapshotApplications.findMany({
				where: eq(volumeSnapshotApplications.snapshotId, opts.snapshotId),
				orderBy: [desc(volumeSnapshotApplications.appliedAt)],
			});
		}
		if (opts.chapterId) {
			return db.query.volumeSnapshotApplications.findMany({
				where: eq(volumeSnapshotApplications.chapterId, opts.chapterId),
				orderBy: [desc(volumeSnapshotApplications.appliedAt)],
			});
		}
		return [];
	},
};
