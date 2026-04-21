/**
 * Cross-platform build script: compiles NarraFork for multiple platforms.
 *
 * Usage:
 *   bun scripts/build-cross-platform.ts                    # build all platforms
 *   bun scripts/build-cross-platform.ts --platform=darwin-arm64  # specific platform
 *   bun scripts/build-cross-platform.ts --skip-frontend    # skip Vite build
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { generateZstdPatch } from "../server/lib/zstd-patch";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const VERSION: string = pkg.version ?? "0.0.0";
const FRONTEND_DIR = join(ROOT, "dist", "frontend");
const DRIZZLE_DIR = join(ROOT, "drizzle");
const DRIZZLE_JOURNAL_PATH = join(DRIZZLE_DIR, "meta", "_journal.json");
const GENERATED_FILE = join(ROOT, "server", "generated", "embedded-frontend.ts");
const GENERATED_MIGRATIONS_DATA_FILE = join(
	ROOT,
	"server",
	"generated",
	"embedded-migrations-data.ts",
);
const GENERATED_BUILD_INFO_FILE = join(ROOT, "server", "generated", "build-info.ts");
const GENERATED_CHANGELOG_FILE = join(ROOT, "server", "generated", "embedded-changelog.ts");
const DIST_DIR = join(ROOT, "dist");

function getLatestYmlName(target: string): string {
	if (target.includes("darwin")) return "latest-mac.yml";
	if (target.includes("windows")) return "latest.yml";
	return "latest-linux.yml";
}

interface LatestYmlOptions {
	version: string;
	path: string;
	sha512: string;
	fileSize: number;
}

function generateLatestYml(opts: LatestYmlOptions): string {
	const releaseDate = new Date().toISOString();
	return `version: ${opts.version}
releaseDate: "${releaseDate}"
path: ${opts.path}
sha512: ${opts.sha512}
files:
  - url: ${opts.path}
    size: ${opts.fileSize}
    sha512: ${opts.sha512}
`;
}

// ============================================================================
// Main build script
// ============================================================================

// Parse CLI arguments
const args = process.argv.slice(2);
const skipFrontend = args.includes("--skip-frontend");
const platformArg = args.find((a) => a.startsWith("--platform="))?.split("=")[1];

// Available platforms
// NOTE: platformId must match the format returned by getPlatform() in update-service.ts
// (e.g. "darwin-arm64", "win-x64", "linux-x64-baseline")
const PLATFORMS = [
	{ target: "bun-darwin-arm64", platformId: "darwin-arm64", name: `narrafork-${VERSION}-macos-arm64` },
	{ target: "bun-darwin-x64", platformId: "darwin-x64", name: `narrafork-${VERSION}-macos-x64` },
	{ target: "bun-linux-x64", platformId: "linux-x64", name: `narrafork-${VERSION}-linux-x64` },
	{ target: "bun-linux-x64-baseline", platformId: "linux-x64-baseline", name: `narrafork-${VERSION}-linux-x64-baseline` },
	{ target: "bun-linux-arm64", platformId: "linux-arm64", name: `narrafork-${VERSION}-linux-arm64` },
	{ target: "bun-windows-x64", platformId: "win-x64", name: `narrafork-${VERSION}-windows-x64.exe` },
	{ target: "bun-windows-x64-baseline", platformId: "win-x64-baseline", name: `narrafork-${VERSION}-windows-x64-baseline.exe` },
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

// Step 1: Build frontend with Vite
if (!skipFrontend) {
	console.log("→ Building frontend...");
	const vite = Bun.spawnSync(["bunx", "vite", "build", "--config", "frontend/vite.config.ts"], {
		cwd: ROOT,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (vite.exitCode !== 0) {
		console.error("❌ Frontend build failed");
		process.exit(1);
	}
	console.log("✓ Frontend built");
}

// Step 1b: Download @parcel/watcher native binaries for all platforms
{
	console.log("→ Downloading @parcel/watcher native binaries...");
	const dl = Bun.spawnSync(["bun", "scripts/download-parcel-watcher.ts"], {
		cwd: ROOT,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (dl.exitCode !== 0) {
		console.error("❌ @parcel/watcher binary download failed");
		process.exit(1);
	}
}

// Step 2: Scan dist/frontend/ and collect all files
function walkDir(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			results.push(...walkDir(full));
		} else {
			results.push(full);
		}
	}
	return results;
}

if (!existsSync(FRONTEND_DIR)) {
	console.error(`❌ Frontend directory not found: ${FRONTEND_DIR}`);
	console.log("Run without --skip-frontend to build it first");
	process.exit(1);
}

const files = walkDir(FRONTEND_DIR);
const relFiles = files.map((f) => relative(ROOT, f));

// Step 3: Generate server/generated/embedded-frontend.ts
const imports: string[] = [];
const mapEntries: string[] = [];

for (let i = 0; i < relFiles.length; i++) {
	const rel = relFiles[i];
	// Always use forward slashes for URL paths (Windows path.relative returns backslashes)
	const urlPath = `/${relative("dist/frontend", rel).replaceAll("\\", "/")}`;
	const importPath = `../../${rel.replaceAll("\\", "/")}`;

	imports.push(`import _f${i} from ${JSON.stringify(importPath)} with { type: "file" };`);
	mapEntries.push(`\t${JSON.stringify(urlPath)}: _f${i},`);
}

const code = `// AUTO-GENERATED by scripts/build-cross-platform.ts — DO NOT EDIT
${imports.join("\n")}

/** URL path → embedded file path (resolved at compile time via $bunfs) */
export const embeddedAssets: Record<string, string> = {
${mapEntries.join("\n")}
};
`;

const generatedDir = join(ROOT, "server", "generated");
if (!existsSync(generatedDir)) {
	mkdirSync(generatedDir, { recursive: true });
}
writeFileSync(GENERATED_FILE, code);
console.log(`✓ Generated ${relative(ROOT, GENERATED_FILE)} (${relFiles.length} files)`);

// Step 4: Generate embedded migration data
type DrizzleJournal = {
	entries: Array<{ tag: string }>;
};

if (!existsSync(DRIZZLE_JOURNAL_PATH)) {
	console.error(`❌ Drizzle migration journal not found: ${relative(ROOT, DRIZZLE_JOURNAL_PATH)}`);
	console.error("Run `bun run db:generate` first, then re-run the build.");
	process.exit(1);
}

const journalJson = readFileSync(DRIZZLE_JOURNAL_PATH, "utf-8");
const journal = JSON.parse(journalJson) as DrizzleJournal;
const sqlFiles = journal.entries.map((entry) => {
	const fileName = `${entry.tag}.sql`;
	const filePath = join(DRIZZLE_DIR, fileName);
	if (!existsSync(filePath)) {
		console.error(`❌ Drizzle migration SQL file missing: ${relative(ROOT, filePath)}`);
		process.exit(1);
	}
	return {
		name: fileName,
		content: readFileSync(filePath, "utf-8"),
	};
});

const sqlEntries = sqlFiles
	.map(
		(file) => `\t{ name: ${JSON.stringify(file.name)}, content: ${JSON.stringify(file.content)} },`,
	)
	.join("\n");

const migrationsCode = `// AUTO-GENERATED by scripts/build-cross-platform.ts — DO NOT EDIT
export const embeddedMigrationJournalJson = ${JSON.stringify(journalJson)};

export const embeddedMigrationSqlFiles: ReadonlyArray<{ name: string; content: string }> = [
${sqlEntries}
];
`;

writeFileSync(GENERATED_MIGRATIONS_DATA_FILE, migrationsCode);
console.log(
	`✓ Generated ${relative(ROOT, GENERATED_MIGRATIONS_DATA_FILE)} (${sqlFiles.length} migrations)`,
);

// Step 5: Generate build info (placeholder, will be overwritten per-platform in loop)
let commitHash = "";
try {
	commitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {
	// git not available
}
// Initial placeholder with unknown platform (will be replaced per-platform)
const buildInfoCode = `// AUTO-GENERATED by scripts/build-cross-platform.ts — DO NOT EDIT
export const buildVersion = ${JSON.stringify(VERSION)};
export const buildCommit = ${JSON.stringify(commitHash)};
export const buildPlatform = "unknown";
`;
writeFileSync(GENERATED_BUILD_INFO_FILE, buildInfoCode);
console.log(
	`✓ Generated ${relative(ROOT, GENERATED_BUILD_INFO_FILE)} (v${VERSION}, ${commitHash || "no commit"})`,
);

// Step 5b: Generate embedded changelog data
const changelogsDir = join(ROOT, "changelogs");
const changelogEntries: Array<{ version: string; date: string; en: string; "zh-CN": string }> = [];
if (existsSync(changelogsDir)) {
	for (const name of readdirSync(changelogsDir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(changelogsDir, name), "utf-8"));
			if (parsed.version && parsed.date) {
				changelogEntries.push(parsed);
			}
		} catch {
			// skip malformed files
		}
	}
}
changelogEntries.sort((a, b) => {
	const pa = a.version.split(".").map(Number);
	const pb = b.version.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
	}
	return 0;
});
const changelogCode = `// AUTO-GENERATED by scripts/build-cross-platform.ts — DO NOT EDIT
export const embeddedChangelogs: ReadonlyArray<{
	version: string;
	date: string;
	en: string;
	"zh-CN": string;
}> = ${JSON.stringify(changelogEntries, null, "\t")};
`;
writeFileSync(GENERATED_CHANGELOG_FILE, changelogCode);
console.log(
	`✓ Generated ${relative(ROOT, GENERATED_CHANGELOG_FILE)} (${changelogEntries.length} entries)`,
);

// Step 6: Compile for each platform (serial — shared build-info.ts requires sequential writes)
if (!existsSync(DIST_DIR)) {
	mkdirSync(DIST_DIR, { recursive: true });
}

/**
 * Find rcodesign binary for cross-platform ad-hoc signing of macOS binaries.
 * Search order: system PATH → ~/.narrafork/bin/rcodesign
 */
function findRcodesign(): string | null {
	// Check system PATH
	try {
		const check = Bun.spawnSync(["rcodesign", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (check.exitCode === 0) return "rcodesign";
	} catch {
		// rcodesign not in PATH
	}

	// Check ~/.narrafork/bin/
	const localPath = join(homedir(), ".narrafork", "bin", "rcodesign");
	if (existsSync(localPath)) {
		try {
			const localCheck = Bun.spawnSync([localPath, "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (localCheck.exitCode === 0) return localPath;
		} catch {
			// local binary exists but failed to execute
		}
	}

	return null;
}

/**
 * Ad-hoc sign a macOS Mach-O binary.
 * Tries rcodesign first (works on any OS), falls back to native codesign on macOS.
 * Returns log lines instead of printing directly (for parallel-safe output).
 */
function adHocSign(filePath: string): { signed: boolean; logs: string[] } {
	const logs: string[] = [];
	const rcodesign = findRcodesign();
	if (rcodesign) {
		const result = Bun.spawnSync([rcodesign, "sign", filePath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			logs.push(`✓ Ad-hoc signed (rcodesign): ${relative(ROOT, filePath)}`);
			return { signed: true, logs };
		}
		const stderr = new TextDecoder().decode(result.stderr);
		logs.push(`⚠ rcodesign failed: ${stderr.trim()}`);
	}

	// Fallback: native codesign on macOS
	if (process.platform === "darwin") {
		const result = Bun.spawnSync(["codesign", "--force", "--sign", "-", filePath], {
			cwd: ROOT,
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (result.exitCode === 0) {
			logs.push(`✓ Ad-hoc signed (codesign): ${relative(ROOT, filePath)}`);
			return { signed: true, logs };
		}
	}

	return { signed: false, logs };
}

// Phase 1: Serial compilation (each platform needs its own buildPlatform in build-info.ts)
const compileStart = performance.now();
for (const platform of selectedPlatforms) {
	console.log(`\n→ Compiling for ${platform.target}...`);

	// Inject build platform constant before compiling
	writeFileSync(
		GENERATED_BUILD_INFO_FILE,
		`// AUTO-GENERATED by scripts/build-cross-platform.ts — DO NOT EDIT
export const buildVersion = ${JSON.stringify(VERSION)};
export const buildCommit = ${JSON.stringify(commitHash)};
export const buildPlatform = ${JSON.stringify(platform.platformId)};
`,
	);

	const outfile = join(DIST_DIR, platform.name);

	const compile = Bun.spawnSync(
		[
			"bun",
			"build",
			"./server/index.ts",
			"--compile",
			"--minify",
			"--target",
			platform.target,
			"--asset-naming=[dir]/[name].[ext]",
			// electron is referenced by puppeteer-core but never used in headless mode
			"--external=electron",
			"--outfile",
			outfile,
		],
		{
			cwd: ROOT,
			stdio: ["inherit", "inherit", "inherit"],
		},
	);

	if (compile.exitCode !== 0) {
		console.error(`❌ Compilation failed for ${platform.target}`);
		process.exit(1);
	}

	console.log(`✓ Built: ${relative(ROOT, outfile)}`);
}
const compileMs = (performance.now() - compileStart).toFixed(0);
console.log(`\n✓ All ${selectedPlatforms.length} platforms compiled in ${compileMs}ms`);

// Phase 2: Post-processing (signing, SHA-512, zstd patch, latest.yml metadata)
// NOTE: adHocSign uses Bun.spawnSync and all I/O is synchronous (readFileSync, createHash),
// so Promise.all does not yield true parallelism here. The async structure is kept for
// future migration to async spawn and to collect logs per-platform without interleaving.
interface PostProcessResult {
	platform: (typeof selectedPlatforms)[number];
	logs: string[];
	latestYml: { name: string; content: string } | null;
}

async function postProcess(
	platform: (typeof selectedPlatforms)[number],
): Promise<PostProcessResult> {
	const logs: string[] = [];
	const outfile = join(DIST_DIR, platform.name);

	// Ad-hoc codesign for macOS targets (required to bypass Gatekeeper "damaged" error)
	// Signing MUST happen before SHA512 computation and patch generation so that
	// delta patches are based on the signed binary (matching what users actually run).
	if (platform.target.includes("darwin")) {
		const { signed, logs: signLogs } = adHocSign(outfile);
		logs.push(...signLogs);
		if (!signed) {
			logs.push(
				`⚠ Ad-hoc signing failed — users may need to run: codesign --force --sign - ${relative(ROOT, outfile)}`,
			);
		}
	}

	// Compute SHA-512 and file size for latest.yml
	const fileSha512 = createHash("sha512").update(readFileSync(outfile)).digest("base64");
	const fileSize = statSync(outfile).size;

	// Generate zstd dictionary patch against previous version
	const prevBinary = findPreviousVersionBinary(platform.name, VERSION);
	if (prevBinary) {
		logs.push(`→ Generating zstd patch from ${relative(ROOT, prevBinary.path)}...`);
		try {
			const oldBuf = readFileSync(prevBinary.path);
			const newBuf = readFileSync(outfile);

			const { patch, meta } = generateZstdPatch(oldBuf, newBuf, {
				fromVersion: prevBinary.version,
				toVersion: VERSION,
			});

			const patchPath = `${outfile}.zstd-patch`;
			const metaPath = `${outfile}.zstd-patch.meta.json`;
			writeFileSync(patchPath, patch);
			writeFileSync(metaPath, JSON.stringify(meta, null, 2));

			const savings = ((1 - patch.length / newBuf.length) * 100).toFixed(1);
			logs.push(
				`✓ Zstd patch: ${relative(ROOT, patchPath)} (${(patch.length / 1024).toFixed(0)}KB, ${savings}% savings)`,
			);
		} catch (err) {
			logs.push(`⚠ Zstd patch generation failed: ${err}`);
		}
	} else {
		logs.push("ℹ No previous version found for zstd patch generation");
	}

	// Prepare latest.yml content (written later to avoid parallel write conflicts)
	const latestYml = {
		name: getLatestYmlName(platform.target),
		content: generateLatestYml({
			version: VERSION,
			path: platform.name,
			sha512: fileSha512,
			fileSize,
		}),
	};

	return { platform, logs, latestYml };
}

console.log(`\n→ Post-processing ${selectedPlatforms.length} platforms...`);
const postStart = performance.now();
const results = await Promise.all(selectedPlatforms.map(postProcess));
const postMs = (performance.now() - postStart).toFixed(0);

// Print collected logs per platform (avoids interleaved output)
for (const result of results) {
	console.log(`\n[${result.platform.platformId}]`);
	for (const line of result.logs) {
		console.log(`  ${line}`);
	}
}

// Write latest.yml files (serial — same OS family shares one file, last writer wins)
for (const result of results) {
	if (result.latestYml) {
		const ymlPath = join(DIST_DIR, result.latestYml.name);
		writeFileSync(ymlPath, result.latestYml.content);
	}
}
console.log(`\n✓ Post-processing completed in ${postMs}ms`);

console.log("\n✅ All builds completed!");
console.log("\nBuilt executables:");
for (const platform of selectedPlatforms) {
	console.log(`  - dist/${platform.name}`);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find the most recent previous version binary for the same platform in dist/.
 * Returns null if no previous version exists.
 */
function findPreviousVersionBinary(
	currentName: string,
	currentVersion: string,
): { path: string; version: string } | null {
	// Extract platform suffix from name: "narrafork-0.0.17-linux-x64" → "linux-x64"
	const versionedPrefix = `narrafork-${currentVersion}-`;
	if (!currentName.startsWith(versionedPrefix)) return null;
	const platformSuffix = currentName.slice(versionedPrefix.length);

	// Scan dist/ for same-platform binaries with different versions
	const candidates: { version: string; path: string }[] = [];
	const pattern = new RegExp(
		`^narrafork-(\\d+\\.\\d+\\.\\d+)-${platformSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
	);

	for (const name of readdirSync(DIST_DIR)) {
		const m = name.match(pattern);
		if (m && m[1] !== currentVersion) {
			candidates.push({ version: m[1], path: join(DIST_DIR, name) });
		}
	}

	if (candidates.length === 0) return null;

	// Sort by version descending, pick the latest one before current
	candidates.sort((a, b) => {
		const pa = a.version.split(".").map(Number);
		const pb = b.version.split(".").map(Number);
		for (let i = 0; i < 3; i++) {
			if (pa[i] !== pb[i]) return pb[i] - pa[i]; // descending
		}
		return 0;
	});

	// Pick the highest version that is less than current
	const currentParts = currentVersion.split(".").map(Number);
	for (const c of candidates) {
		const parts = c.version.split(".").map(Number);
		let isLess = false;
		for (let i = 0; i < 3; i++) {
			if (parts[i] < currentParts[i]) {
				isLess = true;
				break;
			}
			if (parts[i] > currentParts[i]) break;
		}
		if (isLess) return c;
	}

	return null;
}
