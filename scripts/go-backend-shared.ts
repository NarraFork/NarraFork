import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const GO_ROOT = join(ROOT, "go_backend");
export const GO_BETA_PRODUCT = "narrafork-go-backend";
export const GO_BETA_CHANNEL = "beta";
export const GO_BUILD_CHANNEL = "go-beta";
export const GO_BUILD_OUTPUT_DIR = join(ROOT, "dist", "go-backend");
export const UPDATE_SERVER_CONFIG_PATH = join(homedir(), ".narrafork", "update-server.json");

export interface GoTargetSpec {
	platform: string;
	goos: string;
	goarch: string;
	filenameSuffix: string;
}

export interface GoArtifactManifestEntry {
	platform: string;
	goos: string;
	goarch: string;
	filename: string;
	size: number;
	sha512: string;
	channel: string;
}

export interface GoArtifactManifest {
	version: string;
	commit: string;
	channel: string;
	backend: string;
	generatedAt: string;
	artifacts: GoArtifactManifestEntry[];
}

export interface UpdateServerConfig {
	serverUrl: string;
	token: string;
}

const TARGETS: GoTargetSpec[] = [
	{ platform: "linux-x64", goos: "linux", goarch: "amd64", filenameSuffix: "linux-x64" },
	{ platform: "linux-arm64", goos: "linux", goarch: "arm64", filenameSuffix: "linux-arm64" },
	{ platform: "darwin-x64", goos: "darwin", goarch: "amd64", filenameSuffix: "darwin-x64" },
	{ platform: "darwin-arm64", goos: "darwin", goarch: "arm64", filenameSuffix: "darwin-arm64" },
	{ platform: "win-x64", goos: "windows", goarch: "amd64", filenameSuffix: "win-x64.exe" },
];

export function getGoTargets(platformArg?: string): GoTargetSpec[] {
	const input = (platformArg ?? "").trim();
	if (!input || input === "all") {
		return [...TARGETS];
	}
	const matches = TARGETS.filter(
		(target) => target.platform === input || target.filenameSuffix === input,
	);
	return matches;
}

export function listGoPlatforms(): string[] {
	return TARGETS.map((target) => target.platform);
}

export function safeVersionSegment(version: string): string {
	const trimmed = version.trim();
	if (!trimmed) {
		return "unknown";
	}
	return trimmed.replaceAll(/[\\/:\s]+/g, "-").replaceAll(/[^A-Za-z0-9._+-]+/g, "-");
}

export function versionOutputDir(version: string, outDir = GO_BUILD_OUTPUT_DIR): string {
	return join(outDir, safeVersionSegment(version));
}

export function buildBinaryFilename(version: string, target: GoTargetSpec): string {
	return `narrafork-go-${version}-${target.filenameSuffix}`;
}

export function buildBinaryPath(
	version: string,
	target: GoTargetSpec,
	outDir = GO_BUILD_OUTPUT_DIR,
): string {
	return join(versionOutputDir(version, outDir), buildBinaryFilename(version, target));
}

export function buildLdflags(version: string, commit: string, channel: string): string {
	return [
		`-X narrafork-go/internal/buildinfo.Version=${version}`,
		`-X narrafork-go/internal/buildinfo.Commit=${commit}`,
		`-X narrafork-go/internal/buildinfo.Channel=${channel}`,
	].join(" ");
}

export function loadUpdateServerConfig(): UpdateServerConfig {
	let fileConfig: { serverUrl?: string; token?: string } = {};
	if (existsSync(UPDATE_SERVER_CONFIG_PATH)) {
		try {
			fileConfig = JSON.parse(readFileSync(UPDATE_SERVER_CONFIG_PATH, "utf-8"));
		} catch {
			// ignore malformed config
		}
	}
	return {
		serverUrl:
			process.env.NF_UPDATE_SERVER ??
			fileConfig.serverUrl ??
			"https://narrafork-update.b.domexie.cn",
		token: process.env.NF_UPDATE_TOKEN ?? fileConfig.token ?? "",
	};
}

export function loadChangelog(
	version: string,
	changelogArg?: string,
): string | Record<string, string> | undefined {
	const changelogPath = changelogArg ?? join(ROOT, "changelogs", `v${version}.json`);
	if (!existsSync(changelogPath)) {
		if (changelogArg) {
			throw new Error(`Changelog file not found: ${changelogPath}`);
		}
		return undefined;
	}
	const raw = readFileSync(changelogPath, "utf-8");
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}
		return raw;
	} catch {
		return raw;
	}
}

export function sha512Base64ForFile(path: string): string {
	const hash = createHash("sha512");
	hash.update(readFileSync(path));
	return hash.digest("base64");
}

export function writeJsonPretty(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function compareGoVersions(a: string, b: string): -1 | 0 | 1 {
	const parsedA = parseGoVersion(a);
	const parsedB = parseGoVersion(b);
	for (let i = 0; i < 3; i++) {
		const partA = parsedA.numbers[i] ?? 0;
		const partB = parsedB.numbers[i] ?? 0;
		if (partA > partB) return 1;
		if (partA < partB) return -1;
	}
	if (parsedA.prerelease && !parsedB.prerelease) return -1;
	if (!parsedA.prerelease && parsedB.prerelease) return 1;
	if (parsedA.prerelease && parsedB.prerelease) {
		if (parsedA.prerelease > parsedB.prerelease) return 1;
		if (parsedA.prerelease < parsedB.prerelease) return -1;
	}
	return 0;
}

export function listGoBuildVersions(outDir = GO_BUILD_OUTPUT_DIR): string[] {
	if (!existsSync(outDir)) return [];
	return readdirSync(outDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((version) => existsSync(join(outDir, version, "manifest.json")))
		.sort((a, b) => compareGoVersions(b, a));
}

export function loadGoArtifactManifest(
	version: string,
	outDir = GO_BUILD_OUTPUT_DIR,
): GoArtifactManifest | null {
	const manifestPath = join(outDir, version, "manifest.json");
	if (!existsSync(manifestPath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(manifestPath, "utf-8")) as GoArtifactManifest;
	} catch {
		return null;
	}
}

export function findPreviousGoVersion(
	currentVersion: string,
	outDir = GO_BUILD_OUTPUT_DIR,
): string | null {
	for (const version of listGoBuildVersions(outDir)) {
		if (compareGoVersions(version, currentVersion) < 0) {
			return version;
		}
	}
	return null;
}

export function findPreviousGoArtifactForPlatform(
	currentVersion: string,
	platform: string,
	outDir = GO_BUILD_OUTPUT_DIR,
): { version: string; manifest: GoArtifactManifest; artifact: GoArtifactManifestEntry } | null {
	for (const version of listGoBuildVersions(outDir)) {
		if (compareGoVersions(version, currentVersion) >= 0) {
			continue;
		}
		const manifest = loadGoArtifactManifest(version, outDir);
		if (!manifest) {
			continue;
		}
		const artifact = loadGoArtifactManifestEntry(manifest, platform);
		if (artifact) {
			return { version, manifest, artifact };
		}
	}
	return null;
}

export function loadGoArtifactManifestEntry(
	manifest: GoArtifactManifest,
	platform: string,
): GoArtifactManifestEntry | null {
	return manifest.artifacts.find((artifact) => artifact.platform === platform) ?? null;
}

function parseGoVersion(version: string): { numbers: number[]; prerelease: string } {
	const [core, prerelease = ""] = version.trim().split("-", 2);
	return {
		numbers: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
		prerelease,
	};
}

export function parseArg(args: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	const found = args.find((arg) => arg.startsWith(prefix));
	return found ? found.slice(prefix.length) : undefined;
}

export function hasFlag(args: string[], name: string): boolean {
	return args.includes(`--${name}`);
}

export function normalizeVersionForFilename(version: string): string {
	return version.trim().replaceAll("/", "-");
}
