import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type { ExecutionBackend } from "../lib/agent/execution/backend";

export interface LocalFileObservation {
	bytes: Uint8Array | null;
	mode: number | null;
	/** Not a content version: checked in addition to bytes, mode and canonical path. */
	identity: string | null;
}

export class LocalFileValidationError extends Error {
	constructor(
		message: string,
		readonly toolOutput?: string,
	) {
		super(message);
		this.name = "LocalFileValidationError";
	}
}

export function localObjectIdentity(stat: BigIntStats): string {
	if (stat.ino === 0n && stat.dev === 0n)
		throw new LocalFileValidationError("Local filesystem does not expose an object identity");
	// Without a creation timestamp, recycled dev/ino values cannot distinguish
	// workspace incarnations. Do not invent continuity from mtime/ctime instead.
	if (stat.birthtimeNs <= 0n)
		throw new LocalFileValidationError("Local filesystem does not expose a valid creation time");
	return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

export async function localDirectoryIdentity(path: string): Promise<string> {
	const stat = await lstat(path, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new LocalFileValidationError("Canonical workspace root is not a directory");
	return localObjectIdentity(stat);
}

function regular(stat: BigIntStats): void {
	if (!stat.isFile() || stat.nlink !== 1n)
		throw new LocalFileValidationError("Only single-link regular file referents are supported");
	if (stat.size > BigInt(FILE_CHANGE_LIMITS.blobBytes))
		throw new LocalFileValidationError("File exceeds the 32 MiB evidence limit");
}

async function readHandle(file: FileHandle, signal?: AbortSignal): Promise<LocalFileObservation> {
	signal?.throwIfAborted();
	const initial = await file.stat({ bigint: true });
	regular(initial);
	const bytes = Buffer.alloc(Number(initial.size));
	let offset = 0;
	while (offset < bytes.length) {
		signal?.throwIfAborted();
		const read = await file.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
		if (!read.bytesRead) throw new LocalFileValidationError("File changed during complete read");
		offset += read.bytesRead;
	}
	const final = await file.stat({ bigint: true });
	regular(final);
	if (
		initial.size !== final.size ||
		initial.mtimeNs !== final.mtimeNs ||
		initial.ctimeNs !== final.ctimeNs ||
		initial.mode !== final.mode ||
		localObjectIdentity(initial) !== localObjectIdentity(final)
	)
		throw new LocalFileValidationError("File changed during complete read");
	signal?.throwIfAborted();
	return { bytes, mode: Number(final.mode & 0o7777n), identity: localObjectIdentity(final) };
}

export interface LocalFileApplyInput {
	backend: ExecutionBackend;
	lexicalPath: string;
	canonicalPath: string;
	before: LocalFileObservation;
	nextBytes: Uint8Array;
	signal: AbortSignal;
	/** Includes the frozen runtime, workspace incarnation and coordinator fence. */
	assertTarget(): Promise<void>;
	/** Called synchronously immediately before the first mutating syscall. */
	onDispatch(): void;
}

export interface FileChangeLocalIo {
	read(path: string, signal?: AbortSignal): Promise<LocalFileObservation>;
	apply(input: LocalFileApplyInput): Promise<void>;
}

function equal(left: LocalFileObservation, right: LocalFileObservation): boolean {
	return (
		left.mode === right.mode &&
		left.identity === right.identity &&
		(left.bytes === null
			? right.bytes === null
			: right.bytes !== null && Buffer.from(left.bytes).equals(right.bytes))
	);
}

/**
 * A bounded, descriptor-based local writer. It does NOT promise filesystem CAS or
 * OS atomicity: an external writer may race any check. Such observed mismatches
 * are quarantined by the runtime; no old state is automatically written back.
 */
export const fileChangeLocalIo: FileChangeLocalIo = {
	async read(path, signal) {
		signal?.throwIfAborted();
		let entry: BigIntStats;
		try {
			entry = await lstat(path, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { bytes: null, mode: null, identity: null };
			throw error;
		}
		regular(entry);
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const observed = await readHandle(file, signal);
			const current = await lstat(path, { bigint: true });
			regular(current);
			if (
				observed.identity !== localObjectIdentity(entry) ||
				observed.identity !== localObjectIdentity(current)
			)
				throw new LocalFileValidationError("Canonical file object changed during read");
			return observed;
		} finally {
			await file.close();
		}
	},
	async apply(input) {
		const { before, canonicalPath, nextBytes, signal } = input;
		signal.throwIfAborted();
		if (nextBytes.byteLength > FILE_CHANGE_LIMITS.blobBytes)
			throw new LocalFileValidationError("Output exceeds the 32 MiB evidence limit");
		await input.assertTarget();
		if (!equal(before, await this.read(canonicalPath, signal)))
			throw new LocalFileValidationError("Content/object changed before dispatch");
		let file: FileHandle;
		if (before.bytes === null) {
			// Directory creation is also a dispatch: a later failure must not claim
			// no filesystem calls ran. Never compensate these parents recursively.
			signal.throwIfAborted();
			input.onDispatch();
			signal.throwIfAborted();
			await mkdir(dirname(canonicalPath), { recursive: true });
			await input.assertTarget();
			signal.throwIfAborted();
			file = await open(
				canonicalPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
				0o666,
			);
		} else {
			if (before.mode !== null && (before.mode & 0o222) === 0)
				throw new LocalFileValidationError("File is read-only");
			// Opening an existing descriptor does not truncate or otherwise mutate it.
			file = await open(canonicalPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
		}
		try {
			if (before.bytes !== null && !equal(before, await readHandle(file, signal)))
				throw new LocalFileValidationError("Opened content/object changed before dispatch");
			// O_EXCL already mutated a new target. Its runtime/path guards ran just
			// before open: do not let a cancelled lease leave that file empty now.
			if (before.bytes !== null) await input.assertTarget();
			// assertTarget awaits canonical/runtime guards. Recheck the descriptor
			// against the directory entry AFTER those awaits: a rename-and-replace
			// must not make us truncate the now-moved original object. This narrows
			// the observed race window; it is not an OS-level CAS guarantee.
			const [openedBeforeDispatch, pathBeforeDispatch] = await Promise.all([
				file.stat({ bigint: true }),
				lstat(canonicalPath, { bigint: true }),
			]);
			regular(openedBeforeDispatch);
			regular(pathBeforeDispatch);
			if (localObjectIdentity(openedBeforeDispatch) !== localObjectIdentity(pathBeforeDispatch))
				throw new LocalFileValidationError(
					"Opened object no longer matches the target before dispatch",
				);
			if (before.bytes !== null) {
				signal.throwIfAborted();
				input.onDispatch();
				signal.throwIfAborted();
				await file.truncate(0);
			}
			// Once truncate/O_EXCL starts, finish the bounded write and sync even
			// after cooperative cancellation. IO errors still propagate; this is
			// not atomicity and must never trigger a rollback over external edits.
			let offset = 0;
			while (offset < nextBytes.byteLength) {
				const written = await file.write(
					nextBytes,
					offset,
					Math.min(64 * 1024, nextBytes.byteLength - offset),
					offset,
				);
				if (!written.bytesWritten) throw new Error("Local file write made no progress");
				offset += written.bytesWritten;
			}
			await file.sync();
			await input.assertTarget();
			const [written, current] = await Promise.all([
				file.stat({ bigint: true }),
				lstat(canonicalPath, { bigint: true }),
			]);
			regular(current);
			if (localObjectIdentity(written) !== localObjectIdentity(current))
				throw new LocalFileValidationError("Written object was replaced before verification");
		} finally {
			await file.close();
		}
	},
};
