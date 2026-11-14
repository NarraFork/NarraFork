import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiReleasePlan } from "../../scripts/lib/ci-release-types";
import type { HelperReleasePlan } from "../../scripts/lib/helper-release-control";
import { HELPER_MANIFEST_FILENAME } from "../../shared/helper-distribution";
import { EXECUTOR_MANIFEST_FILENAME } from "../../shared/remote-executor";

const originalPlan = await import("../../scripts/lib/ci-release-plan");
const originalGithub = await import("../../scripts/lib/github-release");
const originalHelpers = await import("../../scripts/lib/helper-release");
const originalRestore = { ...(await import("../../scripts/lib/ci-release-restore")) };
const unexpectedArchiveDownload = mock(
	async (..._args: Parameters<typeof originalRestore.downloadArchive>) => {
		throw new Error("Unexpected archive download in controller fixture");
	},
);
const commit = "a".repeat(40);
const digest = createHash("sha256").update("fixture").digest("hex");
const file = { name: "fixture.metadata.json", size: 7, sha256: digest };
const plan: CiReleasePlan = {
	schemaVersion: 1,
	repository: "Example/Fork",
	defaultBranch: "trunk",
	tag: "v1.2.1",
	version: "1.2.1",
	commit,
	workflowCommit: commit,
	bunVersion: "1.4.3",
	channel: "beta",
	changelog: { version: "1.2.1", date: "2026-10-10", en: "notes", "zh-CN": "说明" },
	runId: 9,
	runAttempt: 1,
	baselines: [],
};
const manifest = { schemaVersion: 1, plan, files: [file], smoke: [] };
const trace: string[] = [];
let indexFailure = false;
let guardFailure = false;
let corruptReadback = false;
let indexRepairMode = false;
let root = "";
let previousCwd = "";
let env: NodeJS.ProcessEnv = {};
const gh = mock(async (args: string[]) => {
	trace.push(`API:${args[1]}`);
	const path = args[1] ?? "";
	// `--jq` only narrows the read; the fixture returns the full object.
	const projected = args.length === 4 && args[2] === "--jq";
	if (args[0] !== "api" || (args.length !== 2 && !projected))
		throw new Error("Read-only fixture boundary");
	if (path === "repos/Example/Fork")
		return JSON.stringify({ full_name: plan.repository, default_branch: "trunk" });
	if (path.endsWith("environments/release"))
		return JSON.stringify({
			name: "release",
			protection_rules: [
				{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
			],
			deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
		});
	if (path.includes("deployment-branch-policies"))
		return JSON.stringify({ total_count: 1, branch_policies: [{ name: "trunk", type: "branch" }] });
	if (path.includes("git/ref/"))
		return JSON.stringify({
			object: { type: "commit", sha: guardFailure ? "b".repeat(40) : commit },
		});
	if (path.includes("compare/"))
		return JSON.stringify({ status: "identical", merge_base_commit: { sha: commit } });
	if (path.includes("releases/tags/")) {
		const name = path.includes("helpers-v")
			? HELPER_MANIFEST_FILENAME
			: path.includes("executor-v")
				? EXECUTOR_MANIFEST_FILENAME
				: file.name;
		return JSON.stringify({
			id: 100,
			tag_name: path.split("/").at(-1),
			draft: false,
			prerelease: false,
			assets: [
				{
					id: 101,
					name,
					size: 7,
					digest: `sha256:${corruptReadback ? "b".repeat(64) : digest}`,
					state: "uploaded",
				},
				...(indexRepairMode
					? [
							{
								id: 102,
								name: "sidecar.metadata.json",
								size: 7,
								digest: `sha256:${digest}`,
								state: "uploaded",
							},
						]
					: []),
			],
		});
	}
	throw new Error("Unexpected inspection API");
});
mock.module("../../scripts/lib/ci-release-plan", () => ({
	...originalPlan,
	revalidateCiReleasePlan: async (input: CiReleasePlan) => {
		trace.push("revalidate");
		if (guardFailure) throw new Error("tag/source changed");
		return input;
	},
}));
mock.module("../../scripts/lib/ci-release-bundle", () => ({
	verifyReleaseBundle: async () => manifest,
	assembleReleaseBundle: async () => {
		throw new Error("Forbidden rebuild");
	},
}));
mock.module("../../scripts/lib/ci-release-restore", () => ({
	...originalRestore,
	// Keep the complete module contract without permitting a real artifact download.
	downloadArchive: unexpectedArchiveDownload,
	restoreCiReleaseBundle: async (options: { destination: string }) => {
		trace.push("restore-source");
		await mkdir(options.destination);
		return { plan, sourceRunId: 9, sourceRunAttempt: 1, artifactId: 88 };
	},
}));
mock.module("../../scripts/lib/github-release", () => ({
	...originalGithub,
	runGh: gh,
	publishGitHubRelease: async (options: { requireAlreadyPublished?: boolean }) => {
		trace.push(options.requireAlreadyPublished ? "GH_READ_PUBLIC" : "GH_PUBLISH");
		return { alreadyPublished: false };
	},
}));
mock.module("../../scripts/lib/update-index", () => ({
	prepareUpdateIndexRelease: async () => {
		trace.push("index-prepare");
		return {};
	},
}));
mock.module("../../scripts/lib/update-index-github", () => ({
	preparePublishedUpdateIndexRelease: async () => {
		indexRepairMode = true;
		return {
			release: {
				files: [
					{
						...file,
						metadata: { name: "sidecar.metadata.json", size: 7, sha256: digest },
						patches: [],
					},
				],
			},
		};
	},
	publishUpdateIndex: async () => {
		trace.push("INDEX_WRITE");
		if (indexFailure) throw new Error("fixture index failure");
		return { commit: "b".repeat(40), generation: 2 };
	},
}));
mock.module("../../scripts/lib/ci-publication-runtime", () => ({
	ciPublicationDeadlineSignal: (_env: unknown, signal: AbortSignal) => signal,
	createPublicationGhRunner: () => gh,
	runPublicationProcess: async () => {
		throw new Error("Forbidden archive/subprocess operation");
	},
}));
mock.module("../../scripts/lib/helper-release", () => ({
	...originalHelpers,
	validateHelperReleaseBundle: async (options: { kind: string }) => ({
		files: [
			{
				...file,
				name: options.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME,
			},
		],
	}),
	publishHelperRelease: async (options: { dryRun: boolean; beforeWrite?: () => Promise<void> }) => {
		if (options.beforeWrite) await options.beforeWrite();
		trace.push(options.dryRun ? "helper-preview" : "GH_PUBLISH");
	},
}));
const { writePublicationReceipt } = await import("../../scripts/lib/publication-receipt");
const { runCiRelease } = await import("../../scripts/ci-release");
const { prepareHelperReleaseBridge, publishHelperReleasePlan, mirrorHelperReleasePlan } =
	await import("../../scripts/lib/helper-release-control");
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ci-canonical-controller-"));
	previousCwd = process.cwd();
	env = { ...process.env };
	execFileSync("git", ["init", "--quiet", root], { timeout: 10000, maxBuffer: 65536 });
	process.chdir(root);
	Object.assign(process.env, {
		GITHUB_OUTPUT: join(root, "output.txt"),
		GITHUB_STEP_SUMMARY: join(root, "summary.txt"),
		GITHUB_RUN_ID: "99",
		GITHUB_RUN_ATTEMPT: "2",
		GITHUB_SHA: commit,
		GITHUB_REPOSITORY: plan.repository,
		GITHUB_REF: "refs/heads/trunk",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		PUBLISH_REQUESTED: "true",
	});
	delete process.env.NF_UPDATE_SERVER;
	delete process.env.NF_UPDATE_TOKEN;
	trace.length = 0;
	unexpectedArchiveDownload.mockClear();
	indexFailure = false;
	guardFailure = false;
	corruptReadback = false;
	indexRepairMode = false;
});
afterEach(async () => {
	process.chdir(previousCwd);
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	Object.assign(process.env, env);
	await rm(root, { recursive: true, force: true });
	expect(unexpectedArchiveDownload).not.toHaveBeenCalled();
});
afterAll(() => mock.restore());
const main = () =>
	runCiRelease([
		"publish",
		"--source-run-id=9",
		"--tag=v1.2.1",
		`--bundle-dir=${join(root, "bundle")}`,
	]);
const helperPlan = (kind: "helpers" | "executor"): HelperReleasePlan => ({
	schemaVersion: 1,
	repository: plan.repository,
	defaultBranch: "trunk",
	tag: `${kind}-v${kind === "helpers" ? "1.0.0" : "1.2.1"}`,
	commit,
	controlCommit: commit,
	kind,
	version: kind === "helpers" ? "1.0.0" : "1.2.1",
	protocolVersion: 1,
	sourceRunId: "9",
	publish: true,
});
const configs: NodeJS.ProcessEnv[] = [
	{},
	{ NF_UPDATE_SERVER: "https://fixture.invalid" },
	{ NF_UPDATE_TOKEN: "fixture-secret" },
	{ NF_UPDATE_SERVER: "not a URL", NF_UPDATE_TOKEN: "fixture-secret" },
	{ NF_UPDATE_SERVER: "https://fixture.invalid", NF_UPDATE_TOKEN: "fixture-secret" },
];
describe("publication receipt current identity bounds", () => {
	const source = {
		runId: 9,
		runAttempt: 1,
		workflowPath: ".github/workflows/release.yml",
		nativeProof: "verified-public-index-repair" as const,
	};
	const publicValue = () => ({
		id: 100,
		tag_name: plan.tag,
		draft: false,
		assets: [
			{ id: 101, name: file.name, size: file.size, digest: `sha256:${digest}`, state: "uploaded" },
		],
	});
	const write = (
		value = publicValue(),
		extra: Partial<Parameters<typeof writePublicationReceipt>[0]> = {},
	) =>
		writePublicationReceipt({
			kind: "main",
			repository: plan.repository,
			tag: plan.tag,
			version: plan.version,
			commit,
			expectedAssets: [file],
			source,
			indexCommit: "b".repeat(40),
			generation: 2,
			run: async () => JSON.stringify(value),
			...extra,
		});
	test("publisher proof never replaces original QA provenance", async () => {
		await expect(
			write(publicValue(), {
				source: { ...source, runId: 99, runAttempt: 2, nativeProof: "verified-original-bundle" },
			}),
		).rejects.toThrow("provenance");
	});
	for (const invalid of ["run", "attempt", "artifact", "workflow"] as const)
		test(`rejects invalid independent build ${invalid}`, async () => {
			const buildSource = {
				runId: 9,
				runAttempt: 1,
				bundleArtifactId: 88,
				workflowPath: source.workflowPath,
				nativeProof: "verified-original-bundle" as const,
			};
			if (invalid === "run") buildSource.runId = 0;
			if (invalid === "attempt") buildSource.runAttempt = 0;
			if (invalid === "artifact") buildSource.bundleArtifactId = 0;
			if (invalid === "workflow") buildSource.workflowPath = ".github/workflows/untrusted.yml";
			await expect(
				write(publicValue(), {
					source: { ...source, runId: 99, runAttempt: 2, nativeProof: "verified-original-bundle" },
					buildSource,
				}),
			).rejects.toThrow("provenance");
		});
	test("index-only preserves checksum identities without generating public assets", async () => {
		const value = publicValue();
		const name = `narrafork-${plan.version}-SHA256SUMS`;
		value.assets.push({ id: 102, name, size: 20, digest: `sha256:${digest}`, state: "uploaded" });
		const receipt = await write(value, {
			additionalAssetNames: [name, `narrafork-${plan.version}-checksums.txt`],
		});
		expect(receipt.assets).toHaveLength(2);
		expect(receipt.assets[1]?.name).toBe(name);
	});
	for (const mutation of [
		"draft",
		"duplicate-id",
		"unknown-name",
		"bad-digest",
		"missing-asset",
	] as const)
		test(`rejects ${mutation} current public identities`, async () => {
			const value = publicValue();
			if (mutation === "draft") value.draft = true;
			if (mutation === "duplicate-id")
				value.assets.push({
					...(value.assets[0] as NonNullable<(typeof value.assets)[0]>),
					name: `narrafork-${plan.version}-SHA256SUMS`,
				});
			if (mutation === "unknown-name")
				value.assets.push({
					...(value.assets[0] as NonNullable<(typeof value.assets)[0]>),
					id: 102,
					name: "unknown.bin",
				});
			if (mutation === "bad-digest") {
				const asset = value.assets[0];
				if (asset) asset.digest = `sha256:${"c".repeat(64)}`;
			}
			if (mutation === "missing-asset") value.assets = [];
			await expect(
				write(value, { additionalAssetNames: [`narrafork-${plan.version}-SHA256SUMS`] }),
			).rejects.toThrow();
		});
	for (const extra of [
		{ indexCommit: "" },
		{ generation: 0 },
		{ source: { ...source, runAttempt: 0 } },
	])
		test(`refuses invalid canonical provenance ${JSON.stringify(extra)}`, async () => {
			await expect(write(publicValue(), extra)).rejects.toThrow("provenance");
		});
});

describe("canonical primary publication", () => {
	for (const [i, config] of configs.entries())
		test(`main ignores mirror config ${i} and confirms public then index`, async () => {
			Object.assign(process.env, config);
			await main();
			expect(trace.indexOf("restore-source")).toBeLessThan(trace.indexOf("GH_PUBLISH"));
			expect(trace.indexOf("GH_PUBLISH")).toBeLessThan(trace.indexOf("INDEX_WRITE"));
			const receipt = JSON.parse(
				await readFile(join(root, "artifacts/publication/publication-receipt.json"), "utf8"),
			);
			expect(receipt.indexCommit).toBe("b".repeat(40));
			expect(receipt.generation).toBe(2);
			expect(receipt.source.runId).toBe(99);
			expect(receipt.source.runAttempt).toBe(2);
			expect(receipt.source.bundleArtifactId).toBeUndefined();
			expect(receipt.buildSource).toEqual({
				runId: 9,
				runAttempt: 1,
				workflowPath: ".github/workflows/release.yml",
				bundleArtifactId: 88,
				nativeProof: "verified-original-bundle",
			});
			expect(receipt.assets[0].id).toBe(101);
			expect(JSON.stringify(receipt)).not.toContain("fixture-secret");
		});
	for (const withBundle of [false, true])
		test(`index repair records current publisher independently of old plan, original bundle=${withBundle}`, async () => {
			const planPath = join(root, "plan.json");
			await writeFile(planPath, JSON.stringify(plan));
			await runCiRelease([
				"index",
				`--plan=${planPath}`,
				"--publish=true",
				...(withBundle ? ["--source-run-id=9", `--bundle-dir=${join(root, "bundle")}`] : []),
			]);
			const receipt = JSON.parse(
				await readFile(join(root, "artifacts/publication/publication-receipt.json"), "utf8"),
			);
			expect(receipt.source).toEqual({
				runId: 99,
				runAttempt: 2,
				workflowPath: ".github/workflows/release.yml",
				nativeProof: "verified-public-index-repair",
			});
			if (withBundle)
				expect(receipt.buildSource).toEqual({
					runId: 9,
					runAttempt: 1,
					workflowPath: ".github/workflows/release.yml",
					bundleArtifactId: 88,
					nativeProof: "verified-original-bundle",
				});
			else expect(receipt.buildSource).toBeUndefined();
			expect(trace).not.toContain("GH_PUBLISH");
			expect(trace).toContain("INDEX_WRITE");
		});
	test("index failure preserves public Release and fails without a success receipt", async () => {
		indexFailure = true;
		await expect(main()).rejects.toThrow("index failure");
		expect(trace).toContain("GH_PUBLISH");
		expect(await readFile(join(root, "summary.txt"), "utf8")).toContain("PUBLISHED_NOT_INDEXED");
		await expect(
			readFile(join(root, "artifacts/publication/publication-receipt.json")),
		).rejects.toThrow();
	});
	test("source/tag revalidation failure forbids GitHub mutation", async () => {
		guardFailure = true;
		await expect(main()).rejects.toThrow("tag/source changed");
		expect(trace).not.toContain("GH_PUBLISH");
	});
	test("current public asset corruption cannot create a success receipt", async () => {
		corruptReadback = true;
		await expect(main()).rejects.toThrow("asset identity mismatch");
	});
	for (const command of ["prepare-bridge", "mirror"])
		test(`${command} is explicitly retired before IO`, async () => {
			await expect(runCiRelease([command])).rejects.toThrow("retired");
			expect(trace).toEqual([]);
		});
});
for (const kind of ["helpers", "executor"] as const)
	describe(`${kind} canonical publication`, () => {
		for (const [i, config] of configs.entries())
			test(`ignores mirror config ${i} without bridge or server`, async () => {
				Object.assign(process.env, config);
				await publishHelperReleasePlan(helperPlan(kind), "fixture-bundle", false, {
					sourceRunAttempt: "1",
				});
				expect(trace).toContain("GH_PUBLISH");
				const receipt = JSON.parse(
					await readFile(join(root, "artifacts/publication/publication-receipt.json"), "utf8"),
				);
				expect(receipt.kind).toBe(kind);
				expect(receipt.source).toEqual({
					runId: 99,
					runAttempt: 2,
					workflowPath: ".github/workflows/helpers-release.yml",
					nativeProof: "verified-original-bundle",
				});
				expect(receipt.buildSource).toEqual({
					runId: 9,
					runAttempt: 1,
					workflowPath: ".github/workflows/helpers-release.yml",
					nativeProof: "verified-original-bundle",
				});
				expect(receipt.indexCommit).toBeUndefined();
			});
		test("offline preview ignores malformed configuration and produces no publication receipt", async () => {
			process.env.NF_UPDATE_SERVER = "not a URL";
			await publishHelperReleasePlan(helperPlan(kind), "unused", true);
			expect(trace).toEqual(["helper-preview"]);
		});
		test("beforeWrite retains real tag/ancestor/environment checks", async () => {
			guardFailure = true;
			await expect(publishHelperReleasePlan(helperPlan(kind), "unused", false)).rejects.toThrow(
				"tag/source",
			);
			expect(trace).not.toContain("GH_PUBLISH");
		});
		test("build-only cannot publish", async () => {
			await expect(
				publishHelperReleasePlan({ ...helperPlan(kind), publish: false }, "unused", false),
			).rejects.toThrow("Build-only");
			expect(trace).toEqual([]);
		});
		test("legacy preparation and mirror methods clearly refuse", async () => {
			await expect(prepareHelperReleaseBridge()).rejects.toThrow("retired");
			await expect(mirrorHelperReleasePlan()).rejects.toThrow("retired");
			expect(trace).toEqual([]);
		});
	});
