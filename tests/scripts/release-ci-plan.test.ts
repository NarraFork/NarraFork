import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	assertCiMainAncestor,
	ciApiList,
	createCiReleasePlan,
	readTargetRemoteFrontendCapability,
	revalidateCiReleasePlan,
	validateCiReleasePlan,
} from "../../scripts/lib/ci-release-plan";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_REPOSITORY,
	CI_RELEASE_WORKFLOW,
} from "../../scripts/lib/ci-release-types";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";
import { REMOTE_FRONTEND_CAPABILITY } from "../../shared/remote-access/application";

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
function fixture(repository = CI_RELEASE_REPOSITORY, defaultBranch = "main") {
	const calls: string[][] = [];
	const state = {
		calls,
		tag: commit,
		annotated: false,
		ancestor: true,
		pkg: { version: "1.2.0", packageManager: `bun@${CI_RELEASE_BUN}` },
		changelog: { ...changelog },
		marker: true,
		componentVersions: undefined as unknown,
		remoteFrontend: undefined as unknown,
		remoteFrontendError: undefined as Error | undefined,
		releases: [] as unknown[],
		environment: {
			name: "release",
			protection_rules: [
				{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
			],
			deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
		},
		branches: [{ name: defaultBranch, type: "branch" }],
		async run(args: string[]) {
			calls.push(args);
			expect(args[0]).toBe("api");
			if (args[1] === `repos/${repository}`)
				return JSON.stringify({ full_name: repository, default_branch: defaultBranch });
			if (args[1] === "graphql") {
				return JSON.stringify({
					data: {
						repository: {
							nameWithOwner: repository,
							releases: {
								nodes: state.releases,
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				});
			}
			const path = args[1].replace(`repos/${repository}/`, "");
			if (path === "git/ref/tags/v1.2.0")
				return JSON.stringify({
					object: { type: state.annotated ? "tag" : "commit", sha: state.tag },
				});
			if (path.startsWith("git/tags/"))
				return JSON.stringify({ object: { type: "commit", sha: state.tag } });
			if (path === `git/ref/heads/${encodeURIComponent(defaultBranch)}`)
				return JSON.stringify({ object: { type: "commit", sha: main } });
			if (path.startsWith("compare/"))
				return JSON.stringify({
					status: state.ancestor ? "ahead" : "diverged",
					merge_base_commit: { sha: path.slice(8, 48) },
				});
			const sharedTree = "1".repeat(40);
			const config = Buffer.from(JSON.stringify(state.componentVersions ?? null));
			const configSha = createHash("sha1")
				.update(`blob ${config.length}\0`)
				.update(config)
				.digest("hex");
			if (path === `git/trees/${commit}`)
				return JSON.stringify({
					truncated: false,
					tree:
						state.componentVersions === undefined
							? []
							: [{ path: "shared", mode: "040000", type: "tree", sha: sharedTree }],
				});
			if (path === `git/trees/${sharedTree}`)
				return JSON.stringify({
					truncated: false,
					tree: [
						{
							path: "component-versions.json",
							mode: "100644",
							type: "blob",
							sha: configSha,
							size: config.length,
						},
					],
				});
			if (path === `git/blobs/${configSha}`) return config.toString("base64");
			if (path === `contents/shared/remote-access/frontend-capability.json?ref=${commit}`) {
				if (state.remoteFrontendError) throw state.remoteFrontendError;
				if (state.remoteFrontend === undefined) throw new Error("HTTP 404");
				return JSON.stringify(contents(state.remoteFrontend));
			}
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

const componentEvidence = {
	executor: {
		version: "0.9.1",
		protocolVersion: 1,
		tag: "executor-v0.9.1",
		commit: "d".repeat(40),
		manifestSha256: "e".repeat(64),
		buildInputsSha256: "f".repeat(64),
	},
};

describe("frozen remote frontend declaration", () => {
	test("reads target commit rather than control commit and preserves historical absence", async () => {
		const state = fixture();
		expect((await createCiReleasePlan(options(state))).remoteFrontend).toBeUndefined();
		state.remoteFrontend = REMOTE_FRONTEND_CAPABILITY;
		const plan = await createCiReleasePlan(options(state));
		expect(plan.remoteFrontend).toEqual(REMOTE_FRONTEND_CAPABILITY);
		expect(
			state.calls
				.filter((call) => call[1].includes("frontend-capability"))
				.every((call) => call[1].endsWith(`ref=${commit}`)),
		).toBe(true);
		state.remoteFrontend = undefined;
		await expect(revalidateCiReleasePlan(plan, options(state))).rejects.toThrow(
			"declaration differs",
		);
	});
	test("only actual HTTP 404 is optional; bad JSON, unknown ABI and transport errors fail", async () => {
		for (const message of ["HTTP 403", "HTTP 500", "timeout", "connection reset"]) {
			const state = fixture();
			state.remoteFrontendError = new Error(message);
			await expect(createCiReleasePlan(options(state))).rejects.toThrow(message);
		}
		const state = fixture();
		state.remoteFrontend = { ...REMOTE_FRONTEND_CAPABILITY, wireVersion: 99 };
		await expect(createCiReleasePlan(options(state))).rejects.toThrow();
		await expect(
			readTargetRemoteFrontendCapability(
				async () => "HTTP 404 is malformed JSON",
				commit,
				CI_RELEASE_REPOSITORY,
			),
		).rejects.toThrow();
		await expect(
			readTargetRemoteFrontendCapability(
				async () =>
					JSON.stringify({
						...contents({}),
						content: Buffer.from("not JSON HTTP 404").toString("base64"),
						size: 17,
					}),
				commit,
				CI_RELEASE_REPOSITORY,
			),
		).rejects.toThrow();
	});
});

describe("CI release plan trust boundary", () => {
	test("ancestry checks project only trust fields before bounded output collection", async () => {
		const state = fixture();
		await assertCiMainAncestor(state.run, commit);
		expect(state.calls.at(-1)).toEqual([
			"api",
			`repos/${CI_RELEASE_REPOSITORY}/compare/${commit}...${main}?per_page=1`,
			"--jq",
			"{status, merge_base_commit: {sha: .merge_base_commit.sha}}",
		]);
		state.ancestor = false;
		await expect(assertCiMainAncestor(state.run, commit)).rejects.toThrow("not an ancestor");
		await expect(
			assertCiMainAncestor(async (args) => {
				if (args[1].includes("/compare/")) {
					return JSON.stringify({ status: "ahead", merge_base_commit: { sha: main } });
				}
				return state.run(args);
			}, commit),
		).rejects.toThrow("not an ancestor");
	});
	test("component evidence has strict bounded structure and its own version/tag identity", async () => {
		const plan = await createCiReleasePlan(options(fixture()));
		expect(validateCiReleasePlan({ ...plan, componentEvidence }).componentEvidence).toEqual(
			componentEvidence,
		);
		for (const executor of [
			{ ...componentEvidence.executor, version: "v0.9.1" },
			{ ...componentEvidence.executor, version: "1".repeat(65) },
			{ ...componentEvidence.executor, tag: "executor-v0.9.2" },
			{ ...componentEvidence.executor, tag: "x".repeat(81) },
			{ ...componentEvidence.executor, protocolVersion: 0 },
			{ ...componentEvidence.executor, protocolVersion: 2 ** 31 },
			{ ...componentEvidence.executor, commit: "d".repeat(7) },
			{ ...componentEvidence.executor, manifestSha256: "bad" },
			{ ...componentEvidence.executor, buildInputsSha256: "F".repeat(64) },
			{ ...componentEvidence.executor, extra: true },
		]) {
			expect(() => validateCiReleasePlan({ ...plan, componentEvidence: { executor } })).toThrow();
		}
		expect(() =>
			validateCiReleasePlan({ ...plan, componentEvidence: { ...componentEvidence, extra: true } }),
		).toThrow();
	});
	test("only online publishing collects evidence; builds perform zero component checks", async () => {
		const state = fixture();
		const dependencies = createHelperDistributionDependencies("0.9.1");
		const calls: string[] = [];
		const componentChecks = {
			readDependencies: async () => {
				calls.push("read");
				return dependencies;
			},
			collectEvidence: async () => {
				calls.push("collect");
				return componentEvidence;
			},
		};
		expect(
			(await createCiReleasePlan({ ...options(state), componentChecks })).componentEvidence,
		).toBeUndefined();
		expect(calls).toEqual([]);
		const plan = await createCiReleasePlan({ ...options(state), publish: true, componentChecks });
		expect(plan.componentEvidence).toEqual(componentEvidence);
		expect(calls).toEqual(["read", "collect"]);
	});
	test("index recovery preflight skips unavailable components but still requires protected publication", async () => {
		const state = fixture();
		state.componentVersions = { executor: { version: "0.9.1", protocolVersion: 1 } };
		state.releases = [
			{
				databaseId: 1,
				tagName: "v1.2.0",
				isDraft: false,
				isPrerelease: false,
				publishedAt: "2026-10-08T00:00:00Z",
				releaseAssets: { totalCount: 18 },
			},
		];
		let componentCalls = 0;
		const unavailable = async () => {
			componentCalls++;
			throw new Error("helpers/executor unavailable");
		};
		const opts = {
			...options(state),
			publish: true,
			indexOnly: true,
			sourceRunId: 122,
			componentChecks: { readDependencies: unavailable, collectEvidence: unavailable },
		};
		const plan = await createCiReleasePlan(opts);
		expect(plan.componentEvidence).toBeUndefined();
		expect(componentCalls).toBe(0);
		expect(state.calls.some((call) => call[1].endsWith("environments/release"))).toBe(true);
		await expect(createCiReleasePlan({ ...opts, indexOnly: false })).rejects.toThrow(
			"helpers/executor unavailable",
		);
		expect(componentCalls).toBe(1);
		state.environment.protection_rules = [];
		await expect(createCiReleasePlan(opts)).rejects.toThrow("required reviewers");
		expect(componentCalls).toBe(1);
	});
	test.each([
		false,
		true,
	])("published recovery preserves sealed evidence=%s without remote readiness, but rejects identity changes", async (withEvidence) => {
		const state = fixture();
		state.componentVersions = { executor: { version: "0.9.1", protocolVersion: 1 } };
		const original = await createCiReleasePlan(options(state));
		const plan = withEvidence ? { ...original, componentEvidence } : original;
		const raw = JSON.stringify(plan);
		const dependencies = createHelperDistributionDependencies("0.9.1");
		let verified = 0;
		const opts = {
			...options(state),
			publish: true,
			requireAlreadyPublished: true,
			helperDistribution: dependencies,
			componentChecks: {
				verifyEvidence: async () => {
					verified++;
					throw new Error("helpers/executor unavailable");
				},
			},
		};
		expect(await revalidateCiReleasePlan(plan, opts)).toEqual(plan);
		expect(JSON.stringify(plan)).toBe(raw);
		expect(verified).toBe(0);
		for (const helperDistribution of [undefined, createHelperDistributionDependencies("0.9.2")]) {
			await expect(revalidateCiReleasePlan(plan, { ...opts, helperDistribution })).rejects.toThrow(
				"target component configuration",
			);
		}
		await expect(
			revalidateCiReleasePlan(plan, {
				...opts,
				requireAlreadyPublished: false,
			}),
		).rejects.toThrow("helpers/executor unavailable");
		expect(verified).toBe(1);
		state.environment.protection_rules = [];
		await expect(revalidateCiReleasePlan(plan, opts)).rejects.toThrow("required reviewers");
		state.tag = "d".repeat(40);
		await expect(revalidateCiReleasePlan(plan, opts)).rejects.toThrow("tag moved");
		state.tag = commit;
		state.changelog.en = "changed";
		await expect(revalidateCiReleasePlan(plan, opts)).rejects.toThrow("changelog changed");
		expect(verified).toBe(1);
	});
	test("online preflight derives independent pins from exact target tree; malformed JSON fails closed", async () => {
		const state = fixture("Example/Fork");
		state.componentVersions = { executor: { version: "0.9.1", protocolVersion: 1 } };
		const forkEnv = {
			...env,
			GITHUB_REPOSITORY: "Example/Fork",
			GITHUB_WORKFLOW_REF: `Example/Fork/${CI_RELEASE_WORKFLOW}@refs/heads/main`,
		};
		let collected = 0;
		const componentChecks = {
			collectEvidence: async (input: {
				repository: string;
				targetCommit: string;
				dependencies?: unknown;
			}) => {
				collected++;
				expect(input.repository).toBe("Example/Fork");
				expect(input.targetCommit).toBe(commit);
				expect(input.dependencies).toEqual(createHelperDistributionDependencies("0.9.1"));
				return componentEvidence;
			},
		};
		const opts = { ...options(state), env: forkEnv, componentChecks };
		expect((await createCiReleasePlan(opts)).componentEvidence).toBeUndefined();
		expect(state.calls.some((call) => /git\/(trees|blobs)|executor-v/.test(call[1]))).toBe(false);
		expect((await createCiReleasePlan({ ...opts, publish: true })).componentEvidence).toEqual(
			componentEvidence,
		);
		state.componentVersions = { executor: { version: "0.9.1", protocolVersion: 1 }, extra: true };
		await expect(createCiReleasePlan({ ...opts, publish: true })).rejects.toThrow(
			"Unknown distribution field",
		);
		expect(collected).toBe(1);
		expect(
			state.calls.every(
				(call) => call[1] === "graphql" || call[1].startsWith("repos/Example/Fork"),
			),
		).toBe(true);
	});
	test("publisher revalidation adds evidence to a new control plan without mutating old bundle plan", async () => {
		const state = fixture();
		const original = await createCiReleasePlan(options(state));
		const raw = JSON.stringify(original);
		const dependencies = createHelperDistributionDependencies("0.9.1");
		let verified = 0;
		const componentChecks = {
			readDependencies: async () => dependencies,
			verifyEvidence: async () => {
				verified++;
				return componentEvidence;
			},
		};
		const opts = {
			...options(state),
			publish: true,
			componentChecks,
			helperDistribution: dependencies,
		};
		const control = await revalidateCiReleasePlan(original, opts);
		expect(control.componentEvidence).toEqual(componentEvidence);
		expect(JSON.stringify(original)).toBe(raw);
		expect(original.componentEvidence).toBeUndefined();
		for (const helperDistribution of [
			undefined,
			createHelperDistributionDependencies("0.9.2"),
			createHelperDistributionDependencies("0.9.1", 2),
		]) {
			await expect(
				revalidateCiReleasePlan(original, { ...opts, helperDistribution }),
			).rejects.toThrow("target component configuration");
		}
		expect(verified).toBe(1);
		await expect(
			revalidateCiReleasePlan(original, {
				...opts,
				componentChecks: {
					...componentChecks,
					verifyEvidence: async () => ({
						executor: { ...componentEvidence.executor, version: "0.9.2", tag: "executor-v0.9.2" },
					}),
				},
			}),
		).rejects.toThrow("evidence/dependency");
	});
	test("legacy targets retain old declaration identity and never acquire current pin evidence", async () => {
		const state = fixture();
		const plan = await createCiReleasePlan(options(state));
		const opts = { ...options(state), publish: true };
		expect(
			(
				await revalidateCiReleasePlan(plan, {
					...opts,
					helperDistribution: createHelperDistributionDependencies(plan.version),
				})
			).componentEvidence,
		).toBeUndefined();
		await expect(
			revalidateCiReleasePlan(plan, {
				...opts,
				helperDistribution: createHelperDistributionDependencies("0.9.1"),
			}),
		).rejects.toThrow("Legacy target");
		await expect(revalidateCiReleasePlan({ ...plan, componentEvidence }, opts)).rejects.toThrow(
			"Legacy target",
		);
	});
	test("retains validated helper dependencies from published baseline metadata", async () => {
		const plan = await createCiReleasePlan(options(fixture()));
		const dependencies = createHelperDistributionDependencies("0.9.1");
		const name = "narrafork-1.1.0-linux-x64";
		const baseline = {
			releaseId: 100,
			version: "1.1.0",
			platform: "linux-x64",
			binaryAsset: { id: 101, name, size: 128 },
			metadataAsset: { id: 102, name: `${name}.metadata.json`, size: 512 },
			metadataSha256: "d".repeat(64),
			metadata: {
				name,
				platform: "linux-x64",
				target: "bun-linux-x64",
				version: "1.1.0",
				commit,
				repository: CI_RELEASE_REPOSITORY,
				buildDate: "2026-10-01T00:00:00.000Z",
				size: 128,
				sha256: "e".repeat(64),
				sha512: Buffer.alloc(64, 1).toString("base64"),
				helperDistribution: dependencies,
			},
		};
		const input = { ...plan, baselines: [baseline] };
		expect(validateCiReleasePlan(input).baselines[0]?.metadata.helperDistribution).toEqual(
			dependencies,
		);
		for (const versions of [
			[1, 2],
			[1, 2, 3],
			[3, 1, 2],
		]) {
			expect(
				validateCiReleasePlan({
					...plan,
					baselines: [
						{ ...baseline, metadata: { ...baseline.metadata, recoveryManifestVersions: versions } },
					],
				}).baselines[0]?.metadata.recoveryManifestVersions,
			).toEqual([...versions].sort((a, b) => a - b));
		}
		expect(
			validateCiReleasePlan(input).baselines[0]?.metadata.recoveryManifestVersions,
		).toBeUndefined();
		for (const versions of [[], [0], [256], [1, 1], [1.5], ["1"], null]) {
			expect(() =>
				validateCiReleasePlan({
					...plan,
					baselines: [
						{ ...baseline, metadata: { ...baseline.metadata, recoveryManifestVersions: versions } },
					],
				}),
			).toThrow();
		}
		const { helperDistribution: _dependencies, ...legacy } = baseline.metadata;
		expect(
			validateCiReleasePlan({ ...plan, baselines: [{ ...baseline, metadata: legacy }] })
				.baselines[0]?.metadata.helperDistribution,
		).toBeUndefined();
		for (const dependency of [
			{ ...dependencies, executor: { ...dependencies.executor, protocolVersion: 0 } },
			{ ...dependencies, helpers: { ...dependencies.helpers, extra: true } },
			{ ...dependencies, executor: { ...dependencies.executor, tag: "executor-v9.9.9" } },
			null,
		]) {
			expect(() =>
				validateCiReleasePlan({
					...plan,
					baselines: [
						{ ...baseline, metadata: { ...baseline.metadata, helperDistribution: dependency } },
					],
				}),
			).toThrow();
		}
		expect(() =>
			validateCiReleasePlan({
				...plan,
				baselines: [{ ...baseline, metadata: { ...baseline.metadata, unknown: true } }],
			}),
		).toThrow();
	});
	test("fork dispatch pins API default branch and refuses official plans", async () => {
		const repository = "Example/Custom";
		const defaultBranch = "release/trunk";
		const state = fixture(repository, defaultBranch);
		const forkEnv = {
			...env,
			GITHUB_REPOSITORY: repository,
			GITHUB_REF: `refs/heads/${defaultBranch}`,
			GITHUB_WORKFLOW_REF: `${repository}/${CI_RELEASE_WORKFLOW}@refs/heads/${defaultBranch}`,
		};
		const opts = { ...options(state), env: forkEnv, publish: true };
		const plan = await createCiReleasePlan(opts);
		expect(plan).toMatchObject({ repository, defaultBranch });
		expect(
			state.calls.every(
				(args) => args[1] === "graphql" || args[1].startsWith(`repos/${repository}`),
			),
		).toBe(true);
		await revalidateCiReleasePlan(plan, opts);
		await expect(
			revalidateCiReleasePlan({ ...plan, repository: CI_RELEASE_REPOSITORY }, opts),
		).rejects.toThrow("repository/default branch");
		await expect(
			revalidateCiReleasePlan({ ...plan, defaultBranch: undefined }, opts),
		).rejects.toThrow("repository/default branch");
		state.branches = [{ name: "main", type: "branch" }];
		await expect(createCiReleasePlan(opts)).rejects.toThrow("environment");
	});
	test("matching refs cannot override repository API default branch", async () => {
		const state = fixture();
		await expect(
			createCiReleasePlan({
				...options(state),
				env: {
					...env,
					GITHUB_REF: "refs/heads/other",
					GITHUB_WORKFLOW_REF: `${CI_RELEASE_REPOSITORY}/${CI_RELEASE_WORKFLOW}@refs/heads/other`,
				},
			}),
		).rejects.toThrow("default branch");
	});
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
			state.releases = [
				{
					databaseId: 1,
					tagName: "v1.2.0",
					isDraft: draft,
					isPrerelease: false,
					publishedAt: null,
					releaseAssets: { totalCount: draft ? 1 : 0 },
				},
			];
			await expect(createCiReleasePlan(options(state))).rejects.toThrow("source_run_id");
			await expect(
				createCiReleasePlan({ ...options(state), sourceRunId: 122 }),
			).resolves.toMatchObject({ commit });
		}
	});
	test("index-only requires existing published assets, without demanding a rebuild bundle", async () => {
		const state = fixture();
		const opts = { ...options(state), indexOnly: true };
		await expect(createCiReleasePlan(opts)).rejects.toThrow("Index-only");
		const release = {
			databaseId: 1,
			tagName: "v1.2.0",
			isDraft: true,
			isPrerelease: false,
			publishedAt: null,
			releaseAssets: { totalCount: 18 },
		};
		state.releases = [release];
		await expect(createCiReleasePlan(opts)).rejects.toThrow("Index-only");
		release.isDraft = false;
		await expect(createCiReleasePlan(opts)).resolves.toMatchObject({
			repository: CI_RELEASE_REPOSITORY,
		});
		await expect(createCiReleasePlan({ ...opts, sourceRunId: 122 })).resolves.toMatchObject({
			commit,
		});
		release.releaseAssets.totalCount = 0;
		await expect(createCiReleasePlan(opts)).rejects.toThrow("Index-only");
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
		expect(
			state.calls.every(
				(args) =>
					args.length === 2 ||
					args[1] === "graphql" ||
					(args.length === 4 && args[1].includes("/compare/") && args[2] === "--jq"),
			),
		).toBe(true);
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
			{ repository: "../repo" },
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

describe("original build provenance plan contract", () => {
	test("separates product, build and re-verification identities without allowing ambiguous target sets", async () => {
		const state = fixture();
		const base = await createCiReleasePlan({
			root: "/unused",
			tag: "v1.2.0",
			publish: false,
			env,
			run: state.run,
		});
		const source = {
			runId: 100,
			runAttempt: 2,
			workflowCommit: "d".repeat(40),
			controlArtifact: { id: 900, digest: `sha256:${"a".repeat(64)}`, size: 100 },
			platforms: [
				{
					target: "windows-x64",
					artifact: { id: 901, digest: `sha256:${"b".repeat(64)}`, size: 100 },
				},
			],
		};
		expect(validateCiReleasePlan({ ...base, buildSource: source })).toMatchObject({
			commit,
			workflowCommit,
			buildSource: source,
		});
		for (const changed of [
			{ runId: base.runId },
			{ runAttempt: 0 },
			{ workflowCommit: "d".repeat(8) },
			{ controlArtifact: { ...source.controlArtifact, size: 4 * 1024 * 1024 + 1 } },
			{ controlArtifact: { ...source.controlArtifact, digest: "a".repeat(64) } },
			{ platforms: [] },
			{ platforms: [source.platforms[0], source.platforms[0]] },
			{ platforms: [{ target: "windows-x86", artifact: source.platforms[0]?.artifact }] },
			{ platforms: [{ ...source.platforms[0], artifact: source.controlArtifact }] },
			{ extra: true },
		])
			expect(() =>
				validateCiReleasePlan({ ...base, buildSource: { ...source, ...changed } }),
			).toThrow();
	});
});
