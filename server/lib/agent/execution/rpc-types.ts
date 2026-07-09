/**
 * RPC protocol between the NarraFork server and a remote executor device.
 *
 * The server sends `RpcRequest` frames over the device WebSocket; the executor
 * replies with `RpcStream` frames (0..n, for streaming output) followed by
 * exactly one terminal `RpcResult` frame. All frames are JSON.
 *
 * The Go executor mirrors these shapes exactly. Keep this file free of runtime
 * dependencies so it can be imported by both the backend and tests, and treat
 * it as the single source of truth for the wire contract. Bump PROTOCOL_VERSION
 * on any breaking change.
 */

export const DEVICE_PROTOCOL_VERSION = 1;

// ── Handshake ────────────────────────────────────────────────────────────────

/** First frame the executor sends after the WS opens (reverse mode) or after
 *  the server dials it (direct mode). Authenticates + advertises capabilities. */
export interface DeviceHelloFrame {
	type: "hello";
	protocolVersion: number;
	/** Device slug or id, used to look up the record. */
	deviceRef: string;
	/** Registration token (reverse mode). Omitted in direct mode where the
	 *  server already authenticated by dialing a trusted URL. */
	token?: string;
	agentVersion: string;
	platform: {
		os: string;
		arch: string;
		shellPath?: string;
		shellType?: string;
		shellLoginWrap?: boolean;
	};
	defaultCwd?: string;
	capabilities: {
		git: boolean;
		ripgrep: boolean;
		pty: boolean;
		[key: string]: unknown;
	};
}

/** Server's reply to a hello — accept or reject. */
export interface DeviceHelloAckFrame {
	type: "hello_ack";
	ok: boolean;
	/** Reason when ok === false. */
	error?: string;
	/** Server-assigned session id (for logging/correlation). */
	sessionId?: string;
	/** Effective limits the executor must honour. */
	limits?: {
		maxRpcBytes: number;
		rpcTimeoutMs: number;
	};
}

// ── RPC methods ──────────────────────────────────────────────────────────────

export type RpcMethod =
	| "fs.stat"
	| "fs.read"
	| "fs.write"
	| "fs.mkdirp"
	| "fs.list"
	| "fs.exists"
	| "glob"
	| "grep"
	| "exec.start"
	| "exec.kill"
	| "git.status"
	| "git.diff"
	| "pty.open"
	| "pty.write"
	| "pty.resize"
	| "pty.kill"
	| "transfer.begin"
	| "transfer.stat"
	| "transfer.ack"
	| "transfer.complete"
	| "transfer.abort";

export interface RpcRequestFrame {
	type: "rpc";
	id: string;
	method: RpcMethod;
	params: Record<string, unknown>;
}

/** Streaming chunk for long-running methods (exec output). Base64 for bytes. */
export interface RpcStreamFrame {
	type: "rpc_stream";
	id: string;
	/** "stdout" | "stderr" for exec; other methods may omit. */
	channel?: string;
	/** Base64-encoded bytes. */
	chunkB64: string;
}

export interface RpcResultFrame {
	type: "rpc_result";
	id: string;
	ok: boolean;
	/** Method-specific result payload (see result interfaces below). */
	result?: unknown;
	/** Error message when ok === false. */
	error?: string;
}

/** Control frame the server sends to abort an in-flight exec RPC. */
export interface RpcCancelFrame {
	type: "rpc_cancel";
	id: string;
}

/** Liveness. */
export interface DevicePingFrame {
	type: "ping";
}
export interface DevicePongFrame {
	type: "pong";
}

export type ServerToDeviceFrame =
	| DeviceHelloAckFrame
	| RpcRequestFrame
	| RpcCancelFrame
	| DevicePingFrame
	| DevicePongFrame;

export type DeviceToServerFrame =
	| DeviceHelloFrame
	| RpcStreamFrame
	| RpcResultFrame
	| DevicePingFrame
	| DevicePongFrame;

// ── Method param/result payloads ───────────────────────────────────────────

export interface FsStatParams {
	path: string;
}
export interface FsStatResult {
	exists: boolean;
	isDirectory: boolean;
	isFile: boolean;
	size: number;
}

export interface FsReadParams {
	path: string;
	maxBytes?: number;
}
export interface FsReadResult {
	/** Base64-encoded file bytes (possibly truncated). */
	dataB64: string;
	truncated: boolean;
	totalSize: number;
}

export interface FsWriteParams {
	path: string;
	/** Base64-encoded content. */
	dataB64: string;
}

export interface FsMkdirpParams {
	path: string;
}

export interface FsListParams {
	path: string;
}
export interface FsListResult {
	entries: Array<{ name: string; isDirectory: boolean }>;
}

export interface FsExistsParams {
	path: string;
}
export interface FsExistsResult {
	exists: boolean;
}

export interface GlobParams {
	pattern: string;
	cwd: string;
	dot?: boolean;
	maxResults?: number;
}
export interface GlobResult {
	matches: string[];
}

export interface GrepRpcParams {
	pattern: string;
	searchPath: string;
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
	rawBytes?: boolean;
	maxBytes: number;
	timeoutMs: number;
}
export interface GrepRpcResult {
	/** Base64-encoded raw stdout bytes. */
	stdoutB64: string;
	stderr: string;
	exitCode: number;
	truncatedByBytes: boolean;
	timedOut: boolean;
	unavailable?: boolean;
}

export interface ExecStartParams {
	command: string;
	cwd: string;
	freshEnv?: boolean;
	env?: Record<string, string>;
	/** Hard timeout enforced on the executor side. */
	timeoutMs: number;
	/** Max total output bytes the executor will stream before truncating. */
	maxBytes: number;
}
/** Terminal result of an exec RPC (stdout/stderr arrive via rpc_stream). */
export interface ExecStartResult {
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
}

export interface GitStatusParams {
	cwd: string;
}
export interface GitStatusResult {
	stdout: string;
}

export interface GitDiffParams {
	cwd: string;
	args?: string[];
	maxBytes?: number;
}
export interface GitDiffResult {
	stdout: string;
	truncated: boolean;
}

// ── PTY (interactive terminal) ──────────────────────────────────────────────
//
// pty.open is a long-lived RPC: its rpc_stream frames carry terminal output
// (channel "pty") until the shell exits, at which point the terminal rpc_result
// reports the exit code. pty.write / pty.resize / pty.kill are short RPCs that
// reference the ptyId returned via the first stream frame's metadata — since we
// need the id before the long RPC resolves, the executor accepts the caller's
// ptyId in pty.open params instead of generating its own.

export interface PtyOpenParams {
	/** Caller-generated id used to correlate write/resize/kill. */
	ptyId: string;
	cmd: string[];
	cwd: string;
	cols: number;
	rows: number;
	env?: Record<string, string>;
}
export interface PtyOpenResult {
	exitCode: number | null;
}

export interface PtyWriteParams {
	ptyId: string;
	/** Base64-encoded bytes to write to the PTY stdin. */
	dataB64: string;
}

export interface PtyResizeParams {
	ptyId: string;
	cols: number;
	rows: number;
}

export interface PtyKillParams {
	ptyId: string;
}

// ── File transfer (high-performance, resumable, binary framed) ──────────────
//
// Control plane uses JSON RPC (transfer.*). The data plane uses raw binary
// WebSocket frames (see encodeChunkFrame/decodeChunkFrame) so file bytes cross
// the wire with zero base64 overhead. `direction` decouples who initiates the
// transfer from which way the bytes flow:
//   - "download": remote → server (executor sends chunk frames)
//   - "upload":   server → remote (server sends chunk frames)

export type TransferDirection = "download" | "upload";
export type TransferVerify = "crc32c" | "sha256" | "none";

export interface TransferBeginParams {
	/** Caller-generated transfer id, used to route chunk frames + acks. */
	transferId: string;
	direction: TransferDirection;
	/** Path on the executor device (source for download, dest for upload). */
	remotePath: string;
	/** Size of the source file in bytes (sender advertises it). */
	fileSize: number;
	/** Chunk size in bytes both sides use. */
	chunkSize: number;
	/** Total chunk count = ceil(fileSize / chunkSize). */
	totalChunks: number;
	/** Source file mtime (ms) — part of the resume validity fingerprint. */
	mtimeMs: number;
	/** Integrity strategy for whole-file verification at completion. */
	verify: TransferVerify;
}
export interface TransferBeginResult {
	/** Chunk indices the receiver already has (resume). Sender skips these. */
	completedChunks: number[];
	/** True when the resume manifest was invalidated (size/mtime changed) and
	 *  the transfer must start fresh. */
	restarted: boolean;
}

export interface TransferStatParams {
	path: string;
	/** When true, recursively enumerate a directory's files. */
	recursive?: boolean;
	/** Max entries to return for a directory enumeration. */
	maxEntries?: number;
}
export interface TransferStatEntry {
	/** Path relative to the queried directory (or the file's basename). */
	relPath: string;
	size: number;
	mtimeMs: number;
	isDirectory: boolean;
}
export interface TransferStatResult {
	exists: boolean;
	isDirectory: boolean;
	size: number;
	mtimeMs: number;
	/** Present when recursive enumeration was requested on a directory. */
	entries?: TransferStatEntry[];
	/** True when the directory listing was capped at maxEntries. */
	truncated?: boolean;
}

export interface TransferAckParams {
	transferId: string;
	/** Chunk indices the receiver has durably written. */
	chunkIndices: number[];
	/** Per-chunk crc32c the receiver computed (parallel to chunkIndices). */
	crc32c?: number[];
}

export interface TransferCompleteParams {
	transferId: string;
	/** Optional whole-file sha256 (hex) for strong verification. */
	sha256?: string;
}
export interface TransferCompleteResult {
	ok: boolean;
	/** Final byte size the receiver observed. */
	fileSize: number;
	error?: string;
}

export interface TransferAbortParams {
	transferId: string;
}

// ── Binary chunk frame codec ────────────────────────────────────────────────
//
// Layout: [magic 0xNF][frameType 0x01][headerLen uint16 LE][header JSON][payload]
// header = { transferId, chunkIndex }. The payload is raw file bytes.

export const TRANSFER_FRAME_MAGIC = 0x4e; // 'N'
export const TRANSFER_FRAME_TYPE_CHUNK = 0x01;

export interface ChunkFrameHeader {
	transferId: string;
	chunkIndex: number;
}

/** Encode a binary chunk frame. Returns a Uint8Array ready for ws.send. */
export function encodeChunkFrame(header: ChunkFrameHeader, payload: Uint8Array): Uint8Array {
	const headerJson = JSON.stringify(header);
	const headerBytes = new TextEncoder().encode(headerJson);
	if (headerBytes.length > 0xffff) throw new Error("chunk frame header too large");
	const total = 2 + 2 + headerBytes.length + payload.length;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	out[0] = TRANSFER_FRAME_MAGIC;
	out[1] = TRANSFER_FRAME_TYPE_CHUNK;
	view.setUint16(2, headerBytes.length, true);
	out.set(headerBytes, 4);
	out.set(payload, 4 + headerBytes.length);
	return out;
}

/** Quick check whether a binary message is a transfer chunk frame. */
export function isChunkFrame(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 && bytes[0] === TRANSFER_FRAME_MAGIC && bytes[1] === TRANSFER_FRAME_TYPE_CHUNK
	);
}

/** Decode a binary chunk frame. Returns null when the bytes are not a valid frame. */
export function decodeChunkFrame(
	bytes: Uint8Array,
): { header: ChunkFrameHeader; payload: Uint8Array } | null {
	if (!isChunkFrame(bytes)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerLen = view.getUint16(2, true);
	if (bytes.length < 4 + headerLen) return null;
	const headerBytes = bytes.subarray(4, 4 + headerLen);
	let header: ChunkFrameHeader;
	try {
		header = JSON.parse(new TextDecoder().decode(headerBytes));
	} catch {
		return null;
	}
	const payload = bytes.subarray(4 + headerLen);
	return { header, payload };
}
