/**
 * Device connection manager.
 *
 * Owns the live WebSocket sessions to remote executor devices and the RPC
 * request/response correlation on top of them. Exposes `sendRpc` (used by
 * RemoteBackend) and registers a RemoteBackend resolver with the execution
 * registry so tools can route to online devices.
 *
 * Pinned to globalThis via hotSafe so hot reloads don't orphan live sockets.
 */
import type { ServerWebSocket } from "bun";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { remoteDevices } from "../db/schema";
import { setRemoteBackendResolver } from "../lib/agent/execution/registry";
import type {
	DeviceHelloFrame,
	RpcMethod,
	RpcResultFrame,
	RpcStreamFrame,
} from "../lib/agent/execution/rpc-types";
import { DEVICE_PROTOCOL_VERSION } from "../lib/agent/execution/rpc-types";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { createRemoteBackend } from "./device-remote-backend";
import { type RemoteDeviceRow, verifyDeviceToken } from "./device-service";

export interface DeviceWSData {
	connectedAt: number;
	lastPongAt: number;
	/** Set once the hello handshake authenticates this socket. */
	deviceId?: string;
	authenticated: boolean;
}

type DeviceWS = ServerWebSocket<DeviceWSData & { channel: "device" }>;

/**
 * Minimal transport the RPC machinery writes to. Both the inbound Bun
 * ServerWebSocket (reverse-dial) and an outbound client WebSocket (direct mode)
 * implement this, so the connection/RPC logic is identical for both directions.
 */
export interface DeviceTransport {
	send(data: string): void;
	/** Send a raw binary frame (file transfer chunks). */
	sendBinary(data: Uint8Array): void;
	/** Current outbound send-buffer size in bytes (for backpressure), if known. */
	bufferedAmount?(): number;
	close(code: number, reason: string): void;
}

interface PendingRpc {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
	onStream?: (channel: string, chunk: Uint8Array) => void;
	longLived?: boolean;
}

interface DeviceConnection {
	transport: DeviceTransport;
	deviceId: string;
	pending: Map<string, PendingRpc>;
	/** Count of in-flight long-lived RPCs (e.g. pty.open), excluded from the cap. */
	longLivedCount: number;
	rpcSeq: number;
	hello?: DeviceHelloFrame;
}

/** deviceId → live connection. Survives hot reloads. */
const connections = hotSafe(
	"narrafork:deviceConnections",
	() => new Map<string, DeviceConnection>(),
);

/** All open device sockets (for heartbeat sweeps), including pre-auth ones. */
const sockets = hotSafe("narrafork:deviceSockets", () => new Set<DeviceWS>());

export function getDeviceConnections(): Set<DeviceWS> {
	return sockets;
}

export function isDeviceOnline(deviceId: string): boolean {
	return connections.has(deviceId);
}

/** Copy a Uint8Array view into a standalone ArrayBuffer (satisfies WS.send typing). */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(data.byteLength);
	new Uint8Array(out).set(data);
	return out;
}

// ── Binary chunk frames (file transfer data plane) ──────────────────────────

/** Handler invoked when a transfer chunk frame arrives from a device. */
type ChunkFrameHandler = (deviceId: string, bytes: Uint8Array) => void;
let chunkFrameHandler: ChunkFrameHandler | null = null;

/** Register the transfer service's chunk-frame receiver (avoids a circular import). */
export function setChunkFrameHandler(handler: ChunkFrameHandler | null): void {
	chunkFrameHandler = handler;
}

/** Send a raw binary chunk frame to a device. Returns false when offline. */
export function sendChunkFrame(deviceId: string, frame: Uint8Array): boolean {
	const conn = connections.get(deviceId);
	if (!conn) return false;
	try {
		conn.transport.sendBinary(frame);
		return true;
	} catch {
		return false;
	}
}

/** Current WebSocket send buffer backpressure for a device, in bytes (0 when unknown). */
export function deviceBufferedAmount(deviceId: string): number {
	const conn = connections.get(deviceId);
	return conn?.transport.bufferedAmount?.() ?? 0;
}

/** Route an inbound binary frame to the transfer service. */
function handleBinaryFrame(deviceId: string, bytes: Uint8Array): void {
	if (chunkFrameHandler) chunkFrameHandler(deviceId, bytes);
}

/**
 * Build the DeviceSummary list a narrator session may route to: all non-revoked
 * devices authorized for the project (global scope + this project), with live
 * online status. Project-scoped devices for other projects are excluded.
 */
export async function getSessionDevices(
	projectId: string | null | undefined,
): Promise<import("../lib/agent/execution/backend").DeviceSummary[]> {
	const rows = await db.query.remoteDevices.findMany({
		where: isNull(remoteDevices.revokedAt),
	});
	const summaries: import("../lib/agent/execution/backend").DeviceSummary[] = [];
	for (const row of rows) {
		if (row.scope === "project" && row.projectId && row.projectId !== projectId) continue;
		summaries.push({
			id: row.id,
			name: row.name,
			slug: row.slug,
			description: row.description,
			online: connections.has(row.id),
			platform: row.platformOs
				? {
						os: row.platformOs,
						arch: row.platformArch ?? "",
						shellPath: row.shellPath ?? undefined,
					}
				: undefined,
			defaultCwd: row.defaultCwd,
		});
	}
	return summaries;
}

// ── RPC ──────────────────────────────────────────────────────────────────────

export interface SendRpcOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Called for each streaming chunk (exec output). */
	onStream?: (channel: string, chunk: Uint8Array) => void;
	/**
	 * Exempt this call from the per-device concurrency cap. Used for long-lived
	 * RPCs (e.g. pty.open) that would otherwise permanently occupy a slot.
	 */
	longLived?: boolean;
}

export class DeviceOfflineError extends Error {
	constructor(deviceId: string) {
		super(`Remote device ${deviceId} is offline`);
		this.name = "DeviceOfflineError";
	}
}

/**
 * Send an RPC to a device and await its terminal result. Rejects on timeout,
 * disconnect, or an abort signal (which also sends a cancel frame).
 */
export function sendRpc(
	deviceId: string,
	method: RpcMethod,
	params: Record<string, unknown>,
	opts: SendRpcOptions = {},
): Promise<unknown> {
	const conn = connections.get(deviceId);
	if (!conn) return Promise.reject(new DeviceOfflineError(deviceId));

	if (!opts.longLived) {
		const maxConcurrent = settings.devices?.maxConcurrentRpcPerDevice ?? 16;
		// Count only short-lived RPCs against the cap; long-lived ones (PTY) are
		// tracked separately and must not exhaust the budget.
		const shortLivedPending = conn.pending.size - conn.longLivedCount;
		if (shortLivedPending >= maxConcurrent) {
			return Promise.reject(
				new Error(`Device ${deviceId} RPC concurrency limit reached (${maxConcurrent})`),
			);
		}
	}

	const id = `rpc_${conn.rpcSeq++}`;
	const timeoutMs = opts.timeoutMs ?? settings.devices?.rpcTimeoutMs ?? 120_000;

	return new Promise<unknown>((resolve, reject) => {
		// Long-lived RPCs (PTY sessions) have no timeout — they end on kill/abort
		// or when the remote reports completion.
		const timer = opts.longLived
			? null
			: setTimeout(() => {
					cleanupPending(conn, id);
					sendCancel(conn, id);
					reject(new Error(`RPC ${method} to device ${deviceId} timed out after ${timeoutMs}ms`));
				}, timeoutMs);

		const pending: PendingRpc = {
			resolve,
			reject,
			timer,
			onStream: opts.onStream,
			longLived: opts.longLived,
		};
		conn.pending.set(id, pending);
		if (opts.longLived) conn.longLivedCount++;

		if (opts.signal) {
			if (opts.signal.aborted) {
				cleanupPending(conn, id);
				sendCancel(conn, id);
				reject(new Error("RPC aborted"));
				return;
			}
			opts.signal.addEventListener(
				"abort",
				() => {
					if (conn.pending.has(id)) {
						cleanupPending(conn, id);
						sendCancel(conn, id);
						reject(new Error("RPC aborted"));
					}
				},
				{ once: true },
			);
		}

		try {
			conn.transport.send(JSON.stringify({ type: "rpc", id, method, params }));
		} catch (err) {
			cleanupPending(conn, id);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

function cleanupPending(conn: DeviceConnection, id: string): void {
	const pending = conn.pending.get(id);
	if (pending) {
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.longLived) conn.longLivedCount = Math.max(0, conn.longLivedCount - 1);
		conn.pending.delete(id);
	}
}

function sendCancel(conn: DeviceConnection, id: string): void {
	try {
		conn.transport.send(JSON.stringify({ type: "rpc_cancel", id }));
	} catch {
		// socket may be dead
	}
}

// ── Shared frame processing (transport-agnostic) ────────────────────────────────

/**
 * Handle a decoded frame from an authenticated connection. Returns false when
 * the frame required authentication but the device wasn't registered (caller
 * decides whether to close). Ping/pong and hello are handled by the callers.
 */
function processAuthenticatedFrame(deviceId: string, frame: { type?: string }): void {
	const conn = connections.get(deviceId);
	if (!conn) return;
	if (frame.type === "rpc_stream") {
		handleRpcStream(conn, frame as unknown as RpcStreamFrame);
	} else if (frame.type === "rpc_result") {
		handleRpcResult(conn, frame as unknown as RpcResultFrame);
	}
}

/**
 * Register an authenticated device connection over the given transport. Shared
 * by the inbound (reverse-dial) and outbound (direct) paths. Returns the
 * resolved device id, or null when auth/protocol checks fail (transport closed).
 *
 * Reverse-dial: the device authenticates with a token, verified here.
 * Direct mode: the server dialed a trusted, admin-configured `directUrl`, so it
 * already knows which device row this connection belongs to. It passes the
 * pre-verified row and the token check is skipped — the executor never needs to
 * know its own registration token.
 */
async function registerConnection(
	transport: DeviceTransport,
	hello: DeviceHelloFrame,
	preVerified?: RemoteDeviceRow,
): Promise<string | null> {
	if (hello.protocolVersion !== DEVICE_PROTOCOL_VERSION) {
		sendHelloAck(transport, false, `Unsupported protocol version ${hello.protocolVersion}`);
		transport.close(1002, "protocol version mismatch");
		return null;
	}

	const row = preVerified ?? (await verifyDeviceToken(hello.deviceRef, hello.token ?? ""));
	if (!row) {
		sendHelloAck(transport, false, "Invalid device token");
		transport.close(1008, "auth failed");
		return null;
	}
	// Defense-in-depth: both callers already exclude revoked devices
	// (verifyDeviceToken and getDeviceRowForDial), but re-check here so a revoked
	// device can never register regardless of how the row was resolved.
	if (row.revokedAt) {
		sendHelloAck(transport, false, "Device revoked");
		transport.close(1008, "device revoked");
		return null;
	}

	// Replace any previous connection for this device.
	const previous = connections.get(row.id);
	if (previous && previous.transport !== transport) {
		try {
			previous.transport.close(1000, "replaced by new connection");
		} catch {
			// dead
		}
	}

	connections.set(row.id, {
		transport,
		deviceId: row.id,
		pending: new Map(),
		longLivedCount: 0,
		rpcSeq: 0,
		hello,
	});

	await markOnline(row.id, hello);
	sendHelloAck(transport, true, undefined, row.id);
	logger.info("Device authenticated", {
		deviceId: row.id,
		slug: row.slug,
		os: hello.platform.os,
		arch: hello.platform.arch,
	});
	return row.id;
}

/** Tear down a connection and reject its in-flight RPCs. */
function teardownConnection(deviceId: string, transport: DeviceTransport): void {
	const conn = connections.get(deviceId);
	if (conn && conn.transport === transport) {
		for (const [id, pending] of conn.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new DeviceOfflineError(deviceId));
			conn.pending.delete(id);
		}
		conn.longLivedCount = 0;
		connections.delete(deviceId);
		void markOffline(deviceId);
		logger.info("Device disconnected", { deviceId });
	}
}

// ── Inbound WebSocket lifecycle (reverse-dial) ──────────────────────────────────

export const handleDeviceWS = {
	open(ws: DeviceWS) {
		sockets.add(ws);
		logger.debug("Device WS opened (awaiting hello)");
	},

	async message(ws: DeviceWS, raw: unknown) {
		const frame = raw as { type?: string };
		if (!frame || typeof frame.type !== "string") return;

		if (frame.type === "pong" || frame.type === "ping") {
			ws.data.lastPongAt = Date.now();
			if (frame.type === "ping") {
				try {
					ws.send(JSON.stringify({ type: "pong" }));
				} catch {
					// dead
				}
			}
			return;
		}

		if (frame.type === "hello") {
			const transport = wsTransport(ws);
			const deviceId = await registerConnection(transport, frame as unknown as DeviceHelloFrame);
			if (deviceId) {
				ws.data.deviceId = deviceId;
				ws.data.authenticated = true;
				ws.data.lastPongAt = Date.now();
			}
			return;
		}

		// All other frames require an authenticated socket.
		if (!ws.data.authenticated || !ws.data.deviceId) {
			try {
				ws.send(JSON.stringify({ type: "hello_ack", ok: false, error: "Not authenticated" }));
			} catch {
				// dead
			}
			return;
		}

		processAuthenticatedFrame(ws.data.deviceId, frame);
	},

	/** Binary WebSocket message (transfer chunk frames). */
	binaryMessage(ws: DeviceWS, bytes: Uint8Array) {
		if (!ws.data.authenticated || !ws.data.deviceId) return;
		handleBinaryFrame(ws.data.deviceId, bytes);
	},

	close(ws: DeviceWS) {
		sockets.delete(ws);
		const deviceId = ws.data.deviceId;
		if (!deviceId) return;
		teardownConnection(deviceId, wsTransport(ws));
	},
};

/** Adapt a Bun ServerWebSocket to the DeviceTransport interface (memoised). */
const wsTransportCache = new WeakMap<DeviceWS, DeviceTransport>();
function wsTransport(ws: DeviceWS): DeviceTransport {
	let t = wsTransportCache.get(ws);
	if (!t) {
		t = {
			send: (data: string) => ws.send(data),
			sendBinary: (data: Uint8Array) => ws.send(data),
			bufferedAmount: () => {
				try {
					return (ws as unknown as { getBufferedAmount?: () => number }).getBufferedAmount?.() ?? 0;
				} catch {
					return 0;
				}
			},
			close: (code: number, reason: string) => {
				try {
					ws.close(code, reason);
				} catch {
					// dead
				}
			},
		};
		wsTransportCache.set(ws, t);
	}
	return t;
}

function sendHelloAck(
	transport: DeviceTransport,
	ok: boolean,
	error?: string,
	deviceId?: string,
): void {
	try {
		transport.send(
			JSON.stringify({
				type: "hello_ack",
				ok,
				error,
				sessionId: deviceId,
				limits: ok
					? {
							maxRpcBytes: settings.devices?.maxRpcBytes ?? 10 * 1024 * 1024,
							rpcTimeoutMs: settings.devices?.rpcTimeoutMs ?? 120_000,
						}
					: undefined,
			}),
		);
	} catch {
		// dead
	}
}

function handleRpcStream(conn: DeviceConnection, frame: RpcStreamFrame): void {
	const pending = conn.pending.get(frame.id);
	if (!pending?.onStream) return;
	try {
		const bytes = Uint8Array.from(Buffer.from(frame.chunkB64, "base64"));
		pending.onStream(frame.channel ?? "stdout", bytes);
	} catch (err) {
		logger.warn("Failed to decode rpc_stream chunk", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function handleRpcResult(conn: DeviceConnection, frame: RpcResultFrame): void {
	const pending = conn.pending.get(frame.id);
	if (!pending) return;
	if (pending.timer) clearTimeout(pending.timer);
	if (pending.longLived) conn.longLivedCount = Math.max(0, conn.longLivedCount - 1);
	conn.pending.delete(frame.id);
	if (frame.ok) {
		pending.resolve(frame.result);
	} else {
		pending.reject(new Error(frame.error ?? "Remote RPC failed"));
	}
}

// ── DB status updates ──────────────────────────────────────────────────────────

async function markOnline(deviceId: string, hello: DeviceHelloFrame): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(remoteDevices)
		.set({
			status: "online",
			lastSeenAt: now,
			platformOs: hello.platform.os,
			platformArch: hello.platform.arch,
			shellPath: hello.platform.shellPath ?? null,
			defaultCwd: hello.defaultCwd ?? null,
			agentVersion: hello.agentVersion,
			capabilitiesJson: hello.capabilities,
			updatedAt: now,
		})
		.where(eq(remoteDevices.id, deviceId));
	eventBus.emit({ type: "device:status", deviceId, status: "online" });
}

async function markOffline(deviceId: string): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(remoteDevices)
		.set({ status: "offline", lastSeenAt: now, updatedAt: now })
		.where(and(eq(remoteDevices.id, deviceId)));
	eventBus.emit({ type: "device:status", deviceId, status: "offline" });
}

/** Force-disconnect a device (on revoke or token rotation). */
export function disconnectDevice(deviceId: string, reason: string): void {
	const conn = connections.get(deviceId);
	if (!conn) return;
	try {
		conn.transport.close(1000, reason);
	} catch {
		// dead
	}
	// Stop any direct-mode reconnect loop for this device.
	stopDirectDial(deviceId);
}

// ── Direct mode (server dials the executor) ─────────────────────────────────────

interface DirectDialState {
	deviceId: string;
	url: string;
	stopped: boolean;
	ws: WebSocket | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	backoffMs: number;
}

const directDials = hotSafe(
	"narrafork:deviceDirectDials",
	() => new Map<string, DirectDialState>(),
);

const DIRECT_DIAL_MIN_BACKOFF_MS = 2_000;
const DIRECT_DIAL_MAX_BACKOFF_MS = 60_000;

/** Begin (or restart) an outbound connection loop to a direct-mode device. */
export function startDirectDial(deviceId: string, url: string): void {
	stopDirectDial(deviceId);
	const state: DirectDialState = {
		deviceId,
		url,
		stopped: false,
		ws: null,
		reconnectTimer: null,
		backoffMs: DIRECT_DIAL_MIN_BACKOFF_MS,
	};
	directDials.set(deviceId, state);
	dialDirect(state);
}

/** Stop the outbound connection loop for a device and close any live socket. */
export function stopDirectDial(deviceId: string): void {
	const state = directDials.get(deviceId);
	if (!state) return;
	state.stopped = true;
	if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
	try {
		state.ws?.close();
	} catch {
		// dead
	}
	directDials.delete(deviceId);
}

function scheduleDirectReconnect(state: DirectDialState): void {
	if (state.stopped) return;
	if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
	const delay = state.backoffMs;
	state.backoffMs = Math.min(state.backoffMs * 2, DIRECT_DIAL_MAX_BACKOFF_MS);
	state.reconnectTimer = setTimeout(() => dialDirect(state), delay);
}

function dialDirect(state: DirectDialState): void {
	if (state.stopped) return;
	let ws: WebSocket;
	try {
		ws = new WebSocket(state.url);
	} catch (err) {
		logger.warn("Direct dial failed to open", {
			deviceId: state.deviceId,
			error: err instanceof Error ? err.message : String(err),
		});
		scheduleDirectReconnect(state);
		return;
	}
	state.ws = ws;

	const transport: DeviceTransport = {
		send: (data: string) => ws.send(data),
		sendBinary: (data: Uint8Array) => ws.send(toArrayBuffer(data)),
		bufferedAmount: () => ws.bufferedAmount ?? 0,
		close: (code: number, reason: string) => {
			try {
				ws.close(code, reason);
			} catch {
				// dead
			}
		},
	};

	ws.addEventListener("open", () => {
		logger.info("Direct dial connected", { deviceId: state.deviceId, url: state.url });
		state.backoffMs = DIRECT_DIAL_MIN_BACKOFF_MS;
	});

	ws.addEventListener("message", (ev: MessageEvent) => {
		void handleDirectMessage(state, transport, ev.data);
	});

	ws.addEventListener("close", () => {
		const deviceId = state.deviceId;
		teardownConnection(deviceId, transport);
		if (!state.stopped) scheduleDirectReconnect(state);
	});

	ws.addEventListener("error", () => {
		// The close handler drives reconnect; just log.
		logger.debug("Direct dial socket error", { deviceId: state.deviceId });
	});
}

async function handleDirectMessage(
	state: DirectDialState,
	transport: DeviceTransport,
	raw: unknown,
): Promise<void> {
	// Binary messages are transfer chunk frames — route them without JSON parsing.
	if (raw instanceof ArrayBuffer) {
		if (state.stopped) return;
		const conn = connections.get(state.deviceId);
		if (conn && conn.transport === transport)
			handleBinaryFrame(state.deviceId, new Uint8Array(raw));
		return;
	}
	if (typeof Blob !== "undefined" && raw instanceof Blob) {
		const buf = new Uint8Array(await raw.arrayBuffer());
		const conn = connections.get(state.deviceId);
		if (conn && conn.transport === transport) handleBinaryFrame(state.deviceId, buf);
		return;
	}

	let frame: { type?: string };
	try {
		const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
		frame = JSON.parse(text);
	} catch {
		return;
	}
	if (!frame || typeof frame.type !== "string") return;

	if (frame.type === "ping" || frame.type === "pong") {
		if (frame.type === "ping") {
			try {
				transport.send(JSON.stringify({ type: "pong" }));
			} catch {
				// dead
			}
		}
		return;
	}

	if (frame.type === "hello") {
		// In direct mode the server dialed a trusted, admin-configured URL, so it
		// already knows which device row this connection belongs to. The executor
		// stays agnostic about its own registration identity: we resolve the row by
		// the dialed device id and register with it directly, skipping the token
		// check (the executor may not even have a token in direct mode).
		const row = await getDeviceRowForDial(state.deviceId);
		if (!row) {
			transport.close(1008, "device not found");
			stopDirectDial(state.deviceId);
			return;
		}
		const hello = frame as unknown as DeviceHelloFrame;
		hello.deviceRef = row.slug;
		await registerConnection(transport, hello, row);
		return;
	}

	processAuthenticatedFrame(state.deviceId, frame);
}

/** Fetch a device row for a direct dial, bypassing the token requirement. */
async function getDeviceRowForDial(deviceId: string) {
	const row = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.id, deviceId),
	});
	return row && !row.revokedAt ? row : null;
}

/**
 * Reconcile direct-mode dials with the DB: start dials for direct devices that
 * aren't yet dialing, and stop dials for devices that no longer qualify.
 */
export async function reconcileDirectDials(): Promise<void> {
	const rows = await db.query.remoteDevices.findMany({
		where: isNull(remoteDevices.revokedAt),
	});
	const wanted = new Map<string, string>();
	for (const row of rows) {
		if (row.connectionMode === "direct" && row.directUrl) {
			wanted.set(row.id, row.directUrl);
		}
	}
	// Start/refresh wanted dials.
	for (const [deviceId, url] of wanted) {
		const existing = directDials.get(deviceId);
		if (!existing || existing.url !== url) {
			startDirectDial(deviceId, url);
		}
	}
	// Stop dials no longer wanted.
	for (const deviceId of [...directDials.keys()]) {
		if (!wanted.has(deviceId)) stopDirectDial(deviceId);
	}
}

// ── Startup wiring ─────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Register the RemoteBackend resolver + lifecycle listeners. Called once during
 * server startup. On boot, all devices are marked offline until they reconnect.
 */
export function initDeviceConnectionService(): void {
	if (initialized) return;
	initialized = true;

	setRemoteBackendResolver((deviceId) => {
		const conn = connections.get(deviceId);
		if (!conn) return null;
		// Feed the handshake platform + default cwd into the backend so tools can
		// resolve relative paths and the default exec cwd on the remote machine.
		const hello = conn.hello;
		const platform = hello
			? {
					os: hello.platform.os,
					arch: hello.platform.arch,
					shellPath: hello.platform.shellPath,
					shellType: hello.platform.shellType,
					shellLoginWrap: hello.platform.shellLoginWrap,
				}
			: undefined;
		return createRemoteBackend(deviceId, platform, hello?.defaultCwd ?? null);
	});

	eventBus.on("device:revoked", ({ deviceId }) => disconnectDevice(deviceId, "device revoked"));
	eventBus.on("device:token-rotated", ({ deviceId }) =>
		disconnectDevice(deviceId, "token rotated"),
	);
	// Any device create/update may add, remove, or repoint a direct-mode URL.
	eventBus.on("device:changed", () => {
		void reconcileDirectDials();
	});

	// Reset stale online flags left over from a previous process.
	void db
		.update(remoteDevices)
		.set({ status: "offline" })
		.where(eq(remoteDevices.status, "online"))
		.then(() => {
			// Start outbound dials for any direct-mode devices.
			void reconcileDirectDials();
		});
}
