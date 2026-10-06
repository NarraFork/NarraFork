import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeExecutionBinding,
	type FileChangeIdentity,
	type FileChangeState,
	fileChangeStatesEqual,
	type KnownFileChangeState,
} from "@shared/file-change-protocol";
import { type ExecutionBackend, LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { logger } from "../lib/logger";
import {
	createFileChangeIdentity,
	type FileChangeScopeIdentity,
	fileChangeExecutionBindingMatches,
	fileChangeIdentityKey,
} from "./file-change-identity";
import { localObjectIdentity } from "./file-change-local-io";
import type { WorkspaceRuntimeBinding, WorkspaceWriteLease } from "./workspace-write-coordinator";

export const LOCAL_RESTORE_LIMITS = Object.freeze({
	timeoutMs: 30_000,
	maxTimeoutMs: 120_000,
	pathComponents: 128,
	createdParents: 32,
	ioChunkBytes: 64 * 1024,
});

type RestoreState = { kind: "absent" } | { kind: "regular"; blob: FileChangeBlobRef; mode: number };
export interface LocalRestoreDescriptor {
	mutationId: string;
	requestDigest: string;
	identity: Readonly<FileChangeIdentity>;
	scope: Readonly<FileChangeScopeIdentity>;
	executionBinding: Readonly<FileChangeExecutionBinding>;
	/** Measured incarnation of the existing root; never synthesized from a path. */
	rootObjectIdentity: string;
	/** Fresh preflight object identity, in addition to typed bytes/mode. null ONLY for absent. */
	expectedObjectIdentity: string | null;
	expected: KnownFileChangeState;
	desired: KnownFileChangeState;
	createParents?: boolean;
}
export interface LocalRestoreGuard extends Readonly<LocalRestoreDescriptor> {
	phase: "preflight" | "before_dispatch" | "after_dispatch";
	signal: AbortSignal;
}
export interface LocalFileRestoreInput extends LocalRestoreDescriptor {
	/** Must be the actual local singleton, never a remote backend labelled local. */
	backend: ExecutionBackend;
	/** Already held by the caller. No worktree lock, lease acquisition or settlement here. */
	lease: WorkspaceWriteLease;
	/** Existing runtime authority, not a requested/generated epoch. */
	readRuntime(deviceId: string): WorkspaceRuntimeBinding | null;
	authorize(guard: LocalRestoreGuard): Promise<void>;
	/** Recheck namespace, live scope, plan/version AND the durable, blob-pinned intent. */
	assertCurrent(guard: LocalRestoreGuard): void | Promise<void>;
	/**
	 * Synchronous durable applying/lease.registerMutation barrier, once before the
	 * FIRST actual mutation (including mkdir). Throwing prevents dispatch. A Promise
	 * is invalid. It must NOT perform filesystem work or change the frozen target.
	 */
	onDispatch(guard: LocalRestoreGuard): void;
	/** Authorized, verified, bounded raw store adapter. The helper also rehashes its copy. */
	readBlob(
		ref: Readonly<FileChangeBlobRef>,
		options: { signal: AbortSignal; maxBytes: number },
	): Promise<Uint8Array>;
	signal: AbortSignal;
	timeoutMs?: number;
}

/**
 * Windows semantics differ in ways that matter for a guarded restore:
 * - no O_NOFOLLOW/O_NONBLOCK: reparse points are DETECTED by the existing
 *   lstat-before-open and fd/path identity comparisons, not prevented;
 * - mode is synthesized from the read-only attribute only (0o666/0o444); there
 *   are no execute bits and no owner/ACL model visible through stat;
 * - deleting a read-only file fails with EPERM, and fchmod needs a handle with
 *   write-attribute access;
 * - sharing violations (EBUSY, and EPERM from antivirus/indexers) are common
 *   and transient before any mutation.
 * Admission of the volume itself (stable dev:ino:birthtime, real nlink) is
 * checked by file-change-platform-capability before a plan is prepared.
 */
let restoreSemantics: NodeJS.Platform = process.platform;
/**
 * Test-only: apply Windows restore DECISIONS (read-only delete, mode handling,
 * sharing-violation mapping) on a POSIX host. Backend authority and open flags
 * always follow the real host, so this cannot relax production checks.
 */
export function setLocalRestoreSemanticsForTests(platform: NodeJS.Platform | null): void {
	restoreSemantics = platform ?? process.platform;
}
const windowsSemantics = () => restoreSemantics === "win32";
/** libuv's synthesized regular-file modes: read-only attribute clear / set. */
const WINDOWS_WRITABLE_MODE = 0o666;
const WINDOWS_READ_ONLY_MODE = 0o444;

export interface LocalRestoreObservation {
	/** A raw observation, NOT a published blob reference or durable execution receipt. */
	state: FileChangeState;
	raw: Uint8Array | null;
	objectIdentity: string | null;
}
export type LocalRestoreFailure =
	| "invalid_input"
	| "unsupported_backend"
	| "unsupported_object"
	| "target_changed"
	| "expected_mismatch"
	| "authorization_failed"
	| "guard_failed"
	| "permission_denied"
	| "blob_invalid"
	| "budget_exceeded"
	| "cancelled"
	| "timeout"
	/** Windows sharing violation before dispatch: nothing was written; retryable. */
	| "io_busy"
	| "io_failed";
export interface LocalFileRestoreResult {
	/** Only this invocation. Never use a new no-op to settle an older uncertain mutation. */
	status: "applied" | "not_dispatched" | "uncertain_after_dispatch";
	reason: LocalRestoreFailure | "verified" | "no_change" | "preflight_verified";
	observation: LocalRestoreObservation | null;
	/** Snapshot at return: target IO or cleanup may still be pending, including late guards/adapters. */
	ioPending: boolean;
	/**
	 * Lifetime barrier, NOT a receipt or a new outcome. Always await while retaining
	 * the lease and pinned resources before any follow-up operation. It waits for
	 * all dispatched IO/awaited guards and blob adapters, then closes even a late
	 * opened fd. A failed close rejects; a hung kernel/adapter can keep it pending
	 * beyond the request deadline. Neither fulfillment nor rejection upgrades an
	 * uncertain result or permits automatic compensation/retry.
	 */
	whenSettled: Promise<void>;
	/** Acknowledged IO only; byte counts are lower bounds on uncertainty, never no-write evidence. */
	stats: { elapsedMs: number; bytesRead: number; bytesWritten: number; dispatches: 0 | 1 };
}

class RestoreError extends Error {
	constructor(readonly code: LocalRestoreFailure) {
		super(code);
	}
}
function fail(code: LocalRestoreFailure): never {
	throw new RestoreError(code);
}

/**
 * One guarded local regular/absent object, not an OS CAS, transaction or idempotency
 * journal. POSIX requires O_NOFOLLOW/O_NONBLOCK; Windows follows the weaker contract
 * documented at `restoreSemantics` above (detect, not prevent, reparse swaps). Links,
 * directories, special objects and multiply-linked files fail closed. Both lexical
 * and canonical ancestors must be real directories, including symlink cwd aliases.
 *
 * A caller MUST hold the common coordinator lease and persist/pin the full intent
 * BEFORE invoking this API. It MUST durably record the result; this in-memory return
 * cannot recover a crash/lost response. Matching current==desired cannot confirm an
 * earlier attempt. There is no retry, implicit compensation, recursive deletion or
 * cleanup of created parents. Compensation uses a NEW mutationId with this attempt's
 * actually verified after as expected; third-party edits/replacements then refuse.
 *
 * External processes can still race the final path checks and unlink/open/write.
 * Descriptor writes protect against detected replacement, not arbitrary external
 * races or cross-file atomicity. Deadlines stop further dispatch, not kernel IO
 * already running; late handles close only AFTER pending IO completes.
 */
export async function restoreLocalFile(
	input: LocalFileRestoreInput,
): Promise<LocalFileRestoreResult> {
	return runLocalRestore(input, false);
}

/**
 * Read-only validation of the ORIGINAL full intent, for a caller's complete file
 * set preflight. Shares every pre-dispatch check and whenSettled cleanup with the
 * writer, but never invokes onDispatch, registers a mutation or creates parents.
 * Success is not a reservation, execution receipt, or authority for a later write:
 * restoreLocalFile ALWAYS repeats the complete checks in a fresh session. The
 * caller must await whenSettled and require preflight_verified for EVERY target
 * before starting any mutation; expected/desired/requestDigest remain unchanged.
 */
export async function preflightLocalFileRestore(
	input: LocalFileRestoreInput,
): Promise<LocalFileRestoreResult> {
	return runLocalRestore(input, true);
}

async function runLocalRestore(
	input: LocalFileRestoreInput,
	preflightOnly: boolean,
): Promise<LocalFileRestoreResult> {
	const started = performance.now();
	let session: RestoreSession | undefined;
	let reason: LocalFileRestoreResult["reason"] = "invalid_input";
	let succeeded = false;
	let whenSettled = Promise.resolve();
	try {
		// Copy only bounded fields, synchronously before the first await.
		session = new RestoreSession(input, freezeDescriptor(input));
		reason = await session.execute(preflightOnly);
		succeeded = true;
	} catch (error) {
		reason = failureCode(error);
	} finally {
		if (session) {
			try {
				// Start cleanup independently of the deadline; only waiting for its
				// foreground completion is bounded. The original promise survives.
				whenSettled = session.close();
				await session.budget.wait(() => whenSettled);
			} catch (error) {
				succeeded = false;
				reason = failureCode(error);
			}
			session.budget.dispose();
		}
	}
	const result: LocalFileRestoreResult = {
		status: session?.dispatched
			? succeeded
				? "applied"
				: "uncertain_after_dispatch"
			: "not_dispatched",
		reason,
		observation: session?.observation ?? null,
		ioPending: session ? session.pending.size > 0 : false,
		whenSettled,
		stats: {
			elapsedMs: Math.round(performance.now() - started),
			bytesRead: session?.bytesRead ?? 0,
			bytesWritten: session?.bytesWritten ?? 0,
			dispatches: session?.dispatched ? 1 : 0,
		},
	};
	if (result.stats.elapsedMs > 1_000) {
		// Bounded diagnostics only; never log raw bytes, blob refs, paths or ACL input.
		logger.warn("Slow guarded local restore", {
			...result.stats,
			status: result.status,
			reason: result.reason,
			ioPending: result.ioPending,
		});
	}
	return result;
}

type FrozenDescriptor = Readonly<Omit<LocalRestoreDescriptor, "expected" | "desired">> & {
	expected: Readonly<RestoreState>;
	desired: Readonly<RestoreState>;
};
type DirectoryStamp = { identity: string; mode: bigint };
class RestoreSession {
	readonly budget: RestoreBudget;
	readonly pending = new Set<Promise<unknown>>();
	dispatched = false;
	observation: LocalRestoreObservation | null = null;
	bytesRead = 0;
	bytesWritten = 0;
	private file?: fs.FileHandle;
	/** Path stamp from the most recent successful verifyOpened. */
	private verifiedStamp?: BigIntStats;
	private cleanup?: Promise<void>;
	private readonly backend: ExecutionBackend;
	private readonly lease: WorkspaceWriteLease;
	private readonly authorize: LocalFileRestoreInput["authorize"];
	private readonly assertCurrent: LocalFileRestoreInput["assertCurrent"];
	private readonly onDispatch: LocalFileRestoreInput["onDispatch"];
	private readonly readBlob: LocalFileRestoreInput["readBlob"];
	private readonly readRuntime: LocalFileRestoreInput["readRuntime"];
	private readonly ancestors = new Map<string, DirectoryStamp | null>();

	constructor(
		input: LocalFileRestoreInput,
		private readonly target: FrozenDescriptor,
	) {
		for (const key of [
			"authorize",
			"assertCurrent",
			"onDispatch",
			"readBlob",
			"readRuntime",
		] as const)
			if (typeof input[key] !== "function") fail("invalid_input");
		if (!input.signal || typeof input.signal.addEventListener !== "function" || !input.lease)
			fail("invalid_input");
		this.backend = input.backend;
		this.lease = input.lease;
		this.authorize = input.authorize;
		this.assertCurrent = input.assertCurrent;
		this.onDispatch = input.onDispatch;
		this.readBlob = input.readBlob;
		this.readRuntime = input.readRuntime;
		this.checkAuthority();
		this.budget = new RestoreBudget(
			input.signal,
			input.timeoutMs ?? LOCAL_RESTORE_LIMITS.timeoutMs,
		);
	}

	private checkAuthority() {
		const { identity, executionBinding, scope } = this.target;
		if (
			this.backend !== localBackend ||
			this.backend.kind !== "local" ||
			this.backend.deviceId !== LOCAL_DEVICE_ID ||
			identity.deviceId !== LOCAL_DEVICE_ID ||
			identity.pathFlavor !== this.backend.pathFlavor ||
			// Authority follows the REAL host, never the test semantics override.
			(process.platform === "win32"
				? this.backend.pathFlavor !== "windows"
				: this.backend.pathFlavor !== "posix" || !constants.O_NOFOLLOW || !constants.O_NONBLOCK)
		)
			fail("unsupported_backend");
		const runtime = this.readRuntime(identity.deviceId);
		if (
			!runtime ||
			runtime.runtimeEpoch !== executionBinding.runtimeEpoch ||
			runtime.runtimeGeneration !== executionBinding.runtimeGeneration ||
			this.backend.runtimeGeneration !== executionBinding.runtimeGeneration ||
			!fileChangeExecutionBindingMatches(executionBinding, this.lease.executionBinding)
		)
			fail("target_changed");
		for (const key of [
			"id",
			"sourceInstanceId",
			"deviceId",
			"workspaceInstanceId",
			"pathFlavor",
			"canonicalRoot",
		] as const)
			if (this.lease.scope[key] !== scope[key]) fail("target_changed");
		// Observation is a coordinator capability, not authority to race native file recovery.
		if (this.lease.overlappedUncoordinatedActivity) fail("guard_failed");
		this.lease.assertCurrent(executionBinding);
	}

	private context(phase: LocalRestoreGuard["phase"]): LocalRestoreGuard {
		return Object.freeze({ ...this.target, phase, signal: this.budget.signal });
	}
	private async guard(phase: LocalRestoreGuard["phase"]) {
		this.budget.check();
		this.checkAuthority();
		const context = this.context(phase);
		try {
			await this.budget.wait(async () => this.assertCurrent(context));
		} catch (error) {
			this.budget.check();
			if (error instanceof RestoreError) throw error;
			fail("guard_failed");
		}
		// Authorization is the last caller-supplied await; a slow durable guard
		// cannot leave an earlier permission verdict silently cached until write.
		try {
			await this.budget.wait(() => this.authorize(context));
		} catch (error) {
			this.budget.check();
			if (error instanceof RestoreError) throw error;
			fail("authorization_failed");
		}
		this.checkAuthority();
		// Resolve using the real backend, never a caller supplied canonicalizer.
		for (const [lexical, canonical] of [
			[this.target.scope.canonicalRoot, this.target.scope.canonicalRoot],
			[this.target.identity.lexicalPath, this.target.identity.canonicalPath],
			[this.target.identity.canonicalPath, this.target.identity.canonicalPath],
		]) {
			const resolved = await this.budget.wait(() =>
				this.backend.resolvePathIdentity(lexical, { signal: this.budget.signal }),
			);
			if (
				// Drive-letter/case spelling may vary on Windows; POSIX equals is exact.
				!this.backend.paths.equals(resolved.canonicalPath, canonical) ||
				resolved.runtimeGeneration !== this.target.executionBinding.runtimeGeneration
			)
				fail("target_changed");
		}
		this.budget.check();
	}

	private async io<T>(work: () => Promise<T>): Promise<T> {
		return this.budget.wait(() => {
			const pending = work();
			this.pending.add(pending);
			void pending.then(
				() => this.pending.delete(pending),
				() => this.pending.delete(pending),
			);
			return pending;
		});
	}
	private async entry(path: string): Promise<BigIntStats | null> {
		try {
			return await this.io(() => fs.lstat(path, { bigint: true }));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	private async inspectAncestors(initial = false) {
		const paths = initial
			? [
					...new Set([
						...ancestorPaths(this.target.identity.canonicalPath),
						...ancestorPaths(this.target.identity.lexicalPath),
					]),
				]
			: [...this.ancestors.keys()];
		for (const path of paths) {
			const entry = await this.entry(path);
			if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) fail("unsupported_object");
			const stamp = entry ? { identity: localObjectIdentity(entry), mode: entry.mode } : null;
			if (initial) this.ancestors.set(path, stamp);
			else {
				const expected = this.ancestors.get(path);
				if (stamp?.identity !== expected?.identity || stamp?.mode !== expected?.mode)
					fail("target_changed");
			}
			if (
				path === this.target.scope.canonicalRoot &&
				stamp?.identity !== this.target.rootObjectIdentity
			)
				fail("target_changed");
		}
		if (
			this.ancestors.get(this.target.scope.canonicalRoot)?.identity !==
			this.target.rootObjectIdentity
		)
			fail("target_changed");
	}

	private async raw(state: Readonly<RestoreState>): Promise<Uint8Array | null> {
		if (state.kind === "absent") return null;
		let bytes: Uint8Array;
		try {
			bytes = await this.budget.wait(() =>
				this.readBlob(state.blob, {
					signal: this.budget.signal,
					maxBytes: state.blob.sizeBytes,
				}),
			);
		} catch (error) {
			this.budget.check();
			if (error instanceof RestoreError) throw error;
			fail("blob_invalid");
		}
		if (
			!(bytes instanceof Uint8Array) ||
			bytes.byteLength !== state.blob.sizeBytes ||
			bytes.buffer instanceof SharedArrayBuffer
		)
			fail("blob_invalid");
		// Adapter buffers are not ours. Copy bounded chunks and hash THAT copy, not a
		// mutable adapter buffer retained over the last authorization await.
		const copy = new Uint8Array(bytes.byteLength);
		const hash = createHash("sha256");
		for (let offset = 0; offset < copy.length; offset += FILE_CHANGE_LIMITS.streamChunkBytes) {
			this.budget.check();
			const end = Math.min(copy.length, offset + FILE_CHANGE_LIMITS.streamChunkBytes);
			copy.set(bytes.subarray(offset, end), offset);
			hash.update(copy.subarray(offset, end));
			await this.budget.wait(() => yieldToEventLoop());
		}
		if (hash.digest("hex") !== state.blob.digest) fail("blob_invalid");
		return copy;
	}

	private async opened(flags: number, mode?: number) {
		await this.io(async () => {
			// Assign even after timeout so close() owns a late-opened descriptor.
			// Windows has neither flag (checkAuthority requires both on POSIX). There a
			// swapped reparse point is caught by the lstat/fstat stamp comparisons.
			this.file = await fs.open(
				this.target.identity.canonicalPath,
				flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
				mode,
			);
		});
	}
	private async readOpened(): Promise<{
		observation: LocalRestoreObservation;
		stamp: BigIntStats;
	}> {
		const file = this.requireFile();
		const initial = await this.io(() => file.stat({ bigint: true }));
		regular(initial);
		const bytes = new Uint8Array(Number(initial.size));
		const hash = createHash("sha256");
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await this.io(() =>
				file.read(
					bytes,
					offset,
					Math.min(LOCAL_RESTORE_LIMITS.ioChunkBytes, bytes.length - offset),
					offset,
				),
			);
			if (!bytesRead) fail("expected_mismatch");
			hash.update(bytes.subarray(offset, offset + bytesRead));
			offset += bytesRead;
			this.bytesRead += bytesRead;
		}
		const final = await this.io(() => file.stat({ bigint: true }));
		if (!sameStamp(initial, final)) fail("expected_mismatch");
		return {
			stamp: final,
			observation: {
				state: {
					kind: "regular",
					mode: Number(final.mode & 0o7777n),
					blob: { algorithm: "sha256", digest: hash.digest("hex"), sizeBytes: bytes.length },
				},
				raw: bytes,
				objectIdentity: localObjectIdentity(final),
			},
		};
	}
	private requireFile(): fs.FileHandle {
		if (!this.file) fail("io_failed");
		return this.file;
	}
	/**
	 * Windows only: an open handle turns unlink into a delete-pending entry on
	 * volumes without POSIX delete semantics (later lstat reports EPERM, not
	 * ENOENT). Close our descriptor, then re-prove the path is still the exact
	 * object verified after the last guard. Still before dispatch.
	 */
	private async releaseBeforeDelete() {
		const stamp = this.verifiedStamp;
		if (!stamp) fail("target_changed");
		const file = this.file;
		this.file = undefined;
		if (file) await this.io(() => file.close());
		await this.inspectAncestors();
		const entry = await this.entry(this.target.identity.canonicalPath);
		if (!entry || !sameStamp(stamp, entry)) fail("target_changed");
		this.budget.check();
		this.checkAuthority();
	}
	private async verifyOpened(state: Readonly<RestoreState>, object: string) {
		const result = await this.readOpened();
		// Nothing supplied by the caller is awaited after these checks. Recheck
		// bytes/mode timestamps and fd/path alignment AFTER the last async guard.
		await this.inspectAncestors();
		const opened = await this.io(() => this.requireFile().stat({ bigint: true }));
		const entry = await this.entry(this.target.identity.canonicalPath);
		if (!entry || !sameStamp(result.stamp, opened) || !sameStamp(opened, entry))
			fail("target_changed");
		this.verifiedStamp = entry;
		this.observation = result.observation;
		if (
			!fileChangeStatesEqual(state, result.observation.state) ||
			result.observation.objectIdentity !== object
		)
			fail("expected_mismatch");
		this.budget.check();
		return result;
	}
	private async verifyAbsent() {
		await this.inspectAncestors();
		if (await this.entry(this.target.identity.canonicalPath)) fail("expected_mismatch");
		this.observation = { state: { kind: "absent" }, raw: null, objectIdentity: null };
		this.budget.check();
	}
	private async permissions(byteChange: boolean, noChange: boolean) {
		const { expected, desired, identity } = this.target;
		if (expected.kind === "regular") {
			// An already-open fd retains its original permissions. Recheck path ACLs
			// after authorization, then recheck fd/path identity and bytes afterward.
			const write = desired.kind === "regular" && byteChange;
			await this.io(() =>
				fs.access(identity.canonicalPath, constants.R_OK | (write ? constants.W_OK : 0)),
			);
			if (desired.kind === "regular" && expected.mode !== desired.mode) {
				const stat = await this.io(() => this.requireFile().stat({ bigint: true }));
				if (
					typeof process.geteuid === "function" &&
					process.geteuid() !== 0 &&
					BigInt(process.geteuid()) !== stat.uid
				)
					fail("permission_denied");
			}
		}
		if (!noChange && (expected.kind === "absent" || desired.kind === "absent")) {
			const parent = ancestorPaths(identity.canonicalPath)
				.reverse()
				.find((path) => this.ancestors.get(path));
			if (!parent) fail("target_changed");
			const mode = this.ancestors.get(parent)?.mode ?? 0n;
			// Windows directory modes are synthetic and carry no search bit. The
			// write/delete ACL is only enforced by the actual syscall, before which
			// a denial is still a clean not_dispatched failure.
			if (windowsSemantics()) {
				if (!(mode & 0o222n)) fail("permission_denied");
				await this.io(() => fs.access(parent, constants.W_OK));
			} else {
				if (!(mode & 0o222n) || !(mode & 0o111n)) fail("permission_denied");
				await this.io(() => fs.access(parent, constants.W_OK | constants.X_OK));
			}
		}
	}
	private dispatch() {
		this.budget.check();
		this.checkAuthority();
		if (!this.dispatched) {
			const returned: unknown = this.onDispatch(this.context("before_dispatch"));
			if (returned !== undefined) {
				// Reject a mistakenly async barrier without writing. Its lifetime still
				// belongs to whenSettled, even if it cannot honor the aborted signal.
				if (returned instanceof Promise) this.budget.track(returned);
				fail("guard_failed");
			}
			this.budget.check();
			this.checkAuthority();
			this.lease.assertMutationPending(this.target.mutationId);
			this.dispatched = true;
		}
		// No inference that a thrown mutating syscall was harmless.
		this.observation = null;
	}

	async execute(preflightOnly: boolean): Promise<"verified" | "no_change" | "preflight_verified"> {
		const { expected, desired, expectedObjectIdentity, identity } = this.target;
		await this.guard("preflight");
		await this.inspectAncestors(true);
		const missing = [...this.ancestors].filter(([, stamp]) => !stamp).map(([path]) => path);
		if (missing.length > LOCAL_RESTORE_LIMITS.createdParents) fail("budget_exceeded");
		for (const path of missing) {
			const within = relative(this.target.scope.canonicalRoot, path);
			if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
				fail("target_changed");
		}
		if (missing.length && desired.kind !== "absent" && !this.target.createParents)
			fail("target_changed");
		// Validate BOTH sides: deleted/mode-only restores also need their pinned before.
		await this.raw(expected);
		const next = await this.raw(desired);
		const noChange = fileChangeStatesEqual(expected, desired);
		const byteChange =
			expected.kind !== "regular" ||
			desired.kind !== "regular" ||
			expected.blob.digest !== desired.blob.digest ||
			expected.blob.sizeBytes !== desired.blob.sizeBytes;
		// Windows chmod can only toggle the read-only attribute (the write bits of the
		// synthesized mode). Any other mode difference is unrepresentable: refuse it
		// BEFORE dispatch instead of discovering the mismatch in post-verification.
		const modeChange =
			expected.kind === "regular" && desired.kind === "regular" && expected.mode !== desired.mode;
		if (
			windowsSemantics() &&
			desired.kind === "regular" &&
			(expected.kind === "regular"
				? ((expected.mode ^ desired.mode) & ~0o222) !== 0
				: desired.mode !== WINDOWS_WRITABLE_MODE && desired.mode !== WINDOWS_READ_ONLY_MODE)
		)
			fail("unsupported_object");
		let object = expectedObjectIdentity;
		if (expected.kind === "regular") {
			const entry = await this.entry(identity.canonicalPath);
			if (!entry) fail("expected_mismatch");
			regular(entry);
			if (!(entry.mode & 0o444n)) fail("permission_denied");
			if (localObjectIdentity(entry) !== expectedObjectIdentity) fail("target_changed");
			if (desired.kind === "regular" && byteChange && (entry.mode & 0o222n) === 0n)
				fail("permission_denied");
			// Windows refuses to delete a read-only file (EPERM) where POSIX only
			// consults the parent directory, and a read-only file cannot be opened for
			// the write-attribute access fchmod needs. Refuse both before dispatch
			// rather than turning an unverified attribute write into an uncertain result.
			if (
				windowsSemantics() &&
				(entry.mode & 0o222n) === 0n &&
				(desired.kind === "absent" || modeChange)
			)
				fail("permission_denied");
			if (
				desired.kind === "regular" &&
				expected.mode !== desired.mode &&
				typeof process.geteuid === "function" &&
				process.geteuid() !== 0 &&
				BigInt(process.geteuid()) !== entry.uid
			)
				fail("permission_denied");
			// Windows fchmod needs a handle with write-attribute access; a read-only
			// handle fails AFTER dispatch. Open for writing when the mode changes.
			const writable =
				desired.kind === "regular" && (byteChange || (windowsSemantics() && modeChange));
			await this.opened(writable ? constants.O_RDWR : constants.O_RDONLY);
			await this.verifyOpened(expected, expectedObjectIdentity as string);
		} else await this.verifyAbsent();
		await this.permissions(byteChange, noChange);
		await this.guard("before_dispatch");
		await this.permissions(byteChange, noChange);
		if (expected.kind === "regular")
			await this.verifyOpened(expected, expectedObjectIdentity as string);
		else await this.verifyAbsent();
		if (preflightOnly) {
			this.budget.check();
			this.checkAuthority();
			return "preflight_verified";
		}
		if (noChange) return "no_change"; // Positive THIS-invocation no syscall, not old execution confirmation.

		if (desired.kind === "absent") {
			if (windowsSemantics() && expected.kind === "regular") await this.releaseBeforeDelete();
			this.dispatch();
			await this.io(() => fs.unlink(identity.canonicalPath)); // Single entry only, never rm/recursive.
			await this.guard("after_dispatch");
			await this.verifyAbsent();
			return "verified";
		}
		if (expected.kind === "absent") {
			for (const path of missing) {
				// The first iteration follows the last guard above; subsequent ones also
				// reauthorize after the previous directory mutation. Never mkdir recursive.
				if (this.dispatched) {
					await this.guard("before_dispatch");
					await this.permissions(byteChange, noChange);
					await this.verifyAbsent();
				}
				this.dispatch();
				await this.io(() => fs.mkdir(path, { mode: 0o700 }));
				const created = await this.entry(path);
				if (!created?.isDirectory() || created.isSymbolicLink()) fail("target_changed");
				this.ancestors.set(path, { identity: localObjectIdentity(created), mode: created.mode });
			}
			if (missing.length) {
				await this.guard("before_dispatch");
				await this.permissions(byteChange, noChange);
				await this.verifyAbsent();
			}
			this.dispatch();
			await this.opened(constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
			// O_EXCL never overwrites a later-created file. Further writes still need
			// the newly opened descriptor to match the path after authorization.
			const created = await this.io(() => this.requireFile().stat({ bigint: true }));
			regular(created);
			object = localObjectIdentity(created);
			await this.guard("before_dispatch");
			await this.inspectAncestors();
			const opened = await this.io(() => this.requireFile().stat({ bigint: true }));
			const path = await this.entry(identity.canonicalPath);
			if (!path || !sameStamp(created, opened) || !sameStamp(opened, path) || opened.size !== 0n)
				fail("target_changed");
		}
		const file = this.requireFile();
		if (!object) fail("target_changed");
		if (byteChange) {
			this.dispatch();
			if (expected.kind === "regular") await this.io(() => file.truncate(0));
			let offset = 0;
			while (next && offset < next.length) {
				const { bytesWritten } = await this.io(() =>
					file.write(
						next,
						offset,
						Math.min(LOCAL_RESTORE_LIMITS.ioChunkBytes, next.length - offset),
						offset,
					),
				);
				if (!bytesWritten) fail("io_failed");
				offset += bytesWritten;
				this.bytesWritten += bytesWritten;
			}
		}
		// Mode-only uses the SAME descriptor as the last guard, never chmod(path).
		this.dispatch();
		// Windows: only touch the read-only attribute when it actually differs, so an
		// unchanged mode never adds an attribute write after the byte mutation.
		const currentMode = windowsSemantics()
			? Number((await this.io(() => file.stat({ bigint: true }))).mode & 0o7777n)
			: null;
		if (currentMode !== desired.mode) await this.io(() => file.chmod(desired.mode));
		await this.io(() => file.sync());
		await this.guard("after_dispatch");
		await this.verifyOpened(desired, object);
		return "verified";
	}

	close(): Promise<void> {
		if (this.cleanup) return this.cleanup;
		// execute() has unwound: no rejected wait can resume our mutation sequence.
		// Drain every outstanding call, including non-cancellable guards/blob reads,
		// before closing a descriptor possibly assigned by a late open. Taking this
		// snapshot BEFORE waiting on cleanup prevents a self-referential promise.
		const cleanup = Promise.allSettled([...this.budget.pending]).then(async () => {
			if (this.file) await this.file.close();
		});
		this.cleanup = cleanup;
		this.pending.add(cleanup);
		// Observe rejection here so returning after a timeout does not create an
		// unhandled rejection, but expose the ORIGINAL rejecting promise to caller.
		void cleanup.then(
			() => this.pending.delete(cleanup),
			() => this.pending.delete(cleanup),
		);
		return cleanup;
	}
}

class RestoreBudget {
	/** Calls still executing after their cancellable wait has returned. */
	readonly pending = new Set<Promise<unknown>>();
	private readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	private readonly deadline: number;
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly abort = () => this.controller.abort(new RestoreError("cancelled"));
	constructor(
		private readonly external: AbortSignal,
		timeoutMs: number,
	) {
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > LOCAL_RESTORE_LIMITS.maxTimeoutMs
		)
			fail("invalid_input");
		this.deadline = performance.now() + timeoutMs;
		this.timer = setTimeout(() => this.controller.abort(new RestoreError("timeout")), timeoutMs);
		external.addEventListener("abort", this.abort, { once: true });
		if (external.aborted) this.abort();
	}
	check() {
		if (!this.signal.aborted && performance.now() >= this.deadline)
			this.controller.abort(new RestoreError("timeout"));
		this.signal.throwIfAborted();
	}
	track<T>(pending: Promise<T>): Promise<T> {
		this.pending.add(pending);
		void pending.then(
			() => this.pending.delete(pending),
			() => this.pending.delete(pending),
		);
		return pending;
	}
	async wait<T>(work: () => Promise<T>): Promise<T> {
		this.check();
		let onAbort: () => void = () => {};
		try {
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(this.signal.reason);
				this.signal.addEventListener("abort", onAbort, { once: true });
			});
			const result = await Promise.race([this.track(work()), aborted]);
			this.check();
			return result;
		} finally {
			this.signal.removeEventListener("abort", onAbort);
		}
	}
	dispose() {
		clearTimeout(this.timer);
		this.external.removeEventListener("abort", this.abort);
	}
}

function freezeDescriptor(input: LocalRestoreDescriptor): FrozenDescriptor {
	string(input.mutationId, 256);
	if (typeof input.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.requestDigest))
		fail("invalid_input");
	string(input.rootObjectIdentity, 256);
	const expected = freezeState(input.expected);
	const desired = freezeState(input.desired);
	if (expected.kind === "regular") string(input.expectedObjectIdentity, 256);
	else if (input.expectedObjectIdentity !== null) fail("invalid_input");
	const scope = Object.freeze({
		id: input.scope.id,
		sourceInstanceId: input.scope.sourceInstanceId,
		deviceId: input.scope.deviceId,
		workspaceInstanceId: input.scope.workspaceInstanceId,
		canonicalRoot: input.scope.canonicalRoot,
		pathFlavor: input.scope.pathFlavor,
	});
	const identity = Object.freeze({
		sourceInstanceId: input.identity.sourceInstanceId,
		deviceId: input.identity.deviceId,
		workspaceInstanceId: input.identity.workspaceInstanceId,
		scopeId: input.identity.scopeId,
		pathFlavor: input.identity.pathFlavor,
		objectRole: input.identity.objectRole,
		canonicalPath: input.identity.canonicalPath,
		lexicalPath: input.identity.lexicalPath,
		displayPath: input.identity.displayPath,
	});
	for (const value of [
		scope.id,
		scope.sourceInstanceId,
		scope.deviceId,
		scope.workspaceInstanceId,
		identity.sourceInstanceId,
		identity.deviceId,
		identity.workspaceInstanceId,
		identity.scopeId,
	])
		string(value, 256);
	for (const path of [scope.canonicalRoot, identity.canonicalPath, identity.lexicalPath]) {
		string(path, FILE_CHANGE_LIMITS.metadataBytes);
		if (!isAbsolute(path) || normalize(path) !== path) fail("invalid_input");
		ancestorPaths(path);
	}
	string(identity.displayPath, FILE_CHANGE_LIMITS.metadataBytes);
	const rebuilt = createFileChangeIdentity(scope, identity);
	if (
		rebuilt.scopeId !== identity.scopeId ||
		fileChangeIdentityKey(rebuilt) !== fileChangeIdentityKey(identity)
	)
		fail("target_changed");
	const binding = input.executionBinding;
	const executionBinding = Object.freeze({
		deviceId: binding.deviceId,
		runtimeEpoch: binding.runtimeEpoch,
		runtimeGeneration: binding.runtimeGeneration,
		fencingToken: binding.fencingToken,
	});
	string(binding.deviceId, 256);
	string(binding.runtimeEpoch, 256);
	if (
		binding.deviceId !== identity.deviceId ||
		!fileChangeExecutionBindingMatches(binding, binding)
	)
		fail("invalid_input");
	if (input.createParents !== undefined && typeof input.createParents !== "boolean")
		fail("invalid_input");
	const descriptor = Object.freeze({
		mutationId: input.mutationId,
		requestDigest: input.requestDigest,
		identity,
		scope,
		executionBinding,
		rootObjectIdentity: input.rootObjectIdentity,
		expectedObjectIdentity: input.expectedObjectIdentity,
		expected,
		desired,
		createParents: input.createParents === true,
	});
	if (Buffer.byteLength(JSON.stringify(descriptor)) > FILE_CHANGE_LIMITS.metadataBytes)
		fail("budget_exceeded");
	return descriptor;
}
function freezeState(state: KnownFileChangeState): Readonly<RestoreState> {
	if (state?.kind === "absent") return Object.freeze({ kind: "absent" });
	if (state?.kind !== "regular") fail("unsupported_object");
	if (!Number.isInteger(state.mode) || state.mode === null || state.mode < 0 || state.mode > 0o7777)
		fail("invalid_input");
	const blob = state.blob;
	if (
		!blob ||
		blob.algorithm !== "sha256" ||
		typeof blob.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(blob.digest) ||
		!Number.isSafeInteger(blob.sizeBytes) ||
		blob.sizeBytes < 0
	)
		fail("blob_invalid");
	if (blob.sizeBytes > FILE_CHANGE_LIMITS.blobBytes) fail("budget_exceeded");
	return Object.freeze({
		kind: "regular",
		mode: state.mode,
		blob: Object.freeze({ algorithm: "sha256", digest: blob.digest, sizeBytes: blob.sizeBytes }),
	});
}
function string(value: unknown, max: number): asserts value is string {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\0") ||
		value.length > max ||
		Buffer.byteLength(value) > max
	)
		fail("invalid_input");
}
function ancestorPaths(path: string): string[] {
	const result: string[] = [];
	let current = dirname(path);
	while (true) {
		result.push(current);
		if (result.length > LOCAL_RESTORE_LIMITS.pathComponents) fail("budget_exceeded");
		const parent = dirname(current);
		if (parent === current) return result.reverse();
		current = parent;
	}
}
function regular(stat: BigIntStats) {
	if (!stat.isFile() || stat.nlink !== 1n || stat.isSymbolicLink()) fail("unsupported_object");
	if (stat.size < 0n || stat.size > BigInt(FILE_CHANGE_LIMITS.blobBytes)) fail("budget_exceeded");
}
function sameStamp(a: BigIntStats, b: BigIntStats) {
	regular(a);
	regular(b);
	return (
		localObjectIdentity(a) === localObjectIdentity(b) &&
		a.size === b.size &&
		a.mode === b.mode &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}
function failureCode(error: unknown): LocalRestoreFailure {
	if (error instanceof RestoreError) return error.code;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	// Sharing violations (another process holds the file open without sharing, as
	// Windows antivirus/indexers/editors often do). The reason only names the cause:
	// result.status still says whether a mutation was dispatched, so a busy error
	// after dispatch remains uncertain_after_dispatch and never looks retry-safe.
	if (code === "EBUSY" || code === "ETXTBSY") return "io_busy";
	if (code === "EACCES" || code === "EPERM") return "permission_denied";
	if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") return "unsupported_object";
	return "io_failed";
}
