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
import {
	createDeviceAuthProof,
	DEVICE_AUTH_VERSION,
	deviceAuthKeyFromTokenHash,
	generateDeviceAuthNonce,
	isValidDeviceAuthNonce,
	verifyDeviceAuthProof,
} from "../lib/agent/execution/device-auth";
import { setRemoteBackendResolver } from "../lib/agent/execution/registry";
import type {
	DeviceAuthInitFrame,
	DeviceAuthProofFrame,
	DeviceHelloFrame,
	RpcMethod,
	RpcResultFrame,
	RpcStreamFrame,
} from "../lib/agent/execution/rpc-types";
import {
	DEVICE_PROTOCOL_VERSION,
	FS_READ_ATOMIC_RESOLVED_PATH_FEATURE,
	FS_STAT_RESOLVED_PATH_FEATURE,
} from "../lib/agent/execution/rpc-types";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { createRemoteBackend } from "./device-remote-backend";
import {
	deviceHasFeature,
	isDeviceAuthorizedForProject,
	type RemoteDeviceRow,
	verifyDeviceToken,
} from "./device-service";
import { resolveOAuthDeviceRuntimeAuthorization } from "./oauth-device-runtime-policy";

export interface DeviceWSData {
	connectedAt: number;
	lastPongAt: number;
	/** Set once the hello handshake authenticates this socket. */
	deviceId?: string;
	authenticating?: boolean;
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
	connectedAt: number;
	/** Monotonic identity for this authenticated transport generation. */
	generation?: number;
	hello?: DeviceHelloFrame;
}

/** deviceId → live connection. Survives hot reloads. */
const connections = hotSafe(
	"narrafork:deviceConnections",
	() => new Map<string, DeviceConnection>(),
);
const connectionGenerationState = hotSafe("narrafork:deviceConnectionGeneration", () => ({
	next: 1,
}));

function ensureConnectionGeneration(conn: DeviceConnection): number {
	if (conn.generation === undefined) {
		conn.generation = connectionGenerationState.next++;
	}
	return conn.generation;
}

/** All open device sockets (for heartbeat sweeps), including pre-auth ones. */
const sockets = hotSafe("narrafork:deviceSockets", () => new Set<DeviceWS>());

const DEVICE_HANDSHAKE_TIMEOUT_MS = 10_000;
const reverseHandshakeTimers = new WeakMap<DeviceWS, ReturnType<typeof setTimeout>>();

export function getDeviceConnections(): Set<DeviceWS> {
	return sockets;
}

export function isDeviceOnline(deviceId: string): boolean {
	return connections.has(deviceId);
}

export function getConnectedDeviceHello(deviceId: string): DeviceHelloFrame | null {
	return connections.get(deviceId)?.hello ?? null;
}

export function hasDeviceProtocolFeature(deviceId: string, feature: string): boolean {
	return deviceHasFeature(connections.get(deviceId)?.hello?.capabilities, feature);
}

/** Current authenticated transport generation, used to bind RemoteBackend instances. */
export function getDeviceConnectionGeneration(deviceId: string): number | null {
	const conn = connections.get(deviceId);
	return conn ? ensureConnectionGeneration(conn) : null;
}

/** Copy a Uint8Array view into a standalone ArrayBuffer (satisfies WS.send typing). */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(data.byteLength);
	new Uint8Array(out).set(data);
	return out;
}

// ── Binary chunk frames (file transfer data plane) ──────────────────────────

/** Handler invoked when a transfer chunk frame arrives from a device. */
type ChunkFrameHandler = (deviceId: string, bytes: Uint8Array) => Promise<void>;
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
async function handleBinaryFrame(deviceId: string, bytes: Uint8Array): Promise<void> {
	await chunkFrameHandler?.(deviceId, bytes);
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
		if (!isDeviceAuthorizedForProject(row, projectId)) continue;
		const authorization = await resolveOAuthDeviceRuntimeAuthorization(row).catch(() => ({
			oauthOwned: true,
			allowed: false,
		}));
		if (!authorization.allowed) continue;
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
	/** Reject instead of silently switching this RPC to a reconnected executor. */
	expectedConnectionGeneration?: number;
	/** Capabilities that must still be present on the bound live connection. */
	requiredFeatures?: readonly string[];
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

export class DeviceConnectionChangedError extends Error {
	constructor(deviceId: string, expected: number, actual: number) {
		super(
			`Remote device ${deviceId} connection changed ` +
				`(expected generation ${expected}, current generation ${actual})`,
		);
		this.name = "DeviceConnectionChangedError";
	}
}

export class DeviceCapabilityError extends Error {
	constructor(deviceId: string, feature: string) {
		super(`Remote device ${deviceId} connection lacks required feature ${feature}`);
		this.name = "DeviceCapabilityError";
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
	const connectionGeneration = ensureConnectionGeneration(conn);
	if (
		opts.expectedConnectionGeneration !== undefined &&
		opts.expectedConnectionGeneration !== connectionGeneration
	) {
		return Promise.reject(
			new DeviceConnectionChangedError(
				deviceId,
				opts.expectedConnectionGeneration,
				connectionGeneration,
			),
		);
	}
	for (const feature of opts.requiredFeatures ?? []) {
		if (!deviceHasFeature(conn.hello?.capabilities, feature)) {
			return Promise.reject(new DeviceCapabilityError(deviceId, feature));
		}
	}

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

function rejectConnectionPending(conn: DeviceConnection, error: Error): void {
	for (const pending of conn.pending.values()) {
		if (pending.timer) clearTimeout(pending.timer);
		pending.reject(error);
	}
	conn.pending.clear();
	conn.longLivedCount = 0;
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
function processAuthenticatedFrame(
	deviceId: string,
	transport: DeviceTransport,
	frame: { type?: string },
): void {
	const conn = connections.get(deviceId);
	// A replaced socket may still deliver buffered frames. Never route those into
	// the current connection's pending map, whose RPC ids restart from zero.
	if (!conn || conn.transport !== transport) return;
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
 * Reverse-dial passes no row, so the hello token is verified here. Direct mode
 * passes a row only after the nonce/HMAC exchange has mutually authenticated
 * both peers with that row's token hash.
 */
async function registerConnection(
	transport: DeviceTransport,
	hello: DeviceHelloFrame,
	authenticatedRow?: RemoteDeviceRow,
	onAuthorizationDenied?: (reason: string) => void,
): Promise<string | null> {
	if (hello.protocolVersion !== DEVICE_PROTOCOL_VERSION) {
		sendHelloAck(transport, false, `Unsupported protocol version ${hello.protocolVersion}`);
		transport.close(1002, "protocol version mismatch");
		return null;
	}

	const row = authenticatedRow ?? (await verifyDeviceToken(hello.deviceRef, hello.token ?? ""));
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
	const authorization = await resolveOAuthDeviceRuntimeAuthorization(row);
	if (!authorization.allowed) {
		const reason = authorization.reason ?? "OAuth device authorization is inactive";
		onAuthorizationDenied?.(reason);
		sendHelloAck(transport, false, reason);
		transport.close(1008, "oauth device authorization inactive");
		return null;
	}

	// Replace any previous connection for this device with a new transport generation.
	const generation = connectionGenerationState.next++;
	const previous = connections.get(row.id);
	if (previous && previous.transport !== transport) {
		rejectConnectionPending(
			previous,
			new DeviceConnectionChangedError(row.id, ensureConnectionGeneration(previous), generation),
		);
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
		connectedAt: Date.now(),
		generation,
		hello,
	});

	// Queue hello_ack before the first async yield after publishing the
	// connection, so the executor never observes an RPC before its ack.
	sendHelloAck(transport, true, undefined, row.id);
	await markOnline(row.id, hello);
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
		rejectConnectionPending(conn, new DeviceOfflineError(deviceId));
		connections.delete(deviceId);
		void markOffline(deviceId);
		logger.info("Device disconnected", { deviceId });
	}
}

// ── Inbound WebSocket lifecycle (reverse-dial) ──────────────────────────────────

function clearReverseHandshakeTimer(ws: DeviceWS): void {
	const timer = reverseHandshakeTimers.get(ws);
	if (timer) clearTimeout(timer);
	reverseHandshakeTimers.delete(ws);
}

function rejectPreAuthFrame(transport: DeviceTransport, frameType: string): void {
	sendHelloAck(transport, false, `${frameType} is not allowed before authentication`);
	transport.close(1008, "not authenticated");
}

export const handleDeviceWS = {
	open(ws: DeviceWS) {
		sockets.add(ws);
		clearReverseHandshakeTimer(ws);
		reverseHandshakeTimers.set(
			ws,
			setTimeout(() => {
				if (ws.data.authenticated) return;
				wsTransport(ws).close(1008, "handshake timeout");
			}, DEVICE_HANDSHAKE_TIMEOUT_MS),
		);
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
			if (ws.data.authenticated || ws.data.authenticating) {
				transport.close(1002, "duplicate hello");
				return;
			}
			ws.data.authenticating = true;
			try {
				const deviceId = await registerConnection(transport, frame as unknown as DeviceHelloFrame);
				if (deviceId) {
					clearReverseHandshakeTimer(ws);
					ws.data.deviceId = deviceId;
					ws.data.authenticated = true;
					ws.data.lastPongAt = Date.now();
				}
			} finally {
				ws.data.authenticating = false;
			}
			return;
		}

		// All data/control frames other than heartbeat require authentication.
		if (!ws.data.authenticated || !ws.data.deviceId) {
			rejectPreAuthFrame(wsTransport(ws), frame.type);
			return;
		}

		processAuthenticatedFrame(ws.data.deviceId, wsTransport(ws), frame);
	},

	/** Binary WebSocket message (transfer chunk frames). */
	async binaryMessage(ws: DeviceWS, bytes: Uint8Array) {
		if (!ws.data.authenticated || !ws.data.deviceId) {
			rejectPreAuthFrame(wsTransport(ws), "binary");
			return;
		}
		await handleBinaryFrame(ws.data.deviceId, bytes);
	},

	close(ws: DeviceWS) {
		clearReverseHandshakeTimer(ws);
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
	if (conn) {
		try {
			conn.transport.close(1000, reason);
		} catch {
			// dead
		}
	}
	// Stop connected, reconnect-waiting, and in-progress direct dials alike.
	stopDirectDial(deviceId);
}

// ── Direct mode (server dials the executor) ─────────────────────────────────────

interface DirectAuthState {
	row: RemoteDeviceRow;
	deviceRef: string;
	executorNonce: string;
	serverNonce: string;
	key: Uint8Array;
	executorVerified: boolean;
}

interface DirectDialState {
	deviceId: string;
	url: string;
	stopped: boolean;
	ws: WebSocket | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	handshakeTimer: ReturnType<typeof setTimeout> | null;
	authenticating: boolean;
	auth: DirectAuthState | null;
	backoffMs: number;
	lastError: string | null;
	lastEventAt: number;
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
		handshakeTimer: null,
		authenticating: false,
		auth: null,
		backoffMs: DIRECT_DIAL_MIN_BACKOFF_MS,
		lastError: null,
		lastEventAt: Date.now(),
	};
	directDials.set(deviceId, state);
	void dialDirect(state);
}

/** Stop the outbound connection loop for a device and close any live socket. */
export function stopDirectDial(deviceId: string): void {
	const state = directDials.get(deviceId);
	if (!state) return;
	state.stopped = true;
	if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
	if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
	state.reconnectTimer = null;
	state.handshakeTimer = null;
	state.authenticating = false;
	state.auth = null;
	try {
		state.ws?.close();
	} catch {
		// dead
	}
	directDials.delete(deviceId);
}

function haltUnauthorizedDirectDial(
	state: DirectDialState,
	reason: string,
	closeSocket = true,
): void {
	state.stopped = true;
	state.lastError = reason;
	state.lastEventAt = Date.now();
	if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
	if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
	state.reconnectTimer = null;
	state.handshakeTimer = null;
	state.authenticating = false;
	state.auth = null;
	if (closeSocket) {
		try {
			state.ws?.close(1008, "oauth device authorization inactive");
		} catch {
			// dead
		}
	}
}

export interface DeviceConnectionDiagnostics {
	deviceId: string;
	mode: "reverse" | "direct";
	online: boolean;
	stage:
		| "ready"
		| "waiting_for_executor"
		| "idle"
		| "connecting"
		| "waiting_auth_init"
		| "authenticating"
		| "waiting_hello"
		| "reconnect_wait"
		| "offline";
	directUrl?: string | null;
	socketState?: "connecting" | "open" | "closing" | "closed";
	lastError?: string | null;
	lastEventAt?: number;
	lastSeenAt?: string | null;
	agentVersion?: string;
	protocolVersion?: number;
	platform?: DeviceHelloFrame["platform"];
	capabilities?: DeviceHelloFrame["capabilities"];
	defaultCwd?: string | null;
}

export interface DeviceConnectionTestResult {
	ok: boolean;
	stage: string;
	latencyMs?: number;
	message?: string;
	diagnostics: DeviceConnectionDiagnostics;
}

function socketStateLabel(
	readyState: number | undefined,
): DeviceConnectionDiagnostics["socketState"] {
	switch (readyState) {
		case 0:
			return "connecting";
		case 1:
			return "open";
		case 2:
			return "closing";
		case 3:
			return "closed";
		default:
			return undefined;
	}
}

function persistedDiagnosticFields(
	row: RemoteDeviceRow,
): Pick<
	DeviceConnectionDiagnostics,
	"lastSeenAt" | "agentVersion" | "platform" | "capabilities" | "defaultCwd"
> {
	return {
		lastSeenAt: row.lastSeenAt,
		agentVersion: row.agentVersion ?? undefined,
		platform: row.platformOs
			? {
					os: row.platformOs,
					arch: row.platformArch ?? "",
					shellPath: row.shellPath ?? undefined,
				}
			: undefined,
		capabilities: (row.capabilitiesJson as DeviceHelloFrame["capabilities"] | null) ?? undefined,
		defaultCwd: row.defaultCwd,
	};
}

export async function getDeviceConnectionDiagnostics(
	deviceId: string,
): Promise<DeviceConnectionDiagnostics | null> {
	const row = await db.query.remoteDevices.findFirst({
		where: and(eq(remoteDevices.id, deviceId), isNull(remoteDevices.revokedAt)),
	});
	if (!row) return null;
	const persisted = persistedDiagnosticFields(row);
	const conn = connections.get(deviceId);
	if (conn) {
		return {
			deviceId,
			mode: row.connectionMode,
			online: true,
			stage: "ready",
			directUrl: row.directUrl,
			...persisted,
			lastEventAt: conn.connectedAt,
			agentVersion: conn.hello?.agentVersion ?? row.agentVersion ?? undefined,
			protocolVersion: conn.hello?.protocolVersion,
			platform: conn.hello?.platform ?? persisted.platform,
			capabilities: conn.hello?.capabilities ?? persisted.capabilities,
			defaultCwd: conn.hello?.defaultCwd ?? row.defaultCwd,
		};
	}
	if (row.connectionMode === "reverse") {
		return {
			deviceId,
			mode: "reverse",
			online: false,
			stage: "waiting_for_executor",
			...persisted,
		};
	}
	const state = directDials.get(deviceId);
	if (!state) {
		return {
			deviceId,
			mode: "direct",
			online: false,
			stage: "idle",
			directUrl: row.directUrl,
			...persisted,
		};
	}
	const readyState = state.ws?.readyState;
	let stage: DeviceConnectionDiagnostics["stage"] = "offline";
	if (readyState === 0) stage = "connecting";
	else if (readyState === 1 && state.auth?.executorVerified) stage = "waiting_hello";
	else if (readyState === 1 && state.authenticating) stage = "authenticating";
	else if (readyState === 1) stage = "waiting_auth_init";
	else if (state.reconnectTimer) stage = "reconnect_wait";
	return {
		deviceId,
		mode: "direct",
		online: false,
		stage,
		directUrl: row.directUrl,
		socketState: socketStateLabel(readyState),
		lastError: state.lastError,
		lastEventAt: state.lastEventAt,
		...persisted,
	};
}

export async function testDeviceConnection(
	deviceId: string,
): Promise<DeviceConnectionTestResult | null> {
	const row = await db.query.remoteDevices.findFirst({
		where: and(eq(remoteDevices.id, deviceId), isNull(remoteDevices.revokedAt)),
	});
	if (!row) return null;
	const startedAt = Date.now();
	if (!connections.has(deviceId) && row.connectionMode === "direct" && row.directUrl) {
		startDirectDial(deviceId, row.directUrl);
		const deadline = Date.now() + DEVICE_HANDSHAKE_TIMEOUT_MS;
		while (!connections.has(deviceId) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	const diagnostics = await getDeviceConnectionDiagnostics(deviceId);
	if (!diagnostics) return null;
	if (!connections.has(deviceId)) {
		return {
			ok: false,
			stage: diagnostics.stage,
			latencyMs: Date.now() - startedAt,
			message: row.connectionMode === "direct" ? (diagnostics.lastError ?? undefined) : undefined,
			diagnostics,
		};
	}

	try {
		await sendRpc(deviceId, "system.ping", {}, { timeoutMs: 5_000 });
		return {
			ok: true,
			stage: "rpc_ready",
			latencyMs: Date.now() - startedAt,
			diagnostics: (await getDeviceConnectionDiagnostics(deviceId)) ?? diagnostics,
		};
	} catch (err) {
		return {
			ok: false,
			stage: "rpc_failed",
			latencyMs: Date.now() - startedAt,
			message: err instanceof Error ? err.message : String(err),
			diagnostics: (await getDeviceConnectionDiagnostics(deviceId)) ?? diagnostics,
		};
	}
}

function scheduleDirectReconnect(state: DirectDialState): void {
	if (state.stopped) return;
	if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
	const delay = state.backoffMs;
	state.backoffMs = Math.min(state.backoffMs * 2, DIRECT_DIAL_MAX_BACKOFF_MS);
	state.reconnectTimer = setTimeout(() => void dialDirect(state), delay);
}

async function dialDirect(state: DirectDialState): Promise<void> {
	if (state.stopped) return;
	state.reconnectTimer = null;
	try {
		const row = await getDeviceRowForDial(state.deviceId);
		if (state.stopped) return;
		if (!row) {
			haltUnauthorizedDirectDial(
				state,
				"Device is revoked or no longer configured for direct dial",
			);
			return;
		}
		const authorization = await resolveOAuthDeviceRuntimeAuthorization(row);
		if (state.stopped) return;
		if (!authorization.allowed) {
			haltUnauthorizedDirectDial(
				state,
				authorization.reason ?? "OAuth device authorization is inactive",
			);
			return;
		}
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		state.lastEventAt = Date.now();
		logger.warn("Direct device authorization check failed", {
			deviceId: state.deviceId,
			error: state.lastError,
		});
		scheduleDirectReconnect(state);
		return;
	}

	let ws: WebSocket;
	try {
		ws = new WebSocket(state.url);
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		state.lastEventAt = Date.now();
		logger.warn("Direct dial failed to open", {
			deviceId: state.deviceId,
			error: state.lastError,
		});
		scheduleDirectReconnect(state);
		return;
	}
	if (state.stopped) {
		ws.close();
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
		if (state.ws !== ws || state.stopped) return;
		logger.info("Direct dial connected", { deviceId: state.deviceId, url: state.url });
		state.backoffMs = DIRECT_DIAL_MIN_BACKOFF_MS;
		state.authenticating = false;
		state.auth = null;
		state.lastError = null;
		state.lastEventAt = Date.now();
		if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
		state.handshakeTimer = setTimeout(() => {
			if (state.ws !== ws || connections.get(state.deviceId)?.transport === transport) return;
			transport.close(1008, "handshake timeout");
		}, DEVICE_HANDSHAKE_TIMEOUT_MS);
	});

	ws.addEventListener("message", (ev: MessageEvent) => {
		void handleDirectMessage(state, ws, transport, ev.data).catch((err: unknown) => {
			state.lastError = err instanceof Error ? err.message : String(err);
			state.lastEventAt = Date.now();
			logger.warn("Direct device handshake/message failed", {
				deviceId: state.deviceId,
				error: state.lastError,
			});
			transport.close(1011, "device message failed");
		});
	});

	ws.addEventListener("close", (event: CloseEvent) => {
		const deviceId = state.deviceId;
		state.lastError =
			event.reason || (event.code ? `WebSocket closed (${event.code})` : "WebSocket closed");
		state.lastEventAt = Date.now();
		teardownConnection(deviceId, transport);
		if (state.ws !== ws) return;
		if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
		state.handshakeTimer = null;
		state.authenticating = false;
		state.auth = null;
		state.ws = null;
		if (!state.stopped) scheduleDirectReconnect(state);
	});

	ws.addEventListener("error", () => {
		// The close handler drives reconnect; retain a concise diagnostic for the UI.
		state.lastError = "WebSocket connection error";
		state.lastEventAt = Date.now();
		logger.debug("Direct dial socket error", { deviceId: state.deviceId });
	});
}

async function handleDirectMessage(
	state: DirectDialState,
	ws: WebSocket,
	transport: DeviceTransport,
	raw: unknown,
): Promise<void> {
	if (state.stopped || state.ws !== ws) return;
	const liveConnection = connections.get(state.deviceId);
	const authenticated = liveConnection?.transport === transport;

	// Binary transfer data is forbidden until the final hello_ack has been sent.
	// Browser WebSocket implementations usually expose ArrayBuffer/Blob, while
	// Bun may deliver Buffer/Uint8Array (ArrayBufferView) for the same frame.
	if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
		if (!authenticated) {
			transport.close(1008, "binary before authentication");
			return;
		}
		const bytes =
			raw instanceof ArrayBuffer
				? new Uint8Array(raw)
				: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
		await handleBinaryFrame(state.deviceId, bytes);
		return;
	}
	if (typeof Blob !== "undefined" && raw instanceof Blob) {
		if (!authenticated) {
			transport.close(1008, "binary before authentication");
			return;
		}
		await handleBinaryFrame(state.deviceId, new Uint8Array(await raw.arrayBuffer()));
		return;
	}

	let frame: { type?: string };
	try {
		const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
		frame = JSON.parse(text);
	} catch {
		transport.close(1002, "invalid JSON frame");
		return;
	}
	if (!frame || typeof frame.type !== "string") {
		transport.close(1002, "invalid frame");
		return;
	}

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

	if (authenticated) {
		if (frame.type === "auth_init" || frame.type === "auth_proof" || frame.type === "hello") {
			transport.close(1002, "duplicate handshake frame");
			return;
		}
		processAuthenticatedFrame(state.deviceId, transport, frame);
		return;
	}

	if (
		frame.type === "rpc" ||
		frame.type === "rpc_cancel" ||
		frame.type === "rpc_result" ||
		frame.type === "rpc_stream"
	) {
		transport.close(1008, `${frame.type} before authentication`);
		return;
	}

	if (frame.type === "auth_init") {
		await handleDirectAuthInit(state, ws, transport, frame as unknown as DeviceAuthInitFrame);
		return;
	}
	if (frame.type === "auth_proof") {
		handleDirectAuthProof(state, transport, frame as unknown as DeviceAuthProofFrame);
		return;
	}
	if (frame.type === "hello") {
		const auth = state.auth;
		if (!auth?.executorVerified) {
			transport.close(1008, "hello before mutual authentication");
			return;
		}
		const hello = frame as unknown as DeviceHelloFrame;
		if (hello.deviceRef !== auth.deviceRef) {
			transport.close(1008, "hello device mismatch");
			return;
		}
		const deviceId = await registerConnection(transport, hello, auth.row, (reason) => {
			haltUnauthorizedDirectDial(state, reason, false);
		});
		if (deviceId) {
			if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
			state.handshakeTimer = null;
			state.auth = null;
		}
		return;
	}

	transport.close(1002, "unexpected pre-authentication frame");
}

async function handleDirectAuthInit(
	state: DirectDialState,
	ws: WebSocket,
	transport: DeviceTransport,
	frame: DeviceAuthInitFrame,
): Promise<void> {
	if (state.auth || state.authenticating) {
		transport.close(1002, "duplicate auth init");
		return;
	}
	if (
		frame.authVersion !== DEVICE_AUTH_VERSION ||
		!frame.deviceRef ||
		!isValidDeviceAuthNonce(frame.executorNonce)
	) {
		transport.close(1008, "invalid auth init");
		return;
	}

	state.authenticating = true;
	try {
		const row = await getDeviceRowForDial(state.deviceId);
		if (state.stopped || state.ws !== ws) return;
		if (!row || (frame.deviceRef !== row.slug && frame.deviceRef !== row.id)) {
			transport.close(1008, "device identity mismatch");
			return;
		}
		const key = deviceAuthKeyFromTokenHash(row.tokenHash);
		if (!key) {
			logger.error("Direct device has invalid token hash", { deviceId: row.id });
			transport.close(1011, "invalid server credential");
			return;
		}
		const serverNonce = generateDeviceAuthNonce();
		state.auth = {
			row,
			deviceRef: frame.deviceRef,
			executorNonce: frame.executorNonce,
			serverNonce,
			key,
			executorVerified: false,
		};
		const proof = createDeviceAuthProof(key, {
			authVersion: DEVICE_AUTH_VERSION,
			deviceRef: frame.deviceRef,
			executorNonce: frame.executorNonce,
			serverNonce,
			role: "server",
		});
		transport.send(
			JSON.stringify({
				type: "auth_challenge",
				authVersion: DEVICE_AUTH_VERSION,
				deviceRef: frame.deviceRef,
				executorNonce: frame.executorNonce,
				serverNonce,
				proof,
			}),
		);
	} finally {
		state.authenticating = false;
	}
}

function handleDirectAuthProof(
	state: DirectDialState,
	transport: DeviceTransport,
	frame: DeviceAuthProofFrame,
): void {
	const auth = state.auth;
	if (
		!auth ||
		auth.executorVerified ||
		frame.authVersion !== DEVICE_AUTH_VERSION ||
		frame.deviceRef !== auth.deviceRef ||
		frame.executorNonce !== auth.executorNonce ||
		frame.serverNonce !== auth.serverNonce
	) {
		transport.close(1008, "invalid auth proof context");
		return;
	}
	const valid = verifyDeviceAuthProof(
		auth.key,
		{
			authVersion: DEVICE_AUTH_VERSION,
			deviceRef: auth.deviceRef,
			executorNonce: auth.executorNonce,
			serverNonce: auth.serverNonce,
			role: "executor",
		},
		frame.proof,
	);
	if (!valid) {
		transport.close(1008, "executor authentication failed");
		return;
	}
	auth.executorVerified = true;
}

/** Fetch the configured, non-revoked direct device row for a dial. */
async function getDeviceRowForDial(deviceId: string) {
	const row = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.id, deviceId),
	});
	return row && !row.revokedAt && row.connectionMode === "direct" ? row : null;
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
		// Feed the handshake platform + default cwd + capability declaration into the
		// backend so tools can resolve paths on the remote machine without treating a
		// legacy executor's lexical path as canonical.
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
		const supportsFsStatResolvedPath = hello
			? deviceHasFeature(hello.capabilities, FS_STAT_RESOLVED_PATH_FEATURE)
			: undefined;
		const supportsFsReadAtomicResolvedPath = hello
			? deviceHasFeature(hello.capabilities, FS_READ_ATOMIC_RESOLVED_PATH_FEATURE)
			: undefined;
		return createRemoteBackend(deviceId, {
			connectionGeneration: ensureConnectionGeneration(conn),
			platform,
			defaultCwd: hello?.defaultCwd ?? null,
			supportsFsStatResolvedPath,
			supportsFsReadAtomicResolvedPath,
		});
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
