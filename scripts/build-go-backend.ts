/**
 * Build NarraFork Go backend binaries for one or more platforms.
 *
 * Usage:
 *   bun scripts/build-go-backend.ts
 *   bun scripts/build-go-backend.ts --platform=linux-x64
 *   bun scripts/build-go-backend.ts --platform=all --dry-run
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
	buildBinaryFilename,
	buildBinaryPath,
	buildLdflags,
	GO_BUILD_CHANNEL,
	GO_BUILD_OUTPUT_DIR,
	GO_ROOT,
	getGoTargets,
	hasFlag,
	listGoPlatforms,
	loadChangelog,
	parseArg,
	safeVersionSegment,
	sha512Base64ForFile,
	versionOutputDir,
	writeJsonPretty,
} from "./go-backend-shared";

const args = process.argv.slice(2);
const platformArg = parseArg(args, "platform");
const versionArg = parseArg(args, "version");
const commitArg = parseArg(args, "commit");
const channelArg = parseArg(args, "channel");
const outDirArg = parseArg(args, "out-dir");
const dryRun = hasFlag(args, "dry-run");
const changelogArg = parseArg(args, "changelog");

const pkg = JSON.parse(readFileSync(join(GO_ROOT, "..", "package.json"), "utf-8"));
const gitCommitResult = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
	cwd: GO_ROOT,
	stdout: "pipe",
	stderr: "pipe",
});
const version = (versionArg ?? pkg.version ?? "0.0.0").trim();
const commit = (
	commitArg ?? new TextDecoder().decode(gitCommitResult.stdout ?? new Uint8Array()).trim()
).trim();
const channel = (channelArg ?? GO_BUILD_CHANNEL).trim();
const outDir = resolve(outDirArg ?? GO_BUILD_OUTPUT_DIR);
const selectedTargets = getGoTargets(platformArg);

if (selectedTargets.length === 0) {
	console.error(`❌ Unknown platform: ${platformArg ?? "(empty)"}`);
	console.error(`Available: ${listGoPlatforms().join(", ")} or all`);
	process.exit(1);
}

if (dryRun) {
	console.log(`→ Go beta build dry-run`);
	console.log(`  version: ${version}`);
	console.log(`  commit: ${commit || "(unknown)"}`);
	console.log(`  channel: ${channel}`);
	console.log(`  output: ${join(outDir, safeVersionSegment(version))}`);
	for (const target of selectedTargets) {
		console.log(`  - ${target.platform} → ${buildBinaryFilename(version, target)}`);
	}
	if (changelogArg) {
		console.log(`  changelog: ${changelogArg}`);
	}
	process.exit(0);
}

const versionDir = versionOutputDir(version, outDir);
mkdirSync(versionDir, { recursive: true });

const ldflags = buildLdflags(version, commit, channel);
const builtArtifacts = [] as Array<{
	platform: string;
	goos: string;
	goarch: string;
	filename: string;
	path: string;
	size: number;
	sha512: string;
	channel: string;
}>;

for (const target of selectedTargets) {
	const outfile = buildBinaryPath(version, target, outDir);
	console.log(`→ Building ${target.platform}...`);
	const result = Bun.spawnSync(
		[
			"go",
			"build",
			"-trimpath",
			"-buildvcs=false",
			"-ldflags",
			ldflags,
			"-o",
			outfile,
			"./cmd/narrafork-go",
		],
		{
			cwd: GO_ROOT,
			env: {
				...process.env,
				CGO_ENABLED: "0",
				GOOS: target.goos,
				GOARCH: target.goarch,
				NARRAFORK_VERSION: version,
				NARRAFORK_COMMIT: commit,
				NARRAFORK_BUILD_CHANNEL: channel,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (result.exitCode !== 0) {
		const stdout = new TextDecoder().decode(result.stdout ?? new Uint8Array());
		const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array());
		console.error(`❌ go build failed for ${target.platform}`);
		if (stdout.trim()) console.error(stdout.trim());
		if (stderr.trim()) console.error(stderr.trim());
		process.exit(result.exitCode ?? 1);
	}
	const size = Bun.file(outfile).size;
	const sha512 = sha512Base64ForFile(outfile);
	const shaPath = `${outfile}.sha512`;
	writeFileSync(shaPath, `${sha512}  ${buildBinaryFilename(version, target)}\n`);
	builtArtifacts.push({
		platform: target.platform,
		goos: target.goos,
		goarch: target.goarch,
		filename: buildBinaryFilename(version, target),
		path: outfile,
		size,
		sha512,
		channel,
	});
	console.log(`✓ ${target.platform}: ${buildBinaryFilename(version, target)}`);
}

const manifest = {
	version,
	commit,
	channel,
	backend: "go",
	buildChannel: channel,
	generatedAt: new Date().toISOString(),
	changelog: loadChangelog(version, changelogArg),
	artifacts: builtArtifacts.map(({ path, ...artifact }) => artifact),
};

writeJsonPretty(join(versionDir, "manifest.json"), manifest);
console.log(`✓ Wrote manifest to ${join(versionDir, "manifest.json")}`);
console.log(`✓ Go beta build complete (${builtArtifacts.length} artifacts)`);
