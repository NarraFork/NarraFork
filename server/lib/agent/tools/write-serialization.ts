/**
 * Serialization of short tool file-write windows within one local workspace.
 * Write/Edit hold this lock while reading, modifying and writing. Bash never
 * takes it: arbitrary shell processes have no bounded file-write window, and
 * their rollback exclusion is handled separately by workspace activity leases.
 * Remote devices are excluded because their paths are not this server's files.
 */
import { normalizePathForComparison } from "@server/lib/platform-path";
import { worktreeWriteLock } from "../../async-mutex";
import type { ExecutionBackend } from "../execution/backend";
import { LOCAL_DEVICE_ID } from "../execution/backend";

/** Lock key for a workspace path on the local device. */
export function writeLockKey(workspacePath: string): string {
	return normalizePathForComparison(workspacePath);
}

/**
 * Run a short, local file-write window under the workspace lock.
 *
 * Non-local backends run `fn` directly, since the lock only means something for
 * paths on this server.
 */
export async function withWorkspaceWriteLock<T>(
	backend: Pick<ExecutionBackend, "deviceId">,
	workspacePath: string,
	fn: () => Promise<T>,
	/** Admission only: aborting after entry never releases a running write window. */
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	if (backend.deviceId !== LOCAL_DEVICE_ID) return fn();
	const key = writeLockKey(workspacePath);
	if (!signal) return worktreeWriteLock.acquire(key, fn);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void worktreeWriteLock
			.acquire(key, async () => {
				signal.removeEventListener("abort", onAbort);
				// A cancelled waiter retains its FIFO slot until its predecessor ends.
				// It then drains without IO; never release the predecessor's lock early.
				signal.throwIfAborted();
				return fn();
			})
			.then(resolve, reject);
	});
}

/** Legacy call shape retained for callers loaded before Bash stopped locking. */
export interface BashSerializationInput {
	cwd: string;
	filePaths: readonly string[];
	hasWriteOperation: boolean;
	allReadOnly: boolean;
	commandNames?: readonly string[];
	commandTokens?: readonly string[];
	isBackground: boolean;
}

export interface BashWriteLockOutcome<T> {
	value: T;
	/** Always false: Bash does not acquire a workspace write lock. */
	serialized: boolean;
}

/**
 * No-lock compatibility layer for existing callers. Neither command analysis nor
 * a lock attempt is performed, even for short mutations. New Bash execution paths
 * should run their process lifecycle directly and retain their activity lease.
 */
export async function withBashWriteLock<T>(
	_backend: Pick<ExecutionBackend, "deviceId">,
	_input: BashSerializationInput,
	fn: () => Promise<T>,
	_timeoutMs?: number,
): Promise<BashWriteLockOutcome<T>> {
	return { value: await fn(), serialized: false };
}
