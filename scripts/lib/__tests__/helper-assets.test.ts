import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCliHelperSpec } from "../../../server/lib/helper-binary-platform";
import { RIPGREP_ASSETS, verifyRipgrepArchitecture } from "../../prepare-ripgrep-helpers";
import { downloadHelperAsset, sha256 } from "../helper-assets";
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
				RIPGREP_ASSETS.map((asset) => getCliHelperSpec("rg", asset.platform, asset.arch)?.toolName),
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

describe("Linux zstd build isolation", () => {
	function runBuild(target: "x64" | "arm64", overrides: Record<string, string> = {}) {
		const root = mkdtempSync(join(dir, "linux-build-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		mkdirSync(join(root, "scripts"));
		const script = join(root, "scripts", "build-zstd-static.sh");
		writeFileSync(script, readFileSync(new URL("../../build-zstd-static.sh", import.meta.url)));
		const stub = (name: string, body: string) =>
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		stub("podman", 'printf "%s\\0" "$@" > "$NF_PODMAN_ARGS"');
		for (const name of ["ls", "apk", "curl", "tar", "make", "chmod", "aarch64-linux-musl-gcc"])
			stub(name, "exit 0");
		stub("nproc", "printf '1\\n'");
		stub("file", 'printf "%s\\n" "$NF_TEST_ELF"');
		stub("cp", 'printf "%s\\n" "$@" > "$NF_COPIED"');
		const env: Record<string, string | undefined> = { ...process.env };
		for (const name of [
			"http_proxy",
			"https_proxy",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"no_proxy",
			"NO_PROXY",
			"ZSTD_BUILD_PROXY",
		])
			delete env[name];
		Object.assign(env, {
			PATH: `${bin}:${process.env.PATH}`,
			NF_PODMAN_ARGS: join(root, "podman-args"),
			NF_COPIED: join(root, "copied"),
			...overrides,
		});
		const result = Bun.spawnSync(["bash", script, target], { env, timeout: 5_000 });
		expect(result.exitCode).toBe(0);
		const args = readFileSync(join(root, "podman-args"), "utf8").split("\0").slice(0, -1);
		return { root, env, args };
	}

	test("both Linux targets pin the compiler container to amd64 without a private proxy", () => {
		for (const target of ["x64", "arm64"] as const) {
			const { args } = runBuild(target);
			expect(args[args.indexOf("--platform") + 1]).toBe("linux/amd64");
			expect(args.some((arg) => /^(http|https)_proxy=|^(HTTP|HTTPS)_PROXY=/.test(arg))).toBe(false);
			expect(args.join(" ")).not.toContain("10.126.126.111");
		}
	});

	test("inherits per-protocol proxies and bypass settings from the caller", () => {
		const { args } = runBuild("x64", {
			http_proxy: "http://caller:8080",
			HTTPS_PROXY: "http://secure:8443",
			NO_PROXY: "localhost,.internal",
		});
		expect(args).toContain("http_proxy=http://caller:8080");
		expect(args).toContain("HTTPS_PROXY=http://secure:8443");
		expect(args).toContain("NO_PROXY=localhost,.internal");
	});

	test("explicit proxy override accepts a URL or an empty direct-connection value", () => {
		for (const value of ["http://override:9000", ""]) {
			const { args } = runBuild("x64", {
				http_proxy: "http://caller:8080",
				ZSTD_BUILD_PROXY: value,
			});
			for (const name of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
				const values = args.filter((arg) => arg.startsWith(`${name}=`));
				expect(values.at(-1)).toBe(`${name}=${value}`);
			}
		}
	});

	test("rejects wrong-architecture ELF before copying a labelled artifact", () => {
		for (const target of ["x64", "arm64"] as const) {
			const { root, env, args } = runBuild(target);
			const programs = join(root, "zstd-1.5.7", "programs");
			mkdirSync(programs, { recursive: true });
			writeFileSync(join(programs, "zstd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const command = args[args.indexOf("-c") + 1];
			for (const arch of ["x86-64", "ARM aarch64"]) {
				rmSync(join(root, "copied"), { force: true });
				const result = Bun.spawnSync(["sh", "-c", command], {
					cwd: root,
					env: { ...env, NF_TEST_ELF: `ELF 64-bit LSB executable, ${arch}, statically linked` },
					timeout: 5_000,
				});
				const valid = arch === (target === "x64" ? "x86-64" : "ARM aarch64");
				expect(result.exitCode).toBe(valid ? 0 : 1);
				if (valid) {
					expect(readFileSync(join(root, "copied"), "utf8")).toContain(
						`/output/zstd-linux-${target}`,
					);
				} else {
					expect(() => readFileSync(join(root, "copied"))).toThrow();
				}
			}
		}
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
