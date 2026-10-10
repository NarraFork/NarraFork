import { BUILD_GITHUB_REPOSITORY } from "./build-repository";
import { isValidGitHubRepository } from "./github-repository";
import { isValidReleaseVersion } from "./release-version";
import { EXECUTOR_PLATFORMS, type ExecutorManifest } from "./remote-executor";
import { EXECUTOR_VERSION_RE, parseExecutorManifest } from "./remote-executor-manifest";

// Pure distribution contract: no filesystem, environment, settings or network access.
export const HELPER_CATALOG_VERSION = "1.0.0";
export const HELPER_RELEASE_TAG = "helpers-v1.0.0";
export const HELPER_MANIFEST_FILENAME = "helper-manifest-v1.json";
export const HELPER_TOOLS = ["rg", "zstd"] as const;
export const HELPER_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
	"windows-arm64",
] as const;
export const HELPER_TOOL_VERSIONS = { rg: "15.1.0", zstd: "1.5.7" } as const;
export const HELPER_MANIFEST_MAX_BYTES = 64 * 1024;
export const HELPER_BINARY_MAX_BYTES = 32 * 1024 * 1024;
export type HelperTool = (typeof HELPER_TOOLS)[number];
export type HelperPlatform = (typeof HELPER_PLATFORMS)[number];
export interface DistributionLicense {
	name: string;
	size: number;
	sha256: string;
}
export interface HelperManifestFile extends DistributionLicense {
	tool: HelperTool;
	toolVersion: string;
	platform: HelperPlatform;
}
export interface HelperManifest {
	schemaVersion: 1;
	repository: string;
	tag: string;
	commit: string;
	catalogVersion: string;
	files: HelperManifestFile[];
	licenses: DistributionLicense[];
}
export interface ExecutorReleaseManifest {
	schemaVersion: 1;
	repository: string;
	tag: string;
	commit: string;
	manifest: ExecutorManifest;
	licenses: DistributionLicense[];
}
export interface HelperDistributionDependencies {
	helpers: { catalogVersion: typeof HELPER_CATALOG_VERSION; tag: typeof HELPER_RELEASE_TAG };
	executor: { version: string; protocolVersion: number; tag: string };
}
/** Matches the existing device wire protocol; no runtime/server dependency here. */
export const HELPER_EXECUTOR_PROTOCOL_VERSION = 1;
export function parseHelperDistributionDependencies(
	value: unknown,
	expectedVersion?: string,
): HelperDistributionDependencies {
	const record = object(value, ["helpers", "executor"]);
	const helpers = object(record.helpers, ["catalogVersion", "tag"]);
	const executor = object(record.executor, ["version", "protocolVersion", "tag"]);
	if (
		helpers.catalogVersion !== HELPER_CATALOG_VERSION ||
		helpers.tag !== HELPER_RELEASE_TAG ||
		typeof executor.version !== "string" ||
		!isValidReleaseVersion(executor.version) ||
		!EXECUTOR_VERSION_RE.test(executor.version) ||
		(expectedVersion !== undefined && executor.version !== expectedVersion) ||
		executor.tag !== `executor-v${executor.version}` ||
		executor.protocolVersion !== HELPER_EXECUTOR_PROTOCOL_VERSION
	)
		throw new Error("Invalid helper distribution dependencies");
	return {
		helpers: { catalogVersion: HELPER_CATALOG_VERSION, tag: HELPER_RELEASE_TAG },
		executor: {
			version: executor.version,
			protocolVersion: HELPER_EXECUTOR_PROTOCOL_VERSION,
			tag: `executor-v${executor.version}`,
		},
	};
}
export function createHelperDistributionDependencies(
	version: string,
	protocolVersion = HELPER_EXECUTOR_PROTOCOL_VERSION,
): HelperDistributionDependencies {
	return parseHelperDistributionDependencies(
		{
			helpers: { catalogVersion: HELPER_CATALOG_VERSION, tag: HELPER_RELEASE_TAG },
			executor: { version, protocolVersion, tag: `executor-v${version}` },
		},
		version,
	);
}
export type HelperSource =
	| { source: "github"; repository: string }
	| { source: "update-server"; serverUrl: string };
export function normalizeHelperSource(input: {
	source?: string;
	githubRepository?: string;
	repository?: string;
	serverUrl?: string;
}): HelperSource {
	if (input.source === undefined || input.source === "github") {
		const repository = input.repository ?? input.githubRepository ?? BUILD_GITHUB_REPOSITORY;
		if (!isValidGitHubRepository(repository)) throw new Error("Invalid helper repository");
		return { source: "github", repository: repository.toLowerCase() };
	}
	if (input.source !== "update-server") throw new Error("Invalid helper source");
	const url = new URL(input.serverUrl?.trim() || "https://narrafork-update.b.domexie.cn");
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Invalid helper server URL");
	}
	return { source: "update-server", serverUrl: url.href.replace(/\/+$/, "") };
}
export function helperSourceIdentity(source: HelperSource): string {
	const normalized = normalizeHelperSource(source);
	return normalized.source === "github"
		? `github:${normalized.repository}`
		: `update-server:${normalized.serverUrl}`;
}
export function getHelperAssetName(tool: HelperTool, platform: HelperPlatform): string {
	if (!HELPER_TOOLS.includes(tool) || !HELPER_PLATFORMS.includes(platform))
		throw new Error("Unknown helper tool/platform");
	return platform.startsWith("windows-")
		? `${tool}-${platform === "windows-x64" ? "win64" : "win-arm64"}.exe`
		: `${tool}-${platform}`;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid distribution object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key)))
		throw new Error("Unknown distribution field");
	return record;
}
function bounded(value: unknown): void {
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > HELPER_MANIFEST_MAX_BYTES)
		throw new Error("Manifest exceeds size limit");
}
function asset(
	value: unknown,
	keys: readonly string[] = ["name", "size", "sha256"],
): DistributionLicense {
	const record = object(value, keys);
	if (
		typeof record.name !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(record.name) ||
		record.name.includes("..")
	)
		throw new Error("Invalid asset name");
	if (
		!Number.isSafeInteger(record.size) ||
		(record.size as number) < 1 ||
		(record.size as number) > HELPER_BINARY_MAX_BYTES
	)
		throw new Error("Invalid asset size");
	if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256))
		throw new Error("Invalid asset digest");
	return { name: record.name, size: record.size as number, sha256: record.sha256 };
}
function licenses(value: unknown, binaryNames: string[]): DistributionLicense[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32)
		throw new Error("Missing distribution licenses");
	const result = value.map((entry) => asset(entry));
	const names = [...binaryNames, ...result.map((entry) => entry.name)];
	if (new Set(names).size !== names.length) throw new Error("Duplicate asset name");
	return result;
}
export interface ExpectedDistributionIdentity {
	repository: string;
	tag?: string;
	commit?: string;
}
function identity(
	record: Record<string, unknown>,
	expected: ExpectedDistributionIdentity,
	tag: string,
): { schemaVersion: 1; repository: string; tag: string; commit: string } {
	if (
		record.schemaVersion !== 1 ||
		!isValidGitHubRepository(record.repository) ||
		typeof record.repository !== "string" ||
		record.repository.toLowerCase() !== expected.repository.toLowerCase() ||
		record.tag !== tag ||
		(expected.tag !== undefined && record.tag !== expected.tag) ||
		typeof record.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(record.commit) ||
		(expected.commit !== undefined && record.commit !== expected.commit)
	)
		throw new Error("Distribution identity mismatch");
	return { schemaVersion: 1, repository: record.repository, tag, commit: record.commit };
}
export function parseHelperManifest(
	value: unknown,
	expected: ExpectedDistributionIdentity,
): HelperManifest {
	bounded(value);
	const record = object(value, [
		"schemaVersion",
		"repository",
		"tag",
		"commit",
		"catalogVersion",
		"files",
		"licenses",
	]);
	const id = identity(record, expected, HELPER_RELEASE_TAG);
	if (
		record.catalogVersion !== HELPER_CATALOG_VERSION ||
		!Array.isArray(record.files) ||
		record.files.length !== 12
	)
		throw new Error("Incomplete helper catalog");
	const seen = new Set<string>();
	const files = record.files.map((value): HelperManifestFile => {
		const entry = object(value, ["tool", "toolVersion", "platform", "name", "size", "sha256"]);
		const tool = entry.tool as HelperTool;
		const platform = entry.platform as HelperPlatform;
		if (
			!HELPER_TOOLS.includes(tool) ||
			!HELPER_PLATFORMS.includes(platform) ||
			entry.toolVersion !== HELPER_TOOL_VERSIONS[tool]
		)
			throw new Error("Invalid helper platform/version");
		const binary = asset(entry, ["tool", "toolVersion", "platform", "name", "size", "sha256"]);
		if (binary.name !== getHelperAssetName(tool, platform) || seen.has(`${tool}:${platform}`))
			throw new Error("Unexpected/duplicate helper asset");
		seen.add(`${tool}:${platform}`);
		return { ...binary, tool, platform, toolVersion: HELPER_TOOL_VERSIONS[tool] };
	});
	return {
		...id,
		catalogVersion: HELPER_CATALOG_VERSION,
		files,
		licenses: licenses(
			record.licenses,
			files.map((entry) => entry.name),
		),
	};
}
export function parseExecutorReleaseManifest(
	value: unknown,
	expected: ExpectedDistributionIdentity & { version: string; protocolVersion: number },
): ExecutorReleaseManifest {
	bounded(value);
	const record = object(value, [
		"schemaVersion",
		"repository",
		"tag",
		"commit",
		"manifest",
		"licenses",
	]);
	const id = identity(record, expected, `executor-v${expected.version}`);
	const rawManifest = object(record.manifest, [
		"version",
		"protocolVersion",
		"releasedAt",
		"platforms",
	]);
	const rawPlatforms = object(rawManifest.platforms, EXECUTOR_PLATFORMS);
	for (const entry of Object.values(rawPlatforms)) object(entry, ["filename", "size", "sha256"]);
	const manifest = parseExecutorManifest(rawManifest);
	if (
		manifest.version !== expected.version ||
		manifest.protocolVersion !== expected.protocolVersion ||
		Object.keys(manifest.platforms).length !== EXECUTOR_PLATFORMS.length ||
		Object.values(manifest.platforms).some((entry) => entry.size > HELPER_BINARY_MAX_BYTES)
	)
		throw new Error("Executor version/protocol/platform mismatch");
	return {
		...id,
		manifest,
		licenses: licenses(
			record.licenses,
			Object.values(manifest.platforms).map((entry) => entry.filename),
		),
	};
}
