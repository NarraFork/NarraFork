import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
	canonicalWindowsIoJson,
	validateWindowsIoTicketPayload,
	type WindowsIoTicketPayload,
	windowsIoCaptureProofSchema,
	windowsIoTicketSignedBytes,
} from "@shared/windows-io-authority";
import golden from "@shared/windows-io-authority.golden.json";
import type { WindowsIoAuthoritySigner } from "../lib/windows-io-authority-broker-client";
import {
	decodeWindowsIoBase64url,
	encodeWindowsIoSignedTicket,
	verifyWindowsIoCaptureProof,
	verifyWindowsIoSignedTicket,
} from "../lib/windows-io-authority-crypto";
import {
	createWindowsIoAuthority,
	createWindowsIoAuthorityForUnitTests,
	type WindowsIoAuthorizationRequest,
	type WindowsIoTrustedActor,
} from "./windows-io-authority";

const payload = JSON.parse(golden.canonicalPayload) as WindowsIoTicketPayload;
const pin = {
	issuer: payload.issuer,
	serviceId: payload.serviceId,
	keyEpoch: 1,
	publicKey: golden.publicKey,
};
const goldenTicket = {
	payload: Buffer.from(golden.canonicalPayload).toString("base64url"),
	signature: golden.signature,
};
const signal = () => new AbortController().signal;
function fixture() {
	const keys = generateKeyPairSync("ed25519");
	const testPin = {
		...pin,
		publicKey: keys.publicKey
			.export({ type: "spki", format: "der" })
			.subarray(-32)
			.toString("base64url"),
	};
	const signer: WindowsIoAuthoritySigner = {
		kind: "unit_test_only_not_native",
		pin: testPin,
		async readiness() {
			return { ready: true, reason: "unit_test_only_not_native" };
		},
		async signAuthorizedPayload(value) {
			return sign(null, windowsIoTicketSignedBytes(value), keys.privateKey);
		},
	};
	const {
		version: _v,
		issuer: _i,
		serviceId: _s,
		keyEpoch: _k,
		actorSubjectKey: _a,
		narratorId: _n,
		projectId: _p,
		originRefHash: _o,
		issuedAt: _t,
		expiresAt: _e,
		nonce: _nonce,
		...request
	} = payload;
	let revision = "live-1";
	const deps = {
		signer,
		now: () => payload.issuedAt,
		async readCurrentActorOrigin() {
			return {
				source: "http" as const,
				userId: "test-user",
				actorSubjectKey: payload.actorSubjectKey,
				narratorId: payload.narratorId,
				projectId: payload.projectId,
				originRefHash: payload.originRefHash,
				credentialRef: {},
			};
		},
		async revalidateActor() {
			return revision;
		},
		async authorizeOperation(_origin: unknown, requested: WindowsIoAuthorizationRequest) {
			if (canonicalWindowsIoJson(requested) !== canonicalWindowsIoJson(request))
				throw new Error("Server original binding rejected");
			return structuredClone(request);
		},
	};
	return {
		request,
		deps,
		signer,
		testPin,
		keys,
		revoke() {
			revision = "revoked";
		},
	};
}

describe("Windows IO exact signed contract (NOT native acceptance)", () => {
	test("Go/TS golden verifies exact Unicode wire bytes and opaque helper proof", () => {
		expect(Buffer.from(windowsIoTicketSignedBytes(payload)).toString()).toBe(
			golden.canonicalPayload,
		);
		expect(verifyWindowsIoSignedTicket(goldenTicket, [pin], payload.issuedAt)).toEqual(payload);
		expect(
			verifyWindowsIoCaptureProof(golden.proof, {
				helperInstanceId: "helper-test",
				keyEpoch: 1,
				publicKey: golden.publicKey,
			}),
		).toEqual(windowsIoCaptureProofSchema.parse(golden.proof));
	});
	test("tampered payload/signature and unknown issuer are rejected", () => {
		const altered = {
			...goldenTicket,
			payload: Buffer.from(golden.canonicalPayload.replace("scope-test", "scope-evil")).toString(
				"base64url",
			),
		};
		expect(() => verifyWindowsIoSignedTicket(altered, [pin], payload.issuedAt)).toThrow();
		expect(() =>
			verifyWindowsIoSignedTicket(
				{ ...goldenTicket, signature: "A".repeat(86) },
				[pin],
				payload.issuedAt,
			),
		).toThrow();
		expect(() => verifyWindowsIoSignedTicket(goldenTicket, [], payload.issuedAt)).toThrow();
		expect(() =>
			verifyWindowsIoSignedTicket(goldenTicket, [{ ...pin, issuer: "unknown" }], payload.issuedAt),
		).toThrow();
	});
	test.each([
		{ actorSubjectKey: "human:other" },
		{ helperInstanceId: "other-helper" },
		{ runtimeGeneration: 8 },
		{ connectionId: "other-connection" },
		{ sessionId: "other-session" },
		{ fence: 41 },
		{ nonce: "Z".repeat(32) },
		{ challengeNonce: "Z".repeat(32) },
		{ deviceId: "other-device" },
		{ executorSourceId: "other-executor" },
		{ scopeId: "other-scope" },
		{ root: { ...payload.root, fileId: "other-root" } },
		{ parent: { ...payload.parent, fileId: "other-parent" } },
		{ target: { ...payload.target, fileId: "other-target" } },
		{ operationId: "other-operation" },
		{ requestDigest: "f".repeat(64) },
		{ leaseId: "other-lease" },
		{ originRefHash: "f".repeat(64) },
	])("all original context fields bind exact expectations: %j", (expected) => {
		expect(() =>
			verifyWindowsIoSignedTicket(goldenTicket, [pin], payload.issuedAt, expected),
		).toThrow();
	});
	test("future, expired, oversized and base64 junk rejected", () => {
		expect(() => verifyWindowsIoSignedTicket(goldenTicket, [pin], payload.issuedAt - 1)).toThrow();
		expect(() => verifyWindowsIoSignedTicket(goldenTicket, [pin], payload.expiresAt)).toThrow();
		for (const junk of ["AA=", "AA+", "A A", "A", "AB", "A".repeat(24000)]) {
			expect(() => decodeWindowsIoBase64url(junk, 16384)).toThrow();
		}
	});
	test("even valid signatures cannot carry duplicate fields, unknown fields or client SD", () => {
		const f = fixture();
		for (const raw of [
			golden.canonicalPayload.replace("{", '{"version":1,'),
			golden.canonicalPayload.replace("{", '{"securityDescriptor":"forged",'),
			golden.canonicalPayload.replace("{", '{"sourcePid":100,'),
			golden.canonicalPayload.replace("{", '{"unknown":true,'),
			golden.canonicalPayload.replace("{", '{"root":{},'),
		]) {
			const bytes = Buffer.from(raw);
			const ticket = encodeWindowsIoSignedTicket(bytes, sign(null, bytes, f.keys.privateKey));
			expect(() => verifyWindowsIoSignedTicket(ticket, [f.testPin], payload.issuedAt)).toThrow();
		}
		expect(() =>
			windowsIoCaptureProofSchema.parse({ ...golden.proof, sd: "client-owned" }),
		).toThrow();
	});
	test("forged/tampered/helper-key epoch/record nonce and correct digest wrong record proof fail", () => {
		const helperPin = { helperInstanceId: "helper-test", keyEpoch: 1, publicKey: golden.publicKey };
		for (const patch of [
			{ recordId: "other-record" },
			{ recordNonce: "Z".repeat(32) },
			{ recordDigest: "f".repeat(64) },
			{ helperInstanceId: "other-helper" },
			{ keyEpoch: 2 },
			{ signature: "A".repeat(86) },
		])
			expect(() => verifyWindowsIoCaptureProof({ ...golden.proof, ...patch }, helperPin)).toThrow();
	});
	test("fixed version, TTL maxima and action-specific proof domains cannot be bypassed", () => {
		for (const [budgetClass, ttl] of [
			["metadata", 30000],
			["operation", 120000],
			["attachment", 300000],
		] as const) {
			expect(
				validateWindowsIoTicketPayload({
					...payload,
					budgetClass,
					expiresAt: payload.issuedAt + ttl,
				}),
			).toBeDefined();
			expect(() =>
				validateWindowsIoTicketPayload({
					...payload,
					budgetClass,
					expiresAt: payload.issuedAt + ttl + 1,
				}),
			).toThrow();
		}
		for (const patch of [
			{ version: 2 },
			{ action: "SetAcl" },
			{ action: "restore_original" },
			{ action: "cleanup_created", captureProofId: "record-test", preparedObjectId: "created" },
			{ captureProofId: "record-test" },
			{ preparedObjectId: "created" },
			{
				recoveryOriginal: {
					operationId: "old",
					requestDigest: "b".repeat(64),
					leaseId: "old",
					fence: 40,
				},
			},
		])
			expect(() => validateWindowsIoTicketPayload({ ...payload, ...patch })).toThrow();
		expect(() =>
			validateWindowsIoTicketPayload({
				...payload,
				target: { ...payload.target, pathKey: "\u0000" },
			}),
		).toThrow();
	});
});

describe("Windows IO trusted actor and live authority", () => {
	test("production never accepts test signer or creates a default private key", async () => {
		const f = fixture();
		const production = createWindowsIoAuthority(f.deps);
		expect((await production.readiness(signal())).ready).toBe(false);
		const absent = createWindowsIoAuthority({ ...f.deps, signer: null });
		expect((await absent.readiness(signal())).ready).toBe(false);
		const actor = await production.captureTrustedActor(signal());
		await expect(production.issueTicket(actor, f.request, signal())).rejects.toThrow(
			"KEY_CUSTODY_NOT_CONFIGURED",
		);
	});
	test("JSON actors and actors minted by another authority are rejected", async () => {
		const f = fixture();
		const a = createWindowsIoAuthorityForUnitTests(f.deps);
		const b = createWindowsIoAuthorityForUnitTests(f.deps);
		await expect(
			a.issueTicket(
				{ actorSubjectKey: payload.actorSubjectKey } as unknown as WindowsIoTrustedActor,
				f.request,
				signal(),
			),
		).rejects.toThrow("authentic service actor");
		await expect(
			a.issueTicket(await b.captureTrustedActor(signal()), f.request, signal()),
		).rejects.toThrow("authentic service actor");
	});
	test("single authorized request signs real Ed25519 and revalidates original authority", async () => {
		const f = fixture();
		let calls = 0;
		const authority = createWindowsIoAuthorityForUnitTests({
			...f.deps,
			async revalidateActor() {
				calls++;
				return "live";
			},
		});
		const actor = await authority.captureTrustedActor(signal());
		const ticket = await authority.issueTicket(actor, f.request, signal());
		const verified = verifyWindowsIoSignedTicket(ticket, [f.testPin], payload.issuedAt);
		expect(verified.actorSubjectKey).toBe(payload.actorSubjectKey);
		expect(calls).toBe(3);
		expect(verified.nonce).not.toBe(payload.nonce);
	});
	test("a cached boolean approval is not a fresh policy revision proof", async () => {
		const f = fixture();
		const authority = createWindowsIoAuthorityForUnitTests({
			...f.deps,
			revalidateActor: (async () => true) as unknown as typeof f.deps.revalidateActor,
		});
		await expect(authority.captureTrustedActor(signal())).rejects.toThrow("revision unavailable");
	});
	test("client naked source/scope/root and generated actor fields are never authorized", async () => {
		const f = fixture();
		const authority = createWindowsIoAuthorityForUnitTests(f.deps);
		const actor = await authority.captureTrustedActor(signal());
		await expect(
			authority.issueTicket(actor, { ...f.request, scopeId: "client-scope" }, signal()),
		).rejects.toThrow("original binding rejected");
		await expect(
			authority.issueTicket(
				actor,
				{ ...f.request, actorSubjectKey: "human:admin" } as WindowsIoAuthorizationRequest,
				signal(),
			),
		).rejects.toThrow();
	});
	test("revocation while awaiting asynchronous broker reply refuses to return ticket", async () => {
		const f = fixture();
		const signer: WindowsIoAuthoritySigner = {
			...f.signer,
			async signAuthorizedPayload(value) {
				await Promise.resolve();
				f.revoke();
				return f.signer.signAuthorizedPayload(value, signal());
			},
		};
		const authority = createWindowsIoAuthorityForUnitTests({ ...f.deps, signer });
		const actor = await authority.captureTrustedActor(signal());
		await expect(authority.issueTicket(actor, f.request, signal())).rejects.toThrow(
			"authority changed",
		);
	});
	test("operation/lease/session changes while queued and cancellation fail closed", async () => {
		const f = fixture();
		let calls = 0;
		const authority = createWindowsIoAuthorityForUnitTests({
			...f.deps,
			async authorizeOperation() {
				calls++;
				return calls === 1 ? f.request : { ...f.request, fence: 43 };
			},
		});
		const actor = await authority.captureTrustedActor(signal());
		await expect(authority.issueTicket(actor, f.request, signal())).rejects.toThrow(
			"authority changed",
		);
		const controller = new AbortController();
		controller.abort();
		await expect(authority.issueTicket(actor, f.request, controller.signal)).rejects.toThrow();
	});
});
