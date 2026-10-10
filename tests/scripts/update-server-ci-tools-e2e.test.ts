import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	BRIDGE_PREPARE_STEP,
	BRIDGE_UPLOAD_STEP,
	bridgeArtifactName,
} from "../../scripts/lib/ci-update-server-bridge-restore";
import { EXECUTOR_LICENSE_FILES, HELPER_LICENSE_FILES } from "../../scripts/lib/helper-release";
import {
	type HelperReleasePlan,
	mirrorHelperReleasePlan,
	prepareHelperReleaseBridge,
	publishHelperReleasePlan,
} from "../../scripts/lib/helper-release-control";
import { HELPER_MIRROR_STATE_FILENAME } from "../../scripts/lib/update-server-tools-mirror";
import {
	getHelperAssetName,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
} from "../../shared/helper-distribution";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "../../shared/remote-executor";
import { initConfig } from "../../update-server/lib/config";
import { createToolRoutes } from "../../update-server/routes/tools";
import type { StorageBackend } from "../../update-server/storage/types";

const temporary: string[] = [];
afterEach(async () => {
	for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const commit = "a".repeat(40);
async function fixture(kind: "helpers" | "executor") {
	const root = await mkdtemp(join(tmpdir(), "ci-tools-e2e-"));
	temporary.push(root);
	const bundleDir = join(root, "bundle");
	await mkdir(bundleDir);
	const version = kind === "helpers" ? "1.0.0" : "1.2.1";
	const plan: HelperReleasePlan = {
		schemaVersion: 1,
		repository: "Fixture/Fork",
		defaultBranch: "trunk",
		tag: `${kind}-v${version}`,
		commit,
		controlCommit: commit,
		kind,
		version,
		protocolVersion: 1,
		sourceRunId: "11",
		publish: true,
	};
	const token = "fixture-legacy-never-real";
	const environment = {
		GITHUB_REPOSITORY: plan.repository,
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REF: "refs/heads/trunk",
		GITHUB_SHA: commit,
		GITHUB_RUN_ID: "22",
		GITHUB_RUN_ATTEMPT: "1",
		GH_TOKEN: "fixture-gh-never-real",
		GITHUB_OUTPUT: join(root, "output.txt"),
		GITHUB_STEP_SUMMARY: join(root, "summary.txt"),
		NF_UPDATE_SERVER: "https://fixture.invalid",
		NF_UPDATE_TOKEN: token,
	};
	const files = new Map<string, Buffer>();
	const artifactFile = (name: string) => {
		const bytes = Buffer.from(`${kind}:${name}\n`);
		files.set(name, bytes);
		return { name, size: bytes.length, sha256: sha(bytes) };
	};
	const licenses = (kind === "helpers" ? HELPER_LICENSE_FILES : EXECUTOR_LICENSE_FILES).map(
		artifactFile,
	);
	const manifest =
		kind === "helpers"
			? {
					schemaVersion: 1,
					repository: plan.repository,
					tag: plan.tag,
					commit,
					catalogVersion: version,
					files: HELPER_TOOLS.flatMap((tool) =>
						HELPER_PLATFORMS.map((platform) => ({
							tool,
							toolVersion: HELPER_TOOL_VERSIONS[tool],
							platform,
							...artifactFile(getHelperAssetName(tool, platform)),
						})),
					),
					licenses,
				}
			: {
					schemaVersion: 1,
					repository: plan.repository,
					tag: plan.tag,
					commit,
					manifest: {
						version,
						protocolVersion: 1,
						releasedAt: "1970-01-01T00:00:00Z",
						platforms: Object.fromEntries(
							EXECUTOR_PLATFORMS.map((platform) => {
								const file = artifactFile(executorPublishedFilename(version, platform));
								return [platform, { filename: file.name, size: file.size, sha256: file.sha256 }];
							}),
						),
					},
					licenses,
				};
	const manifestName = kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	files.set(manifestName, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
	for (const [name, bytes] of files) await writeFile(join(bundleDir, name), bytes);
	const configPath = join(root, "fixture-config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			tokens: [
				{
					id: "fixture",
					name: "fixture",
					tokenHash: sha(token),
					role: "upload",
					createdAt: "1970-01-01T00:00:00Z",
				},
			],
		}),
	);
	await initConfig(configPath);
	const remote = new Map<string, Buffer>();
	const serverWrites: string[] = [];
	let publicRelease = false;
	let artifactDownloads = 0;
	const storage: StorageBackend = {
		async saveFile(path, data) {
			if (!publicRelease) throw new Error("Legacy write before GitHub public readback");
			const bytes = Buffer.isBuffer(data)
				? data
				: Buffer.from(await new Response(data).arrayBuffer());
			remote.set(path.replace("tools/", ""), Buffer.from(bytes));
			serverWrites.push(path.replace("tools/", ""));
		},
		async getFile(path) {
			return remote.get(path.replace("tools/", "")) ?? null;
		},
		async getFileStream(path) {
			const bytes = remote.get(path.replace("tools/", ""));
			return bytes ? new Blob([Uint8Array.from(bytes)]).stream() : null;
		},
		async getFileSize(path) {
			return remote.get(path.replace("tools/", ""))?.length ?? null;
		},
		async deleteFile(path) {
			remote.delete(path.replace("tools/", ""));
		},
		async deleteDirectory() {},
		async listFiles() {
			return [...remote.keys()].map((name) => `tools/${name}`);
		},
		async fileExists(path) {
			return remote.has(path.replace("tools/", ""));
		},
		async getFileSliceStream() {
			return null;
		},
	};
	const app = new Hono().route("/api/v2/tools", createToolRoutes(storage));
	let failName: string | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.method === "PUT" && new URL(request.url).pathname.endsWith(`/${failName}`))
			return new Response("fixture partial", { status: 503 });
		return app.fetch(request);
	}) as typeof fetch;
	let zipBytes = Buffer.alloc(0);
	const artifact = {
		id: 44,
		name: bridgeArtifactName(kind, 22, 1),
		expired: false,
		size_in_bytes: 1,
		digest: `sha256:${"b".repeat(64)}`,
		workflow_run: {
			id: 22,
			repository_id: 88,
			head_repository_id: 88,
			head_sha: commit,
			head_branch: "trunk",
		},
	};
	const release = {
		id: 99,
		tag_name: plan.tag,
		draft: true,
		prerelease: false,
		assets: [] as { id: number; name: string; size: number; digest: string; state: string }[],
	};
	const githubWrites: string[] = [];
	const run = async (args: string[]) => {
		if (args[0] === "release") {
			if (!zipBytes.length) throw new Error("GitHub write before immutable bridge upload");
			githubWrites.push(args[1] ?? "");
			if (args[1] === "upload") {
				const path = args[3];
				if (!path) throw new Error("Missing upload path");
				const bytes = await readFile(path);
				const name = path.split("/").at(-1) as string;
				release.assets.push({
					id: release.assets.length + 1,
					name,
					size: bytes.length,
					digest: `sha256:${sha(bytes)}`,
					state: "uploaded",
				});
				return "";
			}
			if (args[1] === "edit") {
				release.draft = false;
				publicRelease = true;
				return "";
			}
			throw new Error("Unexpected GitHub write");
		}
		if (args[0] !== "api") throw new Error("Unexpected GitHub command");
		const path = args[1] ?? "";
		if (path === `repos/${plan.repository}`)
			return JSON.stringify({ full_name: plan.repository, default_branch: "trunk" });
		if (path.endsWith("/environments/release"))
			return JSON.stringify({
				name: "release",
				protection_rules: [
					{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
				],
				deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
			});
		if (path.includes("deployment-branch-policies"))
			return JSON.stringify({
				total_count: 1,
				branch_policies: [{ name: "trunk", type: "branch" }],
			});
		if (path.includes("/git/ref/"))
			return JSON.stringify({ object: { type: "commit", sha: commit } });
		if (path.includes("/compare/"))
			return JSON.stringify({ status: "identical", merge_base_commit: { sha: commit } });
		if (path.includes("/releases/tags/")) return JSON.stringify(release);
		if (path.includes("/releases/assets/")) {
			const id = Number(path.split("/").at(-1));
			const asset = release.assets.find((entry) => entry.id === id);
			if (!asset) throw new Error("Missing asset");
			return files.get(asset.name)?.toString("utf8") ?? "";
		}
		if (path.endsWith("/actions/runs/22"))
			return JSON.stringify({
				id: 22,
				run_attempt: 1,
				workflow_id: 77,
				path: ".github/workflows/helpers-release.yml",
				event: "workflow_dispatch",
				head_branch: "trunk",
				head_sha: commit,
				status: "completed",
				conclusion: "failure",
				repository: { id: 88, full_name: plan.repository },
				head_repository: { id: 88, full_name: plan.repository },
			});
		if (path.endsWith("/actions/workflows/77"))
			return JSON.stringify({
				id: 77,
				path: ".github/workflows/helpers-release.yml",
				state: "active",
			});
		if (path.includes("/jobs?"))
			return JSON.stringify({
				total_count: 1,
				jobs: [
					{
						id: 55,
						run_id: 22,
						run_attempt: 1,
						head_sha: commit,
						name: "Publish approved helper draft",
						steps: [BRIDGE_PREPARE_STEP, BRIDGE_UPLOAD_STEP].map((name) => ({
							name,
							status: "completed",
							conclusion: "success",
						})),
					},
				],
			});
		if (path.includes("/artifacts?"))
			return JSON.stringify({ total_count: 1, artifacts: [artifact] });
		if (path.endsWith("/actions/artifacts/44")) return JSON.stringify(artifact);
		throw new Error(`Unexpected GitHub API ${path}`);
	};
	const artifactFetch = (async () => {
		artifactDownloads++;
		return new Response(zipBytes);
	}) as unknown as typeof fetch;
	const options = { environment, run, fetchImpl, artifactFetch, sourceRunAttempt: "1" };
	const prepareDir = join(root, "prepared");
	async function sealUpload() {
		const zip = join(root, "bridge.zip");
		execFileSync(
			"python3",
			[
				"-c",
				"import os,sys,zipfile\nroot,out=sys.argv[1:]\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n for base,dirs,files in os.walk(root):\n  for name in files:\n   p=os.path.join(base,name);z.write(p,os.path.relpath(p,root))",
				prepareDir,
				zip,
			],
			{ timeout: 10000, maxBuffer: 65536 },
		);
		zipBytes = await readFile(zip);
		artifact.size_in_bytes = zipBytes.length;
		artifact.digest = `sha256:${sha(zipBytes)}`;
		return { artifactId: "44", artifactDigest: sha(zipBytes) };
	}
	return {
		root,
		plan,
		bundleDir,
		prepareDir,
		files,
		remote,
		serverWrites,
		githubWrites,
		release,
		options,
		sealUpload,
		downloadCount: () => artifactDownloads,
		fail: (name: string | undefined) => {
			failName = name;
		},
	};
}
for (const kind of ["helpers", "executor"] as const)
	describe(`${kind} real CI bridge fixture`, () => {
		test("prepare -> immutable ZIP upload -> GitHub publish -> old API mirror -> mirror-only replay", async () => {
			const f = await fixture(kind);
			await prepareHelperReleaseBridge(f.plan, f.bundleDir, {
				...f.options,
				bridgeDir: f.prepareDir,
			});
			expect(f.githubWrites).toEqual([]);
			expect(f.serverWrites).toEqual([]);
			const uploaded = await f.sealUpload();
			await publishHelperReleasePlan(f.plan, f.bundleDir, false, {
				...f.options,
				...uploaded,
				bridgeDir: join(f.root, "publish-bridge"),
			});
			expect(f.release.draft).toBe(false);
			expect(f.serverWrites.length).toBeGreaterThan(0);
			expect(f.downloadCount()).toBe(1);
			const writes = [...f.githubWrites];
			await mirrorHelperReleasePlan(
				{ ...f.plan, mirrorOnly: true, bridgeRunId: "22" },
				f.bundleDir,
				{
					...f.options,
					environment: { ...f.options.environment, GITHUB_RUN_ID: "33" },
					bridgeDir: join(f.root, "retry-bridge"),
				},
			);
			expect(f.githubWrites).toEqual(writes);
			expect(f.downloadCount()).toBe(2);
			for (const [name, bytes] of f.files) {
				if (name === HELPER_MANIFEST_FILENAME || name === EXECUTOR_MANIFEST_FILENAME) continue;
				expect(f.remote.get(name)).toEqual(bytes);
			}
			if (kind === "executor") {
				const projected = JSON.parse(
					f.remote.get(EXECUTOR_MANIFEST_FILENAME)?.toString("utf8") ?? "{}",
				);
				expect(projected.version).toBe(f.plan.version);
				expect(projected.manifest).toBeUndefined();
				expect(f.serverWrites.at(-1)).toBe(EXECUTOR_MANIFEST_FILENAME);
			} else expect(f.serverWrites.at(-1)).toBe(HELPER_MIRROR_STATE_FILENAME);
			expect(await readFile(join(f.root, "summary.txt"), "utf8")).not.toContain(
				"fixture-legacy-never-real",
			);
		});
		test("real partial response fails publication status, retains receipt, and recovers original ZIP only", async () => {
			const f = await fixture(kind);
			await prepareHelperReleaseBridge(f.plan, f.bundleDir, {
				...f.options,
				bridgeDir: f.prepareDir,
			});
			const uploaded = await f.sealUpload();
			f.fail(kind === "helpers" ? HELPER_MIRROR_STATE_FILENAME : EXECUTOR_MANIFEST_FILENAME);
			await expect(
				publishHelperReleasePlan(f.plan, f.bundleDir, false, {
					...f.options,
					...uploaded,
					bridgeDir: join(f.root, "publish-bridge"),
				}),
			).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
			const receipt = JSON.parse(
				await readFile(join(f.root, "publish-bridge", "tools-mirror-receipt.json"), "utf8"),
			);
			expect(receipt.status).toBe("PUBLISHED_NOT_MIRRORED");
			expect(receipt.verified.length).toBeGreaterThan(0);
			expect(await readFile(join(f.root, "summary.txt"), "utf8")).toContain(
				"source_run_id=11 bridge_run_id=22",
			);
			const writes = [...f.githubWrites];
			f.fail(undefined);
			await mirrorHelperReleasePlan(
				{ ...f.plan, mirrorOnly: true, bridgeRunId: "22" },
				f.bundleDir,
				{
					...f.options,
					environment: { ...f.options.environment, GITHUB_RUN_ID: "33" },
					bridgeDir: join(f.root, "recovered-bridge"),
				},
			);
			expect(f.githubWrites).toEqual(writes);
		});
	});
