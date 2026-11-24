import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXECUTOR_RELEASE_VERSION } from "../../shared/helper-distribution";

const repoRoot = resolve(import.meta.dir, "../..");
const releaseSource = readFileSync(resolve(repoRoot, "scripts/release.ts"), "utf8");

function mirrorFixture(args: string[], missing = false, executor = false, cancellation = false) {
	const temporaryParent = join(repoRoot, ".narrafork");
	mkdirSync(temporaryParent, { recursive: true });
	const root = mkdtempSync(join(temporaryParent, "release-mirror-cli-"));
	const entry = join(root, "fixture.ts");
	writeFileSync(
		entry,
		`
import { mock } from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
const exists = fs.existsSync;
const read = fs.readFileSync;
const calls = [], configReads = [], repositoryReads = [];
const forbiddenConfig = ${JSON.stringify(args.includes("--preview") || args.includes("--dry-run"))};
const isConfig = path => String(path).endsWith("update-server.json");
mock.module("node:fs", () => ({ ...fs,
 existsSync: path => { if (isConfig(path)) { configReads.push(String(path)); if (forbiddenConfig) throw new Error("Forbidden credential read"); return false; } if (String(path).includes("/dist")) throw new Error("Forbidden dist read"); return exists(path); },
 readFileSync: (path, ...args) => { if (String(path).includes("/dist") || String(path).endsWith("protocol.go")) throw new Error("Forbidden baseline/protocol read"); return read(path, ...args); },
 writeFileSync: () => { throw new Error("Forbidden write"); },
}));
mock.module("node:child_process", () => ({ ...child, execFileSync: () => { throw new Error("Forbidden build/git command"); } }));
mock.module(${JSON.stringify(resolve(repoRoot, "scripts/lib/build-repository.ts"))}, () => ({ resolveBuildGitHubRepository: options => { repositoryReads.push(options.root); return "SourceOwner/SourceFork"; } }));
mock.module(${JSON.stringify(resolve(repoRoot, "scripts/mirror-update-server.ts"))}, () => ({ mirrorPublishedGitHubRelease: async options => { calls.push({...options, signal: options.signal ? "bounded" : undefined}); if (${missing}) throw new Error("HTTP 404 public tag missing"); if (${cancellation}) { process.emit("SIGTERM"); options.signal.throwIfAborted(); } return {status: "METADATA_ONLY"}; } }));
process.on("exit", code => console.log(JSON.stringify({code, calls, configReads, repositoryReads})));
process.argv = [process.execPath, ${JSON.stringify(resolve(repoRoot, executor ? "scripts/release-executor.ts" : "scripts/release.ts"))}, ...${JSON.stringify(args)}];
try { await import(${JSON.stringify(resolve(repoRoot, executor ? "scripts/release-executor.ts" : "scripts/release.ts"))}); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`,
	);
	try {
		const child = Bun.spawnSync([process.execPath, entry], {
			cwd: repoRoot,
			timeout: 15_000,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				NF_UPDATE_SERVER: "https://fixture.invalid",
				NF_UPDATE_TOKEN: "fixture-token",
			},
		});
		const stdout = new TextDecoder().decode(child.stdout);
		return {
			exitCode: child.exitCode,
			output: stdout + new TextDecoder().decode(child.stderr),
			...JSON.parse(stdout.trim().split("\n").at(-1) as string),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("release CLI canonical mirror", () => {
	test("keeps GitHub dirty/tag guards and returns mirror before version mutation", () => {
		const preflight = releaseSource.indexOf(
			"getUnexpectedReleaseChanges(ROOT, releaseCommitPaths)",
		);
		const bump = releaseSource.indexOf("// ── Step 1: Version bump");
		expect(preflight).toBeGreaterThan(-1);
		expect(preflight).toBeLessThan(bump);
		expect(releaseSource.indexOf("// ── Step 3: Build")).toBeLessThan(
			releaseSource.indexOf("// ── Step 4: Tag the successfully built commit"),
		);
		expect(releaseSource.indexOf('if (target === "update-server")')).toBeLessThan(preflight);
		for (const forbidden of [
			"getLatestPublishedBaseline",
			"ensureStableBaselinePatches",
			"rebuildOld",
			"new FormData",
			"DEFAULT_GITHUB_REPOSITORY",
		])
			expect(releaseSource).not.toContain(forbidden);
	});
	test("offline default mirror dry-run has no network, build, mutation, dist or token read", () => {
		const result = mirrorFixture(["0.9.2", "--dry-run", "--upload-only", "--platform=linux-x64"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Offline mirror intent: main SourceOwner/SourceFork v0.9.2");
		expect(result.calls).toHaveLength(0);
		expect(result.configReads).toHaveLength(0);
		expect(result.repositoryReads).toHaveLength(1);
	});
	test("preview verifies actual fork public tag without server config/token", () => {
		const result = mirrorFixture(["0.9.2", "--preview", "--platform=linux-x64"]);
		expect(result.exitCode).toBe(0);
		expect(result.configReads).toHaveLength(0);
		expect(result.calls).toEqual([
			{
				kind: "main",
				repository: "SourceOwner/SourceFork",
				tag: "v0.9.2",
				platforms: ["linux-x64"],
				patchOnly: true,
				dryRun: true,
				signal: "bounded",
			},
		]);
	});
	test("include-full is an explicit mirror-only override", () => {
		const result = mirrorFixture(["0.9.2", "--preview", "--include-full"]);
		expect(result.exitCode).toBe(0);
		expect(result.calls[0].patchOnly).toBe(false);
		expect(mirrorFixture(["0.9.2", "--include-full", "--patch-only"]).exitCode).not.toBe(0);
		expect(mirrorFixture(["0.9.2", "--target=github", "--include-full"]).exitCode).not.toBe(0);
	});
	test("normal mirror and upload-only need no dist and retain configured server", () => {
		const result = mirrorFixture(["0.9.2", "--upload-only", "--github-repository=Other/Fork"]);
		expect(result.exitCode).toBe(0);
		expect(result.repositoryReads).toHaveLength(0);
		expect(result.configReads).toHaveLength(1);
		expect(result.calls[0].config).toEqual({
			serverUrl: "https://fixture.invalid",
			token: "fixture-token",
		});
		expect(result.calls[0].repository).toBe("Other/Fork");
	});
	test("missing public tag fails clearly and never builds or publishes first", () => {
		const result = mirrorFixture(["0.9.2", "--preview"], true);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("primary GitHub entry first");
		expect(result.output).toContain("public tag missing");
		expect(result.calls).toHaveLength(1);
		expect(result.configReads).toHaveLength(0);
	});
	for (const flag of [
		"--skip-build",
		"--patch-from=0.9.1",
		"--skip-stable-patch",
		"--changelog=notes.json",
		"--preview",
		"--dry-run=false",
		"--preview=true",
		"--dry-rnu",
		"--rebuild-old",
	]) {
		test(`rejects obsolete/conflicting mirror option ${flag}`, () => {
			const result = mirrorFixture(["0.9.2", "--dry-run", flag]);
			expect(result.exitCode).not.toBe(0);
			expect(result.calls).toHaveLength(0);
			expect(result.configReads).toHaveLength(0);
		});
	}
	test("unknown platform is still a failure before mirror requests", () => {
		const result = mirrorFixture(["0.9.2", "--upload-only", "--platform=not-a-real-platform"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("Unknown platform");
		expect(result.calls).toHaveLength(0);
	});
	test("overwrite option remains forbidden", () => {
		let output = "";
		try {
			execFileSync(process.execPath, ["scripts/release.ts", "0.9.2", "--overwrite-release=0.9.2"], {
				cwd: repoRoot,
				timeout: 15_000,
				maxBuffer: 64 * 1024,
				stdio: "pipe",
			});
		} catch (error) {
			output = String((error as { stderr: Buffer }).stderr);
		}
		expect(output).toContain("no longer supported");
		expect(output).toContain("Publish a new version");
	});
	test("executor server mirror uploads only public metadata without go/protocol/dist", () => {
		const result = mirrorFixture(["--preview", "--platform=linux-amd64"], false, true);
		expect(result.exitCode).toBe(0);
		expect(result.configReads).toHaveLength(0);
		expect(result.calls).toEqual([
			{
				kind: "executor",
				repository: "SourceOwner/SourceFork",
				tag: `executor-v${EXECUTOR_RELEASE_VERSION}`,
				platforms: ["linux-amd64"],
				dryRun: true,
				signal: "bounded",
			},
		]);
	});
	for (const executor of [false, true]) {
		test(`SIGTERM cancels ${executor ? "executor" : "main"} mirror without fallback/build`, () => {
			const result = mirrorFixture(
				executor ? ["--preview"] : ["0.9.2", "--preview"],
				false,
				executor,
				true,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.calls).toHaveLength(1);
			expect(result.calls[0].signal).toBe("bounded");
			expect(result.configReads).toHaveLength(0);
		});
	}
	test("executor missing public version never falls through to local build", () => {
		const result = mirrorFixture(["--preview"], true, true);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("primary GitHub entry first");
	});
});
