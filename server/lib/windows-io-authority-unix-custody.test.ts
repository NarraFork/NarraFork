import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionDefaultWindowsIoSigner } from "./windows-io-authority-broker-client";
import {
	createWindowsIoUnixBrokerSigner,
	createWindowsIoUnixCustodyAdapter,
	createWindowsIoUnixGrantPublisher,
	type WindowsIoUnixCustodyOptions,
} from "./windows-io-authority-unix-custody";

function options(
	binaryPath = "/unconfigured/windows-io-signing-broker",
	administratorConfigPath = "/unconfigured/broker.json",
): WindowsIoUnixCustodyOptions {
	// Ephemeral unit public pin only; no production seed/file or exported private key.
	const { publicKey } = generateKeyPairSync("ed25519");
	return {
		binaryPath,
		administratorConfigPath,
		pin: {
			issuer: "unit",
			serviceId: "unit-service",
			keyEpoch: 1,
			publicKey: publicKey
				.export({ format: "der", type: "spki" })
				.subarray(-32)
				.toString("base64url"),
		},
	};
}

describe("Unix custody native failclosed (not an installed isolated service)", () => {
	test("production does not auto-generate a signer or provision OS identities", () => {
		expect(productionDefaultWindowsIoSigner()).toBeNull();
	});
	test("absent administrator registration remains unavailable", async () => {
		const configured = options();
		const signer = createWindowsIoUnixBrokerSigner(
			{
				pin: configured.pin,
				brokerServiceId: "unit",
				brokerPrincipal: "uid:2001",
				authServicePrincipal: "uid:2002",
			},
			configured,
		);
		const state = await signer.readiness(new AbortController().signal);
		expect(state.ready).toBe(false);
		expect(state.reason).toBe("WINDOWS_IO_SIGNING_BROKER_UNAVAILABLE");
	});
	test("an already canceled inspection cannot spawn a helper", async () => {
		const controller = new AbortController();
		controller.abort();
		const adapter = createWindowsIoUnixCustodyAdapter(options());
		await expect(adapter.inspectSecurityContext(controller.signal)).rejects.toThrow();
	});
	test("an already canceled grant publication cannot invent authority", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			createWindowsIoUnixGrantPublisher(options()).publishAuthorizedPayloadGrant(
				{} as never,
				controller.signal,
			),
		).rejects.toThrow();
	});
	test("an already canceled exchange cannot send ticket bytes", async () => {
		const controller = new AbortController();
		controller.abort();
		const adapter = createWindowsIoUnixCustodyAdapter(options());
		await expect(
			adapter.exchange(new TextEncoder().encode("sensitive payload"), controller.signal, 1024),
		).rejects.toThrow();
	});
	test("relative authority config cannot become a trusted workspace setting", async () => {
		const adapter = createWindowsIoUnixCustodyAdapter(
			options("/no/binary", "workspace/broker.json"),
		);
		await expect(adapter.inspectSecurityContext(new AbortController().signal)).rejects.toThrow();
	});
	test("a fake helper in mutable scratch cannot supply native boolean evidence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "nf-custody-negative-"));
		try {
			const binary = join(directory, "fake-broker");
			const config = join(directory, "broker.json");
			await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			await writeFile(
				config,
				JSON.stringify({ version: 1, peerAuthenticatedByOs: true, keyNonExportable: true }),
				{ mode: 0o600 },
			);
			const adapter = createWindowsIoUnixCustodyAdapter(options(binary, config));
			await expect(adapter.inspectSecurityContext(new AbortController().signal)).rejects.toThrow(
				"WINDOWS_IO_CUSTODY_ADMIN_PATH_UNPROTECTED",
			);
		} finally {
			await rm(directory, { recursive: true });
		}
	});
	test("different pin cannot silently select another broker", () => {
		const configured = options();
		const other = options();
		expect(() =>
			createWindowsIoUnixBrokerSigner(
				{
					pin: other.pin,
					brokerServiceId: "unit",
					brokerPrincipal: "uid:2001",
					authServicePrincipal: "uid:2002",
				},
				configured,
			),
		).toThrow("WINDOWS_IO_CUSTODY_PIN_MISMATCH");
	});
});
