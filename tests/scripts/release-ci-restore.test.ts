import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatChecksumsReport,
	formatMetadataJson,
	formatSha256Sums,
} from "../../scripts/lib/binary-metadata";
import {
	REQUIRED_RELEASE_REVERIFY_JOBS,
	REQUIRED_RELEASE_SOURCE_JOBS,
	restoreCiReleaseBundle,
} from "../../scripts/lib/ci-release-restore";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_REPOSITORY,
	CI_RELEASE_TARGETS,
	CI_RELEASE_WORKFLOW,
	type CiReleaseManifest,
	type CiReleasePlan,
} from "../../scripts/lib/ci-release-types";

import { createHelperDistributionDependencies } from "../../shared/helper-distribution";

import { REMOTE_FRONTEND_CAPABILITY } from "../../shared/remote-access/application";
import { remoteReleaseFixture } from "./remote-frontend-release.fixture";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const commit = "a".repeat(40);
const workflowCommit = "b".repeat(40);
const plan: CiReleasePlan = {
	schemaVersion: 1,
	repository: CI_RELEASE_REPOSITORY,
	tag: "v1.2.0",
	version: "1.2.0",
	commit,
	workflowCommit,
	bunVersion: CI_RELEASE_BUN,
	channel: "stable",
	runId: 101,
	runAttempt: 2,
	baselines: [],
	changelog: { version: "1.2.0", date: "2026-10-08", en: "Notes", "zh-CN": "说明" },
};
const env = {
	GH_TOKEN: "fixture-token",
	GITHUB_REPOSITORY: CI_RELEASE_REPOSITORY,
	GITHUB_EVENT_NAME: "workflow_dispatch",
	GITHUB_REF: "refs/heads/main",
	GITHUB_WORKFLOW_REF: `${CI_RELEASE_REPOSITORY}/${CI_RELEASE_WORKFLOW}@refs/heads/main`,
	GITHUB_WORKFLOW_SHA: workflowCommit,
	GITHUB_SHA: workflowCommit,
	GITHUB_RUN_ID: "102",
	GITHUB_RUN_ATTEMPT: "1",
};
function contents(value: unknown) {
	const bytes = Buffer.from(JSON.stringify(value));
	return JSON.stringify({
		type: "file",
		encoding: "base64",
		size: bytes.length,
		content: bytes.toString("base64"),
	});
}
function fixture(releasePlan: CiReleasePlan = plan, declareHelpers = false) {
	const repositoryName = releasePlan.repository;
	const defaultBranch = releasePlan.defaultBranch ?? "main";
	const root = mkdtempSync(join(tmpdir(), "narrafork-ci-restore-"));
	roots.push(root);
	const bundle = join(root, "input");
	mkdirSync(bundle);
	mkdirSync(join(bundle, "dist"));
	const entries = new Map<string, Buffer>();
	const smoke: CiReleaseManifest["smoke"] = [];
	const metadata = CI_RELEASE_TARGETS.map((target) => {
		const name = `narrafork-${releasePlan.version}-${target.suffix}`;
		const bytes = Buffer.from(`binary:${target.target}`);
		const meta = computeBinaryMetadataFromBuffer(name, bytes, {
			version: releasePlan.version,
			platformId: target.platform,
			target: `bun-${target.target}`,
			commit: commit.slice(0, 12),
			...(releasePlan.repository === CI_RELEASE_REPOSITORY
				? {}
				: { repository: releasePlan.repository }),
			buildDate: "2026-10-08T00:00:00.000Z",
			...(declareHelpers
				? { helperDistribution: createHelperDistributionDependencies("0.9.1") }
				: {}),
		});
		entries.set(name, bytes);
		entries.set(`${name}.metadata.json`, Buffer.from(formatMetadataJson(meta)));
		smoke.push({
			schemaVersion: 1,
			...(meta.repository ? { repository: meta.repository } : {}),
			target: target.target,
			commit,
			version: releasePlan.version,
			size: meta.size,
			sha256: meta.sha256,
			sha512: meta.sha512,
			checks: {
				startup: true,
				frontend: true,
				database: true,
				watcher: true,
				pty: true,
				signature: target.target.startsWith("darwin-"),
			},
		});
		return meta;
	});
	entries.set(
		`narrafork-${releasePlan.version}-SHA256SUMS`,
		Buffer.from(formatSha256Sums(metadata)),
	);
	entries.set(
		`narrafork-${releasePlan.version}-checksums.txt`,
		Buffer.from(formatChecksumsReport(releasePlan.version, metadata)),
	);
	for (const [name, bytes] of entries) writeFileSync(join(bundle, "dist", name), bytes);
	const manifest: CiReleaseManifest = {
		schemaVersion: 1,
		plan: structuredClone(releasePlan),
		...(declareHelpers
			? { helperDistribution: createHelperDistributionDependencies("0.9.1") }
			: {}),
		smoke,
		files: [...entries].map(([name, bytes]) => ({
			name,
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			sha512: createHash("sha512").update(bytes).digest("base64"),
		})),
	};
	const archivePath = join(root, "bundle.zip");
	const repository = { id: 55, full_name: repositoryName };
	const state = {
		root,
		bundle,
		manifest,
		componentVersions: (declareHelpers
			? { executor: { version: "0.9.1", protocolVersion: 1 } }
			: undefined) as unknown,
		archive: Buffer.alloc(0),
		calls: [] as string[][],
		downloads: 0,
		source: {
			id: 101,
			run_attempt: 2,
			workflow_id: 77,
			path: CI_RELEASE_WORKFLOW,
			event: "workflow_dispatch",
			head_branch: defaultBranch,
			head_sha: workflowCommit,
			status: "completed",
			conclusion: "failure",
			repository: { ...repository },
			head_repository: { ...repository },
		},
		jobs: REQUIRED_RELEASE_SOURCE_JOBS.map((name, index) => ({
			id: index + 1,
			run_id: 101,
			run_attempt: 2,
			name,
			status: "completed",
			conclusion: "success",
			head_sha: workflowCommit,
		})),
		artifact: {
			id: 900,
			name: "release-bundle-101-2",
			expired: false,
			size_in_bytes: 1,
			digest: "",
			workflow_run: {
				id: 101,
				repository_id: 55,
				head_repository_id: 55,
				head_branch: defaultBranch,
				head_sha: workflowCommit,
			},
		},
		artifactDeleted: false,
		duplicateArtifact: false,
		workflowPath: CI_RELEASE_WORKFLOW,
		repack(extra?: { name: string; kind?: string }) {
			writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest));
			execFileSync(
				"python3",
				[
					"-c",
					`import json,os,sys,zipfile\nroot,out,extra=sys.argv[1:]\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n for current,dirs,files in os.walk(root):\n  for name in files:\n   path=os.path.join(current,name); z.write(path,os.path.relpath(path,root))\n if extra:\n  e=json.loads(extra); info=zipfile.ZipInfo(e['name']); info.create_system=3; info.external_attr=(0o120777 if e.get('kind')=='symlink' else 0o100644)<<16; z.writestr(info,b'evil')`,
					bundle,
					archivePath,
					extra ? JSON.stringify(extra) : "",
				],
				{ timeout: 30_000, maxBuffer: 1024 * 1024 },
			);
			state.archive = readFileSync(archivePath);
			state.artifact.size_in_bytes = state.archive.length;
			state.artifact.digest = `sha256:${createHash("sha256").update(state.archive).digest("hex")}`;
		},
		async run(args: string[]) {
			state.calls.push(args);
			if (args[1] === `repos/${repositoryName}`)
				return JSON.stringify({ full_name: repositoryName, default_branch: defaultBranch });
			const path = args[1].replace(`repos/${repositoryName}/`, "");
			if (path === "actions/runs/101") return JSON.stringify(state.source);
			if (path === "actions/workflows/77")
				return JSON.stringify({ id: 77, path: state.workflowPath, state: "active" });
			if (path.startsWith("actions/runs/101/attempts/"))
				return JSON.stringify({ total_count: state.jobs.length, jobs: state.jobs });
			if (path.startsWith("actions/runs/101/artifacts?"))
				return JSON.stringify({
					total_count: state.artifactDeleted ? 0 : state.duplicateArtifact ? 2 : 1,
					artifacts: state.artifactDeleted
						? []
						: state.duplicateArtifact
							? [state.artifact, state.artifact]
							: [state.artifact],
				});
			if (path === "actions/artifacts/900") return JSON.stringify(state.artifact);
			if (path === `git/ref/heads/${encodeURIComponent(defaultBranch)}`)
				return JSON.stringify({ object: { type: "commit", sha: workflowCommit } });
			if (path.startsWith("compare/"))
				return JSON.stringify({ status: "ahead", merge_base_commit: { sha: path.slice(8, 48) } });
			if (path === "git/ref/tags/v1.2.0")
				return JSON.stringify({ object: { type: "commit", sha: commit } });
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
				if (!releasePlan.remoteFrontend) throw new Error("HTTP 404");
				return contents(releasePlan.remoteFrontend);
			}
			if (path === `contents/package.json?ref=${commit}`)
				return contents({ version: releasePlan.version, packageManager: `bun@${CI_RELEASE_BUN}` });
			if (path === `contents/changelogs/v1.2.0.json?ref=${commit}`)
				return contents(releasePlan.changelog);
			if (path === `contents/scripts/lib/ci-release-types.ts?ref=${commit}`)
				return JSON.stringify({ type: "file", size: 100 });
			throw new Error(`Unexpected API: ${path}`);
		},
		fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
			state.downloads++;
			init?.signal?.throwIfAborted();
			return new Response(state.archive, {
				headers: { "content-length": String(state.archive.length) },
			});
		}) as typeof fetch,
	};
	state.repack();
	return state;
}
function options(state: ReturnType<typeof fixture>) {
	return {
		sourceRunId: 101,
		tag: plan.tag,
		root: state.root,
		destination: join(state.root, "restored"),
		env,
		run: state.run,
		fetch: state.fetch,
	};
}

describe("remote pair retained in source_run_id bundle", () => {
	test("restores both remote assets verbatim with the original full bundle and unchanged binary sums", async () => {
		const declared = { ...plan, remoteFrontend: REMOTE_FRONTEND_CAPABILITY };
		const state = fixture(declared);
		const sums = readFileSync(join(state.bundle, "dist", `narrafork-${plan.version}-SHA256SUMS`));
		const remote = await remoteReleaseFixture(state.root, declared, join(state.bundle, "dist"));
		for (const name of Object.values(remote.names)) {
			const bytes = readFileSync(join(remote.directory, name));
			state.manifest.files.push({
				name,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				sha512: createHash("sha512").update(bytes).digest("base64"),
			});
		}
		state.repack();
		const restored = await restoreCiReleaseBundle(options(state));
		expect(restored.plan.remoteFrontend).toEqual(REMOTE_FRONTEND_CAPABILITY);
		for (const name of Object.values(remote.names))
			expect(readFileSync(join(restored.destination, "dist", name))).toEqual(
				readFileSync(join(remote.directory, name)),
			);
		expect(
			readFileSync(join(restored.destination, "dist", `narrafork-${plan.version}-SHA256SUMS`)),
		).toEqual(sums);
	});
});

describe("CI immutable release bundle restoration", () => {
	test("restores independently pinned build-only bundle bytes without inventing publication evidence", async () => {
		const state = fixture(plan, true);
		const before = readFileSync(join(state.bundle, "manifest.json"));
		const restored = await restoreCiReleaseBundle(options(state));
		expect(restored.plan.componentEvidence).toBeUndefined();
		expect(state.manifest.helperDistribution?.executor.version).toBe("0.9.1");
		expect(readFileSync(join(restored.destination, "manifest.json"))).toEqual(before);
		for (const file of state.manifest.files)
			expect(readFileSync(join(restored.destination, "dist", file.name))).toEqual(
				readFileSync(join(state.bundle, "dist", file.name)),
			);
		expect(state.calls.some((args) => /executor-v|helpers-v|releases/.test(args[1]))).toBe(false);
	});
	test("restored declarations must match target JSON, never the current control pin", async () => {
		for (const componentVersions of [
			{ executor: { version: "0.9.2", protocolVersion: 1 } },
			{ executor: { version: "0.9.1", protocolVersion: 2 } },
		]) {
			const state = fixture(plan, true);
			state.componentVersions = componentVersions;
			await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow(
				"target component configuration",
			);
		}
		const missing = fixture();
		missing.componentVersions = { executor: { version: "0.9.1", protocolVersion: 1 } };
		await expect(restoreCiReleaseBundle(options(missing))).rejects.toThrow(
			"target component configuration",
		);
		const legacy = fixture(plan, true);
		legacy.componentVersions = undefined;
		await expect(restoreCiReleaseBundle(options(legacy))).rejects.toThrow("Legacy target");
	});
	test("fork restore uses the same repository/default branch through artifact download", async () => {
		const repository = "Example/Custom";
		const defaultBranch = "trunk";
		const state = fixture({ ...plan, repository, defaultBranch });
		const forkEnv = {
			...env,
			GITHUB_REPOSITORY: repository,
			GITHUB_REF: `refs/heads/${defaultBranch}`,
			GITHUB_WORKFLOW_REF: `${repository}/${CI_RELEASE_WORKFLOW}@refs/heads/${defaultBranch}`,
		};
		let downloadUrl = "";
		const restored = await restoreCiReleaseBundle({
			...options(state),
			env: forkEnv,
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				downloadUrl = String(url);
				return state.fetch(url, init);
			}) as typeof fetch,
		});
		expect(restored.plan).toMatchObject({ repository, defaultBranch });
		expect(downloadUrl).toBe(
			`https://api.github.com/repos/${repository}/actions/artifacts/900/zip`,
		);
		expect(state.calls.every((args) => args[1].startsWith(`repos/${repository}`))).toBe(true);
	});
	test("a legacy official bundle cannot be restored under a fork dispatch", async () => {
		const repository = "Example/Custom";
		const state = fixture({ ...plan, repository, defaultBranch: "main" });
		state.manifest.plan.repository = CI_RELEASE_REPOSITORY;
		delete state.manifest.plan.defaultBranch;
		state.repack();
		await expect(
			restoreCiReleaseBundle({
				...options(state),
				env: {
					...env,
					GITHUB_REPOSITORY: repository,
					GITHUB_WORKFLOW_REF: `${repository}/${CI_RELEASE_WORKFLOW}@refs/heads/main`,
				},
			}),
		).rejects.toThrow("source run provenance");
	});
	test("accepts successful source evidence despite failed publication and preserves bytes", async () => {
		const state = fixture();
		const restored = await restoreCiReleaseBundle(options(state));
		expect(restored).toMatchObject({
			plan,
			artifactId: 900,
			sourceRunId: 101,
			sourceRunAttempt: 2,
		});
		for (const file of state.manifest.files)
			expect(readFileSync(join(restored.destination, "dist", file.name))).toEqual(
				readFileSync(join(state.bundle, "dist", file.name)),
			);
		expect(
			state.calls.every(
				(args) =>
					args[0] === "api" &&
					(args.length === 2 ||
						(args.length === 4 && args[1].includes("/compare/") && args[2] === "--jq")),
			),
		).toBe(true);
	});
	test("allows own in-progress run only after required jobs succeeded", async () => {
		const state = fixture();
		state.source.status = "in_progress";
		await expect(
			restoreCiReleaseBundle({
				...options(state),
				env: { ...env, GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "2" },
			}),
		).resolves.toMatchObject({ artifactId: 900 });
	});
	for (const change of [
		{ event: "pull_request" },
		{ head_branch: "fork" },
		{ repository: { id: 55, full_name: "Other/Repo" } },
		{ head_repository: { id: 55, full_name: "Other/Repo" } },
		{ path: ".github/workflows/fake.yml" },
		{ id: 999 },
		{ status: "in_progress" },
	]) {
		test(`rejects source run provenance ${JSON.stringify(change)}`, async () => {
			const state = fixture();
			Object.assign(state.source, change);
			await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow();
			expect(state.downloads).toBe(0);
		});
	}
	test("rejects fork repository and workflow API mismatch", async () => {
		const state = fixture();
		state.source.head_repository.id = 66;
		await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow();
		state.source.head_repository.id = 55;
		state.workflowPath = ".github/workflows/fake.yml";
		await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow();
	});
	for (const group of [
		"Static checks",
		"Tests (3/4)",
		"CI Gate",
		"Build (windows-arm64)",
		"Smoke (darwin-x64)",
		"Assemble release bundle",
	]) {
		test(`rejects skipped source job ${group}`, async () => {
			const state = fixture();
			const job = state.jobs.find((entry) => entry.name.includes(group));
			if (!job) throw new Error("bad fixture");
			job.conclusion = "skipped";
			await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow("Source job");
			expect(state.downloads).toBe(0);
		});
	}
	test("rejects missing, duplicated, wrong-attempt and forged-prefix jobs", async () => {
		for (const mode of ["missing", "duplicate", "attempt", "prefix"]) {
			const state = fixture();
			if (mode === "missing") state.jobs.pop();
			if (mode === "duplicate") state.jobs.push({ ...state.jobs[0], id: 100 });
			if (mode === "attempt") state.jobs[0].run_attempt = 1;
			if (mode === "prefix") state.jobs[0].name = `Untrusted / ${state.jobs[0].name}`;
			await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow("Source job");
		}
	});
	test("requires exact nonexpired artifact and cannot fall back to rebuilding", async () => {
		for (const mode of ["expired", "deleted", "duplicate", "attempt", "run", "head"]) {
			const state = fixture();
			if (mode === "expired") state.artifact.expired = true;
			if (mode === "deleted") state.artifactDeleted = true;
			if (mode === "duplicate") state.duplicateArtifact = true;
			if (mode === "attempt") state.artifact.name = "release-bundle-101-1";
			if (mode === "run") state.artifact.workflow_run.id = 999;
			if (mode === "head") state.artifact.workflow_run.head_sha = commit;
			await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow();
			expect(state.downloads).toBe(0);
		}
	});
	test("rejects API digest mismatch and cleans temporary output", async () => {
		const state = fixture();
		state.artifact.digest = `sha256:${"f".repeat(64)}`;
		await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow("digest");
		expect(existsSync(options(state).destination)).toBe(false);
		expect(readdirSync(state.root).filter((name) => name.includes("restore-"))).toEqual([]);
	});
	test("rejects short/oversized download and cancellation", async () => {
		const state = fixture();
		state.artifact.size_in_bytes--;
		await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow("size");
		state.artifact.size_in_bytes++;
		await expect(
			restoreCiReleaseBundle({ ...options(state), signal: AbortSignal.abort() }),
		).rejects.toThrow();
	});
	for (const extra of [
		{ name: "../escape" },
		{ name: "/absolute" },
		{ name: "dist/../escape" },
		{ name: "dist/link", kind: "symlink" },
		{ name: "manifest.json" },
	]) {
		test(`rejects unsafe zip ${JSON.stringify(extra)}`, async () => {
			const state = fixture();
			state.repack(extra);
			await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow();
			expect(existsSync(join(state.root, "escape"))).toBe(false);
			expect(existsSync(options(state).destination)).toBe(false);
		});
	}
	for (const change of [
		{ runAttempt: 1 },
		{ runId: 999 },
		{ workflowCommit: commit },
		{ commit: workflowCommit },
		{ channel: "beta" },
	]) {
		test(`rejects manifest self-asserted identity ${JSON.stringify(change)}`, async () => {
			const state = fixture();
			Object.assign(state.manifest.plan, change);
			state.repack();
			await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow();
		});
	}
	test("rejects corrupted inner file even when outer archive digest is valid", async () => {
		const state = fixture();
		writeFileSync(join(state.bundle, "dist", state.manifest.files[0].name), "tampered");
		state.repack();
		await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow("mismatch");
	});
	test("follows only signed GitHub storage redirects without forwarding the token", async () => {
		const state = fixture();
		let requests = 0;
		const transport = (async (url: string | URL | Request, init?: RequestInit) => {
			requests++;
			if (requests === 1) {
				expect(String(url)).toEndWith("/actions/artifacts/900/zip");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
				return new Response(null, {
					status: 302,
					headers: { location: "https://fixture.blob.core.windows.net/signed.zip" },
				});
			}
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			return new Response(state.archive);
		}) as typeof fetch;
		await expect(
			restoreCiReleaseBundle({ ...options(state), fetch: transport }),
		).resolves.toMatchObject({ artifactId: 900 });
		expect(requests).toBe(2);
	});

	test("rejects attacker-controlled redirect and excessive stream bytes", async () => {
		const state = fixture();
		const redirect = (async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://attacker.invalid/archive" },
			})) as unknown as typeof fetch;
		await expect(restoreCiReleaseBundle({ ...options(state), fetch: redirect })).rejects.toThrow(
			"Untrusted",
		);
		const overrun = (async () =>
			new Response(
				Buffer.concat([state.archive, Buffer.from("extra")]),
			)) as unknown as typeof fetch;
		await expect(restoreCiReleaseBundle({ ...options(state), fetch: overrun })).rejects.toThrow(
			"exceeds size",
		);
	});

	test("does not merge into an existing destination", async () => {
		const state = fixture();
		mkdirSync(options(state).destination);
		await expect(restoreCiReleaseBundle(options(state))).rejects.toThrow("already exists");
		expect(state.downloads).toBe(0);
	});
});

/** Three distinct runs: original build 51, full re-verification 101, publisher 102. */
function reverifiedFixture() {
	const state = fixture();
	const originalPlan: CiReleasePlan = {
		...plan,
		runId: 51,
		runAttempt: 3,
		workflowCommit: "d".repeat(40),
	};
	const controlPath = join(state.root, "original-control.zip");
	execFileSync(
		"python3",
		[
			"-I",
			"-c",
			"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n z.writestr('plan.json',sys.argv[2]); z.writestr('control.js',b'throw new Error(\"never execute original control\")')",
			controlPath,
			JSON.stringify(originalPlan),
		],
		{ timeout: 5000, maxBuffer: 16384 },
	);
	const controlBytes = readFileSync(controlPath);
	const originalSource = {
		...state.source,
		id: 51,
		run_attempt: 3,
		head_sha: originalPlan.workflowCommit,
	};
	const artifact = (id: number, name: string, size: number, digest: string) => ({
		...state.artifact,
		id,
		name,
		size_in_bytes: size,
		digest,
		workflow_run: { ...state.artifact.workflow_run, id: 51, head_sha: originalPlan.workflowCommit },
	});
	const controlArtifact = artifact(
		800,
		"release-control-51-3",
		controlBytes.length,
		`sha256:${createHash("sha256").update(controlBytes).digest("hex")}`,
	);
	const platforms = CI_RELEASE_TARGETS.map(({ target }, index) =>
		artifact(801 + index, `release-platform-${target}-51-3`, 256, `sha256:${"a".repeat(64)}`),
	);
	const originalJobs = [
		"Release preflight",
		...REQUIRED_RELEASE_SOURCE_JOBS.filter(
			(name) => name.startsWith("Verify release source / ") || name.startsWith("Build ("),
		),
	].map((name, index) => ({
		id: 100 + index,
		run_id: 51,
		run_attempt: 3,
		head_sha: originalPlan.workflowCommit,
		name,
		status: "completed",
		conclusion: "success",
		steps: [
			{
				name: "Run actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
				status: "completed",
				conclusion: "success",
			},
		],
	}));
	state.jobs = REQUIRED_RELEASE_REVERIFY_JOBS.map((name, index) => ({
		id: 200 + index,
		run_id: 101,
		run_attempt: 2,
		name,
		status: "completed",
		conclusion: "success",
		head_sha: workflowCommit,
	}));
	state.manifest.plan.buildSource = {
		runId: 51,
		runAttempt: 3,
		workflowCommit: originalPlan.workflowCommit,
		controlArtifact: {
			id: controlArtifact.id,
			digest: controlArtifact.digest,
			size: controlArtifact.size_in_bytes,
		},
		platforms: CI_RELEASE_TARGETS.map(({ target }, index) => {
			const value = platforms[index];
			if (!value) throw new Error("Missing fixture platform artifact");
			return {
				target,
				artifact: { id: value.id, digest: value.digest, size: value.size_in_bytes },
			};
		}),
	};
	state.repack();
	const run = async (args: string[]) => {
		const path = args[1]?.replace(`repos/${plan.repository}/`, "") ?? "";
		if (path === "actions/runs/51/attempts/3") return JSON.stringify(originalSource);
		if (path.startsWith("actions/runs/51/attempts/3/jobs"))
			return JSON.stringify({ total_count: originalJobs.length, jobs: originalJobs });
		if (path.startsWith("actions/runs/51/artifacts?"))
			return JSON.stringify({ total_count: 9, artifacts: [controlArtifact, ...platforms] });
		const item = [controlArtifact, ...platforms].find(
			(value) => path === `actions/artifacts/${value.id}`,
		);
		if (item) return JSON.stringify(item);
		return state.run(args);
	};
	const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url).endsWith("/actions/artifacts/800/zip")) {
			init?.signal?.throwIfAborted();
			return new Response(controlBytes, {
				headers: { "content-length": String(controlBytes.length) },
			});
		}
		if (/\/actions\/artifacts\/80[1-8]\/zip$/.test(String(url)))
			throw new Error("Publisher must not download original large platform archives");
		return state.fetch(url, init);
	}) as typeof globalThis.fetch;
	return { state, originalPlan, originalJobs, options: { ...options(state), run, fetch } };
}

describe("publication proof for re-verified original builds", () => {
	test("a later publisher restores a fully re-verified bundle without rerunning original tests or downloading original binaries", async () => {
		const f = reverifiedFixture();
		const restored = await restoreCiReleaseBundle(f.options);
		expect(restored.plan.buildSource).toEqual(f.state.manifest.plan.buildSource);
		expect(restored.plan.runId).toBe(101);
		expect(restored.plan.buildSource?.runId).toBe(51);
		for (const file of f.state.manifest.files)
			expect(readFileSync(join(restored.destination, "dist", file.name))).toEqual(
				readFileSync(join(f.state.bundle, "dist", file.name)),
			);
	});

	for (const name of [
		"Release preflight",
		"Restore original platform (windows-arm64)",
		"Smoke (windows-x64)",
		"Assemble release bundle",
	])
		test(`refuses incomplete re-verification proof: ${name}`, async () => {
			const f = reverifiedFixture();
			const job = f.state.jobs.find((job) => job.name === name);
			if (!job) throw new Error("Missing fixture job");
			job.conclusion = "skipped";
			await expect(restoreCiReleaseBundle(f.options)).rejects.toThrow("Source job");
			expect(f.state.downloads).toBe(0);
		});

	test("requires original successful source tests even though every re-verification job succeeded", async () => {
		const f = reverifiedFixture();
		const job = f.originalJobs.find((job) => job.name.includes("Tests (2/4)"));
		if (!job) throw new Error("Missing fixture test shard");
		job.conclusion = "failure";
		await expect(restoreCiReleaseBundle(f.options)).rejects.toThrow("Original source job");
		expect(existsSync(f.options.destination)).toBe(false);
	});

	test("rejects re-verification jobs attached to a manifest that omits original build provenance", async () => {
		const f = reverifiedFixture();
		delete f.state.manifest.plan.buildSource;
		f.state.repack();
		await expect(restoreCiReleaseBundle(f.options)).rejects.toThrow("source CI and build proof");
	});

	test("rejects single-platform provenance despite unrelated all-eight successful job names", async () => {
		const f = reverifiedFixture();
		const source = f.state.manifest.plan.buildSource;
		if (!source) throw new Error("Missing fixture build origin");
		source.platforms = source.platforms.slice(0, 1);
		f.state.repack();
		await expect(restoreCiReleaseBundle(f.options)).rejects.toThrow("complete native proof");
	});
});
