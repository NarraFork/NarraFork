import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
		if (args[0] === "rev-parse") return commit;
		if (args[0] === "merge-base") return "";
		if (args[0] === "show") return "const ProtocolVersion = 1\n";
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
		expect(workflow).toContain("bun-version: 1.4.2");
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
