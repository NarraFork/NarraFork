/**
 * Prepare all currently supported native ripgrep helpers; never uploads.
 * bun scripts/prepare-ripgrep-helpers.ts [--platform=linux-arm64] [--ssh-host=HOST]
 * Requires curl, unzip and tar. Outputs dist/helpers/ripgrep/ and a hash manifest.
 */
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCliHelperSpec } from "../server/lib/helper-binary-platform";
import { isWindowsPeFile } from "../shared/windows-pe";
import { downloadHelperAsset, runHelperCommand, sha256 } from "./lib/helper-assets";

export const RIPGREP_VERSION = "15.1.0";
// Official BurntSushi/ripgrep 15.1.0 release assets; digest is of the upstream archive.
export const RIPGREP_ASSETS = [
	{
		key: "linux-x64",
		platform: "linux",
		arch: "x64",
		target: "x86_64-unknown-linux-musl",
		sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
	},
	{
		key: "linux-arm64",
		platform: "linux",
		arch: "arm64",
		target: "aarch64-unknown-linux-gnu",
		sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
	},
	{
		key: "darwin-x64",
		platform: "darwin",
		arch: "x64",
		target: "x86_64-apple-darwin",
		sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
	},
	{
		key: "darwin-arm64",
		platform: "darwin",
		arch: "arm64",
		target: "aarch64-apple-darwin",
		sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
	},
	{
		key: "win-x64",
		platform: "win32",
		arch: "x64",
		target: "x86_64-pc-windows-msvc",
		sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
	},
	{
		key: "win-arm64",
		platform: "win32",
		arch: "arm64",
		target: "aarch64-pc-windows-msvc",
		sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
	},
] as const;

/** Check ELF/Mach-O headers as well as Windows PE; no foreign binary execution. */
export function verifyRipgrepArchitecture(path: string, platform: string, arch: "x64" | "arm64") {
	if (platform === "win32") return isWindowsPeFile(path, arch);
	const fd = openSync(path, "r");
	try {
		const header = Buffer.alloc(32);
		if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
		if (platform === "linux") {
			return (
				header.readUInt32LE(0) === 0x464c457f &&
				header[4] === 2 &&
				header[5] === 1 &&
				header.readUInt16LE(18) === (arch === "arm64" ? 183 : 62)
			);
		}
		if (platform === "darwin") {
			return (
				header.readUInt32LE(0) === 0xfeedfacf &&
				header.readUInt32LE(4) === (arch === "arm64" ? 0x100000c : 0x1000007)
			);
		}
		return false;
	} finally {
		closeSync(fd);
	}
}

export async function prepareRipgrepHelpers(out: string, platformKey?: string, sshHost?: string) {
	mkdirSync(out, { recursive: true });
	const assets = platformKey
		? RIPGREP_ASSETS.filter((asset) => asset.key === platformKey)
		: RIPGREP_ASSETS;
	if (!assets.length) throw new Error(`Unknown ripgrep platform: ${platformKey}`);
	const records = [];
	for (const asset of assets) {
		const dir = `ripgrep-${RIPGREP_VERSION}-${asset.target}`;
		const archive = `${dir}.${asset.platform === "win32" ? "zip" : "tar.gz"}`;
		const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${archive}`;
		await downloadHelperAsset(out, archive, url, asset.sha256, sshHost);
		if (asset.platform === "win32") {
			await runHelperCommand(out, [
				"unzip",
				"-oq",
				archive,
				`${dir}/rg.exe`,
				`${dir}/LICENSE-MIT`,
				`${dir}/COPYING`,
				"-d",
				out,
			]);
		} else {
			await runHelperCommand(out, [
				"tar",
				"-xzf",
				archive,
				"-C",
				out,
				`${dir}/rg`,
				`${dir}/LICENSE-MIT`,
				`${dir}/COPYING`,
			]);
		}
		const spec = getCliHelperSpec("rg", asset.platform, asset.arch);
		if (!spec) throw new Error(`Unsupported helper platform: ${asset.key}`);
		const binary = join(out, spec.toolName);
		copyFileSync(join(out, dir, asset.platform === "win32" ? "rg.exe" : "rg"), binary);
		if (!verifyRipgrepArchitecture(binary, asset.platform, asset.arch))
			throw new Error(`Native architecture mismatch: ${binary}`);
		const digest = await sha256(binary);
		if (spec.expectedSha256 && digest !== spec.expectedSha256)
			throw new Error(`Runtime digest mismatch: ${binary}`);
		copyFileSync(join(out, dir, "LICENSE-MIT"), join(out, "ripgrep-LICENSE-MIT.txt"));
		console.log(`Verified ${asset.key}: ${binary} sha256=${digest}`);
		records.push({
			filename: spec.toolName,
			platform: asset.key,
			version: RIPGREP_VERSION,
			sha256: digest,
			source: url,
			archiveSha256: asset.sha256,
		});
	}
	writeFileSync(join(out, "ripgrep-manifest.json"), `${JSON.stringify(records, null, 2)}\n`);
	return records;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const key = args.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length);
	const host = args.find((arg) => arg.startsWith("--ssh-host="))?.slice("--ssh-host=".length);
	await prepareRipgrepHelpers(join(import.meta.dir, "..", "dist", "helpers", "ripgrep"), key, host);
	console.log("Prepared locally only; no update-server upload performed.");
}
