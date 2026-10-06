/**
 * Remote executor distribution contract, shared by the release script, the
 * server, and the settings UI.
 *
 * The executor is a statically linked Go single-file binary published to the
 * update server's public `tools/` channel alongside a manifest. Platform ids use
 * Go's `GOOS-GOARCH` spelling so published filenames map 1:1 onto `make dist`
 * output, rather than being translated into the NarraFork release platform ids
 * (`linux-x64`, `win-x64`, …) which cover a different set of targets.
 */

/** Published executor platforms, matching `PLATFORMS` in remote-executor/Makefile. */
export const EXECUTOR_PLATFORMS = [
	"linux-amd64",
	"linux-arm64",
	"darwin-amd64",
	"darwin-arm64",
	"windows-amd64",
	"windows-arm64",
] as const;

export type ExecutorPlatform = (typeof EXECUTOR_PLATFORMS)[number];

export type ExecutorOs = "linux" | "darwin" | "windows";

/** Filename of the manifest published next to the binaries in `tools/`. */
export const EXECUTOR_MANIFEST_FILENAME = "narrafork-executor-manifest.json";

export interface ExecutorPlatformArtifact {
	/** Filename in the update server `tools/` channel. */
	filename: string;
	size: number;
	/** Lowercase hex SHA-256 of the binary. */
	sha256: string;
}

export interface ExecutorManifest {
	/** Executor release version, tracking the NarraFork version it shipped with. */
	version: string;
	/** Device RPC protocol version this build speaks. */
	protocolVersion: number;
	/** ISO-8601 publish timestamp. */
	releasedAt: string;
	platforms: Partial<Record<ExecutorPlatform, ExecutorPlatformArtifact>>;
}

export interface ExecutorPlatformInfo {
	platform: ExecutorPlatform;
	os: ExecutorOs;
	/** Go arch name (`amd64` / `arm64`). */
	arch: "amd64" | "arm64";
	/** `uname -m` values that correspond to this arch, for script self-checks. */
	unameArches: readonly string[];
	/** Interactive PTY terminals are Unix-only; Windows ConPTY is not implemented. */
	supportsPty: boolean;
	/** Human-readable label for UI menus. */
	label: string;
}

const PLATFORM_INFO: Record<ExecutorPlatform, ExecutorPlatformInfo> = {
	"linux-amd64": {
		platform: "linux-amd64",
		os: "linux",
		arch: "amd64",
		unameArches: ["x86_64", "amd64"],
		supportsPty: true,
		label: "Linux x86_64",
	},
	"linux-arm64": {
		platform: "linux-arm64",
		os: "linux",
		arch: "arm64",
		unameArches: ["aarch64", "arm64"],
		supportsPty: true,
		label: "Linux arm64",
	},
	"darwin-amd64": {
		platform: "darwin-amd64",
		os: "darwin",
		arch: "amd64",
		unameArches: ["x86_64", "amd64"],
		supportsPty: true,
		label: "macOS Intel",
	},
	"darwin-arm64": {
		platform: "darwin-arm64",
		os: "darwin",
		arch: "arm64",
		unameArches: ["arm64"],
		supportsPty: true,
		label: "macOS Apple Silicon",
	},
	"windows-amd64": {
		platform: "windows-amd64",
		os: "windows",
		arch: "amd64",
		unameArches: ["x86_64", "amd64"],
		supportsPty: false,
		label: "Windows x64",
	},
	"windows-arm64": {
		platform: "windows-arm64",
		os: "windows",
		arch: "arm64",
		unameArches: ["arm64"],
		supportsPty: false,
		label: "Windows arm64",
	},
};

export function isExecutorPlatform(value: string): value is ExecutorPlatform {
	return Object.hasOwn(PLATFORM_INFO, value);
}

export function getExecutorPlatformInfo(platform: ExecutorPlatform): ExecutorPlatformInfo {
	return PLATFORM_INFO[platform];
}

export function listExecutorPlatformInfo(): ExecutorPlatformInfo[] {
	return EXECUTOR_PLATFORMS.map((platform) => PLATFORM_INFO[platform]);
}

/** `narrafork-executor-<os>-<arch>[.exe]` — the name produced by `make dist`. */
export function executorDistFilename(platform: ExecutorPlatform): string {
	const info = PLATFORM_INFO[platform];
	return `narrafork-executor-${platform}${info.os === "windows" ? ".exe" : ""}`;
}

/** Versioned name used in the update server `tools/` channel. */
export function executorPublishedFilename(version: string, platform: ExecutorPlatform): string {
	const info = PLATFORM_INFO[platform];
	return `narrafork-executor-${version}-${platform}${info.os === "windows" ? ".exe" : ""}`;
}

/** Local cache name under ~/.narrafork/bin, versioned so platforms never collide. */
export function executorCachedFilename(version: string, platform: ExecutorPlatform): string {
	return executorPublishedFilename(version, platform);
}

/** Name the executor is installed as on the target machine. */
export function executorInstalledFilename(platform: ExecutorPlatform): string {
	return PLATFORM_INFO[platform].os === "windows" ? "narrafork-executor.exe" : "narrafork-executor";
}
