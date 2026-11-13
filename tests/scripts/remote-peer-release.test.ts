import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	publishHelperRelease,
	validateHelperReleaseBundle,
} from "../../scripts/lib/helper-release";
import {
	assembleHelperReleaseBundle,
	type HelperReleasePlan,
	planHelperRelease,
	publishHelperReleasePlan,
	validateHelperBundleArtifact,
	validateHelperSourceJobs,
	validateHelperSourceRun,
} from "../../scripts/lib/helper-release-control";
import { writePublicationReceipt } from "../../scripts/lib/publication-receipt";
import {
	compareRemotePeerRecipeIdentity,
	REMOTE_PEER_RECIPE_PATHS,
} from "../../scripts/lib/remote-peer-release-inputs";
import { parseHelperReleaseArguments } from "../../scripts/release-helpers";
import {
	REMOTE_PEER_LICENSE_FILES,
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PLATFORMS,
	remotePeerPublishedFilename,
} from "../../shared/remote-peer";

const commit = "a".repeat(40);
const controlCommit = "b".repeat(40);
const repository = "ForkOwner/peer-fork";
const version = "0.1.0-alpha.1";
const plan: HelperReleasePlan = {
	schemaVersion: 1,
	repository,
	defaultBranch: "main",
	tag: `remote-peer-v${version}`,
	commit,
	controlCommit,
	kind: "remote-peer",
	version,
	protocolVersion: 1,
	sourceRunId: "123",
	publish: false,
};
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const file = (name: string, raw: string) => ({
	name,
	size: Buffer.byteLength(raw),
	sha256: hash(raw),
});
const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
	const path = await mkdtemp(join(process.cwd(), ".narrafork/peer-release-test-"));
	temporary.push(path);
	return path;
}
async function bundle() {
	const path = await temp();
	const manifest = {
		schemaVersion: 1,
		repository,
		tag: plan.tag,
		commit,
		manifest: {
			version,
			protocolVersion: 1,
			releasedAt: "1970-01-01T00:00:00Z",
			platforms: Object.fromEntries(
				REMOTE_PEER_PLATFORMS.map((platform) => {
					const name = remotePeerPublishedFilename(version, platform);
					return [platform, { filename: name, size: platform.length, sha256: hash(platform) }];
				}),
			),
		},
		licenses: REMOTE_PEER_LICENSE_FILES.map((name) => file(name, "real license fixture")),
	};
	for (const platform of REMOTE_PEER_PLATFORMS)
		await writeFile(join(path, remotePeerPublishedFilename(version, platform)), platform);
	for (const license of manifest.licenses)
		await writeFile(join(path, license.name), "real license fixture");
	const raw = `${JSON.stringify(manifest)}\n`;
	await writeFile(join(path, REMOTE_PEER_MANIFEST_FILENAME), raw);
	return { path, manifest, raw, options: { ...plan, bundleDir: path } };
}
function planningFixture() {
	const calls: string[][] = [];
	const state = { pin: version, protocol: 1, wire: 1, recipeChange: false };
	const environment = {
		GITHUB_REPOSITORY: repository,
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REF: "refs/heads/main",
		GITHUB_SHA: controlCommit,
	};
	const git = (_root: string, args: string[]) => {
		if (args[0] === "rev-parse") return commit;
		if (args[0] === "merge-base") return "";
		if (args[1] === `${commit}:remote-peer/protocol.go`)
			return `const ProtocolVersion = ${state.wire}`;
		if (args[1] === `${commit}:shared/component-versions.json`)
			return JSON.stringify({
				executor: { version: "0.9.1", protocolVersion: 1 },
				remotePeer: { version: state.pin, protocolVersion: state.protocol },
			});
		if (args[0] === "show") {
			const [sha, path] = (args[1] ?? "").split(":");
			if (REMOTE_PEER_RECIPE_PATHS.includes(path as (typeof REMOTE_PEER_RECIPE_PATHS)[number]))
				return state.recipeChange && sha === controlCommit
					? "changed independent recipe"
					: `same ${path}`;
		}
		throw new Error("Unexpected source read");
	};
	const run = async (args: string[]) => {
		calls.push(args);
		if (args[1] === `repos/${repository}`)
			return JSON.stringify({ full_name: repository, default_branch: "main" });
		if (args[1]?.includes("/git/ref/tags/"))
			return JSON.stringify({ object: { type: "commit", sha: commit } });
		if (args[1]?.includes("/git/ref/heads/"))
			return JSON.stringify({ object: { type: "commit", sha: controlCommit } });
		if (args[1]?.includes("/compare/"))
			return JSON.stringify({ status: "ahead", merge_base_commit: { sha: commit } });
		throw new Error("Unexpected remote operation");
	};
	return { state, calls, options: { git, run, environment } };
}
describe("independent peer plan and recipe", () => {
	test("freezes tag pin and wire protocol, never requires an Environment for default build-only", async () => {
		const fixture = planningFixture();
		const actual = await planHelperRelease(".", "remote-peer", plan.tag, "", fixture.options);
		expect(actual).toEqual({ ...plan, sourceRunId: "" });
		expect(fixture.calls.every((args) => args[0] === "api")).toBe(true);
		await expect(
			publishHelperReleasePlan(actual, "not-read", false, fixture.options),
		).rejects.toThrow("Build-only");
	});
	for (const mode of ["pin", "protocol", "wire", "recipe"])
		test(`rejects source ${mode} mismatch before building`, async () => {
			const fixture = planningFixture();
			if (mode === "pin") fixture.state.pin = "0.2.0";
			if (mode === "protocol") fixture.state.protocol = 2;
			if (mode === "wire") fixture.state.wire = 2;
			if (mode === "recipe") fixture.state.recipeChange = true;
			await expect(
				planHelperRelease(".", "remote-peer", plan.tag, "", fixture.options),
			).rejects.toThrow();
		});
	test("historical peer restore keeps original bundle recipe, not today's controller recipe", async () => {
		const fixture = planningFixture();
		fixture.state.recipeChange = true;
		expect(
			(await planHelperRelease(".", "remote-peer", plan.tag, "123", fixture.options)).sourceRunId,
		).toBe("123");
	});
	test("CLI explicitly accepts peer only with its own tag and Go platform", () => {
		expect(
			parseHelperReleaseArguments([
				"preflight",
				"--kind=remote-peer",
				`--tag=${plan.tag}`,
			]).options.has("publish"),
		).toBe(false);
		expect(parseHelperReleaseArguments(["build", "--platform=linux-amd64"]).command).toBe("build");
		expect(() =>
			parseHelperReleaseArguments([
				"preflight",
				"--kind=remote-peer",
				"--tag=executor-v0.1.0-alpha.1",
			]),
		).toThrow();
	});
	for (const path of REMOTE_PEER_RECIPE_PATHS)
		test(`rejects trusted control drift in ${path}`, async () => {
			await expect(
				compareRemotePeerRecipeIdentity({
					commit,
					controlCommit,
					readSource: (sha, current) =>
						sha === controlCommit && current === path ? "changed" : "same",
				}),
			).rejects.toThrow("differs");
		});
	test("recipe reads reject cancellation, expired deadlines, missing and oversized evidence", async () => {
		for (const options of [
			{ signal: AbortSignal.abort(new Error("cancelled")), readSource: () => "same" },
			{ deadline: Date.now() - 1, readSource: () => "same" },
			{
				readSource: () => {
					throw new Error("missing source");
				},
			},
			{ readSource: () => "x".repeat(2 * 1024 * 1024 + 1) },
		])
			await expect(
				compareRemotePeerRecipeIdentity({ commit, controlCommit, ...options }),
			).rejects.toThrow();
	});
});

describe("peer immutable bundle provenance", () => {
	const source = () => ({
		id: 123,
		status: "completed",
		event: "workflow_dispatch",
		head_repository: { full_name: repository },
		path: ".github/workflows/remote-peer-release.yml",
		head_branch: "main",
		head_sha: controlCommit,
		run_attempt: 1,
	});
	test("only fixed peer workflow and all six native Go-platform jobs prove peer builds", () => {
		const run = validateHelperSourceRun(plan, source());
		const names = [
			"Remote peer preflight",
			"Assemble exact remote peer bundle",
			...REMOTE_PEER_PLATFORMS.flatMap((platform) => [
				`Build (${platform})`,
				`Native smoke (${platform})`,
			]),
		];
		const jobs = names.map((name) => ({
			name,
			conclusion: "success",
			run_id: 123,
			head_sha: controlCommit,
		}));
		expect(() => validateHelperSourceJobs({ total_count: jobs.length, jobs }, run)).not.toThrow();
		const native = jobs[2];
		if (!native) throw new Error("Missing fixture native job");
		native.conclusion = "skipped";
		expect(() => validateHelperSourceJobs({ total_count: jobs.length, jobs }, run)).toThrow();
		for (const path of [
			".github/workflows/helpers-release.yml",
			".github/workflows/other.yml",
			"remote-peer-release.yml",
		])
			expect(() => validateHelperSourceRun(plan, { ...source(), path })).toThrow();
		expect(() => validateHelperSourceRun({ ...plan, kind: "executor" }, source())).toThrow();
	});
	test("restore binds kind, commit, source run and exact immutable artifact digest", () => {
		const artifact = {
			id: 42,
			name: `helper-bundle-remote-peer-${commit}`,
			expired: false,
			size_in_bytes: 128,
			digest: `sha256:${"a".repeat(64)}`,
			workflow_run: { id: 123 },
		};
		expect(validateHelperBundleArtifact(plan, { total_count: 1, artifacts: [artifact] }).id).toBe(
			42,
		);
		for (const changed of [
			{ name: `helper-bundle-executor-${commit}` },
			{ digest: "" },
			{ expired: true },
			{ workflow_run: { id: 789 } },
		])
			expect(() =>
				validateHelperBundleArtifact(plan, {
					total_count: 1,
					artifacts: [{ ...artifact, ...changed }],
				}),
			).toThrow();
	});
	test("assembly requires native per-platform digests and real license attachment", async () => {
		const f = await bundle();
		const native = join(await temp(), "native");
		await mkdir(native);
		for (const platform of REMOTE_PEER_PLATFORMS) {
			const directory = join(native, `helper-native-${platform}`);
			await mkdir(directory);
			const name = remotePeerPublishedFilename(version, platform);
			await writeFile(join(directory, name), platform);
			await writeFile(
				join(directory, "receipt.json"),
				JSON.stringify({
					schemaVersion: 1,
					kind: plan.kind,
					commit,
					platform,
					version,
					protocolVersion: 1,
					files: [file(name, platform)],
				}),
			);
		}
		const root = await temp();
		await mkdir(join(root, "licenses", "extra"), { recursive: true });
		const output = join(await temp(), "bundle");
		await expect(assembleHelperReleaseBundle(root, plan, native, output)).rejects.toThrow();
		await rm(output, { recursive: true, force: true });
		await writeFile(
			join(root, "licenses", "extra", REMOTE_PEER_LICENSE_FILES[0]),
			"real license fixture",
		);
		await assembleHelperReleaseBundle(root, plan, native, output);
		expect(
			(await validateHelperReleaseBundle({ ...f.options, bundleDir: output })).files,
		).toHaveLength(8);
	});
});

describe("peer publisher retains immutable protected auxiliary semantics", () => {
	test("preview and dry-run have zero remote queries or writes and require all licenses", async () => {
		const f = await bundle();
		let calls = 0;
		const run = async () => {
			calls++;
			throw new Error("Network forbidden");
		};
		await publishHelperRelease({ ...f.options, dryRun: true, run });
		await publishHelperReleasePlan(plan, f.path, true, { run });
		expect(calls).toBe(0);
		await rm(join(f.path, REMOTE_PEER_LICENSE_FILES[0]));
		await expect(publishHelperRelease({ ...f.options, dryRun: true, run })).rejects.toThrow();
		expect(calls).toBe(0);
	});
	test("unknown local file and damaged binary fail before touching GitHub", async () => {
		const f = await bundle();
		await writeFile(join(f.path, "unknown.txt"), "extra");
		await expect(validateHelperReleaseBundle(f.options)).rejects.toThrow("exact");
		await rm(join(f.path, "unknown.txt"));
		await writeFile(join(f.path, remotePeerPublishedFilename(version, "linux-amd64")), "bad");
		await expect(validateHelperReleaseBundle(f.options)).rejects.toThrow("mismatch");
	});
	for (const mode of ["existing-draft", "new-release"])
		test(`publishes alpha without latest and only uploads missing immutable files: ${mode}`, async () => {
			const f = await bundle();
			const description = await validateHelperReleaseBundle(f.options);
			const assets = description.files.map((file, index) => ({
				id: index + 1,
				name: file.name,
				size: file.size,
				state: "uploaded",
				digest: `sha256:${file.sha256}`,
			}));
			const release = {
				id: 50,
				tag_name: plan.tag,
				draft: true,
				prerelease: true,
				assets: assets.slice(0, mode === "existing-draft" ? 2 : 0),
			};
			let created = mode === "existing-draft";
			const calls: string[][] = [];
			const run = async (args: string[]) => {
				calls.push(args);
				if (args[0] === "api") {
					if (args[1]?.includes("/git/ref/tags/"))
						return JSON.stringify({ object: { type: "commit", sha: commit } });
					if (args[1]?.includes("/releases/assets/")) return f.raw;
					if (args[1]?.includes("/releases?")) return "[]";
					if (!created) throw new Error("HTTP 404");
					return JSON.stringify(release);
				}
				if (args[1] === "create") {
					expect(args).toContain("--draft");
					expect(args).toContain("--prerelease");
					expect(args).toContain("--latest=false");
					created = true;
					return "";
				}
				if (args[1] === "upload") {
					const name = args[3]?.split(/[\\/]/).at(-1);
					const asset = assets.find((asset) => asset.name === name);
					if (!asset) throw new Error("Unknown upload");
					release.assets.push(asset);
					return "";
				}
				if (args[1] === "edit") {
					release.draft = false;
					return "";
				}
				throw new Error("Unexpected remote write");
			};
			await publishHelperRelease({ ...f.options, run });
			expect(calls.filter((args) => args[1] === "upload")).toHaveLength(
				mode === "existing-draft" ? 6 : 8,
			);
			expect(calls.some((args) => args.includes("--clobber"))).toBe(false);
			expect(calls.find((args) => args[1] === "edit")).toContain("--latest=false");
			const writes = calls.filter((args) => args[0] === "release").length;
			await expect(publishHelperRelease({ ...f.options, run })).rejects.toThrow("immutable");
			expect(calls.filter((args) => args[0] === "release").length).toBe(writes);
		});
	for (const mode of ["channel", "conflicting-asset"])
		test(`rejects ${mode} without overwriting or publishing the peer draft`, async () => {
			const f = await bundle();
			const description = await validateHelperReleaseBundle(f.options);
			const expected = description.files[0];
			if (!expected) throw new Error("Missing fixture asset");
			const calls: string[][] = [];
			const run = async (args: string[]) => {
				calls.push(args);
				if (args[0] !== "api") throw new Error("Writes forbidden");
				if (args[1]?.includes("/git/ref/tags/"))
					return JSON.stringify({ object: { type: "commit", sha: commit } });
				return JSON.stringify({
					id: 50,
					tag_name: plan.tag,
					draft: true,
					prerelease: mode !== "channel",
					assets: [{ ...expected, id: 1, state: "uploaded", digest: `sha256:${"b".repeat(64)}` }],
				});
			};
			await expect(publishHelperRelease({ ...f.options, run })).rejects.toThrow();
			expect(calls.every((args) => args[0] === "api")).toBe(true);
		});
	test("publication receipt binds independent workflow, original build and current publisher", async () => {
		const f = await bundle();
		const description = await validateHelperReleaseBundle(f.options);
		const source = {
			runId: 456,
			runAttempt: 2,
			workflowPath: ".github/workflows/remote-peer-release.yml",
			nativeProof: "verified-original-bundle" as const,
		};
		const options = {
			...plan,
			expectedAssets: description.files,
			source,
			buildSource: { ...source, runId: 123, runAttempt: 1, bundleArtifactId: 42 },
			path: join(await temp(), "receipt.json"),
			run: async () =>
				JSON.stringify({
					id: 20,
					tag_name: plan.tag,
					draft: false,
					assets: description.files.map((file, index) => ({
						id: index + 1,
						...file,
						state: "uploaded",
						digest: `sha256:${file.sha256}`,
					})),
				}),
		};
		const receipt = await writePublicationReceipt(options);
		expect(receipt.kind).toBe("remote-peer");
		expect(receipt.source.runId).toBe(456);
		expect(receipt.buildSource?.runId).toBe(123);
		await expect(
			writePublicationReceipt({
				...options,
				source: { ...source, workflowPath: ".github/workflows/helpers-release.yml" },
			}),
		).rejects.toThrow("provenance");
		expect(JSON.parse(await readFile(options.path, "utf8")).assets).toHaveLength(8);
	});
});
