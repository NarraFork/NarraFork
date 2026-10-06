import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const currentVersion = (
	JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { version: string }
).version;
const releaseSource = readFileSync(resolve(repoRoot, "scripts/release.ts"), "utf8");

function decode(output: Uint8Array | undefined): string {
	return output ? new TextDecoder().decode(output) : "";
}

describe("release upload validation", () => {
	test("checks the worktree before version mutation and tags only after a successful build", () => {
		const preflightIndex = releaseSource.indexOf(
			"getUnexpectedReleaseChanges(ROOT, releaseCommitPaths)",
		);
		const versionBumpIndex = releaseSource.indexOf("// ── Step 1: Version bump");
		const buildIndex = releaseSource.indexOf("// ── Step 3: Build");
		const tagIndex = releaseSource.indexOf("// ── Step 4: Tag the successfully built commit");

		expect(preflightIndex).toBeGreaterThan(-1);
		expect(preflightIndex).toBeLessThan(versionBumpIndex);
		expect(buildIndex).toBeLessThan(tagIndex);
	});

	test("rejects the deprecated overwrite-release option", () => {
		const result = Bun.spawnSync(
			["bun", "scripts/release.ts", "0.5.11", "--overwrite-release=0.5.11"],
			{
				cwd: repoRoot,
				env: process.env,
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const output = `${decode(result.stdout)}${decode(result.stderr)}`;
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("no longer supported");
		expect(output).toContain("Publish a new version");
	});

	test("keeps the explicit offline downgrade for dry-run baseline checks", () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"scripts/release.ts",
				currentVersion,
				"--dry-run",
				"--skip-build",
				"--platform=linux-x64",
			],
			{
				cwd: repoRoot,
				env: { ...process.env, NF_UPDATE_SERVER: "http://127.0.0.1:1" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const output = `${decode(result.stdout)}${decode(result.stderr)}`;
		expect(result.exitCode).toBe(0);
		expect(output).toContain("continuing offline dry run without baseline verification");
		expect(output).toContain("Dry run complete");
	});

	test("exits non-zero when there are no upload entries", () => {
		const result = Bun.spawnSync(
			["bun", "scripts/release.ts", "0.5.11", "--upload-only", "--platform=not-a-real-platform"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NF_UPDATE_SERVER: "http://127.0.0.1:1",
					NF_UPDATE_TOKEN: "test-token",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const output = `${decode(result.stdout)}${decode(result.stderr)}`;
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("No release artifacts were uploaded");
	});
});
