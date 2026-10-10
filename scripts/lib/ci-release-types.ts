import { OFFICIAL_GITHUB_REPOSITORY } from "../../shared/github-repository";
import type { BinaryMetadata } from "./binary-metadata";

/** Compatibility default only; live CI derives identity from validated GITHUB_REPOSITORY. */
export const CI_RELEASE_REPOSITORY = OFFICIAL_GITHUB_REPOSITORY;
export const CI_RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const CI_RELEASE_BUN = "1.4.2";
export const CI_RELEASE_TARGETS = [
	{
		target: "linux-x64",
		platform: "linux-x64",
		suffix: "linux-x64",
		buildRunner: "ubuntu-24.04",
		smokeRunner: "ubuntu-24.04",
	},
	{
		target: "linux-x64-baseline",
		platform: "linux-x64-baseline",
		suffix: "linux-x64-baseline",
		buildRunner: "ubuntu-24.04",
		smokeRunner: "ubuntu-24.04",
	},
	{
		target: "linux-arm64",
		platform: "linux-arm64",
		suffix: "linux-arm64",
		buildRunner: "ubuntu-24.04",
		smokeRunner: "ubuntu-24.04-arm",
	},
	{
		target: "windows-x64",
		platform: "win-x64",
		suffix: "windows-x64.exe",
		buildRunner: "ubuntu-24.04",
		smokeRunner: "windows-2022",
	},
	{
		target: "windows-x64-baseline",
		platform: "win-x64-baseline",
		suffix: "windows-x64-baseline.exe",
		buildRunner: "ubuntu-24.04",
		smokeRunner: "windows-2022",
	},
	{
		target: "windows-arm64",
		platform: "win-arm64",
		suffix: "windows-arm64.exe",
		buildRunner: "ubuntu-24.04",
		smokeRunner: "windows-11-arm",
	},
	{
		target: "darwin-x64",
		platform: "darwin-x64",
		suffix: "macos-x64",
		buildRunner: "macos-15-intel",
		smokeRunner: "macos-15-intel",
	},
	{
		target: "darwin-arm64",
		platform: "darwin-arm64",
		suffix: "macos-arm64",
		buildRunner: "macos-15",
		smokeRunner: "macos-15",
	},
] as const;
export type CiReleaseTarget = (typeof CI_RELEASE_TARGETS)[number]["target"];

export interface CiReleaseChangelog {
	version: string;
	date: string;
	en: string;
	"zh-CN": string;
}
export interface CiReleaseBaseline {
	releaseId: number;
	version: string;
	platform: string;
	binaryAsset: { id: number; name: string; size: number };
	metadataAsset: { id: number; name: string; size: number };
	metadataSha256: string;
	metadata: BinaryMetadata;
}
export interface CiReleasePlan {
	schemaVersion: 1;
	repository: string;
	/** Absent only in legacy main-branch bundles. */
	defaultBranch?: string;
	tag: string;
	version: string;
	commit: string;
	workflowCommit: string;
	bunVersion: string;
	channel: "stable" | "beta";
	changelog: CiReleaseChangelog;
	runId: number;
	runAttempt: number;
	baselines: CiReleaseBaseline[];
}
export interface CiReleaseSmokeResult {
	schemaVersion: 1;
	/** Verified by querying fresh settings from the actual downloaded binary. */
	repository?: string;
	target: string;
	commit: string;
	version: string;
	sha256: string;
	sha512: string;
	size: number;
	checks: {
		startup: true;
		frontend: true;
		database: true;
		watcher: true;
		pty: true;
		signature: boolean;
	};
}
export interface CiReleaseFile {
	name: string;
	size: number;
	sha256: string;
	sha512: string;
}
export interface CiReleaseManifest {
	schemaVersion: 1;
	plan: CiReleasePlan;
	files: CiReleaseFile[];
	smoke: CiReleaseSmokeResult[];
	/** Optional for legacy bundles; exactly matches all eight sidecars when declared. */
	helperDistribution?: BinaryMetadata["helperDistribution"];
}
