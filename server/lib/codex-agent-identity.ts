/**
 * Codex Agent Identity authentication.
 *
 * Agent Identity uses an Ed25519 keypair (PKCS#8, base64) plus a runtime id and
 * a task id. Requests are authenticated with an `AgentAssertion <base64url>`
 * header instead of a bearer token. The assertion is a signed JSON envelope of
 * `runtime_id:task_id:timestamp`.
 *
 * When a task id is absent it must be registered against the agent auth API. The
 * registration response may return the task id in clear text or as an encrypted
 * blob sealed to the agent's public key (NaCl crypto_box_seal), which is
 * decrypted with a Curve25519 key derived from the Ed25519 seed.
 *
 * Reference: sub2api openai_agent_identity.go
 */

import crypto from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";

export const CODEX_AGENT_IDENTITY_AUTH_MODE = "agent_identity";

const AUTH_API_BASE_URL = "https://auth.openai.com/api/accounts";
const TASK_REGISTRATION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Test seam: allow overriding the agent auth API base URL. */
let authApiBaseUrl = AUTH_API_BASE_URL;
export function __setCodexAgentIdentityBaseUrlForTests(url?: string): void {
	authApiBaseUrl = url ?? AUTH_API_BASE_URL;
}

export interface AgentIdentityKey {
	runtimeId: string;
	privateKey: crypto.KeyObject;
	taskId?: string;
}

/**
 * Parse and validate a PKCS#8 base64 Ed25519 private key. Never logs or returns
 * the raw key material.
 */
export function parseAgentPrivateKey(encoded: string): crypto.KeyObject {
	const raw = (encoded ?? "").trim();
	if (!raw) throw new Error("agent identity private key is missing");
	let der: Buffer;
	try {
		der = Buffer.from(raw, "base64");
	} catch {
		throw new Error("agent identity private key is not valid base64");
	}
	if (der.length === 0) {
		throw new Error("agent identity private key is not valid base64");
	}
	let key: crypto.KeyObject;
	try {
		key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
	} catch {
		throw new Error("agent identity private key is not valid PKCS#8");
	}
	if (key.asymmetricKeyType !== "ed25519") {
		throw new Error("agent identity private key is not Ed25519");
	}
	return key;
}

/**
 * Validate a PKCS#8 base64 Ed25519 private key. Returns an error message on
 * failure, or null when valid.
 */
export function validateAgentPrivateKey(encoded: string): string | null {
	try {
		parseAgentPrivateKey(encoded);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : "invalid agent identity private key";
	}
}

/** Extract the 32-byte Ed25519 seed from a PKCS#8 key object. */
function ed25519Seed(privateKey: crypto.KeyObject): Uint8Array {
	const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
	// PKCS#8 Ed25519 encodes the 32-byte seed as the trailing OCTET STRING.
	return pkcs8.subarray(pkcs8.length - 32);
}

function signEd25519(privateKey: crypto.KeyObject, payload: Uint8Array): Uint8Array {
	// Ed25519 signing uses a null digest algorithm in Node/Bun crypto.
	return new Uint8Array(crypto.sign(null, Buffer.from(payload), privateKey));
}

/**
 * Build an `AgentAssertion <base64url>` authorization header value.
 */
export function buildAgentAssertion(key: AgentIdentityKey, now: Date = new Date()): string {
	if (!key.runtimeId) throw new Error("agent identity runtime id is missing");
	if (!key.taskId) throw new Error("agent identity task id is missing");
	const timestamp = toRfc3339(now);
	const payload = new TextEncoder().encode(`${key.runtimeId}:${key.taskId}:${timestamp}`);
	const signature = signEd25519(key.privateKey, payload);
	const envelope = {
		agent_runtime_id: key.runtimeId,
		task_id: key.taskId,
		timestamp,
		signature: Buffer.from(signature).toString("base64"),
	};
	const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64url");
	return `AgentAssertion ${encoded}`;
}

function toRfc3339(date: Date): string {
	// RFC3339 UTC with seconds precision, e.g. 2026-04-01T12:34:56Z
	return `${date.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

interface TaskRegistrationResponse {
	task_id?: string;
	taskId?: string;
	encrypted_task_id?: string;
	encryptedTaskId?: string;
}

function pfetch(url: string, init: RequestInit, proxy?: string): Promise<Response> {
	if (proxy) {
		// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
		return fetch(url, { ...init, proxy } as any);
	}
	return fetch(url, init);
}

async function readLimitedText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const size = Math.min(total, MAX_RESPONSE_BYTES);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= size) break;
		const slice = chunk.subarray(0, size - offset);
		bytes.set(slice, offset);
		offset += slice.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Decrypt an encrypted task id sealed to the agent's Curve25519 public key
 * (NaCl crypto_box_seal). The Curve25519 keypair is derived from the Ed25519
 * seed exactly as libsodium's crypto_sign_ed25519_sk_to_curve25519.
 */
export function decryptEncryptedTaskId(privateKey: crypto.KeyObject, encoded: string): string {
	let ciphertext: Buffer;
	try {
		ciphertext = Buffer.from((encoded ?? "").trim(), "base64");
	} catch {
		throw new Error("encrypted agent task id is not valid base64");
	}
	if (ciphertext.length <= 32) {
		throw new Error("encrypted agent task id is too short");
	}

	const seed = ed25519Seed(privateKey);
	const digest = crypto.createHash("sha512").update(Buffer.from(seed)).digest();
	const curvePrivate = new Uint8Array(digest.subarray(0, 32));
	curvePrivate[0] &= 248;
	curvePrivate[31] &= 127;
	curvePrivate[31] |= 64;
	const curvePublic = nacl.scalarMult.base(curvePrivate);

	const ephemeralPublic = new Uint8Array(ciphertext.subarray(0, 32));
	const sealed = new Uint8Array(ciphertext.subarray(32));
	const nonce = blake2b(new Uint8Array([...ephemeralPublic, ...curvePublic]), { dkLen: 24 });
	const plaintext = nacl.box.open(sealed, nonce, ephemeralPublic, curvePrivate);
	if (!plaintext) {
		throw new Error("failed to decrypt encrypted agent task id");
	}
	const taskId = new TextDecoder().decode(plaintext).trim();
	if (!taskId) {
		throw new Error("decrypted agent task id is empty");
	}
	return taskId;
}

/**
 * Register a new task for an agent runtime and return the resolved task id.
 */
export async function registerAgentIdentityTask(
	key: AgentIdentityKey,
	proxy?: string,
): Promise<string> {
	if (!key.runtimeId) throw new Error("agent identity runtime id is missing");
	const timestamp = toRfc3339(new Date());
	const signaturePayload = new TextEncoder().encode(`${key.runtimeId}:${timestamp}`);
	const signature = Buffer.from(signEd25519(key.privateKey, signaturePayload)).toString("base64");

	const url = `${authApiBaseUrl.replace(/\/+$/, "")}/v1/agent/${encodeURIComponent(key.runtimeId)}/task/register`;
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort(new Error("agent task registration timed out"));
	}, TASK_REGISTRATION_TIMEOUT_MS);

	try {
		const response = await pfetch(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({ timestamp, signature }),
				signal: abortController.signal,
			},
			proxy,
		);
		if (!response.ok) {
			throw new Error(`agent task registration returned status ${response.status}`);
		}
		const raw = await readLimitedText(response);
		let result: TaskRegistrationResponse;
		try {
			result = JSON.parse(raw) as TaskRegistrationResponse;
		} catch {
			throw new Error("agent task registration response is invalid");
		}
		const plain = (result.task_id ?? result.taskId ?? "").trim();
		if (plain) return plain;
		const encrypted = (result.encrypted_task_id ?? result.encryptedTaskId ?? "").trim();
		if (!encrypted) {
			throw new Error("agent task registration response omitted task id");
		}
		return decryptEncryptedTaskId(key.privateKey, encrypted);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Detect whether an upstream response indicates the current task id is invalid
 * or expired and should be re-registered.
 */
export function isAgentTaskInvalidResponse(status: number, body: string): boolean {
	if (status !== 401) return false;
	return agentTaskInvalidMarkersPresent(body);
}

/**
 * Message-based variant used when only a stringified upstream error is
 * available (the provider concatenates status + body into the error message).
 */
export function isAgentTaskInvalidMessage(message: string): boolean {
	const lower = (message ?? "").toLowerCase();
	if (!lower.includes("401") && !lower.includes("unauthorized")) return false;
	return agentTaskInvalidMarkersPresent(message);
}

function agentTaskInvalidMarkersPresent(body: string): boolean {
	const lower = (body ?? "").toLowerCase();
	const compact = lower.replace(/[\s]/g, "");
	const jsonMarkers = [
		'"code":"invalid_task_id"',
		'"code":"task_not_found"',
		'"code":"task_expired"',
		'"error":"invalid_task_id"',
	];
	for (const marker of jsonMarkers) {
		if (compact.includes(marker)) return true;
	}
	const textMarkers = [
		"invalid task_id",
		"invalid task id",
		"task_id is invalid",
		"task id is invalid",
		"task not found",
		"task expired",
		"unknown task_id",
		"unknown task id",
	];
	for (const marker of textMarkers) {
		if (lower.includes(marker)) return true;
	}
	return false;
}
