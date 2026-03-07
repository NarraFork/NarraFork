import { execSync } from "node:child_process";
import { resolve } from "node:path";

const pkg = await Bun.file(resolve(import.meta.dir, "../../package.json")).json();

export const APP_VERSION: string = pkg.version ?? "0.0.0";

let commitHash = "";
try {
	commitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {
	// not in a git repo or git not available
}

export const GIT_COMMIT: string = commitHash;
