/**
 * Release script: bump version, tag, build, and upload to update server.
 *
 * When the version publishes as stable (x.y.0), an extra direct patch from the previous
 * stable release is generated and uploaded so stable users upgrade in a single step.
 *
 * Usage:
 *   bun scripts/release.ts 0.2.0                          # full release
 *   bun scripts/release.ts 0.2.0 --changelog=notes.json   # with changelog
 *   bun scripts/release.ts 0.2.0 --dry-run                # build only, no upload
 *   bun scripts/release.ts 0.2.0 --skip-build             # skip compilation
 *   bun scripts/release.ts 0.2.0 --upload-only            # only upload existing dist
 *
 * Environment:
 *   NF_UPDATE_SERVER  — update server URL (default: https://narrafork-update.b.domexie.cn)
 *   NF_UPDATE_TOKEN   — admin token for upload API
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import {
	computeFileIdentity,
	getBaselineMismatch,
	requirePublishedBaseline,
	type PublishedBaselineCandidate,
} from "../server/lib/release-baseline";
import { getUnexpectedReleaseChanges, resolveGitCommit } from "./lib/release-git";
import {
	ensureStableBaselinePatches,
	formatStableBaselineSummary,
	resolvePlatformSuffixes,
} from "./lib/stable-baseline-patch";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const DIST_DIR = join(ROOT, "dist");

// ── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const deprecatedOverwriteArg = args.find((argument) => argument.startsWith("--overwrite-release"));
if (deprecatedOverwriteArg) {
	console.error(
		"❌ --overwrite-release is no longer supported because published release identities are immutable. Publish a new version instead.",
	);
	process.exit(1);
}
const version = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const skipBuild = args.includes("--skip-build");
const uploadOnly = args.includes("--upload-only");
const changelogArg = args.find((a) => a.startsWith("--changelog="))?.split("=").slice(1).join("=");
const platformArg = args.find((a) => a.startsWith("--platform="))?.split("=").slice(1).join("=");
const patchFromArg = args.find((a) => a.startsWith("--patch-from="))?.split("=").slice(1).join("=");
const skipStablePatch = args.includes("--skip-stable-patch");
const patchFromVersions = patchFromArg
	?.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

if (!version) {
	console.error("Usage: bun scripts/release.ts <version> [options]");
	console.error("");
	console.error("Options:");
	console.error("  --changelog=<file>    JSON file with localized release notes");
	console.error("  --platform=<target>   Build and upload only this platform (e.g. windows-x64)");
	console.error("  --patch-from=<v,...>  Upload direct patches for the listed base versions");
	console.error(
		"  --skip-stable-patch   Skip the automatic previous-stable patch on stable releases",
	);
	console.error("  --dry-run             Build only, do not upload or tag");
	console.error("  --skip-build          Skip compilation (use existing dist/)");
	console.error("  --upload-only         Only upload, skip version bump and build");
	process.exit(1);
}

// Allow semver with optional pre-release suffix: 0.1.0, 0.1.0-fix1, 0.2.0-beta.3, etc.
const VERSION_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/;
if (!VERSION_RE.test(version)) {
	console.error(`❌ Invalid version format: ${version} (expected: x.y.z or x.y.z-prerelease)`);
	process.exit(1);
}
for (const fromVersion of patchFromVersions ?? []) {
	if (!VERSION_RE.test(fromVersion)) {
		console.error(`❌ Invalid patch base version: ${fromVersion}`);
		process.exit(1);
	}
}
// ── Load update server config ───────────────────────────────────────────────

function loadUpdateServerConfig(): { serverUrl: string; token: string } {
	const configPath = join(homedir(), ".narrafork", "update-server.json");
	let fileConfig: { serverUrl?: string; token?: string } = {};
	if (existsSync(configPath)) {
		try {
			fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch {
			// ignore malformed config
		}
	}
	return {
		serverUrl:
			process.env.NF_UPDATE_SERVER ?? fileConfig.serverUrl ?? "https://narrafork-update.b.domexie.cn",
		token: process.env.NF_UPDATE_TOKEN ?? fileConfig.token ?? "",
	};
}

const { serverUrl: SERVER, token: TOKEN } = loadUpdateServerConfig();

if (!dryRun && !TOKEN) {
	console.error("❌ Update server token not found");
	console.error("   Set NF_UPDATE_TOKEN env var or create ~/.narrafork/update-server.json:");
	console.error('   { "token": "nfup_..." }');
	process.exit(1);
}

// [dist filename suffix, update server platform ID], honouring --platform=<build name>.
const uploadEntries = [...resolvePlatformSuffixes(platformArg)].map(
	([platform, suffix]) => [suffix, platform] as const,
);

interface PublishedReleaseMetadata {
	version: string;
	platforms: Record<
		string,
		{
			filename: string;
			size: number;
			sha512: string;
		}
	>;
}

class MetadataUnavailableError extends Error {}
class BaselineIntegrityError extends Error {}

const publishedMetadataCache = new Map<string, Promise<PublishedReleaseMetadata | null>>();
const latestPublishedCache = new Map<string, Promise<PublishedBaselineCandidate | null>>();

function getPublishedReleaseMetadata(releaseVersion: string): Promise<PublishedReleaseMetadata | null> {
	let pending = publishedMetadataCache.get(releaseVersion);
	if (!pending) {
		pending = (async () => {
			let response: Response;
			try {
				response = await fetch(
					`${SERVER}/api/v2/products/narrafork/releases/${releaseVersion}/metadata`,
				);
			} catch (error) {
				throw new MetadataUnavailableError(
					`Failed to query published metadata for v${releaseVersion}: ${String(error)}`,
				);
			}
			if (response.status === 404) return null;
			if (!response.ok) {
				throw new MetadataUnavailableError(
					`Published metadata query for v${releaseVersion} returned HTTP ${response.status}`,
				);
			}
			return (await response.json()) as PublishedReleaseMetadata;
		})();
		publishedMetadataCache.set(releaseVersion, pending);
	}
	return pending;
}

function getLatestPublishedBaseline(
	channel: "stable" | "beta",
	platform: string,
): Promise<PublishedBaselineCandidate | null> {
	const cacheKey = `${channel}:${platform}`;
	let pending = latestPublishedCache.get(cacheKey);
	if (!pending) {
		pending = (async () => {
			const url = new URL(`${SERVER}/api/v2/products/narrafork/releases/latest`);
			url.searchParams.set("channel", channel);
			url.searchParams.set("platform", platform);
			let response: Response;
			try {
				response = await fetch(url);
			} catch (error) {
				throw new MetadataUnavailableError(
					`Failed to query latest ${channel} release for ${platform}: ${String(error)}`,
				);
			}
			if (!response.ok) {
				throw new MetadataUnavailableError(
					`Latest ${channel} release query for ${platform} returned HTTP ${response.status}`,
				);
			}
			const data = (await response.json()) as {
				updateAvailable?: boolean;
				version?: string;
				file?: { filename?: string; size?: number; sha512?: string };
			};
			if (data.updateAvailable === false && !data.version) return null;
			if (
				data.updateAvailable !== true ||
				!data.version ||
				!data.file?.filename ||
				!data.file.size ||
				!data.file.sha512
			) {
				throw new MetadataUnavailableError(
					`Latest ${channel} release response for ${platform} is incomplete`,
				);
			}
			return {
				version: data.version,
				channel,
				file: {
					filename: data.file.filename,
					size: data.file.size,
					sha512: data.file.sha512,
				},
			};
		})();
		latestPublishedCache.set(cacheKey, pending);
	}
	return pending;
}

function readDistFilenames(): string[] {
	try {
		return readdirSync(DIST_DIR);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return [];
		}
		throw error;
	}
}

async function verifyLocalPublishedBaselines(): Promise<void> {
	const mismatches: string[] = [];
	const availableFilenames = readDistFilenames();
	for (const [suffix, platform] of uploadEntries) {
		const currentName = `narrafork-${version}-${suffix}`;
		const candidates = (
			await Promise.all([
				getLatestPublishedBaseline("stable", platform),
				getLatestPublishedBaseline("beta", platform),
			])
		).filter((candidate): candidate is PublishedBaselineCandidate => candidate !== null);
		let baseline: PublishedBaselineCandidate | null;
		try {
			baseline = requirePublishedBaseline(
				version,
				currentName,
				candidates,
				availableFilenames,
			);
		} catch (error) {
			mismatches.push(`${platform}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!baseline) continue;

		const baselinePath = join(DIST_DIR, baseline.file.filename);
		const actual = computeFileIdentity(baselinePath);
		const mismatch = getBaselineMismatch(actual, baseline.file);
		if (mismatch) {
			mismatches.push(`${platform}: ${basename(baselinePath)}\n${mismatch}`);
		}
	}

	if (mismatches.length > 0) {
		throw new BaselineIntegrityError(
			`Release baseline integrity check failed:\n\n${mismatches.join("\n\n")}\n\nRestore the exact published binaries before releasing.`,
		);
	}
	console.log("✓ Published release baselines verified against latest stable/beta releases");
}

if (!uploadOnly) {
	try {
		await verifyLocalPublishedBaselines();
	} catch (error) {
		if (dryRun && error instanceof MetadataUnavailableError) {
			console.warn(`⚠ ${error.message}; continuing offline dry run without baseline verification`);
		} else {
			console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	}
}

// ── Load changelog ──────────────────────────────────────────────────────────

let changelog: string | Record<string, string> | undefined;
const changelogPath = changelogArg ?? join(ROOT, "changelogs", `v${version}.json`);
if (existsSync(changelogPath)) {
	const raw = readFileSync(changelogPath, "utf-8");
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			changelog = parsed as Record<string, string>;
		} else {
			changelog = raw;
		}
	} catch {
		changelog = raw;
	}
	console.log(`✓ Loaded changelog from ${changelogPath}`);
} else if (changelogArg) {
	console.error(`❌ Changelog file not found: ${changelogArg}`);
	process.exit(1);
}

const releaseCommitPaths = ["package.json"];
if (existsSync(changelogPath)) {
	const relChangelog = relative(ROOT, changelogPath);
	if (relChangelog && !relChangelog.startsWith("..") && !isAbsolute(relChangelog)) {
		releaseCommitPaths.push(relChangelog);
	} else {
		console.warn(
			`⚠ Changelog ${changelogPath} is outside the repo; not adding it to the release commit`,
		);
	}
}

if (!uploadOnly && !dryRun) {
	const unexpectedChanges = getUnexpectedReleaseChanges(ROOT, releaseCommitPaths);
	if (unexpectedChanges.length > 0) {
		console.error("❌ Release worktree contains changes outside package.json and the version changelog:");
		for (const change of unexpectedChanges) console.error(`   ${change}`);
		console.error("   Commit or stash those changes before publishing so the binary matches its tag.");
		process.exit(1);
	}
}

// ── Step 1: Version bump ────────────────────────────────────────────────────

if (!uploadOnly) {
	const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
	const oldVersion = pkg.version;

	if (oldVersion === version) {
		console.log(`ℹ Version already ${version}, skipping bump`);
	} else {
		pkg.version = version;
		writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, "\t")}\n`);
		console.log(`✓ Version bumped: ${oldVersion} → ${version}`);
	}
}

// ── Step 2: Git release commit ──────────────────────────────────────────────

if (!uploadOnly && !dryRun) {
	try {
		const status = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all", "--", ...releaseCommitPaths],
			{
				cwd: ROOT,
				encoding: "utf8",
			},
		).trim();

		if (status) {
			execFileSync("git", ["add", "--", ...releaseCommitPaths], {
				cwd: ROOT,
				stdio: "inherit",
			});
			execFileSync("git", ["commit", "-m", `release: v${version}`], {
				cwd: ROOT,
				stdio: "inherit",
			});
			console.log(`✓ Committed release: v${version}`);
		}

		const remainingChanges = getUnexpectedReleaseChanges(ROOT);
		if (remainingChanges.length > 0) {
			console.error("❌ Release commit did not leave a clean worktree:");
			for (const change of remainingChanges) console.error(`   ${change}`);
			process.exit(1);
		}
	} catch (err) {
		console.error(`❌ Git release commit failed: ${err}`);
		process.exit(1);
	}
}

// ── Step 3: Build ───────────────────────────────────────────────────────────

if (!skipBuild && !uploadOnly) {
	const buildLabel = platformArg ? `platform ${platformArg}` : "all platforms";
	console.log(`\n→ Building ${buildLabel}...\n`);
	const buildCmd = platformArg
		? `bun scripts/build-cross-platform.ts --platform=${platformArg}`
		: "bun scripts/build-cross-platform.ts";
	try {
		execSync(buildCmd, {
			cwd: ROOT,
			stdio: "inherit",
		});
	} catch {
		console.error("❌ Build failed");
		process.exit(1);
	}
}

// ── Step 4: Tag the successfully built commit ───────────────────────────────

if (!uploadOnly && !dryRun) {
	try {
		const postBuildChanges = getUnexpectedReleaseChanges(ROOT);
		if (postBuildChanges.length > 0) {
			console.error("❌ Build changed repository files after the release commit:");
			for (const change of postBuildChanges) console.error(`   ${change}`);
			console.error("   Commit deterministic generated sources before tagging the release.");
			process.exit(1);
		}

		const headCommit = resolveGitCommit(ROOT, "HEAD");
		if (!headCommit) throw new Error("Cannot resolve HEAD");
		const tagRef = `refs/tags/v${version}`;
		const taggedCommit = resolveGitCommit(ROOT, tagRef);
		if (taggedCommit && taggedCommit !== headCommit) {
			console.error(
				`❌ Tag v${version} already points to ${taggedCommit.slice(0, 12)}, not HEAD ${headCommit.slice(0, 12)}`,
			);
			process.exit(1);
		}
		if (taggedCommit) {
			console.log(`ℹ Tag v${version} already points to HEAD, skipping`);
		} else {
			execFileSync("git", ["tag", `v${version}`], { cwd: ROOT, stdio: "inherit" });
			console.log(`✓ Tagged: v${version}`);
		}
	} catch (err) {
		console.error(`❌ Git tag failed: ${err}`);
		process.exit(1);
	}
}

// ── Step 5: Upload ──────────────────────────────────────────────────────────

if (dryRun) {
	console.log("\n✅ Dry run complete — skipping upload");
	process.exit(0);
}

console.log("\n→ Uploading to update server...\n");

interface PatchArtifact {
	fromVersion: string;
	patchPath: string;
	metaPath: string;
	meta: {
		fromVersion: string;
		toVersion: string;
		oldFileSize?: number;
		oldFileSha512?: string;
		patchSize: number;
		newFileSize: number;
		newFileSha512: string;
	};
}

function loadPatchArtifact(filename: string, fromVersion?: string): PatchArtifact | null {
	const patchPath = join(
		DIST_DIR,
		fromVersion
			? `${filename}.from-${fromVersion}.zstd-patch`
			: `${filename}.zstd-patch`,
	);
	const metaPath = `${patchPath}.meta.json`;
	if (!existsSync(patchPath) || !existsSync(metaPath)) return null;
	const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as PatchArtifact["meta"];
	if (fromVersion && meta.fromVersion !== fromVersion) return null;
	return { fromVersion: meta.fromVersion, patchPath, metaPath, meta };
}

function resolvePatchArtifacts(filename: string): PatchArtifact[] {
	if (!patchFromVersions || patchFromVersions.length === 0) {
		const artifact = loadPatchArtifact(filename);
		return artifact ? [artifact] : [];
	}

	return patchFromVersions.map((fromVersion) => {
		const versioned = loadPatchArtifact(filename, fromVersion);
		if (versioned) return versioned;
		const canonical = loadPatchArtifact(filename);
		if (canonical?.fromVersion === fromVersion) return canonical;
		throw new Error(`Missing patch artifact for ${filename} from ${fromVersion}`);
	});
}

async function validatePatchSource(
	platform: string,
	artifact: PatchArtifact,
): Promise<string | null> {
	const { meta } = artifact;
	if (!meta.oldFileSize || !meta.oldFileSha512) {
		return "patch metadata does not contain oldFileSize and oldFileSha512; rebuild the patch";
	}
	const published = await getPublishedReleaseMetadata(artifact.fromVersion);
	const expected = published?.platforms[platform];
	if (!expected) {
		return `published source metadata is missing for ${platform} v${artifact.fromVersion}`;
	}
	return getBaselineMismatch(
		{ size: meta.oldFileSize, sha512: meta.oldFileSha512 },
		expected,
	);
}

async function validateTargetIdentity(
	platform: string,
	filename: string,
	size: number,
	sha512: string,
): Promise<string | null> {
	const published = await getPublishedReleaseMetadata(version);
	const existing = published?.platforms[platform];
	if (!existing) return null;
	const mismatch = getBaselineMismatch({ size, sha512 }, existing);
	if (!mismatch) return null;
	return [
		`v${version} ${platform} already exists with a different binary`,
		mismatch,
		"Published release identities are immutable; publish the replacement binary under a new version.",
	].join("\n");
}

// Channel: x.y.0 → stable, anything else (x.y.z where z>0, or pre-release) → beta
const channel: "stable" | "beta" = /^\d+\.\d+\.0$/.test(version) ? "stable" : "beta";

const prefix = `narrafork-${version}-`;
let uploaded = 0;
let failed = 0;

for (const [suffix, platform] of uploadEntries) {
	const filename = `${prefix}${suffix}`;
	let artifacts: PatchArtifact[];
	try {
		artifacts = resolvePatchArtifacts(filename);
	} catch (err) {
		console.error(`  ❌ ${platform}: ${err instanceof Error ? err.message : String(err)}`);
		failed++;
		continue;
	}

	if (artifacts.length === 0) {
		if (patchFromVersions && patchFromVersions.length > 0) {
			console.error(`  ❌ ${platform}: requested patch artifacts are unavailable`);
			failed++;
			continue;
		}
		const fullPath = join(DIST_DIR, filename);
		if (!existsSync(fullPath)) {
			console.error(`  ❌ ${platform}: no zstd patch and full artifact is missing (${fullPath})`);
			failed++;
			continue;
		}
		const fullBuf = readFileSync(fullPath);
		if (fullBuf.length === 0) {
			console.error(`  ❌ ${platform}: full artifact is empty`);
			failed++;
			continue;
		}
		const fullSha512 = createHash("sha512").update(fullBuf).digest("base64");
		try {
			const targetMismatch = await validateTargetIdentity(
				platform,
				filename,
				fullBuf.length,
				fullSha512,
			);
			if (targetMismatch) {
				console.error(`  ❌ ${platform}: ${targetMismatch}`);
				failed++;
				continue;
			}
		} catch (error) {
			console.error(`  ❌ ${platform}: failed to validate target release: ${String(error)}`);
			failed++;
			continue;
		}
		const form = new FormData();
		form.append("version", version);
		form.append("channel", channel);
		form.append("platform", platform);
		form.append("filename", filename);
		form.append("file", new Blob([fullBuf]), filename);
		if (changelog) {
			form.append(
				"releaseNotes",
				typeof changelog === "string" ? changelog : JSON.stringify(changelog),
			);
		}
		try {
			const resp = await fetch(`${SERVER}/api/v2/products/narrafork/releases`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
				body: form,
			});
			const data = (await resp.json()) as { success?: boolean; error?: string };
			if (resp.ok && data.success) {
				console.log(`  ✓ ${platform}: ${(fullBuf.length / 1024).toFixed(0)}KB full artifact`);
				uploaded++;
			} else {
				console.error(`  ❌ ${platform}: ${data.error ?? `HTTP ${resp.status}`}`);
				failed++;
			}
		} catch (err) {
			console.error(`  ❌ ${platform}: ${err}`);
			failed++;
		}
		continue;
	}

	for (const artifact of artifacts) {
		const { meta } = artifact;
		const sha512 = meta.newFileSha512;
		const size = meta.newFileSize;
		if (!sha512 || !size || meta.toVersion !== version) {
			console.error(`  ❌ ${platform} from ${artifact.fromVersion}: incomplete or mismatched meta`);
			failed++;
			continue;
		}
		try {
			const sourceMismatch = await validatePatchSource(platform, artifact);
			if (sourceMismatch) {
				console.error(
					`  ❌ ${platform} from ${artifact.fromVersion}: source baseline mismatch\n${sourceMismatch}`,
				);
				failed++;
				continue;
			}
			const targetMismatch = await validateTargetIdentity(platform, filename, size, sha512);
			if (targetMismatch) {
				console.error(`  ❌ ${platform}: ${targetMismatch}`);
				failed++;
				continue;
			}
		} catch (error) {
			console.error(
				`  ❌ ${platform} from ${artifact.fromVersion}: release integrity validation failed: ${String(error)}`,
			);
			failed++;
			continue;
		}

		const form = new FormData();
		form.append("version", version);
		form.append("channel", channel);
		form.append("platform", platform);
		form.append("filename", filename);
		form.append("size", String(size));
		form.append("sha512", sha512);

		if (changelog) {
			form.append(
				"releaseNotes",
				typeof changelog === "string" ? changelog : JSON.stringify(changelog),
			);
		}

		const patchBuf = readFileSync(artifact.patchPath);
		const metaBuf = readFileSync(artifact.metaPath);
		form.append("zstdPatch", new Blob([patchBuf]), `${filename}.zstd-patch`);
		form.append("zstdPatchMeta", new Blob([metaBuf]), `${filename}.zstd-patch.meta.json`);

		try {
			const resp = await fetch(`${SERVER}/api/v2/products/narrafork/releases`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
				body: form,
			});

			const data = (await resp.json()) as { success?: boolean; error?: string };
			if (data.success) {
				console.log(
					`  ✓ ${platform} ${artifact.fromVersion}→${version}: ${(patchBuf.length / 1024).toFixed(0)}KB patch`,
				);
				uploaded++;
			} else {
				console.error(
					`  ❌ ${platform} ${artifact.fromVersion}→${version}: ${data.error ?? "unknown error"}`,
				);
				failed++;
			}
		} catch (err) {
			console.error(`  ❌ ${platform} ${artifact.fromVersion}→${version}: ${err}`);
			failed++;
		}
	}
}

console.log(`\n✅ Release v${version} complete: ${uploaded} uploaded, ${failed} failed`);

// ── Step 6: Direct previous-stable patch (stable releases only) ─────────────

// A stable release must be reachable from the previous *stable* release in one step. The
// build only produces a patch from the immediately preceding version, which is usually a
// beta, so stable users would otherwise replay the whole intermediate chain. Failures here
// are warnings: the chain still works, it is just larger.
if (channel === "stable" && !skipStablePatch && uploaded > 0) {
	console.log("\n→ Ensuring a direct previous-stable upgrade path...");
	const stablePatchResult = await ensureStableBaselinePatches({
		client: { serverUrl: SERVER, token: TOKEN, product: "narrafork" },
		targetVersion: version,
		distDir: DIST_DIR,
		platformSuffixes: resolvePlatformSuffixes(platformArg),
		availableFilenames: readDistFilenames(),
		log: (message) => console.log(message),
	});
	for (const line of formatStableBaselineSummary(stablePatchResult)) console.log(line);
	if (
		stablePatchResult.uploaded.length === 0 &&
		stablePatchResult.failed.length === 0 &&
		stablePatchResult.skipped.length === 0
	) {
		console.log("✓ Direct previous-stable patches were already published");
	}
}

if (failed > 0 || uploaded === 0) {
	if (uploaded === 0) console.error("❌ No release artifacts were uploaded");
	process.exit(1);
}
