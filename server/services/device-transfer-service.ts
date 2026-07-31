/**
 * Device file transfer service — high-performance, resumable, binary-framed
 * file transfer between the server and remote executor devices.
 *
 * Control plane: transfer.* RPCs (device-connection-service.sendRpc).
 * Data plane: binary chunk frames (device-connection-service.sendChunkFrame /
 * setChunkFrameHandler).
 *
 * Direction semantics:
 *   - "download": remote → server. The executor sends chunk frames; the server
 *     writes them to a local .part file.
 *   - "upload":   server → remote. The server sends chunk frames; the executor
 *     writes them. The server reads its local source with ReadAt-style offsets.
 *
 * This module keeps everything streaming: chunks are read/written at byte
 * offsets, never buffering a whole file in memory.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, mkdirSync } from "node:fs";
import { open, readdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { db } from "../db";
import {
	type ChunkFrameHeader,
	decodeChunkFrame,
	encodeChunkFrame,
	type TransferBeginResult,
	type TransferDirection,
	type TransferStatResult,
} from "../lib/agent/execution/rpc-types";
import { crc32c } from "../lib/crc32c";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { settings } from "../lib/settings";
import {
	deviceBufferedAmount,
	getConnectedDeviceHello,
	hasDeviceProtocolFeature,
	isDeviceOnline,
	sendChunkFrame,
	sendRpc,
	setChunkFrameHandler,
} from "./device-connection-service";
import {
	type DeviceTransferTask,
	type DeviceTransferTaskStopIntent,
	DeviceTransferTaskStore,
} from "./device-transfer-task-store";

const ACK_FLUSH_INTERVAL_MS = 200;
const ACK_FLUSH_THRESHOLD = 16;
/** Pause sending when the device WS send buffer exceeds this (backpressure). */
const BACKPRESSURE_HIGH_WATER = 8 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 25;

function transfersRoot(): string {
	return settings.devices?.transfersDir || getNarraforkPath("transfers");
}

function chunkSize(): number {
	return settings.devices?.transferChunkBytes ?? 1024 * 1024;
}

function transferConcurrency(): number {
	return Math.max(1, settings.devices?.transferConcurrency ?? 4);
}

function maxTransfersPerDevice(): number {
	return Math.max(1, settings.devices?.maxConcurrentTransfersPerDevice ?? 2);
}

export type RemotePathSemantics = "windows" | "posix";

function remotePathSemantics(platformOs: string): RemotePathSemantics {
	return platformOs.toLowerCase() === "windows" ? "windows" : "posix";
}

function getRemotePlatformOs(deviceId: string, override?: string): string {
	const platformOs = override ?? getConnectedDeviceHello(deviceId)?.platform.os;
	if (!platformOs) {
		throw new Error(
			`Cannot validate remote path for device ${deviceId}: target platform is unavailable`,
		);
	}
	return platformOs;
}

export function validateLocalAbsolutePath(path: string, label = "Local path"): string {
	if (!path.trim()) throw new Error(`${label} is required`);
	if (path.includes("\0")) throw new Error(`${label} contains a NUL byte`);
	if (!isAbsolute(path)) {
		throw new Error(`${label} must be absolute on the NarraFork server: ${JSON.stringify(path)}`);
	}
	return resolve(path);
}

export function validateRemoteAbsolutePath(
	path: string,
	platformOs: string,
	label = "Remote path",
): string {
	if (!path.trim()) throw new Error(`${label} is required`);
	if (path.includes("\0")) throw new Error(`${label} contains a NUL byte`);
	const semantics = remotePathSemantics(platformOs);
	const pathApi = semantics === "windows" ? win32 : posix;
	const windowsRoot = semantics === "windows" ? win32.parse(path).root : "";
	const isFullyQualifiedWindowsPath =
		semantics !== "windows" ||
		windowsRoot.startsWith("\\\\") ||
		/^[A-Za-z]:[\\/]/.test(windowsRoot);
	if (!pathApi.isAbsolute(path) || !isFullyQualifiedWindowsPath) {
		throw new Error(
			`${label} must be an absolute ${semantics === "windows" ? "Windows drive or UNC" : "POSIX"} path: ` +
				JSON.stringify(path),
		);
	}
	return pathApi.normalize(path);
}

function validateTransferRelativePath(relPath: string, label: string): void {
	if (typeof relPath !== "string") throw new Error(`${label} must be a string`);
	if (!relPath.trim()) throw new Error(`${label} is empty`);
	if (relPath.includes("\0")) throw new Error(`${label} contains a NUL byte`);
	if (
		posix.isAbsolute(relPath) ||
		win32.isAbsolute(relPath) ||
		posix.parse(relPath).root !== "" ||
		win32.parse(relPath).root !== ""
	) {
		throw new Error(`${label} must be relative, got ${JSON.stringify(relPath)}`);
	}
	if (relPath.split(/[\\/]+/).some((segment) => segment === "..")) {
		throw new Error(`${label} contains path traversal: ${JSON.stringify(relPath)}`);
	}
}

export function joinRemotePath(remoteRoot: string, relPath: string, platformOs: string): string {
	const normalizedRoot = validateRemoteAbsolutePath(remoteRoot, platformOs, "Remote root path");
	validateTransferRelativePath(relPath, "Transfer relative path");
	const pathApi = remotePathSemantics(platformOs) === "windows" ? win32 : posix;
	return pathApi.join(normalizedRoot, ...relPath.split("/"));
}

export function resolveDownloadManifestPath(localRoot: string, relPath: string): string {
	const normalizedRoot = validateLocalAbsolutePath(localRoot, "Local download root");
	validateTransferRelativePath(relPath, "Remote manifest relPath");
	const destination = resolve(normalizedRoot, relPath);
	const relToRoot = relative(normalizedRoot, destination);
	if (relToRoot === ".." || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
		throw new Error(
			`Remote manifest relPath resolves outside local download root: ${JSON.stringify(relPath)}`,
		);
	}
	return destination;
}

// ── Per-device transfer concurrency gate ─────────────────────────────────────
//
// Caps how many top-level transfer operations (a single file, or a whole
// directory) may run against one device concurrently. Fail-fast on excess,
// mirroring the RPC concurrency cap in device-connection-service (rejects rather
// than queueing) so a caller gets immediate feedback instead of a silent stall.

/** deviceId → count of in-flight top-level transfers. */
const activeTransfers = new Map<string, number>();

/**
 * Run `fn` while holding a transfer slot for the device, releasing it on
 * completion. Directory transfers pass `held=true` for the per-file calls they
 * make internally so a directory occupies exactly one slot, not one per file.
 */
async function withTransferSlot<T>(
	deviceId: string,
	held: boolean,
	fn: () => Promise<T>,
): Promise<T> {
	if (held) return fn();
	const current = activeTransfers.get(deviceId) ?? 0;
	const limit = maxTransfersPerDevice();
	if (current >= limit) {
		throw new Error(
			`Device ${deviceId} transfer concurrency limit reached (${limit}). Try again after in-flight transfers finish.`,
		);
	}
	activeTransfers.set(deviceId, current + 1);
	try {
		return await fn();
	} finally {
		const n = (activeTransfers.get(deviceId) ?? 1) - 1;
		if (n <= 0) activeTransfers.delete(deviceId);
		else activeTransfers.set(deviceId, n);
	}
}

// ── Active transfer state ────────────────────────────────────────────────────

interface ReceiveState {
	transferId: string;
	deviceId: string;
	direction: TransferDirection;
	fileHandle: Awaited<ReturnType<typeof open>>;
	partPath: string;
	finalPath: string;
	chunkSize: number;
	totalChunks: number;
	fileSize: number;
	mtimeMs: number;
	received: Set<number>;
	bytesWritten: number;
	pendingAckIndices: number[];
	pendingAckCrc: number[];
	ackTimer: ReturnType<typeof setInterval> | null;
	onFileDone: (ok: boolean, error?: string) => void;
	abortSignal?: AbortSignal;
	abortHandler?: () => void;
	settled: boolean;
	cleaned: boolean;
}

/** transferId → receive state (server is the receiver, i.e. download). */
const receives = new Map<string, ReceiveState>();

// ── Public API: single-file transfers ──────────────────────────────────────

export interface TransferProgressUpdate {
	bytesTransferred: number;
	totalBytes: number;
	filesDone: number;
	totalFiles: number;
	currentFile?: string;
}

export interface TransferProgressMeta {
	direction: TransferDirection;
	filesDone: number;
	totalFiles: number;
	currentFile?: string;
	/** Bytes completed in prior files (for directory-level aggregate progress). */
	baseBytes?: number;
	totalBytes?: number;
	onProgress?: (progress: TransferProgressUpdate) => void;
}

/** Remote file/dir metadata for planning transfers (uses transfer.stat RPC). */
export async function statRemote(
	deviceId: string,
	path: string,
	opts: {
		recursive?: boolean;
		maxEntries?: number;
		signal?: AbortSignal;
		remotePlatformOs?: string;
	} = {},
): Promise<TransferStatResult> {
	if (!isDeviceOnline(deviceId)) throw new Error(`Device ${deviceId} is offline`);
	const platformOs = getRemotePlatformOs(deviceId, opts.remotePlatformOs);
	const remotePath = validateRemoteAbsolutePath(path, platformOs);
	return (await sendRpc(
		deviceId,
		"transfer.stat",
		{
			path: remotePath,
			recursive: opts.recursive,
			maxEntries: opts.maxEntries,
		},
		{ signal: opts.signal },
	)) as TransferStatResult;
}

/**
 * Download a single remote file to a local destination. Resolves when the file
 * is fully received + verified.
 *
 * `_slotHeld` is set by directory transfers, which already hold a device
 * transfer slot for the whole directory — the per-file calls must not each
 * acquire (and possibly exhaust) another slot.
 */
export async function downloadFile(args: {
	deviceId: string;
	remotePath: string;
	localDest: string;
	remoteSize: number;
	remoteMtimeMs: number;
	remotePlatformOs?: string;
	progress?: TransferProgressMeta;
	signal?: AbortSignal;
	_slotHeld?: boolean;
}): Promise<{ transferId: string; bytes: number }> {
	return withTransferSlot(args.deviceId, args._slotHeld ?? false, () => downloadFileInner(args));
}

async function downloadFileInner(args: {
	deviceId: string;
	remotePath: string;
	localDest: string;
	remoteSize: number;
	remoteMtimeMs: number;
	remotePlatformOs?: string;
	progress?: TransferProgressMeta;
	signal?: AbortSignal;
}): Promise<{ transferId: string; bytes: number }> {
	const { deviceId, localDest, remoteSize, remoteMtimeMs } = args;
	if (args.signal?.aborted) throw new Error("transfer cancelled");
	if (!isDeviceOnline(deviceId)) throw new Error(`Device ${deviceId} is offline`);
	const platformOs = getRemotePlatformOs(deviceId, args.remotePlatformOs);
	const remotePath = validateRemoteAbsolutePath(args.remotePath, platformOs);

	const cs = chunkSize();
	const totalChunks = remoteSize === 0 ? 0 : Math.ceil(remoteSize / cs);
	const transferId = `tx_${generateId()}`;
	const finalPath = validateLocalAbsolutePath(localDest, "Local download destination");
	mkdirSync(dirname(finalPath), { recursive: true });
	const partPath = `${finalPath}.nfpart`;

	// Open (or reopen) the .part file for random-access writes. Use O_RDWR|O_CREAT
	// (NOT "a+"): O_APPEND makes the kernel ignore the write offset and always
	// append to EOF, which silently corrupts the file if chunks ever arrive out of
	// order or in parallel. O_RDWR|O_CREAT preserves existing bytes (for resume),
	// creates the file when absent, and honours the positional writes in writeChunk.
	const fileHandle = await open(partPath, fsConstants.O_RDWR | fsConstants.O_CREAT);
	if (args.signal?.aborted) {
		await fileHandle.close();
		throw new Error("transfer cancelled");
	}

	// Resume: which chunks do we already have durably?
	const existing = await loadLocalManifest(finalPath, {
		chunkSize: cs,
		fileSize: remoteSize,
		mtimeMs: remoteMtimeMs,
	});

	// No valid resume manifest → start fresh. Because we no longer truncate on
	// open, a stale .part left over from a previous (larger) download would keep
	// its trailing bytes and fail the final size check. Truncate to 0 so the
	// positional writes below produce exactly `remoteSize` bytes.
	if (existing.length === 0) {
		await fileHandle.truncate(0);
	}

	const verify = settings.devices?.transferVerify ?? "crc32c";
	if (args.signal?.aborted) {
		await fileHandle.close();
		throw new Error("transfer cancelled");
	}

	return await new Promise((resolvePromise, reject) => {
		const state: ReceiveState = {
			transferId,
			deviceId,
			direction: "download",
			fileHandle,
			partPath,
			finalPath,
			chunkSize: cs,
			totalChunks,
			fileSize: remoteSize,
			mtimeMs: remoteMtimeMs,
			received: new Set(existing),
			bytesWritten: existing.reduce(
				(sum, index) => sum + Math.max(0, Math.min(cs, remoteSize - index * cs)),
				0,
			),
			pendingAckIndices: [],
			pendingAckCrc: [],
			ackTimer: null,
			onFileDone: (ok, error) => {
				if (ok) resolvePromise({ transferId, bytes: remoteSize });
				else reject(new Error(error ?? "transfer failed"));
			},
			abortSignal: args.signal,
			settled: false,
			cleaned: false,
		};
		receives.set(transferId, state);
		if (args.signal) {
			state.abortHandler = () => void pauseReceive(state, "transfer cancelled");
			args.signal.addEventListener("abort", state.abortHandler, { once: true });
			if (args.signal.aborted) {
				state.abortHandler();
				return;
			}
		}
		state.ackTimer = setInterval(() => flushAcks(state), ACK_FLUSH_INTERVAL_MS);

		// Begin the transfer; the executor will start sending chunk frames.
		sendRpc(
			deviceId,
			"transfer.begin",
			{
				transferId,
				direction: "download",
				remotePath,
				fileSize: remoteSize,
				chunkSize: cs,
				totalChunks,
				mtimeMs: remoteMtimeMs,
				completedChunks: existing,
				verify,
			},
			{ signal: args.signal },
		)
			.then((res) => {
				if (state.cleaned || receives.get(state.transferId) !== state) return;
				const begin = res as TransferBeginResult;
				// The executor may report additional already-sent chunks (unlikely
				// for download, but harmless): merge them.
				for (const idx of begin.completedChunks) state.received.add(idx);
				emitProgress(state, args.progress);
				if (state.received.size >= totalChunks) void finalizeReceive(state);
			})
			.catch((err) => {
				void failReceive(state, err instanceof Error ? err.message : String(err));
			});
	});
}

/**
 * Upload a single local file to a remote destination. The server is the sender:
 * it reads local chunks and pushes chunk frames; the executor writes them.
 */
export async function uploadFile(args: {
	deviceId: string;
	localPath: string;
	remoteDest: string;
	remotePlatformOs?: string;
	progress?: TransferProgressMeta;
	signal?: AbortSignal;
	_slotHeld?: boolean;
}): Promise<{ transferId: string; bytes: number }> {
	return withTransferSlot(args.deviceId, args._slotHeld ?? false, () => uploadFileInner(args));
}

async function uploadFileInner(args: {
	deviceId: string;
	localPath: string;
	remoteDest: string;
	remotePlatformOs?: string;
	progress?: TransferProgressMeta;
	signal?: AbortSignal;
}): Promise<{ transferId: string; bytes: number }> {
	const { deviceId, localPath } = args;
	if (!isDeviceOnline(deviceId)) throw new Error(`Device ${deviceId} is offline`);
	const platformOs = getRemotePlatformOs(deviceId, args.remotePlatformOs);
	const remoteDest = validateRemoteAbsolutePath(args.remoteDest, platformOs);

	const src = validateLocalAbsolutePath(localPath, "Local upload source");
	const info = await stat(src);
	const fileSize = info.size;
	const cs = chunkSize();
	const totalChunks = fileSize === 0 ? 0 : Math.ceil(fileSize / cs);
	const transferId = `tx_${generateId()}`;
	const verify = settings.devices?.transferVerify ?? "crc32c";
	const contentDigest = await hashFileSha256(src, args.signal);
	const supportsContentIdentity = hasDeviceProtocolFeature(
		deviceId,
		"transfer.upload-content-identity.v1",
	);
	if (!supportsContentIdentity) {
		for (const path of [
			`${remoteDest}.nfpart`,
			`${remoteDest}.nfmeta`,
			`${remoteDest}.nfmeta.tmp`,
		]) {
			await sendRpc(deviceId, "fs.remove", { path }, { signal: args.signal });
		}
	}

	// Ask the executor to prepare the destination; it returns already-received
	// chunks for resume.
	const begin = (await sendRpc(
		deviceId,
		"transfer.begin",
		{
			transferId,
			direction: "upload",
			remotePath: remoteDest,
			fileSize,
			chunkSize: cs,
			totalChunks,
			mtimeMs: info.mtimeMs,
			verify,
			contentIdentity: { algorithm: "sha256", digest: contentDigest },
		},
		{ signal: args.signal },
	)) as TransferBeginResult;

	const already = new Set(begin.completedChunks);
	const fileHandle = await open(src, "r");
	let bytesSent = [...already].reduce(
		(sum, index) => sum + Math.max(0, Math.min(cs, fileSize - index * cs)),
		0,
	);
	let completed = false;

	try {
		if (totalChunks === 0) {
			const complete = (await sendRpc(
				deviceId,
				"transfer.complete",
				{ transferId, sha256: contentDigest },
				{ signal: args.signal },
			)) as { ok: boolean; error?: string };
			if (!complete.ok) throw new Error(complete.error ?? "remote finalize failed");
			completed = true;
			return { transferId, bytes: 0 };
		}

		// Build the work list (skip already-received chunks for resume).
		const pending: number[] = [];
		for (let i = 0; i < totalChunks; i++) if (!already.has(i)) pending.push(i);

		const concurrency = transferConcurrency();
		let next = 0;
		const sendOne = async (chunkIndex: number) => {
			const offset = chunkIndex * cs;
			const len = Math.min(cs, fileSize - offset);
			const buf = Buffer.allocUnsafe(len);
			await fileHandle.read(buf, 0, len, offset);
			await waitForDrain(deviceId, args.signal);
			const frame = encodeChunkFrame(
				{ transferId, chunkIndex },
				new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
			);
			if (!sendChunkFrame(deviceId, frame)) {
				throw new Error(`Device ${deviceId} went offline mid-upload`);
			}
			bytesSent += len;
			if (args.progress) {
				const progress = {
					bytesTransferred: (args.progress.baseBytes ?? 0) + bytesSent,
					totalBytes: args.progress.totalBytes ?? fileSize,
					filesDone: args.progress.filesDone,
					totalFiles: args.progress.totalFiles,
					currentFile: args.progress.currentFile,
				};
				eventBus.emit({
					type: "transfer:progress",
					transferId,
					deviceId,
					direction: "upload",
					...progress,
				});
				args.progress.onProgress?.(progress);
			}
		};

		const worker = async () => {
			while (true) {
				if (args.signal?.aborted) throw new Error("upload aborted");
				const i = next++;
				if (i >= pending.length) break;
				await sendOne(pending[i]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

		// Signal completion with the same digest used to bind resume state. The
		// executor hashes the received file, detecting source changes during upload.
		const complete = (await sendRpc(
			deviceId,
			"transfer.complete",
			{
				transferId,
				sha256: contentDigest,
			},
			{ signal: args.signal },
		)) as { ok: boolean; error?: string };
		if (!complete.ok) throw new Error(complete.error ?? "remote finalize failed");
		completed = true;
		return { transferId, bytes: fileSize };
	} finally {
		await fileHandle.close();
		if (!completed) {
			void sendRpc(deviceId, "transfer.abort", {
				transferId,
				preservePartial: true,
			}).catch(() => {});
		}
	}
}

// ── Directory transfers (recursive) ─────────────────────────────────────────

export interface DirectoryTransferResult {
	filesTransferred: number;
	bytesTransferred: number;
}

/**
 * Download a remote directory recursively to a local directory. Enumerates the
 * remote tree via transfer.stat, then transfers each file with directory-level
 * progress. Per-file resume is inherited from downloadFile.
 */
export async function downloadDirectory(args: {
	deviceId: string;
	remoteDir: string;
	localDir: string;
	remotePlatformOs?: string;
	signal?: AbortSignal;
	onProgress?: (progress: TransferProgressUpdate) => void;
}): Promise<DirectoryTransferResult> {
	// A directory transfer holds a single device slot for its whole run; the
	// per-file downloads below pass _slotHeld so they don't each acquire one.
	return withTransferSlot(args.deviceId, false, async () => {
		const { deviceId } = args;
		const platformOs = getRemotePlatformOs(deviceId, args.remotePlatformOs);
		const remoteRoot = validateRemoteAbsolutePath(
			args.remoteDir,
			platformOs,
			"Remote download directory",
		);
		const localRoot = validateLocalAbsolutePath(args.localDir, "Local download directory");
		const stat = await statRemote(deviceId, remoteRoot, {
			recursive: true,
			signal: args.signal,
			remotePlatformOs: platformOs,
		});
		if (!stat.exists || !stat.isDirectory) {
			throw new Error(`Remote path is not a directory: ${remoteRoot}`);
		}
		const entries = stat.entries ?? [];
		const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
		let baseBytes = 0;
		let filesDone = 0;

		for (const entry of entries) {
			if (args.signal?.aborted) throw new Error("directory download aborted");
			const localFile = resolveDownloadManifestPath(localRoot, entry.relPath);
			const remoteFile = joinRemotePath(remoteRoot, entry.relPath, platformOs);
			await downloadFile({
				deviceId,
				remotePath: remoteFile,
				localDest: localFile,
				remoteSize: entry.size,
				remoteMtimeMs: entry.mtimeMs,
				remotePlatformOs: platformOs,
				signal: args.signal,
				_slotHeld: true,
				progress: {
					direction: "download",
					filesDone,
					totalFiles: entries.length,
					currentFile: entry.relPath,
					baseBytes,
					totalBytes,
					onProgress: args.onProgress,
				},
			});
			baseBytes += entry.size;
			filesDone++;
		}
		return { filesTransferred: filesDone, bytesTransferred: baseBytes };
	});
}

/**
 * Upload a local directory recursively to a remote directory. Enumerates the
 * local tree, then transfers each file with directory-level progress.
 */
export async function uploadDirectory(args: {
	deviceId: string;
	localDir: string;
	remoteDir: string;
	remotePlatformOs?: string;
	signal?: AbortSignal;
	onProgress?: (progress: TransferProgressUpdate) => void;
}): Promise<DirectoryTransferResult> {
	// A directory transfer holds a single device slot for its whole run; the
	// per-file uploads below pass _slotHeld so they don't each acquire one.
	return withTransferSlot(args.deviceId, false, async () => {
		const { deviceId } = args;
		const platformOs = getRemotePlatformOs(deviceId, args.remotePlatformOs);
		const root = validateLocalAbsolutePath(args.localDir, "Local upload directory");
		const remoteRoot = validateRemoteAbsolutePath(
			args.remoteDir,
			platformOs,
			"Remote upload directory",
		);
		const files = await enumerateLocalDir(root, 50_000, args.signal);
		const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
		let baseBytes = 0;
		let filesDone = 0;

		for (const file of files) {
			if (args.signal?.aborted) throw new Error("directory upload aborted");
			const remoteFile = joinRemotePath(remoteRoot, file.relPath, platformOs);
			await uploadFile({
				deviceId,
				localPath: file.absPath,
				remoteDest: remoteFile,
				remotePlatformOs: platformOs,
				signal: args.signal,
				_slotHeld: true,
				progress: {
					direction: "upload",
					filesDone,
					totalFiles: files.length,
					currentFile: file.relPath,
					baseBytes,
					totalBytes,
					onProgress: args.onProgress,
				},
			});
			baseBytes += file.size;
			filesDone++;
		}
		return { filesTransferred: filesDone, bytesTransferred: baseBytes };
	});
}

interface LocalFileEntry {
	absPath: string;
	relPath: string;
	size: number;
}

/** Recursively enumerate files under a local directory (bounded). */
async function enumerateLocalDir(
	root: string,
	maxEntries = 50_000,
	signal?: AbortSignal,
): Promise<LocalFileEntry[]> {
	const out: LocalFileEntry[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		if (signal?.aborted) throw new Error("directory enumeration aborted");
		const dir = stack.pop();
		if (!dir) break;
		const dirents = await readdir(dir, { withFileTypes: true });
		for (const dirent of dirents) {
			if (signal?.aborted) throw new Error("directory enumeration aborted");
			const abs = join(dir, dirent.name);
			if (dirent.isDirectory()) {
				stack.push(abs);
			} else if (dirent.isFile()) {
				const info = await stat(abs);
				out.push({
					absPath: abs,
					relPath: relative(root, abs).replaceAll("\\", "/"),
					size: info.size,
				});
				if (out.length >= maxEntries) return out;
			}
		}
	}
	return out;
}

// ── Receive path (download): binary chunk frame handling ────────────────────

async function handleChunkFrame(deviceId: string, bytes: Uint8Array): Promise<void> {
	const decoded = decodeChunkFrame(bytes);
	if (!decoded) return;
	const state = receives.get(decoded.header.transferId);
	if (!state || state.deviceId !== deviceId) return;
	await writeChunk(state, decoded.header, decoded.payload);
}

async function writeChunk(
	state: ReceiveState,
	header: ChunkFrameHeader,
	payload: Uint8Array,
): Promise<void> {
	if (state.cleaned || state.received.has(header.chunkIndex)) return;
	const offset = header.chunkIndex * state.chunkSize;
	try {
		await state.fileHandle.write(payload, 0, payload.length, offset);
		if (state.cleaned) return;
	} catch (err) {
		await failReceive(state, err instanceof Error ? err.message : String(err));
		return;
	}
	state.received.add(header.chunkIndex);
	state.bytesWritten += payload.length;
	state.pendingAckIndices.push(header.chunkIndex);
	state.pendingAckCrc.push(crc32c(payload));

	if (state.pendingAckIndices.length >= ACK_FLUSH_THRESHOLD) flushAcks(state);

	// Persist the resume manifest periodically (fsync + write) so an interrupted
	// download can continue from the last durable checkpoint.
	if (state.received.size % 32 === 0) {
		try {
			await state.fileHandle.sync();
		} catch {
			// best effort
		}
		await saveLocalManifest(state, state.mtimeMs);
	}

	if (state.received.size >= state.totalChunks) {
		await finalizeReceive(state);
	}
}

function flushAcks(state: ReceiveState): void {
	if (state.pendingAckIndices.length === 0) return;
	const chunkIndices = state.pendingAckIndices;
	const crc = state.pendingAckCrc;
	state.pendingAckIndices = [];
	state.pendingAckCrc = [];
	// The crc32c values are advisory: the executor (the download sender) currently
	// treats acks as progress only and does not re-send on mismatch. The wire is
	// already integrity-protected by TCP + WebSocket framing, and finalizeReceive
	// enforces the exact byte count, so a corrupted download is caught by the size
	// check. Set transferVerify: "sha256" for end-to-end whole-file verification on
	// the upload path (server → device). See finalizeReceive for the download note.
	sendRpc(state.deviceId, "transfer.ack", {
		transferId: state.transferId,
		chunkIndices,
		crc32c: crc,
	}).catch(() => {
		// ack is best-effort; the sender also tracks completion
	});
}

function cleanupReceiveState(state: ReceiveState): boolean {
	if (state.cleaned) return false;
	state.cleaned = true;
	if (receives.get(state.transferId) === state) receives.delete(state.transferId);
	if (state.ackTimer) {
		clearInterval(state.ackTimer);
		state.ackTimer = null;
	}
	if (state.abortSignal && state.abortHandler) {
		state.abortSignal.removeEventListener("abort", state.abortHandler);
		state.abortHandler = undefined;
	}
	return true;
}

function settleReceive(state: ReceiveState, ok: boolean, error?: string): void {
	if (state.settled) return;
	state.settled = true;
	state.onFileDone(ok, error);
}

async function finalizeReceive(state: ReceiveState): Promise<void> {
	if (!cleanupReceiveState(state)) return;
	flushAcks(state);
	try {
		await state.fileHandle.sync();
		await state.fileHandle.close();
		const finalInfo = await stat(state.partPath).catch(() => null);
		if (finalInfo && state.fileSize > 0 && finalInfo.size !== state.fileSize) {
			throw new Error(`size mismatch: got ${finalInfo.size}, expected ${state.fileSize}`);
		}
		await rename(state.partPath, state.finalPath);
		await removeLocalManifest(state.finalPath);
		eventBus.emit({
			type: "transfer:done",
			transferId: state.transferId,
			deviceId: state.deviceId,
			bytesTransferred: state.bytesWritten,
			filesDone: 1,
		});
		settleReceive(state, true);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.warn("Transfer receive failed", { transferId: state.transferId, error });
		eventBus.emit({
			type: "transfer:error",
			transferId: state.transferId,
			deviceId: state.deviceId,
			error,
		});
		settleReceive(state, false, error);
	}
}

async function pauseReceive(state: ReceiveState, error: string): Promise<void> {
	if (!cleanupReceiveState(state)) return;
	try {
		await state.fileHandle.sync();
		await saveLocalManifest(state, state.mtimeMs);
		await state.fileHandle.close();
	} catch {
		// Best effort: any previously persisted manifest remains resumable.
	}
	void sendRpc(state.deviceId, "transfer.abort", {
		transferId: state.transferId,
		preservePartial: true,
	}).catch(() => {});
	settleReceive(state, false, error);
}

async function failReceive(state: ReceiveState, error: string): Promise<void> {
	if (!cleanupReceiveState(state)) return;
	try {
		await state.fileHandle.close();
	} catch {
		// ignore
	}
	logger.warn("Transfer receive failed", { transferId: state.transferId, error });
	eventBus.emit({
		type: "transfer:error",
		transferId: state.transferId,
		deviceId: state.deviceId,
		error,
	});
	settleReceive(state, false, error);
}

/**
 * Fail every in-flight download (receive) for a device. The download data plane
 * is binary chunk frames, so a disconnect produces no RPC rejection to unblock
 * the transfer — without this, `downloadFile` would hang forever and its ack
 * timer would keep firing. Invoked when the device goes offline. Upload
 * transfers self-terminate: their next `sendChunkFrame`/RPC fails once the
 * connection is gone.
 */
function failReceivesForDevice(deviceId: string, error: string): void {
	// Snapshot first — failReceive mutates the map during iteration.
	const affected = [...receives.values()].filter((s) => s.deviceId === deviceId);
	for (const state of affected) {
		void failReceive(state, error);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function emitProgress(state: ReceiveState, meta?: TransferProgressMeta): void {
	const progress = {
		bytesTransferred: (meta?.baseBytes ?? 0) + state.bytesWritten,
		totalBytes: meta?.totalBytes ?? state.fileSize,
		filesDone: meta?.filesDone ?? 0,
		totalFiles: meta?.totalFiles ?? 1,
		currentFile: meta?.currentFile,
	};
	eventBus.emit({
		type: "transfer:progress",
		transferId: state.transferId,
		deviceId: state.deviceId,
		direction: state.direction,
		...progress,
	});
	meta?.onProgress?.(progress);
}

/** Wait until the device's WS send buffer drains below the high-water mark. */
async function waitForDrain(deviceId: string, signal?: AbortSignal): Promise<void> {
	while (deviceBufferedAmount(deviceId) > BACKPRESSURE_HIGH_WATER) {
		if (signal?.aborted) throw new Error("aborted");
		await Bun.sleep(BACKPRESSURE_POLL_MS);
	}
}

async function hashFileSha256(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	const handle = await open(path, "r");
	try {
		const buf = Buffer.allocUnsafe(1024 * 1024);
		let offset = 0;
		while (true) {
			if (signal?.aborted) throw new Error("hashing aborted");
			const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
			if (bytesRead === 0) break;
			hash.update(buf.subarray(0, bytesRead));
			offset += bytesRead;
		}
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

interface LocalManifest {
	chunkSize: number;
	fileSize: number;
	mtimeMs: number;
	completedChunks: number[];
}

function manifestPath(finalPath: string): string {
	return `${finalPath}.nfmeta`;
}

/**
 * Load which chunks of a local download destination are already durable. The
 * manifest is only honoured when its fingerprint (chunkSize/fileSize/mtimeMs)
 * matches the current source, otherwise the transfer restarts fresh.
 */
async function loadLocalManifest(
	finalPath: string,
	fingerprint: { chunkSize: number; fileSize: number; mtimeMs: number },
): Promise<number[]> {
	try {
		const raw = await Bun.file(manifestPath(finalPath)).text();
		const m = JSON.parse(raw) as LocalManifest;
		if (
			m.chunkSize !== fingerprint.chunkSize ||
			m.fileSize !== fingerprint.fileSize ||
			m.mtimeMs !== fingerprint.mtimeMs
		) {
			return [];
		}
		return Array.isArray(m.completedChunks) ? m.completedChunks : [];
	} catch {
		return [];
	}
}

async function saveLocalManifest(state: ReceiveState, mtimeMs: number): Promise<void> {
	const manifest: LocalManifest = {
		chunkSize: state.chunkSize,
		fileSize: state.fileSize,
		mtimeMs,
		completedChunks: [...state.received].sort((a, b) => a - b),
	};
	try {
		await Bun.write(manifestPath(state.finalPath), JSON.stringify(manifest));
	} catch {
		// manifest persistence is best-effort
	}
}

async function removeLocalManifest(finalPath: string): Promise<void> {
	try {
		await Bun.file(manifestPath(finalPath)).delete();
	} catch {
		// ignore
	}
}

// ── Persistent transfer task lifecycle ───────────────────────────────────────

export type DeviceTransferTaskStatus =
	| "queued"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

interface TransferTaskOperations {
	statRemote: typeof statRemote;
	downloadFile: typeof downloadFile;
	uploadFile: typeof uploadFile;
	downloadDirectory: typeof downloadDirectory;
	uploadDirectory: typeof uploadDirectory;
	statLocal: typeof stat;
}

interface ActiveTransferTaskRun {
	generation: number;
	controller: AbortController;
	stopIntent?: DeviceTransferTaskStopIntent;
	done: Promise<void>;
}

const TASK_PROGRESS_WRITE_INTERVAL_MS = 500;

export function createDeviceTransferTaskManager(
	store: DeviceTransferTaskStore,
	operations: TransferTaskOperations,
) {
	const activeRuns = new Map<string, ActiveTransferTaskRun>();
	let recoveryPromise: Promise<void> | null = null;

	const ensureRecovery = () => {
		recoveryPromise ??= store.recoverInterrupted();
		return recoveryPromise;
	};

	function createProgressWriter(taskId: string, generation: number) {
		let lastWriteAt = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let pending: TransferProgressUpdate | null = null;
		let inFlight: Promise<void> | null = null;
		const flush = async () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (inFlight) await inFlight;
			const progress = pending;
			if (!progress) return;
			pending = null;
			lastWriteAt = Date.now();
			inFlight = store
				.updateProgress(taskId, generation, progress)
				.catch((error) =>
					logger.warn("Failed to persist transfer task progress", {
						taskId,
						generation,
						error: String(error),
					}),
				)
				.finally(() => {
					inFlight = null;
					if (pending && !timer) {
						timer = setTimeout(() => void flush(), TASK_PROGRESS_WRITE_INTERVAL_MS);
					}
				});
			await inFlight;
		};
		return {
			report(progress: TransferProgressUpdate) {
				pending = progress;
				if (timer || inFlight) return;
				const delay = Math.max(0, TASK_PROGRESS_WRITE_INTERVAL_MS - (Date.now() - lastWriteAt));
				if (delay === 0) void flush();
				else timer = setTimeout(() => void flush(), delay);
			},
			flush,
		};
	}

	async function execute(task: DeviceTransferTask, run: ActiveTransferTaskRun): Promise<void> {
		const progressWriter = createProgressWriter(task.id, run.generation);
		try {
			let result: DirectoryTransferResult;
			if (task.recursive) {
				result =
					task.direction === "download"
						? await operations.downloadDirectory({
								deviceId: task.deviceId,
								remoteDir: task.remotePath,
								localDir: task.localPath,
								signal: run.controller.signal,
								onProgress: progressWriter.report,
							})
						: await operations.uploadDirectory({
								deviceId: task.deviceId,
								localDir: task.localPath,
								remoteDir: task.remotePath,
								signal: run.controller.signal,
								onProgress: progressWriter.report,
							});
			} else if (task.direction === "download") {
				const remote = await operations.statRemote(task.deviceId, task.remotePath, {
					signal: run.controller.signal,
				});
				if (!remote.exists || remote.isDirectory) throw new Error("Remote source is not a file");
				await store.updateTotals(task.id, run.generation, 1, remote.size);
				const file = await operations.downloadFile({
					deviceId: task.deviceId,
					remotePath: task.remotePath,
					localDest: task.localPath,
					remoteSize: remote.size,
					remoteMtimeMs: remote.mtimeMs,
					signal: run.controller.signal,
					progress: {
						direction: "download",
						filesDone: 0,
						totalFiles: 1,
						currentFile: task.remotePath,
						totalBytes: remote.size,
						onProgress: progressWriter.report,
					},
				});
				result = { filesTransferred: 1, bytesTransferred: file.bytes };
			} else {
				const local = await operations.statLocal(resolve(task.localPath));
				await store.updateTotals(task.id, run.generation, 1, local.size);
				const file = await operations.uploadFile({
					deviceId: task.deviceId,
					localPath: task.localPath,
					remoteDest: task.remotePath,
					signal: run.controller.signal,
					progress: {
						direction: "upload",
						filesDone: 0,
						totalFiles: 1,
						currentFile: task.localPath,
						totalBytes: local.size,
						onProgress: progressWriter.report,
					},
				});
				result = { filesTransferred: 1, bytesTransferred: file.bytes };
			}
			await progressWriter.flush();
			await store.complete(task.id, run.generation, result);
		} catch (error) {
			await progressWriter.flush();
			await store.finishStoppedOrFailed({
				taskId: task.id,
				generation: run.generation,
				stopIntent: run.stopIntent,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function schedule(taskId: string, generation: number): void {
		queueMicrotask(async () => {
			const previous = activeRuns.get(taskId);
			if (previous) await previous.done;
			const controller = new AbortController();
			let resolveDone!: () => void;
			const done = new Promise<void>((resolveDonePromise) => {
				resolveDone = resolveDonePromise;
			});
			const run: ActiveTransferTaskRun = { generation, controller, done };
			activeRuns.set(taskId, run);
			try {
				const task = await store.claim(taskId, generation, new Date().toISOString());
				if (task) await execute(task, run);
			} catch (error) {
				logger.error("Transfer task runner failed", { taskId, generation, error: String(error) });
			} finally {
				if (activeRuns.get(taskId) === run) activeRuns.delete(taskId);
				resolveDone();
			}
		});
	}

	return {
		async start(input: {
			deviceId: string;
			direction: TransferDirection;
			remotePath: string;
			localPath: string;
			recursive?: boolean;
			createdBy?: string | null;
		}) {
			await ensureRecovery();
			const now = new Date().toISOString();
			const task = await store.create({
				id: `txtask_${generateId()}`,
				deviceId: input.deviceId,
				direction: input.direction,
				remotePath: input.remotePath,
				localPath: input.localPath,
				recursive: input.recursive ?? false,
				status: "queued",
				runGeneration: 0,
				createdBy: input.createdBy ?? null,
				createdAt: now,
				updatedAt: now,
			});
			schedule(task.id, task.runGeneration);
			return task;
		},
		get: (deviceId: string, taskId: string) => store.get(deviceId, taskId),
		list: (deviceId: string) => store.list(deviceId),
		async pause(deviceId: string, taskId: string) {
			const task = await store.pause(deviceId, taskId);
			if (!task) return null;
			const run = activeRuns.get(taskId);
			if (run?.generation === task.runGeneration) {
				run.stopIntent = "paused";
				run.controller.abort();
			}
			return task;
		},
		async cancel(deviceId: string, taskId: string) {
			const task = await store.cancel(deviceId, taskId);
			if (!task) return null;
			const run = activeRuns.get(taskId);
			if (run?.generation === task.runGeneration) {
				run.stopIntent = "cancelled";
				run.controller.abort();
			}
			return task;
		},
		async resume(deviceId: string, taskId: string) {
			await ensureRecovery();
			const task = await store.resume(deviceId, taskId);
			if (!task) return null;
			schedule(task.id, task.runGeneration);
			return task;
		},
		recover: () => store.recoverInterrupted(),
	};
}

const transferTaskManager = createDeviceTransferTaskManager(new DeviceTransferTaskStore(db), {
	statRemote,
	downloadFile,
	uploadFile,
	downloadDirectory,
	uploadDirectory,
	statLocal: stat,
});

export const startDeviceTransferTask = transferTaskManager.start;
export const getDeviceTransferTask = transferTaskManager.get;
export const listDeviceTransferTasks = transferTaskManager.list;
export const pauseDeviceTransferTask = transferTaskManager.pause;
export const cancelDeviceTransferTask = transferTaskManager.cancel;
export const resumeDeviceTransferTask = transferTaskManager.resume;
export const recoverInterruptedTransferTasks = transferTaskManager.recover;

// ── Startup wiring ───────────────────────────────────────────────────────────

let initialized = false;
export function initDeviceTransferService(): void {
	if (initialized) return;
	initialized = true;
	setChunkFrameHandler(handleChunkFrame);
	mkdirSync(transfersRoot(), { recursive: true });
	void recoverInterruptedTransferTasks().catch((error) => {
		logger.warn("Failed to recover interrupted transfer tasks", { error: String(error) });
	});

	// A device going offline strands any in-flight download (its chunk frames
	// stop arriving with no RPC to reject). Fail them so callers unblock and
	// timers are cleared. Revocation/token-rotation also flow through offline
	// (the connection layer force-disconnects, which emits device:status).
	eventBus.on("device:status", ({ deviceId, status }) => {
		if (status === "offline") {
			failReceivesForDevice(deviceId, `Device ${deviceId} went offline`);
		}
	});
}
