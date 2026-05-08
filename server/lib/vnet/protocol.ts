import type { VNetClientMessage, VNetEndpoint, VNetUdpClientPacket } from "./types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Bytes(value: string): Uint8Array {
	return textEncoder.encode(value);
}

export function utf8String(value: ArrayBuffer | ArrayBufferView): string {
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
	return textDecoder.decode(bytes);
}

function toUint8Array(value: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function base64UrlEncode(value: ArrayBuffer | ArrayBufferView): string {
	const bytes = toUint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function randomBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return bytes;
}

export function randomToken(size = 18): string {
	return base64UrlEncode(randomBytes(size));
}

export function randomNonce(): string {
	return base64UrlEncode(randomBytes(12));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isEndpoint(value: unknown): value is VNetEndpoint {
	if (!isRecord(value)) return false;
	if (value.transport !== "relay" && value.transport !== "udp") return false;
	if (value.address !== undefined && typeof value.address !== "string") return false;
	if (value.port !== undefined && !isNumber(value.port)) return false;
	if (value.observedAt !== undefined && !isNumber(value.observedAt)) return false;
	return true;
}

function isRelayPacket(value: Record<string, unknown>): boolean {
	if (value.type !== "relay_packet") return false;
	if (value.toPeerId !== undefined && typeof value.toPeerId !== "string") return false;
	if (value.dstIp !== undefined && typeof value.dstIp !== "string") return false;
	if (value.srcIp !== undefined && typeof value.srcIp !== "string") return false;
	if (value.srcPort !== undefined && !isNumber(value.srcPort)) return false;
	if (value.dstPort !== undefined && !isNumber(value.dstPort)) return false;
	return isNumber(value.seq) && isString(value.nonce) && isString(value.ciphertext);
}

export function isVNetClientMessage(value: unknown): value is VNetClientMessage {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "hello": {
			const endpoints = value.endpoints;
			return (
				isString(value.networkId) &&
				isString(value.peerId) &&
				isString(value.virtualIp) &&
				(value.displayName === undefined || typeof value.displayName === "string") &&
				(endpoints === undefined ||
					(Array.isArray(endpoints) && endpoints.every((endpoint) => isEndpoint(endpoint)))) &&
				(value.capabilities === undefined || isRecord(value.capabilities))
			);
		}
		case "relay_packet":
			return isRelayPacket(value);
		case "punch_request":
			return isString(value.toPeerId) && (value.tid === undefined || typeof value.tid === "string");
		case "pong":
			return true;
		default:
			return false;
	}
}

export function isVNetUdpClientPacket(value: unknown): value is VNetUdpClientPacket {
	if (!isRecord(value)) return false;
	if (value.type !== "register" && value.type !== "punch_probe") return false;
	if (
		!isString(value.sessionId) ||
		!isString(value.networkId) ||
		!isString(value.peerId) ||
		!isNumber(value.timestamp) ||
		!isString(value.nonce) ||
		!isString(value.authTag)
	) {
		return false;
	}
	if (value.type === "punch_probe") {
		return isString(value.toPeerId) && isString(value.tid);
	}
	return true;
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
	return `{${entries.join(",")}}`;
}

export function jsonByteLength(value: unknown): number {
	return utf8Bytes(JSON.stringify(value)).byteLength;
}

export function encodeJson(value: unknown): string {
	return JSON.stringify(value);
}

export function decodeJson(value: string | Buffer | ArrayBuffer | ArrayBufferView): unknown {
	const text = typeof value === "string" ? value : utf8String(value);
	return JSON.parse(text);
}
