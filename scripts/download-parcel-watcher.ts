/**
 * Download @parcel/watcher native binaries for all target platforms.
 *
 * Fetches platform-specific npm packages, extracts `watcher.node` files,
 * and places them in `server/generated/parcel-watcher-binaries/`.
 *
 * Also generates `server/generated/parcel-native-loader.ts` which embeds
 * the binaries via `import ... with { type: "file" }` for Bun --compile.
 *
 * Usage:
 *   bun scripts/download-parcel-watcher.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "server", "generated", "parcel-watcher-binaries");
const LOADER_FILE = join(ROOT, "server", "generated", "parcel-native-loader.ts");

// Read version from installed @parcel/watcher
const parcelPkg = JSON.parse(
	readFileSync(join(ROOT, "node_modules", "@parcel", "watcher", "package.json"), "utf-8"),
);
const PARCEL_VERSION: string = parcelPkg.version;

/**
 * Platform mapping: our build target suffix → @parcel/watcher package name.
 *
 * Key = identifier used in generated loader (also matches Bun compile targets).
 * Value = npm package name containing the `watcher.node` binary.
 */
const PLATFORMS: Record<string, string> = {
	"darwin-arm64": `@parcel/watcher-darwin-arm64`,
	"darwin-x64": `@parcel/watcher-darwin-x64`,
	"linux-x64-glibc": `@parcel/watcher-linux-x64-glibc`,
	"linux-x64-musl": `@parcel/watcher-linux-x64-musl`,
	"linux-arm64-glibc": `@parcel/watcher-linux-arm64-glibc`,
	"linux-arm64-musl": `@parcel/watcher-linux-arm64-musl`,
	"win32-x64": `@parcel/watcher-win32-x64`,
	"win32-arm64": `@parcel/watcher-win32-arm64`,
};

// ── Download helpers ────────────────────────────────────────────────────────

async function downloadAndExtract(pkgName: string, outPath: string): Promise<boolean> {
	const tarballUrl = `https://registry.npmjs.org/${pkgName}/-/${pkgName.split("/")[1]}-${PARCEL_VERSION}.tgz`;

	try {
		console.log(`  ↓ ${pkgName}@${PARCEL_VERSION}`);
		const resp = await fetch(tarballUrl);
		if (!resp.ok) {
			console.warn(`  ⚠ Failed to fetch ${tarballUrl}: ${resp.status}`);
			return false;
		}

		const tarGz = await resp.arrayBuffer();

		// Decompress gzip
		const ds = new DecompressionStream("gzip");
		const decompressed = new Response(
			new Blob([tarGz]).stream().pipeThrough(ds),
		);
		const tarBuf = new Uint8Array(await decompressed.arrayBuffer());

		// Simple tar extraction — find watcher.node in the tar
		const nodeFile = extractFileFromTar(tarBuf, "watcher.node");
		if (!nodeFile) {
			console.warn(`  ⚠ watcher.node not found in ${pkgName}`);
			return false;
		}

		writeFileSync(outPath, nodeFile);
		console.log(`  ✓ ${outPath} (${(nodeFile.length / 1024).toFixed(0)}KB)`);
		return true;
	} catch (err) {
		console.warn(`  ⚠ Error downloading ${pkgName}: ${err}`);
		return false;
	}
}

/**
 * Extract a file from a tar archive (uncompressed).
 * Simple implementation that handles POSIX tar format.
 */
function extractFileFromTar(tar: Uint8Array, targetName: string): Uint8Array | null {
	let offset = 0;
	const decoder = new TextDecoder();

	while (offset < tar.length - 512) {
		// Read header
		const header = tar.slice(offset, offset + 512);

		// Check for empty block (end of archive)
		if (header.every((b) => b === 0)) break;

		// File name: bytes 0-99
		const nameRaw = decoder.decode(header.slice(0, 100)).replace(/\0/g, "");
		// Size: bytes 124-135 (octal)
		const sizeStr = decoder.decode(header.slice(124, 136)).replace(/\0/g, "").trim();
		const size = Number.parseInt(sizeStr, 8) || 0;

		// Data starts after header
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;

		// Check if this is the file we want (may be prefixed with "package/")
		if (nameRaw.endsWith(targetName) || nameRaw === targetName) {
			return tar.slice(dataStart, dataEnd);
		}

		// Move to next entry (data is padded to 512-byte blocks)
		offset = dataStart + Math.ceil(size / 512) * 512;
	}

	return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

if (!existsSync(OUT_DIR)) {
	mkdirSync(OUT_DIR, { recursive: true });
}

console.log(`Downloading @parcel/watcher v${PARCEL_VERSION} native binaries...\n`);

const results: Array<{ key: string; success: boolean }> = [];

for (const [key, pkgName] of Object.entries(PLATFORMS)) {
	const outPath = join(OUT_DIR, `watcher-${key}.node`);

	// Skip if already downloaded (same version)
	if (existsSync(outPath)) {
		console.log(`  ✓ ${key} (cached)`);
		results.push({ key, success: true });
		continue;
	}

	const success = await downloadAndExtract(pkgName, outPath);
	results.push({ key, success });
}

const succeeded = results.filter((r) => r.success);
const failed = results.filter((r) => !r.success);

console.log(`\n✅ Downloaded ${succeeded.length}/${results.length} platform binaries`);
if (failed.length > 0) {
	console.warn(`⚠ Failed: ${failed.map((r) => r.key).join(", ")}`);
}

// ── Generate loader file ────────────────────────────────────────────────────

console.log("\n→ Generating parcel-native-loader.ts...");

/**
 * Runtime platform detection → loader key mapping.
 *
 * At runtime we check process.platform + process.arch (+ libc on Linux)
 * to pick the right embedded binary.
 */
const loaderCode = `// @ts-nocheck — generated file with Bun-specific import attributes
// AUTO-GENERATED by scripts/download-parcel-watcher.ts — DO NOT EDIT
//
// Embeds @parcel/watcher v${PARCEL_VERSION} native binaries for all platforms.
// At runtime, extracts the correct binary to disk and loads it via process.dlopen.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Embed all platform binaries via Bun's file embedding
${succeeded.map((r) => `import _${r.key.replace(/-/g, "_")} from "./parcel-watcher-binaries/watcher-${r.key}.node" with { type: "file" };`).join("\n")}

const EMBEDDED: Record<string, string> = {
${succeeded.map((r) => `\t"${r.key}": _${r.key.replace(/-/g, "_")},`).join("\n")}
};

const PARCEL_VERSION = ${JSON.stringify(PARCEL_VERSION)};

/**
 * Detect the current platform key for @parcel/watcher binary selection.
 */
function detectPlatformKey(): string | null {
\tconst platform = process.platform;
\tconst arch = process.arch as string;

\tif (platform === "darwin") {
\t\treturn arch === "arm64" ? "darwin-arm64" : "darwin-x64";
\t}

\tif (platform === "win32") {
\t\treturn arch === "arm64" ? "win32-arm64" : "win32-x64";
\t}

\tif (platform === "linux") {
\t\t// Detect musl vs glibc
\t\tlet isMusl = false;
\t\ttry {
\t\t\t// Check if we're running on musl by looking at the dynamic linker
\t\t\tconst lddOutput = require("node:child_process")
\t\t\t\t.execSync("ldd --version 2>&1 || true", { encoding: "utf-8" });
\t\t\tisMusl = lddOutput.toLowerCase().includes("musl");
\t\t} catch {
\t\t\t// Default to glibc
\t\t}
\t\tconst libc = isMusl ? "musl" : "glibc";
\t\tif (arch === "arm64" || arch === "aarch64") {
\t\t\treturn \`linux-arm64-\${libc}\`;
\t\t}
\t\treturn \`linux-x64-\${libc}\`;
\t}

\treturn null;
}

/**
 * Load the @parcel/watcher native binding for the current platform.
 *
 * In compiled binary mode, extracts the embedded .node file to
 * ~/.narrafork/cache/ and loads it via process.dlopen.
 *
 * Returns the raw binding object (same as require("@parcel/watcher-xxx")).
 */
export function loadParcelNativeBinding(): Record<string, (...args: unknown[]) => unknown> | null {
\tconst key = detectPlatformKey();
\tif (!key) return null;

\tconst embeddedPath = EMBEDDED[key];
\tif (!embeddedPath) return null;

\t// Extract to a stable cache path so we don't re-extract on every startup
\tconst cacheDir = join(homedir(), ".narrafork", "cache");
\tconst cachePath = join(cacheDir, \`parcel-watcher-\${PARCEL_VERSION}-\${key}.node\`);

\tif (!existsSync(cachePath)) {
\t\tif (!existsSync(cacheDir)) {
\t\t\tmkdirSync(cacheDir, { recursive: true });
\t\t}
\t\t// Read from $bunfs embedded path and write to disk
\t\tconst data = readFileSync(embeddedPath);
\t\twriteFileSync(cachePath, data);
\t}

\t// Load via process.dlopen
\tconst mod: { exports: Record<string, (...args: unknown[]) => unknown> } = { exports: {} };
\ttry {
\t\tprocess.dlopen(mod, cachePath);
\t\treturn mod.exports;
\t} catch (err) {
\t\tconsole.error(\`Failed to load parcel watcher native binding from \${cachePath}:\`, err);
\t\treturn null;
\t}
}
`;

writeFileSync(LOADER_FILE, loaderCode);
console.log(`✓ Generated ${LOADER_FILE}`);
