import { lstat, mkdir, mkdtemp, opendir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { applyZstdPatchToFile, generateZstdPatchToFile } from "../../server/lib/zstd-patch";
import {
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import { compareReleaseVersions } from "../../shared/release-version";
import { type BinaryMetadata, formatChecksumsReport, formatSha256Sums } from "./binary-metadata";
import {
	CI_BUNDLE_LIMIT,
	CI_DISK_RESERVE,
	CI_METADATA_LIMIT,
	CI_TEXT_LIMIT,
	copyReleaseFile,
	downloadReleaseAsset,
	hashReleaseFile,
	type ReleaseAssetDownloader,
	readReleaseText,
} from "./ci-release-io";
import { validateCiReleasePlan } from "./ci-release-plan";
import {
	CI_RELEASE_TARGETS,
	type CiReleaseBaseline,
	type CiReleaseManifest,
	type CiReleasePlan,
	type CiReleaseSmokeResult,
} from "./ci-release-types";
import { publishGitHubRelease } from "./github-release";
import { validateBaselineMetadata } from "./github-release-baseline";

const hash256 = z.string().regex(/^[a-f0-9]{64}$/);
const hash512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const sizeSchema = z.number().int().positive().max(MAX_RELEASE_BINARY_BYTES);
const smokeSchema = z
	.object({
		schemaVersion: z.literal(1),
		target: z.string(),
		commit: z.string().regex(/^[a-f0-9]{40}$/),
		version: z.string(),
		sha256: hash256,
		sha512: hash512,
		size: sizeSchema,
		checks: z
			.object({
				startup: z.literal(true),
				frontend: z.literal(true),
				database: z.literal(true),
				watcher: z.literal(true),
				pty: z.literal(true),
				signature: z.boolean(),
			})
			.strict(),
	})
	.strict();
const manifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		plan: z.unknown(),
		files: z
			.array(
				z
					.object({
						name: z
							.string()
							.min(1)
							.max(255)
							.regex(/^[A-Za-z0-9.+_-]+$/),
						size: sizeSchema,
						sha256: hash256,
						sha512: hash512,
					})
					.strict(),
			)
			.min(18)
			.max(50),
		smoke: z.array(smokeSchema).length(8),
	})
	.strict();

export interface AssembleReleaseBundleOptions {
	plan: CiReleasePlan;
	platformsDir: string;
	smokeDir: string;
	bundleDir: string;
	signal?: AbortSignal;
	/** Fixture injection only; defaults use bounded gh and actual file-to-file zstd. */
	dependencies?: {
		downloadAsset?: ReleaseAssetDownloader;
		generatePatch?: typeof generateZstdPatchToFile;
		applyPatch?: typeof applyZstdPatchToFile;
	};
}

async function directoryEntries(path: string, maximum = 200): Promise<string[]> {
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`Invalid release directory type: ${path}`);
	const names: string[] = [];
	for await (const entry of await opendir(path)) {
		if (names.length >= maximum) throw new Error(`Release directory entry limit exceeded: ${path}`);
		names.push(entry.name);
	}
	return names.sort();
}

function assertSameNames(actual: string[], expected: string[], context: string): void {
	if (!isDeepStrictEqual([...actual].sort(), [...expected].sort()))
		throw new Error(`Missing/extra/duplicate ${context}`);
}

function assertIdentity(
	actual: { size: number; sha256: string; sha512: string },
	expected: { size: number; sha256: string; sha512: string },
	context: string,
): void {
	if (
		actual.size !== expected.size ||
		actual.sha256 !== expected.sha256 ||
		actual.sha512 !== expected.sha512
	)
		throw new Error(`Release size/hash mismatch: ${context}`);
}

function validateBaselines(plan: CiReleasePlan): void {
	if (plan.baselines.length > 16) throw new Error("Baseline count limit exceeded");
	const seen = new Set<string>();
	const counts = new Map<string, number>();
	for (const baseline of plan.baselines) {
		const target = CI_RELEASE_TARGETS.find((entry) => entry.platform === baseline.platform);
		if (!target || compareReleaseVersions(baseline.version, plan.version) >= 0)
			throw new Error("Invalid baseline version/platform");
		const key = `${baseline.platform}:${baseline.version}`;
		const count = (counts.get(baseline.platform) ?? 0) + 1;
		if (seen.has(key) || count > (plan.channel === "stable" ? 2 : 1))
			throw new Error("Duplicate/excess baseline");
		seen.add(key);
		counts.set(baseline.platform, count);
		const name = `narrafork-${baseline.version}-${target.suffix}`;
		if (
			!Number.isSafeInteger(baseline.releaseId) ||
			baseline.releaseId <= 0 ||
			!Number.isSafeInteger(baseline.binaryAsset.id) ||
			baseline.binaryAsset.id <= 0 ||
			!Number.isSafeInteger(baseline.metadataAsset.id) ||
			baseline.metadataAsset.id <= 0 ||
			baseline.binaryAsset.id === baseline.metadataAsset.id ||
			baseline.binaryAsset.name !== name ||
			baseline.metadataAsset.name !== `${name}.metadata.json` ||
			!Number.isSafeInteger(baseline.metadataAsset.size) ||
			baseline.metadataAsset.size <= 0 ||
			baseline.metadataAsset.size > CI_METADATA_LIMIT ||
			!/^[a-f0-9]{64}$/.test(baseline.metadataSha256)
		)
			throw new Error("Invalid baseline asset identity");
		validateBaselineMetadata(baseline.metadata, {
			version: baseline.version,
			platform: baseline.platform,
			name,
			size: baseline.binaryAsset.size,
		});
	}
}

function validateSmoke(
	value: unknown,
	plan: CiReleasePlan,
	target: (typeof CI_RELEASE_TARGETS)[number],
	binary: BinaryMetadata,
): CiReleaseSmokeResult {
	const smoke = smokeSchema.parse(value);
	if (
		smoke.target !== target.target ||
		smoke.commit !== plan.commit ||
		smoke.version !== plan.version ||
		(target.target.startsWith("darwin-") && smoke.checks.signature !== true)
	)
		throw new Error(`Smoke identity/signature mismatch: ${target.target}`);
	assertIdentity(smoke, binary, `smoke ${target.target}`);
	return smoke;
}

async function readBinary(
	directory: string,
	plan: CiReleasePlan,
	target: (typeof CI_RELEASE_TARGETS)[number],
	signal?: AbortSignal,
): Promise<BinaryMetadata> {
	const name = `narrafork-${plan.version}-${target.suffix}`;
	const raw = await readReleaseText(join(directory, `${name}.metadata.json`), CI_METADATA_LIMIT);
	const identity = await hashReleaseFile(join(directory, name), MAX_RELEASE_BINARY_BYTES, signal);
	const metadata = validateBaselineMetadata(JSON.parse(raw), {
		version: plan.version,
		platform: target.platform,
		name,
		size: identity.size,
		commit: plan.commit,
	});
	assertIdentity(identity, metadata, name);
	return metadata;
}

function patchName(plan: CiReleasePlan, baseline: CiReleaseBaseline): string {
	const target = CI_RELEASE_TARGETS.find((entry) => entry.platform === baseline.platform);
	if (!target) throw new Error("Invalid baseline platform");
	return `narrafork-${plan.version}-${target.suffix}.from-${baseline.version}.zstd-patch`;
}

function assetLimit(name: string): number {
	if (name.endsWith(".metadata.json") || name.endsWith(".meta.json")) return CI_METADATA_LIMIT;
	if (name.endsWith(".zstd-patch")) return MAX_RELEASE_PATCH_BYTES;
	if (name.endsWith("-SHA256SUMS") || name.endsWith("-checksums.txt")) return CI_TEXT_LIMIT;
	return MAX_RELEASE_BINARY_BYTES;
}

/** Validation does not execute binaries, download bases, regenerate checksums or repair a bundle. */
export async function verifyReleaseBundle(
	bundleDir: string,
	expectedPlan?: CiReleasePlan,
): Promise<CiReleaseManifest> {
	return verifyBundle(bundleDir, expectedPlan, AbortSignal.timeout(30 * 60 * 1000));
}

async function verifyBundle(
	bundleDir: string,
	expectedPlan: CiReleasePlan | undefined,
	signal: AbortSignal,
): Promise<CiReleaseManifest> {
	signal.throwIfAborted();
	assertSameNames(
		await directoryEntries(bundleDir, 3),
		["dist", "manifest.json"],
		"bundle root entries",
	);
	const parsed = manifestSchema.parse(
		JSON.parse(await readReleaseText(join(bundleDir, "manifest.json"))),
	);
	const plan = validateCiReleasePlan(parsed.plan);
	validateBaselines(plan);
	if (expectedPlan) {
		const expected = validateCiReleasePlan(expectedPlan);
		for (const key of [
			"repository",
			"tag",
			"version",
			"commit",
			"channel",
			"changelog",
			"bunVersion",
			"workflowCommit",
			"runId",
			"runAttempt",
			"baselines",
		] as const) {
			if (!isDeepStrictEqual(plan[key], expected[key]))
				throw new Error(`Bundle expected target identity mismatch: ${key}`);
		}
	}
	const dist = join(bundleDir, "dist");
	const names = await directoryEntries(dist, 51);
	const listedNames = parsed.files.map((file) => file.name);
	if (new Set(listedNames).size !== listedNames.length)
		throw new Error("Duplicate manifest filenames");
	assertSameNames(names, listedNames, "bundle assets");
	let total = 0;
	for (const file of parsed.files) {
		total += file.size;
		if (total > CI_BUNDLE_LIMIT) throw new Error("Bundle byte limit exceeded");
		assertIdentity(
			await hashReleaseFile(join(dist, file.name), assetLimit(file.name), signal),
			file,
			file.name,
		);
	}
	const allowed = new Set<string>();
	const binaries: BinaryMetadata[] = [];
	const smoke: CiReleaseSmokeResult[] = [];
	assertSameNames(
		parsed.smoke.map((entry) => entry.target),
		CI_RELEASE_TARGETS.map((entry) => entry.target),
		"smoke platforms",
	);
	for (const target of CI_RELEASE_TARGETS) {
		const binary = await readBinary(dist, plan, target, signal);
		binaries.push(binary);
		allowed.add(binary.name);
		allowed.add(`${binary.name}.metadata.json`);
		smoke.push(
			validateSmoke(
				parsed.smoke.find((entry) => entry.target === target.target),
				plan,
				target,
				binary,
			),
		);
	}
	const sums = `narrafork-${plan.version}-SHA256SUMS`;
	const report = `narrafork-${plan.version}-checksums.txt`;
	allowed.add(sums);
	allowed.add(report);
	if (
		(await readReleaseText(join(dist, sums))) !== formatSha256Sums(binaries) ||
		(await readReleaseText(join(dist, report))) !== formatChecksumsReport(plan.version, binaries)
	)
		throw new Error("Unified checksum content mismatch");
	for (const baseline of plan.baselines) {
		const name = patchName(plan, baseline);
		const metadataName = `${name}.meta.json`;
		if (!names.includes(name) && !names.includes(metadataName)) continue;
		if (!names.includes(name) || !names.includes(metadataName))
			throw new Error("Unpaired bundle patch");
		const binary = binaries.find((entry) => entry.platform === baseline.platform);
		const patch = parsed.files.find((entry) => entry.name === name);
		if (!binary || !patch) throw new Error("Patch platform missing");
		const meta = validateReleasePatchMetadata(
			JSON.parse(await readReleaseText(join(dist, metadataName), CI_METADATA_LIMIT)),
			{
				fromVersion: baseline.version,
				toVersion: plan.version,
				patchSize: patch.size,
				newFileSize: binary.size,
				newFileSha512: binary.sha512,
			},
		);
		if (
			meta.mode !== "patch-from" ||
			meta.oldFileSize !== baseline.metadata.size ||
			meta.oldFileSha512 !== baseline.metadata.sha512 ||
			patch.size >= binary.size
		)
			throw new Error("Patch baseline identity/size mismatch");
		allowed.add(name);
		allowed.add(metadataName);
	}
	assertSameNames(names, [...allowed], "allowed release assets");
	signal.throwIfAborted();
	// Publisher dryRun snapshots assets into the system temporary filesystem.
	const disk = await statfs(tmpdir());
	if (disk.bavail * disk.bsize < total + CI_DISK_RESERVE)
		throw new Error("Insufficient disk space for publisher verification and 4 GiB reserve");
	const sealed = await publishGitHubRelease({
		distDir: dist,
		version: plan.version,
		repository: plan.repository,
		commit: plan.commit,
		platformSuffixes: new Map(CI_RELEASE_TARGETS.map((entry) => [entry.platform, entry.suffix])),
		dryRun: true,
	});
	signal.throwIfAborted();
	assertSameNames(sealed.assets, names, "publisher dry-run assets");
	return { schemaVersion: 1, plan, files: parsed.files, smoke };
}

async function addPatch(
	options: AssembleReleaseBundleOptions,
	baseline: CiReleaseBaseline,
	binaries: BinaryMetadata[],
	dist: string,
	temporary: string,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const download = options.dependencies?.downloadAsset ?? downloadReleaseAsset;
	const generate = options.dependencies?.generatePatch ?? generateZstdPatchToFile;
	const apply = options.dependencies?.applyPatch ?? applyZstdPatchToFile;
	const binary = binaries.find((entry) => entry.platform === baseline.platform);
	if (!binary) throw new Error("Baseline platform missing");
	const workspace = await mkdtemp(join(temporary, "baseline-"));
	try {
		const oldFilePath = join(workspace, "base");
		const sidecarPath = join(workspace, "metadata.json");
		await download({
			repository: options.plan.repository,
			assetId: baseline.metadataAsset.id,
			size: baseline.metadataAsset.size,
			outputPath: sidecarPath,
			signal,
		});
		const sidecar = await hashReleaseFile(sidecarPath, CI_METADATA_LIMIT, signal);
		if (
			sidecar.size !== baseline.metadataAsset.size ||
			sidecar.sha256 !== baseline.metadataSha256 ||
			!isDeepStrictEqual(
				JSON.parse(await readReleaseText(sidecarPath, CI_METADATA_LIMIT)),
				baseline.metadata,
			)
		)
			throw new Error("Baseline sidecar identity mismatch");
		await download({
			repository: options.plan.repository,
			assetId: baseline.binaryAsset.id,
			size: baseline.binaryAsset.size,
			outputPath: oldFilePath,
			signal,
		});
		assertIdentity(
			await hashReleaseFile(oldFilePath, MAX_RELEASE_BINARY_BYTES, signal),
			baseline.metadata,
			"baseline binary",
		);
		const name = patchName(options.plan, baseline);
		const patchPath = join(workspace, name);
		const meta = await generate({
			oldFilePath,
			newFilePath: join(dist, binary.name),
			patchOutputPath: patchPath,
			fromVersion: baseline.version,
			toVersion: options.plan.version,
			timeoutMs: 15 * 60 * 1000,
			signal,
		});
		const generated = await hashReleaseFile(
			patchPath,
			MAX_RELEASE_BINARY_BYTES + CI_TEXT_LIMIT,
			signal,
		);
		if (
			meta.mode !== "patch-from" ||
			meta.fromVersion !== baseline.version ||
			meta.toVersion !== options.plan.version ||
			meta.oldFileSize !== baseline.metadata.size ||
			meta.oldFileSha512 !== baseline.metadata.sha512 ||
			meta.newFileSize !== binary.size ||
			meta.newFileSha512 !== binary.sha512 ||
			meta.patchSize !== generated.size
		)
			throw new Error("Generated patch identity mismatch");
		const restoredPath = join(workspace, "restored");
		await apply({
			oldFilePath,
			patchFilePath: patchPath,
			outputFilePath: restoredPath,
			meta,
			maxOutputBytes: binary.size,
			timeoutMs: 15 * 60 * 1000,
			signal,
		});
		assertIdentity(
			await hashReleaseFile(restoredPath, binary.size, signal),
			binary,
			"restored patch",
		);
		if (generated.size >= binary.size) {
			console.info(`Omitting patch ${name}: not smaller than full binary`);
			return;
		}
		validateReleasePatchMetadata(meta);
		await copyReleaseFile(patchPath, join(dist, name), MAX_RELEASE_PATCH_BYTES, signal);
		await writeFile(join(dist, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, {
			flag: "wx",
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

/** Produces an all-eight-platform bundle atomically; never reuses an existing output. */
export async function assembleReleaseBundle(
	options: AssembleReleaseBundleOptions,
): Promise<CiReleaseManifest> {
	const plan = validateCiReleasePlan(options.plan);
	validateBaselines(plan);
	const signal = AbortSignal.any([
		AbortSignal.timeout(120 * 60 * 1000),
		...(options.signal ? [options.signal] : []),
	]);
	signal.throwIfAborted();
	const bundleDir = resolve(options.bundleDir);
	const parent = dirname(bundleDir);
	await directoryEntries(parent, 4096);
	try {
		await lstat(bundleDir);
		throw new Error("Bundle destination already exists; use verification for recovery");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	assertSameNames(
		await directoryEntries(options.platformsDir, 9),
		CI_RELEASE_TARGETS.map((entry) => entry.target),
		"build platforms",
	);
	assertSameNames(
		await directoryEntries(options.smokeDir, 9),
		CI_RELEASE_TARGETS.map((entry) => entry.target),
		"smoke platforms",
	);
	const binaries: BinaryMetadata[] = [];
	const smoke: CiReleaseSmokeResult[] = [];
	for (const target of CI_RELEASE_TARGETS) {
		signal.throwIfAborted();
		const directory = join(options.platformsDir, target.target);
		// Diagnostics may coexist, but only these explicit artifact names are ever consumed.
		await directoryEntries(directory, 32);
		await directoryEntries(join(options.smokeDir, target.target), 32);
		const binary = await readBinary(directory, plan, target, signal);
		binaries.push(binary);
		smoke.push(
			validateSmoke(
				JSON.parse(
					await readReleaseText(
						join(options.smokeDir, target.target, "smoke.json"),
						CI_METADATA_LIMIT,
					),
				),
				plan,
				target,
				binary,
			),
		);
	}
	const fullBytes = binaries.reduce((sum, entry) => sum + entry.size, 0);
	const maxBase = Math.max(0, ...plan.baselines.map((entry) => entry.metadata.size));
	const maxFull = Math.max(...binaries.map((entry) => entry.size));
	const patchBudget = plan.baselines.reduce((sum, baseline) => {
		const binary = binaries.find((entry) => entry.platform === baseline.platform);
		if (!binary) throw new Error("Missing baseline platform");
		return sum + Math.min(MAX_RELEASE_PATCH_BYTES, binary.size);
	}, 0);
	const outputBudget = fullBytes + patchBudget + CI_TEXT_LIMIT * 4;
	// Account for both generation scratch and the publisher's second complete snapshot.
	const required =
		Math.max(outputBudget * 2, outputBudget + maxBase + maxFull * 2) + CI_DISK_RESERVE;
	const disk = await statfs(parent);
	if (disk.bavail * disk.bsize < required)
		throw new Error("Insufficient disk space for bundle and 4 GiB reserve");
	const staging = await mkdtemp(join(parent, ".ci-release-bundle-"));
	try {
		const dist = join(staging, "dist");
		await mkdir(dist);
		for (const target of CI_RELEASE_TARGETS) {
			const binary = binaries.find((entry) => entry.platform === target.platform);
			if (!binary) throw new Error("Missing platform binary");
			await copyReleaseFile(
				join(options.platformsDir, target.target, binary.name),
				join(dist, binary.name),
				MAX_RELEASE_BINARY_BYTES,
				signal,
			);
			// Preserve exact sidecar bytes; provenance hashes must not depend on reserialization.
			await copyReleaseFile(
				join(options.platformsDir, target.target, `${binary.name}.metadata.json`),
				join(dist, `${binary.name}.metadata.json`),
				CI_METADATA_LIMIT,
				signal,
			);
			assertIdentity(
				await hashReleaseFile(join(dist, binary.name), MAX_RELEASE_BINARY_BYTES, signal),
				binary,
				binary.name,
			);
		}
		await writeFile(
			join(dist, `narrafork-${plan.version}-SHA256SUMS`),
			formatSha256Sums(binaries),
			{ flag: "wx" },
		);
		await writeFile(
			join(dist, `narrafork-${plan.version}-checksums.txt`),
			formatChecksumsReport(plan.version, binaries),
			{ flag: "wx" },
		);
		for (const baseline of plan.baselines)
			await addPatch(options, baseline, binaries, dist, staging, signal);
		const files = [];
		for (const name of await directoryEntries(dist, 51))
			files.push({ name, ...(await hashReleaseFile(join(dist, name), assetLimit(name), signal)) });
		const manifest: CiReleaseManifest = { schemaVersion: 1, plan, files, smoke };
		await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
			flag: "wx",
		});
		const verified = await verifyBundle(staging, plan, signal);
		signal.throwIfAborted();
		await rename(staging, bundleDir);
		return verified;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
