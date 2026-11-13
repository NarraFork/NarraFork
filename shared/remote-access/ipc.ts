import type { RemoteBackendIdentity, RemoteRequestRule } from "./application";
import { remoteContractObject } from "./application";

export const REMOTE_IPC_VERSION = 2;
export const REMOTE_IPC_MAX_LINE_BYTES = 64 * 1024;
export const REMOTE_IPC_MAX_PENDING = 32;
export const REMOTE_IPC_COMMAND_TIMEOUT_MS = 15_000;
export const REMOTE_BRIDGE_HEADERS = Object.freeze({
	process: "x-narrafork-bridge",
	epoch: "x-narrafork-remote-epoch",
	context: "x-narrafork-remote-context",
	capability: "x-narrafork-remote-capability",
});
export const REMOTE_SESSION_INTROSPECT_PATH = "/_nf/remote/session/introspect";

export const REMOTE_IPC_TYPES = [
	"init",
	"ready",
	"pair.create",
	"pair.cancel",
	"grants.list",
	"grants.revoke",
	"peer.open",
	"peer.accept",
	"peer.reject",
	"peer.closed",
	"session.updated",
	"session.invalidated",
	"grant.changed",
	"command.result",
	"command.error",
	"status",
	"shutdown",
	"stopped",
] as const;
export type RemoteIpcType = (typeof REMOTE_IPC_TYPES)[number];

/** Result/error echo the command requestId. Unsolicited events use their own unique ID. */
export interface RemoteIpcEnvelope {
	ipcVersion: 2;
	epoch: string;
	requestId: string;
	type: RemoteIpcType;
	payload: Record<string, unknown>;
}

/** init.payload.config; all secrets travel through the private pipe, never argv/env. */
export interface RemotePeerInitConfig {
	mode: "narrafork";
	signalUrl: string;
	signalCAFile?: string;
	bridgeUrl: string;
	bridgeSecret: string;
	statePath: string;
	stunUrls: string[];
	iceIPAllowlist?: string[];
	iceInterfaceAllowlist?: string[];
	iceNetworkTypes?: ("udp4" | "udp6")[];
	allowLocalhost: boolean;
	leaseSeconds: number;
	backendIdentity: RemoteBackendIdentity;
	requestPolicy: RemoteRequestRule[];
}

/** Go emits only after ticket/hello verification and durable grant creation. */
export interface RemotePeerOpen {
	peerId: string;
	instanceId: string;
	grantId: string;
	clientPublicKey: string;
	grantExpiresAt: number;
}

/** peer.accept.payload; requests remain forbidden until Go receives this acknowledgement. */
export interface RemotePeerAccept {
	peerId: string;
	contextId: string;
	contextCapability: string;
	backendIdentity: RemoteBackendIdentity;
}

/** Private introspection response and session.updated.payload.session. Expiry is Unix seconds. */
export interface RemoteSessionProjection {
	sessionId: string;
	userId: string;
	role: "admin";
	expiresAt: number;
	authRevision: number;
}

export function isRemoteIpcId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function parseRemoteIpcEnvelope(value: unknown): RemoteIpcEnvelope {
	const record = remoteContractObject(value, [
		"ipcVersion",
		"epoch",
		"requestId",
		"type",
		"payload",
	]);
	if (
		record.ipcVersion !== REMOTE_IPC_VERSION ||
		!isRemoteIpcId(record.epoch) ||
		!isRemoteIpcId(record.requestId) ||
		!(REMOTE_IPC_TYPES as readonly unknown[]).includes(record.type) ||
		!record.payload ||
		typeof record.payload !== "object" ||
		Array.isArray(record.payload)
	)
		throw new Error("REMOTE_IPC_ENVELOPE_INVALID");
	return {
		ipcVersion: REMOTE_IPC_VERSION,
		epoch: record.epoch,
		requestId: record.requestId,
		type: record.type as RemoteIpcType,
		payload: record.payload as Record<string, unknown>,
	};
}

export function parseRemoteIpcLine(line: string): RemoteIpcEnvelope {
	if (new TextEncoder().encode(line).byteLength > REMOTE_IPC_MAX_LINE_BYTES)
		throw new Error("REMOTE_IPC_LINE_TOO_LARGE");
	return parseRemoteIpcEnvelope(JSON.parse(line));
}

export function encodeRemoteIpcEnvelope(message: RemoteIpcEnvelope): string {
	const line = JSON.stringify(parseRemoteIpcEnvelope(message));
	if (new TextEncoder().encode(line).byteLength > REMOTE_IPC_MAX_LINE_BYTES)
		throw new Error("REMOTE_IPC_LINE_TOO_LARGE");
	return `${line}\n`;
}

export function parseRemoteSessionProjection(value: unknown): RemoteSessionProjection {
	const record = remoteContractObject(value, [
		"sessionId",
		"userId",
		"role",
		"expiresAt",
		"authRevision",
	]);
	if (
		!isRemoteIpcId(record.sessionId) ||
		!isRemoteIpcId(record.userId) ||
		record.role !== "admin" ||
		!Number.isSafeInteger(record.expiresAt) ||
		(record.expiresAt as number) < 1 ||
		!Number.isSafeInteger(record.authRevision) ||
		(record.authRevision as number) < 0
	)
		throw new Error("REMOTE_SESSION_PROJECTION_INVALID");
	return {
		sessionId: record.sessionId,
		userId: record.userId,
		role: "admin",
		expiresAt: record.expiresAt as number,
		authRevision: record.authRevision as number,
	};
}
