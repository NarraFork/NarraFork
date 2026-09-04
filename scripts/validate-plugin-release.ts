import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { type Manifest, safeParseManifest } from "../server/lib/plugins/manifest";
import {
	PluginProviderRpcClient,
	PluginRuntimeProviderTransport,
} from "../server/services/plugin-provider-rpc";
import { LocalProcessRunner, PluginRuntime } from "../server/services/plugin-runtime";
import { generateSpdxSbom, parseSbom } from "../server/services/plugin-sbom";

const RELEASE_OSES = ["linux", "darwin", "win32"] as const;
const RELEASE_ARCHES = ["x64", "arm64"] as const;
const SBOM_FILE = "sbom.spdx.json";
const DEFAULT_RUNTIME_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 2_000;

export type PluginReleaseValidationMode = "static" | "runtime" | "ga";

export interface PluginReleaseValidationOptions {
	mode?: PluginReleaseValidationMode;
	runtimeTimeoutMs?: number;
}

export interface PluginReleaseMatrixEntry {
	os: (typeof RELEASE_OSES)[number];
	arch: (typeof RELEASE_ARCHES)[number];
	supported: boolean;
}

export interface PluginReleaseRuntimeEvidence {
	status: "not-requested" | "skipped-no-server" | "passed" | "failed";
	handshake?: {
		hello: boolean;
		initialize: boolean;
		activate: boolean;
		health: boolean;
		generation: number;
	};
	toolInvoke?: {
		contributionId: string;
		outputBytes: number;
	};
	provider?: {
		providerTypeId: string;
		modelCount: number;
	};
	error?: string;
}

export interface PluginReleasePackageSummary {
	kind: string;
	pluginId?: string;
	version?: string;
	path: string;
	valid: boolean;
	errors: string[];
	digest?: string;
	entries: string[];
	matrix: PluginReleaseMatrixEntry[];
	sbom: {
		path: string;
		format?: "spdx" | "cyclonedx";
		componentCount: number;
		generatedSpdx: boolean;
	};
	runtime: PluginReleaseRuntimeEvidence;
}

export interface PluginReleaseValidationSummary {
	valid: boolean;
	mode: PluginReleaseValidationMode;
	packageCount: number;
	matrixCombinationCount: number;
	errors: string[];
	packages: PluginReleasePackageSummary[];
}

function isInsidePath(parent: string, child: string): boolean {
	const normalizedParent = resolve(parent);
	const normalizedChild = resolve(child);
	return (
		normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`)
	);
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function pathIsRegularFile(packageRoot: string, relativePath: string): Promise<boolean> {
	const path = resolve(packageRoot, relativePath);
	if (!isInsidePath(packageRoot, path)) return false;
	try {
		const [packageRealPath, fileRealPath, stats] = await Promise.all([
			realpath(packageRoot),
			realpath(path),
			lstat(path),
		]);
		return isInsidePath(packageRealPath, fileRealPath) && stats.isFile() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
}

function manifestEntryPaths(manifest: Manifest): string[] {
	const paths = new Set<string>();
	if (manifest.server?.entry) paths.add(manifest.server.entry);
	if (manifest.ui?.entry) paths.add(manifest.ui.entry);
	if (manifest.ui?.style) paths.add(manifest.ui.style);
	for (const view of manifest.contributes.views) {
		paths.add(view.entry);
		if (view.style) paths.add(view.style);
	}
	return [...paths].sort();
}

async function packageFilePaths(root: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink())
				throw new Error(`symlink is not allowed: ${relative(root, path)}`);
			if (entry.isDirectory()) {
				await walk(path);
			} else if (entry.isFile()) {
				files.push(path);
			} else {
				throw new Error(`unsupported package entry: ${relative(root, path)}`);
			}
		}
	};
	await walk(root);
	return files;
}

async function computePackageDigest(root: string): Promise<string> {
	const hash = createHash("sha256");
	for (const path of await packageFilePaths(root)) {
		const relativePath = relative(root, path).split(sep).join("/");
		hash.update(relativePath);
		hash.update("\0");
		hash.update(await readFile(path));
	}
	return hash.digest("hex");
}

function releaseMatrix(manifest: Manifest): PluginReleaseMatrixEntry[] {
	const supportedOs = new Set(manifest.engine.os ?? RELEASE_OSES);
	const supportedArch = new Set(manifest.engine.arch ?? RELEASE_ARCHES);
	return RELEASE_OSES.flatMap((os) =>
		RELEASE_ARCHES.map((arch) => ({
			os,
			arch,
			supported: supportedOs.has(os) && supportedArch.has(arch),
		})),
	);
}

function runtimeCommand(manifest: Manifest, packageRoot: string): string[] {
	const server = manifest.server;
	if (!server) throw new Error("plugin has no server entry");
	const entryPath = join(packageRoot, ...server.entry.split("/"));
	switch (manifest.engine.runtime) {
		case "bun":
			return [process.execPath, entryPath, ...server.args];
		case "node":
			return ["node", entryPath, ...server.args];
		case "python":
			return ["python", entryPath, ...server.args];
		case "binary":
			return [entryPath, ...server.args];
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function outputByteLength(value: unknown): number {
	if (
		typeof value === "object" &&
		value !== null &&
		"output" in value &&
		typeof value.output === "string"
	) {
		return Buffer.byteLength(value.output);
	}
	return Buffer.byteLength(JSON.stringify(value) ?? "");
}

async function boundedCleanup(runtime: PluginRuntime): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			runtime.terminate("release validation cleanup"),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("release validation process-tree cleanup timed out")),
					CLEANUP_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function validateRuntime(
	packageRoot: string,
	manifest: Manifest,
	packageDigest: string,
	mode: Exclude<PluginReleaseValidationMode, "static">,
	timeoutMs: number,
): Promise<PluginReleaseRuntimeEvidence> {
	if (!manifest.server) return { status: "skipped-no-server" };
	if (manifest.engine.runner !== "local-process") {
		return {
			status: "failed",
			error: `release validation only supports local-process runners, received ${manifest.engine.runner}`,
		};
	}

	const runtimeRoot = await mkdtemp(join(tmpdir(), "narrafork-plugin-release-"));
	const dataPath = join(runtimeRoot, "data");
	const tempPath = join(runtimeRoot, "temp");
	await Promise.all([mkdir(dataPath), mkdir(tempPath)]);
	const runner = new LocalProcessRunner({
		allowedCwds: [packageRoot, dataPath, tempPath],
		allowUnboundedResourceUsage: process.platform === "win32",
		spawnTimeoutMs: timeoutMs,
		idleTimeoutMs: timeoutMs,
		totalTimeoutMs: timeoutMs,
	});
	const runtime = new PluginRuntime({
		pluginId: manifest.pluginId,
		pluginVersion: manifest.version,
		packageDigest,
		command: runtimeCommand(manifest, packageRoot),
		cwd: packageRoot,
		runner,
		rpcProtocol: manifest.server.protocol,
		hostApiVersion: "1.0",
		grantedCapabilities: manifest.permissions.host,
		activationReason: `release-validation:${mode}`,
		env: {
			NF_PLUGIN_PACKAGE_DIR: packageRoot,
			NF_PLUGIN_DATA_DIR: dataPath,
			NF_PLUGIN_TEMP_DIR: tempPath,
			NF_PLUGIN_LOG_DIR: runtimeRoot,
			NF_PLUGIN_PACKAGE_DIGEST: packageDigest,
		},
		timeouts: {
			handshakeMs: timeoutMs,
			activationMs: timeoutMs,
			rpcMs: timeoutMs,
			drainMs: Math.min(timeoutMs, 500),
			shutdownMs: Math.min(timeoutMs, 500),
			cancelGraceMs: Math.min(timeoutMs, 100),
		},
		idleTimeoutMs: timeoutMs,
		totalTimeoutMs: timeoutMs,
	});
	const controller = new AbortController();
	let providerClient: PluginProviderRpcClient | undefined;
	let timedOut = false;
	let rejectDeadline: ((error: Error) => void) | undefined;
	const deadline = new Promise<never>((_, reject) => {
		rejectDeadline = reject;
	});
	const timer = setTimeout(() => {
		timedOut = true;
		const error = new Error(`runtime validation timeout after ${timeoutMs}ms`);
		controller.abort(error);
		runtime.quarantine(error.message);
		rejectDeadline?.(error);
	}, timeoutMs);

	try {
		const evidence = await Promise.race([
			(async (): Promise<PluginReleaseRuntimeEvidence> => {
				await runtime.start(controller.signal);
				const diagnostics = runtime.getDiagnostics();
				const result: PluginReleaseRuntimeEvidence = {
					status: "passed",
					handshake: {
						hello: true,
						initialize: true,
						activate: true,
						health: true,
						generation: diagnostics.generation,
					},
				};

				if (mode === "ga") {
					const tool = manifest.contributes.tools.find((item) => item.execution === "server");
					if (tool) {
						const response = await runtime.request(
							"tools.invoke",
							{ contributionId: tool.id, input: { text: "NarraFork GA release validation" } },
							{ signal: controller.signal, timeoutMs },
						);
						result.toolInvoke = {
							contributionId: tool.id,
							outputBytes: outputByteLength(response),
						};
					}

					if (manifest.contributes.providers.length > 0) {
						const transport = new PluginRuntimeProviderTransport(runtime, {
							subscribeNotifications: (handler) => runtime.onNotification(handler),
							subscribeClose: (handler) => runtime.onClose(handler),
							kill: (reason) => runtime.quarantine(reason),
						});
						providerClient = new PluginProviderRpcClient({
							transport,
							expectedPluginId: manifest.pluginId,
							limits: {
								acceptedTimeoutMs: timeoutMs,
								unaryTimeoutMs: timeoutMs,
								streamIdleTimeoutMs: timeoutMs,
								operationTimeoutMs: timeoutMs,
								cancelGraceMs: Math.min(timeoutMs, 100),
							},
						});
						const description = await providerClient.describe();
						const provider = description.providers[0];
						if (!provider) throw new Error("provider.describe returned no providers");
						const models = await providerClient.listModels(
							{
								providerTypeId: provider.providerTypeId,
								providerInstanceId: "release-validation",
								config: {},
								limit: provider.limits.maxModelPageSize,
							},
							controller.signal,
						);
						result.provider = {
							providerTypeId: provider.providerTypeId,
							modelCount: models.models.length,
						};
					}
				}

				return result;
			})(),
			deadline,
		]);
		return evidence;
	} catch (error) {
		return {
			status: "failed",
			error: timedOut ? `runtime validation timeout after ${timeoutMs}ms` : errorMessage(error),
		};
	} finally {
		clearTimeout(timer);
		await providerClient?.dispose().catch(() => undefined);
		await boundedCleanup(runtime);
		await rm(runtimeRoot, { recursive: true, force: true });
	}
}

async function validatePackage(
	packageRoot: string,
	mode: PluginReleaseValidationMode,
	runtimeTimeoutMs: number,
): Promise<PluginReleasePackageSummary> {
	const kind = basename(packageRoot);
	const errors: string[] = [];
	const summary: PluginReleasePackageSummary = {
		kind,
		path: packageRoot,
		valid: false,
		errors,
		entries: [],
		matrix: [],
		sbom: {
			path: join(packageRoot, SBOM_FILE),
			componentCount: 0,
			generatedSpdx: false,
		},
		runtime: { status: "not-requested" },
	};

	let manifest: Manifest;
	try {
		const parsed = safeParseManifest(await readJson(join(packageRoot, "manifest.json")));
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				errors.push(`manifest ${issue.path.join(".") || "root"}: ${issue.message}`);
			}
			return summary;
		}
		manifest = parsed.data;
		summary.pluginId = manifest.pluginId;
		summary.version = manifest.version;
	} catch (error) {
		errors.push(`manifest: ${errorMessage(error)}`);
		return summary;
	}

	summary.entries = manifestEntryPaths(manifest);
	for (const entry of summary.entries) {
		if (!(await pathIsRegularFile(packageRoot, entry))) {
			errors.push(`entry is missing, unsafe, or not a regular file: ${entry}`);
		}
	}
	// Declarative-only contributions (e.g. themes) ship no server/UI entry: they
	// are pure whitelisted tokens the host compiles. Such a package is valid as
	// long as it declares at least one contribution.
	const hasDeclarativeContribution = manifest.contributes.themes.length > 0;
	if (summary.entries.length === 0 && !hasDeclarativeContribution) {
		errors.push("package has no server or UI entry");
	}

	summary.matrix = releaseMatrix(manifest);
	for (const combination of summary.matrix) {
		if (!combination.supported) {
			errors.push(`release matrix does not support ${combination.os}/${combination.arch}`);
		}
	}

	try {
		const sbom = parseSbom(await readJson(summary.sbom.path));
		summary.sbom.format = sbom.format;
		summary.sbom.componentCount = sbom.components.length;
		if (sbom.format !== "spdx") errors.push(`SBOM must use SPDX, received ${sbom.format}`);
		const packageComponent = sbom.components.find(
			(component) => component.name === manifest.pluginId && component.version === manifest.version,
		);
		if (!packageComponent) {
			errors.push("SBOM does not contain the plugin package and version");
		} else if (manifest.license && packageComponent.license !== manifest.license) {
			errors.push("SBOM package license does not match manifest license");
		}
		const generated = parseSbom(
			generateSpdxSbom(
				[
					{
						id: manifest.pluginId,
						name: manifest.pluginId,
						version: manifest.version,
						license: manifest.license,
						supplier: manifest.publisher?.name ?? manifest.publisher?.id,
					},
				],
				manifest.pluginId,
			),
		);
		summary.sbom.generatedSpdx = generated.format === "spdx";
	} catch (error) {
		errors.push(`SBOM: ${errorMessage(error)}`);
	}

	let packageDigest: string | undefined;
	try {
		packageDigest = await computePackageDigest(packageRoot);
		summary.digest = packageDigest;
	} catch (error) {
		errors.push(`digest: ${errorMessage(error)}`);
	}

	if (errors.length === 0 && mode !== "static" && packageDigest !== undefined) {
		summary.runtime = await validateRuntime(
			packageRoot,
			manifest,
			packageDigest,
			mode,
			runtimeTimeoutMs,
		);
		if (summary.runtime.status === "failed") {
			errors.push(`runtime: ${summary.runtime.error ?? "validation failed"}`);
		}
	}

	summary.valid = errors.length === 0;
	return summary;
}

function normalizeOptions(
	options: PluginReleaseValidationOptions,
): Required<PluginReleaseValidationOptions> {
	const mode = options.mode ?? "static";
	if (mode !== "static" && mode !== "runtime" && mode !== "ga") {
		throw new Error(`Invalid plugin release validation mode: ${String(mode)}`);
	}
	const runtimeTimeoutMs = options.runtimeTimeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
	if (!Number.isSafeInteger(runtimeTimeoutMs) || runtimeTimeoutMs < 100) {
		throw new Error("runtimeTimeoutMs must be an integer of at least 100ms");
	}
	return { mode, runtimeTimeoutMs };
}

export async function validatePluginRelease(
	pluginsRoot = resolve(process.cwd(), "examples/plugins"),
	options: PluginReleaseValidationOptions = {},
): Promise<PluginReleaseValidationSummary> {
	const normalized = normalizeOptions(options);
	const rootEntries = await readdir(pluginsRoot, { withFileTypes: true });
	const packageRoots = rootEntries
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(pluginsRoot, entry.name))
		.sort((left, right) => basename(left).localeCompare(basename(right)));
	const packages = await Promise.all(
		packageRoots.map((packageRoot) =>
			validatePackage(packageRoot, normalized.mode, normalized.runtimeTimeoutMs),
		),
	);
	const errors = packages.flatMap((item) => item.errors.map((error) => `${item.kind}: ${error}`));
	return {
		valid: errors.length === 0 && packages.length > 0,
		mode: normalized.mode,
		packageCount: packages.filter((item) => item.valid).length,
		matrixCombinationCount: packages.reduce((total, item) => total + item.matrix.length, 0),
		errors,
		packages,
	};
}

interface CliOptions {
	pluginsRoot?: string;
	validation: PluginReleaseValidationOptions;
	help: boolean;
}

function parseCliArgs(args: string[]): CliOptions {
	let pluginsRoot: string | undefined;
	let mode: PluginReleaseValidationMode = "static";
	let runtimeTimeoutMs: number | undefined;
	let help = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (argument === "--static" || argument === "--runtime" || argument === "--ga") {
			mode = argument.slice(2) as PluginReleaseValidationMode;
			continue;
		}
		if (argument === "--mode") {
			const value = args[index + 1];
			if (!value) throw new Error("--mode requires static, runtime, or ga");
			mode = value as PluginReleaseValidationMode;
			index += 1;
			continue;
		}
		if (argument.startsWith("--mode=")) {
			mode = argument.slice("--mode=".length) as PluginReleaseValidationMode;
			continue;
		}
		if (argument === "--runtime-timeout-ms" || argument === "--timeout-ms") {
			const value = args[index + 1];
			if (!value) throw new Error(`${argument} requires a number`);
			runtimeTimeoutMs = Number(value);
			index += 1;
			continue;
		}
		if (argument.startsWith("--runtime-timeout-ms=") || argument.startsWith("--timeout-ms=")) {
			runtimeTimeoutMs = Number(argument.slice(argument.indexOf("=") + 1));
			continue;
		}
		if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
		if (pluginsRoot) throw new Error(`Unexpected positional argument: ${argument}`);
		pluginsRoot = argument;
	}
	return { pluginsRoot, validation: { mode, runtimeTimeoutMs }, help };
}

if (import.meta.main) {
	try {
		const cli = parseCliArgs(process.argv.slice(2));
		if (cli.help) {
			console.log(
				"Usage: bun scripts/validate-plugin-release.ts [plugins-root] [--static|--runtime|--ga] [--runtime-timeout-ms N]",
			);
		} else {
			const summary = await validatePluginRelease(cli.pluginsRoot, cli.validation);
			console.log(JSON.stringify(summary, null, 2));
			if (!summary.valid) process.exitCode = 1;
		}
	} catch (error) {
		console.error(errorMessage(error));
		process.exitCode = 1;
	}
}
