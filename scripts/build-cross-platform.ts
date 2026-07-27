/**
 * Cross-platform build script: compiles NarraFork for multiple platforms.
 *
 * Usage:
 *   bun scripts/build-cross-platform.ts                    # build all platforms
 *   bun scripts/build-cross-platform.ts --platform=darwin-arm64  # specific platform
 *   bun scripts/build-cross-platform.ts --skip-frontend    # skip Vite build
 */
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Worker } from "node:worker_threads";
import type { LocalizedValue } from "../shared/i18n-locales";
import {
	type BinaryMetadata,
	formatChecksumsReport,
	formatSha256Sums,
} from "./lib/binary-metadata";
import { formatLatestYmlFiles, type LatestYmlEntry } from "./lib/latest-yml";

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
type ChangelogEntry = { version: string; date: string } & LocalizedValue<string>;
const changelogEntries: ChangelogEntry[] = [];
if (existsSync(changelogsDir)) {
	for (const name of readdirSync(changelogsDir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(changelogsDir, name), "utf-8"));
			if (
				typeof parsed.version === "string" &&
				typeof parsed.date === "string" &&
				typeof parsed.en === "string"
			) {
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
export const embeddedChangelogs = ${JSON.stringify(changelogEntries, null, "\t")} as const;
`;
writeFileSync(GENERATED_CHANGELOG_FILE, changelogCode);
console.log(
	`✓ Generated ${relative(ROOT, GENERATED_CHANGELOG_FILE)} (${changelogEntries.length} entries)`,
);

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
			// Additional entry point: the database read worker. `new Worker()` specifiers are NOT
			// followed by the bundler, so without listing it here the worker module is simply absent
			// from the binary and every spawn fails with ModuleNotFound. It is embedded as
			// `worker-entry.js` (note the rewritten extension), which is what pool.ts resolves at
			// runtime when it detects the compiled runtime.
			"./server/lib/db-worker/worker-entry.ts",
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
// Each platform runs in its own worker thread for true parallelism.
// Workers send log messages back immediately for real-time output.

interface WorkerResult {
	latestYml: LatestYmlEntry;
	metadata?: BinaryMetadata;
}

function runPostProcessWorker(
	platform: (typeof selectedPlatforms)[number],
): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(join(import.meta.dir, "post-process-worker.ts"), {
			workerData: {
				platform,
				distDir: DIST_DIR,
				root: ROOT,
				version: VERSION,
				commit: commitHash,
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
					resolve({ latestYml: msg.latestYml!, metadata: msg.metadata });
				}
			},
		);

		worker.on("error", reject);
		worker.on("exit", (code) => {
			if (code !== 0) reject(new Error(`Worker for ${platform.platformId} exited with code ${code}`));
		});
	});
}

console.log(`\n→ Post-processing ${selectedPlatforms.length} platforms in parallel...`);
const postStart = performance.now();
const results = await Promise.all(selectedPlatforms.map(runPostProcessWorker));
const postMs = (performance.now() - postStart).toFixed(0);

// Write latest*.yml files as family manifests. Multiple architectures share one
// metadata file; aggregate every binary instead of letting the last worker win.
const latestYmlFiles = formatLatestYmlFiles(results.map((result) => result.latestYml));
for (const [name, content] of latestYmlFiles) {
	writeFileSync(join(DIST_DIR, name), content);
}
console.log(`\n✓ Post-processing completed in ${postMs}ms`);

// Write aggregate checksum files (verifiable provenance for every binary).
// Best-effort: a failure here must not fail the build.
const metadataEntries = results
	.map((r) => r.metadata)
	.filter((m): m is BinaryMetadata => m !== undefined);

const aggregateFiles: string[] = [];
if (metadataEntries.length > 0) {
	try {
		const sumsName = `narrafork-${VERSION}-SHA256SUMS`;
		const reportName = `narrafork-${VERSION}-checksums.txt`;
		writeFileSync(join(DIST_DIR, sumsName), formatSha256Sums(metadataEntries));
		writeFileSync(join(DIST_DIR, reportName), formatChecksumsReport(VERSION, metadataEntries));
		aggregateFiles.push(sumsName, reportName);
		console.log(
			`✓ Wrote aggregate checksums for ${metadataEntries.length} binaries (${sumsName}, ${reportName})`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`⚠ Failed to write aggregate checksum files: ${message}`);
	}
} else {
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
