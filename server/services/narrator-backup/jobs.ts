import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "@server/lib/errors";
import {
	NARRATOR_BACKUP_LIMITS as LIMITS,
	type NarratorBackupArtifact,
	type NarratorBackupJob,
	type NarratorBackupPlan,
	type NarratorBackupRequest,
	type NarratorRestorePreview,
	type NarratorRestoreRequest,
	type NarratorRestoreResult,
} from "@shared/narrator-backup";
import { MAX_ARTIFACT_BYTES } from "./artifact";
import type { BackupActor } from "./contract";
import type { BackupWorkerConfig, BackupWorkerRequest, BackupWorkerResult } from "./worker";
import { startPrivateArchiveWorker } from "./worker-client";

function readUploadChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
	return new Promise((resolveChunk, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			cleanup();
			void reader.cancel().catch(() => {});
			reject(new Error("Backup upload cancelled or timed out"));
		};
		const timer = setTimeout(abort, timeoutMs);
		signal.addEventListener("abort", abort, { once: true });
		reader.read().then(
			(result) => {
				cleanup();
				resolveChunk(result);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) abort();
	});
}

interface OwnedArtifact {
	owner: string;
	path: string;
	digest?: string;
}
interface JobRecord {
	owner: string;
	view: NarratorBackupJob;
	controller: AbortController;
}
export interface BackupJobOptions {
	root: string;
	config(): Promise<BackupWorkerConfig>;
	/** Isolated fixtures may inject a worker runner. Production always uses real Worker. */
	run?: typeof executeBackupWorker;
}
export async function executeBackupWorker(
	input: Omit<BackupWorkerRequest, "cancellation" | "deadline">,
	signal: AbortSignal,
): Promise<BackupWorkerResult> {
	const deadline = Date.now() + LIMITS.jobMs;
	const worker = await startPrivateArchiveWorker("backup", signal, deadline);
	return new Promise((resolvePromise, reject) => {
		const cancellation = new SharedArrayBuffer(4);
		let settled = false;
		let terminating: ReturnType<typeof setTimeout> | undefined;
		const cancel = () => {
			Atomics.store(new Int32Array(cancellation), 0, 1);
			terminating ??= setTimeout(() => {
				void worker.terminate();
				finish(undefined, new Error("Backup cancelled"));
			}, LIMITS.childMs + 1000);
		};
		const timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
		const finish = (result?: BackupWorkerResult, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(terminating);
			signal.removeEventListener("abort", cancel);
			void worker.terminate();
			if (error) reject(error);
			else if (result) resolvePromise(result);
			else reject(new Error("Backup worker returned no result"));
		};
		signal.addEventListener("abort", cancel, { once: true });
		worker.once("message", (message: { value?: BackupWorkerResult; error?: string }) =>
			finish(
				message.value,
				message.error ? new Error("Backup validation or operation failed") : undefined,
			),
		);
		worker.once("error", () => finish(undefined, new Error("Backup worker failed")));
		worker.once("exit", () => {
			if (!settled) finish(undefined, new Error("Backup worker exited before completion"));
		});
		worker.postMessage({
			...input,
			cancellation,
			deadline,
		} satisfies BackupWorkerRequest);
		if (signal.aborted) cancel();
	});
}

/** Runtime handles remain process-local. Offline source authority comes from the
 * worker-verified persistent application key, never uploaded identity claims alone.
 */
export const BACKUP_ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60_000;
export class NarratorBackupJobs {
	private readonly activeFiles = new Set<string>();
	private readonly artifacts = new Map<string, OwnedArtifact>();
	private readonly jobs = new Map<string, JobRecord>();
	private readonly root: string;
	private readonly run: typeof executeBackupWorker;
	private operations = 0;
	private pendingJobs = 0;
	private reservedArtifacts = 0;
	private downloadStreams = 0;
	constructor(private readonly options: BackupJobOptions) {
		this.root = resolve(options.root);
		this.run = options.run ?? executeBackupWorker;
	}
	private async prepare() {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const stat = await lstat(this.root);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(await realpath(this.root)) !== this.root ||
			(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
		)
			throw new AppError("Private backup storage unavailable", 503, "BACKUP_STORAGE_UNAVAILABLE");
		let count = 0;
		let scanned = 0;
		const deadline = Date.now() + 2000;
		for await (const entry of await opendir(this.root)) {
			if (++scanned > LIMITS.artifacts * 8 || Date.now() > deadline)
				throw new AppError("Backup directory scan limit exceeded", 429, "BACKUP_LIMIT");
			const path = join(this.root, entry.name);
			const owned = [...this.artifacts.values()].some((artifact) => artifact.path === path);
			// Orphan files never regain runtime ownership. Offline signatures survive cleanup:
			// only the separately stored application key establishes uploaded source authority.
			if (
				!owned &&
				!this.activeFiles.has(path) &&
				/^[a-f0-9-]{36}\.(sqlite|staging)$/.test(entry.name)
			) {
				const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return null;
				});
				if (!before) continue;
				const retention = entry.name.endsWith(".staging")
					? LIMITS.jobMs * 2
					: BACKUP_ORPHAN_RETENTION_MS;
				if (
					before.isFile() &&
					!before.isSymbolicLink() &&
					Date.now() - before.mtimeMs > retention
				) {
					const current = await lstat(path).catch(() => null);
					if (
						current?.isFile() &&
						current.dev === before.dev &&
						current.ino === before.ino &&
						current.size === before.size &&
						current.mtimeMs === before.mtimeMs &&
						current.ctimeMs === before.ctimeMs &&
						!this.activeFiles.has(path) &&
						![...this.artifacts.values()].some((artifact) => artifact.path === path)
					) {
						await unlink(path).catch((error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						});
						continue;
					}
				}
			}
			count++;
		}
		if (count > LIMITS.artifacts * 2)
			throw new AppError("Backup file limit exceeded", 429, "BACKUP_LIMIT");
	}
	private owned(actor: BackupActor, artifactId: string): OwnedArtifact {
		const artifact = this.artifacts.get(artifactId);
		if (!artifact || artifact.owner !== actor.userId)
			throw new AppError("Backup artifact not found", 404, "BACKUP_NOT_FOUND");
		return artifact;
	}
	private async operation<T>(action: () => Promise<T>): Promise<T> {
		if (this.operations >= 4)
			throw new AppError("Backup worker queue is full", 429, "BACKUP_QUEUE_FULL");
		this.operations++;
		try {
			return await action();
		} finally {
			this.operations--;
		}
	}
	async planNarratorBackup(
		actor: BackupActor,
		request: NarratorBackupRequest,
		signal = new AbortController().signal,
	): Promise<NarratorBackupPlan> {
		return this.operation(
			async () =>
				this.run(
					{ action: "plan", actor, ...request, config: await this.options.config() },
					signal,
				) as Promise<NarratorBackupPlan>,
		);
	}
	async exportNarratorBackup(
		actor: BackupActor,
		request: NarratorBackupRequest,
	): Promise<NarratorBackupJob> {
		// Keep a bounded status history, not a lifetime quota that 32 failed/cancelled jobs
		// can exhaust forever. Never evict a live job or revoke an artifact's ownership.
		for (const [id, record] of this.jobs) {
			if (this.jobs.size + this.pendingJobs < LIMITS.jobs) break;
			if (!["queued", "running"].includes(record.view.status)) this.jobs.delete(id);
		}
		if (
			this.jobs.size + this.pendingJobs >= LIMITS.jobs ||
			this.artifacts.size + this.reservedArtifacts >= LIMITS.artifacts
		)
			throw new AppError("Backup job/artifact limit exceeded", 429, "BACKUP_LIMIT");
		this.pendingJobs++;
		this.reservedArtifacts++;
		try {
			await this.prepare();
		} catch (error) {
			this.reservedArtifacts--;
			throw error;
		} finally {
			this.pendingJobs--;
		}
		const jobId = randomUUID();
		const artifactId = randomUUID();
		const controller = new AbortController();
		const record: JobRecord = {
			owner: actor.userId,
			view: { jobId, status: "queued" },
			controller,
		};
		this.jobs.set(jobId, record);
		const target = join(this.root, `${artifactId}.sqlite`);
		const staging = join(this.root, `${artifactId}.staging`);
		this.activeFiles.add(target);
		this.activeFiles.add(staging);
		void this.operation(async () => {
			try {
				const config = await this.options.config();
				controller.signal.throwIfAborted();
				record.view.status = "running";
				const result = (await this.run(
					{
						action: "export",
						actor,
						...request,
						config,
						artifactPath: target,
						stagingPath: staging,
					},
					controller.signal,
				)) as { digest: string };
				controller.signal.throwIfAborted();
				this.artifacts.set(artifactId, {
					owner: actor.userId,
					path: target,
					digest: result.digest,
				});
				record.view = { jobId, status: "completed", artifactId };
			} catch {
				record.view = {
					jobId,
					status: controller.signal.aborted ? "cancelled" : "failed",
					error: "Backup validation or operation failed",
				};
				await unlink(target).catch(() => {});
			} finally {
				await unlink(staging).catch(() => {});
			}
		})
			.catch(() => {
				record.view = { jobId, status: "failed", error: "Backup worker queue is full" };
			})
			.finally(() => {
				this.activeFiles.delete(target);
				this.activeFiles.delete(staging);
				this.reservedArtifacts--;
			});
		return { ...record.view };
	}
	getJob(actor: BackupActor, jobId: string): NarratorBackupJob {
		const record = this.jobs.get(jobId);
		if (!record || record.owner !== actor.userId)
			throw new AppError("Backup job not found", 404, "BACKUP_NOT_FOUND");
		return { ...record.view };
	}
	cancelJob(actor: BackupActor, jobId: string): NarratorBackupJob {
		this.getJob(actor, jobId);
		const record = this.jobs.get(jobId);
		if (record && ["queued", "running"].includes(record.view.status)) record.controller.abort();
		return this.getJob(actor, jobId);
	}
	async uploadArtifact(
		actor: BackupActor,
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
	): Promise<NarratorBackupArtifact> {
		if (this.artifacts.size + this.reservedArtifacts >= LIMITS.artifacts)
			throw new AppError("Backup artifact limit exceeded", 429, "BACKUP_LIMIT");
		this.reservedArtifacts++;
		try {
			return await this.operation(async () => {
				await this.prepare();
				const artifactId = randomUUID();
				const path = join(this.root, `${artifactId}.sqlite`);
				const file = await open(
					path,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
					0o600,
				);
				this.activeFiles.add(path);
				const reader = stream.getReader();
				let size = 0;
				const deadline = Date.now() + LIMITS.jobMs;
				try {
					for (;;) {
						signal.throwIfAborted();
						if (Date.now() >= deadline) throw new Error("Backup upload timed out");
						const next = await readUploadChunk(
							reader,
							signal,
							Math.min(60_000, deadline - Date.now()),
						);
						if (next.done) break;
						size += next.value.length;
						if (size > MAX_ARTIFACT_BYTES || next.value.length > 1024 * 1024)
							throw new Error("Backup artifact byte limit exceeded");
						let offset = 0;
						while (offset < next.value.length) {
							signal.throwIfAborted();
							if (Date.now() >= deadline) throw new Error("Backup upload timed out");
							const { bytesWritten } = await file.write(
								next.value,
								offset,
								next.value.length - offset,
							);
							if (!bytesWritten) throw new Error("Backup upload write made no progress");
							offset += bytesWritten;
						}
					}
					await file.sync();
					await file.close();
					const verified = (await this.run(
						{
							action: "upload",
							config: await this.options.config(),
							actor,
							artifactId,
							artifactPath: path,
						},
						signal,
					)) as { digest: string; verifiedSameInstance: boolean };
					// Only worker-verified cryptographic provenance can regain offline authority.
					this.artifacts.set(artifactId, {
						owner: actor.userId,
						path,
						digest: verified.verifiedSameInstance ? verified.digest : undefined,
					});
					return { artifactId, verifiedSameInstance: verified.verifiedSameInstance };
				} catch (error) {
					void reader.cancel().catch(() => {});
					await unlink(path).catch(() => {});
					throw error;
				} finally {
					this.activeFiles.delete(path);
					reader.releaseLock();
					await file.close().catch(() => {});
				}
			});
		} finally {
			this.reservedArtifacts--;
		}
	}
	async previewNarratorRestore(
		actor: BackupActor,
		request: NarratorRestoreRequest,
		signal = new AbortController().signal,
	): Promise<NarratorRestorePreview> {
		const artifact = this.owned(actor, request.artifactId);
		return this.operation(
			async () =>
				this.run(
					{
						action: "preview",
						config: await this.options.config(),
						actor,
						artifactId: request.artifactId,
						mapping: request.mapping,
						artifactPath: artifact.path,
						expectedDigest: artifact.digest,
					},
					signal,
				) as Promise<NarratorRestorePreview>,
		);
	}
	async restoreNarratorState(
		actor: BackupActor,
		request: NarratorRestoreRequest,
		signal = new AbortController().signal,
	): Promise<NarratorRestoreResult> {
		const artifact = this.owned(actor, request.artifactId);
		if (!artifact.digest)
			throw new AppError(
				"Unattested artifacts support preview only",
				409,
				"BACKUP_CROSS_INSTANCE_UNSUPPORTED",
			);
		return this.operation(
			async () =>
				this.run(
					{
						action: "restore",
						config: await this.options.config(),
						actor,
						artifactId: request.artifactId,
						mapping: request.mapping,
						artifactPath: artifact.path,
						expectedDigest: artifact.digest,
					},
					signal,
				) as Promise<NarratorRestoreResult>,
		);
	}
	async download(
		actor: BackupActor,
		artifactId: string,
		signal: AbortSignal,
	): Promise<ReadableStream<Uint8Array>> {
		const artifact = this.owned(actor, artifactId);
		if (this.downloadStreams >= 4)
			throw new AppError("Backup download slots are full", 429, "BACKUP_QUEUE_FULL");
		this.downloadStreams++;
		let release: () => Promise<void> = async () => {
			this.downloadStreams--;
		};
		try {
			// Authorization of the ORIGINAL source closure is refreshed, including revocation.
			await this.operation(async () =>
				this.run(
					{
						action: "download",
						actor,
						artifactId,
						artifactPath: artifact.path,
						expectedDigest: artifact.digest,
						config: await this.options.config(),
					},
					signal,
				),
			);
			signal.throwIfAborted();
			await this.prepare();
			const file = await open(artifact.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			let closed = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abort = () => {};
			const originalRelease = release;
			let closing: Promise<void> | undefined;
			release = () => {
				if (closed) return closing ?? Promise.resolve();
				closed = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				closing = file
					.close()
					.catch(() => {})
					.then(originalRelease);
				return closing;
			};
			const metadata = await file.stat();
			if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES)
				throw new Error("Backup artifact unavailable");
			let position = 0;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					abort = () => {
						if (closed) return;
						void release();
						controller.error(new Error("Backup download cancelled or timed out"));
					};
					timer = setTimeout(abort, LIMITS.jobMs);
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				},
				async pull(controller) {
					try {
						signal.throwIfAborted();
						const chunk = Buffer.alloc(1024 * 1024);
						const { bytesRead } = await file.read(
							chunk,
							0,
							Math.min(chunk.length, metadata.size - position),
							position,
						);
						if (closed) return;
						position += bytesRead;
						if (!bytesRead) {
							await release();
							controller.close();
						} else controller.enqueue(chunk.subarray(0, bytesRead));
					} catch (error) {
						if (closed) return;
						await release();
						controller.error(error);
					}
				},
				cancel() {
					return release();
				},
			});
		} catch (error) {
			await release();
			throw error;
		}
	}
	async deleteArtifact(actor: BackupActor, artifactId: string) {
		const artifact = this.owned(actor, artifactId);
		await unlink(artifact.path);
		this.artifacts.delete(artifactId);
		for (const [id, job] of this.jobs) if (job.view.artifactId === artifactId) this.jobs.delete(id);
	}
}
