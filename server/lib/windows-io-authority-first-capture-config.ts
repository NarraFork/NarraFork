import { createHash } from "node:crypto";
import {
	parseWindowsFirstCaptureBytes,
	WINDOWS_FIRST_CAPTURE_LIMITS,
} from "@shared/windows-first-capture";
import { z } from "zod";
import { runWindowsIoBounded } from "./windows-io-authority-budget";
import {
	createWindowsIoUnixBrokerSigner,
	createWindowsIoUnixFirstCaptureEnrollmentInspector,
	readWindowsIoProtectedPublicFile,
} from "./windows-io-authority-unix-custody";

export const WINDOWS_FIRST_CAPTURE_CONFIG_ENV = "NARRAFORK_WINDOWS_FIRST_CAPTURE_CONFIG";
const path = z.string().min(1).max(4096);
const id = z.string().min(1).max(256);
const publicPin = z.strictObject({
	issuer: id,
	serviceId: id,
	keyEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	publicKey: z.string().length(43),
});
export const windowsFirstCapturePublicConfigurationSchema = z.strictObject({
	version: z.literal(1),
	enrollmentFile: path,
	broker: z.strictObject({
		binaryPath: path,
		administratorConfigPath: path,
		pin: publicPin,
		brokerServiceId: id,
		authServicePrincipal: id,
		brokerPrincipal: id,
		allowedCustodyModels: z
			.array(z.enum(["hardware_nonexportable", "os_isolated_software"]))
			.min(1)
			.max(2),
	}),
});
/** The environment contains ONLY a public file locator. No default key, enrollment,
 * account registration or test process/boolean adapter exists on this production path. */
export async function loadWindowsFirstCaptureDeployment(signal: AbortSignal) {
	if (process.platform !== "linux")
		throw new Error("WINDOWS_FIRST_CAPTURE_SIGNER_HOST_UNSUPPORTED");
	const location = process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV];
	if (!location) throw new Error("WINDOWS_FIRST_CAPTURE_ADMIN_CONFIGURATION_MISSING");
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	return runWindowsIoBounded(bounded, async () => {
		const bytes = await readWindowsIoProtectedPublicFile(
			location,
			WINDOWS_FIRST_CAPTURE_LIMITS.configurationBytes,
		);
		const configuration = parseWindowsFirstCaptureBytes(
			bytes,
			windowsFirstCapturePublicConfigurationSchema,
		);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const options = {
			binaryPath: configuration.broker.binaryPath,
			administratorConfigPath: configuration.broker.administratorConfigPath,
			pin: configuration.broker.pin,
		};
		const signer = createWindowsIoUnixBrokerSigner(
			{
				pin: configuration.broker.pin,
				brokerServiceId: configuration.broker.brokerServiceId,
				authServicePrincipal: configuration.broker.authServicePrincipal,
				brokerPrincipal: configuration.broker.brokerPrincipal,
				allowedCustodyModels: configuration.broker.allowedCustodyModels,
			},
			options,
		);
		const inspect = createWindowsIoUnixFirstCaptureEnrollmentInspector(
			options,
			configuration.enrollmentFile,
		);
		if (!(await signer.readiness(bounded)).ready)
			throw new Error("WINDOWS_FIRST_CAPTURE_OS_CUSTODY_UNAVAILABLE");
		const enrolled = await inspect(bounded);
		bounded.throwIfAborted();
		const assertCurrent = (original: AbortSignal) => {
			const current = AbortSignal.any([original, AbortSignal.timeout(10_000)]);
			return runWindowsIoBounded(current, async () => {
				const freshBytes = await readWindowsIoProtectedPublicFile(
					location,
					WINDOWS_FIRST_CAPTURE_LIMITS.configurationBytes,
				);
				if (
					process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV] !== location ||
					createHash("sha256").update(freshBytes).digest("hex") !== digest
				)
					throw new Error("WINDOWS_FIRST_CAPTURE_CONFIGURATION_CHANGED");
				if (!(await signer.readiness(current)).ready)
					throw new Error("WINDOWS_FIRST_CAPTURE_OS_CUSTODY_REVOKED");
				const fresh = await inspect(current);
				if (
					fresh.enrollmentDigest !== enrolled.enrollmentDigest ||
					fresh.configDigest !== enrolled.configDigest
				)
					throw new Error("WINDOWS_FIRST_CAPTURE_ENROLLMENT_CHANGED");
				current.throwIfAborted();
			});
		};
		await assertCurrent(bounded);
		return Object.freeze({
			configuration,
			configurationDigest: digest,
			signer,
			...enrolled,
			assertCurrent,
		});
	});
}
