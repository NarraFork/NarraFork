import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
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

/** Only the descriptor operations used here; injectable without global FS mocks. */
export interface LocalFileHandle {
	stat(options: { bigint: true }): Promise<BigIntStats>;
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>;
	write(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesWritten: number }>;
	truncate(length: number): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface LocalFileSyscalls {
	lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
	/** Deliberately non-recursive: one call can affect only this directory entry. */
	mkdir(path: string): Promise<void>;
	open(path: string, flags: number, mode?: number): Promise<LocalFileHandle>;
}

async function readHandle(
	file: LocalFileHandle,
	signal?: AbortSignal,
): Promise<LocalFileObservation> {
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
	/** Registration only, immediately before the first potentially mutating syscall. */
	onDispatch(): void;
}

export const LOCAL_FILE_PARENT_DEPTH_LIMIT = 128;

export interface LocalFileParentEffects {
	/** Successful, single-entry mkdir calls, in creation order; at most 128 paths. */
	createdPaths: string[];
	/** At most one uncertain mkdir entry (never a recursive subtree); not safe to dismiss. */
	possiblePaths: string[];
}

/**
 * not_applied: no target mutation and both parent lists empty.
 * parent_only: target untouched; runtime must evaluate BOTH parent lists against
 * its admitted scope before treating this as safely releasable.
 * target_mutation_unknown: target mutation started or its completion is uncertain.
 * applied: all writes, sync, validation and close completed successfully.
 */
export type LocalFileApplyResult =
	| {
			kind: "not_applied" | "parent_only" | "target_mutation_unknown";
			error: unknown;
			parentEffects: LocalFileParentEffects;
	  }
	| { kind: "applied"; error: null; parentEffects: LocalFileParentEffects };

export interface FileChangeLocalIo {
	read(path: string, signal?: AbortSignal): Promise<LocalFileObservation>;
	/** Failures are returned, not swallowed. The caller must throw result.error. */
	apply(input: LocalFileApplyInput): Promise<LocalFileApplyResult>;
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

function codeOf(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error
		? String(error.code)
		: undefined;
}

/**
 * Used ONLY at the controlled nonrecursive mkdir / O_EXCL open call boundary.
 * These errors reject creation before changing the entry. Other failures (EIO,
 * cancellation-shaped exceptions, adapter bugs, etc.) retain uncertain effects.
 * Never apply this whitelist to truncate/write/sync/close or caller exceptions.
 */
function creationDefinitelyRejected(error: unknown): boolean {
	return ["EACCES", "EPERM", "EEXIST", "ENOENT", "ENOTDIR", "EROFS", "ELOOP"].includes(
		codeOf(error) ?? "",
	);
}

function directory(stat: BigIntStats): void {
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new LocalFileValidationError("Canonical parent is not a directory");
}

/**
 * A bounded, descriptor-based local writer. It does NOT promise filesystem CAS or
 * OS atomicity: an external writer may race any check. Such observed mismatches
 * are quarantined by the runtime; no old state is automatically written back.
 */
export function createFileChangeLocalIo(
	syscalls: LocalFileSyscalls = { lstat, mkdir, open },
): FileChangeLocalIo {
	return {
		async read(path, signal) {
			signal?.throwIfAborted();
			let entry: BigIntStats;
			try {
				entry = await syscalls.lstat(path, { bigint: true });
			} catch (error) {
				if (codeOf(error) === "ENOENT") return { bytes: null, mode: null, identity: null };
				throw error;
			}
			regular(entry);
			const file = await syscalls.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			let observed: LocalFileObservation;
			try {
				observed = await readHandle(file, signal);
				const current = await syscalls.lstat(path, { bigint: true });
				regular(current);
				if (
					observed.identity !== localObjectIdentity(entry) ||
					observed.identity !== localObjectIdentity(current)
				)
					throw new LocalFileValidationError("Canonical file object changed during read");
			} catch (error) {
				try {
					await file.close();
				} catch {
					// Keep the primary read/validation error rather than cleanup's error.
				}
				throw error;
			}
			await file.close();
			return observed;
		},
		async apply(input) {
			const { before, canonicalPath, nextBytes, signal } = input;
			const parentEffects: LocalFileParentEffects = { createdPaths: [], possiblePaths: [] };
			let targetMutation = false;
			let file: LocalFileHandle | undefined;
			let failed = false;
			let failure: unknown;
			let registered = false;
			const beforeMutation = () => {
				signal.throwIfAborted();
				if (!registered) {
					input.onDispatch();
					registered = true;
				}
				signal.throwIfAborted();
			};
			try {
				signal.throwIfAborted();
				if (nextBytes.byteLength > FILE_CHANGE_LIMITS.blobBytes)
					throw new LocalFileValidationError("Output exceeds the 32 MiB evidence limit");
				await input.assertTarget();
				signal.throwIfAborted();
				if (!equal(before, await this.read(canonicalPath, signal)))
					throw new LocalFileValidationError("Content/object changed before dispatch");
				if (before.bytes === null) {
					// Bound the whole ancestor chain before any mutation, then discover
					// missing entries without recursive mkdir's opaque partial effects.
					const ancestors: string[] = [];
					let path = dirname(canonicalPath);
					while (dirname(path) !== path) {
						if (ancestors.length >= LOCAL_FILE_PARENT_DEPTH_LIMIT)
							throw new LocalFileValidationError("Parent directory depth exceeds 128");
						ancestors.push(path);
						path = dirname(path);
					}
					const missing: string[] = [];
					for (const ancestor of ancestors) {
						signal.throwIfAborted();
						try {
							directory(await syscalls.lstat(ancestor, { bigint: true }));
							break;
						} catch (error) {
							if (codeOf(error) !== "ENOENT") throw error;
							missing.push(ancestor);
						}
					}
					for (const parent of missing.reverse()) {
						// Discovery awaits can observe a deleted/replaced admission
						// anchor. Revalidate before EACH mkdir, not after creating it.
						await input.assertTarget();
						beforeMutation();
						try {
							await syscalls.mkdir(parent);
							parentEffects.createdPaths.push(parent);
						} catch (error) {
							if (!creationDefinitelyRejected(error)) parentEffects.possiblePaths.push(parent);
							if (codeOf(error) !== "EEXIST") throw error;
							// Another actor may have made the directory. EEXIST itself
							// proves nothing about its type, and is not our side effect.
							directory(await syscalls.lstat(parent, { bigint: true }));
						}
					}
					signal.throwIfAborted();
					await input.assertTarget();
					beforeMutation();
					targetMutation = true;
					try {
						file = await syscalls.open(
							canonicalPath,
							constants.O_WRONLY |
								constants.O_CREAT |
								constants.O_EXCL |
								(constants.O_NOFOLLOW ?? 0),
							0o666,
						);
					} catch (error) {
						if (creationDefinitelyRejected(error)) targetMutation = false;
						throw error;
					}
				} else {
					if (before.mode !== null && (before.mode & 0o222) === 0)
						throw new LocalFileValidationError("File is read-only");
					signal.throwIfAborted();
					// No O_TRUNC/O_CREAT: even a failed open cannot mutate the target.
					file = await syscalls.open(canonicalPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
				}
				if (before.bytes !== null && !equal(before, await readHandle(file, signal)))
					throw new LocalFileValidationError("Opened content/object changed before dispatch");
				// After exclusive creation, complete persistence despite cancellation.
				if (before.bytes !== null) await input.assertTarget();
				// Recheck the descriptor after asynchronous guards. This narrows the
				// rename-and-replace race window; it is not an OS-level CAS guarantee.
				const openedBeforeDispatch = await file.stat({ bigint: true });
				const pathBeforeDispatch = await syscalls.lstat(canonicalPath, { bigint: true });
				regular(openedBeforeDispatch);
				regular(pathBeforeDispatch);
				if (localObjectIdentity(openedBeforeDispatch) !== localObjectIdentity(pathBeforeDispatch))
					throw new LocalFileValidationError(
						"Opened object no longer matches the target before dispatch",
					);
				if (before.bytes !== null) {
					beforeMutation();
					targetMutation = true;
					await file.truncate(0);
				}
				// Never race IO with cancellation: await the entire bounded write,
				// sync and close, even if cancellation happens after mutation starts.
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
				signal.throwIfAborted();
				const written = await file.stat({ bigint: true });
				const current = await syscalls.lstat(canonicalPath, { bigint: true });
				regular(current);
				if (localObjectIdentity(written) !== localObjectIdentity(current))
					throw new LocalFileValidationError("Written object was replaced before verification");
			} catch (error) {
				failed = true;
				failure = error;
			} finally {
				if (file) {
					try {
						await file.close();
					} catch (error) {
						// A failed close is not successful completion. Keep the primary
						// error if an earlier stage failed; do not mask it with cleanup.
						// Closing an existing nontruncating descriptor does not itself
						// modify content: retain the actual mutation stage, not a guess.
						if (!failed) failure = error;
						failed = true;
					}
				}
			}
			// Cancellation while awaiting close must not be reported as a clean apply.
			if (!failed && signal.aborted) {
				failed = true;
				failure = signal.reason;
			}
			if (!failed) return { kind: "applied", error: null, parentEffects };
			return {
				kind: targetMutation
					? "target_mutation_unknown"
					: parentEffects.createdPaths.length || parentEffects.possiblePaths.length
						? "parent_only"
						: "not_applied",
				error: failure,
				parentEffects,
			};
		},
	};
}

export const fileChangeLocalIo: FileChangeLocalIo = createFileChangeLocalIo();
