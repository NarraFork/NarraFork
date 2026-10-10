import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHelperAssetName, type HelperPlatform } from "../../../shared/helper-distribution";
import { RIPGREP_ASSETS, verifyRipgrepArchitecture } from "../../prepare-ripgrep-helpers";
import { downloadHelperAsset, sha256 } from "../helper-assets";
import {
	assertHelperToolVersion,
	helperBuildEnvironment,
	helperContainerProxyArgs,
	prepareZstdHelper,
	ZSTD_LINUX_IMAGE,
	ZSTD_SOURCE_SHA256,
} from "../helper-build";
import { windowsArm64ZstdCommand } from "../zstd-windows-arm64";

const dir = mkdtempSync(join(tmpdir(), "nf-helper-assets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ripgrep release acquisition coverage", () => {
	test("covers every supported platform with pinned official archive digests", () => {
		expect(RIPGREP_ASSETS.map((asset) => asset.key)).toEqual([
			"linux-x64",
			"linux-arm64",
			"darwin-x64",
			"darwin-arm64",
			"win-x64",
			"win-arm64",
		]);
		expect(
			new Set(
				RIPGREP_ASSETS.map((asset) =>
					getHelperAssetName("rg", asset.key.replace(/^win-/, "windows-") as HelperPlatform),
				),
			).size,
		).toBe(6);
		for (const asset of RIPGREP_ASSETS) expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
	});
	test("verifies native ELF/Mach-O machine, not filename or ability to emulate", () => {
		for (const platform of ["linux", "darwin"]) {
			for (const arch of ["x64", "arm64"] as const) {
				const header = Buffer.alloc(32);
				if (platform === "linux") {
					header.writeUInt32LE(0x464c457f, 0);
					header[4] = 2;
					header[5] = 1;
					header.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
				} else {
					header.writeUInt32LE(0xfeedfacf, 0);
					header.writeUInt32LE(arch === "arm64" ? 0x100000c : 0x1000007, 4);
				}
				const path = join(dir, `${platform}-${arch}`);
				writeFileSync(path, header);
				expect(verifyRipgrepArchitecture(path, platform, arch)).toBe(true);
				expect(verifyRipgrepArchitecture(path, platform, arch === "arm64" ? "x64" : "arm64")).toBe(
					false,
				);
			}
		}
	});
});

describe("repeatable native zstd cross-build", () => {
	test("selects deterministic C source order, native threads, and no winpthreads dependency", () => {
		const source = join(dir, "zstd");
		for (const part of [
			"lib/common",
			"lib/compress",
			"lib/decompress",
			"lib/dictBuilder",
			"programs",
		]) {
			mkdirSync(join(source, part), { recursive: true });
			writeFileSync(join(source, part, "z.c"), "");
			writeFileSync(join(source, part, "a.c"), "");
			writeFileSync(join(source, part, "ignored.h"), "");
		}
		const cmd = windowsArm64ZstdCommand(
			source,
			"/toolchain/aarch64-w64-mingw32-clang",
			"/out/zstd.exe",
		);
		expect(cmd[0]).toBe("/toolchain/aarch64-w64-mingw32-clang");
		expect(cmd).toContain("-static");
		expect(cmd).toContain("-Wl,--no-insert-timestamp");
		expect(cmd).toContain(`-ffile-prefix-map=${source}=zstd`);
		expect(cmd).toContain("-DZSTD_MULTITHREAD=1");
		expect(cmd).not.toContain("-pthread");
		expect(cmd.filter((arg) => arg.endsWith(".c")).slice(0, 2)).toEqual([
			join(source, "lib/common/a.c"),
			join(source, "lib/common/z.c"),
		]);
		expect(cmd.some((arg) => arg.endsWith(".h"))).toBe(false);
	});
});

describe("native helper version output", () => {
	test("accepts ripgrep's plain version and zstd's v-prefixed native version", () => {
		assertHelperToolVersion("rg", "ripgrep 15.1.0\nfeatures:+pcre2\n");
		assertHelperToolVersion("zstd", "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***\n");
		expect(() => assertHelperToolVersion("rg", "ripgrep 14.1.1\n")).toThrow();
		expect(() =>
			assertHelperToolVersion("zstd", "*** Zstandard CLI (64-bit) v1.5.6, by Yann Collet ***\n"),
		).toThrow();
	});
});

describe("Linux zstd build isolation", () => {
	async function runBuild(target: "x64" | "arm64", binaryArch: "x64" | "arm64" = target) {
		const root = mkdtempSync(join(dir, "linux-build-"));
		const cache = join(root, "cache");
		const output = join(root, "output");
		const commands: string[][] = [];
		const acquired: string[] = [];
		const operation = prepareZstdHelper(`linux-${target}`, cache, output, {
			download: async (_out, _name, url, expected) => {
				acquired.push(url, expected);
				return "fixture-archive";
			},
			run: async (_cwd, command) => {
				commands.push(command);
				if (command[0] !== "podman" && command[0] !== "docker") return;
				const programs = join(cache, "zstd-1.5.7", "programs");
				mkdirSync(programs, { recursive: true });
				const header = Buffer.alloc(32);
				header.writeUInt32LE(0x464c457f, 0);
				header[4] = 2;
				header[5] = 1;
				header.writeUInt16LE(binaryArch === "arm64" ? 183 : 62, 18);
				writeFileSync(join(programs, "zstd"), header);
			},
		});
		return { operation, output, commands, acquired };
	}
	test("both native Linux targets use a fixed image/source/toolchain instead of unverified cross packages", async () => {
		for (const target of ["x64", "arm64"] as const) {
			const build = await runBuild(target);
			await build.operation;
			const args = build.commands.find(
				(command) => command[0] === "podman" || command[0] === "docker",
			) as string[];
			expect(args[args.indexOf("--platform") + 1]).toBe(
				target === "x64" ? "linux/amd64" : "linux/arm64",
			);
			expect(args).toContain(ZSTD_LINUX_IMAGE);
			expect(args.join(" ")).toContain("gcc=14.2.0-r6");
			expect(args.join(" ")).not.toContain("musl.cc");
			expect(args.join(" ")).not.toContain("-march=native");
			expect(build.acquired).toEqual([
				"https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz",
				ZSTD_SOURCE_SHA256,
			]);
		}
	});
	test("inherits per-protocol proxies and bypass settings from the caller", () => {
		const args = helperContainerProxyArgs({
			http_proxy: "http://caller:8080",
			HTTPS_PROXY: "http://secure:8443",
			NO_PROXY: "localhost,.internal",
		});
		expect(args).toContain("http_proxy=http://caller:8080");
		expect(args).toContain("HTTPS_PROXY=http://secure:8443");
		expect(args).toContain("NO_PROXY=localhost,.internal");
	});
	test("explicit proxy override applies to source acquisition and compiler containers, including empty direct", () => {
		for (const value of ["http://override:9000", ""]) {
			const env = { http_proxy: "http://caller:8080", ZSTD_BUILD_PROXY: value };
			const args = helperContainerProxyArgs(env);
			const downloadEnv = helperBuildEnvironment(env);
			for (const name of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
				expect(args).toContain(`${name}=${value}`);
				expect(downloadEnv[name]).toBe(value);
			}
		}
		expect(helperContainerProxyArgs({})).toEqual([]);
	});
	test("rejects wrong-architecture ELF before copying a labelled artifact", async () => {
		for (const target of ["x64", "arm64"] as const) {
			const build = await runBuild(target, target === "x64" ? "arm64" : "x64");
			await expect(build.operation).rejects.toThrow("architecture mismatch");
			expect(() => readFileSync(join(build.output, `zstd-linux-${target}`))).toThrow();
		}
	});
	test("shell entry delegates into isolated output/cache and never writes vendor/dist", () => {
		const script = readFileSync(new URL("../../build-zstd-static.sh", import.meta.url), "utf8");
		expect(script).toContain("prepare-helper-assets.ts");
		expect(script).toContain(".helper-release/local");
		expect(script).not.toContain("vendor/zstd");
	});
});

describe("bounded acquisition", () => {
	test("reuses only archive bytes matching the trusted digest", async () => {
		const path = join(dir, "archive.zip");
		writeFileSync(path, "trusted-test-payload");
		const digest = await sha256(path);
		expect(
			await downloadHelperAsset(
				dir,
				"archive.zip",
				"https://github.com/owner/repo/releases/download/v1/archive.zip",
				digest,
			),
		).toBe(path);
	});
	test("rejects SSH argument injection and unsafe filenames/URLs before spawning", async () => {
		await expect(
			downloadHelperAsset(
				dir,
				"archive.zip",
				"https://github.com/o/r/releases/download/v1/archive.zip",
				"00",
				"-oProxyCommand=evil",
			),
		).rejects.toThrow("Invalid SSH host");
		await expect(
			downloadHelperAsset(
				dir,
				"../escape",
				"https://github.com/o/r/releases/download/v1/archive.zip",
				"00",
			),
		).rejects.toThrow("Invalid asset filename");
		await expect(
			downloadHelperAsset(
				dir,
				"archive.zip",
				"https://github.com/o/r/releases/download/v1/archive.zip;touch",
				"00",
			),
		).rejects.toThrow("Expected an official GitHub release URL");
	});
});
