import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { safeSpawn } from "../server/lib/spawn";
import versions from "../shared/component-versions.json";

// Explicit test preparation only. Production never builds or executes a PATH helper.
const root = resolve(import.meta.dir, ".."),
	output = resolve(
		root,
		`.narrafork/editor-phase8-executor${process.platform === "win32" ? ".exe" : ""}`,
	);
await mkdir(resolve(root, ".narrafork"), { recursive: true });
const result = await safeSpawn({
	cmd: [
		"go",
		"build",
		"-trimpath",
		"-ldflags",
		`-X github.com/narrafork/remote-executor/internal/buildinfo.Version=${versions.executor.version}`,
		"-o",
		output,
		"./cmd/narrafork-executor",
	],
	cwd: resolve(root, "remote-executor"),
	timeout: 120_000,
	maxOutputBytes: 64 * 1024,
});
if (result.exitCode !== 0)
	throw new Error(`Editor fixture build failed: ${result.stderr.slice(0, 4096)}`);
console.log(`Prepared controlled editor test helper: ${output}`);
