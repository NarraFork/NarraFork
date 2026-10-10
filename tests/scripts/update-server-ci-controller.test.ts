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
const originalArtifact = await import("../../scripts/lib/ci-update-server-bridge-restore");
const originalMain = await import("../../scripts/lib/update-server-main-mirror");
const originalTools = await import("../../scripts/lib/update-server-tools-mirror");
const originalHelpers = await import("../../scripts/lib/helper-release");
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const commit = "a".repeat(40);
const seal = '{"fixture":true}\n';
const digest = hash(seal);
const plan: CiReleasePlan = {
	schemaVersion: 1,
	repository: "Example/Fork",
	defaultBranch: "main",
	tag: "v1.2.1",
	version: "1.2.1",
	commit,
	workflowCommit: commit,
	bunVersion: "1.4.2",
	channel: "beta",
	changelog: { version: "1.2.1", date: "2026-10-10", en: "notes", "zh-CN": "说明" },
	runId: 9,
	runAttempt: 1,
	baselines: [],
};
const manifest = { schemaVersion: 1, plan, files: [], smoke: [] };
const trace: string[] = [];
let prepareFailure = false;
let mirrorFailure = false;
let indexFailure = false;
let baselineAdvanced = false;
let receiptFailure = false;
let root = "";
let previousCwd = "";
let env: NodeJS.ProcessEnv = {};
const gh = mock(async (args: string[]) => {
	trace.push(`API:${args[1]}`);
	const path = args[1] ?? "";
	if (args[0] !== "api" || args.length !== 2)
		throw new Error("No GitHub mutation in inspection seam");
	if (path === "repos/Example/Fork")
		return JSON.stringify({ full_name: plan.repository, default_branch: "main" });
	if (path.endsWith("environments/release"))
		return JSON.stringify({
			name: "release",
			protection_rules: [
				{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
			],
			deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
		});
	if (path.includes("deployment-branch-policies"))
		return JSON.stringify({ total_count: 1, branch_policies: [{ name: "main", type: "branch" }] });
	if (path.includes("git/ref/")) return JSON.stringify({ object: { type: "commit", sha: commit } });
	if (path.includes("compare/"))
		return JSON.stringify({ status: "identical", merge_base_commit: { sha: commit } });
	if (path.includes("releases/tags/")) {
		const name = path.includes("helpers-v") ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
		return JSON.stringify({
			tag_name: path.split("/").at(-1),
			draft: false,
			prerelease: false,
			assets: [
				{ name, size: Buffer.byteLength(seal), digest: `sha256:${digest}`, state: "uploaded" },
			],
		});
	}
	throw new Error(`Unexpected inspection API ${path}`);
});
mock.module("../../scripts/lib/ci-release-plan", () => ({
	...originalPlan,
	revalidateCiReleasePlan: async () => {
		trace.push("revalidate");
	},
}));
mock.module("../../scripts/lib/ci-release-bundle", () => ({
	verifyReleaseBundle: async () => manifest,
	assembleReleaseBundle: async () => {
		throw new Error("No build");
	},
}));
mock.module("../../scripts/lib/ci-release-restore", () => ({
	restoreCiReleaseBundle: async (options: { destination: string }) => {
		trace.push("restore-source");
		await mkdir(options.destination);
		await writeFile(join(options.destination, "manifest.json"), JSON.stringify(manifest));
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
		throw new Error("Unexpected index repair");
	},
	publishUpdateIndex: async () => {
		trace.push("INDEX_WRITE");
		if (indexFailure) throw new Error("fixture index failure");
		return { commit: "b".repeat(40), generation: 2 };
	},
}));
mock.module("../../scripts/lib/ci-update-server-bridge-restore", () => ({
	...originalArtifact,
	createBridgeGhRunner: () => gh,
	restoreUpdateServerBridgeArtifact: async (options: {
		identity: object;
		destination: string;
		bridgeRunId: number;
		uploadedArtifactId?: string;
		uploadedArtifactDigest?: string;
	}) => {
		trace.push("restore-immutable-artifact");
		if (
			options.uploadedArtifactId !== undefined &&
			(options.uploadedArtifactId !== "77" || options.uploadedArtifactDigest !== digest)
		)
			throw new Error("fixture rejected failed artifact upload");
		await mkdir(options.destination);
		await writeFile(join(options.destination, "tools-mirror-seal.json"), seal);
		return {
			envelope: {
				...options.identity,
				bridgeRunId: options.bridgeRunId,
				bridgeRunAttempt: 1,
				sealSha256: digest,
			},
			artifactId: 77,
		};
	},
}));
mock.module("../../scripts/lib/update-server-main-mirror", () => ({
	...originalMain,
	prepareUpdateServerMainMirror: async (options: { bridgeDir: string; bundleDir: string }) => {
		trace.push("prepare-main");
		if (prepareFailure) throw new Error("fixture missing legacy baseline");
		await mkdir(options.bridgeDir);
		await writeFile(join(options.bridgeDir, "prepared-main-mirror.json"), seal);
		return { ...options, sealSha256: digest, seal: {} };
	},
	restorePreparedMainMirror: async (options: object) => {
		trace.push("restore-main-seal");
		return { ...options, sealSha256: digest };
	},
	publishUpdateServerMainMirror: async (prepared: { bridgeDir: string }) => {
		trace.push("MIRROR_WRITE");
		if (receiptFailure) throw new Error("fixture receipt write failed");
		if (baselineAdvanced)
			throw new originalMain.MirrorPublicationError({
				schemaVersion: 1,
				status: "partial",
				serverUrl: "https://fixture.invalid",
				tag: plan.tag,
				runId: 9,
				runAttempt: 1,
				sealSha256: digest,
				platforms: [],
				failureCode: "BASELINE_ADVANCED",
			});
		if (mirrorFailure) {
			await writeFile(
				join(prepared.bridgeDir, "receipt-main-mirror.json"),
				JSON.stringify({
					status: "partial",
					platforms: [{ platform: "linux-x64", status: "verified" }],
				}),
			);
			throw new Error("fixture partial mirror");
		}
		return { status: "mirrored" };
	},
}));
mock.module("../../scripts/lib/helper-release", () => ({
	...originalHelpers,
	validateHelperReleaseBundle: async (options: { kind: string }) => ({
		files: [
			{
				name: options.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME,
				size: Buffer.byteLength(seal),
				sha256: digest,
			},
		],
		manifestName:
			options.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME,
	}),
	publishHelperRelease: async (options: { dryRun: boolean; beforeWrite?: () => Promise<void> }) => {
		if (options.beforeWrite) await options.beforeWrite();
		trace.push(options.dryRun ? "helper-preview" : "GH_PUBLISH");
	},
}));
mock.module("../../scripts/lib/update-server-tools-mirror", () => ({
	...originalTools,
	prepareUpdateServerToolsMirror: async (options: { kind: string; bridgeDir: string }) => {
		trace.push(`prepare-${options.kind}`);
		if (prepareFailure) throw new Error("fixture helper conflict");
		await mkdir(options.bridgeDir);
		await writeFile(join(options.bridgeDir, "tools-mirror-seal.json"), seal);
		return { ...options, sealSha256: digest };
	},
	restoreUpdateServerToolsMirror: async (options: { bridgeDir: string }) => {
		trace.push("restore-tools-seal");
		return {
			...options,
			sealSha256: digest,
			receiptPath: join(options.bridgeDir, "tools-mirror-receipt.json"),
		};
	},
	publishUpdateServerToolsMirror: async (prepared: { bridgeDir: string }) => {
		trace.push("MIRROR_WRITE");
		if (receiptFailure) throw new Error("fixture receipt write failed");
		if (mirrorFailure) {
			await writeFile(
				join(prepared.bridgeDir, "tools-mirror-receipt.json"),
				JSON.stringify({ status: "PUBLISHED_NOT_MIRRORED", verified: ["rg-linux-x64"] }),
			);
			throw new Error("fixture partial helper mirror");
		}
		return { status: "MIRRORED" };
	},
}));
const { runCiRelease } = await import("../../scripts/ci-release");
const { prepareHelperReleaseBridge, publishHelperReleasePlan, mirrorHelperReleasePlan } =
	await import("../../scripts/lib/helper-release-control");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ci-bridge-controller-"));
	previousCwd = process.cwd();
	env = { ...process.env };
	execFileSync("git", ["init", "--quiet", root], { timeout: 10000, maxBuffer: 65536 });
	process.chdir(root);
	process.env.GITHUB_OUTPUT = join(root, "output.txt");
	process.env.GITHUB_STEP_SUMMARY = join(root, "summary.txt");
	process.env.GITHUB_RUN_ID = "99";
	process.env.GITHUB_RUN_ATTEMPT = "1";
	process.env.GITHUB_SHA = commit;
	process.env.GITHUB_REPOSITORY = plan.repository;
	process.env.GITHUB_REF = "refs/heads/main";
	process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
	process.env.PUBLISH_REQUESTED = "true";
	delete process.env.NF_UPDATE_SERVER;
	delete process.env.NF_UPDATE_TOKEN;
	trace.length = 0;
	prepareFailure = false;
	mirrorFailure = false;
	indexFailure = false;
	baselineAdvanced = false;
	receiptFailure = false;
});
afterEach(async () => {
	process.chdir(previousCwd);
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	Object.assign(process.env, env);
	await rm(root, { recursive: true, force: true });
});
afterAll(() => mock.restore());
const configured = () => {
	process.env.NF_UPDATE_SERVER = "https://fixture.invalid";
	process.env.NF_UPDATE_TOKEN = "fixture-never-real-token";
};
const main = (command: string, extra: string[] = []) =>
	runCiRelease([
		command,
		"--source-run-id=9",
		"--tag=v1.2.1",
		`--bundle-dir=${join(root, command)}`,
		...extra,
	]);
const helperPlan = (kind: "helpers" | "executor"): HelperReleasePlan => ({
	schemaVersion: 1,
	repository: plan.repository,
	defaultBranch: "main",
	tag: `${kind}-v${kind === "helpers" ? "1.0.0" : "1.2.1"}`,
	commit,
	controlCommit: commit,
	kind,
	version: kind === "helpers" ? "1.0.0" : "1.2.1",
	protocolVersion: 1,
	sourceRunId: "9",
	publish: true,
});
async function helperBundle(kind: "helpers" | "executor") {
	const output = join(root, `bundle-${kind}`);
	await mkdir(output);
	await writeFile(
		join(output, kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME),
		seal,
	);
	return output;
}

describe("main release bridge order and receipts", () => {
	test("default GitHub-only publication has no legacy bridge activity", async () => {
		await main("prepare-bridge", [`--bridge-dir=${join(root, "bridge")}`]);
		await main("publish");
		expect(trace).toContain("GH_PUBLISH");
		expect(trace).toContain("INDEX_WRITE");
		expect(trace.some((entry) => /prepare-main|MIRROR|restore-immutable/.test(entry))).toBe(false);
	});
	for (const values of [
		{ NF_UPDATE_SERVER: "https://fixture.invalid" },
		{ NF_UPDATE_TOKEN: "fixture-never-real-token" },
		{ NF_UPDATE_SERVER: "http://fixture.invalid", NF_UPDATE_TOKEN: "fixture-never-real-token" },
	])
		test(`configuration fails before GitHub mutator ${Object.keys(values).join(",")}`, async () => {
			Object.assign(process.env, values);
			await expect(main("publish")).rejects.toThrow();
			expect(trace).toEqual([]);
		});
	test("legacy precheck fails before public GitHub writes", async () => {
		configured();
		prepareFailure = true;
		await expect(main("prepare-bridge", [`--bridge-dir=${join(root, "bridge")}`])).rejects.toThrow(
			"baseline",
		);
		expect(trace).not.toContain("GH_PUBLISH");
	});
	test("missing immutable upload receipt forbids publication", async () => {
		configured();
		await expect(main("publish", [`--bridge-dir=${join(root, "bridge")}`])).rejects.toThrow(
			"bridge-artifact-id",
		);
		expect(trace).not.toContain("GH_PUBLISH");
	});
	test("forged upload receipt forbids publication", async () => {
		configured();
		await expect(
			main("publish", [
				`--bridge-dir=${join(root, "bridge")}`,
				"--bridge-artifact-id=999",
				`--bridge-artifact-digest=${digest}`,
			]),
		).rejects.toThrow("artifact upload");
		expect(trace).not.toContain("GH_PUBLISH");
	});
	test("immutable seal verified before GitHub publication and index", async () => {
		configured();
		await main("publish", [
			`--bridge-dir=${join(root, "bridge")}`,
			"--bridge-artifact-id=77",
			`--bridge-artifact-digest=${digest}`,
		]);
		expect(trace.indexOf("restore-main-seal")).toBeLessThan(trace.indexOf("GH_PUBLISH"));
		expect(trace.indexOf("GH_PUBLISH")).toBeLessThan(trace.indexOf("INDEX_WRITE"));
		expect(trace.indexOf("INDEX_WRITE")).toBeLessThan(trace.indexOf("MIRROR_WRITE"));
		expect(trace.filter((entry) => entry === "restore-immutable-artifact")).toHaveLength(1);
		expect(trace.filter((entry) => entry === "restore-main-seal")).toHaveLength(1);
		expect(await readFile(join(root, "output.txt"), "utf8")).toContain(
			"publication-status=INDEXED",
		);
	});
	test("index failure preserves bridge and public release, does not mirror", async () => {
		configured();
		indexFailure = true;
		await expect(
			main("publish", [
				`--bridge-dir=${join(root, "bridge")}`,
				"--bridge-artifact-id=77",
				`--bridge-artifact-digest=${digest}`,
			]),
		).rejects.toThrow("index failure");
		expect(trace).toContain("GH_PUBLISH");
		expect(trace).not.toContain("MIRROR_WRITE");
		expect(await readFile(join(root, "summary.txt"), "utf8")).toContain("PUBLISHED_NOT_INDEXED");
	});
	test("mirror-only restores source X and bridge Y, reads public assets, never indexes/writes GitHub", async () => {
		configured();
		await main("mirror", [
			`--bridge-dir=${join(root, "bridge")}`,
			"--bridge-run-id=22",
			"--mirror-only=true",
		]);
		expect(trace).toContain("GH_READ_PUBLIC");
		expect(trace).toContain("MIRROR_WRITE");
		expect(trace).not.toContain("GH_PUBLISH");
		expect(trace).not.toContain("INDEX_WRITE");
		expect(trace).not.toContain("prepare-main");
	});
	test("partial mirror fails with retained receipt and exact recovery command", async () => {
		configured();
		mirrorFailure = true;
		await expect(
			main("mirror", [
				`--bridge-dir=${join(root, "bridge")}`,
				"--bridge-run-id=22",
				"--mirror-only=true",
			]),
		).rejects.toThrow("partial mirror");
		const summary = await readFile(join(root, "summary.txt"), "utf8");
		expect(summary).toContain("PUBLISHED_NOT_MIRRORED");
		expect(summary).toContain("source_run_id=9 bridge_run_id=22");
		expect(summary).not.toContain("fixture-never-real-token");
		expect(
			JSON.parse(await readFile(join(root, "bridge", "receipt-main-mirror.json"), "utf8")).status,
		).toBe("partial");
	});
	test("obsolete baseline fails without misleading same-artifact retry or new-basis selection", async () => {
		configured();
		baselineAdvanced = true;
		await expect(
			main("mirror", [
				`--bridge-dir=${join(root, "bridge")}`,
				"--bridge-run-id=22",
				"--mirror-only=true",
			]),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		const summary = await readFile(join(root, "summary.txt"), "utf8");
		expect(summary).toContain("BASELINE_ADVANCED");
		expect(summary).toContain("Same-artifact retry cannot fix");
		expect(summary).not.toContain("Retry publish=true");
		expect(summary).toContain("maintainer intervention");
		expect(trace).not.toContain("prepare-main");
	});
	test("receipt write failure does not claim a partial receipt was retained", async () => {
		configured();
		receiptFailure = true;
		await expect(
			main("mirror", [
				`--bridge-dir=${join(root, "bridge")}`,
				"--bridge-run-id=22",
				"--mirror-only=true",
			]),
		).rejects.toThrow("receipt write failed");
		expect(await readFile(join(root, "summary.txt"), "utf8")).toContain(
			"partial receipt unavailable",
		);
	});
});
for (const kind of ["helpers", "executor"] as const)
	describe(`${kind} release bridge controller`, () => {
		test("GitHub-only remains offline with respect to the legacy server", async () => {
			const output = await helperBundle(kind);
			await prepareHelperReleaseBridge(helperPlan(kind), output);
			await publishHelperReleasePlan(helperPlan(kind), output, false);
			expect(trace).toContain("GH_PUBLISH");
			expect(
				trace.some((entry) =>
					/prepare-helpers|prepare-executor|MIRROR|restore-immutable/.test(entry),
				),
			).toBe(false);
		});
		test("missing token fails before any GitHub query/mutator", async () => {
			process.env.NF_UPDATE_SERVER = "https://fixture.invalid";
			await expect(publishHelperReleasePlan(helperPlan(kind), "unused", false)).rejects.toThrow();
			expect(trace).toEqual([]);
		});
		test("preview ignores malformed legacy credentials", async () => {
			process.env.NF_UPDATE_SERVER = "http://invalid";
			await publishHelperReleasePlan(helperPlan(kind), "unused", true);
			expect(trace).toEqual(["helper-preview"]);
		});
		test("normal publish mirrors the same restored Prepared object without downloading twice", async () => {
			configured();
			const output = await helperBundle(kind);
			await publishHelperReleasePlan(helperPlan(kind), output, false, {
				bridgeDir: join(root, "bridge"),
				sourceRunAttempt: "1",
				artifactId: "77",
				artifactDigest: digest,
			});
			expect(trace.indexOf("restore-tools-seal")).toBeLessThan(trace.indexOf("GH_PUBLISH"));
			expect(trace.indexOf("GH_PUBLISH")).toBeLessThan(trace.indexOf("MIRROR_WRITE"));
			expect(trace.filter((entry) => entry === "restore-immutable-artifact")).toHaveLength(1);
			expect(trace.filter((entry) => entry === "restore-tools-seal")).toHaveLength(1);
		});
		test("receipt write failure is surfaced without false receipt retention", async () => {
			configured();
			receiptFailure = true;
			const output = await helperBundle(kind);
			await expect(
				publishHelperReleasePlan(helperPlan(kind), output, false, {
					bridgeDir: join(root, "bridge"),
					sourceRunAttempt: "1",
					artifactId: "77",
					artifactDigest: digest,
				}),
			).rejects.toThrow("receipt write failed");
			expect(await readFile(join(root, "summary.txt"), "utf8")).toContain(
				"partial receipt unavailable",
			);
		});
		test("seal upload receipt is mandatory before GitHub write", async () => {
			configured();
			const output = await helperBundle(kind);
			await expect(publishHelperReleasePlan(helperPlan(kind), output, false)).rejects.toThrow(
				"successfully uploaded",
			);
			expect(trace).not.toContain("GH_PUBLISH");
		});
		test("legacy precheck produces independent envelope before any publication", async () => {
			configured();
			const output = await helperBundle(kind);
			const bridgeDir = join(root, "bridge");
			await prepareHelperReleaseBridge(helperPlan(kind), output, {
				bridgeDir,
				sourceRunAttempt: "1",
			});
			const envelope = JSON.parse(await readFile(join(bridgeDir, "bridge-envelope.json"), "utf8"));
			expect(envelope.sourceRunId).toBe(9);
			expect(envelope.bridgeRunId).toBe(99);
			expect(envelope.sealSha256).toBe(digest);
			expect(JSON.stringify(envelope)).not.toContain("fixture-never-real-token");
			expect(trace).not.toContain("GH_PUBLISH");
		});
		test("mirror-only restores original seal and only reads GitHub assets", async () => {
			configured();
			const output = await helperBundle(kind);
			const bridgeDir = join(root, "bridge");
			await mirrorHelperReleasePlan(
				{ ...helperPlan(kind), mirrorOnly: true, bridgeRunId: "22" },
				output,
				{ bridgeDir, sourceRunAttempt: "1" },
			);
			expect(trace).toContain("restore-tools-seal");
			expect(trace).toContain("MIRROR_WRITE");
			expect(trace).not.toContain("GH_PUBLISH");
			expect(trace.some((entry) => entry === `prepare-${kind}`)).toBe(false);
		});
		test("partial mirror has failure receipt, exact retry and no false success", async () => {
			configured();
			mirrorFailure = true;
			const output = await helperBundle(kind);
			const bridgeDir = join(root, "bridge");
			await expect(
				mirrorHelperReleasePlan(
					{ ...helperPlan(kind), mirrorOnly: true, bridgeRunId: "22" },
					output,
					{ bridgeDir, sourceRunAttempt: "1" },
				),
			).rejects.toThrow("partial helper");
			const summary = await readFile(join(root, "summary.txt"), "utf8");
			expect(summary).toContain("PUBLISHED_NOT_MIRRORED");
			expect(summary).toContain("source_run_id=9 bridge_run_id=22");
			expect(summary).not.toContain("fixture-never-real-token");
			expect(
				JSON.parse(await readFile(join(bridgeDir, "tools-mirror-receipt.json"), "utf8")).verified,
			).toEqual(["rg-linux-x64"]);
		});
	});
