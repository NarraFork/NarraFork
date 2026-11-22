import { type BigIntStats, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { parentPort } from "node:worker_threads";
import type { GitLineStatsFile } from "../../shared/git-line-stats";

export const UNTRACKED_LINE_LIMITS = {
	files: 200,
	requestBytes: 1024 * 1024,
	fileBytes: 1_000_000,
	totalBytes: 20_000_000,
	timeoutMs: 30_000,
	cacheEntries: 512,
} as const;

export interface UntrackedLineBatch {
	files: GitLineStatsFile[];
	complete: boolean;
	/** Internal diagnostic, also used to verify that cache hits do not read contents. */
	readFiles: number;
	/** Conservatively charged file sizes, including failed reads and binary samples. */
	readBytes: number;
}

interface Measurement {
	lines?: number;
	complete: boolean;
}

function version(stat: BigIntStats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Used only inside the worker in production. No database/settings dependency. */
export class UntrackedLineReader {
	private readonly cache = new Map<string, { version: string; value: Measurement }>();

	async measure(
		cwd: string,
		paths: string[],
		signal: AbortSignal,
		remainingBytes: number = UNTRACKED_LINE_LIMITS.totalBytes,
		deadlineAt = Date.now() + UNTRACKED_LINE_LIMITS.timeoutMs,
	): Promise<UntrackedLineBatch> {
		if (
			!Number.isSafeInteger(remainingBytes) ||
			remainingBytes < 0 ||
			remainingBytes > UNTRACKED_LINE_LIMITS.totalBytes ||
			!Number.isFinite(deadlineAt)
		) {
			throw new Error("Invalid Git line statistics budget");
		}
		const check = () => {
			signal.throwIfAborted();
			if (Date.now() >= deadlineAt) throw new Error("Git line statistics worker timed out");
		};
		check();
		const root = resolve(cwd);
		const files: GitLineStatsFile[] = [];
		let remaining = remainingBytes;
		let requestBytes = Buffer.byteLength(JSON.stringify(cwd)) + 2;
		let readFiles = 0;
		let complete = paths.length <= UNTRACKED_LINE_LIMITS.files;
		for (const path of paths.slice(0, UNTRACKED_LINE_LIMITS.files)) {
			check();
			// Bound replies at the source as well: at most 200 DTOs and 1 MiB of path data.
			if (path.length > UNTRACKED_LINE_LIMITS.requestBytes - requestBytes) {
				complete = false;
				break;
			}
			requestBytes += Buffer.byteLength(JSON.stringify(path)) + 1;
			if (requestBytes > UNTRACKED_LINE_LIMITS.requestBytes) {
				complete = false;
				break;
			}
			let value: Measurement = { complete: false };
			const absolute = resolve(root, path);
			if (
				path &&
				!isAbsolute(path) &&
				!path.includes("\0") &&
				absolute.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
			) {
				try {
					const stat = await lstat(absolute, { bigint: true });
					check();
					if (stat.isFile() && stat.size <= BigInt(UNTRACKED_LINE_LIMITS.fileBytes)) {
						const stamp = version(stat);
						const cached = this.cache.get(absolute);
						if (cached?.version === stamp) {
							value = cached.value;
							// A tiny LRU: keep only metadata and counts, never file contents.
							this.cache.delete(absolute);
							this.cache.set(absolute, cached);
						} else if (stat.size <= BigInt(remaining)) {
							remaining -= Number(stat.size);
							readFiles++;
							value = await this.read(absolute, stat, check);
							check();
							if (value.complete) {
								this.cache.delete(absolute);
								this.cache.set(absolute, { version: stamp, value });
								if (this.cache.size > UNTRACKED_LINE_LIMITS.cacheEntries) {
									const oldest = this.cache.keys().next().value;
									if (oldest !== undefined) this.cache.delete(oldest);
								}
							}
						}
					}
				} catch {
					// Disappearing/unreadable/nonregular paths are unknown, not empty files.
					check();
				}
			}
			complete &&= value.complete;
			files.push({
				path,
				unstagedLinesAdded: value.lines,
				unstagedLinesRemoved: value.complete ? 0 : undefined,
				complete: value.complete,
			});
		}
		check();
		return { files, complete, readFiles, readBytes: remainingBytes - remaining };
	}

	private async read(path: string, expected: BigIntStats, check: () => void): Promise<Measurement> {
		const file = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		try {
			const before = await file.stat({ bigint: true });
			if (!before.isFile() || version(before) !== version(expected)) return { complete: false };
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let bytes = 0;
			let lines = 0;
			let lastByte = -1;
			while (bytes < Number(expected.size)) {
				check();
				const { bytesRead } = await file.read(
					buffer,
					0,
					Math.min(buffer.length, Number(expected.size) - bytes),
					null,
				);
				if (!bytesRead) return { complete: false };
				// Like Git, sample only the leading 8 KiB for binary NULs.
				const sample = Math.min(bytesRead, Math.max(0, 8192 - bytes));
				if (buffer.subarray(0, sample).includes(0)) {
					check();
					return version(await file.stat({ bigint: true })) === version(expected)
						? { lines: 0, complete: true }
						: { complete: false };
				}
				for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10) lines++;
				bytes += bytesRead;
				lastByte = buffer[bytesRead - 1];
			}
			check();
			if (version(await file.stat({ bigint: true })) !== version(expected))
				return { complete: false };
			return { lines: lines + (bytes > 0 && lastByte !== 10 ? 1 : 0), complete: true };
		} finally {
			await file.close();
		}
	}
}

const port = parentPort;
if (port) {
	const reader = new UntrackedLineReader();
	let active: AbortController | undefined;
	port.on(
		"message",
		async (
			message:
				| {
						action: "read";
						cwd: string;
						paths: string[];
						remainingBytes: number;
						deadlineAt: number;
				  }
				| { action: "cancel" }
				| { action: "ping" },
		) => {
			if (message.action === "ping") {
				port.postMessage({ ready: true });
				return;
			}
			if (message.action === "cancel") {
				active?.abort();
				return;
			}
			if (active) {
				port.postMessage({ error: "git_line_stats_reader_busy" });
				return;
			}
			const controller = new AbortController();
			active = controller;
			try {
				if (
					!Array.isArray(message.paths) ||
					message.paths.length > UNTRACKED_LINE_LIMITS.files ||
					typeof message.remainingBytes !== "number" ||
					typeof message.deadlineAt !== "number"
				) {
					throw new Error("Invalid Git line statistics request");
				}
				const value = await reader.measure(
					message.cwd,
					message.paths,
					controller.signal,
					message.remainingBytes,
					message.deadlineAt,
				);
				port.postMessage({ value });
			} catch (error) {
				port.postMessage({
					error: error instanceof Error ? error.message : "git_line_stats_read_failed",
				});
			} finally {
				active = undefined;
			}
		},
	);
}
