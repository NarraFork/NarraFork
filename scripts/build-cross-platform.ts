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
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createGzip } from "node:zlib";

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
const DIST_DIR = join(ROOT, "dist");

// ============================================================================
// Blockmap generation utilities (must be defined before use)
// ============================================================================

const BLOCK_SIZE = 64 * 1024; // 64KB blocks

interface BlockmapFile {
	name: string;
	offset: number;
	checksums: string[];
	sizes: number[];
}

interface Blockmap {
	version: "2";
	files: BlockmapFile[];
}

interface BlockmapResult {
	blockmap: Blockmap;
	sha512: string;
	fileSize: number;
}

async function generateBlockmapForFile(filePath: string): Promise<BlockmapResult> {
	const fileSize = statSync(filePath).size;
	const checksums: string[] = [];
	const sizes: number[] = [];
	const sha512Hash = createHash("sha512");

	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { highWaterMark: BLOCK_SIZE });
		let currentBlock = Buffer.alloc(0);

		stream.on("data", (chunk: Buffer) => {
			sha512Hash.update(chunk);
			currentBlock = Buffer.concat([currentBlock, chunk]);

			while (currentBlock.length >= BLOCK_SIZE) {
				const block = currentBlock.subarray(0, BLOCK_SIZE);
				const hash = createHash("sha256").update(block).digest("base64");
				checksums.push(hash);
				sizes.push(BLOCK_SIZE);
				currentBlock = currentBlock.subarray(BLOCK_SIZE);
			}
		});

		stream.on("end", () => {
			if (currentBlock.length > 0) {
				const hash = createHash("sha256").update(currentBlock).digest("base64");
				checksums.push(hash);
				sizes.push(currentBlock.length);
			}

			const blockmap: Blockmap = {
				version: "2",
				files: [
					{
						name: filePath.split("/").pop() || filePath,
						offset: 0,
						checksums,
						sizes,
					},
				],
			};

			resolve({
				blockmap,
				sha512: sha512Hash.digest("base64"),
				fileSize,
			});
		});

		stream.on("error", reject);
	});
}

async function writeBlockmapToFile(blockmap: Blockmap, outputPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const json = JSON.stringify(blockmap);
		const gzip = createGzip({ level: 9 });
		const output = createWriteStream(outputPath);

		output.on("finish", resolve);
		output.on("error", reject);
		gzip.on("error", reject);

		gzip.pipe(output);
		gzip.end(json);
	});
}

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
const PLATFORMS = [
	{ target: "bun-darwin-arm64", name: `narrafork-${VERSION}-macos-arm64` },
	{ target: "bun-darwin-x64", name: `narrafork-${VERSION}-macos-x64` },
	{ target: "bun-linux-x64", name: `narrafork-${VERSION}-linux-x64` },
	{ target: "bun-linux-x64-baseline", name: `narrafork-${VERSION}-linux-x64-baseline` },
	{ target: "bun-linux-arm64", name: `narrafork-${VERSION}-linux-arm64` },
	{ target: "bun-windows-x64", name: `narrafork-${VERSION}-windows-x64.exe` },
	{ target: "bun-windows-x64-baseline", name: `narrafork-${VERSION}-windows-x64-baseline.exe` },
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

// Step 5: Generate build info
let commitHash = "";
try {
	commitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {
	// git not available
}
const buildInfoCode = `// AUTO-GENERATED by scripts/build-cross-platform.ts — DO NOT EDIT
export const buildVersion = ${JSON.stringify(VERSION)};
export const buildCommit = ${JSON.stringify(commitHash)};
`;
writeFileSync(GENERATED_BUILD_INFO_FILE, buildInfoCode);
console.log(
	`✓ Generated ${relative(ROOT, GENERATED_BUILD_INFO_FILE)} (v${VERSION}, ${commitHash || "no commit"})`,
);

// Step 6: Compile for each platform
if (!existsSync(DIST_DIR)) {
	mkdirSync(DIST_DIR, { recursive: true });
}

for (const platform of selectedPlatforms) {
	console.log(`\n→ Compiling for ${platform.target}...`);
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

	// Ad-hoc codesign for macOS targets (required to bypass Gatekeeper "damaged" error)
	if (platform.target.includes("darwin")) {
		if (process.platform === "darwin") {
			const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", outfile], {
				cwd: ROOT,
				stdio: ["inherit", "inherit", "inherit"],
			});
			if (sign.exitCode === 0) {
				console.log(`✓ Ad-hoc signed: ${relative(ROOT, outfile)}`);
			} else {
				console.warn(
					`⚠ codesign failed — users may need to run: codesign --force --sign - ${relative(ROOT, outfile)}`,
				);
			}
		} else {
			console.log(
				`ℹ macOS binary built on ${process.platform} — users need to run before first launch:`,
			);
			console.log(`    codesign --force --sign - ${relative(ROOT, outfile)}`);
		}
	}

	console.log(`✓ Built: ${relative(ROOT, outfile)}`);

	// Step 7: Generate blockmap and SHA512 for delta updates
	console.log(`→ Generating blockmap for ${platform.name}...`);
	const blockmapResult = await generateBlockmapForFile(outfile);
	const blockmapPath = `${outfile}.blockmap`;
	await writeBlockmapToFile(blockmapResult.blockmap, blockmapPath);
	console.log(
		`✓ Blockmap: ${relative(ROOT, blockmapPath)} (${blockmapResult.blockmap.files[0].checksums.length} blocks)`,
	);

	// Write latest.yml for this platform
	const latestYmlPath = join(DIST_DIR, getLatestYmlName(platform.target));
	const latestYml = generateLatestYml({
		version: VERSION,
		path: platform.name,
		sha512: blockmapResult.sha512,
		fileSize: blockmapResult.fileSize,
	});
	writeFileSync(latestYmlPath, latestYml);
	console.log(`✓ Generated: ${relative(ROOT, latestYmlPath)}`);
}

console.log("\n✅ All builds completed!");
console.log("\nBuilt executables:");
const needsCodesign: string[] = [];
for (const platform of selectedPlatforms) {
	console.log(`  - dist/${platform.name}`);
	if (platform.target.includes("darwin") && process.platform !== "darwin") {
		needsCodesign.push(platform.name);
	}
}
if (needsCodesign.length > 0) {
	console.log("\n⚠ macOS binaries were cross-compiled — run on macOS before first launch:");
	for (const name of needsCodesign) {
		console.log(`    codesign --force --sign - dist/${name}`);
	}
	console.log("  Or remove Gatekeeper quarantine attribute:");
	for (const name of needsCodesign) {
		console.log(`    xattr -cr dist/${name}`);
	}
}
