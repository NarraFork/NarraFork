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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatMetadataJson,
} from "../../scripts/lib/binary-metadata";
import {
	atomicInstallCiReleaseBuild,
	prepareCiReleaseBuild,
	REQUIRED_RELEASE_BUILD_SOURCE_CHECKS,
	restoreCiReleaseBuildPlatform,
	restoreCiReleaseRemoteFrontend,
	validateCiReleaseBuildSource,
} from "../../scripts/lib/ci-release-build-restore";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_REPOSITORY,
	CI_RELEASE_TARGETS,
	CI_RELEASE_WORKFLOW,
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
const currentCommit = "c".repeat(40);
const upload = "Run actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const basePlan: CiReleasePlan = {
	schemaVersion: 1,
	repository: CI_RELEASE_REPOSITORY,
	defaultBranch: "main",
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
interface ZipEntry {
	name: string;
	bytes: Buffer;
	kind?: "symlink" | "directory";
	inflated?: number;
	encrypted?: boolean;
}
function pack(root: string, name: string, entries: ZipEntry[]): Buffer {
	const path = join(root, name);
	execFileSync(
		"python3",
		[
			"-I",
			"-c",
			`
import base64,json,stat,struct,sys,zipfile
path = sys.argv[1]
entries=json.loads(sys.stdin.read())
with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as bundle:
 for item in entries:
  info=zipfile.ZipInfo(item['name']); info.create_system=3
  info.compress_type=zipfile.ZIP_DEFLATED
  info.external_attr=(0o120777 if item.get('kind')=='symlink' else 0o40755 if item.get('kind')=='directory' else 0o100644)<<16
  bundle.writestr(info,base64.b64decode(item['bytes']))
data=bytearray(open(path,'rb').read())
pos=0
for item in entries:
 pos=data.index(b'PK\\x01\\x02',pos)
 if item.get('inflated') is not None: struct.pack_into('<I',data,pos+24,item['inflated'])
 if item.get('encrypted'): struct.pack_into('<H',data,pos+8,struct.unpack_from('<H',data,pos+8)[0]|1)
 pos+=46
open(path,'wb').write(data)
`,
			path,
		],
		{
			input: JSON.stringify(
				entries.map((entry) => ({ ...entry, bytes: entry.bytes.toString("base64") })),
			),
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		},
	);
	return readFileSync(path);
}
function contents(value: unknown) {
	const bytes = Buffer.from(JSON.stringify(value));
	return {
		type: "file",
		encoding: "base64",
		size: bytes.length,
		content: bytes.toString("base64"),
	};
}
function createArtifactTemplate(root: string, original: CiReleasePlan) {
	const workflowRun = {
		id: 101,
		repository_id: 55,
		head_repository_id: 55,
		head_branch: original.defaultBranch ?? "main",
		head_sha: workflowCommit,
	};
	const template: {
		artifact: {
			id: number;
			name: string;
			expired: boolean;
			size_in_bytes: number;
			digest: string;
			workflow_run: typeof workflowRun;
		};
		archive: Buffer;
		entries: ZipEntry[];
	}[] = [];
	function addArtifact(name: string, entries: ZipEntry[]) {
		const artifactId = 900 + template.length;
		const archive = pack(root, `${artifactId}.zip`, entries);
		const artifact = {
			id: artifactId,
			name,
			expired: false,
			size_in_bytes: archive.length,
			digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
			workflow_run: { ...workflowRun },
		};
		Object.freeze(artifact.workflow_run);
		Object.freeze(artifact);
		for (const entry of entries) Object.freeze(entry);
		Object.freeze(entries);
		template.push(Object.freeze({ artifact, archive, entries }));
	}
	addArtifact("release-control-101-2", [
		{ name: "plan.json", bytes: Buffer.from(JSON.stringify(original)) },
		{
			name: "control.js",
			bytes: Buffer.from("throw new Error('must never execute original code');"),
		},
	]);
	for (const target of CI_RELEASE_TARGETS) {
		const name = `narrafork-${original.version}-${target.suffix}`;
		const bytes = Buffer.from(`original-binary:${target.target}\0\xff`);
		const metadata = computeBinaryMetadataFromBuffer(name, bytes, {
			version: original.version,
			platformId: target.platform,
			target: `bun-${target.target}`,
			commit: commit.slice(0, 12),
			repository: original.repository,
			buildDate: "2026-10-08T00:00:00.000Z",
		});
		addArtifact(`release-platform-${target.target}-101-2`, [
			{ name, bytes },
			{ name: `${name}.metadata.json`, bytes: Buffer.from(formatMetadataJson(metadata)) },
		]);
	}
	return Object.freeze(template);
}
const defaultArtifactTemplate = (() => {
	let template: ReturnType<typeof createArtifactTemplate> | undefined;
	// Build all nine real ZIPs once. Retain only private in-memory bytes, never paths or fixture state.
	// Buffers cannot be frozen: callers must copy them, along with every nested mutable value.
	return (root: string) => (template ??= createArtifactTemplate(root, basePlan));
})();
function fixture(supplied?: CiReleasePlan) {
	const original = structuredClone(supplied ?? basePlan);
	const root = mkdtempSync(join(tmpdir(), "narrafork-build-restore-"));
	roots.push(root);
	const branch = original.defaultBranch ?? "main";
	const repositoryName = original.repository;
	const repository = { id: 55, full_name: repositoryName };
	const env = {
		GH_TOKEN: "fixture-only",
		GITHUB_REPOSITORY: original.repository,
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REF: `refs/heads/${branch}`,
		GITHUB_WORKFLOW_REF: `${original.repository}/${CI_RELEASE_WORKFLOW}@refs/heads/${branch}`,
		GITHUB_WORKFLOW_SHA: currentCommit,
		GITHUB_SHA: currentCommit,
		GITHUB_RUN_ID: "102",
		GITHUB_RUN_ATTEMPT: "1",
	};
	// Explicit plans (including repository/branch/legacy variants) always use real Python packing.
	const template =
		supplied === undefined ? defaultArtifactTemplate(root) : createArtifactTemplate(root, original);
	const artifacts = template.map(({ artifact }) => structuredClone(artifact));
	const archives = new Map<number, Buffer>(
		template.map(({ artifact, archive }) => [artifact.id, Buffer.from(archive)]),
	);
	const entries = new Map<number, ZipEntry[]>(
		template.map(({ artifact, entries }) => [
			artifact.id,
			entries.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
		]),
	);
	const jobs = [
		"Release preflight",
		...REQUIRED_RELEASE_BUILD_SOURCE_CHECKS,
		...CI_RELEASE_TARGETS.map(({ target }) => `Build (${target})`),
		"Smoke (windows-arm64)",
	].map((name, index) => ({
		id: index + 1,
		run_id: 101,
		run_attempt: 2,
		head_sha: workflowCommit,
		name,
		status: "completed",
		conclusion: name.startsWith("Smoke") ? "failure" : "success",
		steps:
			name === "Release preflight" || name.startsWith("Build (")
				? [{ name: upload, status: "completed", conclusion: "success" }]
				: [],
	}));
	const state = {
		root,
		env,
		original,
		artifacts,
		archives,
		entries,
		jobs,
		calls: [] as string[],
		downloads: [] as number[],
		workflowPath: CI_RELEASE_WORKFLOW as string,
		tagCommit: commit,
		duplicateArtifact: false,
		detailMutation: undefined as undefined | ((artifact: (typeof artifacts)[number]) => void),
		fetchMutation: undefined as undefined | ((id: number, bytes: Buffer) => Buffer),
		source: {
			id: 101,
			run_attempt: 2,
			workflow_id: 77,
			path: CI_RELEASE_WORKFLOW as string,
			event: "workflow_dispatch",
			head_branch: branch,
			head_sha: workflowCommit,
			status: "completed",
			conclusion: "failure",
			repository: { ...repository },
			head_repository: { ...repository },
		},
		repack(id = 900) {
			const archive = pack(root, `${id}.zip`, entries.get(id) ?? []);
			archives.set(id, archive);
			const artifact = artifacts.find((item) => item.id === id);
			if (!artifact) throw new Error("fixture artifact missing");
			artifact.size_in_bytes = archive.length;
			artifact.digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
		},
		repackPlan() {
			const values = entries.get(900);
			if (!values) throw new Error("fixture control missing");
			values[0].bytes = Buffer.from(JSON.stringify(original));
			state.repack();
		},
		async run(args: string[]) {
			const full = args[1];
			state.calls.push(full);
			if (full === `repos/${repositoryName}`)
				return JSON.stringify({ full_name: repositoryName, default_branch: branch });
			const path = full.replace(`repos/${repositoryName}/`, "");
			const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? "1");
			let value: unknown;
			if (path === "actions/runs/101/attempts/2") value = state.source;
			else if (path === "actions/workflows/77")
				value = { id: 77, path: state.workflowPath, state: "active" };
			else if (path.startsWith("actions/runs/101/attempts/2/jobs?"))
				value = { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) };
			else if (path.startsWith("actions/runs/101/artifacts?")) {
				const list = state.duplicateArtifact ? [...artifacts, artifacts[0]] : artifacts;
				value = { total_count: list.length, artifacts: list.slice((page - 1) * 100, page * 100) };
			} else if (/^actions\/artifacts\/\d+$/.test(path)) {
				const artifact = artifacts.find((item) => item.id === Number(path.split("/").at(-1)));
				if (!artifact) throw new Error(`Unknown fixture artifact: ${path}`);
				value = structuredClone(artifact);
				state.detailMutation?.(value as typeof artifact);
			} else if (path === "git/ref/tags/v1.2.0")
				value = { object: { type: "commit", sha: state.tagCommit } };
			else if (path === `git/ref/heads/${encodeURIComponent(branch)}`)
				value = { object: { type: "commit", sha: currentCommit } };
			else if (path.startsWith("compare/"))
				value = { status: "ahead", merge_base_commit: { sha: path.slice(8, 48) } };
			else if (path === `git/trees/${commit}`) value = { truncated: false, tree: [] };
			else if (path === `contents/shared/remote-access/frontend-capability.json?ref=${commit}`) {
				if (!original.remoteFrontend) throw new Error("HTTP 404");
				value = contents(original.remoteFrontend);
			} else if (path === `contents/package.json?ref=${commit}`)
				value = contents({ version: "1.2.0", packageManager: `bun@${CI_RELEASE_BUN}` });
			else if (path === `contents/changelogs/v1.2.0.json?ref=${commit}`)
				value = contents(basePlan.changelog);
			else if (path === `contents/scripts/lib/ci-release-types.ts?ref=${commit}`)
				value = { type: "file", size: 1 };
			else if (path === "environments/release")
				value = {
					name: "release",
					protection_rules: [
						{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
					],
					deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
				};
			else if (path.startsWith("environments/release/deployment-branch-policies?"))
				value = { total_count: 1, branch_policies: [{ name: branch, type: "branch" }] };
			else throw new Error(`Unexpected fixture API: ${path}`);
			return JSON.stringify(value);
		},
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			const artifactId = Number(String(url).split("/").at(-2));
			const bytes = archives.get(artifactId);
			if (!bytes) throw new Error(`Unexpected real network attempt: ${url}`);
			state.downloads.push(artifactId);
			const body = state.fetchMutation?.(artifactId, bytes) ?? bytes;
			return new Response(new Uint8Array(body), {
				headers: { "content-length": String(body.length) },
			});
		}) as typeof fetch,
	};
	return state;
}
function prepare(state: ReturnType<typeof fixture>, target: string | undefined = "linux-x64") {
	return prepareCiReleaseBuild({
		...state,
		sourceRunId: 101,
		sourceRunAttempt: 2,
		tag: "v1.2.0",
		target,
		publish: false,
	});
}
function restore(
	state: ReturnType<typeof fixture>,
	plan: CiReleasePlan,
	target = "linux-x64",
	signal?: AbortSignal,
) {
	return restoreCiReleaseBuildPlatform({
		...state,
		plan,
		target,
		destination: join(state.root, "restored"),
		signal,
	});
}
function noOwnedTemps(state: ReturnType<typeof fixture>) {
	expect(
		readdirSync(state.root).filter(
			(name) => name.startsWith(".ci-build-") || name.startsWith(".restored-"),
		),
	).toEqual([]);
}

describe("default artifact template isolation", () => {
	test("copies all mutable state and bytes and survives removal of its original directory", async () => {
		const left = fixture();
		const right = fixture();
		expect(left.root).not.toBe(right.root);
		expect(left.original).not.toBe(right.original);
		expect(left.original.baselines).not.toBe(right.original.baselines);
		expect(left.original.changelog).not.toBe(right.original.changelog);
		expect(left.archives).not.toBe(right.archives);
		expect(left.entries).not.toBe(right.entries);
		expect(left.run).not.toBe(right.run);
		expect(left.fetch).not.toBe(right.fetch);
		for (const artifact of left.artifacts) {
			const other = right.artifacts.find((item) => item.id === artifact.id);
			const archive = left.archives.get(artifact.id);
			const values = left.entries.get(artifact.id);
			if (!other || !archive || !values) throw new Error("fixture archive missing");
			expect(artifact).not.toBe(other);
			expect(artifact.workflow_run).not.toBe(other.workflow_run);
			expect(archive).not.toBe(right.archives.get(artifact.id));
			expect(values).not.toBe(right.entries.get(artifact.id));
			for (const [index, entry] of values.entries()) {
				expect(entry).not.toBe(right.entries.get(artifact.id)?.[index]);
				expect(entry.bytes).not.toBe(right.entries.get(artifact.id)?.[index].bytes);
				entry.bytes.fill(0);
				entry.name = "mutated";
			}
			archive.fill(0);
			values.pop();
			artifact.workflow_run.head_sha = currentCommit;
			artifact.digest = "mutated";
		}
		left.original.changelog.en = "mutated";
		left.original.baselines.length = 1;
		left.env.GITHUB_RUN_ID = "999";
		left.source.head_repository.full_name = "attacker/fork";
		left.jobs[0].steps[0].name = "mutated";
		left.jobs[0].conclusion = "failure";
		left.jobs.pop();
		left.artifacts.pop();
		await left.run(["api", `repos/${CI_RELEASE_REPOSITORY}/actions/runs/101/attempts/2`]);
		await left.fetch(`https://fixture.invalid/actions/artifacts/900/zip`);
		expect(left.calls).toHaveLength(1);
		expect(left.downloads).toEqual([900]);
		expect(right.calls).toEqual([]);
		expect(right.downloads).toEqual([]);
		rmSync(left.root, { recursive: true, force: true });
		const fresh = fixture();
		for (const state of [right, fresh]) {
			expect(existsSync(state.root)).toBe(true);
			expect(state.original).toEqual(basePlan);
			expect(state.artifacts).toHaveLength(9);
			expect([...state.archives.keys()]).toEqual([900, 901, 902, 903, 904, 905, 906, 907, 908]);
			expect([...state.entries.keys()]).toEqual([...state.archives.keys()]);
			for (const artifact of state.artifacts) {
				const archive = state.archives.get(artifact.id);
				if (!archive) throw new Error("fixture archive missing");
				expect(Buffer.isBuffer(archive)).toBe(true);
				expect(artifact.size_in_bytes).toBe(archive.length);
				expect(artifact.digest).toBe(
					`sha256:${createHash("sha256").update(archive).digest("hex")}`,
				);
				for (const entry of state.entries.get(artifact.id) ?? [])
					expect(Buffer.isBuffer(entry.bytes)).toBe(true);
			}
		}
		const plan = await prepare(right, "all");
		expect(plan.buildSource?.platforms).toHaveLength(8);
		await restore(right, plan, "windows-arm64");
		expect(right.downloads).toEqual([900, 900, 906]);
		for (const entry of right.entries.get(906) ?? [])
			expect(readFileSync(join(right.root, "restored", entry.name))).toEqual(
				Buffer.from(entry.bytes),
			);
		expect(fresh.calls).toEqual([]);
		expect(fresh.downloads).toEqual([]);
		await prepare(fresh);
		expect(fresh.downloads).toEqual([900]);
		noOwnedTemps(right);
		noOwnedTemps(fresh);
	});
});

async function addRemoteOriginal(state: ReturnType<typeof fixture>, sourceCommit = commit) {
	state.original.remoteFrontend = REMOTE_FRONTEND_CAPABILITY;
	state.repackPlan();
	const remote = await remoteReleaseFixture(state.root, {
		...state.original,
		commit: sourceCommit,
	});
	state.artifacts.push({
		...structuredClone(state.artifacts[0]),
		id: 950,
		name: "remote-frontend-101-2",
	});
	state.entries.set(
		950,
		Object.values(remote.names).map((name) => ({
			name,
			bytes: readFileSync(join(remote.directory, name)),
		})),
	);
	state.repack(950);
	const build = state.jobs.find(
		(job) => job.name === "Verify release source / Build and typecheck",
	);
	if (!build) throw new Error("Missing fixture build");
	build.steps.push({ name: "Upload remote frontend", status: "completed", conclusion: "success" });
	return remote;
}
describe("frozen original remote frontend recovery", () => {
	test("freezes artifact ID/digest/size/run/attempt and restores original bytes without a build", async () => {
		const state = fixture();
		const remote = await addRemoteOriginal(state);
		const plan = await prepare(state, "all");
		const artifact = state.artifacts.find((item) => item.id === 950);
		if (!artifact) throw new Error("Missing remote artifact fixture");
		expect(plan.buildSource?.remoteFrontend).toEqual({
			id: 950,
			digest: artifact.digest,
			size: artifact.size_in_bytes,
		});
		expect(plan.buildSource).toMatchObject({ runId: 101, runAttempt: 2, workflowCommit });
		const destination = join(state.root, "remote-restored");
		await restoreCiReleaseRemoteFrontend({
			root: state.root,
			plan,
			destination,
			run: state.run,
			env: state.env,
			fetch: state.fetch,
		});
		for (const name of Object.values(remote.names))
			expect(readFileSync(join(destination, name))).toEqual(
				readFileSync(join(remote.directory, name)),
			);
		expect(state.downloads.every((id) => id === 900 || id === 950)).toBe(true);
	});
	test("rejects missing remote artifact/proof and a changed frozen digest rather than rebuilding", async () => {
		const state = fixture();
		await addRemoteOriginal(state);
		const plan = await prepare(state, "all");
		const remote = state.artifacts.find((artifact) => artifact.id === 950);
		if (!remote) throw new Error();
		remote.digest = `sha256:${"0".repeat(64)}`;
		await expect(
			restoreCiReleaseRemoteFrontend({
				root: state.root,
				plan,
				destination: join(state.root, "rejected"),
				run: state.run,
				env: state.env,
				fetch: state.fetch,
			}),
		).rejects.toThrow("identity");
		state.artifacts.splice(state.artifacts.indexOf(remote), 1);
		await expect(prepare(state, "all")).rejects.toThrow("artifact missing");
	});
	test("valid transport digest cannot excuse remote manifest with another source commit", async () => {
		const state = fixture();
		await addRemoteOriginal(state, "d".repeat(40));
		const plan = await prepare(state, "all");
		const destination = join(state.root, "wrong-source");
		await expect(
			restoreCiReleaseRemoteFrontend({
				root: state.root,
				plan,
				destination,
				run: state.run,
				env: state.env,
				fetch: state.fetch,
			}),
		).rejects.toThrow("TARGET_MISMATCH");
		expect(existsSync(destination)).toBe(false);
	});
});

describe("original build recovery", () => {
	test("recovers failed original smoke without compile/new baseline and preserves exact original binary/sidecar bytes", async () => {
		const state = fixture();
		const plan = await prepare(state);
		expect(plan.runId).toBe(102);
		expect(plan.workflowCommit).toBe(currentCommit);
		expect(plan.buildSource?.workflowCommit).toBe(workflowCommit);
		expect(plan.buildSource?.platforms.map((item) => item.target)).toEqual(["linux-x64"]);
		expect(state.downloads).toEqual([900]);
		await restore(state, plan);
		for (const entry of state.entries.get(901) ?? []) {
			expect(readFileSync(join(state.root, "restored", entry.name))).toEqual(
				Buffer.from(entry.bytes),
			);
		}
		expect(readdirSync(join(state.root, "restored"))).toHaveLength(2);
		expect(state.downloads).toEqual([900, 900, 901]);
		expect(
			state.calls.some((call) => call.includes("releases") || call.includes("dispatches")),
		).toBe(false);
		expect(existsSync(join(state.root, "control.js"))).toBe(false);
		noOwnedTemps(state);
	});
	test("all mode freezes all eight original artifacts and validates without downloading binaries", async () => {
		const state = fixture();
		const plan = await prepare(state, "all");
		expect(plan.buildSource?.platforms).toHaveLength(8);
		await validateCiReleaseBuildSource(plan, state);
		expect(state.downloads).toEqual([900, 900]);
		await restore(state, plan, "windows-arm64");
		expect(state.downloads.at(-1)).toBe(906);
		noOwnedTemps(state);
	});
	test("unset target selects all; a single target need not accept an unrelated failed platform build", async () => {
		const state = fixture();
		const bad = state.jobs.find((item) => item.name === "Build (darwin-x64)");
		if (!bad) throw new Error("fixture missing job");
		bad.conclusion = "failure";
		await prepare(state);
		await expect(
			prepareCiReleaseBuild({
				...state,
				sourceRunId: "101",
				sourceRunAttempt: "2",
				tag: "v1.2.0",
				publish: false,
			}),
		).rejects.toThrow("unsuccessful");
	});
	test("reads complete paginated attempt jobs/artifacts and rejects truncated or changing lists", async () => {
		const state = fixture();
		state.jobs.unshift(
			...Array.from({ length: 100 }, (_, index) => ({
				...state.jobs[1],
				id: 500 + index,
				name: `Unrelated (${index})`,
			})),
		);
		state.artifacts.unshift(
			...Array.from({ length: 100 }, (_, index) => ({
				...state.artifacts[1],
				id: 500 + index,
				name: `unrelated-${index}`,
			})),
		);
		await prepare(state);
		expect(state.calls.some((path) => path.includes("/jobs?") && path.endsWith("page=2"))).toBe(
			true,
		);
		expect(
			state.calls.some((path) => path.includes("/artifacts?") && path.endsWith("page=2")),
		).toBe(true);
		const run = state.run;
		for (const mutation of ["truncated", "changed"]) {
			state.run = async (args) => {
				const value = JSON.parse(await run(args));
				if (args[1].includes("/artifacts?") && args[1].endsWith("page=2")) {
					if (mutation === "truncated") value.artifacts = [];
					else value.total_count += 1;
				}
				return JSON.stringify(value);
			};
			await expect(prepare(state)).rejects.toThrow("pagination");
		}
	});
	test("control archive may contain only plan.json; requested target must belong to frozen set", async () => {
		const state = fixture();
		state.entries.get(900)?.pop();
		state.repack();
		const plan = await prepare(state);
		await validateCiReleaseBuildSource(plan, state);
		await expect(restore(state, plan, "darwin-arm64")).rejects.toThrow("absent");
		await expect(prepare(state, "linux-unsupported")).rejects.toThrow("target");
		if (!plan.buildSource) throw new Error("fixture source missing");
		plan.buildSource.platforms.push({ ...plan.buildSource.platforms[0], target: "linux-arm64" });
		await expect(validateCiReleaseBuildSource(plan, state)).rejects.toThrow();
		noOwnedTemps(state);
	});
	test("rejects same-run recovery before querying original source", async () => {
		const state = fixture();
		state.env.GITHUB_RUN_ID = "101";
		await expect(prepare(state)).rejects.toThrow("different run");
		expect(state.downloads).toEqual([]);
	});
	test("publishing preparation requires release Environment checks", async () => {
		const state = fixture();
		await prepareCiReleaseBuild({
			...state,
			sourceRunId: 101,
			sourceRunAttempt: 2,
			tag: "v1.2.0",
			target: "linux-x64",
			publish: true,
		});
		expect(state.calls.some((path) => path.endsWith("environments/release"))).toBe(true);
	});
	test("online native recovery retains new control evidence without rewriting original artifacts", async () => {
		const state = fixture();
		const evidence = {
			executor: {
				version: "0.9.1",
				protocolVersion: 1,
				tag: "executor-v0.9.1",
				commit: "d".repeat(40),
				manifestSha256: "e".repeat(64),
				buildInputsSha256: "f".repeat(64),
			},
		};
		const before = new Map([...state.archives].map(([id, bytes]) => [id, Buffer.from(bytes)]));
		const control = await prepareCiReleaseBuild({
			...state,
			sourceRunId: 101,
			sourceRunAttempt: 2,
			tag: "v1.2.0",
			publish: true,
			componentChecks: {
				readDependencies: async () => createHelperDistributionDependencies("0.9.1"),
				verifyEvidence: async () => evidence,
			},
		});
		expect(control.componentEvidence).toEqual(evidence);
		expect(control.runId).toBe(102);
		expect(control.buildSource?.runId).toBe(101);
		expect(state.original.componentEvidence).toBeUndefined();
		for (const [id, bytes] of state.archives) {
			const original = before.get(id);
			if (!original) throw new Error("Missing original archive fixture");
			expect(bytes).toEqual(original);
		}
	});
	test("freezes original baselines, never selects current baselines", async () => {
		const state = fixture();
		const name = "narrafork-1.1.0-linux-x64";
		const metadata = computeBinaryMetadataFromBuffer(name, Buffer.from("old"), {
			version: "1.1.0",
			platformId: "linux-x64",
			target: "bun-linux-x64",
			commit: commit.slice(0, 12),
			buildDate: "2026-10-07T00:00:00.000Z",
		});
		state.original.baselines.push({
			releaseId: 30,
			version: "1.1.0",
			platform: "linux-x64",
			binaryAsset: { id: 31, name, size: 3 },
			metadataAsset: { id: 32, name: `${name}.metadata.json`, size: 100 },
			metadataSha256: "d".repeat(64),
			metadata,
		});
		state.repackPlan();
		const plan = await prepare(state);
		expect(plan.baselines).toEqual(state.original.baselines);
		plan.baselines[0].metadataSha256 = "e".repeat(64);
		await expect(validateCiReleaseBuildSource(plan, state)).rejects.toThrow("baselines changed");
	});
	for (const [label, change] of [
		[
			"fork source",
			(s: ReturnType<typeof fixture>) => {
				s.source.head_repository.full_name = "attacker/fork";
			},
		],
		[
			"fork id",
			(s: ReturnType<typeof fixture>) => {
				s.source.head_repository.id = 56;
			},
		],
		[
			"wrong attempt",
			(s: ReturnType<typeof fixture>) => {
				s.source.run_attempt = 3;
			},
		],
		[
			"wrong run",
			(s: ReturnType<typeof fixture>) => {
				s.source.id = 999;
			},
		],
		[
			"wrong workflow path",
			(s: ReturnType<typeof fixture>) => {
				s.source.path = ".github/workflows/ci.yml";
			},
		],
		[
			"inactive source",
			(s: ReturnType<typeof fixture>) => {
				s.source.status = "in_progress";
			},
		],
		[
			"wrong event",
			(s: ReturnType<typeof fixture>) => {
				s.source.event = "push";
			},
		],
		[
			"wrong branch",
			(s: ReturnType<typeof fixture>) => {
				s.source.head_branch = "feature";
			},
		],
		[
			"workflow api mismatch",
			(s: ReturnType<typeof fixture>) => {
				s.workflowPath = ".github/workflows/ci.yml";
			},
		],
		[
			"duplicate job id",
			(s: ReturnType<typeof fixture>) => {
				s.jobs[1].id = s.jobs[0].id;
			},
		],
		[
			"job run",
			(s: ReturnType<typeof fixture>) => {
				s.jobs[1].run_id = 999;
			},
		],
		[
			"job attempt",
			(s: ReturnType<typeof fixture>) => {
				s.jobs[1].run_attempt = 3;
			},
		],
		[
			"job head SHA",
			(s: ReturnType<typeof fixture>) => {
				s.jobs[1].head_sha = currentCommit;
			},
		],
		[
			"missing head SHA",
			(s: ReturnType<typeof fixture>) => {
				s.jobs[1].head_sha = "";
			},
		],
		[
			"duplicate job name",
			(s: ReturnType<typeof fixture>) => {
				s.jobs.push({ ...s.jobs[1], id: 99 });
			},
		],
		[
			"artifact expired",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[0].expired = true;
			},
		],
		[
			"artifact run",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[0].workflow_run.id = 999;
			},
		],
		[
			"artifact repo",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[0].workflow_run.repository_id = 56;
			},
		],
		[
			"artifact fork",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[0].workflow_run.head_repository_id = 56;
			},
		],
		[
			"artifact SHA",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[0].workflow_run.head_sha = currentCommit;
			},
		],
		[
			"artifact branch",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[0].workflow_run.head_branch = "fork";
			},
		],
		[
			"duplicate artifact id",
			(s: ReturnType<typeof fixture>) => {
				s.duplicateArtifact = true;
			},
		],
		[
			"duplicate artifact name",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts.push({ ...s.artifacts[0], id: 950 });
			},
		],
		[
			"missing artifact",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts.splice(1, 1);
			},
		],
		[
			"artifact detail digest",
			(s: ReturnType<typeof fixture>) => {
				s.detailMutation = (a) => {
					a.digest = `sha256:${"f".repeat(64)}`;
				};
			},
		],
		[
			"archive byte digest",
			(s: ReturnType<typeof fixture>) => {
				s.fetchMutation = (_id, bytes) => {
					const b = Buffer.from(bytes);
					b[10] ^= 1;
					return b;
				};
			},
		],
		[
			"archive size",
			(s: ReturnType<typeof fixture>) => {
				s.fetchMutation = (_id, bytes) => Buffer.concat([bytes, Buffer.from("extra")]);
			},
		],
		[
			"control too large",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[0].size_in_bytes = 4 * 1024 ** 2 + 1;
			},
		],
		[
			"platform too large",
			(s: ReturnType<typeof fixture>) => {
				s.artifacts[1].size_in_bytes = 2 * 1024 ** 3;
			},
		],
	] as const) {
		test(`rejects ${label}`, async () => {
			const state = fixture();
			change(state);
			await expect(prepare(state)).rejects.toThrow();
			noOwnedTemps(state);
		});
	}
	for (const name of [
		"Release preflight",
		...REQUIRED_RELEASE_BUILD_SOURCE_CHECKS,
		"Build (linux-x64)",
	]) {
		for (const conclusion of ["failure", "cancelled", "skipped"]) {
			test(`rejects ${name} ${conclusion}`, async () => {
				const state = fixture();
				const job = state.jobs.find((item) => item.name === name);
				if (!job) throw new Error("fixture missing job");
				job.conclusion = conclusion;
				await expect(prepare(state)).rejects.toThrow("unsuccessful");
			});
		}
	}
	for (const mutation of ["failure", "cancelled", "skipped", "duplicate", "missing", "wrong pin"]) {
		test(`rejects original upload ${mutation}`, async () => {
			const state = fixture();
			const job = state.jobs[0];
			if (mutation === "duplicate") job.steps.push({ ...job.steps[0] });
			else if (mutation === "missing") job.steps = [];
			else if (mutation === "wrong pin") job.steps[0].name = "Run actions/upload-artifact@v4";
			else job.steps[0].conclusion = mutation;
			await expect(prepare(state)).rejects.toThrow("upload");
		});
	}
	test("rejects original control chain, tag moved, or frozen identity changed", async () => {
		const state = fixture();
		const plan = await prepare(state);
		state.original.buildSource = plan.buildSource;
		state.repackPlan();
		await expect(prepare(state)).rejects.toThrow();
		delete state.original.buildSource;
		state.repackPlan();
		state.tagCommit = currentCommit;
		await expect(prepare(state)).rejects.toThrow("tag moved");
		state.tagCommit = commit;
		if (!plan.buildSource) throw new Error("source missing");
		plan.buildSource.platforms[0].artifact.id = 999;
		await expect(validateCiReleaseBuildSource(plan, state)).rejects.toThrow("identity mismatch");
	});
	test("rejects original plan run/attempt/controlSHA/tag/repository mismatch", async () => {
		for (const field of ["runId", "runAttempt", "workflowCommit", "tag", "repository"] as const) {
			const state = fixture();
			if (field === "runId" || field === "runAttempt") state.original[field] = 999;
			else if (field === "workflowCommit") state.original[field] = currentCommit;
			else if (field === "tag") {
				state.original.tag = "v1.3.0";
				state.original.version = "1.3.0";
				state.original.changelog.version = "1.3.0";
			} else state.original.repository = "attacker/fork";
			state.repackPlan();
			await expect(prepare(state)).rejects.toThrow();
		}
	});
	for (const [label, entry] of [
		["traversal", { name: "../plan.json", bytes: Buffer.from("x") }],
		["extra code", { name: "execute.js", bytes: Buffer.from("x") }],
		["symlink", { name: "control.js", bytes: Buffer.from("x"), kind: "symlink" }],
		["directory", { name: "control.js", bytes: Buffer.from("x"), kind: "directory" }],
		["encrypted", { name: "control.js", bytes: Buffer.from("x"), encrypted: true }],
		[
			"inflated oversized",
			{ name: "control.js", bytes: Buffer.from("x"), inflated: 4 * 1024 ** 2 },
		],
		["duplicate", { name: "plan.json", bytes: Buffer.from("x") }],
	] as const) {
		test(`rejects control ZIP ${label}`, async () => {
			const state = fixture();
			const entries = state.entries.get(900);
			if (!entries) throw new Error("fixture missing control");
			entries[1] = entry;
			state.repack();
			await expect(prepare(state)).rejects.toThrow();
			noOwnedTemps(state);
		});
	}
	for (const kind of [
		"traversal",
		"symlink",
		"directory",
		"duplicate",
		"encrypted",
		"oversized",
		"missing",
		"extra",
		"wrong binary hash",
		"wrong metadata commit",
		"wrong metadata repository",
		"wrong metadata sha512",
	]) {
		test(`rejects platform ZIP ${kind} and cleans only owned temporary files`, async () => {
			const state = fixture();
			const values = state.entries.get(901);
			if (!values) throw new Error("fixture platform missing");
			if (kind === "traversal") values[0].name = `../${values[0].name}`;
			else if (kind === "symlink" || kind === "directory") values[0].kind = kind;
			else if (kind === "duplicate") values[1].name = values[0].name;
			else if (kind === "encrypted") values[0].encrypted = true;
			else if (kind === "oversized") values[0].inflated = 1024 ** 3 + 1;
			else if (kind === "missing") values.pop();
			else if (kind === "extra") values.push({ name: "other", bytes: Buffer.from("x") });
			else if (kind === "wrong binary hash") values[0].bytes = Buffer.from("not original bytes");
			else {
				const metadata = JSON.parse(values[1].bytes.toString());
				if (kind === "wrong metadata commit") metadata.commit = currentCommit;
				else if (kind === "wrong metadata repository") metadata.repository = "attacker/fork";
				else metadata.sha512 = createHash("sha512").update("wrong").digest("base64");
				values[1].bytes = Buffer.from(JSON.stringify(metadata));
			}
			state.repack(901);
			const plan = await prepare(state);
			writeFileSync(join(state.root, "user-owned"), "keep");
			await expect(restore(state, plan)).rejects.toThrow();
			expect(existsSync(join(state.root, "restored"))).toBe(false);
			expect(readFileSync(join(state.root, "user-owned"), "utf8")).toBe("keep");
			noOwnedTemps(state);
		});
	}
	test("cancellation before API and during streaming leaves destination absent and cleans temps", async () => {
		const state = fixture();
		const cancelled = new AbortController();
		cancelled.abort(new Error("fixture cancel"));
		await expect(
			prepareCiReleaseBuild({
				...state,
				sourceRunId: 101,
				sourceRunAttempt: 2,
				tag: "v1.2.0",
				publish: false,
				signal: cancelled.signal,
			}),
		).rejects.toThrow("fixture cancel");
		expect(state.calls).toEqual([]);
		const plan = await prepare(state);
		const controller = new AbortController();
		state.fetch = (async (url: string | URL | Request) => {
			const id = Number(String(url).split("/").at(-2));
			const archive = state.archives.get(id);
			if (!archive) throw new Error("unexpected fetch");
			if (id === 900) return new Response(new Uint8Array(archive));
			return new Response(
				new ReadableStream({
					pull(stream) {
						stream.enqueue(archive.subarray(0, 10));
						controller.abort(new Error("cancel platform"));
					},
				}),
			);
		}) as typeof fetch;
		await expect(restore(state, plan, "linux-x64", controller.signal)).rejects.toThrow(
			"cancel platform",
		);
		expect(existsSync(join(state.root, "restored"))).toBe(false);
		noOwnedTemps(state);
	});
	test("publisher may revalidate run102's re-verification plan from fresh run103 without downloading binaries", async () => {
		const state = fixture();
		const plan = await prepare(state);
		state.env.GITHUB_RUN_ID = "103";
		state.env.GITHUB_WORKFLOW_SHA = "d".repeat(40);
		state.env.GITHUB_SHA = state.env.GITHUB_WORKFLOW_SHA;
		await validateCiReleaseBuildSource(plan, state);
		expect(state.downloads).toEqual([900, 900]);
		await expect(restore(state, plan)).rejects.toThrow("own re-verification");
		expect(state.downloads).toEqual([900, 900, 900]);
		expect(existsSync(join(state.root, "restored"))).toBe(false);
		noOwnedTemps(state);
	});
	test("atomic no-replace commit preserves even empty concurrent destinations", async () => {
		const state = fixture();
		const source = join(state.root, "owned-extracted");
		const destination = join(state.root, "concurrent-destination");
		mkdirSync(source);
		mkdirSync(destination);
		writeFileSync(join(source, "binary"), "original");
		await expect(atomicInstallCiReleaseBuild(source, destination, state.env)).rejects.toThrow();
		expect(readFileSync(join(source, "binary"), "utf8")).toBe("original");
		expect(readdirSync(destination)).toEqual([]);
		const second = join(state.root, "second-extracted");
		mkdirSync(second);
		writeFileSync(join(second, "binary"), "second");
		const raced = join(state.root, "winner");
		const results = await Promise.allSettled([
			atomicInstallCiReleaseBuild(source, raced, state.env),
			atomicInstallCiReleaseBuild(second, raced, state.env),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(["original", "second"]).toContain(readFileSync(join(raced, "binary"), "utf8"));
		expect(Number(existsSync(source)) + Number(existsSync(second))).toBe(1);
	});
	test("refuses existing destination and symlink parent/root without changing user files", async () => {
		const state = fixture();
		const plan = await prepare(state);
		mkdirSync(join(state.root, "restored"));
		writeFileSync(join(state.root, "restored", "keep"), "user data");
		await expect(restore(state, plan)).rejects.toThrow("already exists");
		expect(readFileSync(join(state.root, "restored", "keep"), "utf8")).toBe("user data");
		mkdirSync(join(state.root, "real"));
		symlinkSync(join(state.root, "real"), join(state.root, "linked"));
		await expect(
			restoreCiReleaseBuildPlatform({
				...state,
				plan,
				target: "linux-x64",
				destination: join(state.root, "linked", "new"),
			}),
		).rejects.toThrow("symlinks");
		await expect(
			validateCiReleaseBuildSource(plan, { ...state, root: join(state.root, "linked") }),
		).rejects.toThrow("symlinks");
		noOwnedTemps(state);
	});
	test("supports explicitly named upload steps and repository default branch identity", async () => {
		const state = fixture({
			...basePlan,
			repository: "example/private-product",
			defaultBranch: "develop",
		});
		state.jobs[0].steps[0].name = "Upload release control";
		const job = state.jobs.find((item) => item.name === "Build (linux-x64)");
		if (!job) throw new Error("fixture missing job");
		job.steps[0].name = "Upload release platform";
		const plan = await prepare(state);
		await restore(state, plan);
		expect(plan.repository).toBe("example/private-product");
	});
	test("rejects omitted fork repository metadata and permits only official legacy metadata", async () => {
		for (const repository of [CI_RELEASE_REPOSITORY, "example/fork"]) {
			const original = { ...basePlan, repository };
			delete original.defaultBranch;
			const state = fixture(original);
			const values = state.entries.get(901);
			if (!values) throw new Error("fixture missing binary");
			const metadata = JSON.parse(values[1].bytes.toString());
			delete metadata.repository;
			values[1].bytes = Buffer.from(JSON.stringify(metadata));
			state.repack(901);
			const plan = await prepare(state);
			if (repository === CI_RELEASE_REPOSITORY) await restore(state, plan);
			else await expect(restore(state, plan)).rejects.toThrow("repository identity");
		}
	});
});
