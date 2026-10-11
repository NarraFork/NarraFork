import { z } from "zod";
import {
	canonicalWindowsIoJson,
	windowsIoCaptureProofSchema,
	windowsIoNativeDescriptorSchema,
	windowsIoTicketPayloadSchema,
} from "./windows-io-authority";

export const WINDOWS_FIRST_CAPTURE_FEATURE = "windows.metadata.first-capture.v1";
export const WINDOWS_FIRST_CAPTURE_METHODS = [
	"history.metadataPreauthorize",
	"history.metadataCapture",
] as const;
export type WindowsFirstCaptureMethod = (typeof WINDOWS_FIRST_CAPTURE_METHODS)[number];
export const WINDOWS_FIRST_CAPTURE_LIMITS = Object.freeze({
	envelopeBytes: 16 * 1024,
	httpBytes: 16 * 1024,
	publicBytes: 64 * 1024,
	tokenTtlMs: 30_000,
	rpcTimeoutMs: 30_000,
	perConnection: 4,
	processTokens: 64,
	ancestorPins: 64,
	workers: 2,
	queue: 64,
	configurationBytes: 64 * 1024,
});
/** FILE_READ_DATA|FILE_READ_EA|FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES|READ_CONTROL|SYNCHRONIZE.
 * Descriptive ordinary-handle evidence only, never permission to augment rights. */
export const WINDOWS_FIRST_CAPTURE_ORDINARY_ACCESS = 0x120189;
const id = windowsIoTicketPayloadSchema.shape.operationId;
const hash = windowsIoTicketPayloadSchema.shape.requestDigest;
const nonce = windowsIoTicketPayloadSchema.shape.nonce;
const uint = windowsIoTicketPayloadSchema.shape.runtimeGeneration;
const publicKey = z
	.string()
	.length(43)
	.regex(/^[A-Za-z0-9_-]+$/);
export const windowsFirstCaptureOriginSchema = z.strictObject({
	version: z.literal(1),
	deviceId: id,
	executorSourceId: id,
	scopeId: id,
	root: windowsIoNativeDescriptorSchema,
	helperInstanceId: id,
	helperKeyEpoch: uint,
	operationId: id,
	requestDigest: hash,
	leaseId: id,
	fence: uint,
	connectionId: id,
	sessionId: id,
	runtimeGeneration: uint,
	action: z.literal("capture_exact"),
	phase: z.enum(["preauthorize", "capture"]),
	outerRpcId: id,
});
export type WindowsFirstCaptureOrigin = z.infer<typeof windowsFirstCaptureOriginSchema>;
export const windowsFirstCaptureOriginSeedSchema = windowsFirstCaptureOriginSchema.omit({
	outerRpcId: true,
});
export type WindowsFirstCaptureOriginSeed = z.infer<typeof windowsFirstCaptureOriginSeedSchema>;
export const windowsFirstCaptureHttpSchema = z.strictObject({
	path: windowsIoNativeDescriptorSchema.shape.pathKey,
	deviceId: id.optional(),
	requestId: z
		.string()
		.min(8)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
});
export const windowsMetadataPreauthorizeParamsSchema = z.strictObject({
	version: z.literal(1),
	path: windowsIoNativeDescriptorSchema.shape.pathKey,
	nonce,
});
export type WindowsMetadataPreauthorizeParams = z.infer<
	typeof windowsMetadataPreauthorizeParamsSchema
>;
export const windowsMetadataCaptureParamsSchema = z.strictObject({
	version: z.literal(1),
	token: nonce,
	preauthRpcId: id,
	preauthNonce: nonce,
	captureNonce: nonce,
});
export type WindowsMetadataCaptureParams = z.infer<typeof windowsMetadataCaptureParamsSchema>;
export const windowsFirstCaptureSignedEnvelopeSchema = z.strictObject({
	version: z.literal(1),
	payload: z
		.string()
		.min(1)
		.max(64 * 1024 - 256)
		.regex(/^[A-Za-z0-9_-]+$/),
	signature: z
		.string()
		.length(86)
		.regex(/^[A-Za-z0-9_-]+$/),
});
export type WindowsFirstCaptureSignedEnvelope = z.infer<
	typeof windowsFirstCaptureSignedEnvelopeSchema
>;
export const windowsFirstCaptureDescriptorsSchema = z.strictObject({
	root: windowsIoNativeDescriptorSchema,
	parent: windowsIoNativeDescriptorSchema,
	target: windowsIoNativeDescriptorSchema,
});
const exact = z.literal("captured_exact");
const presentOrAbsent = z.enum(["captured_exact", "known_absent"]);
/** Exactly the native ordinary-file-v2 PUBLIC descriptor; no SD, EA or stream bytes. */
export const windowsFirstCaptureDescriptorSchema = z.strictObject({
	version: z.literal(2),
	platform: z.literal("windows"),
	matrix: z.literal("ordinary-file-v2"),
	coverage: z.literal("complete"),
	proof: windowsIoCaptureProofSchema,
	root: windowsIoNativeDescriptorSchema,
	parent: windowsIoNativeDescriptorSchema,
	target: windowsIoNativeDescriptorSchema,
	metadataDigest: hash,
	contentDigest: hash,
	attributes: z.number().int().nonnegative().max(0xffffffff),
	fields: z.strictObject({
		owner: exact,
		group: exact,
		dacl: exact,
		sacl: exact,
		label: exact,
		specialSecurity: z.literal("known_absent"),
		times: exact,
		attributes: exact,
		ea: presentOrAbsent,
		streams: presentOrAbsent,
		singleLink: exact,
		ordinaryFile: exact,
	}),
});
export type WindowsFirstCaptureDescriptor = z.infer<typeof windowsFirstCaptureDescriptorSchema>;
export const windowsMetadataPreauthorizationPayloadSchema = z.strictObject({
	domain: z.literal("windows_metadata_preauthorization_v1"),
	version: z.literal(1),
	origin: windowsFirstCaptureOriginSchema.refine((origin) => origin.phase === "preauthorize"),
	preauthNonce: nonce,
	tokenDigest: hash,
	issuedAt: uint,
	expiresAt: uint,
	helperInstanceId: id,
	helperKeyEpoch: uint,
	descriptors: windowsFirstCaptureDescriptorsSchema,
	ordinaryHandle: z.strictObject({
		grantedAccess: z.number().int().nonnegative().max(0xffffffff),
		requiredAccess: z.literal(WINDOWS_FIRST_CAPTURE_ORDINARY_ACCESS),
		sameAccessDuplicate: z.literal(true),
		objectKind: z.literal("ordinary_regular"),
		linkCount: z.literal(1),
		reparse: z.literal(false),
		ancestorPins: z.number().int().min(1).max(WINDOWS_FIRST_CAPTURE_LIMITS.ancestorPins),
		observation: z.literal("describe_ordinary_no_read"),
	}),
});
export type WindowsMetadataPreauthorizationPayload = z.infer<
	typeof windowsMetadataPreauthorizationPayloadSchema
>;
export const windowsMetadataPreauthorizeResultSchema = z.strictObject({
	version: z.literal(1),
	token: nonce,
	attestation: windowsFirstCaptureSignedEnvelopeSchema,
});
export type WindowsMetadataPreauthorizeResult = z.infer<
	typeof windowsMetadataPreauthorizeResultSchema
>;
export const windowsMetadataCaptureResultPayloadSchema = z.strictObject({
	domain: z.literal("windows_metadata_capture_result_v1"),
	version: z.literal(1),
	origin: windowsFirstCaptureOriginSchema.refine((origin) => origin.phase === "capture"),
	preauthorization: z.strictObject({
		outerRpcId: id,
		nonce,
		tokenDigest: hash,
		attestationDigest: hash,
	}),
	captureNonce: nonce,
	challengeNonce: nonce,
	ticketPayloadDigest: hash,
	ticketActor: z.strictObject({
		actorSubjectKey: id,
		narratorId: id.nullable(),
		projectId: id.nullable(),
		originRefHash: hash,
		issuer: id,
		serviceId: id,
		keyEpoch: uint,
	}),
	helperInstanceId: id,
	helperKeyEpoch: uint,
	descriptor: windowsFirstCaptureDescriptorSchema,
	completion: z.strictObject({ state: z.literal("captured"), recordId: id, recordDigest: hash }),
});
export type WindowsMetadataCaptureResultPayload = z.infer<
	typeof windowsMetadataCaptureResultPayloadSchema
>;
export const windowsMetadataCaptureResultSchema = z.strictObject({
	version: z.literal(1),
	attestation: windowsFirstCaptureSignedEnvelopeSchema,
});
export type WindowsMetadataCaptureResult = z.infer<typeof windowsMetadataCaptureResultSchema>;
/** Administrator-preinstalled public material. No issuer key, bearer or private SD. */
export const windowsFirstCaptureEnrollmentSchema = z.strictObject({
	version: z.literal(2),
	enrollmentId: id,
	revision: uint,
	matrix: z.literal("ordinary-file-v2"),
	deviceId: id,
	executorSourceId: id,
	root: windowsIoNativeDescriptorSchema,
	helperInstanceId: id,
	helperPublicKey: publicKey,
	helperKeyEpoch: uint,
	pipePeer: z.strictObject({
		name: z.string().min(1).max(256),
		processId: z.number().int().min(1).max(0xffffffff),
		creationTime: z.string().regex(/^[1-9][0-9]{0,19}$/),
		sid: id,
	}),
	session: z.strictObject({ connectionId: id, sessionId: id, runtimeGeneration: uint }),
	policy: z.literal("capture_only_existing_ordinary_v2"),
});
export type WindowsFirstCaptureEnrollment = z.infer<typeof windowsFirstCaptureEnrollmentSchema>;
export const windowsFirstCaptureEnrollmentInspectionRequestSchema = z.strictObject({
	version: z.literal(1),
	method: z.literal("inspect_windows_first_capture_enrollment"),
	challenge: nonce,
});
export const windowsFirstCaptureEnrollmentInspectionPayloadSchema = z.strictObject({
	domain: z.literal("windows_metadata_public_enrollment_inspection_v1"),
	version: z.literal(1),
	challenge: nonce,
	issuedAt: uint,
	brokerServiceId: id,
	configDigest: hash,
	enrollmentFileDigest: hash,
	enrollment: windowsFirstCaptureEnrollmentSchema,
});
export type WindowsFirstCaptureEnrollmentInspectionPayload = z.infer<
	typeof windowsFirstCaptureEnrollmentInspectionPayloadSchema
>;

export function canonicalWindowsFirstCaptureBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalWindowsIoJson(value));
}
/** Original RAW canonical bytes are required to reject duplicate JSON fields and UTF8 junk. */
export function parseWindowsFirstCaptureBytes<T>(
	bytes: Uint8Array,
	schema: z.ZodType<T>,
	limit = WINDOWS_FIRST_CAPTURE_LIMITS.publicBytes,
): T {
	if (bytes.byteLength > limit) throw new Error("Windows first-capture byte budget exceeded");
	const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const parsed = schema.parse(JSON.parse(raw));
	if (canonicalWindowsIoJson(parsed) !== raw)
		throw new Error("Noncanonical or duplicate first-capture fields");
	return parsed;
}
export function validateWindowsMetadataPreauthorizationPayload(
	value: unknown,
): WindowsMetadataPreauthorizationPayload {
	const payload = windowsMetadataPreauthorizationPayloadSchema.parse(value);
	if (
		payload.expiresAt <= payload.issuedAt ||
		payload.expiresAt - payload.issuedAt > WINDOWS_FIRST_CAPTURE_LIMITS.tokenTtlMs ||
		(payload.ordinaryHandle.grantedAccess & WINDOWS_FIRST_CAPTURE_ORDINARY_ACCESS) !==
			WINDOWS_FIRST_CAPTURE_ORDINARY_ACCESS
	)
		throw new Error("First-capture ordinary access or TTL evidence is incomplete");
	return payload;
}
export function validateWindowsFirstCaptureRpc(
	method: WindowsFirstCaptureMethod,
	idValue: string,
	origin: unknown,
	params: unknown,
) {
	if (!WINDOWS_FIRST_CAPTURE_METHODS.includes(method))
		throw new Error("Unknown first-capture method");
	const parsed = windowsFirstCaptureOriginSchema.parse(origin);
	const phase = method === "history.metadataPreauthorize" ? "preauthorize" : "capture";
	if (parsed.outerRpcId !== idValue || parsed.phase !== phase)
		throw new Error("First-capture method/origin/frame correlation mismatch");
	const argumentsValue =
		phase === "preauthorize"
			? windowsMetadataPreauthorizeParamsSchema.parse(params)
			: windowsMetadataCaptureParamsSchema.parse(params);
	if (
		canonicalWindowsFirstCaptureBytes({ origin: parsed, params: argumentsValue }).byteLength >
		WINDOWS_FIRST_CAPTURE_LIMITS.envelopeBytes
	)
		throw new Error("First-capture request exceeds envelope budget");
	return { origin: parsed, params: argumentsValue };
}
