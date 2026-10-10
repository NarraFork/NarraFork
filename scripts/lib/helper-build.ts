import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	getHelperAssetName,
	HELPER_BINARY_MAX_BYTES,
	HELPER_PLATFORMS,
	HELPER_TOOL_VERSIONS,
	type HelperPlatform,
	type HelperTool,
} from "../../shared/helper-distribution";
import { type ExecutorPlatform, executorPublishedFilename } from "../../shared/remote-executor";
import { prepareRipgrepHelpers, verifyRipgrepArchitecture } from "../prepare-ripgrep-helpers";
import { downloadHelperAsset, runHelperCommand } from "./helper-assets";
import { windowsArm64ZstdCommand } from "./zstd-windows-arm64";

export const ZSTD_SOURCE_SHA256 =
	"eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3";
export const ZSTD_LINUX_IMAGE =
	"docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1";
export const LLVM_MINGW_SHA256 = "936f82221fa4ad4ff1829f28f1cdf4c1e304cfd589323212e2b7ef8be428784a";
export const LLVM_MINGW_DIR = "llvm-mingw-20250613-ucrt-ubuntu-22.04-x86_64";
const BUILD_PROXY_KEYS = [
	"http_proxy",
	"https_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"no_proxy",
	"NO_PROXY",
] as const;
export function helperBuildEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const result = { ...environment };
	if (environment.ZSTD_BUILD_PROXY !== undefined)
		for (const name of BUILD_PROXY_KEYS.slice(0, 4)) result[name] = environment.ZSTD_BUILD_PROXY;
	return result;
}
export function helperContainerProxyArgs(environment: NodeJS.ProcessEnv = process.env): string[] {
	const resolved = helperBuildEnvironment(environment);
	return BUILD_PROXY_KEYS.flatMap((name) =>
		resolved[name] === undefined ? [] : ["-e", `${name}=${resolved[name]}`],
	);
}
export function executorPlatform(platform: HelperPlatform): ExecutorPlatform {
	return platform.replace("x64", "amd64") as ExecutorPlatform;
}
export async function prepareZstdHelper(
	platform: HelperPlatform,
	cache: string,
	output: string,
	io: { download?: typeof downloadHelperAsset; run?: typeof runHelperCommand } = {},
): Promise<void> {
	const acquire = io.download ?? downloadHelperAsset;
	const run = io.run ?? runHelperCommand;
	await mkdir(cache, { recursive: true });
	await mkdir(output, { recursive: true });
	const archive = "zstd-1.5.7.tar.gz";
	await acquire(
		cache,
		archive,
		`https://github.com/facebook/zstd/releases/download/v1.5.7/${archive}`,
		ZSTD_SOURCE_SHA256,
		undefined,
		helperBuildEnvironment(),
	);
	await run(cache, ["tar", "-xzf", archive]);
	const source = join(cache, "zstd-1.5.7");
	const target = join(output, getHelperAssetName("zstd", platform));
	let built = join(source, "programs", "zstd");
	if (platform.startsWith("linux-")) {
		const container = process.env.CONTAINER_RUNTIME ?? "podman";
		if (!["podman", "docker"].includes(container)) throw new Error("Invalid container runtime");
		await run(
			cache,
			[
				container,
				"run",
				"--rm",
				"--platform",
				platform.endsWith("x64") ? "linux/amd64" : "linux/arm64",
				...helperContainerProxyArgs(),
				"-v",
				`${cache}:/work:Z`,
				"-w",
				"/work/zstd-1.5.7",
				ZSTD_LINUX_IMAGE,
				"sh",
				"-ec",
				"apk add --no-cache gcc=14.2.0-r6 musl-dev=1.2.5-r12 musl=1.2.5-r12 binutils=2.44-r3 make=4.4.1-r3; make -j2 CFLAGS='-O2 -static -fno-ident -ffile-prefix-map=/work/zstd-1.5.7=zstd' LDFLAGS=-static ZSTD_LEGACY_SUPPORT=0 ZSTD_DISABLE_ASM=1 zstd-release; strip programs/zstd; ! readelf -l programs/zstd | busybox grep INTERP",
			],
			15 * 60_000,
		);
	} else if (platform.startsWith("windows-")) {
		if (process.platform !== "linux" || process.arch !== "x64")
			throw new Error("Pinned Windows zstd recipe requires Linux x64 build host");
		await acquire(
			cache,
			`${LLVM_MINGW_DIR}.tar.xz`,
			`https://github.com/mstorsjo/llvm-mingw/releases/download/20250613/${LLVM_MINGW_DIR}.tar.xz`,
			LLVM_MINGW_SHA256,
			undefined,
			helperBuildEnvironment(),
		);
		await run(cache, ["tar", "-xf", `${LLVM_MINGW_DIR}.tar.xz`]);
		const compiler = join(
			cache,
			LLVM_MINGW_DIR,
			"bin",
			`${platform.endsWith("arm64") ? "aarch64" : "x86_64"}-w64-mingw32-clang`,
		);
		built = join(cache, `built-${platform}.exe`);
		await run(cache, windowsArm64ZstdCommand(source, compiler, built));
	} else {
		if (process.platform !== "darwin" || `darwin-${process.arch}` !== platform)
			throw new Error("macOS zstd requires the native architecture runner");
		const xcode = Bun.spawnSync(["/usr/bin/xcodebuild", "-version"], {
			timeout: 10_000,
			maxBuffer: 65536,
		});
		if (
			xcode.exitCode !== 0 ||
			!xcode.stdout.toString().includes("Xcode 26.0.1\nBuild version 17A400")
		)
			throw new Error(
				"Expected pinned Xcode 26.0.1 (17A400); set DEVELOPER_DIR=/Applications/Xcode_26.0.1.app/Contents/Developer",
			);
		await run(source, [
			"make",
			"-j2",
			"CC=/usr/bin/xcrun --sdk macosx clang",
			"CFLAGS=-O2 -fno-ident -mmacosx-version-min=11.0",
			"ZSTD_LEGACY_SUPPORT=0",
			"ZSTD_DISABLE_ASM=1",
			"zstd-release",
		]);
	}
	const builtStat = await lstat(built);
	if (!builtStat.isFile() || builtStat.size < 1 || builtStat.size > HELPER_BINARY_MAX_BYTES)
		throw new Error("Invalid compiled zstd size/type");
	if (
		!verifyRipgrepArchitecture(
			built,
			platform.startsWith("windows") ? "win32" : platform.split("-")[0],
			platform.endsWith("arm64") ? "arm64" : "x64",
		)
	)
		throw new Error("zstd architecture mismatch");
	await copyFile(built, target);
	await chmod(target, 0o755);
}
export async function prepareHelperPlatform(
	platform: HelperPlatform,
	cache: string,
	output: string,
): Promise<void> {
	if (!HELPER_PLATFORMS.includes(platform)) throw new Error("Unknown helper platform");
	const rgCache = join(cache, "rg");
	await prepareRipgrepHelpers(rgCache, platform.replace("windows-", "win-"));
	await mkdir(output, { recursive: true });
	await copyFile(
		join(rgCache, getHelperAssetName("rg", platform)),
		join(output, getHelperAssetName("rg", platform)),
	);
	await chmod(join(output, getHelperAssetName("rg", platform)), 0o755);
	await prepareZstdHelper(platform, join(cache, "zstd"), output);
}
export async function buildExecutorPlatform(
	root: string,
	platform: HelperPlatform,
	output: string,
	version: string,
	commit: string,
): Promise<void> {
	if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/.test(version) || !/^[0-9a-f]{40}$/.test(commit))
		throw new Error("Invalid executor build identity");
	await mkdir(output, { recursive: true });
	const goPlatform = executorPlatform(platform);
	const [os, arch] = goPlatform.split("-");
	const binary = join(output, executorPublishedFilename(version, goPlatform));
	const proc = Bun.spawn(
		[
			"go",
			"build",
			"-trimpath",
			"-buildvcs=false",
			"-ldflags",
			`-s -w -X github.com/narrafork/remote-executor/internal/buildinfo.Version=${version} -X github.com/narrafork/remote-executor/internal/buildinfo.Commit=${commit} -X github.com/narrafork/remote-executor/internal/buildinfo.BuildTime=1970-01-01T00:00:00Z`,
			"-o",
			binary,
			"./cmd/narrafork-executor",
		],
		{
			cwd: join(root, "remote-executor"),
			env: {
				...process.env,
				CGO_ENABLED: "0",
				GOOS: os,
				GOARCH: arch,
				GOAMD64: "v1",
				GOARM64: "v8.0",
				GOTOOLCHAIN: "local",
			},
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const timer = setTimeout(() => proc.kill(), 10 * 60_000);
	try {
		if ((await proc.exited) !== 0) throw new Error("Executor build failed");
	} finally {
		clearTimeout(timer);
	}
	await chmod(binary, 0o755);
}
export function assertHelperToolVersion(tool: HelperTool, reported: string): void {
	const expression =
		tool === "rg" ? /^ripgrep ([^\s]+)/ : /\bZstandard CLI\b[^\n]*\bv(\d+\.\d+\.\d+)\b/;
	if (reported.match(expression)?.[1] !== HELPER_TOOL_VERSIONS[tool])
		throw new Error("Native helper version mismatch");
}
export async function smokeHelperPlatform(platform: HelperPlatform, output: string): Promise<void> {
	const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	if (host !== platform) throw new Error(`Native smoke requires ${platform}, got ${host}`);
	const rg = resolve(output, getHelperAssetName("rg", platform));
	const zstd = resolve(output, getHelperAssetName("zstd", platform));
	await chmod(rg, 0o755);
	await chmod(zstd, 0o755);
	for (const [path, tool] of [
		[rg, "rg"],
		[zstd, "zstd"],
	] as const) {
		const result = Bun.spawnSync([path, "--version"], { timeout: 10_000, maxBuffer: 65536 });
		if (result.exitCode !== 0) throw new Error("Native helper version command failed");
		assertHelperToolVersion(tool, result.stdout.toString());
	}
	const text = join(output, "smoke-input.txt");
	await writeFile(text, "helper-native-smoke\n");
	await runHelperCommand(output, [rg, "--fixed-strings", "helper-native-smoke", text], 10_000);
	await runHelperCommand(output, [zstd, "-q", "-f", text, "-o", `${text}.zst`], 10_000);
	await runHelperCommand(
		output,
		[zstd, "-q", "-d", "-f", `${text}.zst`, "-o", `${text}.out`],
		10_000,
	);
	if (!(await readFile(text)).equals(await readFile(`${text}.out`)))
		throw new Error("zstd roundtrip mismatch");
}
