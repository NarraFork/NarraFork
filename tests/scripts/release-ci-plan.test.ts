import { describe, expect, test } from "bun:test";
import {
	ciApiList,
	createCiReleasePlan,
	revalidateCiReleasePlan,
	validateCiReleasePlan,
} from "../../scripts/lib/ci-release-plan";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_REPOSITORY,
	CI_RELEASE_WORKFLOW,
} from "../../scripts/lib/ci-release-types";

const commit = "a".repeat(40);
const workflowCommit = "b".repeat(40);
const main = "c".repeat(40);
const changelog = {
	version: "1.2.0",
	date: "2026-10-08",
	en: "Release notes",
	"zh-CN": "发布说明",
};
const env = {
	GITHUB_REPOSITORY: CI_RELEASE_REPOSITORY,
	GITHUB_EVENT_NAME: "workflow_dispatch",
	GITHUB_REF: "refs/heads/main",
	GITHUB_WORKFLOW_REF: `${CI_RELEASE_REPOSITORY}/${CI_RELEASE_WORKFLOW}@refs/heads/main`,
	GITHUB_WORKFLOW_SHA: workflowCommit,
	GITHUB_SHA: workflowCommit,
	GITHUB_RUN_ID: "123",
	GITHUB_RUN_ATTEMPT: "1",
};
function contents(value: unknown) {
	const bytes = Buffer.from(JSON.stringify(value));
	return {
		type: "file",
		encoding: "base64",
		size: bytes.length,
		content: bytes.toString("base64"),
	};
}
function fixture() {
	const calls: string[][] = [];
	const state = {
		calls,
		tag: commit,
		annotated: false,
		ancestor: true,
		pkg: { version: "1.2.0", packageManager: `bun@${CI_RELEASE_BUN}` },
		changelog: { ...changelog },
		marker: true,
		releases: [] as unknown[],
		environment: {
			name: "release",
			protection_rules: [
				{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
			],
			deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
		},
		branches: [{ name: "main", type: "branch" }],
		async run(args: string[]) {
			calls.push(args);
			expect(args[0]).toBe("api");
			const path = args[1].replace(`repos/${CI_RELEASE_REPOSITORY}/`, "");
			if (path === "git/ref/tags/v1.2.0")
				return JSON.stringify({
					object: { type: state.annotated ? "tag" : "commit", sha: state.tag },
				});
			if (path.startsWith("git/tags/"))
				return JSON.stringify({ object: { type: "commit", sha: state.tag } });
			if (path === "git/ref/heads/main")
				return JSON.stringify({ object: { type: "commit", sha: main } });
			if (path.startsWith("compare/"))
				return JSON.stringify({
					status: state.ancestor ? "ahead" : "diverged",
					merge_base_commit: { sha: path.slice(8, 48) },
				});
			if (path === `contents/package.json?ref=${commit}`)
				return JSON.stringify(contents(state.pkg));
			if (path === `contents/changelogs/v1.2.0.json?ref=${commit}`)
				return JSON.stringify(contents(state.changelog));
			if (path === `contents/scripts/lib/ci-release-types.ts?ref=${commit}`) {
				if (!state.marker) throw new Error("HTTP 404");
				return JSON.stringify({ type: "file", size: 100 });
			}
			if (path.startsWith("releases?")) return JSON.stringify(state.releases);
			if (path === "environments/release") return JSON.stringify(state.environment);
			if (path.startsWith("environments/release/deployment-branch-policies?"))
				return JSON.stringify({
					total_count: state.branches.length,
					branch_policies: state.branches,
				});
			throw new Error(`Unexpected API ${path}`);
		},
	};
	return state;
}
function options(state: ReturnType<typeof fixture>) {
	return { root: process.cwd(), tag: "v1.2.0", publish: false, env, run: state.run };
}

describe("CI release plan trust boundary", () => {
	test("pins target and workflow separately; dry run needs no environment", async () => {
		const state = fixture();
		const plan = await createCiReleasePlan(options(state));
		expect(plan).toMatchObject({
			commit,
			workflowCommit,
			channel: "stable",
			baselines: [],
			runId: 123,
			runAttempt: 1,
		});
		expect(state.calls.some((call) => call[1].includes("environments/"))).toBe(false);
	});
	test("peels annotated tag", async () => {
		const state = fixture();
		state.annotated = true;
		expect((await createCiReleasePlan(options(state))).commit).toBe(commit);
		expect(state.calls.some((call) => call[1].includes("git/tags/"))).toBe(true);
	});
	for (const tag of [
		"1.2.0",
		"v01.2.0",
		"v1.2.0; touch pwn",
		"v1.2.0\n",
		"v1.2.0-beta",
		"--help",
		"v1.2.0/../main",
	]) {
		test(`rejects unsafe or noncanonical tag ${JSON.stringify(tag)}`, async () => {
			const state = fixture();
			await expect(createCiReleasePlan({ ...options(state), tag })).rejects.toThrow();
			expect(state.calls).toHaveLength(0);
		});
	}
	for (const change of [
		{ GITHUB_REPOSITORY: "attacker/NarraFork" },
		{ GITHUB_EVENT_NAME: "pull_request" },
		{ GITHUB_REF: "refs/heads/fork" },
		{ GITHUB_WORKFLOW_REF: `${CI_RELEASE_REPOSITORY}/fake.yml@refs/heads/main` },
		{ GITHUB_WORKFLOW_SHA: "bad" },
		{ GITHUB_SHA: commit },
		{ GITHUB_RUN_ID: "12e3" },
	]) {
		test(`rejects untrusted dispatch ${JSON.stringify(change)}`, async () => {
			const state = fixture();
			await expect(
				createCiReleasePlan({ ...options(state), env: { ...env, ...change } }),
			).rejects.toThrow();
			expect(state.calls).toHaveLength(0);
		});
	}
	test("rejects target or workflow outside main ancestry", async () => {
		const state = fixture();
		state.ancestor = false;
		await expect(createCiReleasePlan(options(state))).rejects.toThrow("ancestor");
	});
	for (const change of [
		{ version: "1.3.0" },
		{ date: "2026-02-30" },
		{ en: " " },
		{ "zh-CN": "" },
	]) {
		test(`rejects changelog ${JSON.stringify(change)}`, async () => {
			const state = fixture();
			Object.assign(state.changelog, change);
			await expect(createCiReleasePlan(options(state))).rejects.toThrow();
		});
	}
	test("requires target version, Bun pin and strict-build marker", async () => {
		for (const field of ["version", "packageManager", "marker"]) {
			const state = fixture();
			if (field === "marker") state.marker = false;
			else state.pkg[field as "version" | "packageManager"] = "wrong";
			await expect(createCiReleasePlan(options(state))).rejects.toThrow();
		}
	});
	test("existing draft assets or public release require original bundle", async () => {
		for (const draft of [true, false]) {
			const state = fixture();
			state.releases = [{ id: 1, tag_name: "v1.2.0", draft, assets: draft ? [{}] : [] }];
			await expect(createCiReleasePlan(options(state))).rejects.toThrow("source_run_id");
			await expect(
				createCiReleasePlan({ ...options(state), sourceRunId: 122 }),
			).resolves.toMatchObject({ commit });
		}
	});
	test("publish requires reviewers and exact main-only policy", async () => {
		const state = fixture();
		await expect(createCiReleasePlan({ ...options(state), publish: true })).resolves.toMatchObject({
			commit,
		});
		state.environment.protection_rules = [];
		await expect(createCiReleasePlan({ ...options(state), publish: true })).rejects.toThrow(
			"required reviewers",
		);
	});
	for (const branches of [
		[],
		[{ name: "*", type: "branch" }],
		[{ name: "main", type: "tag" }],
		[
			{ name: "main", type: "branch" },
			{ name: "v*", type: "tag" },
		],
	]) {
		test(`rejects permissive environment ${JSON.stringify(branches)}`, async () => {
			const state = fixture();
			state.branches = branches;
			await expect(createCiReleasePlan({ ...options(state), publish: true })).rejects.toThrow(
				"only the main",
			);
		});
	}
	test("missing environment fails closed without a write", async () => {
		const state = fixture();
		const run = (args: string[]) => {
			if (args[1].endsWith("environments/release")) throw new Error("HTTP 404");
			return state.run(args);
		};
		await expect(createCiReleasePlan({ ...options(state), publish: true, run })).rejects.toThrow(
			"404",
		);
		expect(state.calls.every((args) => args.length === 2)).toBe(true);
	});
	test("publication rechecks moved tag and lost main ancestry", async () => {
		const state = fixture();
		const plan = await createCiReleasePlan(options(state));
		state.tag = "d".repeat(40);
		await expect(revalidateCiReleasePlan(plan, options(state))).rejects.toThrow("tag moved");
		state.tag = commit;
		state.ancestor = false;
		await expect(revalidateCiReleasePlan(plan, options(state))).rejects.toThrow("ancestor");
	});
	test("plan rejects extra fields and provenance/version mutation", async () => {
		const plan = await createCiReleasePlan(options(fixture()));
		for (const patch of [
			{ repository: "fork/repo" },
			{ commit: "abc" },
			{ commit: `${commit}\n` },
			{ tag: "v1.3.0" },
			{ channel: "beta" },
			{ runAttempt: 0 },
			{ extra: true },
			{ baselines: [{}] },
		]) {
			expect(() => validateCiReleasePlan({ ...plan, ...patch })).toThrow();
		}
	});
	test("keyed pagination rejects truncated or inconsistent API counts", async () => {
		await expect(
			ciApiList(async () => JSON.stringify({ total_count: 2, jobs: [{}] }), "jobs", "jobs"),
		).rejects.toThrow("truncated");
		let page = 0;
		await expect(
			ciApiList(
				async () =>
					JSON.stringify({ total_count: ++page === 1 ? 101 : 100, jobs: Array(100).fill({}) }),
				"jobs",
				"jobs",
			),
		).rejects.toThrow("changed");
		await expect(
			ciApiList(async () => JSON.stringify({ total_count: 1001, jobs: [] }), "jobs", "jobs"),
		).rejects.toThrow();
	});

	test("pagination fails closed at ten full pages, including API/output failures", async () => {
		let calls = 0;
		await expect(
			ciApiList(async () => {
				calls++;
				return JSON.stringify(Array(100).fill({}));
			}, "releases"),
		).rejects.toThrow("pagination");
		expect(calls).toBe(10);
		await expect(
			ciApiList(async () => {
				throw new Error("HTTP 403");
			}, "releases"),
		).rejects.toThrow("403");
		await expect(ciApiList(async () => " ".repeat(1024 * 1024 + 1), "releases")).rejects.toThrow(
			"output limit",
		);
	});
});
