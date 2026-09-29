/**
 * RemoteBackend — an ExecutionBackend implementation that forwards each atomic
 * operation to a remote executor device via RPC (device-connection-service).
 *
 * Byte payloads cross the wire base64-encoded. Streaming exec output is bridged
 * from rpc_stream frames into the ExecHandle's onData callback.
 */
import type {
	DevicePlatform,
	DirEntry,
	ExecHandle,
	ExecParams,
	ExecutionBackend,
	FileMetadataOptions,
	FileStat,
	GitDiffParams,
	GlobMatches,
	GlobOptions,
	GrepParams,
	GrepResult,
	PathIdentity,
	ReadBytesOptions,
	ReadBytesResult,
	WriteBytesOptions,
} from "../lib/agent/execution/backend";
import {
	FEATURE_GIT_COMMIT_PREVIEW_V1,
	FEATURE_GIT_WORKSPACE_V1,
	FEATURE_GIT_WORKSPACE_WATCH_V1,
	GIT_WORKSPACE_MAX_BYTES,
	GIT_WORKSPACE_TIMEOUT_MS,
	type GitWorkspaceRequest,
	type GitWorkspaceResult,
} from "../lib/agent/execution/git-workspace-rpc";
import { platformPathFlavor, targetPathSemantics } from "../lib/agent/execution/path-semantics";
import type {
	ExecStartResult,
	FsExistsResult,
	FsListResult,
	FsReadResult,
	FsStatResult,
	GitDiffResult,
	GitStatusResult,
	GlobResult,
	GrepRpcResult,
	RpcMethod,
} from "../lib/agent/execution/rpc-types";
import {
	FEATURE_FS_READ_BOUNDED_V1,
	FEATURE_GLOB_BOUNDED_V1,
	FS_READ_ATOMIC_RESOLVED_PATH_FEATURE,
	FS_STAT_RESOLVED_PATH_FEATURE,
	FS_WRITE_ATOMIC_RESOLVED_PATH_FEATURE,
} from "../lib/agent/execution/rpc-types";
import { pathsEqualForOS } from "../lib/platform-path";
import { settings } from "../lib/settings";
import {
	hasDeviceProtocolFeature,
	type SendRpcOptions,
	sendRpc,
} from "./device-connection-service";

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
function fromBase64(b64: string): Uint8Array {
	return Uint8Array.from(Buffer.from(b64, "base64"));
}

function remotePathsEqual(left: string, right: string, platform?: DevicePlatform): boolean {
	return pathsEqualForOS(left, right, platform?.os ?? "posix");
}

export interface RemoteBackendOptions {
	connectionGeneration: number;
	platform?: DevicePlatform;
	defaultCwd?: string | null;
	supportsFsStatResolvedPath?: boolean;
	supportsFsReadAtomicResolvedPath?: boolean;
	supportsFsWriteAtomicResolvedPath?: boolean;
}

class RemoteExecHandle implements ExecHandle {
	readonly pid = undefined;
	private exitedFlag = false;
	private truncatedFlag = false;
	private dataCbs: Array<(chunk: Uint8Array) => void> = [];
	private abort = new AbortController();
	readonly exited: Promise<number | null>;

	constructor(
		deviceId: string,
		connectionGeneration: number,
		params: ExecParams,
		timeoutMs: number,
		maxBytes: number,
	) {
		// The session signal can outlive hundreds of completed Bash calls. Detach
		// this bridge on every terminal path, not just when the owner aborts.
		const onAbort = () => this.abort.abort();
		if (params.signal) {
			if (params.signal.aborted) this.abort.abort();
			else params.signal.addEventListener("abort", onAbort, { once: true });
		}
		const cleanup = () => {
			this.exitedFlag = true;
			params.signal?.removeEventListener("abort", onAbort);
			this.dataCbs.length = 0;
		};

		this.exited = sendRpc(
			deviceId,
			"exec.start",
			{
				command: params.command,
				cwd: params.cwd,
				freshEnv: params.freshEnv,
				env: params.env,
				timeoutMs,
				maxBytes,
			},
			{
				signal: this.abort.signal,
				timeoutMs: timeoutMs + 10_000, // allow the executor to enforce its own timeout first
				expectedConnectionGeneration: connectionGeneration,
				onStream: (_channel, chunk) => {
					for (const cb of this.dataCbs) cb(chunk);
				},
			},
		).then(
			(result) => {
				cleanup();
				// The executor reports truncation (byte cap, force-closed inherited
				// pipes, abandoned queue); surface it rather than drop it.
				this.truncatedFlag = (result as ExecStartResult)?.truncated === true;
				return (result as ExecStartResult)?.exitCode ?? null;
			},
			(err) => {
				cleanup();
				throw err;
			},
		);
	}

	onData(cb: (chunk: Uint8Array) => void): void {
		this.dataCbs.push(cb);
	}

	isExited(): boolean {
		return this.exitedFlag;
	}

	outputIncomplete(): boolean {
		return this.truncatedFlag;
	}

	async kill(): Promise<void> {
		this.abort.abort();
	}
}

export class RemoteBackend implements ExecutionBackend {
	readonly kind = "remote" as const;
	readonly deviceId: string;
	readonly platform?: DevicePlatform;
	readonly defaultCwd?: string | null;
	readonly connectionGeneration: number;
	readonly paths;
	readonly pathFlavor;
	readonly runtimeGeneration: number;
	/** Whether the connected executor declared fs.stat canonical-path support. */
	readonly supportsFsStatResolvedPath: boolean;
	/** Whether fs.read can atomically verify a previously authorized canonical identity. */
	readonly supportsFsReadAtomicResolvedPath: boolean;
	/** Whether fs.write can verify a previously authorized canonical create/existing identity. */
	readonly supportsFsWriteAtomicResolvedPath: boolean;

	constructor(deviceId: string, options: RemoteBackendOptions) {
		this.deviceId = deviceId;
		this.platform = options.platform;
		this.defaultCwd = options.defaultCwd ?? null;
		this.connectionGeneration = options.connectionGeneration;
		this.runtimeGeneration = options.connectionGeneration;
		this.pathFlavor = platformPathFlavor(options.platform?.os);
		this.paths = targetPathSemantics(this.pathFlavor);
		this.supportsFsStatResolvedPath = options.supportsFsStatResolvedPath ?? false;
		this.supportsFsReadAtomicResolvedPath = options.supportsFsReadAtomicResolvedPath ?? false;
		this.supportsFsWriteAtomicResolvedPath = options.supportsFsWriteAtomicResolvedPath ?? false;
	}

	get supportsFsReadBounded(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_FS_READ_BOUNDED_V1);
	}

	private get maxBytes(): number {
		return settings.devices?.maxRpcBytes ?? 10 * 1024 * 1024;
	}

	private rpc(
		method: RpcMethod,
		params: Record<string, unknown>,
		opts: SendRpcOptions = {},
	): Promise<unknown> {
		return sendRpc(this.deviceId, method, params, {
			...opts,
			expectedConnectionGeneration: this.connectionGeneration,
		});
	}

	private async statPath(path: string, opts?: FileMetadataOptions): Promise<FsStatResult> {
		return (await this.rpc(
			"fs.stat",
			{ path },
			{
				...opts,
				...(this.supportsFsStatResolvedPath
					? { requiredFeatures: [FS_STAT_RESOLVED_PATH_FEATURE] }
					: {}),
			},
		)) as FsStatResult;
	}

	async resolvePathIdentity(path: string, opts?: FileMetadataOptions): Promise<PathIdentity> {
		const lexicalPath = this.paths.resolve(this.defaultCwd ?? "", path);
		const result = await this.statPath(lexicalPath, opts);
		if (this.supportsFsStatResolvedPath && !result.resolvedPath) {
			throw new Error(
				`Remote device ${this.deviceId} advertised canonical fs.stat but omitted resolvedPath`,
			);
		}
		return {
			lexicalPath,
			canonicalPath: result.resolvedPath ?? lexicalPath,
			exists: result.exists,
			runtimeGeneration: this.runtimeGeneration,
		};
	}

	async statFile(path: string, opts?: FileMetadataOptions): Promise<FileStat | null> {
		const res = await this.statPath(path, opts);
		if (!res.exists) return null;
		if (this.supportsFsStatResolvedPath && !res.resolvedPath) {
			throw new Error(
				`Remote device ${this.deviceId} advertised canonical fs.stat but omitted resolvedPath`,
			);
		}
		return {
			isDirectory: res.isDirectory,
			isFile: res.isFile,
			size: res.size,
			resolvedPath: res.resolvedPath,
		};
	}

	async fileExists(path: string): Promise<boolean> {
		const res = (await this.rpc("fs.exists", { path })) as FsExistsResult;
		return res.exists;
	}

	async readFileBytes(path: string, opts?: ReadBytesOptions): Promise<ReadBytesResult> {
		const expectedResolvedPath = opts?.expectedResolvedPath;
		if (expectedResolvedPath && !this.supportsFsReadAtomicResolvedPath) {
			throw new Error(`Remote device ${this.deviceId} does not support atomic resolved-path reads`);
		}
		const res = (await this.rpc(
			"fs.read",
			{
				path,
				maxBytes: opts?.maxBytes ?? this.maxBytes,
				timeoutMs: opts?.timeoutMs,
				...(expectedResolvedPath ? { expectedResolvedPath } : {}),
			},
			{
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
				requiredFeatures: [
					...(expectedResolvedPath ? [FS_READ_ATOMIC_RESOLVED_PATH_FEATURE] : []),
					...(opts?.timeoutMs !== undefined ? [FEATURE_FS_READ_BOUNDED_V1] : []),
				],
			},
		)) as FsReadResult;
		if (expectedResolvedPath) {
			if (!res.resolvedPath) {
				throw new Error(`Remote device ${this.deviceId} fs.read omitted the verified resolvedPath`);
			}
			if (!remotePathsEqual(res.resolvedPath, expectedResolvedPath, this.platform)) {
				throw new Error(
					`Remote fs.read resolved path mismatch: expected ${expectedResolvedPath}, ` +
						`got ${res.resolvedPath}`,
				);
			}
		}
		return {
			bytes: fromBase64(res.dataB64),
			truncated: res.truncated,
			totalSize: res.totalSize,
			resolvedPath: res.resolvedPath,
		};
	}

	async writeFileBytes(path: string, bytes: Uint8Array, opts?: WriteBytesOptions): Promise<void> {
		const expectedResolvedPath = opts?.expectedResolvedPath;
		if (expectedResolvedPath && !this.supportsFsWriteAtomicResolvedPath) {
			throw new Error(
				`Remote device ${this.deviceId} does not support atomic resolved-path writes; upgrade the executor`,
			);
		}
		await this.rpc(
			"fs.write",
			{
				path,
				dataB64: toBase64(bytes),
				...(expectedResolvedPath ? { expectedResolvedPath } : {}),
			},
			expectedResolvedPath ? { requiredFeatures: [FS_WRITE_ATOMIC_RESOLVED_PATH_FEATURE] } : {},
		);
	}

	async removeFile(path: string): Promise<void> {
		await this.rpc("fs.remove", { path });
	}

	async mkdirp(path: string): Promise<void> {
		await this.rpc("fs.mkdirp", { path });
	}

	async listDir(path: string): Promise<DirEntry[]> {
		const res = (await this.rpc("fs.list", { path })) as FsListResult;
		return res.entries;
	}

	async glob(pattern: string, opts: GlobOptions): Promise<GlobMatches> {
		const bounded =
			opts.signal !== undefined ||
			opts.timeoutMs !== undefined ||
			opts.maxBytes !== undefined ||
			opts.query !== undefined ||
			opts.includeDirectories !== undefined;
		const res = (await this.rpc(
			"glob",
			{
				pattern,
				cwd: opts.cwd,
				dot: opts.dot,
				maxResults: opts.maxResults,
				maxBytes: opts.maxBytes,
				timeoutMs: opts.timeoutMs,
				includeDirectories: opts.includeDirectories,
				query: opts.query,
			},
			{
				signal: opts.signal,
				timeoutMs: opts.timeoutMs,
				...(bounded ? { requiredFeatures: [FEATURE_GLOB_BOUNDED_V1] } : {}),
			},
		)) as GlobResult;
		return Object.assign(res.matches, { truncated: res.truncated ?? false });
	}

	async grep(params: GrepParams): Promise<GrepResult> {
		const res = (await this.rpc(
			"grep",
			{
				pattern: params.pattern,
				searchPath: params.searchPath,
				cwd: params.cwd,
				glob: params.glob,
				outputMode: params.outputMode,
				beforeContext: params.beforeContext,
				afterContext: params.afterContext,
				contextLines: params.contextLines,
				showLineNumbers: params.showLineNumbers,
				caseInsensitive: params.caseInsensitive,
				fileType: params.fileType,
				multiline: params.multiline,
				rawBytes: params.rawBytes,
				maxBytes: params.maxBytes,
				timeoutMs: params.timeoutMs,
			},
			{ signal: params.signal, timeoutMs: params.timeoutMs + 10_000 },
		)) as GrepRpcResult;
		return {
			stdoutBytes: fromBase64(res.stdoutB64),
			stderr: res.stderr,
			exitCode: res.exitCode,
			truncatedByBytes: res.truncatedByBytes,
			timedOut: res.timedOut,
			unavailable: res.unavailable,
			usedFallback: res.usedFallback,
		};
	}

	async execCommand(params: ExecParams): Promise<ExecHandle> {
		const timeoutMs = settings.devices?.rpcTimeoutMs ?? 120_000;
		return new RemoteExecHandle(
			this.deviceId,
			this.connectionGeneration,
			params,
			timeoutMs,
			this.maxBytes,
		);
	}

	get supportsGitWorkspace(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_WORKSPACE_V1);
	}

	get supportsGitWorkspaceWatch(): boolean {
		return (
			this.supportsGitWorkspace &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_WORKSPACE_WATCH_V1)
		);
	}

	get supportsGitCommitPreview(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_COMMIT_PREVIEW_V1);
	}

	async gitWorkspace(
		request: GitWorkspaceRequest,
		signal?: AbortSignal,
	): Promise<GitWorkspaceResult> {
		const timeoutMs = request.timeoutMs ?? GIT_WORKSPACE_TIMEOUT_MS;
		const preview = request.operation === "commitDetail" || request.operation === "commitDiff";
		return (await this.rpc(
			"git.workspace",
			{
				...request,
				timeoutMs,
				maxBytes: Math.min(request.maxBytes ?? GIT_WORKSPACE_MAX_BYTES, this.maxBytes),
			},
			{
				signal,
				timeoutMs: timeoutMs + 5_000,
				requiredFeatures: preview
					? [FEATURE_GIT_WORKSPACE_V1, FEATURE_GIT_COMMIT_PREVIEW_V1]
					: [FEATURE_GIT_WORKSPACE_V1],
			},
		)) as GitWorkspaceResult;
	}

	async gitStatus(cwd: string, signal?: AbortSignal): Promise<string> {
		const res = (await this.rpc("git.status", { cwd }, { signal })) as GitStatusResult;
		return res.stdout;
	}

	async gitDiff(params: GitDiffParams): Promise<string> {
		const res = (await this.rpc(
			"git.diff",
			{ cwd: params.cwd, args: params.args, maxBytes: params.maxBytes },
			{ signal: params.signal },
		)) as GitDiffResult;
		return res.stdout;
	}
}

export function createRemoteBackend(
	deviceId: string,
	options: RemoteBackendOptions,
): RemoteBackend {
	return new RemoteBackend(deviceId, options);
}
