import { createHash, createPublicKey, verify } from "node:crypto";
import {
	canonicalWindowsFirstCaptureBytes,
	parseWindowsFirstCaptureBytes,
	validateWindowsMetadataPreauthorizationPayload,
	WINDOWS_FIRST_CAPTURE_LIMITS,
	type WindowsFirstCaptureEnrollment,
	type WindowsFirstCaptureOrigin,
	type WindowsFirstCaptureSignedEnvelope,
	type WindowsMetadataCaptureResultPayload,
	type WindowsMetadataPreauthorizationPayload,
	windowsFirstCaptureEnrollmentInspectionPayloadSchema,
	windowsFirstCaptureSignedEnvelopeSchema,
	windowsMetadataCaptureResultPayloadSchema,
	windowsMetadataCaptureResultSchema,
	windowsMetadataPreauthorizationPayloadSchema,
	windowsMetadataPreauthorizeResultSchema,
} from "@shared/windows-first-capture";
import type { WindowsIoSignedTicket, WindowsIoTicketPayload } from "@shared/windows-io-authority";
import { parseWindowsIoTicketSignedBytes as parseTicketBytes } from "@shared/windows-io-authority";
import type { z } from "zod";
import {
	decodeWindowsIoBase64url,
	verifyWindowsIoCaptureProof,
	windowsIoTicketPayloadDigest,
} from "./windows-io-authority-crypto";

export function firstCaptureHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function equal(left: unknown, right: unknown): boolean {
	return Buffer.from(canonicalWindowsFirstCaptureBytes(left)).equals(
		Buffer.from(canonicalWindowsFirstCaptureBytes(right)),
	);
}
function key(raw: string) {
	const bytes = decodeWindowsIoBase64url(raw, 32);
	if (bytes.byteLength !== 32) throw new Error("Invalid administrator first-capture public pin");
	return createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]),
		format: "der",
		type: "spki",
	});
}
export function verifyFirstCaptureEnvelope<T>(
	value: unknown,
	publicPin: string,
	schema: z.ZodType<T>,
): { payload: T; payloadDigest: string; envelope: WindowsFirstCaptureSignedEnvelope } {
	const envelope = windowsFirstCaptureSignedEnvelopeSchema.parse(value);
	if (Buffer.byteLength(JSON.stringify(envelope)) > WINDOWS_FIRST_CAPTURE_LIMITS.publicBytes)
		throw new Error("First-capture signed result too large");
	const bytes = decodeWindowsIoBase64url(
		envelope.payload,
		WINDOWS_FIRST_CAPTURE_LIMITS.publicBytes,
	);
	const signature = decodeWindowsIoBase64url(envelope.signature, 64);
	if (!verify(null, bytes, key(publicPin), signature))
		throw new Error("Untrusted first-capture attestation");
	return {
		payload: parseWindowsFirstCaptureBytes(bytes, schema),
		payloadDigest: firstCaptureHash(bytes),
		envelope,
	};
}
export interface VerifiedFirstCapturePreauthorization {
	readonly payload: WindowsMetadataPreauthorizationPayload;
	readonly token: string;
	readonly payloadDigest: string;
}
export function verifyFirstCapturePreauthorization(
	value: unknown,
	expected: {
		origin: WindowsFirstCaptureOrigin;
		nonce: string;
		enrollment: WindowsFirstCaptureEnrollment;
		now: number;
	},
): VerifiedFirstCapturePreauthorization {
	const response = windowsMetadataPreauthorizeResultSchema.parse(value);
	if (Buffer.byteLength(JSON.stringify(response)) > WINDOWS_FIRST_CAPTURE_LIMITS.publicBytes)
		throw new Error("Preauthorization result too large");
	const signed = verifyFirstCaptureEnvelope(
		response.attestation,
		expected.enrollment.helperPublicKey,
		windowsMetadataPreauthorizationPayloadSchema,
	);
	const payload = validateWindowsMetadataPreauthorizationPayload(signed.payload);
	if (
		!equal(payload.origin, expected.origin) ||
		payload.preauthNonce !== expected.nonce ||
		payload.origin.deviceId !== expected.enrollment.deviceId ||
		payload.origin.executorSourceId !== expected.enrollment.executorSourceId ||
		payload.origin.connectionId !== expected.enrollment.session.connectionId ||
		payload.origin.sessionId !== expected.enrollment.session.sessionId ||
		payload.origin.runtimeGeneration !== expected.enrollment.session.runtimeGeneration ||
		payload.helperInstanceId !== expected.enrollment.helperInstanceId ||
		payload.helperKeyEpoch !== expected.enrollment.helperKeyEpoch ||
		payload.origin.helperInstanceId !== payload.helperInstanceId ||
		payload.origin.helperKeyEpoch !== payload.helperKeyEpoch ||
		!equal(payload.descriptors.root, expected.enrollment.root) ||
		!equal(payload.descriptors.root, expected.origin.root) ||
		payload.issuedAt > expected.now ||
		payload.expiresAt <= expected.now ||
		payload.tokenDigest !== firstCaptureHash(decodeWindowsIoBase64url(response.token, 96))
	)
		throw new Error("Preauthorization differs from original pending/root/token/session binding");
	Object.freeze(payload.origin.root);
	Object.freeze(payload.origin);
	Object.freeze(payload.descriptors.root);
	Object.freeze(payload.descriptors.parent);
	Object.freeze(payload.descriptors.target);
	Object.freeze(payload.descriptors);
	Object.freeze(payload.ordinaryHandle);
	Object.freeze(payload);
	return Object.freeze({ payload, token: response.token, payloadDigest: signed.payloadDigest });
}
/** Only call on the actual success return from production authority.issueTicket.
 * The nonce/iat/expiry digest is over original signed bytes, never a request skeleton. */
export interface FirstCaptureIssuedTicket {
	readonly ticket: WindowsIoSignedTicket;
	readonly payload: WindowsIoTicketPayload;
	readonly payloadDigest: string;
}
export function firstCaptureIssuedTicket(ticket: WindowsIoSignedTicket): FirstCaptureIssuedTicket {
	const payload = parseTicketBytes(decodeWindowsIoBase64url(ticket.payload, 16 * 1024));
	if (
		payload.action !== "capture_exact" ||
		payload.budgetClass !== "metadata" ||
		payload.expectedCurrentMetadataHash !== null ||
		payload.expectedCurrentContentHash !== null ||
		payload.captureProofId ||
		payload.preparedObjectId ||
		payload.recoveryOriginal
	)
		throw new Error("First capture cannot borrow restore/prepared/recovery ticket");
	return Object.freeze({
		ticket: Object.freeze({ ...ticket }),
		payload: Object.freeze(payload),
		payloadDigest: windowsIoTicketPayloadDigest(ticket),
	});
}
export function verifyFirstCaptureCompletion(
	value: unknown,
	expected: {
		origin: WindowsFirstCaptureOrigin;
		preauthorization: VerifiedFirstCapturePreauthorization;
		captureNonce: string;
		ticket: FirstCaptureIssuedTicket;
		enrollment: WindowsFirstCaptureEnrollment;
		/** Actual PendingRpc getter at RECEIPT validation, before completion/cleanup. */
		isPending(): boolean;
	},
): WindowsMetadataCaptureResultPayload {
	if (expected.isPending() !== true)
		throw new Error("Original capture pending is gone; late result is Unknown");
	const response = windowsMetadataCaptureResultSchema.parse(value);
	const signed = verifyFirstCaptureEnvelope(
		response.attestation,
		expected.enrollment.helperPublicKey,
		windowsMetadataCaptureResultPayloadSchema,
	);
	const result = signed.payload;
	const preauth = expected.preauthorization;
	const ticket = expected.ticket.payload;
	const actor = {
		actorSubjectKey: ticket.actorSubjectKey,
		narratorId: ticket.narratorId,
		projectId: ticket.projectId,
		originRefHash: ticket.originRefHash,
		issuer: ticket.issuer,
		serviceId: ticket.serviceId,
		keyEpoch: ticket.keyEpoch,
	};
	if (
		!equal(result.origin, expected.origin) ||
		result.captureNonce !== expected.captureNonce ||
		result.challengeNonce !== ticket.challengeNonce ||
		result.ticketPayloadDigest !== expected.ticket.payloadDigest ||
		!equal(result.ticketActor, actor) ||
		result.helperInstanceId !== expected.enrollment.helperInstanceId ||
		result.helperKeyEpoch !== expected.enrollment.helperKeyEpoch ||
		!equal(result.preauthorization, {
			outerRpcId: preauth.payload.origin.outerRpcId,
			nonce: preauth.payload.preauthNonce,
			tokenDigest: preauth.payload.tokenDigest,
			attestationDigest: preauth.payloadDigest,
		}) ||
		!equal(result.descriptor.root, preauth.payload.descriptors.root) ||
		!equal(result.descriptor.parent, preauth.payload.descriptors.parent) ||
		!equal(result.descriptor.target, preauth.payload.descriptors.target) ||
		!equal(result.origin.root, result.descriptor.root) ||
		ticket.helperInstanceId !== result.helperInstanceId ||
		ticket.deviceId !== result.origin.deviceId ||
		ticket.executorSourceId !== result.origin.executorSourceId ||
		ticket.scopeId !== result.origin.scopeId ||
		ticket.operationId !== result.origin.operationId ||
		ticket.requestDigest !== result.origin.requestDigest ||
		ticket.leaseId !== result.origin.leaseId ||
		ticket.fence !== result.origin.fence ||
		ticket.connectionId !== result.origin.connectionId ||
		ticket.sessionId !== result.origin.sessionId ||
		ticket.runtimeGeneration !== result.origin.runtimeGeneration ||
		!equal(ticket.root, result.descriptor.root) ||
		!equal(ticket.parent, result.descriptor.parent) ||
		!equal(ticket.target, result.descriptor.target)
	)
		throw new Error(
			"Captured completion does not prove this original issued ticket/pending/preauth/native descriptor",
		);
	verifyWindowsIoCaptureProof(result.descriptor.proof, {
		helperInstanceId: expected.enrollment.helperInstanceId,
		keyEpoch: expected.enrollment.helperKeyEpoch,
		publicKey: expected.enrollment.helperPublicKey,
	});
	if (expected.isPending() !== true)
		throw new Error("Original capture pending changed; completion is Unknown");
	return Object.freeze(result);
}
export function verifyFirstCaptureEnrollmentInspection(
	value: unknown,
	expected: {
		brokerPublicKey: string;
		brokerServiceId: string;
		configDigest: string;
		challenge: string;
		now: number;
	},
) {
	const verified = verifyFirstCaptureEnvelope(
		value,
		expected.brokerPublicKey,
		windowsFirstCaptureEnrollmentInspectionPayloadSchema,
	);
	const payload = verified.payload;
	if (
		payload.challenge !== expected.challenge ||
		payload.brokerServiceId !== expected.brokerServiceId ||
		payload.configDigest !== expected.configDigest ||
		payload.issuedAt > expected.now ||
		expected.now - payload.issuedAt > 10_000 ||
		payload.enrollmentFileDigest !==
			firstCaptureHash(canonicalWindowsFirstCaptureBytes(payload.enrollment))
	)
		throw new Error(
			"First-capture enrollment inspection is stale or does not match administrator bytes",
		);
	Object.freeze(payload.enrollment.root);
	Object.freeze(payload.enrollment.pipePeer);
	Object.freeze(payload.enrollment.session);
	Object.freeze(payload.enrollment);
	return Object.freeze(payload);
}
