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
	FileStat,
	GitDiffParams,
	GlobOptions,
	GrepParams,
	GrepResult,
	PathIdentity,
	ReadBytesOptions,
	ReadBytesResult,
	WriteBytesOptions,
} from "../lib/agent/execution/backend";
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
	FS_READ_ATOMIC_RESOLVED_PATH_FEATURE,
	FS_STAT_RESOLVED_PATH_FEATURE,
	FS_WRITE_ATOMIC_RESOLVED_PATH_FEATURE,
} from "../lib/agent/execution/rpc-types";
import { pathsEqualForOS } from "../lib/platform-path";
import { settings } from "../lib/settings";
import { type SendRpcOptions, sendRpc } from "./device-connection-service";

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
		// Bridge the caller's abort signal into our internal one.
		if (params.signal) {
			if (params.signal.aborted) this.abort.abort();
			else params.signal.addEventListener("abort", () => this.abort.abort(), { once: true });
		}

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
				this.exitedFlag = true;
				return (result as ExecStartResult)?.exitCode ?? null;
			},
			(err) => {
				this.exitedFlag = true;
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

	private async statPath(path: string): Promise<FsStatResult> {
		return (await this.rpc(
			"fs.stat",
			{ path },
			this.supportsFsStatResolvedPath ? { requiredFeatures: [FS_STAT_RESOLVED_PATH_FEATURE] } : {},
		)) as FsStatResult;
	}

	async resolvePathIdentity(path: string): Promise<PathIdentity> {
		const lexicalPath = this.paths.resolve(this.defaultCwd ?? "", path);
		const result = await this.statPath(lexicalPath);
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

	async statFile(path: string): Promise<FileStat | null> {
		const res = await this.statPath(path);
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
				...(expectedResolvedPath ? { expectedResolvedPath } : {}),
			},
			{
				signal: opts?.signal,
				...(expectedResolvedPath
					? { requiredFeatures: [FS_READ_ATOMIC_RESOLVED_PATH_FEATURE] }
					: {}),
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

	async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
		const res = (await this.rpc("glob", {
			pattern,
			cwd: opts.cwd,
			dot: opts.dot,
			maxResults: opts.maxResults,
		})) as GlobResult;
		return res.matches;
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
