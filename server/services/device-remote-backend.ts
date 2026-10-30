/**
 * RemoteBackend — an ExecutionBackend implementation that forwards each atomic
 * operation to a remote executor device via RPC (device-connection-service).
 *
 * Byte payloads cross the wire base64-encoded. Streaming exec output is bridged
 * from rpc_stream frames into the ExecHandle's onData callback.
 */

import { EDITOR_FILE_MAX_BYTES, EDITOR_IO_TIMEOUT_MS } from "../../shared/editor-document";
import type {
	EditorRawReadChunk,
	EditorRawReadOpen,
	EditorResourceIdentity,
} from "../../shared/editor-provider-contracts";
import type {
	ConditionalWriteBytesOptions,
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
	exclusiveCreateOptions,
	validateExclusiveCreateInput,
} from "../lib/agent/execution/exclusive-create";
import {
	FEATURE_GIT_BRANCH_SWITCH_V1,
	FEATURE_GIT_BRANCHES_V1,
	FEATURE_GIT_COMMIT_PREVIEW_V1,
	FEATURE_GIT_LINE_STATS_V1,
	FEATURE_GIT_REMOTE_SYNC_V1,
	FEATURE_GIT_WORKSPACE_STATUS_V1,
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
	FEATURE_EDITOR_DURABLE_WRITE_V1,
	FEATURE_EDITOR_RAW_READ_V1,
	FEATURE_FS_CONDITIONAL_WRITE_V1,
	FEATURE_FS_CREATE_BOUND_PARENT_V1,
	FEATURE_FS_MKDIR_EXCLUSIVE_V1,
	FEATURE_FS_READ_BOUNDED_V1,
	FEATURE_FS_READ_OFFSET_V1,
	FEATURE_GLOB_BOUNDED_V1,
	FS_READ_ATOMIC_RESOLVED_PATH_FEATURE,
	FS_STAT_RESOLVED_PATH_FEATURE,
	FS_WRITE_ATOMIC_RESOLVED_PATH_FEATURE,
} from "../lib/agent/execution/rpc-types";
import { AppError } from "../lib/errors";
import { pathsEqualForOS } from "../lib/platform-path";
import { settings } from "../lib/settings";
import {
	getDeviceConnectionGeneration,
	hasDeviceProtocolFeature,
	type SendRpcOptions,
	sendRpc,
} from "./device-connection-service";
import type { EditorRemoteRawSource } from "./editor-document-streams";

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

	get supportsEditorDurableWrite() {
		return (
			getDeviceConnectionGeneration(this.deviceId) === this.connectionGeneration &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_EDITOR_DURABLE_WRITE_V1)
		);
	}
	editorWriteRpc() {
		return {
			call: async <T>(method: string, params: object, signal?: AbortSignal) => {
				if (!this.supportsEditorDurableWrite)
					throw new Error("Editor durable executor unavailable or reconnected");
				return (await this.rpc(
					method as RpcMethod,
					{ ...params },
					{
						signal,
						timeoutMs: EDITOR_IO_TIMEOUT_MS,
						requiredFeatures: [FEATURE_EDITOR_DURABLE_WRITE_V1],
					},
				)) as T;
			},
		};
	}
	async editorObservation(
		identity: EditorResourceIdentity,
		resourceKey: string,
		signal?: AbortSignal,
	) {
		const stat = await this.editorWriteRpc().call<FsStatResult>(
			"fs.stat",
			{
				path: identity.canonicalPath,
				editorIdentity: true,
				editorRoot: this.defaultCwd,
			},
			signal,
		);
		if (!stat.exists) return { bytes: null, mode: null, identity: null };
		if (!stat.isFile || !Number.isInteger(stat.mode))
			throw new Error("Remote editor metadata unsupported");
		const source = this.editorRawSource(identity, resourceKey);
		const opened = await source.open(signal ?? AbortSignal.timeout(30_000));
		try {
			const bytes = new Uint8Array(opened.totalBytes);
			let offset = 0;
			for (;;) {
				const chunk = await source.chunk(
					{ readId: opened.readId, offset, maxBytes: 65536, timeoutMs: 10_000 },
					signal ?? AbortSignal.timeout(10_000),
				);
				if (
					chunk.offset !== offset ||
					chunk.sourceGeneration !== opened.sourceGeneration ||
					chunk.readId !== opened.readId ||
					!Number.isSafeInteger(chunk.bytes) ||
					chunk.bytes < 0 ||
					chunk.bytes > 65536
				)
					throw new Error("Invalid remote editor observation");
				const raw = Buffer.from(chunk.dataB64, "base64");
				if (raw.length !== chunk.bytes || offset + raw.length > bytes.length)
					throw new Error("Invalid remote editor observation bytes");
				bytes.set(raw, offset);
				offset += raw.length;
				if (chunk.eof) {
					if (offset !== bytes.length) throw new Error("Incomplete remote editor observation");
					return { bytes, mode: stat.mode as number, identity: opened.sourceGeneration };
				}
				if (!raw.length) throw new Error("Empty remote editor observation chunk");
			}
		} finally {
			await source.close({ readId: opened.readId, abort: true });
		}
	}
	get supportsEditorRawRead() {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_EDITOR_RAW_READ_V1);
	}
	async editorRootIdentity(signal?: AbortSignal) {
		const result = (await this.rpc(
			"fs.stat",
			{ path: this.defaultCwd, editorIdentity: true },
			{ signal, timeoutMs: 10_000, requiredFeatures: [FEATURE_EDITOR_RAW_READ_V1] },
		)) as FsStatResult;
		if (
			!result.isDirectory ||
			typeof result.canonicalRoot !== "string" ||
			!result.canonicalRoot ||
			result.canonicalRoot.length > 4096 ||
			typeof result.rootIdentity !== "string" ||
			!result.rootIdentity ||
			result.rootIdentity.length > 8192 ||
			typeof result.runtimeEpoch !== "string" ||
			!result.runtimeEpoch ||
			result.runtimeEpoch.length > 128
		)
			throw new Error("Remote editor root identity is unavailable");
		return {
			canonicalRoot: result.canonicalRoot,
			rootIdentity: result.rootIdentity,
			runtimeEpoch: result.runtimeEpoch,
		};
	}
	editorRawSource(identity: EditorResourceIdentity, resourceKey: string): EditorRemoteRawSource {
		return {
			open: async (signal) => {
				// Reuse the existing canonical stat for absence, rather than guessing from
				// an executor's human-readable open error or probing the host filesystem.
				if (!(await this.statFile(identity.canonicalPath, { signal, timeoutMs: 10_000 })))
					throw new AppError("Remote editor source does not exist", 404, "ENOENT");
				const result = (await this.rpc(
					"editor.read.open",
					{
						resourceKey,
						identity,
						maxBytes: EDITOR_FILE_MAX_BYTES,
						timeoutMs: EDITOR_IO_TIMEOUT_MS,
					},
					{
						signal,
						timeoutMs: EDITOR_IO_TIMEOUT_MS,
						requiredFeatures: [FEATURE_EDITOR_RAW_READ_V1],
					},
				)) as EditorRawReadOpen;
				if (
					typeof result?.readId !== "string" ||
					!result.readId ||
					result.readId.length > 128 ||
					typeof result.sourceGeneration !== "string" ||
					!result.sourceGeneration ||
					result.sourceGeneration.length > 128 ||
					Object.keys(identity).some(
						(key) =>
							identity[key as keyof EditorResourceIdentity] !==
							result.identity?.[key as keyof EditorResourceIdentity],
					) ||
					!Number.isSafeInteger(result.totalBytes) ||
					result.totalBytes < 0 ||
					result.totalBytes > EDITOR_FILE_MAX_BYTES ||
					!/^[a-f0-9]{64}$/.test(result.rawDigest)
				) {
					if (result?.readId)
						await this.rpc("editor.read.close", { readId: result.readId, abort: true }).catch(
							() => {},
						);
					throw new Error("Remote editor source identity changed");
				}
				return result;
			},
			chunk: async (input, signal) =>
				(await this.rpc(
					"editor.read.chunk",
					{ ...input },
					{ signal, timeoutMs: input.timeoutMs, requiredFeatures: [FEATURE_EDITOR_RAW_READ_V1] },
				)) as EditorRawReadChunk,
			close: async (input) => {
				await this.rpc(
					"editor.read.close",
					{ ...input },
					{ timeoutMs: 10_000, requiredFeatures: [FEATURE_EDITOR_RAW_READ_V1] },
				);
			},
		};
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
		if (
			opts?.offset !== undefined &&
			(!Number.isSafeInteger(opts.offset) || opts.offset < 0 || opts.maxBytes === undefined)
		)
			throw new RangeError("Positional reads require a nonnegative safe offset and maxBytes");
		const expectedResolvedPath = opts?.expectedResolvedPath;
		if (expectedResolvedPath && !this.supportsFsReadAtomicResolvedPath) {
			throw new Error(`Remote device ${this.deviceId} does not support atomic resolved-path reads`);
		}
		const res = (await this.rpc(
			"fs.read",
			{
				path,
				maxBytes: opts?.maxBytes ?? this.maxBytes,
				...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
				timeoutMs: opts?.timeoutMs,
				...(expectedResolvedPath ? { expectedResolvedPath } : {}),
			},
			{
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
				requiredFeatures: [
					...(expectedResolvedPath ? [FS_READ_ATOMIC_RESOLVED_PATH_FEATURE] : []),
					...(opts?.timeoutMs !== undefined ? [FEATURE_FS_READ_BOUNDED_V1] : []),
					...(opts?.offset !== undefined ? [FEATURE_FS_READ_OFFSET_V1] : []),
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
		if (
			opts?.exclusive &&
			(!hasDeviceProtocolFeature(this.deviceId, FEATURE_FS_MKDIR_EXCLUSIVE_V1) ||
				!hasDeviceProtocolFeature(this.deviceId, FEATURE_FS_CREATE_BOUND_PARENT_V1))
		)
			throw new Error(
				`Device ${this.deviceId} requires an executor upgrade for bound-parent exclusive file creation`,
			);
		let budget: ReturnType<typeof exclusiveCreateOptions> | undefined;
		if (opts?.exclusive) {
			validateExclusiveCreateInput(path, bytes);
			validateExclusiveCreateInput(expectedResolvedPath);
			budget = exclusiveCreateOptions(opts);
		}
		const requiredFeatures = [
			...(expectedResolvedPath ? [FS_WRITE_ATOMIC_RESOLVED_PATH_FEATURE] : []),
			...(opts?.exclusive
				? [FEATURE_FS_MKDIR_EXCLUSIVE_V1, FEATURE_FS_CREATE_BOUND_PARENT_V1]
				: []),
		];
		await this.rpc(
			"fs.write",
			{
				path,
				dataB64: toBase64(bytes),
				...(expectedResolvedPath ? { expectedResolvedPath } : {}),
				...(opts?.exclusive ? { exclusive: true, timeoutMs: budget?.timeoutMs } : {}),
			},
			{ signal: opts?.signal, timeoutMs: opts?.timeoutMs, ...budget, requiredFeatures },
		);
	}

	async conditionalWriteFileBytes(
		path: string,
		bytes: Uint8Array,
		opts: ConditionalWriteBytesOptions,
	): Promise<void> {
		if (!hasDeviceProtocolFeature(this.deviceId, FEATURE_FS_CONDITIONAL_WRITE_V1)) {
			throw new Error(
				`Remote device ${this.deviceId} needs an executor upgrade for conditional writes`,
			);
		}
		if (bytes.byteLength > 2_000_000 || (opts.expectedBytes?.byteLength ?? 0) > 2_000_000) {
			throw new Error("Conditional write exceeds the 2000000-byte file limit");
		}
		opts.signal?.throwIfAborted();
		try {
			const result = (await this.rpc(
				"fs.writeConditional",
				{
					path,
					dataB64: toBase64(bytes),
					expectedDataB64: opts.expectedBytes === null ? null : toBase64(opts.expectedBytes),
					expectedResolvedPath: opts.expectedResolvedPath,
					timeoutMs: Math.min(opts.timeoutMs ?? 30_000, 30_000),
				},
				{
					signal: opts.signal,
					timeoutMs: Math.min(opts.timeoutMs ?? 30_000, 30_000),
					requiredFeatures: [FEATURE_FS_CONDITIONAL_WRITE_V1],
				},
			)) as { applied: boolean; conflict?: boolean };
			if (result.conflict)
				throw Object.assign(
					new Error("Conditional write conflict: file changed; preview again before retrying"),
					{ diskOutcome: "conflict" as const },
				);
			if (!result.applied) throw new Error("Conditional write returned an invalid result");
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Conditional write conflict:"))
				throw error;
			const detail = error instanceof Error ? ` Remote error: ${error.message.slice(0, 1024)}` : "";
			throw new Error(
				`Remote conditional-write outcome is unknown; inspect the remote file before retrying. The stash is retained.${detail}`,
				{ cause: error },
			);
		}
	}

	async removeFile(path: string): Promise<void> {
		await this.rpc("fs.remove", { path });
	}

	async mkdirp(path: string): Promise<void> {
		await this.rpc("fs.mkdirp", { path });
	}

	async mkdirExclusive(
		path: string,
		opts: FileMetadataOptions & { expectedResolvedPath: string },
	): Promise<boolean> {
		if (
			!hasDeviceProtocolFeature(this.deviceId, FEATURE_FS_MKDIR_EXCLUSIVE_V1) ||
			!hasDeviceProtocolFeature(this.deviceId, FEATURE_FS_CREATE_BOUND_PARENT_V1)
		)
			throw new Error(
				`Device ${this.deviceId} requires an executor upgrade for bound-parent exclusive directory creation; no local fallback`,
			);
		validateExclusiveCreateInput(path);
		validateExclusiveCreateInput(opts.expectedResolvedPath);
		const budget = exclusiveCreateOptions(opts);
		const result = (await this.rpc(
			"fs.mkdirExclusive",
			{
				path,
				expectedResolvedPath: opts.expectedResolvedPath,
				timeoutMs: budget.timeoutMs,
			},
			{
				...budget,
				requiredFeatures: [FEATURE_FS_MKDIR_EXCLUSIVE_V1, FEATURE_FS_CREATE_BOUND_PARENT_V1],
			},
		)) as { created: boolean };
		if (typeof result.created !== "boolean") throw new Error("Invalid exclusive mkdir response");
		return result.created;
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

	get supportsGitWorkspaceStatus(): boolean {
		return (
			this.supportsGitWorkspace &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_WORKSPACE_STATUS_V1)
		);
	}

	get supportsGitWorkspaceWatch(): boolean {
		return (
			this.supportsGitWorkspace &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_WORKSPACE_WATCH_V1)
		);
	}

	get supportsGitLineStats(): boolean {
		return (
			this.supportsGitWorkspace &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_LINE_STATS_V1)
		);
	}

	get supportsGitCommitPreview(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_COMMIT_PREVIEW_V1);
	}

	get supportsGitBranches(): boolean {
		return (
			this.supportsGitWorkspace && hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_BRANCHES_V1)
		);
	}

	get supportsGitBranchSwitch(): boolean {
		return (
			this.supportsGitWorkspace &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_BRANCH_SWITCH_V1)
		);
	}

	get supportsGitRemoteSync(): boolean {
		return (
			this.supportsGitWorkspace &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_REMOTE_SYNC_V1)
		);
	}

	async gitWorkspace(
		request: GitWorkspaceRequest,
		signal?: AbortSignal,
	): Promise<GitWorkspaceResult> {
		const timeoutMs = request.timeoutMs ?? GIT_WORKSPACE_TIMEOUT_MS;
		// Every git.workspace call needs the base feature; the rest are additive and
		// listed per operation so an older executor fails one operation, not the panel.
		const requiredFeatures = [FEATURE_GIT_WORKSPACE_V1];
		if (request.operation === "commitDetail" || request.operation === "commitDiff")
			requiredFeatures.push(FEATURE_GIT_COMMIT_PREVIEW_V1);
		else if (request.operation === "lineStats") requiredFeatures.push(FEATURE_GIT_LINE_STATS_V1);
		else if (request.operation === "branches") requiredFeatures.push(FEATURE_GIT_BRANCHES_V1);
		else if (request.operation === "checkout") requiredFeatures.push(FEATURE_GIT_BRANCH_SWITCH_V1);
		else if (request.operation === "push" || request.operation === "fetch")
			requiredFeatures.push(FEATURE_GIT_REMOTE_SYNC_V1);
		return (await this.rpc(
			"git.workspace",
			{
				...request,
				timeoutMs,
				maxBytes: Math.min(request.maxBytes ?? GIT_WORKSPACE_MAX_BYTES, this.maxBytes),
			},
			{ signal, timeoutMs: timeoutMs + 5_000, requiredFeatures },
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
