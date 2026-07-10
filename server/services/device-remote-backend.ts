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
	ReadBytesOptions,
	ReadBytesResult,
} from "../lib/agent/execution/backend";
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
} from "../lib/agent/execution/rpc-types";
import { settings } from "../lib/settings";
import { sendRpc } from "./device-connection-service";

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
function fromBase64(b64: string): Uint8Array {
	return Uint8Array.from(Buffer.from(b64, "base64"));
}

class RemoteExecHandle implements ExecHandle {
	readonly pid = undefined;
	private exitedFlag = false;
	private dataCbs: Array<(chunk: Uint8Array) => void> = [];
	private abort = new AbortController();
	readonly exited: Promise<number | null>;

	constructor(deviceId: string, params: ExecParams, timeoutMs: number, maxBytes: number) {
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

	constructor(deviceId: string, platform?: DevicePlatform, defaultCwd?: string | null) {
		this.deviceId = deviceId;
		this.platform = platform;
		this.defaultCwd = defaultCwd ?? null;
	}

	private get maxBytes(): number {
		return settings.devices?.maxRpcBytes ?? 10 * 1024 * 1024;
	}

	async statFile(path: string): Promise<FileStat | null> {
		const res = (await sendRpc(this.deviceId, "fs.stat", { path })) as FsStatResult;
		if (!res.exists) return null;
		return { isDirectory: res.isDirectory, isFile: res.isFile, size: res.size };
	}

	async fileExists(path: string): Promise<boolean> {
		const res = (await sendRpc(this.deviceId, "fs.exists", { path })) as FsExistsResult;
		return res.exists;
	}

	async readFileBytes(path: string, opts?: ReadBytesOptions): Promise<ReadBytesResult> {
		const res = (await sendRpc(
			this.deviceId,
			"fs.read",
			{ path, maxBytes: opts?.maxBytes ?? this.maxBytes },
			{ signal: opts?.signal },
		)) as FsReadResult;
		return {
			bytes: fromBase64(res.dataB64),
			truncated: res.truncated,
			totalSize: res.totalSize,
		};
	}

	async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
		await sendRpc(this.deviceId, "fs.write", { path, dataB64: toBase64(bytes) });
	}

	async mkdirp(path: string): Promise<void> {
		await sendRpc(this.deviceId, "fs.mkdirp", { path });
	}

	async listDir(path: string): Promise<DirEntry[]> {
		const res = (await sendRpc(this.deviceId, "fs.list", { path })) as FsListResult;
		return res.entries;
	}

	async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
		const res = (await sendRpc(this.deviceId, "glob", {
			pattern,
			cwd: opts.cwd,
			dot: opts.dot,
			maxResults: opts.maxResults,
		})) as GlobResult;
		return res.matches;
	}

	async grep(params: GrepParams): Promise<GrepResult> {
		const res = (await sendRpc(
			this.deviceId,
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
		return new RemoteExecHandle(this.deviceId, params, timeoutMs, this.maxBytes);
	}

	async gitStatus(cwd: string, signal?: AbortSignal): Promise<string> {
		const res = (await sendRpc(
			this.deviceId,
			"git.status",
			{ cwd },
			{ signal },
		)) as GitStatusResult;
		return res.stdout;
	}

	async gitDiff(params: GitDiffParams): Promise<string> {
		const res = (await sendRpc(
			this.deviceId,
			"git.diff",
			{ cwd: params.cwd, args: params.args, maxBytes: params.maxBytes },
			{ signal: params.signal },
		)) as GitDiffResult;
		return res.stdout;
	}
}

export function createRemoteBackend(
	deviceId: string,
	platform?: DevicePlatform,
	defaultCwd?: string | null,
): RemoteBackend {
	return new RemoteBackend(deviceId, platform, defaultCwd);
}
