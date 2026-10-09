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
function fixture(releasePlan: CiReleasePlan = plan) {
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

describe("CI immutable release bundle restoration", () => {
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
		expect(state.calls.every((args) => args[0] === "api" && args.length === 2)).toBe(true);
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
