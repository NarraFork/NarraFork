import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isValidGitHubRepository,
	OFFICIAL_GITHUB_REPOSITORY,
} from "../../shared/github-repository";
import {
	type HelperDistributionDependencies,
	parseHelperDistributionDependencies,
} from "../../shared/helper-distribution";
import {
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	parseReleasePatchName,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";
import {
	REMOTE_FRONTEND_ARCHIVE_MAX_BYTES,
	REMOTE_FRONTEND_MANIFEST_MAX_BYTES,
	remoteFrontendArtifactNames,
} from "../../shared/remote-access/frontend-manifest";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import { type BinaryMetadata, formatChecksumsReport, formatSha256Sums } from "./binary-metadata";
import { copyReleaseFile } from "./ci-release-io";
import type { ComponentReleaseEvidence } from "./component-release-inputs";

const MAX_BINARY_BYTES = MAX_RELEASE_BINARY_BYTES;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ASSETS = 200;
const MAX_PATCH_PAIRS = 64;
const MAX_DIST_ENTRIES = 4096;
export const GH_TIMEOUT_MS = 300_000;
export const GH_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_GITHUB_REPOSITORY = OFFICIAL_GITHUB_REPOSITORY;

export interface GhReadControls {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
}
export type GhRunner = (args: string[], controls?: GhReadControls) => string | Promise<string>;

/** Source reads opt into an async bounded transport; ordinary publication keeps its own budget. */
async function runControlledGh(args: string[], controls: GhReadControls): Promise<string> {
	const timeoutMs = Math.min(controls.timeoutMs ?? 30_000, 30_000);
	const maximum = Math.min(controls.maxOutputBytes ?? GH_MAX_OUTPUT_BYTES, GH_MAX_OUTPUT_BYTES);
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		!Number.isSafeInteger(maximum) ||
		maximum < 1
	)
		throw new Error("Invalid bounded GitHub read controls");
	const signal = AbortSignal.any([
		...(controls.signal ? [controls.signal] : []),
		AbortSignal.timeout(timeoutMs),
	]);
	signal.throwIfAborted();
	const proc = Bun.spawn(["gh", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...updateServerChildEnvironment(), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
	});
	const cancel = () => proc.kill();
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const consume = async (stream: ReadableStream<Uint8Array>, maximum: number) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of stream) {
			size += chunk.length;
			if (size > maximum) {
				proc.kill();
				throw new Error("GitHub read output exceeds limit");
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, size).toString("utf8");
	};
	try {
		const [stdout, stderr, exit] = await Promise.all([
			consume(proc.stdout, maximum),
			consume(proc.stderr, 8192),
			proc.exited,
		]);
		signal.throwIfAborted();
		if (exit !== 0) throw new Error(`gh failed: ${stderr}`);
		return stdout;
	} finally {
		signal.removeEventListener("abort", cancel);
		if (proc.exitCode === null) proc.kill();
	}
}

/** No shell interpolation, bounded output and timeout; authentication belongs to gh. */
export const runGh: GhRunner = (args, controls) => {
	if (controls) return runControlledGh(args, controls);
	try {
		return execFileSync("gh", args, {
			encoding: "utf8",
			timeout: GH_TIMEOUT_MS,
			maxBuffer: GH_MAX_OUTPUT_BYTES,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...updateServerChildEnvironment(), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
		});
	} catch (error) {
		const detail = error as { stderr?: string | Buffer; message?: string };
		throw new Error(`gh failed: ${String(detail.stderr ?? detail.message).slice(0, 8192)}`);
	}
};

export function validateGitHubRepository(repository: string): void {
	if (!isValidGitHubRepository(repository)) {
		throw new Error("Invalid GitHub repository; expected owner/repo");
	}
}

export function releaseChannel(version: string): "stable" | "beta" {
	return /^\d+\.\d+\.0$/.test(version) ? "stable" : "beta";
}

export interface GitHubReleaseDownloads {
	repository: string;
	version: string;
	filenames: readonly string[];
}

/** Human-facing links include full executables only, never sidecars or patches. */
export function githubReleaseBody(
	changelog?: string | Record<string, string>,
	downloads?: GitHubReleaseDownloads,
): string {
	const notes =
		typeof changelog === "string"
			? changelog
			: `## 简体中文\n\n${changelog?.["zh-CN"] ?? "未提供更新日志。"}\n\n## English\n\n${changelog?.en ?? "No release notes provided."}\n`;
	if (!downloads) return notes;
	validateGitHubRepository(downloads.repository);
	if (!isValidReleaseVersion(downloads.version)) throw new Error("Invalid release version");
	const available = new Set(downloads.filenames);
	const platforms = [
		["Windows", "x64", "windows-x64.exe"],
		["Windows", "x64（baseline 兼容版）", "windows-x64-baseline.exe"],
		["Windows", "ARM64", "windows-arm64.exe"],
		["macOS", "Apple Silicon（ARM64）", "macos-arm64"],
		["macOS", "Intel（x64）", "macos-x64"],
		["Linux", "x64", "linux-x64"],
		["Linux", "x64（baseline 兼容版）", "linux-x64-baseline"],
		["Linux", "ARM64", "linux-arm64"],
	];
	// Repository identity is case-insensitive; one URL spelling keeps repair deterministic.
	const root = `https://github.com/${downloads.repository.toLowerCase()}/releases/download/v${downloads.version}`;
	const rows = platforms.flatMap(([system, architecture, suffix]) => {
		const name = `narrafork-${downloads.version}-${suffix}`;
		return available.has(name)
			? [`| ${system} | ${architecture} | [直接下载](${root}/${encodeURIComponent(name)}) |`]
			: [];
	});
	if (!rows.length) return notes;
	return `## 快速下载\n\n选择对应系统与处理器的完整程序，无需在下方资产列表中查找。补丁和元数据供自动更新使用，不必手动下载。\n\n| 系统 | 处理器 | 下载 |\n| --- | --- | --- |\n${rows.join("\n")}\n\n${notes}`;
}

/** Accept only exact supported layouts of the same changelog and verified download set. */
export function matchesGitHubReleaseBody(
	body: unknown,
	changelog?: string | Record<string, string>,
	downloads?: GitHubReleaseDownloads,
): boolean {
	if (typeof body !== "string" || Buffer.byteLength(body) > MAX_TEXT_BYTES) return false;
	const legacy =
		typeof changelog === "string"
			? changelog
			: `## English\n\n${changelog?.en ?? "No release notes provided."}\n\n## 简体中文\n\n${changelog?.["zh-CN"] ?? "未提供更新日志。"}\n`;
	return (
		body === legacy ||
		body === githubReleaseBody(changelog) ||
		(downloads !== undefined && body === githubReleaseBody(changelog, downloads))
	);
}

interface Asset {
	name: string;
	path: string;
	size: number;
	sha256: string;
}
interface RemoteAsset {
	name: string;
	size: number;
	state: string;
	digest?: string | null;
}
interface RemoteRelease {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	body: string;
	assets: RemoteAsset[];
}

export interface GitHubReleaseOptions {
	/** Exact target declaration; never inferred from the publisher checkout. */
	remoteFrontend?: import("../../shared/remote-access/application").RemoteFrontendCapability;
	distDir: string;
	version: string;
	repository?: string;
	/** Platform id → binary filename suffix, already filtered by --platform. */
	platformSuffixes: ReadonlyMap<string, string>;
	/** Fully resolved local tag commit (HEAD for an untagged dry-run). */
	commit: string;
	changelog?: string | Record<string, string>;
	dryRun?: boolean;
	/** CI opt-in; local publishing keeps its existing behavior. */
	preventStableLatestRollback?: boolean;
	/** New fork releases must not silently ship an upstream-default binary. */
	requireBuildRepository?: boolean;
	/** Recovery mode may verify an already-public release, never create/upload/publish one. */
	requireAlreadyPublished?: boolean;
	componentEvidence?: ComponentReleaseEvidence;
	signal?: AbortSignal;
	deadline?: number;
	run?: GhRunner;
}

async function fileIdentity(
	path: string,
	maximum: number,
): Promise<{ size: number; sha256: string; sha512: string }> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size === 0 || stat.size > maximum) {
		throw new Error(`Invalid asset size/type: ${path}`);
	}
	const sha256 = createHash("sha256");
	const sha512 = createHash("sha512");
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		size += chunk.length;
		if (size > maximum) throw new Error(`Asset exceeds size limit: ${path}`);
		sha256.update(chunk);
		sha512.update(chunk);
	}
	if (size !== stat.size) throw new Error(`Asset changed while reading: ${path}`);
	return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

async function readText(path: string, maximum = MAX_TEXT_BYTES): Promise<string> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size === 0 || stat.size > maximum) {
		throw new Error(`Invalid text asset size/type: ${path}`);
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		size += chunk.length;
		if (size > maximum) throw new Error(`Text asset exceeds size limit: ${path}`);
		chunks.push(chunk);
	}
	if (size !== stat.size) throw new Error(`Text asset changed while reading: ${path}`);
	return Buffer.concat(chunks, size).toString("utf8");
}

/** Bound directory traversal and reject malformed/orphaned patches for selected platforms only. */
async function discoverPatches(options: GitHubReleaseOptions): Promise<Map<string, string[]>> {
	const binaries = [...options.platformSuffixes.values()].map(
		(suffix) => `narrafork-${options.version}-${suffix}`,
	);
	const related = new Set<string>();
	let scanned = 0;
	for await (const entry of await opendir(options.distDir)) {
		if (++scanned > MAX_DIST_ENTRIES) throw new Error("Release dist entry limit exceeded");
		if (
			binaries.some(
				(binary) =>
					entry.name.startsWith(`${binary}.zstd-patch`) || entry.name.startsWith(`${binary}.from-`),
			) &&
			(entry.name.endsWith(".zstd-patch") || entry.name.endsWith(".zstd-patch.meta.json"))
		) {
			related.add(entry.name);
			if (related.size > MAX_PATCH_PAIRS * 2) throw new Error("Release patch pair limit exceeded");
		}
	}
	const patches = new Map<string, string[]>();
	let pairs = 0;
	for (const binary of binaries) {
		const names = new Set<string>();
		for (const filename of related) {
			if (!filename.startsWith(`${binary}.`)) continue;
			const name = filename.endsWith(".meta.json") ? filename.slice(0, -10) : filename;
			if (!parseReleasePatchName(binary, name))
				throw new Error(`Invalid patch filename: ${filename}`);
			if (!related.has(name) || !related.has(`${name}.meta.json`)) {
				throw new Error(`Unpaired patch asset: ${name}`);
			}
			names.add(name);
		}
		pairs += names.size;
		if (pairs > MAX_PATCH_PAIRS) throw new Error("Release patch pair limit exceeded");
		patches.set(binary, [...names].sort());
	}
	return patches;
}

async function stagePatch(
	options: GitHubReleaseOptions,
	directory: string,
	binary: BinaryMetadata,
	suffix: string,
	name: string,
): Promise<Asset[]> {
	const metadataName = `${name}.meta.json`;
	const raw = await readText(join(options.distDir, metadataName), MAX_METADATA_BYTES);
	const meta = validateReleasePatchMetadata(JSON.parse(raw), {
		...parseReleasePatchName(binary.name, name),
		toVersion: options.version,
		newFileSize: binary.size,
		newFileSha512: binary.sha512,
	});
	// A local base is optional: CI may provide only the final binary and patch pair.
	const basePath = join(options.distDir, `narrafork-${meta.fromVersion}-${suffix}`);
	try {
		await lstat(basePath);
		const base = await fileIdentity(basePath, MAX_BINARY_BYTES);
		if (base.size !== meta.oldFileSize || base.sha512 !== meta.oldFileSha512) {
			throw new Error(`Patch source identity mismatch: ${name}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const path = join(options.distDir, name);
	const original = await fileIdentity(path, MAX_RELEASE_PATCH_BYTES);
	if (original.size !== meta.patchSize) throw new Error(`Patch size mismatch: ${name}`);
	const staged = join(directory, name);
	await copyFile(path, staged);
	const identity = await fileIdentity(staged, MAX_RELEASE_PATCH_BYTES);
	if (identity.size !== original.size || identity.sha256 !== original.sha256) {
		throw new Error(`Patch changed while staging: ${name}`);
	}
	const metadataPath = join(directory, metadataName);
	await writeFile(metadataPath, raw);
	const sidecar = await fileIdentity(metadataPath, MAX_METADATA_BYTES);
	return [
		{ name, path: staged, size: identity.size, sha256: identity.sha256 },
		{ name: metadataName, path: metadataPath, size: sidecar.size, sha256: sidecar.sha256 },
	];
}

/** Snapshot only selected artifacts; dist and its aggregate build files stay untouched. */
async function stageAssets(options: GitHubReleaseOptions, directory: string): Promise<Asset[]> {
	if (options.platformSuffixes.size === 0 || options.platformSuffixes.size > 8) {
		throw new Error("No valid release platforms selected");
	}
	if (!isValidReleaseVersion(options.version)) {
		throw new Error("Invalid release version");
	}
	if (!/^[a-f0-9]{40}$/.test(options.commit)) throw new Error("Expected full tag commit SHA");
	const entries: BinaryMetadata[] = [];
	const assets: Asset[] = [];
	const patches = await discoverPatches(options);
	for (const [platform, suffix] of options.platformSuffixes) {
		if (
			!/^(linux-(x64(-baseline)?|arm64)|macos-(x64|arm64)|windows-(x64(-baseline)?|arm64)\.exe)$/.test(
				suffix,
			)
		) {
			throw new Error(`Invalid platform suffix: ${suffix}`);
		}
		const expectedSuffix =
			platform.replace(/^darwin-/, "macos-").replace(/^win-/, "windows-") +
			(platform.startsWith("win-") ? ".exe" : "");
		if (suffix !== expectedSuffix) throw new Error(`Platform/suffix mismatch: ${platform}`);
		const name = `narrafork-${options.version}-${suffix}`;
		const binaryPath = join(options.distDir, name);
		const metadataName = `${name}.metadata.json`;
		const raw = await readText(join(options.distDir, metadataName), MAX_METADATA_BYTES);
		const metadata = JSON.parse(raw) as BinaryMetadata;
		const expectedRepository = options.repository ?? DEFAULT_GITHUB_REPOSITORY;
		if (
			(metadata.repository !== undefined &&
				(!isValidGitHubRepository(metadata.repository) ||
					metadata.repository.toLowerCase() !== expectedRepository.toLowerCase())) ||
			(options.requireBuildRepository &&
				metadata.repository === undefined &&
				expectedRepository.toLowerCase() !== OFFICIAL_GITHUB_REPOSITORY.toLowerCase())
		)
			throw new Error(`Binary build repository does not match release target: ${metadataName}`);
		const target = `bun-${platform.replace(/^win-/, "windows-")}`;
		if (
			metadata.name !== name ||
			metadata.version !== options.version ||
			metadata.platform !== platform ||
			metadata.target !== target ||
			!metadata.commit ||
			!/^[a-f0-9]{7,40}$/.test(metadata.commit) ||
			!options.commit.startsWith(metadata.commit) ||
			!metadata.buildDate ||
			!Number.isFinite(Date.parse(metadata.buildDate)) ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size <= 0 ||
			!/^[a-f0-9]{64}$/.test(metadata.sha256) ||
			!/^[A-Za-z0-9+/]{86}==$/.test(metadata.sha512)
		)
			throw new Error(`Invalid binary metadata/provenance: ${metadataName}`);
		await fileIdentity(binaryPath, MAX_BINARY_BYTES);
		const staged = join(directory, name);
		await copyFile(binaryPath, staged);
		const identity = await fileIdentity(staged, MAX_BINARY_BYTES);
		if (
			identity.size !== metadata.size ||
			identity.sha256 !== metadata.sha256 ||
			identity.sha512 !== metadata.sha512
		) {
			throw new Error(`Binary size/hash mismatch: ${name}`);
		}
		await writeFile(join(directory, metadataName), raw);
		entries.push(metadata);
		assets.push({ name, path: staged, size: identity.size, sha256: identity.sha256 });
		const sidecar = await fileIdentity(join(directory, metadataName), MAX_TEXT_BYTES);
		assets.push({
			name: metadataName,
			path: join(directory, metadataName),
			size: sidecar.size,
			sha256: sidecar.sha256,
		});
		for (const patch of patches.get(name) ?? []) {
			assets.push(...(await stagePatch(options, directory, metadata, suffix, patch)));
		}
	}
	const sumsName = `narrafork-${options.version}-SHA256SUMS`;
	const reportName = `narrafork-${options.version}-checksums.txt`;
	const originalSums = await readText(join(options.distDir, sumsName));
	const originalReport = await readText(join(options.distDir, reportName));
	if (!originalReport.startsWith(`NarraFork v${options.version} — binary checksums\n`)) {
		throw new Error("Checksum report version mismatch");
	}
	const sumLines = originalSums.trimEnd().split("\n");
	for (const entry of entries) {
		if (
			sumLines.filter((line) => line.endsWith(`  ${entry.name}`)).length !== 1 ||
			!sumLines.includes(`${entry.sha256}  ${entry.name}`)
		) {
			throw new Error(`SHA256SUMS mismatch: ${entry.name}`);
		}
		const section = `${entry.name}\n  platform : ${entry.platform}\n  size     : ${entry.size} bytes\n  sha256   : ${entry.sha256}\n  sha512   : ${entry.sha512}`;
		if (!originalReport.includes(section))
			throw new Error(`Checksum report mismatch: ${entry.name}`);
	}
	for (const [name, content] of [
		[sumsName, formatSha256Sums(entries)],
		[reportName, formatChecksumsReport(options.version, entries)],
	]) {
		const path = join(directory, name);
		await writeFile(path, content);
		const identity = await fileIdentity(path, MAX_TEXT_BYTES);
		assets.push({ name, path, size: identity.size, sha256: identity.sha256 });
	}
	if (options.remoteFrontend) {
		const { verifyRemoteFrontendArtifact } = await import("./remote-frontend-artifact");
		const target = {
			repository: options.repository ?? DEFAULT_GITHUB_REPOSITORY,
			version: options.version,
			commit: options.commit,
			capability: options.remoteFrontend,
		};
		await verifyRemoteFrontendArtifact(options.distDir, target, options.signal);
		const names = remoteFrontendArtifactNames(options.version);
		for (const [name, maximum] of [
			[names.archive, REMOTE_FRONTEND_ARCHIVE_MAX_BYTES],
			[names.manifest, REMOTE_FRONTEND_MANIFEST_MAX_BYTES],
		] as const) {
			const path = join(directory, name);
			await copyReleaseFile(join(options.distDir, name), path, maximum, options.signal);
			const hash = await fileIdentity(path, maximum);
			assets.push({ name, path, size: hash.size, sha256: hash.sha256 });
		}
		await verifyRemoteFrontendArtifact(directory, target, options.signal);
	}
	if (assets.length > MAX_ASSETS) throw new Error("Release asset limit exceeded");
	return assets;
}

function parseRemoteRelease(output: string, tag: string, knownReleaseId?: number): RemoteRelease {
	const result = JSON.parse(output) as RemoteRelease;
	if (
		!result ||
		!Number.isSafeInteger(result.id) ||
		result.id <= 0 ||
		(knownReleaseId !== undefined && result.id !== knownReleaseId) ||
		result.tag_name !== tag ||
		typeof result.draft !== "boolean" ||
		typeof result.prerelease !== "boolean" ||
		!Array.isArray(result.assets) ||
		result.assets.length > MAX_ASSETS
	) {
		throw new Error("Invalid GitHub release response");
	}
	return result;
}

async function getRelease(
	run: GhRunner,
	repository: string,
	tag: string,
	knownReleaseId?: number,
): Promise<RemoteRelease | null> {
	let output: string;
	try {
		output = await run([
			"api",
			knownReleaseId === undefined
				? `repos/${repository}/releases/tags/${tag}`
				: `repos/${repository}/releases/${knownReleaseId}`,
		]);
	} catch (error) {
		// A pinned release disappearing must not become a new draft lookup.
		if (
			knownReleaseId !== undefined ||
			!(error instanceof Error) ||
			!/\bHTTP 404\b/.test(error.message)
		)
			throw error;
		// The tag endpoint is for published releases. Authenticated listing also sees drafts.
		let releaseId: number | undefined;
		for (let page = 1; page <= 10; page++) {
			const candidates = JSON.parse(
				await run([
					"api",
					`repos/${repository}/releases?per_page=100&page=${page}`,
					"--jq",
					"[.[] | {id, tag_name}]",
				]),
			) as { id: number; tag_name: string }[];
			if (
				!Array.isArray(candidates) ||
				candidates.length > 100 ||
				candidates.some(
					(candidate) =>
						!Number.isSafeInteger(candidate.id) ||
						candidate.id <= 0 ||
						typeof candidate.tag_name !== "string",
				)
			) {
				throw new Error("Invalid GitHub release listing");
			}
			const matches = candidates.filter((candidate) => candidate.tag_name === tag);
			if (matches.length > 1) throw new Error(`Duplicate GitHub releases for ${tag}`);
			if (matches.length === 1) {
				releaseId = matches[0].id;
				break;
			}
			if (candidates.length < 100) return null;
			if (page === 10)
				throw new Error("Release lookup page limit reached; cannot safely create a draft");
		}
		output = await run(["api", `repos/${repository}/releases/${releaseId}`]);
		knownReleaseId = releaseId;
	}
	return parseRemoteRelease(output, tag, knownReleaseId);
}

async function verifyRemoteTag(
	run: GhRunner,
	repository: string,
	tag: string,
	commit: string,
): Promise<void> {
	let object = (
		JSON.parse(await run(["api", `repos/${repository}/git/ref/tags/${tag}`])) as {
			object: { type: string; sha: string };
		}
	).object;
	for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
		if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Invalid remote tag object");
		object = (
			JSON.parse(await run(["api", `repos/${repository}/git/tags/${object.sha}`])) as {
				object: { type: string; sha: string };
			}
		).object;
	}
	if (object?.type !== "commit" || object.sha !== commit) {
		throw new Error(`GitHub tag ${tag} does not match local tag commit ${commit}`);
	}
}

async function verifyAsset(
	run: GhRunner,
	options: GitHubReleaseOptions,
	asset: Asset,
	remote: RemoteAsset,
	directory: string,
): Promise<void> {
	if (remote.size !== asset.size || remote.state !== "uploaded")
		throw new Error(`Remote asset size/state mismatch: ${asset.name}`);
	if (remote.digest) {
		if (remote.digest !== `sha256:${asset.sha256}`)
			throw new Error(`Remote asset hash mismatch: ${asset.name}`);
		return;
	}
	// Older GitHub assets may not expose digest. Download to a fresh path, then stream-hash.
	const path = join(directory, `verify-${asset.name}`);
	await run([
		"release",
		"download",
		`v${options.version}`,
		"--repo",
		options.repository ?? DEFAULT_GITHUB_REPOSITORY,
		"--pattern",
		asset.name,
		"--output",
		path,
	]);
	const identity = await fileIdentity(path, asset.size);
	if (identity.size !== asset.size || identity.sha256 !== asset.sha256)
		throw new Error(`Downloaded asset hash mismatch: ${asset.name}`);
	await rm(path);
}

/** Run immediately before draft creation and again before changing latest. */
async function assertStableLatestDoesNotRegress(
	run: GhRunner,
	repository: string,
	version: string,
): Promise<void> {
	for (let page = 1; page <= 10; page++) {
		const output = await run([
			"api",
			`repos/${repository}/releases?per_page=100&page=${page}`,
			"--jq",
			"[.[] | {tag_name, draft, prerelease}]",
		]);
		if (Buffer.byteLength(output) > GH_MAX_OUTPUT_BYTES)
			throw new Error("Release listing exceeds output limit");
		const releases = JSON.parse(output) as {
			tag_name: string;
			draft: boolean;
			prerelease: boolean;
		}[];
		if (
			!Array.isArray(releases) ||
			releases.length > 100 ||
			releases.some(
				(release) =>
					typeof release?.tag_name !== "string" ||
					typeof release.draft !== "boolean" ||
					typeof release.prerelease !== "boolean",
			)
		) {
			throw new Error("Invalid release listing for stable latest guard");
		}
		for (const release of releases) {
			const previous = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
			if (
				!release.draft &&
				!release.prerelease &&
				isValidReleaseVersion(previous) &&
				releaseChannel(previous) === "stable" &&
				compareReleaseVersions(previous, version) > 0
			) {
				throw new Error(`Refusing stable latest rollback from ${previous} to ${version}`);
			}
		}
		if (releases.length < 100) return;
	}
	throw new Error("Stable latest guard pagination limit reached");
}

/** Drafts remain on any failure; public releases are immutable and must match exactly. */
export async function publishGitHubRelease(
	options: GitHubReleaseOptions,
): Promise<{ dryRun: boolean; alreadyPublished: boolean; assets: string[] }> {
	const repository = options.repository ?? DEFAULT_GITHUB_REPOSITORY;
	validateGitHubRepository(repository);
	const baseRun = options.run ?? runGh;
	const checkBoundary = () => {
		options.signal?.throwIfAborted();
		if (options.deadline !== undefined && options.deadline <= Date.now())
			throw new Error("GitHub publication deadline exceeded");
	};
	const run: GhRunner = async (args, controls) => {
		checkBoundary();
		const result = await baseRun(args, controls);
		checkBoundary();
		return result;
	};
	const tag = `v${options.version}`;
	const downloads = {
		repository,
		version: options.version,
		filenames: [...options.platformSuffixes.values()].map(
			(suffix) => `narrafork-${options.version}-${suffix}`,
		),
	};
	const body = githubReleaseBody(options.changelog, downloads);
	if (Buffer.byteLength(body) > MAX_TEXT_BYTES) throw new Error("Release notes exceed size limit");
	let prerelease = releaseChannel(options.version) === "beta";
	const directory = await mkdtemp(join(tmpdir(), "narrafork-github-release-"));
	try {
		const assets = await stageAssets(options, directory);
		const names = assets.map((asset) => asset.name);
		const declarations: Array<HelperDistributionDependencies | undefined> = [];
		for (const asset of assets.filter((entry) => entry.name.endsWith(".metadata.json"))) {
			const sidecar = JSON.parse(await readFile(asset.path, "utf8"));
			declarations.push(
				sidecar.helperDistribution === undefined
					? undefined
					: parseHelperDistributionDependencies(sidecar.helperDistribution),
			);
		}
		const dependencies = declarations[0];
		if (declarations.some((entry) => JSON.stringify(entry) !== JSON.stringify(dependencies)))
			throw new Error("Inconsistent release helper dependencies across platforms");
		if (options.dryRun) return { dryRun: true, alreadyPublished: false, assets: names };
		let componentEvidence: ComponentReleaseEvidence | undefined;
		if (!options.requireAlreadyPublished) {
			const { verifyComponentReleaseEvidence } = await import("./component-release-inputs");
			const evidence = await verifyComponentReleaseEvidence({
				repository,
				targetCommit: options.commit,
				dependencies,
				evidence: options.componentEvidence,
				// Native source reads use their own asynchronous bounded 30s transport.
				run: options.run,
				signal: options.signal,
				deadline: options.deadline,
			});
			componentEvidence = evidence;
			if (!evidence && dependencies) {
				// Historical source without a component configuration retains its original path.
				parseHelperDistributionDependencies(dependencies, options.version);
				const { verifyPublishedHelperDependencies } = await import("./helper-release");
				await verifyPublishedHelperDependencies({
					repository,
					helpersTag: dependencies.helpers.tag,
					executorVersion: dependencies.executor.version,
					protocolVersion: dependencies.executor.protocolVersion,
					run,
					signal: options.signal,
				});
			}
		}
		// Require an explicitly pushed tag rather than silently using GitHub's default branch.
		await verifyRemoteTag(run, repository, tag, options.commit);
		let release = await getRelease(run, repository, tag);
		if (options.requireAlreadyPublished && (!release || release.draft))
			throw new Error("Index repair requires an already-public release");
		// Read-only repair follows an explicit remote promotion, but freezes that
		// announcement state for all subsequent checks and never mutates assets.
		if (options.requireAlreadyPublished && release) prerelease = release.prerelease;
		if (options.preventStableLatestRollback && !prerelease && (!release || release.draft)) {
			await assertStableLatestDoesNotRegress(run, repository, options.version);
		}
		if (!release) {
			// Creation returns the authoritative ID; a just-created draft may not
			// yet appear in tag/list lookups. Never re-create or guess its identity.
			// Existing tag SHA is checked before creation and before publication;
			// omit target_commitish, which can require extra workflows:write access.
			const requestPath = join(directory, "create-release.json");
			await writeFile(
				requestPath,
				JSON.stringify({ tag_name: tag, name: `NarraFork ${tag}`, body, draft: true, prerelease }),
			);
			release = parseRemoteRelease(
				await run([
					"api",
					`repos/${repository}/releases`,
					"--method",
					"POST",
					"--input",
					requestPath,
				]),
				tag,
			);
			if (!release.draft) throw new Error("Expected a newly created draft release");
		}
		if (
			release.prerelease !== prerelease ||
			!matchesGitHubReleaseBody(release.body, options.changelog, downloads)
		)
			throw new Error("Existing release channel/notes mismatch");
		// Layout compatibility never allows notes to change during this publication.
		const verifiedBody = release.body;
		const alreadyPublished = !release.draft;
		const existing = new Map<string, RemoteAsset>();
		for (const remote of release.assets) {
			if (!names.includes(remote.name) || existing.has(remote.name))
				throw new Error(`Unexpected/duplicate remote asset: ${remote.name}`);
			existing.set(remote.name, remote);
		}
		for (const asset of assets) {
			const remote = existing.get(asset.name);
			if (remote) await verifyAsset(run, options, asset, remote, directory);
			else {
				if (alreadyPublished) throw new Error(`Published release is missing asset: ${asset.name}`);
				await run(["release", "upload", tag, asset.path, "--repo", repository]);
			}
		}
		release = await getRelease(run, repository, tag, release.id);
		if (
			!release ||
			release.draft === alreadyPublished ||
			release.prerelease !== prerelease ||
			release.body !== verifiedBody ||
			release.assets.length !== assets.length
		)
			throw new Error("Release changed or assets incomplete during verification");
		for (const asset of assets) {
			const matches = release.assets.filter((remote) => remote.name === asset.name);
			if (matches.length !== 1) throw new Error(`Missing/duplicate remote asset: ${asset.name}`);
			await verifyAsset(run, options, asset, matches[0], directory);
		}
		await verifyRemoteTag(run, repository, tag, options.commit);
		if (!alreadyPublished) {
			// Uploads can take minutes. Recheck the frozen component identities before public promotion.
			if (componentEvidence) {
				const { verifyComponentReleaseEvidence } = await import("./component-release-inputs");
				await verifyComponentReleaseEvidence({
					repository,
					targetCommit: options.commit,
					dependencies,
					evidence: componentEvidence,
					run: options.run,
					signal: options.signal,
					deadline: options.deadline,
				});
			}
			options.signal?.throwIfAborted();
			if (componentEvidence) await verifyRemoteTag(run, repository, tag, options.commit);
			if (options.preventStableLatestRollback && !prerelease) {
				await assertStableLatestDoesNotRegress(run, repository, options.version);
			}
			await run([
				"release",
				"edit",
				tag,
				"--repo",
				repository,
				"--draft=false",
				`--latest=${!prerelease}`,
			]);
			const published = await getRelease(run, repository, tag, release.id);
			if (
				!published ||
				published.draft ||
				published.prerelease !== prerelease ||
				published.body !== verifiedBody ||
				published.assets.length !== assets.length
			)
				throw new Error("GitHub did not confirm publication");
		}
		return { dryRun: false, alreadyPublished, assets: names };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
