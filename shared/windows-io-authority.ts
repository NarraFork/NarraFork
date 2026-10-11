import { z } from "zod";

export const WINDOWS_IO_AUTHORITY_VERSION = 1 as const;
export const WINDOWS_IO_AUTHORITY_LIMITS = Object.freeze({
	payloadBytes: 16 * 1024,
	ticketBytes: 24 * 1024,
	helperMessageBytes: 1024 * 1024,
	queue: 64,
	signingTimeoutMs: 10_000,
	metadataTtlMs: 30_000,
	operationTtlMs: 120_000,
	attachmentTtlMs: 300_000,
});
function noControlCharacters(value: string): boolean {
	return [...value].every((character) => {
		const point = character.codePointAt(0) ?? 0;
		return point >= 32 && point !== 127 && !(point >= 0xd800 && point <= 0xdfff);
	});
}
const id = z.string().min(1).max(256).refine(noControlCharacters);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function canonicalNonce(value: string): boolean {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const remainder = value.length % 4;
	const last = alphabet.indexOf(value.at(-1) ?? "");
	return (
		remainder !== 1 && (remainder !== 2 || last % 16 === 0) && (remainder !== 3 || last % 4 === 0)
	);
}
const nonce = z
	.string()
	.regex(/^[A-Za-z0-9_-]{32,128}$/)
	.refine(canonicalNonce);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const windowsIoActionSchema = z.enum([
	"capture_exact",
	"prepare_owned",
	"restore_original",
	"seal_owned",
	"unseal_original",
	"cleanup_created",
	"status_original",
]);
export type WindowsIoAction = z.infer<typeof windowsIoActionSchema>;
export const windowsIoNativeDescriptorSchema = z.strictObject({
	volumeId: id,
	fileId: id,
	creationTime: id,
	pathKey: z.string().min(1).max(4096).refine(noControlCharacters),
});
export type WindowsIoNativeDescriptor = z.infer<typeof windowsIoNativeDescriptorSchema>;
export const windowsIoTicketPayloadSchema = z.strictObject({
	version: z.literal(WINDOWS_IO_AUTHORITY_VERSION),
	issuer: id,
	serviceId: id,
	keyEpoch: uint,
	deviceId: id,
	executorSourceId: id,
	helperInstanceId: id,
	challengeNonce: nonce,
	connectionId: id,
	sessionId: id,
	runtimeGeneration: uint,
	actorSubjectKey: id,
	narratorId: id.nullable(),
	projectId: id.nullable(),
	originRefHash: hash,
	action: windowsIoActionSchema,
	budgetClass: z.enum(["metadata", "operation", "attachment"]),
	scopeId: id,
	root: windowsIoNativeDescriptorSchema,
	parent: windowsIoNativeDescriptorSchema,
	target: windowsIoNativeDescriptorSchema,
	operationId: id,
	requestDigest: hash,
	leaseId: id,
	fence: uint,
	expectedCurrentMetadataHash: hash.nullable(),
	expectedCurrentContentHash: hash.nullable(),
	captureProofId: id.nullable(),
	preparedObjectId: id.nullable(),
	recoveryOriginal: z
		.strictObject({
			operationId: id,
			requestDigest: hash,
			leaseId: id,
			fence: uint,
		})
		.nullable(),
	issuedAt: uint,
	expiresAt: uint,
	nonce,
});
export type WindowsIoTicketPayload = z.infer<typeof windowsIoTicketPayloadSchema>;
export const windowsIoAuthorizationRequestSchema = windowsIoTicketPayloadSchema.omit({
	version: true,
	issuer: true,
	serviceId: true,
	keyEpoch: true,
	actorSubjectKey: true,
	narratorId: true,
	projectId: true,
	originRefHash: true,
	issuedAt: true,
	expiresAt: true,
	nonce: true,
});
export type WindowsIoAuthorizationRequest = z.infer<typeof windowsIoAuthorizationRequestSchema>;
export const windowsIoSignedTicketSchema = z.strictObject({
	payload: z
		.string()
		.min(1)
		.max(22 * 1024)
		.regex(/^[A-Za-z0-9_-]+$/),
	signature: z
		.string()
		.length(86)
		.regex(/^[A-Za-z0-9_-]+$/),
});
export type WindowsIoSignedTicket = z.infer<typeof windowsIoSignedTicketSchema>;
/** This descriptor never carries SD bytes. Only the helper's protected record can restore SD. */
export const windowsIoCaptureProofSchema = z.strictObject({
	version: z.literal(1),
	helperInstanceId: id,
	keyEpoch: uint,
	recordId: id,
	recordNonce: nonce,
	recordDigest: hash,
	signature: z
		.string()
		.length(86)
		.regex(/^[A-Za-z0-9_-]+$/),
});
export type WindowsIoCaptureProof = z.infer<typeof windowsIoCaptureProofSchema>;

/** Object keys are ASCII contract keys. Sign/verify these UTF-8 bytes, not reconstructed JSON. */
export function canonicalWindowsIoJson(value: unknown): string {
	if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
		if (typeof value === "number" && !Number.isFinite(value))
			throw new Error("Nonfinite authority value");
		return JSON.stringify(value);
	}
	if (typeof value !== "object") throw new Error("Unsupported authority value");
	if (Array.isArray(value)) return `[${value.map(canonicalWindowsIoJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalWindowsIoJson(record[key])}`)
		.join(",")}}`;
}
export function validateWindowsIoTicketPayload(value: unknown): WindowsIoTicketPayload {
	const payload = windowsIoTicketPayloadSchema.parse(value);
	const ttl = WINDOWS_IO_AUTHORITY_LIMITS[`${payload.budgetClass}TtlMs`];
	if (payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > ttl)
		throw new Error("Windows IO ticket lifetime exceeds action budget");
	if (
		["restore_original", "unseal_original", "seal_owned", "status_original"].includes(
			payload.action,
		) &&
		!payload.captureProofId
	)
		throw new Error("Original action requires helper capture proof");
	if (["prepare_owned", "cleanup_created"].includes(payload.action) && !payload.preparedObjectId)
		throw new Error("Owned action requires helper registered object");
	if (["prepare_owned", "cleanup_created"].includes(payload.action) && payload.captureProofId)
		throw new Error("Owned action cannot borrow original capture proof");
	if (
		payload.action === "capture_exact" &&
		(payload.captureProofId || payload.preparedObjectId || payload.recoveryOriginal)
	)
		throw new Error("Capture cannot borrow original/owned/recovery proof");
	if (
		payload.recoveryOriginal &&
		!["restore_original", "unseal_original", "status_original"].includes(payload.action)
	)
		throw new Error("Recovery proof is not authorization for another action");
	if (
		new TextEncoder().encode(canonicalWindowsIoJson(payload)).byteLength >
		WINDOWS_IO_AUTHORITY_LIMITS.payloadBytes
	)
		throw new Error("Windows IO ticket payload exceeds byte budget");
	return payload;
}
export function windowsIoTicketSignedBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalWindowsIoJson(validateWindowsIoTicketPayload(value)));
}
/** Reject duplicate keys, noncanonical numbers/escapes and unknown fields by exact round trip. */
export function parseWindowsIoTicketSignedBytes(bytes: Uint8Array): WindowsIoTicketPayload {
	if (bytes.byteLength > WINDOWS_IO_AUTHORITY_LIMITS.payloadBytes)
		throw new Error("Ticket too large");
	const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const payload = validateWindowsIoTicketPayload(JSON.parse(raw));
	if (canonicalWindowsIoJson(payload) !== raw)
		throw new Error("Noncanonical or duplicate ticket fields");
	return payload;
}
