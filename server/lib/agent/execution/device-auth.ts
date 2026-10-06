import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEVICE_AUTH_VERSION = 1;
export const DEVICE_AUTH_NONCE_BYTES = 32;

export type DeviceAuthRole = "server" | "executor";

const AUTH_DOMAIN = "narrafork-device-auth-v1";
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export interface DeviceAuthTranscriptInput {
	authVersion: number;
	deviceRef: string;
	executorNonce: string;
	serverNonce: string;
	role: DeviceAuthRole;
}

/**
 * Canonical UTF-8 transcript shared with the Go executor. The byte length on
 * deviceRef prevents delimiter ambiguity while keeping the wire values readable.
 */
export function buildDeviceAuthTranscript(input: DeviceAuthTranscriptInput): Uint8Array {
	const deviceRefBytes = Buffer.from(input.deviceRef, "utf8");
	return Buffer.from(
		`${AUTH_DOMAIN}\nauthVersion=${input.authVersion}\ndeviceRef=${deviceRefBytes.length}:${input.deviceRef}\nexecutorNonce=${input.executorNonce}\nserverNonce=${input.serverNonce}\nrole=${input.role}`,
		"utf8",
	);
}

export function generateDeviceAuthNonce(): string {
	return randomBytes(DEVICE_AUTH_NONCE_BYTES).toString("base64url");
}

export function isValidDeviceAuthNonce(value: unknown): value is string {
	if (typeof value !== "string" || !BASE64URL_32_BYTES.test(value)) return false;
	const decoded = Buffer.from(value, "base64url");
	return decoded.length === DEVICE_AUTH_NONCE_BYTES && decoded.toString("base64url") === value;
}

/** K = raw SHA-256(device token), represented by the DB's 64-character hex hash. */
export function deviceAuthKeyFromTokenHash(tokenHash: string): Uint8Array | null {
	if (!/^[a-fA-F0-9]{64}$/.test(tokenHash)) return null;
	return Buffer.from(tokenHash, "hex");
}

export function createDeviceAuthProof(key: Uint8Array, input: DeviceAuthTranscriptInput): string {
	if (key.byteLength !== 32) throw new Error("device auth key must be 32 bytes");
	return createHmac("sha256", key).update(buildDeviceAuthTranscript(input)).digest("base64url");
}

export function verifyDeviceAuthProof(
	key: Uint8Array,
	input: DeviceAuthTranscriptInput,
	proof: unknown,
): boolean {
	if (typeof proof !== "string" || !BASE64URL_32_BYTES.test(proof)) return false;
	const actual = Buffer.from(proof, "base64url");
	if (actual.length !== 32 || actual.toString("base64url") !== proof) return false;
	const expected = Buffer.from(createDeviceAuthProof(key, input), "base64url");
	return timingSafeEqual(actual, expected);
}
