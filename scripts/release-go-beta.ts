/**
 * Release NarraFork Go backend beta artifacts.
 *
 * Upload policy: metadata + zstd patch only. No full binary upload.
 *
 * Usage:
 *   bun scripts/release-go-beta.ts 0.4.17
 *   bun scripts/release-go-beta.ts 0.4.17 --platform=linux-x64
 *   bun scripts/release-go-beta.ts 0.4.17 --dry-run
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { generateZstdPatch } from "../server/lib/zstd-patch";
import {
	compareGoVersions,
	findPreviousGoArtifactForPlatform,
	GO_BETA_CHANNEL,
	GO_BETA_PRODUCT,
	GO_BUILD_CHANNEL,
	GO_BUILD_OUTPUT_DIR,
	getGoTargets,
	hasFlag,
	loadChangelog,
	loadGoArtifactManifest,
	loadGoArtifactManifestEntry,
	loadUpdateServerConfig,
	parseArg,
	versionOutputDir,
} from "./go-backend-shared";

const args = process.argv.slice(2);
const version = args.find((arg) => !arg.startsWith("--"));
const platformArg = parseArg(args, "platform");
const outDirArg = parseArg(args, "out-dir");
const changelogArg = parseArg(args, "changelog");
const fromVersionArg = parseArg(args, "from-version");
const dryRun = hasFlag(args, "dry-run");
const skipBuild = hasFlag(args, "skip-build");

if (!version) {
	console.error("Usage: bun scripts/release-go-beta.ts <version> [options]");
	console.error("");
	console.error("Options:");
	console.error("  --platform=<target>   Upload only one platform (e.g. linux-x64)");
	console.error("  --from-version=<v>    Explicit patch base version");
	console.error("  --out-dir=<dir>       Go build output directory");
	console.error("  --dry-run             Print the upload plan without network calls");
	console.error("  --skip-build          Reuse existing build artifacts");
	process.exit(1);
}

const outDir = resolve(outDirArg ?? GO_BUILD_OUTPUT_DIR);
const versionDir = versionOutputDir(version, outDir);
const selectedTargets = getGoTargets(platformArg);
if (selectedTargets.length === 0) {
	console.error(`❌ Unknown platform: ${platformArg ?? "(empty)"}`);
	process.exit(1);
}

if (!skipBuild && !dryRun) {
	const buildArgs = [
		"scripts/build-go-backend.ts",
		`--version=${version}`,
		`--out-dir=${outDir}`,
		`--channel=${GO_BUILD_CHANNEL}`,
	];

	if (platformArg) {
		buildArgs.push(`--platform=${platformArg}`);
	}
	if (changelogArg) {
		buildArgs.push(`--changelog=${changelogArg}`);
	}
	const build = Bun.spawnSync(["bun", ...buildArgs], {
		cwd: join(import.meta.dir, ".."),
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
		env: { ...process.env },
	});
	if (build.exitCode !== 0) {
		process.exit(build.exitCode ?? 1);
	}
}

const manifest = loadGoArtifactManifest(version, outDir);
if (!manifest) {
	console.error(`❌ Go build manifest not found for ${version} under ${versionDir}`);
	console.error(
		"   Run the Go build script first, or pass --skip-build only after building artifacts.",
	);
	process.exit(1);
}

const releaseNotes = loadChangelog(version, changelogArg);
const { serverUrl: SERVER, token: TOKEN } = loadUpdateServerConfig();
if (!dryRun && !TOKEN) {
	console.error("❌ Update server token not found");
	console.error("   Set NF_UPDATE_TOKEN env var or create ~/.narrafork/update-server.json");
	process.exit(1);
}

const selectedArtifacts = selectedTargets
	.map((target) => loadGoArtifactManifestEntry(manifest, target.platform))
	.filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));

if (selectedArtifacts.length === 0) {
	console.error(`❌ No manifest artifacts matched requested platform(s): ${platformArg ?? "all"}`);
	process.exit(1);
}

const currentVersionDir = versionOutputDir(version, outDir);

type PatchBase = {
	version: string;
	artifact: NonNullable<ReturnType<typeof loadGoArtifactManifestEntry>>;
};

function resolvePatchBase(
	currentVersion: string,
	platform: string,
	outDirPath: string,
	explicitVersion?: string,
): PatchBase {
	if (explicitVersion) {
		if (compareGoVersions(explicitVersion, currentVersion) >= 0) {
			console.error(
				`❌ --from-version must be older than target version for ${platform}: ${explicitVersion} >= ${currentVersion}`,
			);
			process.exit(1);
		}
		const explicitManifest = loadGoArtifactManifest(explicitVersion, outDirPath);
		if (!explicitManifest) {
			console.error(`❌ Go build manifest not found for explicit patch base ${explicitVersion}`);
			process.exit(1);
		}
		const explicitArtifact = loadGoArtifactManifestEntry(explicitManifest, platform);
		if (!explicitArtifact) {
			console.error(
				`❌ Explicit patch base ${explicitVersion} does not contain platform ${platform}`,
			);
			process.exit(1);
		}
		return { version: explicitVersion, artifact: explicitArtifact };
	}

	const previous = findPreviousGoArtifactForPlatform(currentVersion, platform, outDirPath);
	if (!previous) {
		console.error(`❌ Could not find a previous Go build for ${platform} before ${currentVersion}`);
		process.exit(1);
	}
	return { version: previous.version, artifact: previous.artifact };
}

type PreparedUpload = {
	artifact: NonNullable<(typeof selectedArtifacts)[number]>;
	baseVersion: string;
	baseFilename: string;
	patch: Buffer;
	patchMeta: ReturnType<typeof generateZstdPatch>["meta"];
};

const preparedUploads: PreparedUpload[] = [];
for (const artifact of selectedArtifacts) {
	const currentBinary = join(currentVersionDir, artifact.filename);
	if (!existsSync(currentBinary)) {
		console.error(`❌ Missing Go binary for ${artifact.platform}: ${currentBinary}`);
		process.exit(1);
	}

	const base = resolvePatchBase(version, artifact.platform, outDir, fromVersionArg);
	const previousBinary = join(versionOutputDir(base.version, outDir), base.artifact.filename);
	if (!existsSync(previousBinary)) {
		console.error(`❌ Missing base binary for ${artifact.platform}: ${previousBinary}`);
		process.exit(1);
	}

	const currentBuf = readFileSync(currentBinary);
	const previousBuf = readFileSync(previousBinary);
	const { patch, meta } = generateZstdPatch(previousBuf, currentBuf, {
		fromVersion: base.version,
		toVersion: version,
	});
	preparedUploads.push({
		artifact,
		baseVersion: base.version,
		baseFilename: base.artifact.filename,
		patch,
		patchMeta: meta,
	});
}

if (dryRun) {
	console.log("→ Go beta release dry-run");
	console.log(`  product: ${GO_BETA_PRODUCT}`);
	console.log(`  version: ${version}`);
	console.log("  baseVersion per platform:");
	for (const item of preparedUploads) {
		console.log(`    - ${item.artifact.platform}: ${item.baseVersion} (${item.baseFilename})`);
	}
	console.log(`  channel: ${GO_BETA_CHANNEL}`);
	console.log(`  releaseNotes: ${releaseNotes ? "yes" : "no"}`);
	for (const item of preparedUploads) {
		console.log(
			`  - ${item.artifact.platform}: ${item.artifact.filename} patch=${item.patch.length} sha512=${item.artifact.sha512.slice(0, 16)}...`,
		);
	}
	process.exit(0);
}

for (const { artifact, patch, patchMeta } of preparedUploads) {
	const form = new FormData();
	form.append("version", version);
	form.append("channel", GO_BETA_CHANNEL);
	form.append("platform", artifact.platform);
	form.append("filename", artifact.filename);
	form.append("size", String(artifact.size));
	form.append("sha512", artifact.sha512);
	if (releaseNotes) {
		form.append(
			"releaseNotes",
			typeof releaseNotes === "string" ? releaseNotes : JSON.stringify(releaseNotes),
		);
	}
	form.append("zstdPatch", new Blob([patch]), `${artifact.filename}.zstd-patch`);
	form.append(
		"zstdPatchMeta",
		new Blob([`${JSON.stringify(patchMeta, null, "\t")}\n`]),
		`${artifact.filename}.zstd-patch.meta.json`,
	);

	const resp = await fetch(`${SERVER}/api/v2/products/${GO_BETA_PRODUCT}/releases`, {
		method: "POST",
		headers: { Authorization: `Bearer ${TOKEN}` },
		body: form,
	});
	if (!resp.ok) {
		const data = (await resp.json().catch(() => ({}))) as { error?: string };
		console.error(
			`❌ Upload failed for ${artifact.platform}: ${data.error ?? `HTTP ${resp.status}`}`,
		);
		process.exit(1);
	}
	const result = (await resp.json()) as { success?: boolean; error?: string };
	if (!result.success) {
		console.error(`❌ Upload failed for ${artifact.platform}: ${result.error ?? "unknown error"}`);
		process.exit(1);
	}
	console.log(`✓ Uploaded ${artifact.platform} metadata + patch only`);
}

console.log(`✅ Go beta release v${version} complete (${selectedArtifacts.length} platform(s))`);
