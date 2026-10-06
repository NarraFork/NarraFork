/**
 * Execution backend abstraction.
 *
 * Tools (Read/Write/Edit/Glob/Grep/Bash) historically operated directly on the
 * server's local filesystem via Bun/Node `fs`/`spawn`. To support routing those
 * operations to a *remote executor device*, we introduce an `ExecutionBackend`
 * seam: a small set of **atomic primitives** (file IO, glob, grep, process
 * execution, git diagnostics) that a backend implements.
 *
 * Design principle: keep complex, provider-agnostic logic (Edit's replacer
 * chain, Read's line-streaming/caps, Bash's watchdog/live-output/timeout
 * orchestration, snapshots, encoding detection) in the TypeScript tool layer.
 * The backend only exposes the raw IO seams those tools sit on top of. This
 * keeps the remote executor (Go) minimal — it just does IO + exec.
 *
 * `LocalBackend` is the default; it wraps the exact same Bun/Node calls the
 * tools used before, so behaviour on the local machine is unchanged.
 */

import type { GitWorkspaceRequest, GitWorkspaceResult } from "./git-workspace-rpc";
import type { PathFlavor, TargetPathSemantics } from "./path-semantics";

export type { PathFlavor, TargetPathSemantics } from "./path-semantics";

/** Identifier for the local (server) execution target. */
export const LOCAL_DEVICE_ID = "local";

/**
 * Lightweight, session-facing summary of a device that a narrator may route
 * tool calls to. Built by the session assembly layer from the DB row + live
 * connection state. Used for dynamic tool schemas (the `device` enum) and for
 * the "Execution Devices" system-prompt section.
 */
export interface DeviceSummary {
	/** Stable device id (also the value passed as the tool `device` parameter). */
	id: string;
	/** Human-friendly name shown to the model. */
	name: string;
	/** Short slug the model can also use to reference the device. */
	slug: string;
	/** Optional usage description injected into the prompt. */
	description?: string | null;
	/** Whether the device currently has a live connection. */
	online: boolean;
	/** Platform descriptor reported at handshake, when known. */
	platform?: DevicePlatform;
	/** Default working directory on the device, when known. */
	defaultCwd?: string | null;
	/**
	 * True when the device is private to the acting user. Drives the default
	 * injection mode ("my own machine should just be there") without granting any
	 * additional access — authorization already happened upstream.
	 */
	ownedByActingUser?: boolean;
	/**
	 * Project axis of the device record. Drives the default injection tier: only an
	 * administrator can register a `"global"` device, which is what makes "present
	 * in every session without being asked for" an administrative decision.
	 *
	 * Required rather than optional on purpose. An optional field would silently
	 * read as `undefined` at any construction site that forgot it, and since
	 * `undefined` is treated as project-scoped, the device would quietly stop being
	 * injected with no type error to point at the omission.
	 */
	scope: "global" | "project";
}

/** Platform descriptor a backend reports (used for prompt injection + path handling). */
export interface DevicePlatform {
	/** "linux" | "darwin" | "windows" */
	os: string;
	/** "x64" | "arm64" | ... */
	arch: string;
	/** Absolute path to the shell used for command execution. */
	shellPath?: string;
	/** Whether this shell wraps commands as a login shell (Git Bash on Windows). */
	shellLoginWrap?: boolean;
	/** "bash" | "powershell" | "cmd" */
	shellType?: string;
}

/** Minimal file stat used by tools to distinguish files/dirs and size. */
export interface FileStat {
	isDirectory: boolean;
	isFile: boolean;
	/** Size in bytes (0 for directories). */
	size: number;
	/** Canonical path after resolving parent symlinks/junctions and the final entry. */
	resolvedPath?: string;
}

/** Stable identity for one target path at a specific backend runtime generation. */
export interface PathIdentity {
	/** Absolute path after target-grammar lexical normalization. */
	lexicalPath: string;
	/** Canonical path after resolving existing ancestors and symlinks/junctions. */
	canonicalPath: string;
	/** Whether the final path existed when the identity was resolved. */
	exists: boolean;
	/** Backend runtime generation that produced this identity. */
	runtimeGeneration: number;
}

/** A directory entry returned by listDir. */
export interface DirEntry {
	name: string;
	/**
	 * True for a real directory AND for a symlink whose target is a directory.
	 * Raw `readdir`/`ReadDir` types come from lstat, where a symlinked directory
	 * reports false; backends resolve the link so callers see the effective type.
	 */
	isDirectory: boolean;
	/**
	 * The entry is a symbolic link. Optional because older remote executors do not
	 * report it; absent means "unknown", not "not a link".
	 */
	isSymlink?: boolean;
}

/** Options for reading raw file bytes. */
export interface ReadBytesOptions {
	/** Maximum number of bytes to return. Backend truncates beyond this. */
	maxBytes?: number;
	/**
	 * Canonical path identity previously returned by statFile. Backends must verify
	 * the opened file still has this identity before returning any bytes. Remote
	 * backends may require a negotiated atomic-read capability.
	 */
	expectedResolvedPath?: string;
	/** Abort signal to cancel a long read. */
	signal?: AbortSignal;
	/** Require a bounded cancellable read on remote executors (fs.read.bounded.v1). */
	timeoutMs?: number;
}

/** Result of reading raw file bytes. */
export interface WriteBytesOptions {
	/** Canonical create/existing path authorized before the write. */
	expectedResolvedPath?: string;
}

export interface ConditionalWriteBytesOptions {
	expectedBytes: Uint8Array | null;
	expectedResolvedPath: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ReadBytesResult {
	bytes: Uint8Array;
	/** True when the read was cut off at maxBytes. */
	truncated: boolean;
	/** Total file size in bytes (may exceed bytes.length when truncated). */
	totalSize: number;
	/** Canonical path identity verified for the opened file, when available. */
	resolvedPath?: string;
}

/** Read a complete file or fail closed when the backend only returned a prefix. */
export async function readCompleteFileBytes(
	backend: Pick<ExecutionBackend, "deviceId" | "readFileBytes">,
	filePath: string,
	opts?: ReadBytesOptions,
): Promise<ReadBytesResult> {
	const result = await backend.readFileBytes(filePath, opts);
	if (result.truncated) {
		throw new Error(
			`Complete file read required, but device ${backend.deviceId} truncated ${filePath} ` +
				`at ${result.bytes.byteLength} of ${result.totalSize} bytes.`,
		);
	}
	return result;
}

/** Cancellation/deadline for metadata RPCs used by interactive file navigation. */
export interface FileMetadataOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Array-compatible search results; old tool callers may ignore the optional marker. */
export interface GlobMatches extends Array<string> {
	truncated?: boolean;
}

/** Options for glob scanning. */
export interface GlobOptions {
	/** Base directory to scan from. */
	cwd: string;
	/** Match dotfiles/dot-directories. */
	dot?: boolean;
	/** Maximum results to return. */
	maxResults?: number;
	/** Maximum JSON-encoded result bytes; limits collection, not just the response. */
	maxBytes?: number;
	/** Hard scan deadline, including scans with no matching entries. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Include directory candidates for navigation, never recursive attachment. */
	includeDirectories?: boolean;
	/** Optional literal, case-insensitive relative-path filter (not glob syntax). */
	query?: string;
}

/** Parameters for a grep (ripgrep) search. Mirrors the Grep tool surface. */
export interface GrepParams {
	pattern: string;
	/** Absolute path to search (file or directory). */
	searchPath: string;
	/** Working directory for the search process. */
	cwd: string;
	glob?: string;
	outputMode: "content" | "files_with_matches" | "count";
	beforeContext?: number;
	afterContext?: number;
	contextLines?: number;
	showLineNumbers: boolean;
	caseInsensitive?: boolean;
	fileType?: string;
	multiline?: boolean;
	/** When true, search raw bytes (--encoding none) for legacy-encoding files. */
	rawBytes?: boolean;
	/** Max stdout bytes before the search process is killed + result truncated. */
	maxBytes: number;
	/** Hard timeout in ms. */
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Result of a grep search — raw stdout bytes + process status. */
export interface GrepResult {
	/** Raw stdout bytes (undecoded, so callers can charset-detect). */
	stdoutBytes: Uint8Array;
	stderr: string;
	exitCode: number;
	/** stdout was cut off at maxBytes. */
	truncatedByBytes: boolean;
	/** Process was killed by the timeout. */
	timedOut: boolean;
	/** ripgrep binary was unavailable on this backend. */
	unavailable?: boolean;
	/** ripgrep was missing so the search fell back to the system `grep` (degraded capability). */
	usedFallback?: boolean;
}

/** Parameters for starting a command process. */
export interface ExecParams {
	command: string;
	cwd: string;
	/** Whether to source shell profile (fresh-env / login shell). */
	freshEnv?: boolean;
	/** Environment overrides merged over the backend's base env. */
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

/**
 * A running command process. Orchestration (watchdog, timeout, live-output
 * throttling, kill-tree) is handled by the Bash tool on top of this handle.
 * The handle only exposes streaming output + lifecycle control.
 */
export interface ExecHandle {
	/** OS pid, when available (local backend). Remote backends may omit it. */
	readonly pid?: number;
	/** Called for every stdout/stderr chunk (raw bytes). */
	onData(cb: (chunk: Uint8Array) => void): void;
	/** Resolves with the exit code when the process exits. */
	readonly exited: Promise<number | null>;
	/** Authoritative local lifetime barrier: process exit (or proven spawn failure)
	 * AND closed stdio. Unlike an error/abort/kill acknowledgement, resolution means
	 * execution is finished. Rejects if final termination cannot be confirmed.
	 * Backends without this barrier must make `exited` authoritative instead. */
	readonly whenSettled?: Promise<void>;
	/** True once the process has exited. */
	isExited(): boolean;
	/**
	 * After `exited` resolves: true when the backend knows the delivered output is
	 * incomplete (byte cap reached, inherited pipes force-closed, queued output
	 * abandoned). Optional — backends that cannot tell simply omit it.
	 */
	outputIncomplete?(): boolean;
	/** Terminate the process (and its process group, when supported). */
	kill(): Promise<void>;
}

/** Parameters for git diff. */
export interface GitDiffParams {
	cwd: string;
	/** Extra args (e.g. ["--staged"], ["HEAD~1"]). */
	args?: string[];
	/** Max stdout bytes. */
	maxBytes?: number;
	signal?: AbortSignal;
}

/**
 * The execution backend contract. `LocalBackend` runs on the server;
 * `RemoteBackend` forwards each call to a remote executor via RPC.
 */
export interface ExecutionBackend {
	/** Feature-negotiated structured remote Git; absent on local/legacy backends. */
	readonly supportsGitWorkspace?: boolean;
	readonly supportsGitWorkspaceWatch?: boolean;
	/** Executor advertises the read-only commit preview operations. */
	readonly supportsGitCommitPreview?: boolean;
	gitWorkspace?(request: GitWorkspaceRequest, signal?: AbortSignal): Promise<GitWorkspaceResult>;
	readonly deviceId: string;
	readonly kind: "local" | "remote";
	/** Pure lexical path operations for this target. */
	readonly paths: TargetPathSemantics;
	/** Shorthand for paths.flavor, persisted with frozen execution targets. */
	readonly pathFlavor: PathFlavor;
	/** Runtime/connection generation that invalidates identities after replacement or reconnect. */
	readonly runtimeGeneration: number;
	/** Platform descriptor (may be undefined until a remote handshake completes). */
	readonly platform?: DevicePlatform;
	/**
	 * Default working directory on the backend, when known. Remote backends report
	 * the value from the device handshake; the local backend leaves it undefined so
	 * tools fall back to the narrator's cwd. Used to resolve relative tool paths and
	 * the default cwd for command execution on the correct machine.
	 */
	readonly defaultCwd?: string | null;

	/**
	 * Resolve a lexical target path to a canonical identity. Missing final paths
	 * are supported by canonicalizing the nearest existing ancestor and rebuilding
	 * the missing suffix, so create operations can be frozen safely.
	 */
	resolvePathIdentity(path: string, opts?: FileMetadataOptions): Promise<PathIdentity>;

	// ── File primitives ──────────────────────────────────────────────
	statFile(path: string, opts?: FileMetadataOptions): Promise<FileStat | null>;
	readFileBytes(path: string, opts?: ReadBytesOptions): Promise<ReadBytesResult>;
	writeFileBytes(path: string, bytes: Uint8Array, opts?: WriteBytesOptions): Promise<void>;
	/** Executor-serialized check-and-replace, not an OS-level CAS against external writers. */
	conditionalWriteFileBytes?(
		path: string,
		bytes: Uint8Array,
		opts: ConditionalWriteBytesOptions,
	): Promise<void>;
	/** Remove one file. Must be idempotent for a missing path and must not remove directories. */
	removeFile(path: string): Promise<void>;
	mkdirp(path: string): Promise<void>;
	listDir(path: string): Promise<DirEntry[]>;
	fileExists(path: string): Promise<boolean>;

	// ── Search ───────────────────────────────────────────────────────
	glob(pattern: string, opts: GlobOptions): Promise<GlobMatches>;
	grep(params: GrepParams): Promise<GrepResult>;

	// ── Command execution ────────────────────────────────────────────
	/** Local dispatch rejection proves no spawn. Once spawned, local execution
	 * returns a handle even on asynchronous errors, retaining its lifetime barrier. */
	execCommand(params: ExecParams): Promise<ExecHandle>;

	// ── Git diagnostics (read-only) ──────────────────────────────────
	gitStatus(cwd: string, signal?: AbortSignal): Promise<string>;
	gitDiff(params: GitDiffParams): Promise<string>;
}
