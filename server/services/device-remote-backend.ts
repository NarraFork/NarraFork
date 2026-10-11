/**
 * RemoteBackend — an ExecutionBackend implementation that forwards each atomic
 * operation to a remote executor device via RPC (device-connection-service).
 *
 * Byte payloads cross the wire base64-encoded. Streaming exec output is bridged
 * from rpc_stream frames into the ExecHandle's onData callback.
 */
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import {
	FEATURE_REMOTE_HISTORY_CAPTURE_TREE_V1,
	FEATURE_REMOTE_HISTORY_OBJECT_STAGE_V1,
	FEATURE_REMOTE_HISTORY_V1,
	REMOTE_HISTORY_METADATA_TIMEOUT_MS,
	REMOTE_HISTORY_OPERATION_TIMEOUT_MS,
	type RemoteHistoryOperation,
	type RemoteHistoryOperations,
} from "@shared/remote-history-protocol";
import {
	NATIVE_PATH_RESOLVE_FEATURE,
	type NativePathDescriptorV2,
} from "@shared/target-native-path";
import {
	WINDOWS_FIRST_CAPTURE_FEATURE,
	WINDOWS_FIRST_CAPTURE_LIMITS,
	type WindowsFirstCaptureMethod,
	type WindowsMetadataCaptureParams,
	type WindowsMetadataPreauthorizeParams,
} from "@shared/windows-first-capture";
import {
	FEATURE_WORKSPACE_ATTACHMENT_V1,
	WORKSPACE_ATTACHMENT_CHUNK_BYTES,
	WORKSPACE_ATTACHMENT_METADATA_TIMEOUT_MS,
	WORKSPACE_ATTACHMENT_OPERATION_TIMEOUT_MS,
	type WorkspaceAttachmentOperation,
	type WorkspaceAttachmentOperations,
} from "@shared/workspace-attachment-protocol";
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
	ListBoundedOptions,
	ListBoundedResult,
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
import {
	FEATURE_GIT_WORKTREE_V1,
	type GitWorktreeRequest,
	type GitWorktreeResult,
} from "../lib/agent/execution/git-worktree-rpc";
import { parseNativePathResolution } from "../lib/agent/execution/native-path-rpc";
import {
	platformPathFlavor,
	targetPathSemantics,
	withNativePathDescriptors,
} from "../lib/agent/execution/path-semantics";
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
	FEATURE_FS_CONDITIONAL_WRITE_V1,
	FEATURE_FS_LIST_BOUNDED_V1,
	FEATURE_FS_READ_BOUNDED_V1,
	FEATURE_GLOB_BOUNDED_V1,
	FS_READ_ATOMIC_RESOLVED_PATH_FEATURE,
	FS_STAT_RESOLVED_PATH_FEATURE,
	FS_WRITE_ATOMIC_RESOLVED_PATH_FEATURE,
} from "../lib/agent/execution/rpc-types";
import {
	FEATURE_SHARE_ARCHIVE_V1,
	SHARE_ARCHIVE_METADATA_TIMEOUT_MS,
	SHARE_ARCHIVE_OPERATION_TIMEOUT_MS,
	type ShareArchiveRequest,
	type ShareArchiveResult,
} from "../lib/agent/execution/share-archive-rpc";
import { pathsEqualForOS } from "../lib/platform-path";
import { settings } from "../lib/settings";
import {
	hasDeviceProtocolFeature,
	type SendRpcOptions,
	sendRpc,
} from "./device-connection-service";
import { currentMetadataAdmission } from "./windows-metadata-admission";

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
	private readonly nativePaths = new Map<
		string,
		{ descriptor: NativePathDescriptorV2; bytes: number }
	>();
	private nativePathBytes = 0;

	constructor(deviceId: string, options: RemoteBackendOptions) {
		this.deviceId = deviceId;
		this.platform = options.platform;
		this.defaultCwd = options.defaultCwd ?? null;
		this.connectionGeneration = options.connectionGeneration;
		this.runtimeGeneration = options.connectionGeneration;
		this.pathFlavor = platformPathFlavor(options.platform?.os);
		const lexicalPaths = targetPathSemantics(this.pathFlavor);
		this.paths =
			this.pathFlavor === "windows" &&
			hasDeviceProtocolFeature(deviceId, NATIVE_PATH_RESOLVE_FEATURE)
				? withNativePathDescriptors(
						lexicalPaths,
						(path) => this.nativePaths.get(lexicalPaths.normalize(path))?.descriptor,
					)
				: lexicalPaths;
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
			windowsMetadataAdmission: opts.windowsMetadataAdmission ?? currentMetadataAdmission(),
			expectedConnectionGeneration: this.connectionGeneration,
		});
	}

	private async statPath(path: string, opts?: FileMetadataOptions): Promise<FsStatResult> {
		const native =
			this.pathFlavor === "windows" &&
			hasDeviceProtocolFeature(this.deviceId, NATIVE_PATH_RESOLVE_FEATURE);
		let expectedNativeDescriptor = opts?.expectedNativeDescriptor;
		if (native && !expectedNativeDescriptor) {
			// This is a fresh metadata observation, not a replacement for frozen authority.
			const observation = await this.resolvePathIdentity(path, opts);
			expectedNativeDescriptor = observation.nativeDescriptor;
		}
		return (await this.rpc(
			"fs.stat",
			{ path, ...(expectedNativeDescriptor ? { expectedNativeDescriptor } : {}) },
			{
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
				requiredFeatures: [
					...(this.supportsFsStatResolvedPath ? [FS_STAT_RESOLVED_PATH_FEATURE] : []),
					...(expectedNativeDescriptor ? [NATIVE_PATH_RESOLVE_FEATURE] : []),
				],
			},
		)) as FsStatResult;
	}

	get supportsNativePathV2(): boolean {
		return (
			this.pathFlavor === "windows" &&
			hasDeviceProtocolFeature(this.deviceId, NATIVE_PATH_RESOLVE_FEATURE)
		);
	}
	async resolvePathIdentity(path: string, opts?: FileMetadataOptions): Promise<PathIdentity> {
		let baseCwd = opts?.baseCwd ?? this.defaultCwd ?? "";
		const lexicalPaths = targetPathSemantics(this.pathFlavor);
		const lexicalPath = lexicalPaths.resolve(baseCwd, path);
		if (this.pathFlavor === "windows" && !baseCwd && lexicalPaths.isAbsolute(path)) {
			// The native protocol requires a frozen base even for absolute inputs.
			// Derive only its lexical parent from the explicit target, not a device
			// startup directory or host cwd; this is not an authorization root.
			const parent = lexicalPaths.dirname(lexicalPath);
			// Node's dirname can step above an extended UNC share root. In that
			// root-only case the explicit fully qualified target is its own base.
			baseCwd = lexicalPaths.isAbsolute(parent) ? parent : lexicalPath;
		}
		if (
			this.pathFlavor === "windows" &&
			hasDeviceProtocolFeature(this.deviceId, NATIVE_PATH_RESOLVE_FEATURE)
		) {
			const wire = await this.rpc(
				"fs.path.resolve.v2",
				{
					inputPath: path,
					baseCwd,
					operation: opts?.operation ?? "create",
					...(opts?.expectedNativeDescriptor
						? { expectedDescriptor: opts.expectedNativeDescriptor }
						: {}),
					...(opts?.expectedRootDescriptor
						? { expectedRootDescriptor: opts.expectedRootDescriptor }
						: {}),
				},
				{ ...opts, requiredFeatures: [NATIVE_PATH_RESOLVE_FEATURE] },
			);
			const resolved = parseNativePathResolution(wire);
			if (lexicalPaths.normalize(resolved.lexicalPath) !== lexicalPaths.normalize(lexicalPath))
				throw new Error("Native path resolver changed the frozen target lexical slot");
			for (const key of [resolved.lexicalPath, resolved.canonicalPath]) {
				const normalized = lexicalPaths.normalize(key);
				const old = this.nativePaths.get(normalized);
				if (old) this.nativePathBytes -= old.bytes;
				this.nativePaths.delete(normalized);
				const bytes = Buffer.byteLength(JSON.stringify(resolved.nativeDescriptor), "utf8");
				this.nativePaths.set(normalized, { descriptor: resolved.nativeDescriptor, bytes });
				this.nativePathBytes += bytes;
			}
			while (this.nativePaths.size > 256 || this.nativePathBytes > 4 * 1024 * 1024) {
				const oldest = this.nativePaths.entries().next().value;
				if (!oldest) break;
				this.nativePaths.delete(oldest[0]);
				this.nativePathBytes -= oldest[1].bytes;
			}
			return {
				lexicalPath: resolved.lexicalPath,
				canonicalPath: resolved.canonicalPath,
				exists: resolved.exists,
				runtimeGeneration: this.runtimeGeneration,
				nativeDescriptor: resolved.nativeDescriptor,
			};
		}
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
		if (
			this.pathFlavor === "windows" &&
			hasDeviceProtocolFeature(this.deviceId, NATIVE_PATH_RESOLVE_FEATURE)
		) {
			return (await this.resolvePathIdentity(path)).exists;
		}
		const res = (await this.rpc("fs.exists", { path })) as FsExistsResult;
		return res.exists;
	}

	private nativeExpected(
		path: string,
		explicit?: NativePathDescriptorV2,
	): NativePathDescriptorV2 | undefined {
		if (
			this.pathFlavor !== "windows" ||
			!hasDeviceProtocolFeature(this.deviceId, NATIVE_PATH_RESOLVE_FEATURE)
		) {
			if (explicit) throw new Error("Executor cannot validate native path v2 evidence");
			return undefined;
		}
		const key = targetPathSemantics(this.pathFlavor).normalize(path);
		const descriptor = explicit ?? this.nativePaths.get(key)?.descriptor;
		if (!descriptor)
			throw new Error("NATIVE_PATH_IDENTITY_REQUIRED: resolve and authorize the target before IO");
		return descriptor;
	}
	async readFileBytes(path: string, opts?: ReadBytesOptions): Promise<ReadBytesResult> {
		const expectedNativeDescriptor = this.nativeExpected(path, opts?.expectedNativeDescriptor);
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
				...(expectedNativeDescriptor ? { expectedNativeDescriptor } : {}),
			},
			{
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
				requiredFeatures: [
					...(expectedNativeDescriptor ? [NATIVE_PATH_RESOLVE_FEATURE] : []),
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
		const expectedNativeDescriptor = this.nativeExpected(path, opts?.expectedNativeDescriptor);
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
				...(expectedNativeDescriptor ? { expectedNativeDescriptor } : {}),
			},
			{
				requiredFeatures: [
					...(expectedResolvedPath ? [FS_WRITE_ATOMIC_RESOLVED_PATH_FEATURE] : []),
					...(expectedNativeDescriptor ? [NATIVE_PATH_RESOLVE_FEATURE] : []),
				],
			},
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
		const expectedNativeDescriptor = this.nativeExpected(path, opts.expectedNativeDescriptor);
		try {
			const result = (await this.rpc(
				"fs.writeConditional",
				{
					path,
					dataB64: toBase64(bytes),
					expectedDataB64: opts.expectedBytes === null ? null : toBase64(opts.expectedBytes),
					expectedResolvedPath: opts.expectedResolvedPath,
					...(expectedNativeDescriptor ? { expectedNativeDescriptor } : {}),
					timeoutMs: Math.min(opts.timeoutMs ?? 30_000, 30_000),
				},
				{
					signal: opts.signal,
					timeoutMs: Math.min(opts.timeoutMs ?? 30_000, 30_000),
					requiredFeatures: [
						FEATURE_FS_CONDITIONAL_WRITE_V1,
						...(expectedNativeDescriptor ? [NATIVE_PATH_RESOLVE_FEATURE] : []),
					],
				},
			)) as { applied: boolean; conflict?: boolean };
			if (result.conflict)
				throw new Error("Conditional write conflict: file changed; preview again before retrying");
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

	get supportsFsListBounded(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_FS_LIST_BOUNDED_V1);
	}

	async listBounded(path: string, opts: ListBoundedOptions = {}): Promise<ListBoundedResult> {
		if (!this.supportsFsListBounded)
			throw new Error("Executor upgrade required: fs.list.bounded.v1");
		const timeoutMs = Math.min(opts.timeoutMs ?? 2000, 2000);
		return (await this.rpc(
			"fs.listBounded",
			{
				path,
				expectedResolvedPath: opts.expectedResolvedPath,
				showHidden: opts.showHidden,
				directoriesOnly: opts.directoriesOnly,
				maxScanned: Math.min(opts.maxScanned ?? 10_000, 10_000),
				maxEntries: Math.min(opts.maxEntries ?? 500, 500),
				maxBytes: Math.min(opts.maxBytes ?? 256 * 1024, this.maxBytes, 256 * 1024),
				timeoutMs,
			},
			{
				signal: opts.signal,
				timeoutMs: timeoutMs + 1000,
				requiredFeatures: [FEATURE_FS_LIST_BOUNDED_V1],
			},
		)) as ListBoundedResult;
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
			policyExcluded: res.policyExcluded,
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

	get supportsWorkspaceAttachment(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_WORKSPACE_ATTACHMENT_V1);
	}
	async workspaceAttachment<K extends WorkspaceAttachmentOperation>(
		operation: K,
		request: WorkspaceAttachmentOperations[K]["request"],
		signal?: AbortSignal,
	): Promise<WorkspaceAttachmentOperations[K]["result"]> {
		if (!this.supportsWorkspaceAttachment)
			throw new Error("Executor upgrade required: workspace.attachment.v1");
		signal?.throwIfAborted();
		if (
			"contentBase64" in request &&
			request.contentBase64.length > Math.ceil(WORKSPACE_ATTACHMENT_CHUNK_BYTES / 3) * 4
		)
			throw new Error("Attachment chunk budget exceeded");
		const timeoutMs =
			operation === "commit" || operation === "cleanup"
				? Math.min(WORKSPACE_ATTACHMENT_OPERATION_TIMEOUT_MS, 120_000)
				: WORKSPACE_ATTACHMENT_METADATA_TIMEOUT_MS;
		return (await this.rpc(
			`attachment.${operation}`,
			{ ...request },
			{ signal, timeoutMs, requiredFeatures: [FEATURE_WORKSPACE_ATTACHMENT_V1] },
		)) as WorkspaceAttachmentOperations[K]["result"];
	}

	/** Protocol existence only; does NOT imply configured capture/editor/FullReady. */
	get supportsWindowsFirstCapture(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, WINDOWS_FIRST_CAPTURE_FEATURE);
	}
	async windowsFirstCapture(
		method: WindowsFirstCaptureMethod,
		params: WindowsMetadataPreauthorizeParams | WindowsMetadataCaptureParams,
		options: NonNullable<SendRpcOptions["windowsFirstCapture"]>,
		control: Pick<SendRpcOptions, "signal" | "windowsMetadataAdmission"> = {},
	): Promise<unknown> {
		if (!this.supportsWindowsFirstCapture)
			throw new Error("Executor upgrade required: windows.metadata.first-capture.v1");
		return this.rpc(
			method,
			{ ...params },
			{
				...control,
				windowsFirstCapture: options,
				timeoutMs: WINDOWS_FIRST_CAPTURE_LIMITS.rpcTimeoutMs,
				requiredFeatures: [WINDOWS_FIRST_CAPTURE_FEATURE],
			},
		);
	}

	get supportsShareArchive(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_SHARE_ARCHIVE_V1);
	}

	async shareArchive(
		request: ShareArchiveRequest,
		signal?: AbortSignal,
	): Promise<ShareArchiveResult> {
		if (!this.supportsShareArchive) throw new Error("Executor upgrade required: share.archive.v1");
		const cap =
			request.operation === "prepare"
				? SHARE_ARCHIVE_OPERATION_TIMEOUT_MS
				: SHARE_ARCHIVE_METADATA_TIMEOUT_MS;
		const timeoutMs = Math.min(request.timeoutMs ?? cap, cap);
		return (await this.rpc(
			`share.${request.operation}`,
			{
				...request,
				timeoutMs,
				maxEntries: Math.min(request.maxEntries ?? 10_000, 10_000),
				maxExpandedBytes: Math.min(
					request.maxExpandedBytes ?? 128 * 1024 * 1024,
					512 * 1024 * 1024,
				),
				maxArchiveBytes: Math.min(request.maxArchiveBytes ?? 128 * 1024 * 1024, 256 * 1024 * 1024),
				maxBytes: Math.min(request.maxBytes ?? 256 * 1024, this.maxBytes, 256 * 1024),
				maxChunkBytes: Math.min(
					request.maxChunkBytes ?? 1024 * 1024,
					1024 * 1024,
					Math.floor(((this.maxBytes - 8192) * 3) / 4),
				),
			},
			{ signal, timeoutMs, requiredFeatures: [FEATURE_SHARE_ARCHIVE_V1] },
		)) as ShareArchiveResult;
	}

	get remoteHistoryChunkBytes(): number {
		return Math.min(
			FILE_CHANGE_LIMITS.streamChunkBytes,
			Math.floor(((this.maxBytes - 8192) * 3) / 4),
		);
	}
	get supportsRemoteObjectStage(): boolean {
		return (
			this.supportsRemoteHistory &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_REMOTE_HISTORY_OBJECT_STAGE_V1)
		);
	}

	get supportsRemoteTreeCapture(): boolean {
		return (
			this.supportsRemoteHistory &&
			hasDeviceProtocolFeature(this.deviceId, FEATURE_REMOTE_HISTORY_CAPTURE_TREE_V1)
		);
	}

	get supportsRemoteHistory(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_REMOTE_HISTORY_V1);
	}

	async remoteHistory<K extends RemoteHistoryOperation>(
		operation: K,
		request: RemoteHistoryOperations[K]["request"],
		signal?: AbortSignal,
	): Promise<RemoteHistoryOperations[K]["result"]> {
		if (!this.supportsRemoteHistory) throw new Error("Executor upgrade required: history.v1");
		if (operation === "captureTree" && !this.supportsRemoteTreeCapture)
			throw new Error("Executor upgrade required: history.capture-tree.v1");
		if (operation === "objectStage" && !this.supportsRemoteObjectStage)
			throw new Error("Executor upgrade required: history.object-stage.v1");
		signal?.throwIfAborted();
		const maxBytes = Math.min(this.maxBytes, FILE_CHANGE_LIMITS.fileToolRequestBytes);
		const changes = "changes" in request ? request.changes : undefined;
		if (changes && changes.length > FILE_CHANGE_LIMITS.revertFiles)
			throw new Error("Remote effect budget exceeded");
		let inlineBytes = 0;
		let metadata = changes
			? {
					...request,
					changes: changes.map(({ contentBase64, ...change }) => {
						inlineBytes += contentBase64 === undefined ? 0 : contentBase64.length + 32;
						return change;
					}),
				}
			: request;
		if ("contentBase64" in metadata) {
			const { contentBase64, ...headers } = metadata;
			inlineBytes += typeof contentBase64 === "string" ? contentBase64.length + 32 : 0;
			metadata = headers as typeof metadata;
		}
		const metadataBytes = Buffer.byteLength(JSON.stringify(metadata));
		if (
			metadataBytes > FILE_CHANGE_LIMITS.summaryBytes ||
			metadataBytes + inlineBytes > maxBytes - 8192
		)
			throw new Error("Remote history request exceeds RPC byte budget");
		const longOperation = ["capture", "captureTree", "mutate", "restore", "compensate"].includes(
			operation,
		);
		return (await this.rpc(
			`history.${operation}`,
			{ ...request },
			{
				signal,
				requiredFeatures:
					operation === "captureTree"
						? [FEATURE_REMOTE_HISTORY_V1, FEATURE_REMOTE_HISTORY_CAPTURE_TREE_V1]
						: operation === "objectStage"
							? [FEATURE_REMOTE_HISTORY_V1, FEATURE_REMOTE_HISTORY_OBJECT_STAGE_V1]
							: [FEATURE_REMOTE_HISTORY_V1],
				timeoutMs: longOperation
					? REMOTE_HISTORY_OPERATION_TIMEOUT_MS
					: REMOTE_HISTORY_METADATA_TIMEOUT_MS,
			},
		)) as RemoteHistoryOperations[K]["result"];
	}

	get supportsGitWorktree(): boolean {
		return hasDeviceProtocolFeature(this.deviceId, FEATURE_GIT_WORKTREE_V1);
	}

	async gitWorktree(request: GitWorktreeRequest, signal?: AbortSignal): Promise<GitWorktreeResult> {
		const timeoutMs = Math.min(request.timeoutMs ?? 60_000, 120_000);
		return (await this.rpc(
			"git.worktree",
			{
				...request,
				timeoutMs,
				maxBytes: Math.min(request.maxBytes ?? 256 * 1024, this.maxBytes, 256 * 1024),
			},
			{ signal, timeoutMs: timeoutMs + 5_000, requiredFeatures: [FEATURE_GIT_WORKTREE_V1] },
		)) as GitWorktreeResult;
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
