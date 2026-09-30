/**
 * Direct previous-stable → target upgrade paths.
 *
 * The build only ever produces one patch: from the immediately preceding release. That is
 * correct for beta users, who follow every version, but a stable user sitting on the last
 * stable release would otherwise have to replay the whole beta patch chain in between. So
 * whenever a version becomes stable — published directly as stable, or promoted later — we
 * additionally generate and upload a patch whose base is the previous *stable* release.
 *
 * This module owns baseline selection (pure, testable) and the generate + upload pipeline.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareReleaseVersions,
	getBaselineMismatch,
	type PublishedFileIdentity,
} from "../../server/lib/release-baseline";
import { generateZstdPatchToFile } from "../../server/lib/zstd-patch";

/** Update-server platform id → dist filename suffix. */
export const RELEASE_PLATFORM_SUFFIXES: Record<string, string> = {
	"linux-x64": "linux-x64",
	"linux-x64-baseline": "linux-x64-baseline",
	"linux-arm64": "linux-arm64",
	"darwin-arm64": "macos-arm64",
	"darwin-x64": "macos-x64",
	"win-x64": "windows-x64.exe",
	"win-x64-baseline": "windows-x64-baseline.exe",
	"win-arm64": "windows-arm64.exe",
};

/**
 * Resolve the platform suffixes to operate on. `platformArg` uses build-script naming
 * ("windows-x64"), matched against the suffix with and without the `.exe` extension.
 */
export function resolvePlatformSuffixes(platformArg?: string): Map<string, string> {
	const entries = Object.entries(RELEASE_PLATFORM_SUFFIXES).filter(([, suffix]) => {
		if (!platformArg) return true;
		return suffix === platformArg || suffix.replace(/\.exe$/, "") === platformArg;
	});
	return new Map(entries);
}

export interface ReleaseChannelInfo {
	version: string;
	channel: string;
	platforms?: readonly string[];
}

export interface StableBaselineSelection {
	version: string;
}

/**
 * Highest stable release strictly below the target that also ships the given platform.
 *
 * The target itself is skipped, which matters for promotion: by the time the patch is
 * generated the target may already be marked stable in the release list.
 *
 * A release whose version cannot be parsed is dropped, since it can never be a trustworthy
 * patch base — but it is reported through `onUnparseable` rather than swallowed, because
 * "no direct patch was produced" and "the release list contains something unexpected" are
 * different problems and only the second one is a bug worth chasing.
 */
export function selectPreviousStableRelease(
	targetVersion: string,
	releases: readonly ReleaseChannelInfo[],
	platform?: string,
	onUnparseable?: (version: string, error: unknown) => void,
): StableBaselineSelection | null {
	const candidates = releases.filter((release) => {
		if (release.channel !== "stable") return false;
		if (release.version === targetVersion) return false;
		if (platform && release.platforms && !release.platforms.includes(platform)) return false;
		try {
			return compareReleaseVersions(release.version, targetVersion) < 0;
		} catch (error) {
			onUnparseable?.(release.version, error);
			return false;
		}
	});
	if (candidates.length === 0) return null;
	// Safe to compare without guarding: every candidate parsed above, and so did the target.
	candidates.sort((left, right) => compareReleaseVersions(right.version, left.version));
	return { version: candidates[0].version };
}

/**
 * Decide whether a direct previous-stable patch is still needed.
 *
 * It is redundant when the release already exposes that base (the ordinary build patch
 * happens to come from the previous stable release, or a previous run already uploaded it).
 */
export function needsStableBaselinePatch(
	baselineVersion: string,
	existingPatchFromVersions: readonly string[],
): boolean {
	return !existingPatchFromVersions.includes(baselineVersion);
}

export interface PlatformPatchPlan {
	platform: string;
	/** dist filename of the target binary. */
	targetFilename: string;
	/** dist filename of the published baseline binary. */
	baselineFilename: string;
	baselineVersion: string;
}

export interface PlatformPatchSkip {
	platform: string;
	reason: string;
}

export interface StableBaselinePlan {
	plans: PlatformPatchPlan[];
	skips: PlatformPatchSkip[];
}

export interface PlanStableBaselineInput {
	targetVersion: string;
	/** Platform id → dist filename suffix ("windows-x64.exe"). */
	platformSuffixes: ReadonlyMap<string, string>;
	/** Previous stable version per platform; absent means no stable predecessor. */
	baselineVersions: ReadonlyMap<string, string>;
	/** Patch bases already published for the target, per platform. */
	existingPatchFromVersions: ReadonlyMap<string, readonly string[]>;
	/** Filenames present in dist. */
	availableFilenames: readonly string[];
}

/** Pure planner: decides which platforms need a patch and which cannot get one. */
export function planStableBaselinePatches(input: PlanStableBaselineInput): StableBaselinePlan {
	const plans: PlatformPatchPlan[] = [];
	const skips: PlatformPatchSkip[] = [];
	const available = new Set(input.availableFilenames);

	for (const [platform, suffix] of input.platformSuffixes) {
		const baselineVersion = input.baselineVersions.get(platform);
		if (!baselineVersion) {
			skips.push({ platform, reason: "no previous stable release for this platform" });
			continue;
		}
		if (
			!needsStableBaselinePatch(
				baselineVersion,
				input.existingPatchFromVersions.get(platform) ?? [],
			)
		) {
			continue;
		}

		const targetFilename = `narrafork-${input.targetVersion}-${suffix}`;
		const baselineFilename = `narrafork-${baselineVersion}-${suffix}`;
		const missing = [targetFilename, baselineFilename].filter((name) => !available.has(name));
		if (missing.length > 0) {
			skips.push({
				platform,
				reason: `missing local binaries: ${missing.join(", ")}`,
			});
			continue;
		}

		plans.push({ platform, targetFilename, baselineFilename, baselineVersion });
	}

	return { plans, skips };
}

export interface UpdateServerClient {
	serverUrl: string;
	token: string;
	product: string;
}

interface PublishedReleaseMetadata {
	version: string;
	platforms: Record<
		string,
		PublishedFileIdentity & { zstdPatchFromVersion?: string; zstdPatchFromVersions?: string[] }
	>;
}

export async function fetchReleaseList(
	client: UpdateServerClient,
): Promise<ReleaseChannelInfo[] | null> {
	const response = await fetch(`${client.serverUrl}/api/v2/products/${client.product}/releases`, {
		headers: { Authorization: `Bearer ${client.token}` },
	});
	if (!response.ok) return null;
	const data = (await response.json()) as { releases?: ReleaseChannelInfo[] };
	return data.releases ?? null;
}

export async function fetchReleaseMetadata(
	client: UpdateServerClient,
	version: string,
): Promise<PublishedReleaseMetadata | null> {
	const response = await fetch(
		`${client.serverUrl}/api/v2/products/${client.product}/releases/${version}/metadata`,
	);
	if (response.status === 404) return null;
	if (!response.ok) return null;
	return (await response.json()) as PublishedReleaseMetadata;
}

export interface StableBaselinePatchResult {
	uploaded: PlatformPatchPlan[];
	skipped: PlatformPatchSkip[];
	failed: PlatformPatchSkip[];
}

export interface EnsureStableBaselinePatchesOptions {
	client: UpdateServerClient;
	targetVersion: string;
	/** Channel recorded on the upload; the target is stable by definition here. */
	channel?: "stable" | "beta";
	distDir: string;
	/** Platform id → dist filename suffix. */
	platformSuffixes: ReadonlyMap<string, string>;
	availableFilenames: readonly string[];
	log?: (message: string) => void;
}

/**
 * Generate and upload direct previous-stable → target patches for every platform that needs one.
 *
 * Never throws for per-platform problems: callers treat a missing patch as a warning, since the
 * multi-step chain still works. Returns what happened so the caller can report it.
 */
export async function ensureStableBaselinePatches(
	options: EnsureStableBaselinePatchesOptions,
): Promise<StableBaselinePatchResult> {
	const log = options.log ?? (() => {});
	const result: StableBaselinePatchResult = { uploaded: [], skipped: [], failed: [] };

	const releases = await fetchReleaseList(options.client);
	if (!releases) {
		result.failed.push({ platform: "*", reason: "failed to list published releases" });
		return result;
	}

	const targetMetadata = await fetchReleaseMetadata(options.client, options.targetVersion);
	if (!targetMetadata) {
		result.failed.push({
			platform: "*",
			reason: `published metadata for v${options.targetVersion} is unavailable`,
		});
		return result;
	}

	const baselineVersions = new Map<string, string>();
	const existingPatchFromVersions = new Map<string, readonly string[]>();
	// Reported once per version rather than once per platform: the release list is the same
	// for all of them, so a malformed entry would otherwise print seven identical warnings.
	const reportedUnparseable = new Set<string>();
	for (const platform of options.platformSuffixes.keys()) {
		const baseline = selectPreviousStableRelease(
			options.targetVersion,
			releases,
			platform,
			(version) => {
				if (reportedUnparseable.has(version)) return;
				reportedUnparseable.add(version);
				log(`  ⚠ ignoring published release with an unparseable version: ${version}`);
			},
		);
		if (baseline) baselineVersions.set(platform, baseline.version);

		const published = targetMetadata.platforms[platform];
		const bases = new Set(published?.zstdPatchFromVersions ?? []);
		if (published?.zstdPatchFromVersion) bases.add(published.zstdPatchFromVersion);
		existingPatchFromVersions.set(platform, [...bases]);
	}

	const { plans, skips } = planStableBaselinePatches({
		targetVersion: options.targetVersion,
		platformSuffixes: options.platformSuffixes,
		baselineVersions,
		existingPatchFromVersions,
		availableFilenames: options.availableFilenames,
	});
	result.skipped.push(...skips);

	if (plans.length === 0) return result;

	const workDir = mkdtempSync(join(tmpdir(), "nf-stable-patch-"));
	try {
		for (const plan of plans) {
			try {
				await uploadStableBaselinePatch({ ...options, plan, targetMetadata, workDir, log });
				result.uploaded.push(plan);
			} catch (error) {
				result.failed.push({
					platform: plan.platform,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}

	return result;
}

async function uploadStableBaselinePatch(context: {
	client: UpdateServerClient;
	targetVersion: string;
	channel?: "stable" | "beta";
	distDir: string;
	plan: PlatformPatchPlan;
	targetMetadata: PublishedReleaseMetadata;
	workDir: string;
	log: (message: string) => void;
}): Promise<void> {
	const { client, plan, targetMetadata, workDir, log } = context;
	const publishedTarget = targetMetadata.platforms[plan.platform];
	if (!publishedTarget) {
		throw new Error(`published target metadata is missing for ${plan.platform}`);
	}

	const targetPath = join(context.distDir, plan.targetFilename);
	const baselinePath = join(context.distDir, plan.baselineFilename);
	if (!existsSync(targetPath) || !existsSync(baselinePath)) {
		throw new Error("local binaries disappeared before patch generation");
	}

	const patchPath = join(workDir, `${plan.targetFilename}.from-${plan.baselineVersion}.zstd-patch`);
	log(
		`  → ${plan.platform}: generating direct patch ${plan.baselineVersion}→${context.targetVersion}...`,
	);
	const meta = await generateZstdPatchToFile({
		oldFilePath: baselinePath,
		newFilePath: targetPath,
		patchOutputPath: patchPath,
		fromVersion: plan.baselineVersion,
		toVersion: context.targetVersion,
	});

	// The generated target must be byte-identical to what is already published, otherwise the
	// patch would reconstruct a binary the server does not vouch for.
	const targetMismatch = getBaselineMismatch(
		{ size: meta.newFileSize, sha512: meta.newFileSha512 },
		publishedTarget,
	);
	if (targetMismatch) {
		throw new Error(`local target binary does not match the published release\n${targetMismatch}`);
	}

	const baselineMetadata = await fetchReleaseMetadata(client, plan.baselineVersion);
	const publishedBaseline = baselineMetadata?.platforms[plan.platform];
	if (!publishedBaseline) {
		throw new Error(`published baseline metadata is missing for v${plan.baselineVersion}`);
	}
	// `GeneratedZstdPatchMeta` guarantees the source identity fields, so this compares real
	// values rather than narrowing optionals that a fresh patch always has.
	const baselineMismatch = getBaselineMismatch(
		{ size: meta.oldFileSize, sha512: meta.oldFileSha512 },
		publishedBaseline,
	);
	if (baselineMismatch) {
		throw new Error(
			`local baseline binary does not match published v${plan.baselineVersion}\n${baselineMismatch}`,
		);
	}

	const metaJson = JSON.stringify(meta, null, 2);
	// `Bun.file` is a lazy Blob: FormData streams it from disk instead of materialising it in
	// the JS heap. That matters most here — a cross-stable patch spans every intermediate beta,
	// so it is the largest patch the pipeline ever produces, and the rest of this module is
	// file-to-file precisely to keep binaries out of memory.
	const patchFile = Bun.file(patchPath);
	const patchSize = patchFile.size;

	const form = new FormData();
	form.append("version", context.targetVersion);
	form.append("channel", context.channel ?? "stable");
	form.append("platform", plan.platform);
	form.append("filename", plan.targetFilename);
	form.append("size", String(meta.newFileSize));
	form.append("sha512", meta.newFileSha512);
	form.append("zstdPatch", patchFile, `${plan.targetFilename}.zstd-patch`);
	form.append("zstdPatchMeta", new Blob([metaJson]), `${plan.targetFilename}.zstd-patch.meta.json`);

	const response = await fetch(`${client.serverUrl}/api/v2/products/${client.product}/releases`, {
		method: "POST",
		headers: { Authorization: `Bearer ${client.token}` },
		body: form,
	});
	const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
	if (!response.ok || !data.success) {
		throw new Error(data.error ?? `HTTP ${response.status}`);
	}

	log(
		`  ✓ ${plan.platform}: uploaded direct patch ${plan.baselineVersion}→${context.targetVersion} (${(patchSize / 1024).toFixed(0)}KB)`,
	);
}

/** Format a human summary for release/promote logs. */
export function formatStableBaselineSummary(result: StableBaselinePatchResult): string[] {
	const lines: string[] = [];
	for (const skip of result.skipped) {
		lines.push(`⚠ ${skip.platform}: no direct stable patch — ${skip.reason}`);
	}
	for (const failure of result.failed) {
		lines.push(`⚠ ${failure.platform}: direct stable patch failed — ${failure.reason}`);
	}
	if (result.uploaded.length > 0) {
		lines.push(`✓ Uploaded ${result.uploaded.length} direct previous-stable patch(es)`);
	}
	return lines;
}
