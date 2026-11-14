import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveMirrorWorkflowTrigger,
	verifyMirrorPublicationReceipt,
	verifyProtectedMirrorEnvironment,
} from "../../scripts/lib/mirror-workflow";
import { commit, indexCommit, mirrorFixture, repository } from "./mirror-fixture";

for (const [name, value] of [
	["NF_MIRROR_TOTAL_TIMEOUT_MINUTES", "NaN"],
	["NF_MIRROR_TOTAL_TIMEOUT_MINUTES", "-1"],
	["NF_MIRROR_TOTAL_TIMEOUT_MINUTES", "301"],
	["NF_MIRROR_TRANSFER_TIMEOUT_MINUTES", "61"],
	["NF_MIRROR_UPLOAD_CONCURRENCY", "0"],
	["NF_MIRROR_UPLOAD_CONCURRENCY", "9"],
	["NF_MIRROR_UPLOAD_CONCURRENCY", "NaN"],
])
	test(`CLI rejects ${name}=${value} with an independent FAILED_CONFIG receipt before network`, () => {
		const directory = mkdtempSync(join(tmpdir(), "nf-mirror-cli-budget-"));
		try {
			const receipt = join(directory, "receipt.json");
			const result = spawnSync(
				process.execPath,
				[
					"scripts/mirror-update-server.ts",
					"--kind=main",
					"--tag=v1.2.0",
					`--repository=${repository}`,
					"--dry-run",
					`--receipt-output=${receipt}`,
				],
				{
					env: {
						...process.env,
						NF_MIRROR_TOTAL_TIMEOUT_MINUTES: "",
						NF_MIRROR_TRANSFER_TIMEOUT_MINUTES: "",
						[name]: value,
					},
					timeout: 5000,
					maxBuffer: 64 * 1024,
					encoding: "utf8",
				},
			);
			expect(result.status).toBe(1);
			expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
				status: "FAILED",
				failureCode: "FAILED_CONFIG",
				uploaded: [],
				verified: [],
				snapshotCommitted: false,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

function sourceFixture(main = true, peer = false) {
	const path = main
		? ".github/workflows/release.yml"
		: peer
			? ".github/workflows/remote-peer-release.yml"
			: ".github/workflows/helpers-release.yml";
	const source = {
		id: 123,
		run_attempt: 2,
		event: "workflow_dispatch",
		status: "completed",
		conclusion: "success",
		path,
		head_branch: "main",
		repository: { full_name: repository },
		head_repository: { full_name: repository },
	};
	const event = {
		repository: { full_name: repository, default_branch: "main" },
		workflow_run: source,
	};
	const artifact = {
		id: 81,
		name: `${main ? "main" : "auxiliary"}-publication-receipt-123-2`,
		expired: false,
		size_in_bytes: 1024,
	};
	const jobs = (
		main
			? ["Publish verified release", "Release Gate"]
			: peer
				? ["Publish approved remote peer draft", "Remote Peer Release Gate"]
				: ["Publish approved helper draft", "Auxiliary Release Gate"]
	).map((name) => ({ name, status: "completed", conclusion: "success" }));
	const state = { artifacts: [artifact], jobs, protection: true };
	const calls: string[][] = [];
	const run = async (args: string[]) => {
		calls.push(args);
		const endpoint = args[1];
		if (endpoint.includes("/artifacts?"))
			return JSON.stringify({ total_count: state.artifacts.length, artifacts: state.artifacts });
		if (endpoint.includes("/jobs?"))
			return JSON.stringify({ total_count: state.jobs.length, jobs: state.jobs });
		if (endpoint.endsWith("/attempts/2")) return JSON.stringify(source);
		if (endpoint.endsWith("environments/release"))
			return JSON.stringify({
				name: "release",
				protection_rules: state.protection
					? [{ type: "required_reviewers", reviewers: [{ type: "User" }] }]
					: [],
			});
		throw new Error("Read-only trust spy refused unexpected source API");
	};
	return { source, event, artifact, state, run, calls };
}
describe("independent mirror trigger provenance", () => {
	for (const main of [true, false])
		test(`exact ${main ? "main" : "auxiliary"} receipt attempt plus real publisher and gate is eligible`, async () => {
			const f = sourceFixture(main);
			const result = await resolveMirrorWorkflowTrigger(f.event, repository, f.run);
			expect(result?.artifactName).toBe(f.artifact.name);
			expect(result?.runAttempt).toBe(2);
			expect(f.calls.some((c) => c[1].includes("/attempts/2/jobs?"))).toBe(true);
		});
	test("peer source requires its dedicated workflow and publisher/gate names", async () => {
		const f = sourceFixture(false, true);
		expect((await resolveMirrorWorkflowTrigger(f.event, repository, f.run))?.artifactName).toBe(
			f.artifact.name,
		);
		f.state.jobs[0].name = "Publish approved helper draft";
		await expect(resolveMirrorWorkflowTrigger(f.event, repository, f.run)).rejects.toThrow(
			"publisher",
		);
		f.state.jobs[0].name = "Publish approved remote peer draft";
		f.source.path = ".github/workflows/other-release.yml";
		await expect(resolveMirrorWorkflowTrigger(f.event, repository, f.run)).rejects.toThrow(
			"Untrusted",
		);
	});
	test("build-only success without publication receipt is not eligible and never requests approval", async () => {
		const f = sourceFixture();
		f.state.artifacts = [];
		expect(await resolveMirrorWorkflowTrigger(f.event, repository, f.run)).toBeUndefined();
		expect(f.calls.some((c) => c[1].includes("environments"))).toBe(false);
	});
	for (const key of ["event", "head_branch", "conclusion", "path"] as const)
		test(`rejects untrusted source ${key}`, async () => {
			const f = sourceFixture();
			f.source[key] = "untrusted";
			await expect(resolveMirrorWorkflowTrigger(f.event, repository, f.run)).rejects.toThrow();
		});
	test("fork head repository cannot use privileged workflow_run", async () => {
		const f = sourceFixture();
		f.source.head_repository.full_name = "attacker/fork";
		await expect(resolveMirrorWorkflowTrigger(f.event, repository, f.run)).rejects.toThrow();
	});
	test("prior-attempt receipt does not authorize current source run", async () => {
		const f = sourceFixture();
		f.artifact.name = "main-publication-receipt-123-1";
		expect(await resolveMirrorWorkflowTrigger(f.event, repository, f.run)).toBeUndefined();
	});
	test("artifact duplicates and oversized raw-data receipts are rejected", async () => {
		const f = sourceFixture();
		f.state.artifacts.push({ ...f.artifact });
		await expect(resolveMirrorWorkflowTrigger(f.event, repository, f.run)).rejects.toThrow();
		f.state.artifacts.pop();
		f.artifact.size_in_bytes = 129 * 1024;
		await expect(resolveMirrorWorkflowTrigger(f.event, repository, f.run)).rejects.toThrow();
	});
	for (const conclusion of ["skipped", "failure", "cancelled"])
		test(`${conclusion} publisher is never papered over by a green workflow`, async () => {
			const f = sourceFixture();
			f.state.jobs[0].conclusion = conclusion;
			await expect(resolveMirrorWorkflowTrigger(f.event, repository, f.run)).rejects.toThrow();
		});
	test("requires existing protected release Environment; never creates/bypasses one", async () => {
		const f = sourceFixture();
		await verifyProtectedMirrorEnvironment(repository, f.run);
		f.state.protection = false;
		await expect(verifyProtectedMirrorEnvironment(repository, f.run)).rejects.toThrow(
			"existing release",
		);
		expect(f.calls.every((c) => c[0] === "api" && !c.includes("-X"))).toBe(true);
	});
	test("bounded receipt is only a hint; current public Release/tag/assets/index are revalidated", async () => {
		const s = sourceFixture();
		const f = mirrorFixture(false);
		const trigger = await resolveMirrorWorkflowTrigger(s.event, repository, s.run);
		if (!trigger) throw new Error("missing trigger");
		const receipt = {
			schemaVersion: 1,
			kind: "main",
			repository,
			tag: "v1.2.0",
			version: "1.2.0",
			commit,
			releaseId: 17,
			assets: f.assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })),
			indexCommit,
			generation: 1,
			buildSource: {
				runId: 9,
				runAttempt: 1,
				workflowPath: ".github/workflows/release.yml",
				bundleArtifactId: 7,
				nativeProof: "verified-original-bundle",
			},
			source: {
				runId: 123,
				runAttempt: 2,
				workflowPath: ".github/workflows/release.yml",
				nativeProof: "verified-original-bundle",
			},
		};
		const run = (args: string[]) =>
			args[1].includes("/compare/") ? JSON.stringify({ status: "identical" }) : f.run(args);
		expect((await verifyMirrorPublicationReceipt(receipt, trigger, run)).tag).toBe(receipt.tag);
		// Original QA run A=9/1 does not replace publisher run B=123/2.
		receipt.source.runId = receipt.buildSource.runId;
		await expect(verifyMirrorPublicationReceipt(receipt, trigger, run)).rejects.toThrow(
			"provenance",
		);
		receipt.source.runId = 123;
		receipt.source.runAttempt = 1;
		await expect(verifyMirrorPublicationReceipt(receipt, trigger, run)).rejects.toThrow(
			"provenance",
		);
		receipt.source.runAttempt = 2;
		receipt.buildSource.runAttempt = 0;
		await expect(verifyMirrorPublicationReceipt(receipt, trigger, run)).rejects.toThrow(
			"build provenance",
		);
		receipt.buildSource.runAttempt = 1;
		f.publicRelease.draft = true;
		await expect(verifyMirrorPublicationReceipt(receipt, trigger, run)).rejects.toThrow("public");
	});
	for (const kind of ["helpers", "executor", "remote-peer"] as const)
		test(`${kind} publisher B/attempt is bound independently of original build A/attempt and other workflows`, async () => {
			const peer = kind === "remote-peer";
			const s = sourceFixture(false, peer);
			const trigger = await resolveMirrorWorkflowTrigger(s.event, repository, s.run);
			if (!trigger) throw new Error("missing auxiliary trigger");
			const version = peer ? "0.1.0-alpha.1" : "1.0.0";
			const tag = `${kind}-v${version}`;
			const workflowPath = s.source.path;
			const asset = {
				id: 7,
				name: peer ? "narrafork-remote-peer-manifest.json" : "helper-manifest-v1.json",
				size: 7,
				digest: `sha256:${"a".repeat(64)}`,
				state: "uploaded",
			};
			const receipt = {
				schemaVersion: 1,
				kind,
				repository,
				tag,
				version,
				commit,
				releaseId: 17,
				assets: [{ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest }],
				source: {
					runId: 123,
					runAttempt: 2,
					workflowPath,
					nativeProof: "verified-original-bundle",
				},
				buildSource: {
					runId: 11,
					runAttempt: 1,
					workflowPath,
					bundleArtifactId: 55,
					nativeProof: "verified-original-bundle",
				},
			};
			const run = async (args: string[]) => {
				if (args[1].includes("git/ref/tags/"))
					return JSON.stringify({
						ref: `refs/tags/${tag}`,
						object: { sha: commit, type: "commit" },
					});
				if (args[1].includes("releases/tags/"))
					return JSON.stringify({
						id: 17,
						tag_name: tag,
						draft: false,
						prerelease: peer,
						published_at: "2026-07-01T00:00:00Z",
					});
				if (args[1].includes("releases/17/assets?")) return JSON.stringify([asset]);
				throw new Error("Unexpected auxiliary receipt request");
			};
			expect((await verifyMirrorPublicationReceipt(receipt, trigger, run)).source.runId).toBe(123);
			for (const invalid of [
				{ ...receipt, repository: "attacker/fork" },
				{ ...receipt, tag: `${kind === "executor" ? "helpers" : "executor"}-v${version}` },
				{
					...receipt,
					source: { ...receipt.source, workflowPath: ".github/workflows/arbitrary.yml" },
				},
				{
					...receipt,
					buildSource: { ...receipt.buildSource, workflowPath: ".github/workflows/arbitrary.yml" },
				},
				{
					...receipt,
					kind: peer ? "executor" : "remote-peer",
					tag: `${peer ? "executor" : "remote-peer"}-v${version}`,
				},
			])
				await expect(verifyMirrorPublicationReceipt(invalid, trigger, run)).rejects.toThrow();
			if (peer) {
				await expect(
					verifyMirrorPublicationReceipt(
						{
							...receipt,
							source: { ...receipt.source, workflowPath: ".github/workflows/helpers-release.yml" },
							buildSource: {
								...receipt.buildSource,
								workflowPath: ".github/workflows/helpers-release.yml",
							},
						},
						{ ...trigger, workflowPath: ".github/workflows/helpers-release.yml" },
						run,
					),
				).rejects.toThrow("provenance");
			}
			receipt.source.runId = 11;
			await expect(verifyMirrorPublicationReceipt(receipt, trigger, run)).rejects.toThrow(
				"provenance",
			);
		});
	test("workflow mode steps do not cross-inject direct and relay secrets", () => {
		const workflow = readFileSync(
			new URL("../../.github/workflows/update-server-mirror.yml", import.meta.url),
			"utf8",
		);
		const direct = workflow
			.split("- name: Direct mirror")[1]
			.split("- name: Stage for server pull")[0];
		const dav = workflow
			.split("- name: Stage for server pull")[1]
			.split("- name: Preserve independent mirror result")[0];
		expect(direct).toContain("NF_MIRROR_TRANSPORT: direct");
		expect(direct).toContain("secrets.NF_UPDATE_TOKEN");
		expect(direct).not.toContain("NF_MIRROR_WEBDAV_");
		expect(direct).not.toContain("NF_MIRROR_RELAY_SIGNING_KEY");
		expect(dav).toContain("if: vars.NF_MIRROR_TRANSPORT == 'webdav'");
		expect(dav).toContain("secrets.NF_MIRROR_RELAY_SIGNING_KEY");
		expect(dav).not.toContain("NF_UPDATE_TOKEN");
		expect(dav).not.toContain("NF_UPDATE_SERVER");
		expect(workflow).toContain("vars.NF_MIRROR_TRANSPORT || 'direct'");
		expect(workflow).toContain("resolveMirrorTransport(process.env)");
		expect(workflow).toContain("STAGED_FOR_PULL is not a committed mirror");
	});
	test("workflow is read-only, default-branch trusted, separately locked, bounded and independently approved", () => {
		const workflow = readFileSync(
			new URL("../../.github/workflows/update-server-mirror.yml", import.meta.url),
			"utf8",
		);
		expect(() => Bun.YAML.parse(workflow)).not.toThrow();
		expect(workflow).toContain("vars.NF_MIRROR_ENABLED == 'true'");
		expect(workflow).toContain("Remote peer release");
		expect(workflow).toContain("options: [main, helpers, executor, remote-peer]");
		expect(workflow).toMatch(/NF_UPDATE_SERVER: \$\{\{ vars\.NF_UPDATE_SERVER \}\}/);
		expect(workflow).toMatch(/NF_UPDATE_TOKEN: \$\{\{ secrets\.NF_UPDATE_TOKEN \}\}/);
		expect(workflow).not.toContain("secrets.NF_UPDATE_SERVER");
		expect(workflow).toContain("contents: read");
		expect(workflow).toContain("actions: read");
		expect(workflow).not.toContain("contents: write");
		expect(workflow).not.toContain("continue-on-error");
		expect(workflow).toContain("environment: release");
		expect(workflow).toContain("group: independent-update-server-mirror");
		expect(workflow).toContain("timeout-minutes: 330");
		expect(workflow).toContain("NF_MIRROR_TOTAL_TIMEOUT_MINUTES");
		expect(workflow).toContain("NF_MIRROR_TRANSFER_TIMEOUT_MINUTES");
		expect(workflow).toContain("NF_MIRROR_UPLOAD_CONCURRENCY");
		expect(workflow).toContain("github.event.repository.default_branch");
		expect(workflow).toContain("needs.preflight.outputs.control-sha");
		expect(workflow).not.toContain("control.js");
		expect(workflow).not.toContain("zstd");
		expect(workflow).toContain("artifacts/source-publication/publication-receipt.json");
		expect(workflow).toMatch(
			/peer-artifact-name: \$\{\{ steps\.trigger\.outputs\.peer_artifact_name \}\}/,
		);
		expect(workflow).toContain("needs.preflight.outputs.peer-receipt == 'true'");
		expect(workflow).toContain("path: artifacts/source-peer-publication");
		expect(workflow).toContain(
			"--peer-receipt-file=artifacts/source-peer-publication/remote-peer-publication-receipt.json",
		);
		expect(workflow).toContain("path: artifacts/mirror/");
		expect(workflow).not.toContain("merge-multiple: true");
	});
});
