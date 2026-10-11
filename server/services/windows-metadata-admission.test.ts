import { expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import {
	canonicalWindowsIoJson,
	type WindowsIoTicketPayload,
	windowsIoTicketSignedBytes,
} from "@shared/windows-io-authority";
import golden from "@shared/windows-io-authority.golden.json";
import {
	encodeWindowsMetadataCallback,
	parseWindowsMetadataCallback,
	type WindowsMetadataCallback,
	windowsMetadataHelperChallengeSignedBytes,
} from "@shared/windows-metadata-callback";
import type { WindowsIoAuthoritySigner } from "../lib/windows-io-authority-broker-client";
import { verifyWindowsIoSignedTicket } from "../lib/windows-io-authority-crypto";
import {
	createWindowsIoAuthorityForUnitTests,
	type WindowsIoTrustedActor,
} from "./windows-io-authority";
import {
	createWindowsMetadataCallbackController,
	currentMetadataAdmission,
	registerAdmission,
	sendRPCOptions,
	type WindowsMetadataAdmission,
	type WindowsMetadataAdmissionInput,
	type WindowsMetadataOriginalOperation,
	type WindowsMetadataPendingRpc,
	type WindowsMetadataPhase,
	type WindowsMetadataScopeProof,
	withAdmission,
	withdrawAdmission,
} from "./windows-metadata-admission";

const signal = () => new AbortController().signal;
const nonce = () => randomBytes(24).toString("base64url");
function deferred<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error("Deferred not initialized");
	};
	let reject: (reason: unknown) => void = () => {
		throw new Error("Deferred not initialized");
	};
	const promise = new Promise<T>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}
/** Real service/actor WeakMaps and Ed25519, but deliberately NON-NATIVE unit keys. */
async function fixture(phase: WindowsMetadataPhase = "capture_predispatch") {
	const template = JSON.parse(golden.canonicalPayload) as WindowsIoTicketPayload;
	const {
		version: _version,
		issuer: _issuer,
		serviceId: _service,
		keyEpoch: _epoch,
		actorSubjectKey: _actor,
		narratorId: _narrator,
		projectId: _project,
		originRefHash: _origin,
		issuedAt: _issued,
		expiresAt: _expires,
		nonce: _nonce,
		action: _action,
		challengeNonce: _challenge,
		...base
	} = template;
	const original: WindowsMetadataOriginalOperation = {
		...base,
		connectionId: `conn-${randomUUID()}`,
		sessionId: `session-${randomUUID()}`,
		helperInstanceId: `helper-${randomUUID()}`,
		captureProofId: ["apply", "seal", "recovery"].includes(phase) ? "original-proof" : null,
		preparedObjectId: ["prepare", "apply", "cleanup"].includes(phase) ? "prepared-object" : null,
		recoveryOriginal:
			phase === "recovery"
				? {
						operationId: "old-operation",
						requestDigest: "f".repeat(64),
						leaseId: "old-lease",
						fence: 41,
					}
				: null,
	};
	const serverOriginal = structuredClone(original);
	const controlKeys = generateKeyPairSync("ed25519");
	const helperKeys = generateKeyPairSync("ed25519");
	const pin = {
		issuer: template.issuer,
		serviceId: template.serviceId,
		keyEpoch: 1,
		publicKey: controlKeys.publicKey
			.export({ type: "spki", format: "der" })
			.subarray(-32)
			.toString("base64url"),
	};
	const credentialRef = {};
	const controls = {
		revision: "fresh-policy-1",
		pending: true,
		live: {
			deviceId: original.deviceId,
			connectionId: original.connectionId,
			sessionId: original.sessionId,
			runtimeGeneration: original.runtimeGeneration,
		},
		signed: 0,
		freshCalls: 0,
		signGate: async () => {},
		ready: true,
	};
	const signer: WindowsIoAuthoritySigner = {
		kind: "unit_test_only_not_native",
		pin,
		async readiness() {
			return { ready: controls.ready, reason: "unit_test_only_not_native" };
		},
		async signAuthorizedPayload(payload) {
			controls.signed++;
			await controls.signGate();
			return sign(null, windowsIoTicketSignedBytes(payload), controlKeys.privateKey);
		},
	};
	const authority = createWindowsIoAuthorityForUnitTests({
		signer,
		async readCurrentActorOrigin() {
			return {
				source: "agent",
				userId: "test-user",
				actorSubjectKey: template.actorSubjectKey,
				narratorId: template.narratorId,
				projectId: template.projectId,
				originRefHash: template.originRefHash,
				credentialRef,
			};
		},
		async revalidateActor() {
			if (controls.revision === "revoked") throw new Error("Actor revoked");
			return controls.revision;
		},
		async authorizeOperation(_origin, request) {
			if (
				request.deviceId !== serverOriginal.deviceId ||
				request.operationId !== serverOriginal.operationId ||
				request.requestDigest !== serverOriginal.requestDigest ||
				request.leaseId !== serverOriginal.leaseId ||
				request.fence !== serverOriginal.fence ||
				request.scopeId !== serverOriginal.scopeId ||
				!Object.is(request.runtimeGeneration, serverOriginal.runtimeGeneration)
			)
				throw new Error("Original server tuple rejected");
			return structuredClone(request);
		},
	});
	const actor = await authority.captureTrustedActor(signal());
	const scopeProof: WindowsMetadataScopeProof = {
		version: 2,
		matrix: "ordinary-file-v2",
		deviceId: original.deviceId,
		executorSourceId: original.executorSourceId,
		scopeId: original.scopeId,
		root: structuredClone(original.root),
		helperInstanceId: original.helperInstanceId,
		helperKeyEpoch: 1,
		helperPublicKey: helperKeys.publicKey
			.export({ type: "spki", format: "der" })
			.subarray(-32)
			.toString("base64url"),
	};
	const serverScope = structuredClone(scopeProof);
	const input: WindowsMetadataAdmissionInput = {
		authority,
		actor,
		credentialRef,
		scopeProof,
		original,
		phase,
		signal: signal(),
		async freshAuthorize(context) {
			controls.freshCalls++;
			if (
				context.credentialRef !== credentialRef ||
				!same(context.original, serverOriginal) ||
				!same(context.scopeProof, serverScope)
			)
				throw new Error("Original credential/root provenance rejected");
			if (controls.revision === "revoked") throw new Error("Original actor revoked");
			return controls.revision;
		},
	};
	const admission = await registerAdmission(input);
	const pending: WindowsMetadataPendingRpc = {
		...sendRPCOptions(admission),
		outerRpcId: `rpc-${randomUUID()}`,
		isPending: () => controls.pending,
		liveConnection: () => controls.live,
	};
	function callback(
		action: WindowsMetadataCallback["action"] = "capture_exact",
		patch: Partial<WindowsMetadataCallback> = {},
	): WindowsMetadataCallback {
		const capture = action === "capture_exact";
		const owned = action === "prepare_owned" || action === "cleanup_created";
		const value: WindowsMetadataCallback = {
			type: "windows_metadata_callback",
			version: 1,
			outerRpcId: pending.outerRpcId,
			stepId: randomUUID(),
			nonce: nonce(),
			action,
			helperChallenge: {
				helperInstanceId: serverOriginal.helperInstanceId,
				keyEpoch: 1,
				challengeNonce: nonce(),
				connectionId: serverOriginal.connectionId,
				sessionId: serverOriginal.sessionId,
				runtimeGeneration: serverOriginal.runtimeGeneration,
				signature: "A".repeat(86),
			},
			descriptors: {
				root: serverOriginal.root,
				parent: serverOriginal.parent,
				target: serverOriginal.target,
			},
			proofIds: {
				captureProofId: capture || owned ? null : serverOriginal.captureProofId,
				preparedObjectId: capture ? null : serverOriginal.preparedObjectId,
			},
			expectedCurrent: {
				metadataHash: serverOriginal.expectedCurrentMetadataHash,
				contentHash: serverOriginal.expectedCurrentContentHash,
			},
			...patch,
		};
		value.helperChallenge.signature = sign(
			null,
			windowsMetadataHelperChallengeSignedBytes(value, serverOriginal),
			helperKeys.privateKey,
		).toString("base64url");
		return value;
	}
	return {
		original,
		serverOriginal,
		scopeProof,
		input,
		actor,
		authority,
		admission,
		pending,
		controls,
		pin,
		callback,
		helperKeys,
	};
}
function same(left: unknown, right: unknown) {
	return canonicalWindowsIoJson(left) === canonicalWindowsIoJson(right);
}
function handle(
	f: Awaited<ReturnType<typeof fixture>>,
	callback: WindowsMetadataCallback,
	controller = createWindowsMetadataCallbackController(),
	aborted = signal(),
) {
	return controller.handle(encodeWindowsMetadataCallback(callback), f.pending, aborted);
}

test("first observation admission issues only capture without proving dispatch", async () => {
	const f = await fixture();
	const callback = f.callback();
	const reply = await handle(f, callback);
	const payload = verifyWindowsIoSignedTicket(reply.ticket, [f.pin], Date.now());
	expect(payload.action).toBe("capture_exact");
	expect(payload.operationId).toBe(f.original.operationId);
	expect(payload.requestDigest).toBe(f.original.requestDigest);
	expect(payload.leaseId).toBe(f.original.leaseId);
	expect(payload.fence).toBe(f.original.fence);
	expect(payload.challengeNonce).toBe(callback.helperChallenge.challengeNonce);
	expect(Object.keys(f.admission)).toHaveLength(0);
	expect("dispatched" in reply).toBe(false);
	expect(reply.nonce).toBe(callback.nonce);
});

test("ALS/sendRPCOptions preserve opaque original admission without putting it on wire", async () => {
	const f = await fixture();
	await withAdmission(f.admission, async () => {
		await Promise.resolve();
		expect(currentMetadataAdmission()).toBe(f.admission);
		expect(sendRPCOptions().windowsMetadataAdmission).toBe(f.admission);
	});
	expect(currentMetadataAdmission()).toBeUndefined();
	expect(() => sendRPCOptions()).toThrow("no original admission");
	expect(() => withAdmission({} as WindowsMetadataAdmission, () => {})).toThrow("Authentic");
});

test.each([
	"actor",
	"actorSubjectKey",
	"userId",
	"scopeId",
	"executorSourceId",
	"PID",
	"securityDescriptor",
	"sd",
])("wire %s cannot authorize anything", async (field) => {
	const f = await fixture();
	const raw = canonicalWindowsIoJson({ ...f.callback(), [field]: "forged" });
	await expect(
		createWindowsMetadataCallbackController().handle(raw, f.pending, signal()),
	).rejects.toThrow();
	expect(f.controls.signed).toBe(0);
});

test("duplicate JSON keys, base64 junk, unsupported version and bytes budgets fail closed", async () => {
	const f = await fixture();
	const body = f.callback();
	const valid = new TextDecoder().decode(encodeWindowsMetadataCallback(body));
	for (const raw of [
		valid.replace("{", '{"version":1,'),
		"X".repeat(16385),
		canonicalWindowsIoJson({ ...body, version: 2 }),
		canonicalWindowsIoJson({ ...body, nonce: "AA=" }),
		canonicalWindowsIoJson({ ...body, descriptors: { ...body.descriptors, sd: "forged" } }),
	])
		await expect(
			createWindowsMetadataCallbackController().handle(raw, f.pending, signal()),
		).rejects.toThrow();
	expect(() => parseWindowsMetadataCallback(new Uint8Array([0xff]))).toThrow();
	expect(f.controls.signed).toBe(0);
});

test("JSON admission, borrowed actor and wrong original credential cannot mint usable tickets", async () => {
	const f = await fixture();
	await expect(
		createWindowsMetadataCallbackController().handle(
			encodeWindowsMetadataCallback(f.callback()),
			{ ...f.pending, windowsMetadataAdmission: {} as WindowsMetadataAdmission },
			signal(),
		),
	).rejects.toThrow("Authentic");
	await expect(registerAdmission({ ...f.input, credentialRef: {} })).rejects.toThrow(
		"credential/root provenance",
	);
	const fake = await registerAdmission({ ...f.input, actor: {} as WindowsIoTrustedActor });
	await expect(
		createWindowsMetadataCallbackController().handle(
			encodeWindowsMetadataCallback(f.callback()),
			{ ...f.pending, windowsMetadataAdmission: fake },
			signal(),
		),
	).rejects.toThrow("authentic service actor");
	expect(f.controls.signed).toBe(0);
});

test("missing/legacy/wrong source/root/scope v2 proof cannot be repaired from current state", async () => {
	const f = await fixture();
	for (const scopeProof of [
		undefined,
		{ ...f.scopeProof, version: 1 },
		{ ...f.scopeProof, scopeId: "wrong" },
		{ ...f.scopeProof, executorSourceId: "wrong" },
		{ ...f.scopeProof, root: { ...f.scopeProof.root, fileId: "replacement" } },
	])
		await expect(
			registerAdmission({ ...f.input, scopeProof: scopeProof as WindowsMetadataScopeProof }),
		).rejects.toThrow();
	await expect(
		registerAdmission({ ...f.input, original: { ...f.original, operationId: "forged" } }),
	).rejects.toThrow("provenance rejected");
});

test.each([
	"restore_original",
	"prepare_owned",
	"seal_owned",
	"unseal_original",
	"cleanup_created",
	"status_original",
] as const)("predispatch capture cannot borrow %s authority", async (action) => {
	const f = await fixture();
	await expect(handle(f, f.callback(action))).rejects.toThrow("outside admitted stage");
	expect(f.controls.signed).toBe(0);
});

test.each([
	["prepare", "prepare_owned"],
	["apply", "restore_original"],
	["seal", "seal_owned"],
	["cleanup", "cleanup_created"],
	["recovery", "status_original"],
] as const)("explicit phase %s issues only its bound %s action", async (phase, action) => {
	const f = await fixture(phase);
	const reply = await handle(f, f.callback(action));
	const payload = verifyWindowsIoSignedTicket(reply.ticket, [f.pin], Date.now());
	expect(payload.action).toBe(action);
	expect(payload.scopeId).toBe(f.original.scopeId);
	expect(payload.recoveryOriginal).toEqual(f.original.recoveryOriginal);
});

test("stage cannot be selected or advanced by callback JSON", async () => {
	const f = await fixture("cleanup");
	await expect(handle(f, f.callback("restore_original"))).rejects.toThrow("outside admitted stage");
	await expect(
		registerAdmission({
			...f.input,
			original: { ...f.original, captureProofId: "original-proof" },
		}),
	).rejects.toThrow("Cleanup");
	await expect(registerAdmission({ ...f.input, phase: "recovery" })).rejects.toThrow("Recovery");
});

test("valid helper signatures still cannot substitute root/target/hash/proof/connection epochs", async () => {
	const f = await fixture("apply");
	const base = f.callback("restore_original");
	for (const patch of [
		{ descriptors: { ...base.descriptors, root: { ...base.descriptors.root, fileId: "foreign" } } },
		{
			descriptors: {
				...base.descriptors,
				parent: { ...base.descriptors.parent, fileId: "foreign" },
			},
		},
		{
			descriptors: {
				...base.descriptors,
				target: { ...base.descriptors.target, fileId: "foreign" },
			},
		},
		{ proofIds: { ...base.proofIds, captureProofId: "foreign-record" } },
		{ proofIds: { ...base.proofIds, preparedObjectId: "foreign-prepared" } },
		{ expectedCurrent: { ...base.expectedCurrent, metadataHash: "e".repeat(64) } },
		{ helperChallenge: { ...base.helperChallenge, helperInstanceId: "foreign-helper" } },
		{ helperChallenge: { ...base.helperChallenge, keyEpoch: 2 } },
		{ helperChallenge: { ...base.helperChallenge, runtimeGeneration: 8 } },
		{ helperChallenge: { ...base.helperChallenge, sessionId: "foreign-session" } },
	])
		await expect(handle(f, f.callback("restore_original", patch))).rejects.toThrow();
	expect(f.controls.signed).toBe(0);
});

test("tampered challenge and unknown helper key cannot obtain control tickets", async () => {
	const f = await fixture();
	const body = f.callback();
	body.helperChallenge.signature = "A".repeat(86);
	await expect(handle(f, body)).rejects.toThrow("Untrusted native helper");
	const other = generateKeyPairSync("ed25519");
	body.helperChallenge.signature = sign(
		null,
		windowsMetadataHelperChallengeSignedBytes(body, f.original),
		other.privateKey,
	).toString("base64url");
	await expect(handle(f, body)).rejects.toThrow("Untrusted native helper");
});

test("original helper challenge binds operation/digest/lease/fence, not just native paths", async () => {
	const f = await fixture();
	for (const original of [
		{ ...f.original, operationId: "foreign" },
		{ ...f.original, requestDigest: "f".repeat(64) },
		{ ...f.original, leaseId: "foreign" },
		{ ...f.original, fence: 41 },
	]) {
		const body = f.callback();
		body.helperChallenge.signature = sign(
			null,
			windowsMetadataHelperChallengeSignedBytes(body, original),
			f.helperKeys.privateKey,
		).toString("base64url");
		await expect(handle(f, body)).rejects.toThrow("Untrusted native helper");
	}
});

test("wrong/closed outer RPC and stale live generation/session reject before signing", async () => {
	const f = await fixture();
	await expect(handle(f, f.callback("capture_exact", { outerRpcId: "foreign" }))).rejects.toThrow(
		"original pending RPC",
	);
	f.controls.pending = false;
	await expect(handle(f, f.callback())).rejects.toThrow("original pending RPC");
	f.controls.pending = true;
	f.controls.live.runtimeGeneration++;
	await expect(handle(f, f.callback())).rejects.toThrow("original pending RPC");
	f.controls.live.runtimeGeneration--;
	f.controls.live.sessionId = "foreign";
	await expect(handle(f, f.callback())).rejects.toThrow("original pending RPC");
	expect(f.controls.signed).toBe(0);
});

test("single-use step/nonce/challenge never return cached tickets and cannot cross RPC", async () => {
	const f = await fixture();
	const controller = createWindowsMetadataCallbackController();
	const first = f.callback();
	await handle(f, first, controller);
	await expect(handle(f, first, controller)).rejects.toThrow("replay");
	await expect(
		handle(f, f.callback("capture_exact", { nonce: first.nonce }), controller),
	).rejects.toThrow("replay");
	await expect(
		handle(
			f,
			f.callback("capture_exact", { helperChallenge: { ...first.helperChallenge } }),
			controller,
		),
	).rejects.toThrow("replay");
	const admission = await registerAdmission(f.input);
	await expect(
		controller.handle(
			encodeWindowsMetadataCallback(first),
			{ ...f.pending, windowsMetadataAdmission: admission },
			signal(),
		),
	).rejects.toThrow("replay");
	const old = f.pending.outerRpcId;
	f.pending.outerRpcId = "other-rpc";
	await expect(handle(f, f.callback(), controller)).rejects.toThrow("borrowed by another RPC");
	f.pending.outerRpcId = old;
});

test("withdrawn/expired/missing root actor material or broker unavailable fail closed", async () => {
	const f = await fixture();
	withdrawAdmission(f.admission);
	await expect(handle(f, f.callback())).rejects.toThrow("withdrawn");
	const unavailable = await fixture();
	unavailable.controls.ready = false;
	await expect(handle(unavailable, unavailable.callback())).rejects.toThrow("broker not ready");
	await expect(registerAdmission({ ...unavailable.input, ttlMs: 30001 })).rejects.toThrow(
		"lifetime exceeds",
	);
	await expect(
		registerAdmission({
			...unavailable.input,
			freshAuthorize: async () => true as unknown as string,
		}),
	).rejects.toThrow("revision required");
});

test("actor revocation or transport replacement during async signing returns no ticket", async () => {
	for (const replacement of ["actor", "transport"] as const) {
		const f = await fixture();
		f.controls.signGate = async () => {
			if (replacement === "actor") f.controls.revision = "revoked";
			else f.controls.live.runtimeGeneration++;
		};
		await expect(handle(f, f.callback())).rejects.toThrow();
		expect(f.controls.signed).toBe(1);
	}
});

test("control queue has 2 workers and 64 entries, independent of history scheduler", async () => {
	const f = await fixture();
	const started = deferred<void>();
	const release = deferred<void>();
	f.controls.signGate = async () => {
		if (f.controls.signed === 2) started.resolve();
		await release.promise;
	};
	const controller = createWindowsMetadataCallbackController();
	const requests = Array.from({ length: 64 }, () => handle(f, f.callback(), controller));
	await expect(handle(f, f.callback(), controller)).rejects.toThrow("queue full");
	await started.promise;
	expect(f.controls.signed).toBe(2);
	release.resolve();
	expect(await Promise.all(requests)).toHaveLength(64);
	expect(f.controls.signed).toBe(64);
});

test("two hung fresh checks expire, release worker capacity and never issue late tickets", async () => {
	const controller = createWindowsMetadataCallbackController();
	const late = deferred<string>();
	const started = deferred<void>();
	let waiting = 0;
	const stalled = [await fixture(), await fixture()];
	const outcomes: Promise<string>[] = [];
	for (const f of stalled) {
		const admission = await registerAdmission({
			...f.input,
			ttlMs: 150,
			async freshAuthorize(context, bounded) {
				if (context.callback !== null) {
					waiting++;
					if (waiting === 2) started.resolve();
					return late.promise;
				}
				return f.input.freshAuthorize(context, bounded);
			},
		});
		outcomes.push(
			controller
				.handle(
					encodeWindowsMetadataCallback(f.callback()),
					{ ...f.pending, windowsMetadataAdmission: admission },
					signal(),
				)
				.then(
					() => "unexpected ticket",
					() => "expired",
				),
		);
	}
	await started.promise;
	const healthy = await fixture();
	const queued = handle(healthy, healthy.callback(), controller);
	expect(await Promise.all(outcomes)).toEqual(["expired", "expired"]);
	const result = await queued;
	expect(verifyWindowsIoSignedTicket(result.ticket, [healthy.pin], Date.now()).operationId).toBe(
		healthy.original.operationId,
	);
	late.resolve("fresh-policy-1");
	await Promise.resolve();
	await Promise.resolve();
	expect(stalled[0]?.controls.signed).toBe(0);
	expect(stalled[1]?.controls.signed).toBe(0);
});

test("cancellation returns no ticket or dispatched evidence even with stalled signer", async () => {
	const f = await fixture();
	const started = deferred<void>();
	const never = new Promise<void>(() => {});
	f.controls.signGate = async () => {
		if (f.controls.signed === 2) started.resolve();
		await never;
	};
	const controller = createWindowsMetadataCallbackController();
	const controllers = Array.from({ length: 64 }, () => new AbortController());
	const outcomes = controllers.map((entry) =>
		handle(f, f.callback(), controller, entry.signal).catch(() => "cancelled"),
	);
	await started.promise;
	for (const entry of controllers) entry.abort(new Error("cancelled"));
	expect(await Promise.all(outcomes)).toHaveLength(64);
	expect(f.controls.signed).toBe(2);
	const stopped = new AbortController();
	stopped.abort();
	await expect(handle(f, f.callback(), controller, stopped.signal)).rejects.toThrow();
});
