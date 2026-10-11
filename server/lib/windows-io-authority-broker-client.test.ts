import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { WindowsIoTicketPayload } from "@shared/windows-io-authority";
import golden from "@shared/windows-io-authority.golden.json";
import {
	createWindowsIoExternalBrokerSigner,
	type WindowsIoKeyCustodyAdapter,
} from "./windows-io-authority-broker-client";
import { runWindowsIoBounded } from "./windows-io-authority-budget";
import {
	decodeWindowsIoBase64url,
	encodeWindowsIoSignedTicket,
	verifyWindowsIoSignedTicket,
} from "./windows-io-authority-crypto";

// OS evidence below is deliberately a UNIT FIXTURE, never native deployment evidence.
const fixtureState: Awaited<ReturnType<WindowsIoKeyCustodyAdapter["inspectSecurityContext"]>> = {
	brokerServiceId: "broker-unit-test",
	brokerPrincipal: "uid:2001",
	authServicePrincipal: "uid:2002",
	toolWorkerPrincipals: ["uid:2003"],
	custodyModel: "hardware_nonexportable",
	allowedCustodyModels: ["hardware_nonexportable"],
	keyNonExportable: true,
	brokerProcessBound: true,
	authServiceProcessBound: true,
	signingContractValidated: true,
	signerRestrictsRootAndAction: true,
	singleActionGrantRequired: true,
	durableReplayProtection: true,
	keyAclAdminAndBrokerOnly: true,
	configAclAdminOnly: true,
	callerAclAuthServiceOnly: true,
	workerCannotImpersonateAuthService: true,
	peerAuthenticatedByOs: true,
	brokerRestrictsWindowsIoContract: true,
};
function fixture(patch: Partial<typeof fixtureState> = {}) {
	const keys = generateKeyPairSync("ed25519");
	const payload = JSON.parse(golden.canonicalPayload) as WindowsIoTicketPayload;
	const pin = {
		issuer: payload.issuer,
		serviceId: payload.serviceId,
		keyEpoch: payload.keyEpoch,
		publicKey: keys.publicKey
			.export({ format: "der", type: "spki" })
			.subarray(-32)
			.toString("base64url"),
	};
	const state = { ...fixtureState, ...patch };
	let exchanges = 0;
	const adapter: WindowsIoKeyCustodyAdapter = {
		async inspectSecurityContext() {
			return state;
		},
		async exchange(request, _signal, limit) {
			exchanges++;
			expect(limit).toBe(1024);
			const parsed = JSON.parse(new TextDecoder().decode(request));
			expect(parsed.version).toBe(1);
			expect(parsed.method).toBe("sign_windows_io_authorization");
			const bytes = decodeWindowsIoBase64url(parsed.payload, 16384);
			return Buffer.from(
				JSON.stringify({
					version: 1,
					signature: sign(null, bytes, keys.privateKey).toString("base64url"),
				}),
			);
		},
	};
	const config = {
		pin,
		brokerServiceId: fixtureState.brokerServiceId,
		authServicePrincipal: fixtureState.authServicePrincipal,
		brokerPrincipal: fixtureState.brokerPrincipal,
	};
	return { config, adapter, state, payload, exchanges: () => exchanges };
}
const signal = () => new AbortController().signal;

test.each([
	{ toolWorkerPrincipals: ["uid:2002"] },
	{ toolWorkerPrincipals: ["uid:2001"] },
	{ toolWorkerPrincipals: [] },
	{ brokerPrincipal: "uid:2002" },
	{ authServicePrincipal: "uid:changed" },
	{ brokerServiceId: "unknown" },
	{ keyNonExportable: false },
	{ authServiceProcessBound: false },
	{ brokerProcessBound: false },
	{ signingContractValidated: false },
	{ signerRestrictsRootAndAction: false },
	{ singleActionGrantRequired: false },
	{ durableReplayProtection: false },
	{ keyAclAdminAndBrokerOnly: false },
	{ configAclAdminOnly: false },
	{ callerAclAuthServiceOnly: false },
	{ workerCannotImpersonateAuthService: false },
	{ peerAuthenticatedByOs: false },
	{ brokerRestrictsWindowsIoContract: false },
])("OS-isolation gate requirements fail closed (unit evidence): %j", async (patch) => {
	const f = fixture(patch);
	const signer = createWindowsIoExternalBrokerSigner(f.config, f.adapter);
	expect((await signer.readiness(signal())).ready).toBe(false);
	await expect(signer.signAuthorizedPayload(f.payload, signal())).rejects.toThrow(
		"custody not ready",
	);
	expect(f.exchanges()).toBe(0);
});

test("software custody requires explicit constructor AND live administrator policy", async () => {
	const f = fixture({
		custodyModel: "os_isolated_software",
		keyNonExportable: false,
		allowedCustodyModels: ["os_isolated_software"],
	});
	const defaultSigner = createWindowsIoExternalBrokerSigner(f.config, f.adapter);
	expect((await defaultSigner.readiness(signal())).ready).toBe(false);
	await expect(defaultSigner.signAuthorizedPayload(f.payload, signal())).rejects.toThrow(
		"custody not ready",
	);
	const signer = createWindowsIoExternalBrokerSigner(
		{ ...f.config, allowedCustodyModels: ["os_isolated_software"] },
		f.adapter,
	);
	expect((await signer.readiness(signal())).ready).toBe(true);
	expect(f.state.keyNonExportable).toBe(false);
	const signature = await signer.signAuthorizedPayload(f.payload, signal());
	expect(signature.byteLength).toBe(64);
	f.state.allowedCustodyModels = [];
	expect((await signer.readiness(signal())).ready).toBe(false);
	f.state.allowedCustodyModels = ["os_isolated_software"];
	f.state.keyNonExportable = true;
	expect((await signer.readiness(signal())).ready).toBe(false);
});

test.each([
	{ toolWorkerPrincipals: ["uid:2002"] },
	{ toolWorkerPrincipals: ["uid:2001"] },
	{ authServiceProcessBound: false },
	{ brokerProcessBound: false },
	{ signingContractValidated: false },
	{ signerRestrictsRootAndAction: false },
	{ singleActionGrantRequired: false },
	{ durableReplayProtection: false },
	{ keyAclAdminAndBrokerOnly: false },
	{ configAclAdminOnly: false },
	{ callerAclAuthServiceOnly: false },
	{ workerCannotImpersonateAuthService: false },
	{ peerAuthenticatedByOs: false },
	{ brokerRestrictsWindowsIoContract: false },
])("admin allowed software still requires every OS boundary: %j", async (patch) => {
	const f = fixture({
		custodyModel: "os_isolated_software",
		keyNonExportable: false,
		allowedCustodyModels: ["os_isolated_software"],
		...patch,
	});
	const signer = createWindowsIoExternalBrokerSigner(
		{ ...f.config, allowedCustodyModels: ["os_isolated_software"] },
		f.adapter,
	);
	expect((await signer.readiness(signal())).ready).toBe(false);
	await expect(signer.signAuthorizedPayload(f.payload, signal())).rejects.toThrow(
		"custody not ready",
	);
	expect(f.exchanges()).toBe(0);
});

test("string/number claims cannot masquerade as native boolean facts", async () => {
	for (const claim of ["true", 1, undefined]) {
		const f = fixture({ peerAuthenticatedByOs: claim as unknown as boolean });
		expect(
			(await createWindowsIoExternalBrokerSigner(f.config, f.adapter).readiness(signal())).ready,
		).toBe(false);
	}
	const f = fixture({
		custodyModel: "os_isolated_software",
		allowedCustodyModels: ["os_isolated_software"],
		keyNonExportable: undefined as unknown as boolean,
	});
	expect(
		(
			await createWindowsIoExternalBrokerSigner(
				{ ...f.config, allowedCustodyModels: ["os_isolated_software"] },
				f.adapter,
			).readiness(signal())
		).ready,
	).toBe(false);
});

test("empty administrator custody allowlist permits no fallback", async () => {
	const f = fixture();
	expect(
		(
			await createWindowsIoExternalBrokerSigner(
				{ ...f.config, allowedCustodyModels: [] },
				f.adapter,
			).readiness(signal())
		).ready,
	).toBe(false);
});

test("bounded broker contract transmits no private key or env/argv credentials", async () => {
	const f = fixture();
	const signer = createWindowsIoExternalBrokerSigner(f.config, f.adapter);
	expect((await signer.readiness(signal())).ready).toBe(true);
	const signature = await signer.signAuthorizedPayload(f.payload, signal());
	const ticket = encodeWindowsIoSignedTicket(Buffer.from(golden.canonicalPayload), signature);
	expect(verifyWindowsIoSignedTicket(ticket, [f.config.pin], f.payload.issuedAt)).toEqual(
		f.payload,
	);
	expect(f.exchanges()).toBe(1);
});

test("bad/oversize/duplicate broker replies and custody change never return signatures", async () => {
	for (const response of [
		Buffer.alloc(1025),
		Buffer.from('{"version":1,"signature":"AA","version":1}'),
		Buffer.from('{"version":1,"signature":"AA","unknown":true}'),
		Buffer.from('{"version":1,"signature":"AA"}'),
	]) {
		const f = fixture();
		f.adapter.exchange = async () => response;
		await expect(
			createWindowsIoExternalBrokerSigner(f.config, f.adapter).signAuthorizedPayload(
				f.payload,
				signal(),
			),
		).rejects.toThrow();
	}
	const f = fixture();
	const original = f.adapter.exchange;
	f.adapter.exchange = async (...args) => {
		const reply = await original(...args);
		f.state.callerAclAuthServiceOnly = false;
		return reply;
	};
	await expect(
		createWindowsIoExternalBrokerSigner(f.config, f.adapter).signAuthorizedPayload(
			f.payload,
			signal(),
		),
	).rejects.toThrow("custody changed");
});

test("queue stays bounded even when an aborted external broker ignores cancellation", async () => {
	const f = fixture();
	f.adapter.exchange = () => new Promise(() => {});
	const signer = createWindowsIoExternalBrokerSigner(f.config, f.adapter);
	const controllers = Array.from({ length: 64 }, () => new AbortController());
	const pending = controllers.map((controller) =>
		signer.signAuthorizedPayload(f.payload, controller.signal).catch(() => "cancelled"),
	);
	await expect(signer.signAuthorizedPayload(f.payload, signal())).rejects.toThrow("queue full");
	await Promise.resolve();
	await Promise.resolve();
	for (const controller of controllers) controller.abort(new Error("cancelled"));
	expect(await Promise.all(pending)).toHaveLength(64);
	// Slots must not be recycled when still running external IO has no completion proof.
	await expect(signer.signAuthorizedPayload(f.payload, signal())).rejects.toThrow("queue full");
});

test("uncooperative adapters cannot block the caller past cancellation", async () => {
	const controller = new AbortController();
	const pending = runWindowsIoBounded(controller.signal, () => new Promise(() => {}));
	controller.abort(new Error("bounded cancellation"));
	await expect(pending).rejects.toThrow("bounded cancellation");
});
