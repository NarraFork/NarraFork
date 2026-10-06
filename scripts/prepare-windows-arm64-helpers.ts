/**
 * Prepare native Windows ARM64 rg/zstd for a later, separately authorized tools upload.
 * Does NOT upload, change settings, or run foreign executables.
 *
 * bun scripts/prepare-windows-arm64-helpers.ts [--rg-only] [--ssh-host=HOST]
 * Linux x64 build host; requires curl, unzip and tar (no make or Windows resource compiler). Downloads are SHA-256 pinned.
 * Outputs: dist/helpers/windows-arm64/{rg,zstd}-win-arm64.exe and upstream notices.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWindowsPeFile } from "../shared/windows-pe";
import { downloadHelperAsset, runHelperCommand, sha256 } from "./lib/helper-assets";
import { windowsArm64ZstdCommand } from "./lib/zstd-windows-arm64";
import { prepareRipgrepHelpers } from "./prepare-ripgrep-helpers";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "helpers", "windows-arm64");
const ZSTD_VERSION = "1.5.7";
const LLVM_VERSION = "20250613";
const ZSTD_ARCHIVE = `zstd-${ZSTD_VERSION}.tar.gz`;
const LLVM_DIR = `llvm-mingw-${LLVM_VERSION}-ucrt-ubuntu-22.04-x86_64`;
const LLVM_ARCHIVE = `${LLVM_DIR}.tar.xz`;

async function main() {
	const args = process.argv.slice(2);
	const sshHost = args.find((arg) => arg.startsWith("--ssh-host="))?.slice("--ssh-host=".length);
	mkdirSync(OUT, { recursive: true });
	await prepareRipgrepHelpers(OUT, "win-arm64", sshHost);
	if (args.includes("--rg-only")) return;
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error("zstd cross-build requires a Linux x64 host");
	await downloadHelperAsset(
		OUT,
		ZSTD_ARCHIVE,
		`https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/${ZSTD_ARCHIVE}`,
		"eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3",
		sshHost,
	);
	await downloadHelperAsset(
		OUT,
		LLVM_ARCHIVE,
		`https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_VERSION}/${LLVM_ARCHIVE}`,
		"936f82221fa4ad4ff1829f28f1cdf4c1e304cfd589323212e2b7ef8be428784a",
		sshHost,
	);
	await runHelperCommand(OUT, ["tar", "-xf", LLVM_ARCHIVE]);
	await runHelperCommand(OUT, ["tar", "-xzf", ZSTD_ARCHIVE]);
	const cc = join(OUT, LLVM_DIR, "bin", "aarch64-w64-mingw32-clang");
	const zstd = join(OUT, "zstd-win-arm64.exe");
	await runHelperCommand(OUT, windowsArm64ZstdCommand(join(OUT, `zstd-${ZSTD_VERSION}`), cc, zstd));
	if (!isWindowsPeFile(zstd, "arm64")) throw new Error(`Expected native ARM64 PE: ${zstd}`);
	copyFileSync(join(OUT, `zstd-${ZSTD_VERSION}`, "LICENSE"), join(OUT, "zstd-LICENSE.txt"));
	copyFileSync(join(OUT, LLVM_DIR, "LICENSE.TXT"), join(OUT, "llvm-compiler-rt-LICENSE.txt"));
	copyFileSync(
		join(OUT, LLVM_DIR, "aarch64-w64-mingw32", "share", "mingw32", "COPYING.MinGW-w64-runtime.txt"),
		join(OUT, "mingw-w64-runtime-LICENSE.txt"),
	);
	writeFileSync(
		join(OUT, "zstd-manifest.json"),
		`${JSON.stringify(
			{
				filename: "zstd-win-arm64.exe",
				version: ZSTD_VERSION,
				platform: "win-arm64",
				sha256: await sha256(zstd),
				sourceArchive: ZSTD_ARCHIVE,
				sourceSha256: "eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3",
				toolchainArchive: LLVM_ARCHIVE,
				toolchainSha256: "936f82221fa4ad4ff1829f28f1cdf4c1e304cfd589323212e2b7ef8be428784a",
				recipe: "scripts/lib/zstd-windows-arm64.ts",
				published: false,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Verified ARM64 PE zstd ${ZSTD_VERSION}: ${zstd} SHA-256=${await sha256(zstd)}`);
	console.log("Prepared locally only; publish helpers and notices separately after authorization.");
}

if (import.meta.main) await main();
