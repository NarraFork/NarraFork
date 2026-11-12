/**
 * Cross-platform build script: compiles NarraFork for multiple platforms.
 *
 * Usage:
 *   bun scripts/build-cross-platform.ts                    # build all platforms
 *   bun scripts/build-cross-platform.ts --platform=darwin-arm64  # specific platform
 *   bun scripts/build-cross-platform.ts --skip-frontend    # skip Vite build
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { compiledWorkerBuildEntrypoints } from "../server/lib/compiled-worker";
import { createHelperDistributionDependencies } from "../shared/helper-distribution";
import { REMOTE_PEER_DISTRIBUTION } from "../shared/remote-peer-distribution";
import { CURRENT_RECOVERY_MANIFEST_VERSIONS } from "../shared/update-identity";
import type { BinaryMetadata } from "./lib/binary-metadata";
import { assetsUnder, collectBuildModules, renderBuildInfo } from "./lib/build-materials";
import { resolveBuildGitHubRepository } from "./lib/build-repository";
import { validatePtyDependency } from "./lib/ci-build-native";
import {
	runCiBuildCommand,
	validateCiBuildIdentity,
	validateCiMetadata,
	verifyCiSidecar,
	writeBuildAggregates,
} from "./lib/ci-build-strict";
import { compiledBuildArguments, runtimeBuildDefines } from "./lib/compiled-build";
import { formatLatestYmlFiles, type LatestYmlEntry } from "./lib/latest-yml";

const ROOT = join(import.meta.dir, "..");
const BUILD_REPOSITORY = resolveBuildGitHubRepository({ root: ROOT });
// The child Vite build must use exactly the backend's frozen build identity.
process.env.NF_BUILD_GITHUB_REPOSITORY = BUILD_REPOSITORY;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const VERSION: string = pkg.version ?? "0.0.0";
// Freeze component pins once; application releases do not select new executors.
const HELPER_DISTRIBUTION = createHelperDistributionDependencies();
const FRONTEND_DIR = join(ROOT, "dist", "frontend");
const GENERATED_BUILD_INFO_FILE = join(ROOT, "server", "generated", "build-info.ts");
const RUNTIME_BUILD_ID = randomUUID();
const DIST_DIR = join(ROOT, "dist");
/** Windows 可执行文件图标：由 scripts/generate-windows-icon.ts 从品牌 PNG 生成。 */
const WINDOWS_ICON_PATH = join(DIST_DIR, "narrafork.ico");

// ============================================================================
// Main build script
// ============================================================================

// Parse CLI arguments
const args = process.argv.slice(2);
const skipFrontend = args.includes("--skip-frontend");
const releaseCi = args.includes("--release-ci");
let commitHash = "";
try {
	commitHash = execSync(
		releaseCi ? "git rev-parse --verify HEAD^{commit}" : "git rev-parse --short HEAD",
		{
			cwd: ROOT,
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: 4096,
		},
	).trim();
} catch (error) {
	if (releaseCi) throw new Error("Release CI cannot resolve HEAD commit", { cause: error });
}
if (releaseCi) validateCiBuildIdentity(pkg.packageManager, Bun.version, commitHash);
const platformArg = args.find((a) => a.startsWith("--platform="))?.split("=")[1];

// Available platforms
// NOTE: platformId must match the format returned by getPlatform() in update-service.ts
// (e.g. "darwin-arm64", "win-x64", "linux-x64-baseline")
const PLATFORMS = [
	{
		target: "bun-darwin-arm64",
		platformId: "darwin-arm64",
		name: `narrafork-${VERSION}-macos-arm64`,
	},
	{ target: "bun-darwin-x64", platformId: "darwin-x64", name: `narrafork-${VERSION}-macos-x64` },
	{ target: "bun-linux-x64", platformId: "linux-x64", name: `narrafork-${VERSION}-linux-x64` },
	{
		target: "bun-linux-x64-baseline",
		platformId: "linux-x64-baseline",
		name: `narrafork-${VERSION}-linux-x64-baseline`,
	},
	{
		target: "bun-linux-arm64",
		platformId: "linux-arm64",
		name: `narrafork-${VERSION}-linux-arm64`,
	},
	{
		target: "bun-windows-x64",
		platformId: "win-x64",
		name: `narrafork-${VERSION}-windows-x64.exe`,
	},
	{
		target: "bun-windows-x64-baseline",
		platformId: "win-x64-baseline",
		name: `narrafork-${VERSION}-windows-x64-baseline.exe`,
	},
	{
		target: "bun-windows-arm64",
		platformId: "win-arm64",
		name: `narrafork-${VERSION}-windows-arm64.exe`,
	},
];

const selectedPlatforms = platformArg
	? PLATFORMS.filter((p) => {
			// Exact suffix match to avoid "linux-x64" matching "linux-x64-baseline"
			const suffix = p.target.replace("bun-", "");
			return (
				suffix === platformArg ||
				p.target === platformArg ||
				// Allow short aliases like "windows" to match "windows-x64"
				(suffix.startsWith(`${platformArg}-`) &&
					!PLATFORMS.some((q) => q.target.replace("bun-", "") === platformArg))
			);
		})
	: PLATFORMS;

if (selectedPlatforms.length === 0) {
	console.error(`❌ Unknown platform: ${platformArg}`);
	console.log("Available platforms:", PLATFORMS.map((p) => p.target).join(", "));
	process.exit(1);
}

if (!releaseCi) {
	console.log("Local build is full-only; canonical patches are generated by GitHub Release CI");
}

if (releaseCi) {
	for (const platform of selectedPlatforms) {
		if (platform.target.includes("darwin") && process.platform !== "darwin") {
			throw new Error("Release CI macOS builds require a native macOS runner");
		}
		validatePtyDependency(ROOT, platform.target);
	}
}

async function runBuildStep(command: string[]): Promise<{ exitCode: number }> {
	if (releaseCi) {
		await runCiBuildCommand(command, 30 * 60_000, ROOT);
		return { exitCode: 0 };
	}
	return Bun.spawnSync(command, { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
}

// Step 1: Build frontend with Vite
if (!skipFrontend) {
	console.log("→ Building frontend...");
	const vite = await runBuildStep([
		process.execPath,
		"run",
		"vite",
		"build",
		"--config",
		"frontend/vite.config.ts",
	]);
	if (vite.exitCode !== 0) {
		console.error("❌ Frontend build failed");
		process.exit(1);
	}
	console.log("✓ Frontend built");
}

// Step 1b: Download @parcel/watcher native binaries for all platforms
{
	console.log("→ Downloading @parcel/watcher native binaries...");
	const dl = await runBuildStep([
		process.execPath,
		"scripts/download-parcel-watcher.ts",
		...(releaseCi ? selectedPlatforms.map((platform) => `--target=${platform.target}`) : []),
	]);
	if (dl.exitCode !== 0) {
		console.error("❌ @parcel/watcher binary download failed");
		process.exit(1);
	}
}

// Steps 2–5: Generate the same embedded materials as the local immutable build.
if (!existsSync(join(FRONTEND_DIR, "index.html"))) {
	throw new Error("Frontend assets are missing. Run bun run build first.");
}
const buildInfo = {
	version: VERSION,
	commit: commitHash,
	platform: "unknown",
	repository: BUILD_REPOSITORY,
	helperDistribution: HELPER_DISTRIBUTION,
	remotePeerDistribution: REMOTE_PEER_DISTRIBUTION,
};
const generatedDir = join(ROOT, "server", "generated");
mkdirSync(generatedDir, { recursive: true });
for (const [name, source] of await collectBuildModules(
	ROOT,
	assetsUnder(FRONTEND_DIR),
	buildInfo,
)) {
	const path = join(generatedDir, name);
	writeFileSync(path, source);
	console.log(`Generated ${relative(ROOT, path)}`);
}

// Step 6: Compile for each platform (serial — shared build-info.ts requires sequential writes)
if (!existsSync(DIST_DIR)) {
	mkdirSync(DIST_DIR, { recursive: true });
}

// Phase 1: Serial compilation (each platform needs its own buildPlatform in build-info.ts)
const compileStart = performance.now();
for (const platform of selectedPlatforms) {
	console.log(`\n→ Compiling for ${platform.target}...`);

	// Inject build platform constant before compiling
	writeFileSync(
		GENERATED_BUILD_INFO_FILE,
		renderBuildInfo({ ...buildInfo, platform: platform.platformId }),
	);

	const outfile = join(DIST_DIR, platform.name);

	const compile = await runBuildStep([
		process.execPath,
		"build",
		"./server/index.ts",
		// Worker entries are not bundled imports; see server/lib/compiled-worker.ts.
		...compiledWorkerBuildEntrypoints(),
		`--define=__NARRAFORK_BUILD_REPOSITORY__=${JSON.stringify(BUILD_REPOSITORY)}`,
		...Object.entries(runtimeBuildDefines(RUNTIME_BUILD_ID, false)).map(
			([name, value]) => `--define=${name}=${value}`,
		),
		...compiledBuildArguments(),
		"--target",
		platform.target,
		// Windows：面板自带 UI，编译产物不该再弹控制台；图标由
		// scripts/generate-windows-icon.ts 从品牌 PNG 生成，缺失时跳过而不是让编译失败。
		...(platform.target.startsWith("bun-windows")
			? [
					"--windows-hide-console",
					...(existsSync(WINDOWS_ICON_PATH) ? [`--windows-icon=${WINDOWS_ICON_PATH}`] : []),
				]
			: []),
		"--outfile",
		outfile,
	]);

	if (compile.exitCode !== 0) {
		console.error(`❌ Compilation failed for ${platform.target}`);
		process.exit(1);
	}

	console.log(`✓ Built: ${relative(ROOT, outfile)}`);
}
const compileMs = (performance.now() - compileStart).toFixed(0);
console.log(`\n✓ All ${selectedPlatforms.length} platforms compiled in ${compileMs}ms`);

// Phase 2: Post-processing (signing, SHA-512, zstd patch, latest.yml metadata)
// Each platform runs in its own worker thread for true parallelism.
// Workers send log messages back immediately for real-time output.

interface WorkerResult {
	latestYml: LatestYmlEntry;
	metadata?: BinaryMetadata;
}

function runPostProcessWorker(platform: (typeof selectedPlatforms)[number]): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		let completed = false;
		let result: WorkerResult | undefined;
		const worker = new Worker(join(import.meta.dir, "post-process-worker.ts"), {
			workerData: {
				platform,
				distDir: DIST_DIR,
				root: ROOT,
				version: VERSION,
				commit: commitHash,
				repository: BUILD_REPOSITORY,
				helperDistribution: HELPER_DISTRIBUTION,
				recoveryManifestVersions: CURRENT_RECOVERY_MANIFEST_VERSIONS,
				releaseCi,
			},
		});

		worker.on(
			"message",
			(msg: {
				type: string;
				message?: string;
				latestYml?: LatestYmlEntry;
				metadata?: BinaryMetadata;
			}) => {
				if (msg.type === "log") {
					console.log(`  [${platform.platformId}] ${msg.message}`);
				} else if (msg.type === "done") {
					completed = true;
					if (releaseCi) {
						try {
							validateCiMetadata(msg.metadata, {
								...platform,
								version: VERSION,
								commit: commitHash,
								repository: BUILD_REPOSITORY,
								helperDistribution: HELPER_DISTRIBUTION,
								recoveryManifestVersions: CURRENT_RECOVERY_MANIFEST_VERSIONS,
							});
						} catch (error) {
							reject(error);
							return;
						}
					}
					if (!msg.latestYml) {
						reject(
							new Error(`Worker for ${platform.platformId} completed without latest.yml data`),
						);
						return;
					}
					result = { latestYml: msg.latestYml, metadata: msg.metadata };
				}
			},
		);

		worker.on("error", reject);
		worker.on("exit", (code) => {
			if (code !== 0 || !completed || !result) {
				reject(
					new Error(
						`Worker for ${platform.platformId} exited with code ${code} (completed=${completed})`,
					),
				);
			} else {
				resolve(result);
			}
		});
	});
}

console.log(`\n→ Post-processing ${selectedPlatforms.length} platforms in parallel...`);
const postStart = performance.now();
const results = await Promise.all(selectedPlatforms.map(runPostProcessWorker));
if (releaseCi) {
	// Re-read final signed files and sidecars, not just worker-supplied metadata.
	for (const [index, platform] of selectedPlatforms.entries()) {
		const verified = await verifyCiSidecar(join(DIST_DIR, platform.name), {
			...platform,
			version: VERSION,
			commit: commitHash,
			repository: BUILD_REPOSITORY,
			helperDistribution: HELPER_DISTRIBUTION,
			recoveryManifestVersions: CURRENT_RECOVERY_MANIFEST_VERSIONS,
		});
		const reported = results[index].metadata;
		if (
			verified.sha256 !== reported?.sha256 ||
			verified.sha512 !== reported.sha512 ||
			verified.size !== reported.size
		) {
			throw new Error(`Release CI binary changed after post-processing: ${platform.name}`);
		}
	}
}
const postMs = (performance.now() - postStart).toFixed(0);

// Write latest*.yml files as family manifests. Multiple architectures share one
// metadata file; aggregate every binary instead of letting the last worker win.
const latestYmlFiles = formatLatestYmlFiles(results.map((result) => result.latestYml));
for (const [name, content] of latestYmlFiles) {
	writeFileSync(join(DIST_DIR, name), content);
}
console.log(`\n✓ Post-processing completed in ${postMs}ms`);

// Write aggregate checksum files (verifiable provenance for every binary).
// Ordinary local builds remain best-effort; Release CI fails closed.
const metadataEntries = results
	.map((r) => r.metadata)
	.filter((m): m is BinaryMetadata => m !== undefined);

const aggregateFiles: string[] = [];
if (metadataEntries.length > 0) {
	try {
		const [sumsName, reportName] = writeBuildAggregates(DIST_DIR, VERSION, metadataEntries);
		aggregateFiles.push(sumsName, reportName);
		console.log(
			`✓ Wrote aggregate checksums for ${metadataEntries.length} binaries (${sumsName}, ${reportName})`,
		);
	} catch (err) {
		if (releaseCi) throw err;
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`⚠ Failed to write aggregate checksum files: ${message}`);
	}
} else {
	if (releaseCi) throw new Error("Release CI requires per-binary metadata for aggregates");
	console.warn("⚠ No per-binary metadata collected; skipping aggregate checksum files");
}

console.log("\n✅ All builds completed!");
console.log("\nBuilt executables:");
for (const platform of selectedPlatforms) {
	console.log(`  - dist/${platform.name}`);
	console.log(`      dist/${platform.name}.metadata.json`);
}
if (aggregateFiles.length > 0) {
	console.log("\nChecksum files:");
	for (const name of aggregateFiles) {
		console.log(`  - dist/${name}`);
	}
}
