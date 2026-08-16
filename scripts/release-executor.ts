/**
 * Remote executor release script: cross-compile, digest, and publish to the
 * update server's public tools channel.
 *
 * The executor is distributed through `tools/` rather than the product/release
 * system because it is a standalone helper binary with its own platform matrix
 * (Go GOOS-GOARCH pairs, including windows-arm64) that the release platform
 * whitelist does not model, and because it has no delta-patch upgrade path.
 *
 * Usage:
 *   bun scripts/release-executor.ts 0.5.24                      # build + publish all platforms
 *   bun scripts/release-executor.ts 0.5.24 --platform=linux-amd64
 *   bun scripts/release-executor.ts 0.5.24 --dry-run             # build + digest, no upload
 *   bun scripts/release-executor.ts 0.5.24 --upload-only         # publish existing dist/
 *
 * Environment:
 *   NF_UPDATE_SERVER  — update server URL (default: https://narrafork-update.b.domexie.cn)
 *   NF_UPDATE_TOKEN   — upload token for the tools API
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	type ExecutorPlatform,
	executorDistFilename,
	executorPublishedFilename,
	isExecutorPlatform,
} from "../shared/remote-executor";
import {
	buildExecutorManifest,
	type ExecutorArtifactInput,
	formatExecutorManifest,
	parseExecutorManifest,
} from "./lib/executor-manifest";

const ROOT = join(import.meta.dir, "..");
const EXECUTOR_DIR = join(ROOT, "remote-executor");
const EXECUTOR_DIST = join(EXECUTOR_DIR, "dist");
const PKG_PATH = join(ROOT, "package.json");

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/;
/** Guard against publishing a build whose binary is implausibly large or empty. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--")) ?? readPackageVersion();
const dryRun = args.includes("--dry-run");
const uploadOnly = args.includes("--upload-only");
const platformArg = args
	.find((a) => a.startsWith("--platform="))
	?.split("=")
	.slice(1)
	.join("=");

function readPackageVersion(): string {
	return (JSON.parse(readFileSync(PKG_PATH, "utf-8")) as { version: string }).version;
}

function fail(message: string): never {
	console.error(`❌ ${message}`);
	process.exit(1);
}

if (!VERSION_RE.test(version)) {
	fail(`Invalid version format: ${version} (expected x.y.z or x.y.z-prerelease)`);
}

const targetPlatforms: ExecutorPlatform[] = platformArg
	? platformArg
			.split(",")
			.map((value) => value.trim())
			.map((value) => {
				if (!isExecutorPlatform(value)) {
					fail(`Unknown platform: ${value}\n   Available: ${EXECUTOR_PLATFORMS.join(", ")}`);
				}
				return value;
			})
	: [...EXECUTOR_PLATFORMS];

function loadUpdateServerConfig(): { serverUrl: string; token: string } {
	const configPath = join(homedir(), ".narrafork", "update-server.json");
	let fileConfig: { serverUrl?: string; token?: string } = {};
	if (existsSync(configPath)) {
		try {
			fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch {
			// Ignore a malformed config; env vars may still supply everything.
		}
	}
	return {
		serverUrl:
			process.env.NF_UPDATE_SERVER ??
			fileConfig.serverUrl ??
			"https://narrafork-update.b.domexie.cn",
		token: process.env.NF_UPDATE_TOKEN ?? fileConfig.token ?? "",
	};
}

const { serverUrl: rawServer, token: TOKEN } = loadUpdateServerConfig();
const SERVER = rawServer.replace(/\/+$/, "");

if (!dryRun && !TOKEN) {
	fail(
		"Update server token not found\n" +
			'   Set NF_UPDATE_TOKEN or create ~/.narrafork/update-server.json: { "token": "nfup_..." }',
	);
}

function resolveProtocolVersion(): number {
	// The wire protocol version is the real compatibility boundary, so read it out
	// of the Go source instead of duplicating the number here.
	const source = readFileSync(join(EXECUTOR_DIR, "internal", "rpc", "protocol.go"), "utf-8");
	const match = source.match(/ProtocolVersion\s*=\s*(\d+)/);
	if (!match) fail("Could not read ProtocolVersion from remote-executor/internal/rpc/protocol.go");
	return Number.parseInt(match[1], 10);
}

function resolveCommit(): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: ROOT,
			encoding: "utf-8",
		}).trim();
	} catch {
		return "unknown";
	}
}

function buildPlatform(platform: ExecutorPlatform, commit: string, buildTime: string): void {
	const [os, arch] = platform.split("-");
	const output = join(EXECUTOR_DIST, executorDistFilename(platform));
	console.log(`  → ${platform}`);
	execFileSync(
		"go",
		[
			"build",
			"-trimpath",
			"-ldflags",
			[
				"-s",
				"-w",
				`-X github.com/narrafork/remote-executor/internal/buildinfo.Version=${version}`,
				`-X github.com/narrafork/remote-executor/internal/buildinfo.Commit=${commit}`,
				`-X github.com/narrafork/remote-executor/internal/buildinfo.BuildTime=${buildTime}`,
			].join(" "),
			"-o",
			output,
			"./cmd/narrafork-executor",
		],
		{
			cwd: EXECUTOR_DIR,
			stdio: ["ignore", "inherit", "inherit"],
			env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
		},
	);
}

async function putTool(filename: string, body: Uint8Array, contentType: string): Promise<void> {
	const response = await fetch(`${SERVER}/api/v2/tools/${filename}`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"Content-Type": contentType,
			"Content-Length": String(body.byteLength),
		},
		body,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
	}
	let parsed: { success?: boolean; sha512?: string } = {};
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		throw new Error(`Unexpected response body: ${text.slice(0, 200)}`);
	}
	if (!parsed.success) throw new Error(`Upload reported failure: ${text.slice(0, 200)}`);
}

console.log(`\n🚀 Publishing narrafork-executor v${version}`);
console.log(`   Platforms: ${targetPlatforms.join(", ")}`);
console.log(`   Server: ${dryRun ? "(dry run)" : SERVER}\n`);

const protocolVersion = resolveProtocolVersion();
console.log(`📡 Device protocol version: ${protocolVersion}`);

if (!uploadOnly) {
	console.log("\n🔨 Cross-compiling…");
	mkdirSync(EXECUTOR_DIST, { recursive: true });
	const commit = resolveCommit();
	const buildTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	for (const platform of targetPlatforms) {
		buildPlatform(platform, commit, buildTime);
	}
}

// ── Collect artifacts and build the manifest ────────────────────────────────

/**
 * Confirm a built artifact actually carries the version being published.
 *
 * The dist filenames are unversioned (`narrafork-executor-<os>-<arch>`), so a
 * stale artifact from an earlier build — a CI dry run, or a different version —
 * would otherwise be published under the wrong manifest version, and every
 * client would then report a version that does not match what it downloaded.
 *
 * `buildinfo.Version` is injected via ldflags and printed by `--version`, so it
 * can be read back out of the binary. Only host-executable artifacts can be run,
 * so cross-compiled targets fall back to scanning for the literal string.
 */
function assertArtifactVersion(platform: ExecutorPlatform, path: string, bytes: Buffer): void {
	const [os, arch] = platform.split("-");
	const hostArch = process.arch === "arm64" ? "arm64" : "amd64";
	const canExecute = os === "linux" && process.platform === "linux" && arch === hostArch;

	if (canExecute) {
		try {
			const reported = execFileSync(path, ["--version"], { encoding: "utf-8" }).trim();
			if (!reported.includes(version)) {
				fail(
					`Artifact for ${platform} reports "${reported}" but ${version} is being published.\n` +
						"   The dist artifact is stale. Rebuild without --upload-only.",
				);
			}
			return;
		} catch (error) {
			// Fall through to the byte scan rather than failing on an exec problem.
			console.warn(`  ⚠️  Could not run ${platform} artifact for a version check: ${String(error)}`);
		}
	}

	// Cross-compiled targets: the injected version string is present verbatim in
	// the binary's read-only data.
	if (!bytes.includes(Buffer.from(version, "utf-8"))) {
		fail(
			`Artifact for ${platform} does not contain the version string ${version}.\n` +
				"   The dist artifact is stale. Rebuild without --upload-only.",
		);
	}
}

const artifacts: ExecutorArtifactInput[] = [];
for (const platform of targetPlatforms) {
	const path = join(EXECUTOR_DIST, executorDistFilename(platform));
	if (!existsSync(path)) {
		fail(`Missing artifact for ${platform}: ${path}\n   Run without --upload-only to build it.`);
	}
	const size = statSync(path).size;
	if (size === 0) fail(`Artifact for ${platform} is empty: ${path}`);
	if (size > MAX_ARTIFACT_BYTES) {
		fail(`Artifact for ${platform} is ${size} bytes, above the ${MAX_ARTIFACT_BYTES} limit`);
	}
	const bytes = readFileSync(path);
	assertArtifactVersion(platform, path, bytes);
	artifacts.push({ platform, bytes: new Uint8Array(bytes) });
}

const manifest = buildExecutorManifest({
	version,
	protocolVersion,
	releasedAt: new Date().toISOString(),
	artifacts,
});
const manifestText = formatExecutorManifest(manifest);
// Round-trip through the consumer-side parser before publishing: if the writer
// and the reader ever disagree, fail here rather than on every client.
try {
	parseExecutorManifest(JSON.parse(manifestText));
} catch (error) {
	fail(`Generated manifest failed consumer validation: ${String(error)}`);
}
const manifestPath = join(EXECUTOR_DIST, EXECUTOR_MANIFEST_FILENAME);
writeFileSync(manifestPath, manifestText);

console.log("\n📦 Artifacts:");
for (const platform of targetPlatforms) {
	const entry = manifest.platforms[platform];
	if (!entry) continue;
	console.log(
		`  ${platform.padEnd(15)} ${(entry.size / 1024 / 1024).toFixed(2)} MB  sha256:${entry.sha256.slice(0, 16)}…`,
	);
}
console.log(`\n📄 Manifest written to ${manifestPath}`);

if (dryRun) {
	console.log("\n✅ Dry run complete — nothing uploaded");
	process.exit(0);
}

// ── Upload ──────────────────────────────────────────────────────────────────
//
// Binaries first, manifest last: a client that reads the manifest must always
// find every artifact it references already present.

console.log("\n☁️  Uploading…");
let uploaded = 0;
let failed = 0;

for (const artifact of artifacts) {
	const filename = executorPublishedFilename(version, artifact.platform);
	try {
		await putTool(filename, artifact.bytes, "application/octet-stream");
		console.log(`  ✓ ${filename}`);
		uploaded++;
	} catch (error) {
		console.error(`  ❌ ${filename}: ${error instanceof Error ? error.message : String(error)}`);
		failed++;
	}
}

if (failed > 0) {
	console.error(
		`\n❌ ${failed} artifact upload(s) failed — manifest not published so clients keep using the previous version`,
	);
	process.exit(1);
}

try {
	await putTool(
		EXECUTOR_MANIFEST_FILENAME,
		new Uint8Array(Buffer.from(manifestText)),
		"application/json",
	);
	console.log(`  ✓ ${EXECUTOR_MANIFEST_FILENAME}`);
} catch (error) {
	console.error(
		`  ❌ ${EXECUTOR_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}

console.log(`\n✅ Executor v${version} published (${uploaded} binaries + manifest)`);
if (targetPlatforms.length < EXECUTOR_PLATFORMS.length) {
	console.log(
		`⚠️  Only ${targetPlatforms.length}/${EXECUTOR_PLATFORMS.length} platforms were published; the manifest now lists just these.`,
	);
}
