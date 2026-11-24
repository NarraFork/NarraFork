import { createHash } from "node:crypto";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isMainThread, parentPort } from "node:worker_threads";
import { pluginIdSchema, safeParseManifest } from "@server/lib/plugins/manifest";
import {
	PLUGIN_PACKAGE_STAGE_MAX_BUFFERED_BYTES,
	PLUGIN_PACKAGE_STAGE_MAX_CONTROL_BYTES,
	PLUGIN_PACKAGE_STAGE_MAX_ERROR_BYTES,
	PLUGIN_PACKAGE_STAGE_MAX_PATH_BYTES,
	PLUGIN_PACKAGE_STAGE_MAX_RESPONSE_BYTES,
	PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
	type PluginPackageStageRequest,
	type PluginPackageStageResponse,
	type PluginPackageStageResult,
} from "./plugin-package-stage-protocol";
import {
	computePackageHash,
	type InstalledPackageResult,
	type PackageStoreLimits,
	PluginPackageStore,
} from "./plugin-package-store";
import { checkSbomInstallPolicy, parseSbom } from "./plugin-sbom";
import {
	type PluginSignature,
	PluginTrustKeyring,
	parsePluginSignature,
	verifyPluginPackageSignature,
} from "./plugin-signature";

const MAX_TRUST_ARTIFACT_BYTES = 1024 * 1024;
const PACKAGE_LIMIT_CEILINGS = {
	maxArchiveBytes: 100 * 1024 * 1024,
	maxUnpackedBytes: 500 * 1024 * 1024,
	maxFileBytes: 50 * 1024 * 1024,
	maxManifestBytes: 1024 * 1024,
	maxFiles: 10_000,
	timeoutMs: 120_000,
} as const;

function boundedPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		isAbsolute(value) &&
		!value.includes("\0") &&
		Buffer.byteLength(value) <= PLUGIN_PACKAGE_STAGE_MAX_PATH_BYTES
	);
}

function trustFailure(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function assertRequest(
	input: unknown,
): asserts input is Exclude<PluginPackageStageRequest, { action: "ping" }> {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid package Worker request");
	const request = input as Record<string, unknown>;
	if (
		Object.keys(request).length > 8 ||
		request.protocolVersion !== PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION ||
		!Number.isSafeInteger(request.id) ||
		(request.id as number) < 1
	)
		throw new Error("Invalid package Worker protocol");
	if (request.limits !== undefined) {
		if (!request.limits || typeof request.limits !== "object" || Array.isArray(request.limits))
			throw new Error("Invalid package limits");
		for (const [key, value] of Object.entries(request.limits)) {
			const ceiling = PACKAGE_LIMIT_CEILINGS[key as keyof typeof PACKAGE_LIMIT_CEILINGS];
			if (
				ceiling === undefined ||
				!Number.isSafeInteger(value) ||
				(value as number) <= 0 ||
				(value as number) > ceiling
			)
				throw new Error("Package limits exceed the Worker budget");
		}
	}
	if (request.action === "plugin_package_stage") {
		if (
			!boundedPath(request.root) ||
			(typeof request.source === "string"
				? !boundedPath(request.source)
				: !(request.source instanceof ArrayBuffer) ||
					request.source.byteLength > PLUGIN_PACKAGE_STAGE_MAX_BUFFERED_BYTES) ||
			(request.oldPackagePath !== undefined && !boundedPath(request.oldPackagePath))
		)
			throw new Error("Invalid or oversized package stage input");
		if (
			request.expectedArchiveSha256 !== undefined &&
			(typeof request.expectedArchiveSha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(request.expectedArchiveSha256))
		)
			throw new Error("Invalid archive digest");
		if (
			Buffer.byteLength(JSON.stringify({ ...request, source: undefined })) >
			PLUGIN_PACKAGE_STAGE_MAX_CONTROL_BYTES
		)
			throw new Error("Package stage control input exceeded its byte budget");
		return;
	}
	if (request.action === "plugin_package_inspect") {
		const identity = request.identity as Record<string, unknown> | undefined;
		if (
			!boundedPath(request.root) ||
			!boundedPath(request.source) ||
			!identity ||
			typeof identity !== "object" ||
			Array.isArray(identity) ||
			!pluginIdSchema.safeParse(identity.pluginId).success ||
			typeof identity.version !== "string" ||
			!/^[0-9A-Za-z.+-]{1,256}$/.test(identity.version) ||
			typeof identity.hash !== "string" ||
			!/^[a-f0-9]{64}$/.test(identity.hash) ||
			request.source !==
				resolve(
					request.root,
					"packages",
					identity.pluginId as string,
					identity.version,
					identity.hash,
				) ||
			Buffer.byteLength(JSON.stringify(request)) > PLUGIN_PACKAGE_STAGE_MAX_CONTROL_BYTES
		)
			throw new Error("Invalid installed package inspection request");
		return;
	}
	if (request.action !== "plugin_package_verify") throw new Error("Unknown package Worker action");
	const policy = request.policy as Record<string, unknown> | undefined;
	if (
		!policy ||
		typeof policy !== "object" ||
		Array.isArray(policy) ||
		typeof policy.enabled !== "boolean" ||
		typeof policy.requireSignature !== "boolean" ||
		(policy.keyringConfigured !== undefined && typeof policy.keyringConfigured !== "boolean") ||
		Buffer.byteLength(JSON.stringify(request)) > PLUGIN_PACKAGE_STAGE_MAX_CONTROL_BYTES
	)
		throw new Error("Invalid or oversized package trust policy");
	if (policy.key !== undefined) {
		const key = policy.key as Record<string, unknown>;
		if (
			!key ||
			typeof key !== "object" ||
			Array.isArray(key) ||
			typeof key.keyId !== "string" ||
			typeof key.publicKey !== "string" ||
			(key.pluginIds !== undefined &&
				(!Array.isArray(key.pluginIds) || key.pluginIds.some((id) => typeof id !== "string"))) ||
			(key.revokedAt !== undefined && typeof key.revokedAt !== "string")
		)
			throw new Error("Invalid package trust key");
	}
}

async function readArtifact(root: string, name: string): Promise<unknown | undefined> {
	const path = join(root, name);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink())
		throw trustFailure("PLUGIN_TRUST_ARTIFACT_INVALID", "Trust artifact is not a regular file");
	if (info.size > MAX_TRUST_ARTIFACT_BYTES)
		throw trustFailure("PLUGIN_TRUST_ARTIFACT_TOO_LARGE", "Trust artifact exceeds its byte budget");
	const handle = await open(path, "r");
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
			throw trustFailure("PLUGIN_TRUST_ARTIFACT_INVALID", "Trust artifact changed while opening");
		const bytes = new Uint8Array(MAX_TRUST_ARTIFACT_BYTES + 1);
		let count = 0;
		while (count < bytes.length) {
			const result = await handle.read(bytes, count, bytes.length - count, count);
			if (!result.bytesRead) break;
			count += result.bytesRead;
		}
		if (count > MAX_TRUST_ARTIFACT_BYTES)
			throw new Error("Trust artifact exceeded its byte budget");
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
		} catch {
			throw trustFailure("PLUGIN_TRUST_ARTIFACT_INVALID", "Trust artifact is invalid UTF-8 JSON");
		}
	} finally {
		await handle.close();
	}
}

function signatureIdentity(signature: PluginSignature): string {
	return `${signature.algorithm}:${signature.keyId}:${signature.publisherId ?? ""}`;
}

/** Installed bytes can change between activation attempts; reapply bounded file policy. */
async function assertInstalledTree(root: string, limits: PackageStoreLimits): Promise<void> {
	const pending = [root];
	let entries = 0;
	let files = 0;
	let bytes = 0;
	while (pending.length) {
		const path = pending.pop();
		if (!path) break;
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw trustFailure(
				"PLUGIN_TRUST_ARTIFACT_INVALID",
				"Installed package contains an unsafe directory",
			);
		const directory = await opendir(path);
		for await (const entry of directory) {
			if (++entries > 2 * limits.maxFiles)
				throw trustFailure(
					"PLUGIN_TRUST_ARTIFACT_TOO_LARGE",
					"Installed package exceeds its entry budget",
				);
			const child = join(path, entry.name);
			const stat = await lstat(child);
			if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
				throw trustFailure(
					"PLUGIN_TRUST_ARTIFACT_INVALID",
					"Installed package contains a symlink or special file",
				);
			if (stat.isDirectory()) pending.push(child);
			else {
				if (++files > limits.maxFiles)
					throw trustFailure(
						"PLUGIN_TRUST_ARTIFACT_TOO_LARGE",
						"Installed package exceeds its file budget",
					);
				bytes += stat.size;
				if (stat.size > limits.maxFileBytes || bytes > limits.maxUnpackedBytes)
					throw trustFailure(
						"PLUGIN_TRUST_ARTIFACT_TOO_LARGE",
						"Installed package exceeds its byte budget",
					);
			}
		}
	}
}

/** Bind retained files to their stored identity, using exactly the installation hash format. */
async function assertStoredPackageHash(
	root: string,
	expected: string,
	limits: PackageStoreLimits,
): Promise<void> {
	await assertInstalledTree(root, limits);
	if ((await computePackageHash(root, limits)) !== expected)
		throw trustFailure(
			"PLUGIN_PACKAGE_HASH_MISMATCH",
			"Installed package content does not match its recorded hash",
		);
}

// Only this entry owns the package protocol. Importing state storage in any Worker is inert.
if (!isMainThread && parentPort) {
	const port = parentPort;
	let phase: "idle" | "staging" | "staged" | "verifying" | "complete" | "failed" = "idle";
	let staged: PluginPackageStageResult | undefined;
	let signature: PluginSignature | undefined;
	let packageLimits: PackageStoreLimits = { ...PACKAGE_LIMIT_CEILINGS };
	const post = (response: PluginPackageStageResponse) => port.postMessage(response);
	const ready = () =>
		post({ packageStageReady: true, protocolVersion: PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION });
	port.on("message", async (input: unknown) => {
		if (
			input &&
			typeof input === "object" &&
			!Array.isArray(input) &&
			(input as { action?: unknown }).action === "ping"
		) {
			ready();
			return;
		}
		let id = 0;
		if (input && typeof input === "object" && !Array.isArray(input)) {
			const candidate = (input as { id?: unknown }).id;
			if (Number.isSafeInteger(candidate) && (candidate as number) > 0) id = candidate as number;
		}
		try {
			assertRequest(input);
			id = input.id;
			if (input.action === "plugin_package_stage" || input.action === "plugin_package_inspect") {
				if (phase !== "idle" || id !== 1) throw new Error("Package stage request is out of order");
				phase = "staging";
				if (input.action === "plugin_package_stage" && input.expectedArchiveSha256 !== undefined) {
					if (
						!(input.source instanceof ArrayBuffer) ||
						createHash("sha256").update(new Uint8Array(input.source)).digest("hex") !==
							input.expectedArchiveSha256
					) {
						throw Object.assign(new Error("Builtin archive failed integrity validation"), {
							code: "PLUGIN_BUNDLED_INTEGRITY_FAILED",
						});
					}
				}
				const store = new PluginPackageStore({ root: input.root, limits: input.limits });
				packageLimits = store.limits;
				let installed: InstalledPackageResult;
				if (input.action === "plugin_package_inspect") {
					await assertStoredPackageHash(input.source, input.identity.hash, packageLimits);
					const manifest = safeParseManifest(await readArtifact(input.source, "manifest.json"));
					if (
						!manifest.success ||
						manifest.data.pluginId !== input.identity.pluginId ||
						manifest.data.version !== input.identity.version
					)
						throw trustFailure(
							"PLUGIN_IDENTITY_MISMATCH",
							"Installed package manifest identity changed",
						);
					installed = {
						...input.identity,
						manifest: manifest.data,
						path: input.source,
						packagePath: input.source,
						alreadyInstalled: true,
						currentUpdated: false,
					};
				} else {
					installed = await store.install(
						typeof input.source === "string" ? input.source : new Uint8Array(input.source),
						{ updateCurrent: false },
					);
					// Deduplication retains existing bytes; the incoming archive's digest alone
					// cannot prove that this previously installed directory is still intact.
					if (installed.alreadyInstalled)
						await assertStoredPackageHash(installed.path, installed.hash, packageLimits);
				}
				const raw = await readArtifact(installed.path, "signature.json");
				if (raw !== undefined) {
					try {
						signature = parsePluginSignature(raw);
					} catch (error) {
						throw trustFailure(
							"PLUGIN_SIGNATURE_INVALID",
							error instanceof Error ? error.message : "Invalid plugin signature",
						);
					}
				}
				const old =
					input.action === "plugin_package_stage" && input.oldPackagePath
						? await readArtifact(input.oldPackagePath, "signature.json")
						: undefined;
				staged = {
					...installed,
					signatureIdentity: signature ? signatureIdentity(signature) : null,
					previousSignatureIdentity:
						old === undefined ? null : signatureIdentity(parsePluginSignature(old)),
					signatureKeyId: signature?.keyId,
				};
				const resultJson = JSON.stringify(staged);
				if (Buffer.byteLength(resultJson) > PLUGIN_PACKAGE_STAGE_MAX_RESPONSE_BYTES)
					throw new Error("Package stage response exceeds its byte budget");
				phase = "staged";
				post({
					type: "staged",
					protocolVersion: PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
					id,
					resultJson,
				});
				return;
			}
			if (phase !== "staged" || !staged || id !== 2)
				throw new Error("Package trust validation requires staged bytes and a host policy");
			phase = "verifying";
			if (input.policy.enabled) {
				if (!signature && input.policy.requireSignature)
					throw trustFailure(
						"PLUGIN_SIGNATURE_REQUIRED",
						"Plugin signature is required by the host trust policy",
					);
				if (signature) {
					if (signature.pluginId !== staged.pluginId || signature.version !== staged.version)
						throw trustFailure(
							"PLUGIN_SIGNATURE_IDENTITY_MISMATCH",
							"Plugin signature identity does not match the manifest",
						);
					if (!input.policy.key)
						throw trustFailure(
							input.policy.keyringConfigured
								? "PLUGIN_SIGNATURE_UNTRUSTED"
								: "PLUGIN_TRUST_CONFIGURATION_MISSING",
							"Plugin signature verification requires a configured trust key",
						);
					const verified = await verifyPluginPackageSignature(
						staged.path,
						signature,
						new PluginTrustKeyring([input.policy.key]),
					);
					if (!verified.valid || !verified.trusted)
						throw trustFailure(
							"PLUGIN_SIGNATURE_UNTRUSTED",
							`Plugin signature verification failed: ${verified.reason ?? "UNTRUSTED_SIGNATURE"}`,
						);
				}
				const sbom =
					(await readArtifact(staged.path, "sbom.spdx.json")) ??
					(await readArtifact(staged.path, "sbom.cdx.json"));
				if (sbom === undefined && input.policy.sbomPolicy?.requireSbom)
					throw trustFailure(
						"PLUGIN_SBOM_REQUIRED",
						"Plugin SBOM is required by the host trust policy",
					);
				if (sbom !== undefined) {
					let parsed: ReturnType<typeof parseSbom>;
					try {
						parsed = parseSbom(sbom);
					} catch (error) {
						throw trustFailure(
							"PLUGIN_SBOM_INVALID",
							error instanceof Error ? error.message : "Invalid plugin SBOM",
						);
					}
					if (input.policy.sbomPolicy) {
						const result = checkSbomInstallPolicy(parsed, input.policy.sbomPolicy);
						if (!result.allowed)
							throw trustFailure(
								"PLUGIN_SBOM_POLICY",
								`Plugin SBOM policy failed: ${result.violations.join(",")}`,
							);
					}
				}
			}
			// Host policy exchange and signature/SBOM reads can yield. Recheck retained
			// bytes before the success reply rather than just echoing the original hash.
			if (staged.alreadyInstalled)
				await assertStoredPackageHash(staged.path, staged.hash, packageLimits);
			phase = "complete";
			post({
				type: "verified",
				protocolVersion: PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
				id,
				verified: true,
			});
			port.close();
		} catch (error) {
			phase = "failed";
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
			const code = (error as { code?: unknown })?.code;
			post({
				type: "error",
				protocolVersion: PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
				id,
				error: message.slice(0, PLUGIN_PACKAGE_STAGE_MAX_ERROR_BYTES / 4),
				code:
					typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
						? code
						: "PACKAGE_STAGE_FAILED",
			});
			port.close();
		}
	});
	ready();
}
