import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalWindowsFirstCaptureBytes,
	windowsFirstCaptureHttpSchema,
} from "@shared/windows-first-capture";
import golden from "@shared/windows-first-capture.golden.json";
import {
	loadWindowsFirstCaptureDeployment,
	WINDOWS_FIRST_CAPTURE_CONFIG_ENV,
	windowsFirstCapturePublicConfigurationSchema,
} from "./windows-io-authority-first-capture-config";
import { readWindowsIoProtectedPublicFile } from "./windows-io-authority-unix-custody";

const original = process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV];
let directory: string | undefined;
afterEach(async () => {
	if (original === undefined) delete process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV];
	else process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV] = original;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});
const configuration = () => ({
	version: 1 as const,
	enrollmentFile: "/administrator/public-enrollment",
	broker: {
		binaryPath: "/administrator/immutable-broker",
		administratorConfigPath: "/administrator/broker-config",
		pin: { issuer: "platform", serviceId: "control", keyEpoch: 1, publicKey: golden.publicKey },
		brokerServiceId: "broker",
		authServicePrincipal: "auth",
		brokerPrincipal: "broker",
		allowedCustodyModels: ["os_isolated_software" as const],
	},
});

test("no admin path is unavailable, never a production signer fallback", async () => {
	delete process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV];
	await expect(loadWindowsFirstCaptureDeployment(new AbortController().signal)).rejects.toThrow(
		process.platform === "linux" ? "ADMIN_CONFIGURATION_MISSING" : "SIGNER_HOST_UNSUPPORTED",
	);
});

test("local writable development config cannot register itself or pass real OS custody", async () => {
	directory = await mkdtemp(join(tmpdir(), "narrafork-first-capture-negative-"));
	const path = join(directory, "public.json");
	await writeFile(path, canonicalWindowsFirstCaptureBytes(configuration()), { mode: 0o666 });
	process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV] = path;
	await expect(loadWindowsFirstCaptureDeployment(new AbortController().signal)).rejects.toThrow();
});

test("public file read refuses symlink, writable ancestors and unavailable locations", async () => {
	directory = await mkdtemp(join(tmpdir(), "narrafork-first-capture-negative-"));
	const path = join(directory, "public.json");
	const link = join(directory, "link.json");
	await writeFile(path, "{}", { mode: 0o600 });
	await symlink(path, link);
	for (const location of [path, link, join(directory, "absent")])
		await expect(readWindowsIoProtectedPublicFile(location, 65536)).rejects.toThrow();
	await expect(readWindowsIoProtectedPublicFile(path, 65537)).rejects.toThrow("BUDGET");
});

test("production schema accepts no enabled/custody booleans, key, Root or test resolver", () => {
	const value = configuration();
	expect(windowsFirstCapturePublicConfigurationSchema.parse(value)).toEqual(value);
	for (const field of [
		"enabled",
		"externalCustody",
		"testResolver",
		"privateKey",
		"root",
		"allowDefault",
	])
		expect(() =>
			windowsFirstCapturePublicConfigurationSchema.parse({ ...value, [field]: true }),
		).toThrow();
	for (const field of ["enabled", "externalCustody", "privateKey", "allowSamePrincipal"])
		expect(() =>
			windowsFirstCapturePublicConfigurationSchema.parse({
				...value,
				broker: { ...value.broker, [field]: true },
			}),
		).toThrow();
});

test("HTTP request cannot supply authority root/lease/session/helper or request-derived actor", () => {
	const value = { path: "C:\\工作区\\original.txt", requestId: "unit_negative_request" };
	expect(windowsFirstCaptureHttpSchema.parse(value)).toEqual(value);
	for (const field of [
		"actor",
		"credential",
		"root",
		"scope",
		"helper",
		"pipePeer",
		"leaseId",
		"fence",
		"ticket",
		"windowsFirstCaptureOrigin",
	])
		expect(() => windowsFirstCaptureHttpSchema.parse({ ...value, [field]: "forged" })).toThrow();
	for (const path of ["bad\0path", "bad\npath"])
		expect(() => windowsFirstCaptureHttpSchema.parse({ ...value, path })).toThrow();
});
