import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
	canonicalWindowsFirstCaptureBytes,
	parseWindowsFirstCaptureBytes,
	validateWindowsFirstCaptureRpc,
	type WindowsFirstCaptureEnrollment,
	type WindowsMetadataCaptureResultPayload,
	type WindowsMetadataPreauthorizationPayload,
	windowsMetadataCaptureResultPayloadSchema,
} from "@shared/windows-first-capture";
import golden from "@shared/windows-first-capture.golden.json";
import { canonicalWindowsIoJson, type WindowsIoSignedTicket } from "@shared/windows-io-authority";
import old from "@shared/windows-io-authority.golden.json";
import {
	verifyWindowsIoSignedTicket,
	windowsIoCaptureProofSignedBytes,
} from "./windows-io-authority-crypto";
import {
	firstCaptureHash,
	firstCaptureIssuedTicket,
	verifyFirstCaptureCompletion,
	verifyFirstCaptureEnrollmentInspection,
	verifyFirstCaptureEnvelope,
	verifyFirstCapturePreauthorization,
} from "./windows-io-authority-first-capture-proof";

const pre = JSON.parse(golden.preauth.canonicalPayload) as WindowsMetadataPreauthorizationPayload;
const completed = JSON.parse(
	golden.capture.canonicalPayload,
) as WindowsMetadataCaptureResultPayload;
const enrolled = JSON.parse(golden.enrollmentInspection.canonicalPayload)
	.enrollment as WindowsFirstCaptureEnrollment;
const signed = (vector: { canonicalPayload: string; signature: string }) => ({
	version: 1,
	payload: Buffer.from(vector.canonicalPayload).toString("base64url"),
	signature: vector.signature,
});
const oldTicket: WindowsIoSignedTicket = {
	payload: Buffer.from(old.canonicalPayload).toString("base64url"),
	signature: old.signature,
};
const expectation = () => {
	verifyWindowsIoSignedTicket(golden.issuedTicket, [golden.issuerPin], pre.issuedAt, {
		action: "capture_exact",
		budgetClass: "metadata",
		expectedCurrentMetadataHash: null,
		expectedCurrentContentHash: null,
		captureProofId: null,
		preparedObjectId: null,
		recoveryOriginal: null,
	});
	const preauthorization = verifyFirstCapturePreauthorization(
		{ version: 1, token: golden.token, attestation: signed(golden.preauth) },
		{ origin: pre.origin, nonce: pre.preauthNonce, enrollment: enrolled, now: pre.issuedAt },
	);
	return {
		origin: completed.origin,
		preauthorization,
		captureNonce: completed.captureNonce,
		ticket: firstCaptureIssuedTicket(golden.issuedTicket),
		enrollment: enrolled,
		isPending: () => true,
	};
};
// New keys below are crypto/unit fixtures only, NOT production enrollment/custody evidence.
function fixture() {
	const keys = generateKeyPairSync("ed25519");
	const enrollment = {
		...enrolled,
		helperPublicKey: keys.publicKey
			.export({ type: "spki", format: "der" })
			.subarray(-32)
			.toString("base64url"),
	};
	const envelope = (value: unknown) => ({
		version: 1,
		payload: Buffer.from(canonicalWindowsFirstCaptureBytes(value)).toString("base64url"),
		signature: sign(null, canonicalWindowsFirstCaptureBytes(value), keys.privateKey).toString(
			"base64url",
		),
	});
	const preauthorization = verifyFirstCapturePreauthorization(
		{ version: 1, token: golden.token, attestation: envelope(pre) },
		{ origin: pre.origin, nonce: pre.preauthNonce, enrollment, now: pre.issuedAt },
	);
	const result = structuredClone(completed);
	result.descriptor.proof.signature = sign(
		null,
		windowsIoCaptureProofSignedBytes(result.descriptor.proof),
		keys.privateKey,
	).toString("base64url");
	return {
		enrollment,
		result,
		envelope,
		keys,
		expected: { ...expectation(), preauthorization, enrollment },
	};
}

test("all three canonical golden domains verify and completion binds actual issued-ticket bytes", () => {
	expect(
		verifyFirstCaptureCompletion(
			{ version: 1, attestation: signed(golden.capture) },
			expectation(),
		),
	).toEqual(completed);
	const inspection = JSON.parse(golden.enrollmentInspection.canonicalPayload);
	expect(
		verifyFirstCaptureEnrollmentInspection(signed(golden.enrollmentInspection), {
			brokerPublicKey: golden.publicKey,
			brokerServiceId: inspection.brokerServiceId,
			configDigest: inspection.configDigest,
			challenge: inspection.challenge,
			now: inspection.issuedAt,
		}).enrollment,
	).toEqual(enrolled);
	expect(firstCaptureHash(Buffer.from(golden.preauth.canonicalPayload))).toBe(
		completed.preauthorization.attestationDigest,
	);
	expect(firstCaptureIssuedTicket(golden.issuedTicket).payloadDigest).toBe(
		completed.ticketPayloadDigest,
	);
	expect(golden.preauth.canonicalPayload).toBe(canonicalWindowsIoJson(pre));
});

test("unchanged valid v1 current-hash-bearing ticket cannot pass new strict first-capture gate", () => {
	const oldPayload = verifyWindowsIoSignedTicket(
		oldTicket,
		[{ ...golden.issuerPin, publicKey: old.publicKey }],
		pre.issuedAt,
	);
	expect(oldPayload.expectedCurrentMetadataHash).not.toBeNull();
	expect(oldPayload.expectedCurrentContentHash).not.toBeNull();
	expect(() => firstCaptureIssuedTicket(oldTicket)).toThrow("cannot borrow");
	const payload = verifyWindowsIoSignedTicket(
		golden.issuedTicket,
		[golden.issuerPin],
		pre.issuedAt,
	);
	expect(payload.expectedCurrentMetadataHash).toBeNull();
	expect(payload.expectedCurrentContentHash).toBeNull();
});

test("preauth/challenge/old proof never substitute for captured durable completion", () => {
	for (const attestation of [signed(golden.preauth), signed(golden.enrollmentInspection)])
		expect(() =>
			verifyFirstCaptureCompletion({ version: 1, attestation }, expectation()),
		).toThrow();
	const f = fixture();
	for (const state of ["intent", "dispatched", "unknown", "rejected"]) {
		const result = { ...f.result, completion: { ...f.result.completion, state } };
		expect(() =>
			verifyFirstCaptureCompletion({ version: 1, attestation: f.envelope(result) }, f.expected),
		).toThrow();
	}
});

test("valid helper signature still cannot alter original actor/digest/root/preauth/current ticket", () => {
	const f = fixture();
	const base = f.result;
	const patches: Partial<WindowsMetadataCaptureResultPayload>[] = [
		{ ticketPayloadDigest: "0".repeat(64) },
		{ captureNonce: "C".repeat(32) },
		{ challengeNonce: "C".repeat(32) },
		{ helperInstanceId: "foreign" },
		{ helperKeyEpoch: 2 },
		{ origin: { ...base.origin, operationId: "foreign" } },
		{ origin: { ...base.origin, leaseId: "foreign" } },
		{ origin: { ...base.origin, fence: 41 } },
		{ origin: { ...base.origin, sessionId: "foreign" } },
		{ origin: { ...base.origin, outerRpcId: "new_capture_pending" } },
		{ ticketActor: { ...base.ticketActor, actorSubjectKey: "human:foreign" } },
		{ ticketActor: { ...base.ticketActor, originRefHash: "0".repeat(64) } },
		{ preauthorization: { ...base.preauthorization, tokenDigest: "0".repeat(64) } },
		{ preauthorization: { ...base.preauthorization, attestationDigest: "0".repeat(64) } },
		{ descriptor: { ...base.descriptor, root: { ...base.descriptor.root, fileId: "other" } } },
		{ descriptor: { ...base.descriptor, target: { ...base.descriptor.target, fileId: "other" } } },
	];
	for (const patch of patches)
		expect(() =>
			verifyFirstCaptureCompletion(
				{ version: 1, attestation: f.envelope({ ...base, ...patch }) },
				f.expected,
			),
		).toThrow();
});

test("valid completion signature cannot import another valid old CaptureProof or opaque record", () => {
	const f = fixture();
	for (const proof of [
		completed.descriptor.proof,
		{ ...f.result.descriptor.proof, recordId: "different-record" },
		{ ...f.result.descriptor.proof, recordNonce: "Z".repeat(32) },
	]) {
		const descriptor = { ...f.result.descriptor, proof };
		expect(() =>
			verifyFirstCaptureCompletion(
				{ version: 1, attestation: f.envelope({ ...f.result, descriptor }) },
				f.expected,
			),
		).toThrow();
	}
});

test("preauth refuses missing ordinary access, expiry, token replacement and inconsistent descriptors", () => {
	const f = fixture();
	for (const payload of [
		{ ...pre, expiresAt: pre.issuedAt + 30001 },
		{ ...pre, ordinaryHandle: { ...pre.ordinaryHandle, grantedAccess: 1 } },
		{ ...pre, ordinaryHandle: { ...pre.ordinaryHandle, grantedAccess: 0x120089 } },
		{ ...pre, preauthNonce: "B".repeat(32) },
		{ ...pre, origin: { ...pre.origin, outerRpcId: "replacement_pending" } },
		{ ...pre, helperKeyEpoch: 2 },
		{
			...pre,
			descriptors: { ...pre.descriptors, root: { ...pre.descriptors.root, fileId: "other" } },
		},
	])
		expect(() =>
			verifyFirstCapturePreauthorization(
				{ version: 1, token: golden.token, attestation: f.envelope(payload) },
				{
					origin: pre.origin,
					nonce: pre.preauthNonce,
					enrollment: f.enrollment,
					now: pre.issuedAt,
				},
			),
		).toThrow();
	expect(() =>
		verifyFirstCapturePreauthorization(
			{ version: 1, token: "A".repeat(32), attestation: signed(golden.preauth) },
			{ origin: pre.origin, nonce: pre.preauthNonce, enrollment: enrolled, now: pre.issuedAt },
		),
	).toThrow();
	expect(() =>
		verifyFirstCapturePreauthorization(
			{ version: 1, token: golden.token, attestation: signed(golden.preauth) },
			{ origin: pre.origin, nonce: pre.preauthNonce, enrollment: enrolled, now: pre.expiresAt },
		),
	).toThrow();
});

test("late receipt after original pending disappears cannot attach to another pending", () => {
	expect(() =>
		verifyFirstCaptureCompletion(
			{ version: 1, attestation: signed(golden.capture) },
			{ ...expectation(), isPending: () => false },
		),
	).toThrow("pending is gone");
	expect(() =>
		verifyFirstCaptureCompletion(
			{ version: 1, attestation: signed(golden.capture) },
			{ ...expectation(), origin: { ...completed.origin, outerRpcId: "replacement" } },
		),
	).toThrow();
});

test("duplicate/unknown/SD/invalid UTF8/base64 and over-budget signed payloads are rejected", () => {
	const f = fixture();
	for (const raw of [
		golden.capture.canonicalPayload.replace("{", '{"version":1,'),
		golden.capture.canonicalPayload.replace("{", '{"securityDescriptor":"forged",'),
	]) {
		const bytes = Buffer.from(raw);
		const value = {
			version: 1,
			payload: bytes.toString("base64url"),
			signature: sign(null, bytes, f.keys.privateKey).toString("base64url"),
		};
		expect(() =>
			verifyFirstCaptureEnvelope(
				value,
				f.enrollment.helperPublicKey,
				windowsMetadataCaptureResultPayloadSchema,
			),
		).toThrow();
	}
	expect(() =>
		parseWindowsFirstCaptureBytes(new Uint8Array([255]), windowsMetadataCaptureResultPayloadSchema),
	).toThrow();
	expect(() =>
		verifyFirstCaptureEnvelope(
			{ ...signed(golden.capture), payload: "A=" },
			golden.publicKey,
			windowsMetadataCaptureResultPayloadSchema,
		),
	).toThrow();
	expect(() =>
		parseWindowsFirstCaptureBytes(Buffer.alloc(65537), windowsMetadataCaptureResultPayloadSchema),
	).toThrow();
	expect(() =>
		parseWindowsFirstCaptureBytes(
			Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from(golden.capture.canonicalPayload),
			]),
			windowsMetadataCaptureResultPayloadSchema,
		),
	).toThrow();
});

test("only two negotiated method/phase combinations accept origin; no result/status method", () => {
	expect(() =>
		validateWindowsFirstCaptureRpc("history.metadataPreauthorize", "different", pre.origin, {
			version: 1,
			path: "C:\\工作区\\original.txt",
			nonce: pre.preauthNonce,
		}),
	).toThrow();
	expect(() =>
		validateWindowsFirstCaptureRpc("history.metadataCapture", pre.origin.outerRpcId, pre.origin, {
			version: 1,
			token: golden.token,
			preauthRpcId: pre.origin.outerRpcId,
			preauthNonce: pre.preauthNonce,
			captureNonce: completed.captureNonce,
		}),
	).toThrow();
	expect(() =>
		parseWindowsFirstCaptureBytes(
			Buffer.from(golden.capture.canonicalPayload.replace('"captured"', '"intent"')),
			windowsMetadataCaptureResultPayloadSchema,
		),
	).toThrow();
});
