/**
 * Serialization of tool file writes within one workspace.
 *
 * Several narrators (and their subagents) can share a single worktree, and until
 * now their file writes ran fully concurrently. That makes per-narrator
 * attribution unreliable: a tool's before/after workspace snapshots can enclose
 * another narrator's writes, so its recorded change set is not actually its own.
 *
 * The lock is deliberately scoped to the *write window* rather than the tool call:
 *
 *   - Write/Edit read, modify and write in milliseconds, so they hold it outright.
 *   - Bash can legitimately run for hours (background default 5h, max 24h), so it
 *     never holds the lock for its execution. It makes a bounded attempt and, on
 *     timeout, proceeds unserialized — the worst case is today's behaviour, never
 *     a stalled session.
 *
 * Remote devices are excluded: their paths are not this server's filesystem, so a
 * local mutex would not be guarding anything real.
 */
import { resolve as nodeResolve } from "node:path";
import { normalizePathForComparison } from "@server/lib/platform-path";
import { worktreeWriteLock } from "../../async-mutex";
import { logger } from "../../logger";
import type { ExecutionBackend } from "../execution/backend";
import { LOCAL_DEVICE_ID } from "../execution/backend";

/**
 * How long a Bash call waits for the write lock before running unserialized.
 *
 * Sized to cover the common short mutations (single-file `sed -i`, formatting a
 * small directory) without producing a stall a user would notice. A command that
 * genuinely holds the lock longer than this is exactly the case we would rather
 * not serialize.
 */
export const BASH_WRITE_LOCK_TIMEOUT_MS = 2000;

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

export interface BashSerializationDecision {
	/** Whether this command should attempt to take the write lock. */
	shouldSerialize: boolean;
	/** Human-readable reason, for logs and the attribution record. */
	reason: string;
}

export interface BashSerializationInput {
	/** Resolved working directory of the command. */
	cwd: string;
	/** Absolute paths the command explicitly targets, from bash-analyze. */
	filePaths: readonly string[];
	/** Whether bash-analyze recognised a write operation. */
	hasWriteOperation: boolean;
	/** Whether bash-analyze proved every sub-command read-only. */
	allReadOnly: boolean;
	/** Base names of every sub-command, used to recognise short mutations. */
	commandNames?: readonly string[];
	/** All argument tokens across sub-commands, used to verify the write target. */
	commandTokens?: readonly string[];
	/** Background commands are never serialized. */
	isBackground: boolean;
}

/**
 * Classify a shell command for serialization using the existing shell analyzer.
 *
 * Analysis failure degrades to "do not serialize" rather than propagating: this is
 * an optimization of attribution accuracy, and it must never be able to fail a
 * command that would otherwise have run.
 */
export async function resolveBashSerializationInput(params: {
	command: string;
	cwd: string;
	isBackground: boolean;
	isChapter: boolean;
}): Promise<BashSerializationInput> {
	const fallback: BashSerializationInput = {
		cwd: params.cwd,
		filePaths: [],
		hasWriteOperation: false,
		allReadOnly: false,
		isBackground: params.isBackground,
	};
	if (params.isBackground) return fallback;

	try {
		const { analyzeShellCommand } = await import("../bash-analyze");
		const { detectShell } = await import("../shell");
		const analysis = await analyzeShellCommand(
			params.command,
			params.cwd,
			detectShell().type,
			params.isChapter,
		);
		return {
			cwd: params.cwd,
			filePaths: analysis.filePaths,
			hasWriteOperation: analysis.hasWriteOperation,
			allReadOnly: analysis.allReadOnly,
			commandNames: analysis.commands
				.map((entry) => (entry.tokens[0] ? commandBaseName(entry.tokens[0]) : ""))
				.filter(Boolean),
			commandTokens: analysis.commands.flatMap((entry) => entry.tokens.slice(1)),
			isBackground: false,
		};
	} catch (error) {
		logger.debug("Shell analysis for write serialization failed", {
			cwd: params.cwd,
			error: String(error),
		});
		return fallback;
	}
}

/**
 * Commands whose write window is inherently short and bounded by their arguments.
 *
 * `hasWriteOperation` intentionally only covers checker-tool write flags (see the
 * note in bash-analyze), so in-place coreutils mutations are not flagged by it and
 * `sed -i` extracts no `filePaths` at all. Naming them explicitly keeps the policy
 * predictable: this list is exactly "commands we expect to finish in milliseconds",
 * which is the only class worth briefly serializing.
 *
 * Script runners (`bun run build`, `make`) are deliberately absent — their runtime
 * is unbounded, so holding the write lock across them would make every other
 * command on the worktree pay the full wait deadline for no benefit.
 */
const SHORT_MUTATION_COMMANDS = new Set([
	"sed",
	"awk",
	"perl",
	"rm",
	"rmdir",
	"mv",
	"cp",
	"touch",
	"mkdir",
	"ln",
	"chmod",
	"chown",
	"truncate",
	"tee",
	"install",
]);

/** Whether `candidate` is inside `root` (or is `root`). */
function isInside(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	if (normalizedCandidate === normalizedRoot) return true;
	return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/** Last path segment of a command token, so `/usr/bin/sed` matches `sed`. */
function commandBaseName(token: string): string {
	const normalized = token.split(/[\\/]/).pop() ?? token;
	return normalized.toLowerCase();
}

/**
 * Decide whether a Bash call is a good candidate for brief serialization.
 *
 * Qualifies short, targeted mutations — `sed -i src/a.ts`, `biome check --write
 * server/`, `rm src/old.ts`. Commands whose writes cannot be bounded from their
 * arguments are left fully concurrent on purpose.
 */
export function decideBashSerialization(input: BashSerializationInput): BashSerializationDecision {
	if (input.isBackground) {
		return { shouldSerialize: false, reason: "background command" };
	}
	if (input.allReadOnly) {
		return { shouldSerialize: false, reason: "read-only command" };
	}

	// Any explicitly named target outside the workspace disqualifies the call: the
	// lock is scoped to this worktree and would not be guarding the real target.
	if (input.filePaths.some((path) => !isInside(input.cwd, path))) {
		return { shouldSerialize: false, reason: "targets outside the workspace" };
	}

	// A recognised write flag (biome/prettier `--write`, rm/mv/cp/touch/mkdir).
	if (input.hasWriteOperation) {
		return { shouldSerialize: true, reason: "recognised write operation" };
	}

	// Otherwise only the short-mutation list qualifies, and every sub-command must
	// be on it — one unbounded command in a chain makes the whole chain unbounded.
	const commandNames = input.commandNames ?? [];
	if (
		commandNames.length === 0 ||
		!commandNames.every((name) => SHORT_MUTATION_COMMANDS.has(name))
	) {
		return { shouldSerialize: false, reason: "unbounded or unrecognised command" };
	}

	// These commands take their targets as bare arguments, which the analyzer does
	// not extract into `filePaths` (it only knows the flag grammar of specific
	// tools). So require that no argument points outside the workspace: a token that
	// escapes it means the write may land elsewhere, and this lock would not guard it.
	if (input.filePaths.length === 0 && hasOutOfWorkspaceToken(input)) {
		return { shouldSerialize: false, reason: "targets outside the workspace" };
	}

	return { shouldSerialize: true, reason: "short in-place mutation" };
}

/**
 * Whether any path-like argument points outside the workspace.
 *
 * Only tokens that look like paths are considered — a `sed` script (`s/a/b/`) or a
 * `chmod` mode (`644`) must not be mistaken for one. The test is conservative in
 * the safe direction: an unrecognised token is simply not treated as a path, and
 * anything that does look like a path must resolve inside the workspace.
 */
function hasOutOfWorkspaceToken(input: BashSerializationInput): boolean {
	for (const token of input.commandTokens ?? []) {
		if (!token || token.startsWith("-")) continue;
		const isAbsolute = token.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(token);
		const climbsOut = token === ".." || token.startsWith("../") || token.startsWith("..\\");
		if (!isAbsolute && !climbsOut) continue;
		if (!isInside(input.cwd, nodeResolve(input.cwd, token))) return true;
	}
	return false;
}

export interface BashWriteLockOutcome<T> {
	value: T;
	/** True when the body ran while holding the workspace write lock. */
	serialized: boolean;
}

/**
 * Run a Bash command body, serialized when it qualifies and the lock is obtainable.
 *
 * Reports whether serialization actually happened so callers can record how
 * trustworthy this call's attribution is.
 */
export async function withBashWriteLock<T>(
	backend: Pick<ExecutionBackend, "deviceId">,
	input: BashSerializationInput,
	fn: () => Promise<T>,
	timeoutMs = BASH_WRITE_LOCK_TIMEOUT_MS,
): Promise<BashWriteLockOutcome<T>> {
	if (backend.deviceId !== LOCAL_DEVICE_ID) {
		return { value: await fn(), serialized: false };
	}
	const decision = decideBashSerialization(input);
	if (!decision.shouldSerialize) {
		return { value: await fn(), serialized: false };
	}

	const attempt = await worktreeWriteLock.tryAcquire(writeLockKey(input.cwd), fn, timeoutMs);
	if (attempt.acquired) return { value: attempt.value, serialized: true };

	// Another writer held the lock past the deadline. Proceed anyway: blocking a
	// narrator is worse than a less precisely attributed change set.
	logger.debug("Bash write lock not acquired; running unserialized", {
		cwd: input.cwd,
		waitedMs: attempt.waitedMs,
	});
	return { value: await fn(), serialized: false };
}
