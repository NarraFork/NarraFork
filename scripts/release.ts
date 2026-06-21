/**
 * Release script: bump version, tag, build, and upload to update server.
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
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const DIST_DIR = join(ROOT, "dist");

// ── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const skipBuild = args.includes("--skip-build");
const uploadOnly = args.includes("--upload-only");
const changelogArg = args.find((a) => a.startsWith("--changelog="))?.split("=").slice(1).join("=");
const platformArg = args.find((a) => a.startsWith("--platform="))?.split("=").slice(1).join("=");

if (!version) {
	console.error("Usage: bun scripts/release.ts <version> [options]");
	console.error("");
	console.error("Options:");
	console.error("  --changelog=<file>    JSON file with localized release notes");
	console.error("  --platform=<target>   Build and upload only this platform (e.g. windows-x64)");
	console.error("  --dry-run             Build only, do not upload or tag");
	console.error("  --skip-build          Skip compilation (use existing dist/)");
	console.error("  --upload-only         Only upload, skip version bump and build");
	process.exit(1);
}

// Allow semver with optional pre-release suffix: 0.1.0, 0.1.0-fix1, 0.2.0-beta.3, etc.
if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/.test(version)) {
	console.error(`❌ Invalid version format: ${version} (expected: x.y.z or x.y.z-prerelease)`);
	process.exit(1);
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

// ── Step 2: Git commit & tag ────────────────────────────────────────────────

if (!uploadOnly && !dryRun) {
	try {
		// Files to include in the release commit: always package.json, plus the
		// changelog for this version when present so it never gets left behind
		// as an untracked file (the changelog must ship with the release).
		const commitPaths = ["package.json"];
		if (existsSync(changelogPath)) {
			const relChangelog = relative(ROOT, changelogPath);
			// Only stage the changelog when it lives inside the repo; a custom
			// --changelog path outside ROOT can't be committed here.
			if (relChangelog && !relChangelog.startsWith("..") && !isAbsolute(relChangelog)) {
				commitPaths.push(relChangelog);
			} else {
				console.warn(
					`⚠ Changelog ${changelogPath} is outside the repo; not adding it to the release commit`,
				);
			}
		}
		const quotedPaths = commitPaths.map((p) => `"${p}"`).join(" ");

		// Check if any of those files have pending changes to commit
		const status = execSync(`git status --porcelain ${quotedPaths}`, {
			cwd: ROOT,
			encoding: "utf-8",
		}).trim();

		if (status) {
			execSync(`git add ${quotedPaths} && git commit -m "release: v${version}"`, {
				cwd: ROOT,
				stdio: "inherit",
			});
			console.log(`✓ Committed release: v${version}`);
		}

		// Check if tag already exists
		const existingTags = execSync("git tag --list", { cwd: ROOT, encoding: "utf-8" });
		if (existingTags.includes(`v${version}`)) {
			console.log(`ℹ Tag v${version} already exists, skipping`);
		} else {
			execSync(`git tag v${version}`, { cwd: ROOT, stdio: "inherit" });
			console.log(`✓ Tagged: v${version}`);
		}
	} catch (err) {
		console.error(`❌ Git operations failed: ${err}`);
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

// ── Step 4: Upload ──────────────────────────────────────────────────────────

if (dryRun) {
	console.log("\n✅ Dry run complete — skipping upload");
	process.exit(0);
}

// Platform mapping: dist filename suffix → update server platform ID
const PLATFORM_MAP: Record<string, string> = {
	"linux-x64": "linux-x64",
	"linux-x64-baseline": "linux-x64-baseline",
	"linux-arm64": "linux-arm64",
	"macos-arm64": "darwin-arm64",
	"macos-x64": "darwin-x64",
	"windows-x64.exe": "win-x64",
	"windows-x64-baseline.exe": "win-x64-baseline",
};

// When --platform is specified, filter the upload map to matching entries.
// The platformArg uses build-script naming (e.g. "windows-x64"), while the
// PLATFORM_MAP keys use dist filename suffixes (e.g. "windows-x64.exe").
const uploadEntries = platformArg
	? Object.entries(PLATFORM_MAP).filter(([suffix]) => {
			const bare = suffix.replace(/\.exe$/, "");
			return bare === platformArg || suffix === platformArg;
		})
	: Object.entries(PLATFORM_MAP);

console.log("\n→ Uploading to update server...\n");

const prefix = `narrafork-${version}-`;
let uploaded = 0;
let failed = 0;

for (const [suffix, platform] of uploadEntries) {
	const filename = `${prefix}${suffix}`;
	const metaPath = join(DIST_DIR, `${filename}.zstd-patch.meta.json`);
	const patchPath = join(DIST_DIR, `${filename}.zstd-patch`);

	if (!existsSync(metaPath)) {
		console.log(`  ⏭ ${platform}: no zstd patch meta, skipping`);
		continue;
	}

	const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
	const sha512 = meta.newFileSha512;
	const size = meta.newFileSize;

	if (!sha512 || !size) {
		console.log(`  ⏭ ${platform}: incomplete meta, skipping`);
		continue;
	}

	// Build multipart form
	// Channel: x.y.0 → stable, anything else (x.y.z where z>0, or pre-release) → beta
	const channel = /^\d+\.\d+\.0$/.test(version) ? "stable" : "beta";
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

	if (existsSync(patchPath)) {
		const patchBuf = readFileSync(patchPath);
		form.append("zstdPatch", new Blob([patchBuf]), `${filename}.zstd-patch`);
	}

	const metaBuf = readFileSync(metaPath);
	form.append("zstdPatchMeta", new Blob([metaBuf]), `${filename}.zstd-patch.meta.json`);

	try {
		const resp = await fetch(`${SERVER}/api/v2/products/narrafork/releases`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
			body: form,
		});

		const data = (await resp.json()) as { success?: boolean; error?: string };
		if (data.success) {
			const patchSize = existsSync(patchPath)
				? `${(readFileSync(patchPath).length / 1024).toFixed(0)}KB patch`
				: "no patch";
			console.log(`  ✓ ${platform}: ${patchSize}`);
			uploaded++;
		} else {
			console.error(`  ❌ ${platform}: ${data.error ?? "unknown error"}`);
			failed++;
		}
	} catch (err) {
		console.error(`  ❌ ${platform}: ${err}`);
		failed++;
	}
}

console.log(`\n✅ Release v${version} complete: ${uploaded} uploaded, ${failed} failed`);

if (failed > 0) {
	process.exit(1);
}
