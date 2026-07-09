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
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
import { settings } from "../lib/settings";
import {
	deviceBufferedAmount,
	isDeviceOnline,
	sendChunkFrame,
	sendRpc,
	setChunkFrameHandler,
} from "./device-connection-service";

const ACK_FLUSH_INTERVAL_MS = 200;
const ACK_FLUSH_THRESHOLD = 16;
/** Pause sending when the device WS send buffer exceeds this (backpressure). */
const BACKPRESSURE_HIGH_WATER = 8 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 25;

function transfersRoot(): string {
	return settings.devices?.transfersDir || resolve(homedir(), ".narrafork", "transfers");
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
}

/** transferId → receive state (server is the receiver, i.e. download). */
const receives = new Map<string, ReceiveState>();

// ── Public API: single-file transfers ──────────────────────────────────────

export interface TransferProgressMeta {
	direction: TransferDirection;
	filesDone: number;
	totalFiles: number;
	currentFile?: string;
	/** Bytes completed in prior files (for directory-level aggregate progress). */
	baseBytes?: number;
	totalBytes?: number;
}

/** Remote file/dir metadata for planning transfers (uses transfer.stat RPC). */
export async function statRemote(
	deviceId: string,
	path: string,
	opts: { recursive?: boolean; maxEntries?: number } = {},
): Promise<TransferStatResult> {
	if (!isDeviceOnline(deviceId)) throw new Error(`Device ${deviceId} is offline`);
	return (await sendRpc(deviceId, "transfer.stat", {
		path,
		recursive: opts.recursive,
		maxEntries: opts.maxEntries,
	})) as TransferStatResult;
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
	progress?: TransferProgressMeta;
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
	progress?: TransferProgressMeta;
}): Promise<{ transferId: string; bytes: number }> {
	const { deviceId, remotePath, localDest, remoteSize, remoteMtimeMs } = args;
	if (!isDeviceOnline(deviceId)) throw new Error(`Device ${deviceId} is offline`);

	const cs = chunkSize();
	const totalChunks = remoteSize === 0 ? 0 : Math.ceil(remoteSize / cs);
	const transferId = `tx_${generateId()}`;
	const finalPath = resolve(localDest);
	mkdirSync(dirname(finalPath), { recursive: true });
	const partPath = `${finalPath}.nfpart`;

	// Open (or reopen) the .part file for random-access writes. Use O_RDWR|O_CREAT
	// (NOT "a+"): O_APPEND makes the kernel ignore the write offset and always
	// append to EOF, which silently corrupts the file if chunks ever arrive out of
	// order or in parallel. O_RDWR|O_CREAT preserves existing bytes (for resume),
	// creates the file when absent, and honours the positional writes in writeChunk.
	const fileHandle = await open(partPath, fsConstants.O_RDWR | fsConstants.O_CREAT);

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
			bytesWritten: existing.length * cs,
			pendingAckIndices: [],
			pendingAckCrc: [],
			ackTimer: null,
			onFileDone: (ok, error) => {
				if (ok) resolvePromise({ transferId, bytes: remoteSize });
				else reject(new Error(error ?? "transfer failed"));
			},
		};
		receives.set(transferId, state);
		state.ackTimer = setInterval(() => flushAcks(state), ACK_FLUSH_INTERVAL_MS);

		// Begin the transfer; the executor will start sending chunk frames.
		sendRpc(deviceId, "transfer.begin", {
			transferId,
			direction: "download",
			remotePath,
			fileSize: remoteSize,
			chunkSize: cs,
			totalChunks,
			mtimeMs: remoteMtimeMs,
			verify,
		})
			.then((res) => {
				const begin = res as TransferBeginResult;
				// The executor may report additional already-sent chunks (unlikely
				// for download, but harmless): merge them.
				for (const idx of begin.completedChunks) state.received.add(idx);
				emitProgress(state, args.progress);
				// Empty file: complete immediately.
				if (totalChunks === 0) void finalizeReceive(state);
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
	progress?: TransferProgressMeta;
	signal?: AbortSignal;
}): Promise<{ transferId: string; bytes: number }> {
	const { deviceId, localPath, remoteDest } = args;
	if (!isDeviceOnline(deviceId)) throw new Error(`Device ${deviceId} is offline`);

	const src = resolve(localPath);
	const info = await stat(src);
	const fileSize = info.size;
	const cs = chunkSize();
	const totalChunks = fileSize === 0 ? 0 : Math.ceil(fileSize / cs);
	const transferId = `tx_${generateId()}`;
	const verify = settings.devices?.transferVerify ?? "crc32c";

	// Ask the executor to prepare the destination; it returns already-received
	// chunks for resume.
	const begin = (await sendRpc(deviceId, "transfer.begin", {
		transferId,
		direction: "upload",
		remotePath: remoteDest,
		fileSize,
		chunkSize: cs,
		totalChunks,
		mtimeMs: info.mtimeMs,
		verify,
	})) as TransferBeginResult;

	const already = new Set(begin.completedChunks);
	const fileHandle = await open(src, "r");
	let bytesSent = already.size * cs;

	try {
		if (totalChunks === 0) {
			await sendRpc(deviceId, "transfer.complete", { transferId });
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
				eventBus.emit({
					type: "transfer:progress",
					transferId,
					deviceId,
					direction: "upload",
					bytesTransferred: (args.progress.baseBytes ?? 0) + bytesSent,
					totalBytes: args.progress.totalBytes ?? fileSize,
					filesDone: args.progress.filesDone,
					totalFiles: args.progress.totalFiles,
					currentFile: args.progress.currentFile,
				});
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

		// Signal completion; the executor finalizes (rename + verify).
		const sha256 = verify === "sha256" ? await hashFileSha256(src) : undefined;
		const complete = (await sendRpc(deviceId, "transfer.complete", {
			transferId,
			sha256,
		})) as { ok: boolean; error?: string };
		if (!complete.ok) throw new Error(complete.error ?? "remote finalize failed");
		return { transferId, bytes: fileSize };
	} finally {
		await fileHandle.close();
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
	signal?: AbortSignal;
}): Promise<DirectoryTransferResult> {
	// A directory transfer holds a single device slot for its whole run; the
	// per-file downloads below pass _slotHeld so they don't each acquire one.
	return withTransferSlot(args.deviceId, false, async () => {
		const { deviceId, remoteDir, localDir } = args;
		const stat = await statRemote(deviceId, remoteDir, { recursive: true });
		if (!stat.exists || !stat.isDirectory) {
			throw new Error(`Remote path is not a directory: ${remoteDir}`);
		}
		const entries = stat.entries ?? [];
		const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
		let baseBytes = 0;
		let filesDone = 0;

		for (const entry of entries) {
			if (args.signal?.aborted) throw new Error("directory download aborted");
			const remoteFile = `${remoteDir.replace(/\/+$/, "")}/${entry.relPath}`;
			const localFile = join(localDir, entry.relPath);
			await downloadFile({
				deviceId,
				remotePath: remoteFile,
				localDest: localFile,
				remoteSize: entry.size,
				remoteMtimeMs: entry.mtimeMs,
				_slotHeld: true,
				progress: {
					direction: "download",
					filesDone,
					totalFiles: entries.length,
					currentFile: entry.relPath,
					baseBytes,
					totalBytes,
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
	signal?: AbortSignal;
}): Promise<DirectoryTransferResult> {
	// A directory transfer holds a single device slot for its whole run; the
	// per-file uploads below pass _slotHeld so they don't each acquire one.
	return withTransferSlot(args.deviceId, false, async () => {
		const { deviceId, localDir, remoteDir } = args;
		const root = resolve(localDir);
		const files = await enumerateLocalDir(root);
		const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
		let baseBytes = 0;
		let filesDone = 0;

		for (const file of files) {
			if (args.signal?.aborted) throw new Error("directory upload aborted");
			const remoteFile = `${remoteDir.replace(/\/+$/, "")}/${file.relPath}`;
			await uploadFile({
				deviceId,
				localPath: file.absPath,
				remoteDest: remoteFile,
				signal: args.signal,
				_slotHeld: true,
				progress: {
					direction: "upload",
					filesDone,
					totalFiles: files.length,
					currentFile: file.relPath,
					baseBytes,
					totalBytes,
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
async function enumerateLocalDir(root: string, maxEntries = 50_000): Promise<LocalFileEntry[]> {
	const out: LocalFileEntry[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		const dirents = await readdir(dir, { withFileTypes: true });
		for (const dirent of dirents) {
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

function handleChunkFrame(deviceId: string, bytes: Uint8Array): void {
	const decoded = decodeChunkFrame(bytes);
	if (!decoded) return;
	const state = receives.get(decoded.header.transferId);
	if (!state || state.deviceId !== deviceId) return;
	void writeChunk(state, decoded.header, decoded.payload);
}

async function writeChunk(
	state: ReceiveState,
	header: ChunkFrameHeader,
	payload: Uint8Array,
): Promise<void> {
	if (state.received.has(header.chunkIndex)) return; // duplicate
	const offset = header.chunkIndex * state.chunkSize;
	try {
		await state.fileHandle.write(payload, 0, payload.length, offset);
	} catch (err) {
		void failReceive(state, err instanceof Error ? err.message : String(err));
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
		void finalizeReceive(state);
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

async function finalizeReceive(state: ReceiveState): Promise<void> {
	if (!receives.has(state.transferId)) return;
	flushAcks(state);
	if (state.ackTimer) clearInterval(state.ackTimer);
	try {
		await state.fileHandle.sync();
		await state.fileHandle.close();
		// Whole-file verification on download (device → server) is intentionally
		// limited to the byte-count check below. Strong sha256 verification would
		// require the executor to send the source file's hash (a protocol addition
		// not yet implemented), so even with verify === "sha256" we cannot compare
		// one here. Transport integrity (TCP + WS) plus the exact-size check catch
		// truncation/corruption in practice; sha256 is fully enforced on the upload
		// path where the server computes and the executor verifies the hash.
		const finalInfo = await stat(state.partPath).catch(() => null);
		if (finalInfo && state.fileSize > 0 && finalInfo.size !== state.fileSize) {
			throw new Error(`size mismatch: got ${finalInfo.size}, expected ${state.fileSize}`);
		}
		await rename(state.partPath, state.finalPath);
		await removeLocalManifest(state.finalPath);
		receives.delete(state.transferId);
		eventBus.emit({
			type: "transfer:done",
			transferId: state.transferId,
			deviceId: state.deviceId,
			bytesTransferred: state.bytesWritten,
			filesDone: 1,
		});
		state.onFileDone(true);
	} catch (err) {
		await failReceive(state, err instanceof Error ? err.message : String(err));
	}
}

async function failReceive(state: ReceiveState, error: string): Promise<void> {
	if (!receives.has(state.transferId)) return;
	if (state.ackTimer) clearInterval(state.ackTimer);
	receives.delete(state.transferId);
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
	state.onFileDone(false, error);
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
	eventBus.emit({
		type: "transfer:progress",
		transferId: state.transferId,
		deviceId: state.deviceId,
		direction: state.direction,
		bytesTransferred: (meta?.baseBytes ?? 0) + state.bytesWritten,
		totalBytes: meta?.totalBytes ?? state.fileSize,
		filesDone: meta?.filesDone ?? 0,
		totalFiles: meta?.totalFiles ?? 1,
		currentFile: meta?.currentFile,
	});
}

/** Wait until the device's WS send buffer drains below the high-water mark. */
async function waitForDrain(deviceId: string, signal?: AbortSignal): Promise<void> {
	while (deviceBufferedAmount(deviceId) > BACKPRESSURE_HIGH_WATER) {
		if (signal?.aborted) throw new Error("aborted");
		await Bun.sleep(BACKPRESSURE_POLL_MS);
	}
}

async function hashFileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	const handle = await open(path, "r");
	try {
		const buf = Buffer.allocUnsafe(1024 * 1024);
		let offset = 0;
		while (true) {
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

// ── Startup wiring ───────────────────────────────────────────────────────────

let initialized = false;
export function initDeviceTransferService(): void {
	if (initialized) return;
	initialized = true;
	setChunkFrameHandler(handleChunkFrame);
	mkdirSync(transfersRoot(), { recursive: true });

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
