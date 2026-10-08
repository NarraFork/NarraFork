import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { posix } from "node:path";
import type { FileMetadataOptions } from "./backend";

export const EXCLUSIVE_CREATE_MAX_BYTES = 2_000_000;
export const EXCLUSIVE_CREATE_TIMEOUT_MS = 30_000;
export const EXCLUSIVE_CREATE_MAX_PATH_BYTES = 32_768;
export const EXCLUSIVE_CREATE_MAX_DEPTH = 128;

/** Validate before canonicalization, allocation, or filesystem access. */
export function validateExclusiveCreateInput(
	path: unknown,
	bytes?: Uint8Array,
): asserts path is string {
	if (
		typeof path !== "string" ||
		!path ||
		path.includes("\0") ||
		Buffer.byteLength(path) > EXCLUSIVE_CREATE_MAX_PATH_BYTES
	)
		throw new Error("Invalid or oversized exclusive create path");
	if (path.split(/[/\\]/).length > EXCLUSIVE_CREATE_MAX_DEPTH + 1)
		throw new Error("Exclusive create path exceeds the directory depth limit");
	if (bytes && bytes.byteLength > EXCLUSIVE_CREATE_MAX_BYTES)
		throw new Error(`Exclusive create exceeds the ${EXCLUSIVE_CREATE_MAX_BYTES}-byte file limit`);
}

/** One deadline covers canonicalization, disk guard, parent binding and the write. */
export function exclusiveCreateOptions(opts?: FileMetadataOptions): Required<FileMetadataOptions> {
	const timeoutMs = opts?.timeoutMs ?? EXCLUSIVE_CREATE_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > EXCLUSIVE_CREATE_TIMEOUT_MS)
		throw new RangeError("Invalid exclusive create timeout");
	opts?.signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(timeoutMs);
	return {
		timeoutMs,
		signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
	};
}

/** Injectable syscalls, following file-change-local-io without global FS mocks. */
export interface ExclusiveCreateSyscalls {
	open(path: string, flags: number, mode?: number): Promise<FileHandle>;
	mkdir(path: string, options: { mode: number }): Promise<unknown>;
}

export function createExclusiveLocalIo(
	syscalls: ExclusiveCreateSyscalls = { open, mkdir },
	platform = process.platform,
) {
	async function withParent<T>(
		path: string,
		signal: AbortSignal,
		mutate: (boundPath: string) => Promise<T>,
	): Promise<T> {
		validateExclusiveCreateInput(path);
		signal.throwIfAborted();
		// Node/Bun have no portable openat/mkdirat API. Never replace this with a
		// full pathname or a post-create check: either can already write outside.
		if (platform !== "linux" || !constants.O_DIRECTORY || !constants.O_NOFOLLOW)
			throw new Error(
				"Secure exclusive creation requires Linux procfs locally; use a bound-parent capable remote executor on this platform",
			);
		if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path === "/")
			throw new Error("Exclusive creation requires a canonical absolute non-root path");
		const parts = path.slice(1).split("/");
		const leaf = parts.pop();
		if (!leaf || parts.length >= EXCLUSIVE_CREATE_MAX_DEPTH)
			throw new Error("Invalid exclusive create path depth");
		const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
		let parent = await syscalls.open("/", flags);
		try {
			for (const component of parts) {
				signal.throwIfAborted();
				// The only traversed component after the kernel's fd reference is a
				// single name, and O_NOFOLLOW rejects replacements with symlinks.
				const next = await syscalls.open(`/proc/self/fd/${parent.fd}/${component}`, flags);
				try {
					await parent.close();
				} catch (error) {
					await next.close();
					throw error;
				}
				parent = next;
			}
			signal.throwIfAborted();
			// If an ancestor or parent is replaced after validation, this still
			// addresses the bound directory. Missing procfs fails before mutation.
			return await mutate(`/proc/self/fd/${parent.fd}/${leaf}`);
		} finally {
			await parent.close();
		}
	}

	return {
		async mkdir(path: string, signal: AbortSignal): Promise<boolean> {
			return withParent(path, signal, async (boundPath) => {
				try {
					await syscalls.mkdir(boundPath, { mode: 0o700 });
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
					throw error;
				}
			});
		},
		async write(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
			validateExclusiveCreateInput(path, bytes);
			return withParent(path, signal, async (boundPath) => {
				const file = await syscalls.open(
					boundPath,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
				try {
					let offset = 0;
					// Once O_EXCL succeeds, finish this bounded <=2 MiB write. Aborting
					// mid-write would leave an ambiguous partial file and invite retries.
					while (offset < bytes.byteLength) {
						const { bytesWritten } = await file.write(
							bytes,
							offset,
							Math.min(64 * 1024, bytes.byteLength - offset),
							offset,
						);
						if (!bytesWritten) throw new Error("Exclusive create write made no progress");
						offset += bytesWritten;
					}
				} finally {
					// Cancellation/failure may leave our own partial file. Do not unlink
					// a pathname that another process may have replaced, or auto-retry.
					await file.close();
				}
			});
		},
	};
}

export const exclusiveLocalIo = createExclusiveLocalIo();
