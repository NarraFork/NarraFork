import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let version = "0.0.0";
let commitHash = "";

// Try reading from generated build info (compiled binary)
try {
	const { buildVersion, buildCommit } = await import("@server/generated/build-info");
	version = buildVersion;
	commitHash = buildCommit;
} catch {
	// Not a compiled build — read from package.json at dev time
	const pkgPath = resolve(import.meta.dir, "../../package.json");
	if (existsSync(pkgPath)) {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		version = pkg.version ?? "0.0.0";
	}

	try {
		commitHash = execSync("git rev-parse --short HEAD", {
			encoding: "utf-8",
		}).trim();
	} catch {
		// git not available
	}
}

export const APP_VERSION: string = version;
export const GIT_COMMIT: string = commitHash;
