import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseHelperArtifactZipDirectory } from "../../scripts/lib/helper-artifact";
import { HELPER_LICENSE_FILES } from "../../scripts/lib/helper-release";
import {
	assertHelperPublishEnvironment,
	type HelperReleasePlan,
	planHelperRelease,
	publishHelperReleasePlan,
	validateHelperBundleArtifact,
	validateHelperSourceJobs,
	validateHelperSourceRun,
} from "../../scripts/lib/helper-release-control";
import {
	parseHelperReleaseArguments,
	resolveHelperRestoreSource,
	runHelperReleaseController,
} from "../../scripts/release-helpers";
import componentVersions from "../../shared/component-versions.json";
import { HELPER_PLATFORMS } from "../../shared/helper-distribution";

const commit = "a".repeat(40);
const plan: HelperReleasePlan = {
	schemaVersion: 1,
	repository: "ForkOwner/fork-repo",
	defaultBranch: "main",
	tag: "helpers-v1.0.0",
	commit,
	controlCommit: commit,
	kind: "helpers",
	version: "1.0.0",
	protocolVersion: 1,
	sourceRunId: "123",
	publish: false,
};
function source() {
	return {
		id: 123,
		status: "completed",
		event: "workflow_dispatch",
		head_repository: { full_name: plan.repository },
		path: ".github/workflows/helpers-release.yml",
		head_branch: "main",
		head_sha: commit,
		run_attempt: 2,
	};
}
function jobs() {
	const names = [
		"Helper preflight",
		"Assemble exact helper bundle",
		...HELPER_PLATFORMS.flatMap((platform) => [
			`Build (${platform})`,
			`Native smoke (${platform})`,
		]),
	];
	return {
		total_count: names.length,
		jobs: names.map((name) => ({ name, conclusion: "success", run_id: 123, head_sha: commit })),
	};
}
function listing() {
	return {
		total_count: 1,
		artifacts: [
			{
				id: 456,
				name: `helper-bundle-helpers-${commit}`,
				expired: false,
				size_in_bytes: 128,
				digest: `sha256:${"b".repeat(64)}`,
				workflow_run: { id: 123 },
			},
		],
	};
}
function directory(name = "rg-linux-x64", size = 1024, mode = 0o100755) {
	const bytes = Buffer.from(name);
	const result = Buffer.alloc(46 + bytes.length);
	result.writeUInt32LE(0x02014b50, 0);
	result.writeUInt16LE(8, 10);
	result.writeUInt32LE(100, 20);
	result.writeUInt32LE(size, 24);
	result.writeUInt16LE(bytes.length, 28);
	result.writeUInt32LE((mode << 16) >>> 0, 38);
	bytes.copy(result, 46);
	return result;
}
function protectedContextFixture() {
	const calls: string[][] = [];
	const environment = {
		GITHUB_REPOSITORY: plan.repository,
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REF: "refs/heads/main",
		GITHUB_SHA: commit,
	};
	const state = {
		missing: false,
		repository: plan.repository,
		defaultBranch: "main",
		reviewers: [{ type: "User", reviewer: { id: 1 } }],
		branches: [{ name: "main", type: "branch" }],
		branchCount: 1,
		tagPresent: true,
		tagCommit: commit,
		ancestor: true,
		componentConfig: JSON.stringify({ executor: { version: "0.9.1", protocolVersion: 1 } }),
		componentPresent: true,
		componentReadError: false,
		treeReadError: false,
		packageVersion: "0.9.2",
		protocolVersion: 1,
		recipeChange: false,
		toolchainChange: false,
		recipeReadError: false,
		gitCalls: [] as string[][],
	};
	const run = async (args: string[]) => {
		calls.push(args);
		if (args[0] !== "api") throw new Error("Environment validation attempted a write");
		if (args[1] === `repos/${plan.repository}`)
			return JSON.stringify({ full_name: state.repository, default_branch: state.defaultBranch });
		if (args[1] === `repos/${plan.repository}/environments/release`) {
			if (state.missing) throw new Error("HTTP 404");
			return JSON.stringify({
				name: "release",
				protection_rules: [{ type: "required_reviewers", reviewers: state.reviewers }],
				deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
			});
		}
		if (
			args[1]?.startsWith(
				`repos/${plan.repository}/environments/release/deployment-branch-policies?`,
			)
		)
			return JSON.stringify({ total_count: state.branchCount, branch_policies: state.branches });
		if (args[1]?.includes("/git/ref/tags/")) {
			if (!state.tagPresent) throw new Error("HTTP 404");
			return JSON.stringify({ object: { type: "commit", sha: state.tagCommit } });
		}
		if (args[1]?.includes("/git/ref/heads/"))
			return JSON.stringify({ object: { type: "commit", sha: "c".repeat(40) } });
		if (args[1]?.includes("/compare/"))
			return JSON.stringify({
				status: state.ancestor ? "ahead" : "diverged",
				merge_base_commit: { sha: state.ancestor ? commit : "d".repeat(40) },
			});
		throw new Error(`Unexpected API ${args[1]}`);
	};
	const git = (_root: string, args: string[]) => {
		state.gitCalls.push(args);
		if (args[0] === "rev-parse") return commit;
		if (args[0] === "merge-base") return "";
		if (args[0] === "ls-tree") {
			if (state.treeReadError) throw new Error("git tree read failed");
			return state.componentPresent ? "shared/component-versions.json" : "";
		}
		if (args[0] === "show" && args[1] === `${commit}:shared/component-versions.json`) {
			if (state.componentReadError) throw new Error("git component read failed");
			return state.componentConfig;
		}
		if (args[0] === "show" && args[1] === `${commit}:package.json`)
			return JSON.stringify({ version: state.packageVersion });
		if (args[0] === "show" && args[1] === `${commit}:remote-executor/internal/rpc/protocol.go`)
			return `const ProtocolVersion = ${state.protocolVersion}\n`;
		if (args[0] === "show") {
			const [sourceCommit, path] = (args[1] ?? "").split(":");
			if (
				[
					"scripts/lib/helper-build.ts",
					"shared/remote-executor.ts",
					".github/workflows/helpers-release.yml",
				].includes(path ?? "")
			) {
				if (state.recipeReadError) throw new Error("git recipe read failed");
				let source = readFileSync(resolve(path as string), "utf8");
				if (sourceCommit === environment.GITHUB_SHA && sourceCommit !== commit) {
					if (state.recipeChange && path === "scripts/lib/helper-build.ts")
						source = source.replace('"-trimpath"', '"-race"');
					if (state.toolchainChange && path === ".github/workflows/helpers-release.yml")
						source = source.replace("go-version: 1.24.13", "go-version: 1.25.0");
				}
				return source;
			}
		}
		throw new Error("Unexpected git read");
	};
	return { calls, environment, state, options: { run, git, environment } };
}
describe("protected helper Environment", () => {
	test("build-only needs no configured Environment and cannot publish, even with matching CI refs", async () => {
		const f = protectedContextFixture();
		f.state.missing = true;
		const built = await planHelperRelease(".", "helpers", "helpers-v1.0.0", "", f.options);
		expect(built.publish).toBe(false);
		expect(f.calls.some((args) => args[1]?.includes("environments/"))).toBe(false);
		const prior = f.calls.length;
		await expect(
			publishHelperReleasePlan(built, "never-read-bundle", false, f.options),
		).rejects.toThrow("Build-only");
		expect(f.calls.length).toBe(prior);
	});
	test("publish intent freezes reviewers and exact default-branch policy using read-only queries", async () => {
		const f = protectedContextFixture();
		const planned = await planHelperRelease(".", "helpers", "helpers-v1.0.0", "", {
			...f.options,
			publish: true,
		});
		expect(planned.publish).toBe(true);
		await assertHelperPublishEnvironment(planned, f.options);
		expect(f.calls.every((args) => args[0] === "api")).toBe(true);
	});
	for (const mode of [
		"missing",
		"no-reviewer",
		"wildcard",
		"additional-branch",
		"wrong-branch",
		"truncated-policies",
		"foreign-repo",
		"changed-default",
		"tag-deleted",
		"tag-moved",
		"remote-ancestor-removed",
	])
		test(`rejects ${mode} in preflight and after the protected plan was minted`, async () => {
			const f = protectedContextFixture();
			const planned = await planHelperRelease(".", "helpers", "helpers-v1.0.0", "", {
				...f.options,
				publish: true,
			});
			if (mode === "missing") f.state.missing = true;
			if (mode === "no-reviewer") f.state.reviewers = [];
			if (mode === "wildcard") f.state.branches = [{ name: "*", type: "branch" }];
			if (mode === "additional-branch") {
				f.state.branches.push({ name: "feature", type: "branch" });
				f.state.branchCount = 2;
			}
			if (mode === "wrong-branch") f.state.branches = [{ name: "feature", type: "branch" }];
			if (mode === "truncated-policies") f.state.branchCount = 2;
			if (mode === "foreign-repo") f.state.repository = "Other/repo";
			if (mode === "changed-default") f.state.defaultBranch = "other";
			if (mode === "tag-deleted") f.state.tagPresent = false;
			if (mode === "tag-moved") f.state.tagCommit = "b".repeat(40);
			if (mode === "remote-ancestor-removed") f.state.ancestor = false;
			await expect(
				planHelperRelease(".", "helpers", "helpers-v1.0.0", "", { ...f.options, publish: true }),
			).rejects.toThrow();
			await expect(
				publishHelperReleasePlan(planned, "never-read-bundle", false, f.options),
			).rejects.toThrow();
			expect(f.calls.every((args) => args[0] === "api")).toBe(true);
		});
	test("a publisher cannot use a different control SHA", async () => {
		const f = protectedContextFixture();
		await expect(
			assertHelperPublishEnvironment(
				{ ...plan, publish: true, controlCommit: "b".repeat(40) },
				f.options,
			),
		).rejects.toThrow("control commit");
		expect(f.calls.length).toBe(0);
	});
});

describe("independent executor source identity", () => {
	test("executor tag matches target component pin, independently of APP 0.9.2", async () => {
		const f = protectedContextFixture();
		const planned = await planHelperRelease(".", "executor", "executor-v0.9.1", "", f.options);
		expect(planned).toMatchObject({ version: "0.9.1", protocolVersion: 1, commit });
		expect(f.state.gitCalls).toContainEqual([
			"ls-tree",
			"--name-only",
			commit,
			"--",
			"shared/component-versions.json",
		]);
		expect(f.state.gitCalls.some((args) => args[1] === `${commit}:package.json`)).toBe(false);
	});
	for (const mode of [
		"wrong-version",
		"wrong-protocol",
		"bad-json",
		"bad-shape",
		"read-error",
		"tree-error",
	]) {
		test(`rejects ${mode}, never treating a bad declaration/read as legacy`, async () => {
			const f = protectedContextFixture();
			f.state.packageVersion = "0.9.1";
			if (mode === "wrong-version")
				f.state.componentConfig = JSON.stringify({
					executor: { version: "0.9.2", protocolVersion: 1 },
				});
			if (mode === "wrong-protocol")
				f.state.componentConfig = JSON.stringify({
					executor: { version: "0.9.1", protocolVersion: 2 },
				});
			if (mode === "bad-json") f.state.componentConfig = "{";
			if (mode === "bad-shape") f.state.componentConfig = "{}";
			if (mode === "read-error") f.state.componentReadError = true;
			if (mode === "tree-error") f.state.treeReadError = true;
			await expect(
				planHelperRelease(".", "executor", "executor-v0.9.1", "", f.options),
			).rejects.toThrow();
			expect(f.state.gitCalls.some((args) => args[1] === `${commit}:package.json`)).toBe(false);
		});
	}
	test("only a proven absent target configuration preserves legacy package validation", async () => {
		const f = protectedContextFixture();
		f.state.componentPresent = false;
		f.state.packageVersion = "0.9.1";
		expect(
			(await planHelperRelease(".", "executor", "executor-v0.9.1", "123", f.options)).version,
		).toBe("0.9.1");
		f.state.packageVersion = "0.9.2";
		await expect(
			planHelperRelease(".", "executor", "executor-v0.9.1", "123", f.options),
		).rejects.toThrow("Legacy executor tag");
	});
});

describe("new executor trusted-control recipe parity", () => {
	test("independent source/control commits with identical executor recipe remain buildable", async () => {
		const f = protectedContextFixture();
		f.environment.GITHUB_SHA = "b".repeat(40);
		const planned = await planHelperRelease(".", "executor", "executor-v0.9.1", "", f.options);
		expect(planned.controlCommit).toBe(f.environment.GITHUB_SHA);
		for (const sha of [commit, f.environment.GITHUB_SHA])
			for (const path of [
				"scripts/lib/helper-build.ts",
				"shared/remote-executor.ts",
				".github/workflows/helpers-release.yml",
			])
				expect(f.state.gitCalls).toContainEqual(["show", `${sha}:${path}`]);
	});
	for (const mode of ["recipe", "toolchain", "read-error"]) {
		test(`new component build rejects trusted-control ${mode} mismatch`, async () => {
			const f = protectedContextFixture();
			f.environment.GITHUB_SHA = "b".repeat(40);
			f.state.recipeChange = mode === "recipe";
			f.state.toolchainChange = mode === "toolchain";
			f.state.recipeReadError = mode === "read-error";
			await expect(
				planHelperRelease(".", "executor", "executor-v0.9.1", "", f.options),
			).rejects.toThrow();
		});
	}
	test("historical sealed bundle restore does not inspect or require today's control recipe", async () => {
		const f = protectedContextFixture();
		f.environment.GITHUB_SHA = "b".repeat(40);
		f.state.recipeReadError = true;
		expect(
			(await planHelperRelease(".", "executor", "executor-v0.9.1", "123", f.options)).sourceRunId,
		).toBe("123");
		expect(f.state.gitCalls.some((args) => args[1]?.includes("helper-build.ts"))).toBe(false);
	});
	test("unconfigured legacy source keeps its previous build path", async () => {
		const f = protectedContextFixture();
		f.environment.GITHUB_SHA = "b".repeat(40);
		f.state.componentPresent = false;
		f.state.packageVersion = "0.9.1";
		f.state.recipeReadError = true;
		expect(
			(await planHelperRelease(".", "executor", "executor-v0.9.1", "", f.options)).version,
		).toBe("0.9.1");
		expect(f.state.gitCalls.some((args) => args[1]?.includes("helper-build.ts"))).toBe(false);
	});
});

describe("executor CLI component identity", () => {
	function fixture(args: string[], protocol = 1) {
		const root = mkdtempSync(resolve(".narrafork/executor-release-cli-"));
		const path = join(root, "fixture.ts");
		writeFileSync(
			path,
			`
import { mock } from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
const read = fs.readFileSync;
const exists = fs.existsSync;
const stat = fs.statSync;
const exec = child.execFileSync;
const writes = [];
const calls = [];
const artifact = Buffer.from("executor version ${componentVersions.executor.version}");
const isArtifact = (path) => /remote-executor[/\\\\]dist[/\\\\]narrafork-executor-linux-amd64$/.test(String(path));
mock.module("node:fs", () => ({ ...fs,
 existsSync: (path) => isArtifact(path) || exists(path),
 statSync: (path) => isArtifact(path) ? {size: artifact.length} : stat(path),
 readFileSync: (path, ...args) => isArtifact(path) ? artifact : String(path).endsWith("protocol.go") ? "const ProtocolVersion = ${protocol}" : read(path, ...args),
 writeFileSync: (path, contents) => { writes.push({path: String(path), manifest: JSON.parse(contents)}); },
}));
mock.module("node:child_process", () => ({ ...child, execFileSync: (path, ...args) => isArtifact(path) ? "executor version ${componentVersions.executor.version}" : exec(path, ...args) }));
mock.module(${JSON.stringify(resolve("scripts/release-helpers.ts"))}, () => ({
 parseHelperReleaseArguments: () => ({options: new Map([["plan", "plan.json"], ["root", ${JSON.stringify(root)}]])}),
 runHelperReleaseController: async (args) => { calls.push(args); },
}));
mock.module(${JSON.stringify(resolve("scripts/lib/helper-release-control.ts"))}, () => ({readHelperReleasePlan: async () => ({kind: "executor", version: "0.5.24"})}));
process.argv = [process.execPath, ${JSON.stringify(resolve("scripts/release-executor.ts"))}, ...${JSON.stringify(args)}];
process.exit = (code) => { throw new Error("fixture exit " + code); };
try { await import(${JSON.stringify(resolve("scripts/release-executor.ts"))}); }
catch (error) { console.log(JSON.stringify({error: error.message, writes, calls})); }
`,
		);
		try {
			const output = execFileSync(process.execPath, [path], {
				cwd: process.cwd(),
				encoding: "utf8",
				timeout: 15_000,
				maxBuffer: 64 * 1024,
				env: { ...process.env, NARRAFORK_HOME: join(root, "data"), HOME: root, USERPROFILE: root },
			});
			return JSON.parse(output.trim().split("\n").at(-1) as string);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	test("legacy server target defaults to component pin, never the application version", () => {
		const result = fixture(["--dry-run", "--upload-only", "--platform=linux-amd64"]);
		expect(result.error).toBe("fixture exit 0");
		expect(result.writes).toHaveLength(1);
		expect(result.writes[0].manifest.version).toBe(componentVersions.executor.version);
		expect(result.writes[0].manifest.protocolVersion).toBe(1);
		expect(result.calls).toHaveLength(0);
	}, 20_000);
	test("server target rejects explicit versions or source protocol inconsistent with config before writes", () => {
		const wrongVersion = fixture([
			`${componentVersions.executor.version}-wrong`,
			"--dry-run",
			"--upload-only",
		]);
		expect(wrongVersion.error).toContain("component-versions.json");
		expect(wrongVersion.writes).toHaveLength(0);
		const wrongProtocol = fixture(["--dry-run", "--upload-only", "--platform=linux-amd64"], 2);
		expect(wrongProtocol.error).toBe("fixture exit 1");
		expect(wrongProtocol.writes).toHaveLength(0);
	}, 40_000);
	test("GitHub historical restore keeps immutable bundle version instead of current pin", () => {
		for (const positional of [[], ["0.5.24"]]) {
			const result = fixture([
				...positional,
				"--target=github",
				"--dry-run",
				"--plan=plan.json",
				"--output=bundle",
			]);
			expect(result.error).toBe("fixture exit 0");
			expect(result.writes).toHaveLength(0);
			expect(result.calls).toEqual([["preview", "--plan=plan.json", "--output=bundle"]]);
		}
		const result = fixture([
			"0.9.1",
			"--target=github",
			"--dry-run",
			"--plan=plan.json",
			"--output=bundle",
		]);
		expect(result.error).toContain("immutable bundle plan");
		expect(result.calls).toHaveLength(0);
	}, 50_000);
});

describe("strict auxiliary controller arguments", () => {
	test("publish is explicit, publish --dry-run is offline and preview is always offline", () => {
		expect(parseHelperReleaseArguments(["publish"]).dryRun).toBe(false);
		expect(parseHelperReleaseArguments(["publish", "--dry-run"]).dryRun).toBe(true);
		expect(parseHelperReleaseArguments(["preview"]).command).toBe("preview");
		expect(() => parseHelperReleaseArguments([])).toThrow("publish explicitly writes");
	});
	for (const args of [
		["preflight", "--kind=helpers", "--tag=helpers-v1.0.0", "--publish"],
		["preflight", "--kind=helpers", "--tag=helpers-v1.0.0", "--publish=yes"],
		["preflight", "--kind=helpers", "--tag=helpers-v1.0.0", "--publish=true", "--publish=false"],
		["publish", "--publish=true"],
		["publish", "--dry-rnu"],
		["publish", "--dry-run=false"],
		["preview", "--dry-run"],
		["publish", "--output"],
		["publish", "--output="],
		["publish", "--plan=one", "--plan=two"],
		["publish", "extra"],
		["build", "--kind=helpers"],
		["build", "--platform=unsupported"],
		["smoke"],
		["assemble", "--source-run-id=123"],
		["restore", "--source-run-id="],
		["restore", "--source-run-id=9007199254740992"],
		["preflight", "--kind=exectuor", "--tag=executor-v1.0.0"],
		["preflight", "--kind=helpers", "--tag=latest"],
		["publish", "--output=line\nbreak"],
	])
		test(`rejects invalid arguments before plan IO: ${JSON.stringify(args)}`, async () => {
			expect(() => parseHelperReleaseArguments(args)).toThrow();
			await expect(runHelperReleaseController(args)).rejects.toThrow();
		});
	test("preflight only accepts an explicit boolean publish intent", () => {
		for (const value of ["true", "false"])
			expect(
				parseHelperReleaseArguments([
					"preflight",
					"--kind=helpers",
					"--tag=helpers-v1.0.0",
					`--publish=${value}`,
				]).options.get("publish"),
			).toBe(value);
	});
	test("preflight allows only its explicit empty restore input", () => {
		expect(
			parseHelperReleaseArguments([
				"preflight",
				"--kind=helpers",
				"--tag=helpers-v1.0.0",
				"--source-run-id=",
			]).options.get("source-run-id"),
		).toBe("");
	});
	test("an original source run frozen by preflight cannot be swapped", () => {
		expect(resolveHelperRestoreSource(plan)).toBe("123");
		expect(resolveHelperRestoreSource(plan, "123")).toBe("123");
		expect(() => resolveHelperRestoreSource(plan, "456")).toThrow("frozen plan provenance");
	});
	test("the normal current-run publisher override is narrowly bound to trusted dispatch context", () => {
		const original = { ...plan, sourceRunId: "" };
		const environment = {
			GITHUB_RUN_ID: "456",
			GITHUB_SHA: commit,
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_REF: "refs/heads/main",
			GITHUB_REPOSITORY: plan.repository,
		};
		expect(resolveHelperRestoreSource(original, "456", environment)).toBe("456");
		for (const changed of [
			{ GITHUB_RUN_ID: "789" },
			{ GITHUB_SHA: "b".repeat(40) },
			{ GITHUB_EVENT_NAME: "pull_request" },
			{ GITHUB_REF: "refs/heads/feature" },
			{ GITHUB_REPOSITORY: "Other/repo" },
		])
			expect(() =>
				resolveHelperRestoreSource(original, "456", { ...environment, ...changed }),
			).toThrow();
		expect(() => resolveHelperRestoreSource(original, "456", {})).toThrow();
	});
});

describe("original immutable helper artifact provenance", () => {
	test("accepts original native-success evidence even when its publisher run failed", () => {
		const run = validateHelperSourceRun(plan, { ...source(), conclusion: "failure" });
		validateHelperSourceJobs(jobs(), run);
		expect(validateHelperBundleArtifact(plan, listing()).id).toBe(456);
	});
	for (const [name, mutate] of [
		[
			"foreign repository",
			(run: ReturnType<typeof source>) => {
				run.head_repository.full_name = "Other/repo";
			},
		],
		[
			"wrong workflow",
			(run: ReturnType<typeof source>) => {
				run.path = ".github/workflows/ci.yml";
			},
		],
		[
			"PR event",
			(run: ReturnType<typeof source>) => {
				run.event = "pull_request";
			},
		],
		[
			"feature branch",
			(run: ReturnType<typeof source>) => {
				run.head_branch = "feature";
			},
		],
		[
			"not finished",
			(run: ReturnType<typeof source>) => {
				run.status = "in_progress";
			},
		],
		[
			"wrong run ID",
			(run: ReturnType<typeof source>) => {
				run.id = 124;
			},
		],
		[
			"too many attempts",
			(run: ReturnType<typeof source>) => {
				run.run_attempt = 9;
			},
		],
	] as const)
		test(`rejects ${name} source run`, () => {
			const run = source();
			mutate(run);
			expect(() => validateHelperSourceRun(plan, run, "999")).toThrow();
		});
	test("the current approved publisher may restore its already-successful bundle before run ends", () => {
		expect(validateHelperSourceRun(plan, { ...source(), status: "in_progress" }, "123").id).toBe(
			123,
		);
	});
	for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"])
		test(`rejects ${conclusion} native smoke`, () => {
			const value = jobs();
			(value.jobs[3] as (typeof value.jobs)[number]).conclusion = conclusion;
			expect(() => validateHelperSourceJobs(value, source())).toThrow();
		});
	test("a checksummed artifact does not substitute for missing native jobs", () => {
		const value = jobs();
		value.jobs.pop();
		value.total_count--;
		expect(() => validateHelperSourceJobs(value, source())).toThrow();
	});
	test("jobs from another SHA are not accepted", () => {
		const value = jobs();
		(value.jobs[0] as (typeof value.jobs)[number]).head_sha = "b".repeat(40);
		expect(() => validateHelperSourceJobs(value, source())).toThrow();
	});
	for (const [name, mutate] of [
		[
			"expired artifact",
			(v: ReturnType<typeof listing>) => {
				(v.artifacts[0] as (typeof v.artifacts)[number]).expired = true;
			},
		],
		[
			"wrong run",
			(v: ReturnType<typeof listing>) => {
				(v.artifacts[0] as (typeof v.artifacts)[number]).workflow_run.id = 124;
			},
		],
		[
			"missing digest",
			(v: ReturnType<typeof listing>) => {
				(v.artifacts[0] as (typeof v.artifacts)[number]).digest = "";
			},
		],
		[
			"oversized archive",
			(v: ReturnType<typeof listing>) => {
				(v.artifacts[0] as (typeof v.artifacts)[number]).size_in_bytes = 512 * 1024 * 1024 + 1;
			},
		],
		[
			"wrong kind",
			(v: ReturnType<typeof listing>) => {
				(v.artifacts[0] as (typeof v.artifacts)[number]).name = `helper-bundle-executor-${commit}`;
			},
		],
		[
			"duplicate name",
			(v: ReturnType<typeof listing>) => {
				v.artifacts.push({ ...(v.artifacts[0] as (typeof v.artifacts)[number]), id: 457 });
				v.total_count++;
			},
		],
	] as const)
		test(`rejects ${name}`, () => {
			const value = listing();
			mutate(value);
			expect(() => validateHelperBundleArtifact(plan, value)).toThrow();
		});
});
describe("bounded helper ZIP before extraction", () => {
	test("accepts regular raw binary files", () => {
		expect(parseHelperArtifactZipDirectory(directory(), 1)).toEqual(["rg-linux-x64"]);
	});
	for (const name of ["../outside", "nested/file", "/absolute", "bad..name"])
		test(`rejects ${name}`, () => {
			expect(() => parseHelperArtifactZipDirectory(directory(name), 1)).toThrow();
		});
	test("rejects symlink even when its filename is flat", () => {
		expect(() =>
			parseHelperArtifactZipDirectory(directory("rg-linux-x64", 10, 0o120777), 1),
		).toThrow();
	});
	test("rejects oversized expanded binary before unzip", () => {
		expect(() =>
			parseHelperArtifactZipDirectory(directory("rg-linux-x64", 32 * 1024 * 1024 + 1), 1),
		).toThrow();
	});
	test("rejects oversized manifest/license before unzip", () => {
		expect(() => parseHelperArtifactZipDirectory(directory("musl.txt", 65537), 1)).toThrow();
	});
	test("rejects duplicate entries", () => {
		expect(() =>
			parseHelperArtifactZipDirectory(Buffer.concat([directory(), directory()]), 2),
		).toThrow();
	});
	test("rejects encrypted members", () => {
		const value = directory();
		value.writeUInt16LE(1, 8);
		expect(() => parseHelperArtifactZipDirectory(value, 1)).toThrow();
	});
	test("rejects too many members", () => {
		expect(() => parseHelperArtifactZipDirectory(directory(), 46)).toThrow();
	});
});
describe("GCC runtime notice provenance", () => {
	test("requires the notice and preserves both fixed upstream license documents byte for byte", () => {
		const bytes = readFileSync(new URL("../../licenses/extra/gcc-runtime.txt", import.meta.url));
		const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
		expect(HELPER_LICENSE_FILES).toContain("gcc-runtime.txt");
		expect(bytes.length).toBe(38472);
		expect(hash(bytes.subarray(0, 35147))).toBe(
			"8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
		);
		expect(bytes[35147]).toBe(10);
		expect(hash(bytes.subarray(35148))).toBe(
			"9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74",
		);
		expect(hash(bytes)).toBe("5b9f67413587264ed418abab5d052fa8229d8cf1e35e3ad2ceaf9d9e89f45edb");
		const entries = JSON.parse(
			readFileSync(new URL("../../licenses/extra/entries.json", import.meta.url), "utf8"),
		);
		expect(
			entries.find((entry: { textFile: string }) => entry.textFile === "gcc-runtime.txt").license,
		).toBe("GPL-3.0-or-later WITH GCC-exception-3.1");
	});
});

describe("protected workflow and pinned recipe guards", () => {
	const workflow = readFileSync(
		new URL("../../.github/workflows/helpers-release.yml", import.meta.url),
		"utf8",
	);
	const build = readFileSync(new URL("../../scripts/lib/helper-build.ts", import.meta.url), "utf8");
	test("only publisher has write and release Environment; defaults build-only", () => {
		expect(workflow.match(/contents: write/g)?.length).toBe(1);
		expect(workflow).toContain("environment: release");
		expect(workflow).toContain("default: false");
		expect(workflow).toContain("always() && !cancelled() && inputs.publish");
	});
	test("all reusable actions and Bun versions are pinned", () => {
		const uses = [...workflow.matchAll(/uses: ([^\n ]+)/g)].map((match) => match[1]);
		expect(uses.length).toBeGreaterThan(0);
		expect(uses.every((value) => /@[0-9a-f]{40}$/.test(value as string))).toBe(true);
		expect(workflow).not.toContain("bun-version: latest");
		expect(workflow).toContain("bun-version: 1.4.3");
	});
	test("native matrix has all six platform runners and original-bundle recovery", () => {
		for (const platform of HELPER_PLATFORMS) expect(workflow).toContain(`platform: ${platform}`);
		expect(workflow).toContain("windows-11-arm");
		expect(workflow).toContain("macos-26-intel");
		expect(workflow).toContain("source_run_id");
		expect(workflow).not.toContain("ci-release.ts");
	});
	test("Linux/source/toolchain cannot silently float or use native CPU tuning", () => {
		expect(build).toMatch(/alpine:3\.22\.1@sha256:[0-9a-f]{64}/);
		expect(build).toContain("gcc=14.2.0-r6");
		expect(build).toContain("musl-dev=1.2.5-r12");
		expect(build).toContain("Xcode 26.0.1");
		expect(build).not.toContain("-march=native");
		expect(build).not.toContain("musl.cc");
		expect(build).not.toContain("alpine:latest");
	});
});
