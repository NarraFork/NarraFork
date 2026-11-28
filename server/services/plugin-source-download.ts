import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
	type PluginSource,
	type ResolvedPluginRelease,
} from "@shared/plugin-source";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { WorkerCleanupError, WorkerHandle } from "../lib/worker-runtime/lifecycle";
import {
	fetchPluginSource,
	type LocalSourceDescriptor,
	PluginSourceFailure,
	type PluginSourceTransport,
	safeSourceUrl,
	sourceAbortable,
	sourceDownloadPolicy,
} from "./plugin-source-resolvers";

// Deliberately self-contained eval worker: also works in a frozen binary without
// resolving a sibling worker path. No hashing fallback is allowed on the host thread.
const HASH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { open } = require('node:fs/promises');
(async () => {
  let file;
  try {
    file = await open(workerData.path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > workerData.maxBytes) throw new Error('invalid');
    const hash = createHash('sha256');
    const buffer = new Uint8Array(65536);
    let size = 0;
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > workerData.maxBytes) throw new Error('large');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (size !== stat.size) throw new Error('changed');
    parentPort.postMessage({ sha256: hash.digest('hex'), size });
  } catch { parentPort.postMessage({ error: 'hash_failed' }); }
  finally { if (file) await file.close(); }
})();`;

export interface PluginArchiveDigest {
	sha256: string;
	size: number;
}
export interface PluginHashWorker {
	on(event: "message", listener: (value: unknown) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "exit", listener: (code: number) => void): unknown;
	terminate(): Promise<number>;
}

/** A failed cleanup still owns its pending work; the caller must retain its admission slot. */
export class PluginSourceCleanupError extends Error {
	constructor(
		cause: unknown,
		readonly settled: Promise<unknown> = Promise.resolve(),
	) {
		super("Plugin source cleanup failed", { cause });
		this.name = "PluginSourceCleanupError";
		void settled.catch(() => {});
	}
}

export async function hashPluginArchive(
	path: string,
	options: {
		signal: AbortSignal;
		timeoutMs?: number;
		closeTimeoutMs?: number;
		workerFactory?: (path: string) => PluginHashWorker;
	},
): Promise<PluginArchiveDigest> {
	options.signal.throwIfAborted();
	const began = Date.now();
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new PluginSourceFailure("apply_failed")),
		Math.max(1, Math.min(120_000, options.timeoutMs ?? 120_000)),
	);
	const signal = AbortSignal.any([options.signal, timeout.signal]);
	let handle: WorkerHandle<PluginHashWorker> | undefined;
	let digest: PluginArchiveDigest | undefined;
	let failure: unknown;
	try {
		if (options.workerFactory) {
			const worker = options.workerFactory(path);
			handle = new WorkerHandle(
				worker,
				new Promise<number>((resolve) => worker.on("exit", resolve)),
				() => worker.terminate(),
			);
		} else {
			handle = WorkerHandle.thread(HASH_WORKER, {
				eval: true,
				workerData: { path, maxBytes: PLUGIN_UPDATE_MAX_ARCHIVE_BYTES },
			});
		}
		const connected = handle.resource;
		const result = new Promise<PluginArchiveDigest>((resolve, reject) => {
			connected.on("message", (raw) => {
				const value = raw as Partial<PluginArchiveDigest> | null;
				if (
					!value ||
					typeof value.sha256 !== "string" ||
					!/^[a-f0-9]{64}$/.test(value.sha256) ||
					typeof value.size !== "number" ||
					!Number.isSafeInteger(value.size) ||
					value.size <= 0 ||
					value.size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES
				)
					reject(new PluginSourceFailure("apply_failed"));
				else resolve({ sha256: value.sha256, size: value.size });
			});
			connected.on("error", () => reject(new PluginSourceFailure("apply_failed")));
			connected.on("exit", () => reject(new PluginSourceFailure("apply_failed")));
		});
		digest = await sourceAbortable(result, signal);
	} catch (error) {
		failure = signal.aborted
			? signal.reason
			: error instanceof PluginSourceFailure
				? error
				: new PluginSourceFailure("apply_failed");
	} finally {
		clearTimeout(timer);
		try {
			if (handle) {
				const closing = new AbortController();
				const closeTimer = setTimeout(
					() => closing.abort(new Error("Plugin hash Worker exit timed out")),
					Math.max(1, Math.min(5_000, options.closeTimeoutMs ?? 5_000)),
				);
				try {
					await sourceAbortable(handle.close(), closing.signal);
				} catch (error) {
					// A cleanup failure takes priority over cancellation and over a valid digest.
					failure = new WorkerCleanupError(handle, error);
				} finally {
					clearTimeout(closeTimer);
				}
			}
		} finally {
			if (Date.now() - began >= 1_000)
				logger.debug("Plugin source hash Worker finished", { durationMs: Date.now() - began });
		}
	}
	if (failure !== undefined) throw failure;
	if (!digest) throw new PluginSourceFailure("apply_failed");
	return digest;
}

export interface DownloadedPluginArchive {
	path: string;
	cleanup(): Promise<void>;
}
export interface PluginArchiveDownloadOptions {
	signal: AbortSignal;
	transport: PluginSourceTransport;
	stagingRoot?: string;
	getBuiltin(id: string): LocalSourceDescriptor | undefined;
	onProgress?(downloadedBytes: number, totalBytes: number): void;
	/** Test injection exercises the isolated computation directly; production always uses a Worker. */
	hashArchive?: typeof hashPluginArchive;
}

export async function downloadPluginArchive(
	source: PluginSource,
	release: ResolvedPluginRelease,
	options: PluginArchiveDownloadOptions,
): Promise<DownloadedPluginArchive> {
	if (
		!Number.isSafeInteger(release.size) ||
		release.size <= 0 ||
		release.size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES ||
		!/^[a-f0-9]{64}$/.test(release.sha256)
	)
		throw new PluginSourceFailure("invalid_release");
	options.signal.throwIfAborted();
	const root = options.stagingRoot ?? getNarraforkPath("plugin-update-staging");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const staging = await mkdtemp(join(root, "download-"));
	const path = join(staging, "plugin.nfplugin");
	const cleanup = () => rm(staging, { recursive: true, force: true });
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		options.signal.throwIfAborted();
		file = await open(path, "wx", 0o600);
		const writer = file;
		let written = 0;
		const write = async (bytes: Uint8Array) => {
			if (
				written + bytes.byteLength > release.size ||
				written + bytes.byteLength > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES
			)
				throw new PluginSourceFailure("size_mismatch");
			let offset = 0;
			while (offset < bytes.byteLength) {
				options.signal.throwIfAborted();
				const result = await sourceAbortable(
					writer.write(bytes, offset, bytes.byteLength - offset, written),
					options.signal,
				);
				if (!result.bytesWritten) throw new PluginSourceFailure("apply_failed");
				offset += result.bytesWritten;
				written += result.bytesWritten;
			}
			options.onProgress?.(written, release.size);
		};
		if (release.artifact.type === "local") {
			const descriptor = options.getBuiltin(release.artifact.builtinId);
			if (
				!descriptor ||
				descriptor.pluginId !== release.pluginId ||
				descriptor.version !== release.version
			)
				throw new PluginSourceFailure("local_missing");
			const loaded = await sourceAbortable(descriptor.load(options.signal), options.signal);
			if (loaded.sha256 !== release.sha256) throw new PluginSourceFailure("hash_mismatch");
			if (loaded.bytes.byteLength !== release.size) throw new PluginSourceFailure("size_mismatch");
			for (let offset = 0; offset < loaded.bytes.byteLength; offset += 64 * 1024)
				await write(loaded.bytes.subarray(offset, offset + 64 * 1024));
		} else {
			const policy = sourceDownloadPolicy(source, release.artifact.url);
			const response = await fetchPluginSource(
				safeSourceUrl(release.artifact.url, policy.allowHttp),
				policy.origins,
				options,
				policy.allowHttp,
			);
			if (!response.ok || !response.body) {
				void response.body?.cancel().catch(() => {});
				throw new PluginSourceFailure("request_failed");
			}
			const declared = response.headers.get("content-length");
			if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== release.size)) {
				void response.body.cancel().catch(() => {});
				throw new PluginSourceFailure("size_mismatch");
			}
			const reader = response.body.getReader();
			const cancel = () => {
				void reader.cancel().catch(() => {});
			};
			options.signal.addEventListener("abort", cancel, { once: true });
			try {
				for (;;) {
					const chunk = await sourceAbortable(reader.read(), options.signal);
					if (chunk.done) break;
					await write(chunk.value);
				}
			} finally {
				options.signal.removeEventListener("abort", cancel);
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
		if (written !== release.size) throw new PluginSourceFailure("size_mismatch");
		await file.close();
		file = undefined;
		const digest = await (options.hashArchive ?? hashPluginArchive)(path, {
			signal: options.signal,
		});
		options.signal.throwIfAborted();
		if (digest.size !== release.size) throw new PluginSourceFailure("size_mismatch");
		if (digest.sha256 !== release.sha256) throw new PluginSourceFailure("hash_mismatch");
		return { path, cleanup };
	} catch (error) {
		if (error instanceof WorkerCleanupError) {
			// The Worker may still have the archive open. Keep the directory and its owner until
			// the real exit, and include the deferred removal in the caller's retirement barrier.
			throw new PluginSourceCleanupError(error, error.handle.exited.then(cleanup));
		}
		const failures: unknown[] = [];
		try {
			await file?.close();
		} catch (failure) {
			failures.push(failure);
		}
		try {
			await cleanup();
		} catch (failure) {
			failures.push(failure);
		}
		if (failures.length)
			throw new PluginSourceCleanupError(new AggregateError([error, ...failures]));
		if (error instanceof PluginSourceCleanupError) throw error;
		if (options.signal.aborted) throw options.signal.reason;
		throw error instanceof PluginSourceFailure ? error : new PluginSourceFailure("apply_failed");
	}
}
