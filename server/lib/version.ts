import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let version = "0.0.0";
let commitHash = "";

// Dev mode: read from package.json + git directly
const pkgPath = resolve(import.meta.dir, "../../package.json");
if (existsSync(pkgPath)) {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	version = pkg.version ?? "0.0.0";

	try {
		commitHash = execSync("git rev-parse --short HEAD", {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
	} catch {
		// git not available
	}
} else {
	// Compiled binary: no package.json, use generated build info
	try {
		const { buildVersion, buildCommit } = await import("@server/generated/build-info");
		version = buildVersion;
		commitHash = buildCommit;
	} catch {
		// no build info either
	}
}

export const APP_VERSION: string = version;
export const GIT_COMMIT: string = commitHash;
