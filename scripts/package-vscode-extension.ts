/**
 * Package `vscode-extension/` into an installable `.vsix`.
 *
 * Design notes:
 *
 * - **The version is DERIVED from the root `package.json`, never hand-maintained.** The
 *   extension and the backend are released together and the panel loads the backend's own
 *   UI, so two independently edited version numbers could only ever disagree — and the
 *   disagreement would surface as a confusing "which one am I running" question rather
 *   than as an error. The committed value in the extension manifest is a placeholder
 *   (`0.0.0`) that this script overwrites for the duration of the packaging run.
 *
 * - **`private: true` is dropped in the packaged copy.** `vsce` refuses to package a
 *   private manifest, but the flag is correct in the repo: the extension is not published
 *   to npm.
 *
 * - **The manifest is restored afterwards, including on failure.** Leaving a rewritten
 *   version behind would put a moving value into git diffs of every packaging run.
 *
 * - **Not wired into `scripts/release.ts`.** Publishing to a marketplace is a separate
 *   decision; this produces a file you install by hand.
 *
 * Usage:
 *   bun scripts/package-vscode-extension.ts [--out=<dir>]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const EXTENSION_DIR = join(REPO_ROOT, "vscode-extension");
const MANIFEST_PATH = join(EXTENSION_DIR, "package.json");

async function readRootVersion(): Promise<string> {
	const raw = await readFile(join(REPO_ROOT, "package.json"), "utf8");
	const version = (JSON.parse(raw) as { version?: unknown }).version;
	if (typeof version !== "string" || !version) {
		throw new Error("Root package.json has no usable version");
	}
	return version;
}

async function run(command: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`${command.join(" ")} exited with code ${code}`);
	}
}

async function main(): Promise<void> {
	const outDirArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
	const outDir = outDirArg ? resolve(REPO_ROOT, outDirArg) : join(REPO_ROOT, "dist");

	const version = await readRootVersion();
	const originalManifest = await readFile(MANIFEST_PATH, "utf8");
	const manifest = JSON.parse(originalManifest) as Record<string, unknown>;

	console.log(`Packaging NarraFork VS Code extension v${version}`);

	// Type-check and emit first: `vsce` packages `out/`, and a stale or missing build would
	// produce a vsix that installs cleanly and then fails to activate.
	await run(["bunx", "tsc", "-p", "."], EXTENSION_DIR);

	const packaged = { ...manifest, version };
	delete packaged.private;

	try {
		await writeFile(MANIFEST_PATH, `${JSON.stringify(packaged, null, "\t")}\n`);
		const outFile = join(outDir, `narrafork-vscode-${version}.vsix`);
		await run(
			["bunx", "@vscode/vsce", "package", "--no-dependencies", "--skip-license", "--out", outFile],
			EXTENSION_DIR,
		);
		console.log(`\nWrote ${outFile}`);
		console.log("Install with:  code --install-extension <path>   (or the Extensions view menu)");
	} finally {
		// Always restore, so a failed run does not leave a rewritten version in the tree.
		await writeFile(MANIFEST_PATH, originalManifest);
	}
}

await main();
