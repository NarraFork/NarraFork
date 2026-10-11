import { z } from "zod";
import {
	canonicalWindowsIoJson,
	windowsIoActionSchema,
	windowsIoAuthorizationRequestSchema,
	windowsIoNativeDescriptorSchema,
	windowsIoSignedTicketSchema,
	windowsIoTicketPayloadSchema,
} from "./windows-io-authority";

export const WINDOWS_METADATA_CALLBACK_LIMITS = Object.freeze({
	requestBytes: 16 * 1024,
	responseBytes: 25 * 1024,
	queue: 64,
	workers: 2,
	timeoutMs: 10_000,
	stepsPerAdmission: 128,
	replayEntries: 4096,
});
const id = windowsIoTicketPayloadSchema.shape.operationId;
const digest = windowsIoTicketPayloadSchema.shape.requestDigest;
const nonce = windowsIoTicketPayloadSchema.shape.nonce;
export const windowsMetadataCallbackSchema = z.strictObject({
	type: z.literal("windows_metadata_callback"),
	version: z.literal(1),
	outerRpcId: id,
	stepId: id,
	nonce,
	action: windowsIoActionSchema,
	helperChallenge: z.strictObject({
		helperInstanceId: id,
		keyEpoch: windowsIoTicketPayloadSchema.shape.keyEpoch,
		challengeNonce: nonce,
		connectionId: id,
		sessionId: id,
		runtimeGeneration: windowsIoTicketPayloadSchema.shape.runtimeGeneration,
		signature: windowsIoSignedTicketSchema.shape.signature,
	}),
	descriptors: z.strictObject({
		root: windowsIoNativeDescriptorSchema,
		parent: windowsIoNativeDescriptorSchema,
		target: windowsIoNativeDescriptorSchema,
	}),
	proofIds: z.strictObject({ captureProofId: id.nullable(), preparedObjectId: id.nullable() }),
	expectedCurrent: z.strictObject({
		metadataHash: digest.nullable(),
		contentHash: digest.nullable(),
	}),
});
export type WindowsMetadataCallback = z.infer<typeof windowsMetadataCallbackSchema>;
/** Server-held original tuple. NEVER learned from callback actor/source/PID fields. */
export const windowsMetadataChallengeOriginSchema = windowsIoAuthorizationRequestSchema.pick({
	deviceId: true,
	executorSourceId: true,
	scopeId: true,
	root: true,
	operationId: true,
	requestDigest: true,
	leaseId: true,
	fence: true,
	runtimeGeneration: true,
	helperInstanceId: true,
	connectionId: true,
	sessionId: true,
});
export type WindowsMetadataChallengeOrigin = z.infer<typeof windowsMetadataChallengeOriginSchema>;
export const windowsMetadataCallbackResultSchema = z.strictObject({
	type: z.literal("windows_metadata_callback_result"),
	version: z.literal(1),
	outerRpcId: id,
	stepId: id,
	nonce,
	ticket: windowsIoSignedTicketSchema,
});
export type WindowsMetadataCallbackResult = z.infer<typeof windowsMetadataCallbackResultSchema>;

export function encodeWindowsMetadataCallback(value: unknown): Uint8Array {
	const bytes = new TextEncoder().encode(
		canonicalWindowsIoJson(windowsMetadataCallbackSchema.parse(value)),
	);
	if (bytes.byteLength > WINDOWS_METADATA_CALLBACK_LIMITS.requestBytes)
		throw new Error("Metadata callback exceeds byte budget");
	return bytes;
}
/** Requires the original raw frame: parsing and reconstructing request JSON loses duplicate keys. */
export function parseWindowsMetadataCallback(raw: string | Uint8Array): WindowsMetadataCallback {
	const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
	if (bytes.byteLength > WINDOWS_METADATA_CALLBACK_LIMITS.requestBytes)
		throw new Error("Metadata callback exceeds byte budget");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const parsed = windowsMetadataCallbackSchema.parse(JSON.parse(text));
	if (canonicalWindowsIoJson(parsed) !== text)
		throw new Error("Noncanonical or duplicate metadata callback fields");
	return parsed;
}
/** Ed25519 helper attestation over ALL callback fields (minus its signature) and the
 * original server tuple. This is a separate domain from tickets and capture proofs. */
export function windowsMetadataHelperChallengeSignedBytes(
	value: WindowsMetadataCallback,
	original: WindowsMetadataChallengeOrigin,
): Uint8Array {
	const parsed = windowsMetadataCallbackSchema.parse(value);
	const { signature: _signature, ...helperChallenge } = parsed.helperChallenge;
	// A server operation also has budget/current/proof fields; only this explicit
	// fixed tuple belongs to the challenge origin domain. Never project callback fields.
	const origin = Object.fromEntries(
		Object.keys(windowsMetadataChallengeOriginSchema.shape).map((key) => [
			key,
			original[key as keyof WindowsMetadataChallengeOrigin],
		]),
	);
	return new TextEncoder().encode(
		canonicalWindowsIoJson({
			domain: "windows_metadata_callback_challenge_v1",
			original: windowsMetadataChallengeOriginSchema.parse(origin),
			request: { ...parsed, helperChallenge },
		}),
	);
}
