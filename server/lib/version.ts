import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createHelperDistributionDependencies,
	type HelperDistributionDependencies,
	parseHelperDistributionDependencies,
} from "../../shared/helper-distribution";

import { DEVICE_PROTOCOL_VERSION } from "./agent/execution/rpc-types";

export { BUILD_GITHUB_REPOSITORY } from "../../shared/build-repository";

let version = "0.0.0";
let commitHash = "";
let platform = "";
let helperDistribution: HelperDistributionDependencies | undefined;
let embeddedHelperDistribution: unknown;

// Dev mode: read from package.json + git directly
const pkgPath = resolve(import.meta.dir, "../../package.json");
if (existsSync(pkgPath)) {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	version = pkg.version ?? "0.0.0";
	helperDistribution = createHelperDistributionDependencies();

	try {
		commitHash = execSync("git rev-parse --short HEAD", {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		}).trim();
	} catch {
		// git not available
	}
} else {
	// Compiled binary: no package.json, use generated build info
	try {
		const mod = (await import("@server/generated/build-info")) as {
			buildVersion: string;
			buildCommit: string;
			buildPlatform?: string;
			buildHelperDistribution?: unknown;
		};
		version = mod.buildVersion;
		commitHash = mod.buildCommit;
		platform = mod.buildPlatform ?? "";
		embeddedHelperDistribution = mod.buildHelperDistribution;
	} catch {
		// no build info either
	}
}

// An explicit but malformed declaration is not a legacy build: fail closed.
if (embeddedHelperDistribution !== undefined)
	helperDistribution = parseHelperDistributionDependencies(embeddedHelperDistribution);

export const APP_VERSION: string = version;
export const GIT_COMMIT: string = commitHash;
/** Build platform identifier, e.g. "win-x64-baseline", "linux-x64". Empty in dev mode. */
export const BUILD_PLATFORM: string = platform;
/** Undefined only for a compiled legacy build which never advertised helper dependencies. */
export const BUILD_HELPER_DISTRIBUTION = helperDistribution;
/** Exact component identity; only undeclared legacy binaries track the application version. */
export const BUILD_EXECUTOR_DISTRIBUTION = Object.freeze(
	helperDistribution?.executor ?? {
		version: APP_VERSION,
		protocolVersion: DEVICE_PROTOCOL_VERSION,
		tag: `executor-v${APP_VERSION}`,
	},
);
