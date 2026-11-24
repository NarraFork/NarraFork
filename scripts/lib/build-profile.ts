import { join } from "node:path";

export const ALPHA_BUILD_LOCK = ".build-alpha.lock";

export function frontendBuildDirectory(root: string, alphaFrontend: boolean): string {
	return alphaFrontend ? join(root, ALPHA_BUILD_LOCK, "frontend") : join(root, "dist", "frontend");
}

export interface BuildProfileEnvironment {
	readonly CI?: string;
	readonly GITHUB_ACTIONS?: string;
	readonly NF_BUILD_RELEASE_CONTEXT?: string;
}

export interface BuildProfile {
	readonly name: "diagnostic" | "release";
	readonly compileArgs: readonly string[];
}

const DIAGNOSTIC_PROFILE: BuildProfile = Object.freeze({
	name: "diagnostic",
	compileArgs: Object.freeze([
		"--keep-names",
		"--sourcemap",
		"--minify-syntax",
		"--minify-whitespace",
	]),
});
const RELEASE_PROFILE: BuildProfile = Object.freeze({
	name: "release",
	compileArgs: Object.freeze(["--minify"]),
});

function isEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return !!normalized && normalized !== "false" && normalized !== "0";
}

function isAlphaVersion(version: string): boolean {
	const match =
		/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			version,
		);
	if (!match || match[0] !== version) return false;
	const prerelease = match[1].split(".");
	return (
		prerelease[0] === "alpha" &&
		prerelease.every((identifier) => !/^\d+$/.test(identifier) || !/^0\d/.test(identifier))
	);
}

/** Strict validation (--release-ci) is independent of the backend compilation profile. */
export function resolveBuildProfile(version: string, env: BuildProfileEnvironment): BuildProfile {
	return isAlphaVersion(version) &&
		!isEnabled(env.CI) &&
		!isEnabled(env.GITHUB_ACTIONS) &&
		!isEnabled(env.NF_BUILD_RELEASE_CONTEXT)
		? DIAGNOSTIC_PROFILE
		: RELEASE_PROFILE;
}
