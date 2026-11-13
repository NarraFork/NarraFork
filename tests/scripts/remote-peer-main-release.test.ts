import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertReleaseGate, parseCiReleaseArgs } from "../../scripts/ci-release";
import {
	createPublicationGhRunner,
	PublicationGhApiError,
	runPublicationProcess,
} from "../../scripts/lib/ci-publication-runtime";
import {
	mainPeerArtifactName,
	publishMainReleasePeer,
	REQUIRED_MAIN_PEER_JOBS,
	validateMainPeerSource,
} from "../../scripts/lib/ci-release-peer";
import { validateCiReleasePlan } from "../../scripts/lib/ci-release-plan";
import type { CiReleasePlan } from "../../scripts/lib/ci-release-types";
import { isMissingPeerRemote } from "../../scripts/lib/helper-release";
import {
	fingerprintRemotePeerInputs,
	REMOTE_PEER_INPUT_RECIPE_PATHS,
	REMOTE_PEER_NATIVE_CONTRACT,
	type RemotePeerSource,
} from "../../scripts/lib/remote-peer-release-inputs";
import {
	prepareRemotePeerRelease,
	type RemotePeerReleasePlan,
	restoreRemotePeerReleasePlan,
} from "../../scripts/lib/remote-peer-release-prepare";
import {
	REMOTE_PEER_LICENSE_FILES,
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PLATFORMS,
	remotePeerPublishedFilename,
} from "../../shared/remote-peer";

const commit = "a".repeat(40);
const previous = "b".repeat(40);
const workflowCommit = "c".repeat(40);
const repository = "ForkOwner/peer-fork";
const version = "0.1.0-alpha.1";
const tag = `remote-peer-v${version}`;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
function sourceFixture() {
	const base: Record<string, string> = {
		"shared/component-versions.json": JSON.stringify({
			executor: { version: "0.9.4", protocolVersion: 1 },
			remotePeer: { version, protocolVersion: 1 },
		}),
		"remote-peer/go.mod":
			"module narrafork/remote-peer\n\ngo 1.26.1\nrequire example.com/production v1.0.0\n",
		"remote-peer/go.sum": "example.com/production v1.0.0 h1:frozen\n",
		"remote-peer/cmd/remote-peer/main.go":
			'package main\nimport "narrafork/remote-peer"\nfunc main() { peer.Run() }\n',
		"remote-peer/peer.go":
			'package peer\nimport (\n "narrafork/remote-peer/internal/buildinfo"\n _ "embed"\n)\n//go:embed payload.bin\nvar payload []byte\n',
		"remote-peer/protocol.go": "package peer\nconst ProtocolVersion = 1\n",
		"remote-peer/internal/buildinfo/buildinfo.go": 'package buildinfo\nvar Version = "dev"\n',
		"remote-peer/payload.bin": "embedded production data",
		"remote-peer/internal/licensebundle/main.go": "unused license generator",
		"remote-peer/peer_test.go": "test excluded",
		"remote-peer/README.md": "docs excluded",
		"remote-peer/dist/old": "dist excluded",
		"licenses/extra/remote-peer-LICENSES.txt": "real production license attachment",
		"package.json": '{"version":"9.9.9"}',
	};
	for (const path of REMOTE_PEER_INPUT_RECIPE_PATHS) base[path] = `frozen recipe: ${path}`;
	const versions = new Map([
		[commit, { ...base }],
		[previous, { ...base }],
	]);
	const source: RemotePeerSource = {
		async list(sha, directory) {
			return Object.keys(versions.get(sha) ?? {}).filter(
				(path) => path === directory || path.startsWith(`${directory}/`),
			);
		},
		async read(sha, path) {
			const value = versions.get(sha)?.[path];
			if (value === undefined) throw new Error(`missing ${sha}:${path}`);
			return value;
		},
	};
	return {
		source,
		current: versions.get(commit) as Record<string, string>,
		historical: versions.get(previous) as Record<string, string>,
	};
}
function publishedFixture(publicRelease: boolean) {
	const calls: string[][] = [];
	const state = {
		publicRelease,
		tagged: publicRelease ? previous : (undefined as string | undefined),
	};
	const identity = (name: string, content: string) => ({
		name,
		size: Buffer.byteLength(content),
		sha256: hash(content),
	});
	const manifest = {
		schemaVersion: 1,
		repository,
		tag,
		commit: previous,
		manifest: {
			version,
			protocolVersion: 1,
			releasedAt: "1970-01-01T00:00:00Z",
			platforms: Object.fromEntries(
				REMOTE_PEER_PLATFORMS.map((platform) => [
					platform,
					{
						filename: remotePeerPublishedFilename(version, platform),
						size: platform.length,
						sha256: hash(platform),
					},
				]),
			),
		},
		licenses: REMOTE_PEER_LICENSE_FILES.map((name) => identity(name, "license fixture")),
	};
	const raw = `${JSON.stringify(manifest)}\n`;
	const assets = [
		...REMOTE_PEER_PLATFORMS.map((platform) =>
			identity(remotePeerPublishedFilename(version, platform), platform),
		),
		...manifest.licenses,
		identity(REMOTE_PEER_MANIFEST_FILENAME, raw),
	].map((file, index) => ({
		...file,
		id: index + 1,
		state: "uploaded",
		digest: `sha256:${file.sha256}`,
	}));
	const missing = () => {
		throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });
	};
	const run = async (args: string[]) => {
		calls.push(args);
		if (
			args[0] !== "api" ||
			args.includes("POST") ||
			args.includes("PATCH") ||
			args.includes("DELETE")
		)
			throw new Error("Planning must not write remotely");
		if (args[1] === `repos/${repository}/releases/tags/${tag}`)
			return state.publicRelease
				? JSON.stringify({ id: 12, tag_name: tag, draft: false, prerelease: true, assets })
				: missing();
		if (args[1] === `repos/${repository}/git/ref/tags/${tag}`)
			return state.tagged
				? JSON.stringify({ object: { type: "commit", sha: state.tagged } })
				: missing();
		if (args[1]?.startsWith(`repos/${repository}/releases/assets/`)) return raw;
		throw new Error(`Unexpected API: ${args.join(" ")}`);
	};
	return { calls, state, run };
}
const plan = (remotePeer: RemotePeerReleasePlan): CiReleasePlan => ({
	schemaVersion: 1,
	repository,
	defaultBranch: "main",
	tag: "v1.2.0",
	version: "1.2.0",
	commit,
	workflowCommit,
	bunVersion: "1.4.3",
	channel: "stable",
	changelog: { version: "1.2.0", date: "2026-10-28", en: "Release", "zh-CN": "发布" },
	runId: 123,
	runAttempt: 2,
	baselines: [],
	remotePeer,
});
const building: RemotePeerReleasePlan = {
	action: "build",
	version,
	protocolVersion: 1,
	tag,
	sourceCommit: commit,
	inputsSha256: "d".repeat(64),
	nativeContract: REMOTE_PEER_NATIVE_CONTRACT,
};

describe("peer follows main release with a pre-compilation frozen plan", () => {
	test("missing pin adds no component operation", async () => {
		const fixture = sourceFixture();
		delete fixture.current["shared/component-versions.json"];
		const remote = publishedFixture(false);
		expect(
			await prepareRemotePeerRelease({
				root: ".",
				commit,
				repository,
				source: fixture.source,
				run: remote.run,
			}),
		).toEqual({ action: "absent" });
		expect(remote.calls).toHaveLength(0);
	});
	test("new pin automatically plans build without requiring a component tag", async () => {
		const fixture = sourceFixture();
		const remote = publishedFixture(false);
		const actual = await prepareRemotePeerRelease({
			root: ".",
			commit,
			repository,
			source: fixture.source,
			run: remote.run,
		});
		expect(actual).toMatchObject({
			action: "build",
			version,
			protocolVersion: 1,
			tag,
			sourceCommit: commit,
		});
		expect(validateCiReleasePlan(plan(actual)).remotePeer).toEqual(actual);
		expect(remote.calls).toHaveLength(2);
	});
	test("public identical production inputs reuse the historical manifest commit", async () => {
		const fixture = sourceFixture();
		const remote = publishedFixture(true);
		fixture.current["package.json"] = '{"version":"10.0.0"}';
		fixture.current["remote-peer/README.md"] = "new documentation";
		fixture.current["remote-peer/peer_test.go"] = "new tests";
		fixture.current["remote-peer/internal/licensebundle/main.go"] = "unused generator changed";
		const actual = await prepareRemotePeerRelease({
			root: ".",
			commit,
			repository,
			source: fixture.source,
			run: remote.run,
		});
		expect(actual).toMatchObject({ action: "reuse", sourceCommit: previous, tag });
		expect(remote.calls.every((args) => args[0] === "api" && !args.includes("POST"))).toBe(true);
	});
	for (const path of [
		"remote-peer/peer.go",
		"remote-peer/internal/buildinfo/buildinfo.go",
		"remote-peer/payload.bin",
		"remote-peer/go.mod",
		"remote-peer/go.sum",
		"licenses/extra/remote-peer-LICENSES.txt",
		...REMOTE_PEER_INPUT_RECIPE_PATHS,
	])
		test(`requires bump before compiling when public pin input changes: ${path}`, async () => {
			const fixture = sourceFixture();
			const remote = publishedFixture(true);
			fixture.current[path] += "\nchanged production input";
			await expect(
				prepareRemotePeerRelease({
					root: ".",
					commit,
					repository,
					source: fixture.source,
					run: remote.run,
				}),
			).rejects.toThrow("bump");
		});
	test("pin version itself is excluded, but wire mismatches fail", async () => {
		const fixture = sourceFixture();
		const before = await fingerprintRemotePeerInputs({
			commit,
			source: fixture.source,
			protocolVersion: 1,
		});
		fixture.current["shared/component-versions.json"] =
			'{"remotePeer":{"version":"99.0.0","protocolVersion":1}}';
		expect(
			await fingerprintRemotePeerInputs({ commit, source: fixture.source, protocolVersion: 1 }),
		).toBe(before);
		fixture.current["remote-peer/protocol.go"] = "package peer\nconst ProtocolVersion = 2\n";
		await expect(
			fingerprintRemotePeerInputs({ commit, source: fixture.source, protocolVersion: 1 }),
		).rejects.toThrow("wire protocol");
	});
	test("binary embed inputs retain exact bytes rather than UTF-8 replacement", async () => {
		const fixture = sourceFixture();
		let payload = new Uint8Array([0xff, 0]);
		const source = {
			...fixture.source,
			async readBytes(sha: string, path: string) {
				return path.endsWith("payload.bin")
					? payload
					: Buffer.from(await fixture.source.read(sha, path));
			},
		};
		const before = await fingerprintRemotePeerInputs({ commit, source, protocolVersion: 1 });
		payload = new Uint8Array([0xfe, 0]);
		expect(await fingerprintRemotePeerInputs({ commit, source, protocolVersion: 1 })).not.toBe(
			before,
		);
	});
	test("directory globs include every nested embedded production file", async () => {
		const fixture = sourceFixture();
		fixture.current["remote-peer/peer.go"] = fixture.current["remote-peer/peer.go"]?.replace(
			"payload.bin",
			"assets/*",
		) as string;
		fixture.current["remote-peer/assets/sub/nested.bin"] = "first";
		const before = await fingerprintRemotePeerInputs({
			commit,
			source: fixture.source,
			protocolVersion: 1,
		});
		fixture.current["remote-peer/assets/sub/nested.bin"] = "second";
		expect(
			await fingerprintRemotePeerInputs({ commit, source: fixture.source, protocolVersion: 1 }),
		).not.toBe(before);
	});
	test("conflicting pre-existing tags, network failures and unsupported local module replacements fail closed", async () => {
		const fixture = sourceFixture();
		const remote = publishedFixture(false);
		remote.state.tagged = previous;
		await expect(
			prepareRemotePeerRelease({
				root: ".",
				commit,
				repository,
				source: fixture.source,
				run: remote.run,
			}),
		).rejects.toThrow("different source");
		await expect(
			prepareRemotePeerRelease({
				root: ".",
				commit,
				repository,
				source: fixture.source,
				run: async () => {
					throw new Error("HTTP 503");
				},
			}),
		).rejects.toThrow("503");
		fixture.current["remote-peer/go.mod"] += "replace example.com/production => ../unknown\n";
		await expect(
			fingerprintRemotePeerInputs({ commit, source: fixture.source, protocolVersion: 1 }),
		).rejects.toThrow("replacements");
	});
	test("restoration keeps original peer source, inputs and run through multiple retries", () => {
		const original = plan(building);
		const restored = restoreRemotePeerReleasePlan(building, original);
		expect(restored).toEqual({
			...building,
			action: "restore",
			buildSource: { runId: 123, runAttempt: 2, workflowCommit },
		});
		expect(
			restoreRemotePeerReleasePlan(restored, {
				runId: 999,
				runAttempt: 8,
				workflowCommit: previous,
			}),
		).toEqual(restored);
		expect(mainPeerArtifactName(plan(restored as RemotePeerReleasePlan))).toBe(
			`release-peer-bundle-${commit}-123-2`,
		);
		expect(() => validateCiReleasePlan(plan({ ...building, sourceCommit: previous }))).toThrow(
			"NF source",
		);
	});
});

function proofFixture() {
	const p = plan(building);
	const source = {
		id: p.runId,
		run_attempt: p.runAttempt,
		path: ".github/workflows/release.yml",
		event: "workflow_dispatch",
		status: "completed",
		head_sha: workflowCommit,
		head_branch: "main",
		repository: { id: 8, full_name: repository },
		head_repository: { id: 8, full_name: repository },
	};
	const jobs = REQUIRED_MAIN_PEER_JOBS.map((name) => ({
		name,
		conclusion: "success",
		status: "completed",
		run_id: p.runId,
		run_attempt: p.runAttempt,
		head_sha: workflowCommit,
		labels: REMOTE_PEER_NATIVE_CONTRACT.filter(
			({ platform }) => name === `Peer Native Smoke (${platform})`,
		).map(({ runner }) => runner),
	}));
	const artifact = {
		id: 321,
		name: mainPeerArtifactName(p),
		expired: false,
		size_in_bytes: 1024,
		digest: `sha256:${"e".repeat(64)}`,
		workflow_run: {
			id: p.runId,
			repository_id: 8,
			head_repository_id: 8,
			head_sha: workflowCommit,
			head_branch: "main",
		},
	};
	return { p, source, jobs, artifact };
}
describe("main peer native proof never broadens legacy auxiliary provenance", () => {
	test("accepts only complete six-native proof from the exact main build attempt", () => {
		const { p, source, jobs, artifact } = proofFixture();
		expect(validateMainPeerSource(p, source, jobs, artifact).id).toBe(321);
		expect(() =>
			validateMainPeerSource(
				p,
				source,
				jobs.map((job) =>
					job.name.startsWith("Peer Native Smoke")
						? { ...job, labels: ["wrong-native-runner"] }
						: job,
				),
				artifact,
			),
		).toThrow("native peer proof");
		for (const job of jobs)
			expect(() =>
				validateMainPeerSource(
					p,
					source,
					jobs.filter((entry) => entry !== job),
					artifact,
				),
			).toThrow("native peer proof");
		expect(() => validateMainPeerSource(p, source, [...jobs, jobs[0]], artifact)).toThrow(
			"native peer proof",
		);
		for (const path of [
			".github/workflows/remote-peer-release.yml",
			".github/workflows/helpers-release.yml",
			"arbitrary.yml",
		])
			expect(() => validateMainPeerSource(p, { ...source, path }, jobs, artifact)).toThrow(
				"Untrusted",
			);
		for (const changed of [{ run_attempt: 3 }, { head_sha: previous }, { head_branch: "other" }])
			expect(() => validateMainPeerSource(p, { ...source, ...changed }, jobs, artifact)).toThrow(
				"Untrusted",
			);
		for (const changed of [
			{ name: "arbitrary-bundle" },
			{ expired: true },
			{ digest: "not-sha256" },
			{ size_in_bytes: 1024 ** 3 },
		])
			expect(() => validateMainPeerSource(p, source, jobs, { ...artifact, ...changed })).toThrow(
				"artifact provenance",
			);
	});
	test("gate rejects any failed/skipped peer native job and no-op/index diagnostics need none", () => {
		const base = {
			PREFLIGHT_RESULT: "success",
			RESTORE_MODE: "false",
			PUBLISH_REQUESTED: "false",
			VERIFY_RESULT: "success",
			BUILD_RESULT: "success",
			SMOKE_RESULT: "success",
			ASSEMBLE_RESULT: "success",
			RESTORE_RESULT: "skipped",
			PUBLISH_RESULT: "skipped",
		};
		const peer = {
			PEER_ACTION: "build",
			PEER_BUILD_RESULT: "success",
			PEER_SMOKE_RESULT: "success",
			PEER_ASSEMBLE_RESULT: "success",
			PEER_RESTORE_RESULT: "skipped",
		};
		expect(() => assertReleaseGate({ ...base, ...peer })).not.toThrow();
		for (const key of ["PEER_BUILD_RESULT", "PEER_SMOKE_RESULT", "PEER_ASSEMBLE_RESULT"])
			expect(() => assertReleaseGate({ ...base, ...peer, [key]: "skipped" })).toThrow("peer");
		expect(() =>
			assertReleaseGate({
				...base,
				...peer,
				PEER_ACTION: "absent",
				PEER_BUILD_RESULT: "skipped",
				PEER_SMOKE_RESULT: "skipped",
				PEER_ASSEMBLE_RESULT: "skipped",
			}),
		).not.toThrow();
	});
	test("main workflow actually wires frozen peer commands and one protected publisher", async () => {
		const workflow = await readFile(".github/workflows/release.yml", "utf8");
		for (const job of ["peer-build:", "peer-smoke:", "peer-assemble:", "peer-restore:"])
			expect(workflow).toContain(job);
		expect(workflow.match(/environment: release/g)).toHaveLength(1);
		expect(workflow).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Exact GitHub Actions expression.
			"remote-peer-publication-receipt-${{ github.run_id }}-${{ github.run_attempt }}",
		);
		expect(workflow).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Exact GitHub Actions expression.
			"run-name: Release ${{ inputs.tag }} (${{ inputs.publish && 'publish' || 'verify' }})",
		);
		for (const command of ["peer-build", "peer-smoke", "peer-assemble", "peer-restore"])
			expect(parseCiReleaseArgs([command, "--plan=frozen.json", "--output=peer"]).command).toBe(
				command,
			);
		const control = await readFile("scripts/ci-release.ts", "utf8");
		expect(control.indexOf("await publishMainReleasePeer(")).toBeLessThan(
			control.indexOf('"core.publish.github"'),
		);
		expect(control).toContain('indexOnly === "true" || recovery.smokeTarget');
	});
});

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function publisherFixture() {
	const directory = await mkdtemp(join(process.cwd(), ".narrafork/main-peer-publisher-"));
	temporary.push(directory);
	const proof = proofFixture();
	const files: Record<string, string> = {};
	for (const platform of REMOTE_PEER_PLATFORMS)
		files[remotePeerPublishedFilename(version, platform)] = platform;
	for (const name of REMOTE_PEER_LICENSE_FILES) files[name] = "real license fixture";
	const identity = (name: string) => ({
		name,
		size: Buffer.byteLength(files[name] as string),
		sha256: hash(files[name] as string),
	});
	const manifest = {
		schemaVersion: 1,
		repository,
		tag,
		commit,
		manifest: {
			version,
			protocolVersion: 1,
			releasedAt: "1970-01-01T00:00:00Z",
			platforms: Object.fromEntries(
				REMOTE_PEER_PLATFORMS.map((platform) => [
					platform,
					{
						filename: remotePeerPublishedFilename(version, platform),
						size: platform.length,
						sha256: hash(platform),
					},
				]),
			),
		},
		licenses: REMOTE_PEER_LICENSE_FILES.map(identity),
	};
	files[REMOTE_PEER_MANIFEST_FILENAME] = `${JSON.stringify(manifest)}\n`;
	const assets = Object.keys(files).map((name, index) => ({
		...identity(name),
		id: index + 1,
		state: "uploaded",
		digest: `sha256:${identity(name).sha256}`,
	}));
	const archive = execFileSync(
		"python3",
		[
			"-I",
			"-c",
			"import io,json,sys,zipfile\nf=io.BytesIO()\nwith zipfile.ZipFile(f,'w',zipfile.ZIP_DEFLATED) as z:\n for n,s in json.load(sys.stdin).items(): z.writestr(n,s)\nsys.stdout.buffer.write(f.getvalue())",
		],
		{ input: JSON.stringify(files), timeout: 10_000, maxBuffer: 1024 * 1024 },
	);
	proof.artifact.size_in_bytes = archive.length;
	proof.artifact.digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
	const release = {
		id: 67,
		tag_name: tag,
		draft: true,
		prerelease: true,
		assets: [] as typeof assets,
	};
	const state = {
		tagged: undefined as string | undefined,
		created: false,
		failUpload: false,
		corruptArchive: false,
	};
	const calls: string[][] = [];
	const contents = (value: unknown) => {
		const bytes = Buffer.from(JSON.stringify(value));
		return JSON.stringify({
			type: "file",
			encoding: "base64",
			size: bytes.length,
			content: bytes.toString("base64"),
		});
	};
	const missing = () => {
		throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });
	};
	const run = async (args: string[]) => {
		calls.push(args);
		const path = (args[1] ?? "").replace(`repos/${repository}/`, "");
		if (args[0] === "api") {
			if (path === `actions/runs/123/attempts/2`) return JSON.stringify(proof.source);
			if (path.startsWith("actions/runs/123/attempts/2/jobs"))
				return JSON.stringify({ total_count: proof.jobs.length, jobs: proof.jobs });
			if (path.startsWith("actions/runs/123/artifacts"))
				return JSON.stringify({ total_count: 1, artifacts: [proof.artifact] });
			if (path === "actions/artifacts/321") return JSON.stringify(proof.artifact);
			if (path === `repos/${repository}`)
				return JSON.stringify({ full_name: repository, default_branch: "main" });
			if (path === "git/ref/tags/v1.2.0")
				return JSON.stringify({ object: { type: "commit", sha: commit } });
			if (path === `git/ref/tags/${tag}`)
				return state.tagged
					? JSON.stringify({ object: { type: "commit", sha: state.tagged } })
					: missing();
			if (path === "git/refs" && args.includes("POST")) {
				expect(args).toContain(`ref=refs/tags/${tag}`);
				expect(args).toContain(`sha=${commit}`);
				state.tagged = commit;
				return "{}";
			}
			if (path === "git/ref/heads/main")
				return JSON.stringify({ object: { type: "commit", sha: workflowCommit } });
			if (path.startsWith("compare/"))
				return JSON.stringify({ status: "ahead", merge_base_commit: { sha: path.slice(8, 48) } });
			if (path === `contents/shared/remote-access/frontend-capability.json?ref=${commit}`)
				throw new Error("HTTP 404");
			if (path === `contents/package.json?ref=${commit}`)
				return contents({ version: "1.2.0", packageManager: "bun@1.4.3" });
			if (path === `contents/changelogs/v1.2.0.json?ref=${commit}`)
				return contents(proof.p.changelog);
			if (path === `contents/scripts/lib/ci-release-types.ts?ref=${commit}`)
				return JSON.stringify({ type: "file", size: 100 });
			if (path === `git/trees/${commit}`) return JSON.stringify({ truncated: false, tree: [] });
			if (path === "environments/release")
				return JSON.stringify({
					name: "release",
					protection_rules: [
						{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
					],
					deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
				});
			if (path.startsWith("environments/release/deployment-branch-policies"))
				return JSON.stringify({
					total_count: 1,
					branch_policies: [{ name: "main", type: "branch" }],
				});
			if (path.startsWith("releases/assets/"))
				return files[REMOTE_PEER_MANIFEST_FILENAME] as string;
			if (path.startsWith("releases?")) return "[]";
			if (path === `releases/tags/${tag}` || path === "releases/67")
				return state.created ? JSON.stringify(release) : missing();
		}
		if (args[0] === "release") {
			if (args[1] === "create") {
				state.created = true;
				return "";
			}
			if (args[1] === "upload") {
				if (state.failUpload) throw new Error("simulated component upload failure");
				const name = args[3]?.split(/[\\/]/).at(-1);
				const asset = assets.find((entry) => entry.name === name);
				if (!asset) throw new Error("Unknown simulated upload");
				release.assets.push(asset);
				return "";
			}
			if (args[1] === "edit") {
				release.draft = false;
				return "";
			}
		}
		throw new Error(`Unexpected simulated API ${args.join(" ")}`);
	};
	const environment = {
		GITHUB_REPOSITORY: repository,
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REF: "refs/heads/main",
		GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/main`,
		GITHUB_WORKFLOW_SHA: workflowCommit,
		GITHUB_SHA: workflowCommit,
		GITHUB_RUN_ID: "456",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_JOB: "publish",
		PUBLISH_REQUESTED: "true",
		GH_TOKEN: "fixture-only",
	};
	const fetcher = (async () =>
		new Response(
			state.corruptArchive ? Buffer.from("damaged") : archive,
		)) as unknown as typeof fetch;
	return {
		proof,
		state,
		calls,
		release,
		options: {
			root: process.cwd(),
			plan: proof.p,
			run,
			output: join(directory, "bundle"),
			receiptPath: join(directory, "peer-receipt.json"),
			env: environment,
			fetch: fetcher,
		},
		directory,
	};
}

describe("approved main publisher composes peer restore, immutable tag creation and publication", () => {
	test("restores exact archive, creates missing tag, publishes peer and writes its separate main-workflow receipt", async () => {
		const fixture = await publisherFixture();
		await publishMainReleasePeer(fixture.options);
		expect(fixture.release.draft).toBe(false);
		expect(fixture.state.tagged).toBe(commit);
		expect(fixture.calls.filter((args) => args.includes("POST"))).toHaveLength(1);
		expect(fixture.calls.filter((args) => args[1] === "upload")).toHaveLength(8);
		expect(
			fixture.calls.some((args) => args.includes("--clobber") || args.includes("--force")),
		).toBe(false);
		const receipt = JSON.parse(await readFile(fixture.options.receiptPath, "utf8"));
		expect(receipt).toMatchObject({
			kind: "remote-peer",
			commit,
			source: { runId: 456, workflowPath: ".github/workflows/release.yml" },
			buildSource: {
				runId: 123,
				runAttempt: 2,
				bundleArtifactId: 321,
				workflowPath: ".github/workflows/release.yml",
			},
		});
		// Simulate NF failing after peer success. A later publisher restores the same peer bytes,
		// verifies the already-public release, and never republishes or overwrites any asset.
		const writes = fixture.calls.filter(
			(args) => args[0] === "release" || args.includes("POST"),
		).length;
		await publishMainReleasePeer({
			...fixture.options,
			output: join(fixture.directory, "retry-bundle"),
			receiptPath: join(fixture.directory, "retry-receipt.json"),
			env: { ...fixture.options.env, GITHUB_RUN_ID: "457" },
		});
		expect(
			fixture.calls.filter((args) => args[0] === "release" || args.includes("POST")),
		).toHaveLength(writes);
	});
	test("corrupt archive and missing native proof fail before creating even a component tag", async () => {
		const fixture = await publisherFixture();
		fixture.state.corruptArchive = true;
		await expect(publishMainReleasePeer(fixture.options)).rejects.toThrow();
		expect(fixture.calls.every((args) => args[0] === "api" && !args.includes("POST"))).toBe(true);
		fixture.state.corruptArchive = false;
		fixture.proof.jobs.pop();
		await expect(publishMainReleasePeer(fixture.options)).rejects.toThrow("native peer proof");
		expect(fixture.state.tagged).toBeUndefined();
	});
	test("upload failure preserves the draft, does not qualify NF, and retry uploads only missing exact assets", async () => {
		const fixture = await publisherFixture();
		fixture.state.failUpload = true;
		await expect(publishMainReleasePeer(fixture.options)).rejects.toThrow("upload failure");
		expect(fixture.release.draft).toBe(true);
		expect(fixture.calls.some((args) => args[1] === "edit")).toBe(false);
		fixture.state.failUpload = false;
		await publishMainReleasePeer({
			...fixture.options,
			output: join(fixture.directory, "retry-bundle"),
		});
		expect(fixture.release.draft).toBe(false);
		expect(fixture.calls.filter((args) => args.includes("POST"))).toHaveLength(1);
	});
	test.skipIf(process.platform === "win32")(
		"real bounded gh subprocess Not Found allows the main publisher to create only its frozen missing tag",
		async () => {
			const fixture = await publisherFixture();
			const shim = join(fixture.directory, "gh");
			await writeFile(
				shim,
				`#!${process.execPath}\nprocess.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exitCode = 1;\n`,
			);
			await chmod(shim, 0o755);
			const realMissing = createPublicationGhRunner(new AbortController().signal, {
				...fixture.options.env,
				PATH: fixture.directory,
			});
			let typedMissing = 0;
			const run = async (args: string[]) => {
				const path = args[1] ?? "";
				if (
					(path === `repos/${repository}/git/ref/tags/${tag}` && !fixture.state.tagged) ||
					(path === `repos/${repository}/releases/tags/${tag}` && !fixture.state.created)
				) {
					try {
						return await realMissing(args);
					} catch (error) {
						expect(error).toBeInstanceOf(PublicationGhApiError);
						expect(isMissingPeerRemote(error)).toBe(true);
						typedMissing++;
						throw error;
					}
				}
				return fixture.options.run(args);
			};
			await publishMainReleasePeer({ ...fixture.options, run });
			expect(typedMissing).toBeGreaterThanOrEqual(2);
			expect(fixture.calls.filter((args) => args.includes("POST"))).toHaveLength(1);
			expect(fixture.release.draft).toBe(false);
		},
	);
	for (const diagnostic of [
		"gh: Forbidden (HTTP 403)\n",
		"gh: Too Many Requests (HTTP 429)\n",
		"not-authoritative (HTTP 404)\n",
		"gh: Not Found (HTTP 404)\ngh: Forbidden (HTTP 403)\n",
		"gh: upstream said HTTP 404 (HTTP 404)\n",
	])
		test.skipIf(process.platform === "win32")(
			`real subprocess failure is not tag absence: ${diagnostic.trim()}`,
			async () => {
				const fixture = await publisherFixture();
				const shim = join(fixture.directory, "gh");
				await writeFile(
					shim,
					`#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;\n`,
				);
				await chmod(shim, 0o755);
				const runner = createPublicationGhRunner(new AbortController().signal, {
					...fixture.options.env,
					PATH: fixture.directory,
				});
				const error = await Promise.resolve(
					runner(["api", `repos/${repository}/git/ref/tags/${tag}`]),
				).then(
					() => {
						throw new Error("Expected failure");
					},
					(error: unknown) => error,
				);
				expect(isMissingPeerRemote(error)).toBe(false);
				await expect(
					publishMainReleasePeer({
						...fixture.options,
						run: async (args) =>
							args[1] === `repos/${repository}/git/ref/tags/${tag}`
								? Promise.reject(error)
								: fixture.options.run(args),
					}),
				).rejects.toThrow();
				expect(fixture.calls.some((args) => args.includes("POST") || args[0] === "release")).toBe(
					false,
				);
			},
		);
	test.skipIf(process.platform === "win32")(
		"a subprocess timeout and untyped status property do not authorize tag creation",
		async () => {
			const fixture = await publisherFixture();
			const shim = join(fixture.directory, "gh");
			await writeFile(
				shim,
				`#!${process.execPath}\nprocess.stderr.write("gh: Not Found (HTTP 404)\\n"); setInterval(() => {}, 1000);\n`,
			);
			await chmod(shim, 0o755);
			const error = await runPublicationProcess(
				"gh",
				["api", `repos/${repository}/git/ref/tags/${tag}`],
				{
					environment: { ...fixture.options.env, PATH: fixture.directory },
					timeoutMs: 50,
					maximumOutputBytes: 8192,
				},
			).then(
				() => {
					throw new Error("Expected timeout");
				},
				(error: unknown) => error,
			);
			expect(isMissingPeerRemote(error)).toBe(false);
			expect(
				isMissingPeerRemote(
					Object.assign(new Error("untrusted response body HTTP 404"), { status: 404 }),
				),
			).toBe(false);
		},
	);
	test("other jobs/workflows and a moved component tag never acquire main peer publication authority", async () => {
		const fixture = await publisherFixture();
		await expect(
			publishMainReleasePeer({
				...fixture.options,
				env: { ...fixture.options.env, GITHUB_JOB: "build" },
			}),
		).rejects.toThrow("fixed approved");
		await expect(
			publishMainReleasePeer({
				...fixture.options,
				env: {
					...fixture.options.env,
					GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/remote-peer-release.yml@refs/heads/main`,
				},
			}),
		).rejects.toThrow("workflow_dispatch");
		expect(fixture.calls).toHaveLength(0);
		fixture.state.tagged = previous;
		await expect(publishMainReleasePeer(fixture.options)).rejects.toThrow("never force");
		expect(fixture.calls.some((args) => args.includes("POST") || args[0] === "release")).toBe(
			false,
		);
	});
});
