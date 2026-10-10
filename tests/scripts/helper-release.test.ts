import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GhRunner } from "../../scripts/lib/github-release";
import {
	EXECUTOR_LICENSE_FILES,
	HELPER_LICENSE_FILES,
	publishHelperRelease,
	resolveHelperTagCommit,
	validateHelperReleaseBundle,
	verifyPublishedHelperDependencies,
} from "../../scripts/lib/helper-release";
import { publishHelperReleasePlan } from "../../scripts/lib/helper-release-control";
import {
	getHelperAssetName,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
} from "../../shared/helper-distribution";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "../../shared/remote-executor";

const repository = "ForkOwner/fork-repo";
const commit = "a".repeat(40);
const version = "0.7.2";
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const byteIdentity = (name: string, content = "binary") => ({
	name,
	size: Buffer.byteLength(content),
	sha256: digest(content),
});
const makeHelper = () => ({
	schemaVersion: 1,
	repository,
	tag: HELPER_RELEASE_TAG,
	commit,
	catalogVersion: "1.0.0",
	files: HELPER_TOOLS.flatMap((tool) =>
		HELPER_PLATFORMS.map((platform) => ({
			tool,
			platform,
			toolVersion: HELPER_TOOL_VERSIONS[tool],
			...byteIdentity(getHelperAssetName(tool, platform)),
		})),
	),
	licenses: HELPER_LICENSE_FILES.map((name) => byteIdentity(name, "license")),
});
const makeExecutor = () => ({
	schemaVersion: 1,
	repository,
	tag: `executor-v${version}`,
	commit,
	manifest: {
		version,
		protocolVersion: 1,
		releasedAt: "1970-01-01T00:00:00Z",
		platforms: Object.fromEntries(
			EXECUTOR_PLATFORMS.map((platform) => {
				const file = byteIdentity(executorPublishedFilename(version, platform));
				return [platform, { filename: file.name, size: file.size, sha256: file.sha256 }];
			}),
		),
	},
	licenses: EXECUTOR_LICENSE_FILES.map((name) => byteIdentity(name, "license")),
});
type Remote = {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: { id: number; name: string; size: number; state: string; digest: string | null }[];
};
function fixture() {
	const helper = makeHelper();
	const executor = makeExecutor();
	const raws = new Map([
		[HELPER_MANIFEST_FILENAME, `${JSON.stringify(helper)}\n`],
		[EXECUTOR_MANIFEST_FILENAME, `${JSON.stringify(executor)}\n`],
	]);
	let id = 100;
	const asset = (file: { name: string; size: number; sha256: string }) => ({
		id: id++,
		name: file.name,
		size: file.size,
		state: "uploaded",
		digest: `sha256:${file.sha256}`,
	});
	const helperRelease: Remote = {
		id: 1,
		tag_name: HELPER_RELEASE_TAG,
		draft: false,
		prerelease: false,
		assets: [
			...helper.files,
			...helper.licenses,
			byteIdentity(HELPER_MANIFEST_FILENAME, raws.get(HELPER_MANIFEST_FILENAME)),
		].map(asset),
	};
	const executorRelease: Remote = {
		id: 2,
		tag_name: `executor-v${version}`,
		draft: false,
		prerelease: false,
		assets: [
			...Object.values(executor.manifest.platforms).map((entry) => ({
				name: entry.filename,
				size: entry.size,
				sha256: entry.sha256,
			})),
			...executor.licenses,
			byteIdentity(EXECUTOR_MANIFEST_FILENAME, raws.get(EXECUTOR_MANIFEST_FILENAME)),
		].map(asset),
	};
	const calls: string[][] = [];
	const run: GhRunner = (args) => {
		calls.push(args);
		if (args[0] !== "api") throw new Error("Read-only verifier attempted mutation");
		if (args[1]?.includes("/git/ref/tags/"))
			return JSON.stringify({ object: { type: "commit", sha: commit } });
		if (args[1]?.endsWith(`/tags/${HELPER_RELEASE_TAG}`)) return JSON.stringify(helperRelease);
		if (args[1]?.endsWith(`/tags/executor-v${version}`)) return JSON.stringify(executorRelease);
		const all = [...helperRelease.assets, ...executorRelease.assets];
		const found = all.find((entry) => args[1]?.endsWith(`/assets/${entry.id}`));
		if (found && raws.has(found.name)) return raws.get(found.name) as string;
		throw new Error(`Unexpected gh operation: ${args.join(" ")}`);
	};
	const options = {
		repository,
		helpersTag: HELPER_RELEASE_TAG,
		executorVersion: version,
		protocolVersion: 1,
		run,
	};
	return { helper, executor, raws, helperRelease, executorRelease, options, calls, asset };
}
function draftFixture(existing = true) {
	const f = fixture();
	f.helperRelease.draft = true;
	if (!existing) f.helperRelease.assets = [];
	const state = {
		present: existing,
		calls: [] as string[][],
		graphOverride: undefined as unknown,
		idOverride: undefined as Remote | undefined,
	};
	const graph = () => ({
		data: {
			repository: {
				nameWithOwner: repository,
				releases: {
					nodes: state.present
						? [
								{
									databaseId: f.helperRelease.id,
									tagName: HELPER_RELEASE_TAG,
									isDraft: f.helperRelease.draft,
									isPrerelease: f.helperRelease.prerelease,
									publishedAt: f.helperRelease.draft ? null : "2026-10-09T00:00:00Z",
									releaseAssets: { totalCount: f.helperRelease.assets.length },
								},
							]
						: [],
					pageInfo: { hasNextPage: false, endCursor: null as string | null },
				},
			},
		},
	});
	const run: GhRunner = async (args) => {
		state.calls.push(args);
		if (args[0] === "api") {
			if (args[1] === `repos/${repository}/releases/tags/${HELPER_RELEASE_TAG}`) {
				if (!state.present || f.helperRelease.draft) throw new Error("gh: Not Found (HTTP 404)");
				return JSON.stringify(f.helperRelease);
			}
			if (args[1] === "graphql") return JSON.stringify(state.graphOverride ?? graph());
			if (args[1] === `repos/${repository}/releases/${f.helperRelease.id}`)
				return JSON.stringify(state.idOverride ?? f.helperRelease);
			return f.options.run(args);
		}
		if (args[0] !== "release") throw new Error("Unexpected mutation");
		if (args[1] === "create") {
			if (state.present) throw new Error("Duplicate create");
			state.present = true;
			return "";
		}
		if (args[1] === "upload") {
			const path = args[3] as string;
			const bytes = await readFile(path);
			f.helperRelease.assets.push(
				f.asset({
					name: basename(path),
					size: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				}),
			);
			return "";
		}
		if (args[1] === "edit") {
			f.helperRelease.draft = false;
			return "";
		}
		throw new Error("Unexpected release operation");
	};
	return { ...f, state, run, graph };
}
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function bundle(value = makeHelper()) {
	const dir = await mkdtemp(join(import.meta.dir, "../../.narrafork/helper-release-test-"));
	dirs.push(dir);
	for (const entry of value.files) await writeFile(join(dir, entry.name), "binary");
	for (const entry of value.licenses) await writeFile(join(dir, entry.name), "license");
	await writeFile(join(dir, HELPER_MANIFEST_FILENAME), `${JSON.stringify(value)}\n`);
	return dir;
}
describe("actual helper tag refs", () => {
	test("annotated tags peel through bounded same-repository git/tag objects", async () => {
		const calls: string[][] = [];
		const tagObject = "b".repeat(40);
		const run: GhRunner = (args) => {
			calls.push(args);
			if (args[1] === `repos/${repository}/git/ref/tags/${HELPER_RELEASE_TAG}`)
				return JSON.stringify({ object: { type: "tag", sha: tagObject } });
			if (args[1] === `repos/${repository}/git/tags/${tagObject}`)
				return JSON.stringify({ object: { type: "commit", sha: commit } });
			throw new Error("Unexpected API");
		};
		expect(await resolveHelperTagCommit({ repository, run }, HELPER_RELEASE_TAG)).toBe(commit);
		expect(calls.length).toBe(2);
		expect(calls.every((args) => !args[1]?.includes("/commits/"))).toBe(true);
	});
	test("a same-named branch cannot stand in for a deleted/nonexistent tag", async () => {
		const f = draftFixture(false);
		const dir = await bundle();
		const calls: string[][] = [];
		const run: GhRunner = (args) => {
			calls.push(args);
			if (args[1]?.includes("/git/ref/tags/")) throw new Error("HTTP 404");
			if (args[1]?.includes("/commits/")) return commit;
			return f.run(args);
		};
		await expect(
			publishHelperRelease({
				repository,
				kind: "helpers",
				version: "1.0.0",
				protocolVersion: 1,
				commit,
				bundleDir: dir,
				run,
			}),
		).rejects.toThrow("404");
		expect(calls.length).toBe(1);
		expect(calls[0]?.[1]).toContain("/git/ref/tags/");
		expect(f.state.calls.length).toBe(0);
	});
	for (const mode of ["cycle", "too-deep", "wrong-type", "bad-sha"])
		test(`rejects ${mode} tag objects with bounded reads`, async () => {
			let count = 0;
			const run: GhRunner = () => {
				count++;
				return JSON.stringify({
					object: {
						type: mode === "wrong-type" ? "tree" : "tag",
						sha:
							mode === "bad-sha"
								? "a"
								: mode === "cycle"
									? "b".repeat(40)
									: count.toString(16).padStart(40, "0"),
					},
				});
			};
			await expect(
				resolveHelperTagCommit({ repository, run }, HELPER_RELEASE_TAG),
			).rejects.toThrow();
			expect(count).toBeLessThanOrEqual(5);
		});
});

describe("read-only auxiliary dependency readiness", () => {
	test("checks same-repository fixed tags, exact twelve helpers and six executors", async () => {
		const f = fixture();
		await verifyPublishedHelperDependencies(f.options);
		expect(f.calls.length).toBe(6);
		expect(
			f.calls.every((args) => args[0] === "api" && args[1]?.startsWith(`repos/${repository}/`)),
		).toBe(true);
		expect(JSON.stringify(f.calls)).not.toContain("latest");
	});
	for (const [name, mutate] of [
		[
			"draft",
			(f: ReturnType<typeof fixture>) => {
				f.helperRelease.draft = true;
			},
		],
		[
			"prerelease",
			(f: ReturnType<typeof fixture>) => {
				f.executorRelease.prerelease = true;
			},
		],
		[
			"wrong tag",
			(f: ReturnType<typeof fixture>) => {
				f.helperRelease.tag_name = "helpers-v2.0.0";
			},
		],
		[
			"missing binary",
			(f: ReturnType<typeof fixture>) => {
				f.helperRelease.assets.shift();
			},
		],
		[
			"missing license",
			(f: ReturnType<typeof fixture>) => {
				f.helperRelease.assets = f.helperRelease.assets.filter(
					(asset) => asset.name !== "musl.txt",
				);
			},
		],
		[
			"unexpected asset",
			(f: ReturnType<typeof fixture>) => {
				f.helperRelease.assets.push(f.asset(byteIdentity("extra.exe")));
			},
		],
		[
			"duplicate asset",
			(f: ReturnType<typeof fixture>) => {
				f.helperRelease.assets.push(f.helperRelease.assets[0] as Remote["assets"][number]);
			},
		],
		[
			"wrong size",
			(f: ReturnType<typeof fixture>) => {
				(f.helperRelease.assets[0] as Remote["assets"][number]).size++;
			},
		],
		[
			"wrong digest",
			(f: ReturnType<typeof fixture>) => {
				(f.executorRelease.assets[0] as Remote["assets"][number]).digest =
					`sha256:${"0".repeat(64)}`;
			},
		],
		[
			"missing digest",
			(f: ReturnType<typeof fixture>) => {
				(f.helperRelease.assets[0] as Remote["assets"][number]).digest = null;
			},
		],
		[
			"unfinished upload",
			(f: ReturnType<typeof fixture>) => {
				(f.helperRelease.assets[0] as Remote["assets"][number]).state = "new";
			},
		],
		[
			"oversized manifest",
			(f: ReturnType<typeof fixture>) => {
				(f.helperRelease.assets.at(-1) as Remote["assets"][number]).size = 65537;
			},
		],
	] as const)
		test(`rejects ${name}, even with successful API responses`, async () => {
			const f = fixture();
			mutate(f);
			await expect(verifyPublishedHelperDependencies(f.options)).rejects.toThrow();
		});
	for (const [name, mutate] of [
		[
			"repository",
			(f: ReturnType<typeof fixture>) => {
				f.helper.repository = "Other/repo";
			},
		],
		[
			"commit",
			(f: ReturnType<typeof fixture>) => {
				f.helper.commit = "b".repeat(40);
			},
		],
		[
			"tool version",
			(f: ReturnType<typeof fixture>) => {
				(f.helper.files[0] as (typeof f.helper.files)[number]).toolVersion = "0.0.0" as "15.1.0";
			},
		],
		[
			"incomplete platforms",
			(f: ReturnType<typeof fixture>) => {
				f.helper.files.pop();
			},
		],
		[
			"protocol",
			(f: ReturnType<typeof fixture>) => {
				f.executor.manifest.protocolVersion = 2;
			},
		],
		[
			"executor version",
			(f: ReturnType<typeof fixture>) => {
				f.executor.manifest.version = "0.0.0";
			},
		],
	] as const)
		test(`rejects correctly rehashed manifest with wrong ${name}`, async () => {
			const f = fixture();
			mutate(f);
			for (const [manifestName, value, release] of [
				[HELPER_MANIFEST_FILENAME, f.helper, f.helperRelease],
				[EXECUTOR_MANIFEST_FILENAME, f.executor, f.executorRelease],
			] as const) {
				const raw = `${JSON.stringify(value)}\n`;
				f.raws.set(manifestName, raw);
				const remote = release.assets.find(
					(asset) => asset.name === manifestName,
				) as Remote["assets"][number];
				remote.size = Buffer.byteLength(raw);
				remote.digest = `sha256:${digest(raw)}`;
			}
			await expect(verifyPublishedHelperDependencies(f.options)).rejects.toThrow();
		});
	test("rejects moved remote tag commit", async () => {
		const f = fixture();
		const run: GhRunner = (args) =>
			args[1]?.includes("/git/ref/tags/")
				? JSON.stringify({ object: { type: "commit", sha: "b".repeat(40) } })
				: f.options.run(args);
		await expect(verifyPublishedHelperDependencies({ ...f.options, run })).rejects.toThrow();
	});
	test("cancellation stops future API operations", async () => {
		const f = fixture();
		const abort = new AbortController();
		abort.abort();
		await expect(
			verifyPublishedHelperDependencies({ ...f.options, signal: abort.signal }),
		).rejects.toThrow();
		expect(f.calls.length).toBe(0);
	});
});
describe("authenticated draft lookup", () => {
	test("new create survives the tag endpoint's real draft 404 and reads the draft by ID", async () => {
		const f = draftFixture(false);
		const dir = await bundle();
		await publishHelperRelease({
			repository,
			kind: "helpers",
			version: "1.0.0",
			protocolVersion: 1,
			commit,
			bundleDir: dir,
			run: f.run,
		});
		expect(
			f.state.calls.filter((args) => args[0] === "release" && args[1] === "create").length,
		).toBe(1);
		expect(f.state.calls.some((args) => args[1] === "graphql")).toBe(true);
		expect(f.state.calls.some((args) => args[1] === `repos/${repository}/releases/1`)).toBe(true);
		expect(f.state.calls.filter((args) => args[1] === "upload").length).toBe(
			13 + HELPER_LICENSE_FILES.length,
		);
		expect(f.state.calls.find((args) => args[1] === "create")).toContain("--verify-tag");
		expect(f.state.calls.find((args) => args[1] === "edit")).toContain("--verify-tag");
		expect(f.helperRelease.draft).toBe(false);
	});
	test("existing draft uses authenticated summaries without re-creating or clobbering assets", async () => {
		const f = draftFixture();
		f.helperRelease.assets.splice(0, 2);
		const dir = await bundle();
		await publishHelperRelease({
			repository,
			kind: "helpers",
			version: "1.0.0",
			protocolVersion: 1,
			commit,
			bundleDir: dir,
			run: f.run,
		});
		expect(f.state.calls.some((args) => args[1] === "create")).toBe(false);
		expect(f.state.calls.filter((args) => args[1] === "upload").length).toBe(2);
		expect(JSON.stringify(f.state.calls)).not.toContain("clobber");
	});
	test("ready checker rejects a draft even though authenticated summaries could see it", async () => {
		const f = draftFixture();
		await expect(verifyPublishedHelperDependencies({ ...f.options, run: f.run })).rejects.toThrow();
		expect(f.state.calls.every((args) => args[0] === "api")).toBe(true);
	});
	for (const mode of [
		"malformed",
		"errors",
		"foreign",
		"incomplete",
		"duplicate-tag",
		"too-many-assets",
	])
		test(`invalid ${mode} summary cannot prove absence or create a release`, async () => {
			const f = draftFixture(mode === "duplicate-tag" || mode === "too-many-assets");
			const value = f.graph();
			if (mode === "malformed") f.state.graphOverride = { data: null };
			if (mode === "errors") f.state.graphOverride = { ...value, errors: [{ message: "denied" }] };
			if (mode === "foreign") {
				value.data.repository.nameWithOwner = "Other/repo";
				f.state.graphOverride = value;
			}
			if (mode === "incomplete") {
				value.data.repository.releases.pageInfo = {
					hasNextPage: true,
					endCursor: "next",
				} as typeof value.data.repository.releases.pageInfo;
				f.state.graphOverride = value;
			}
			if (mode === "duplicate-tag") {
				const node = value.data.repository.releases
					.nodes[0] as (typeof value.data.repository.releases.nodes)[number];
				value.data.repository.releases.nodes.push({ ...node, databaseId: 2 });
				f.state.graphOverride = value;
			}
			if (mode === "too-many-assets") {
				(
					value.data.repository.releases
						.nodes[0] as (typeof value.data.repository.releases.nodes)[number]
				).releaseAssets.totalCount = 46;
				f.state.graphOverride = value;
			}
			const dir = await bundle();
			await expect(
				publishHelperRelease({
					repository,
					kind: "helpers",
					version: "1.0.0",
					protocolVersion: 1,
					commit,
					bundleDir: dir,
					run: f.run,
				}),
			).rejects.toThrow();
			expect(f.state.calls.every((args) => args[0] === "api")).toBe(true);
		});
	test("summary count disagreement rejects truncated draft assets without creating/uploading", async () => {
		const f = draftFixture();
		f.state.idOverride = { ...f.helperRelease, assets: f.helperRelease.assets.slice(1) };
		const dir = await bundle();
		await expect(
			publishHelperRelease({
				repository,
				kind: "helpers",
				version: "1.0.0",
				protocolVersion: 1,
				commit,
				bundleDir: dir,
				run: f.run,
			}),
		).rejects.toThrow("completeness mismatch");
		expect(f.state.calls.every((args) => args[0] === "api")).toBe(true);
	});
	for (const moved of [false, true])
		test(`a tag ${moved ? "moved" : "deleted"} after asset verification prevents publishing and never recreates it`, async () => {
			const f = draftFixture();
			const dir = await bundle();
			let idReads = 0;
			let changed = false;
			const run: GhRunner = (args) => {
				if (args[1] === `repos/${repository}/releases/1` && ++idReads === 2) changed = true;
				if (changed && args[1]?.includes("/git/ref/tags/")) {
					if (!moved) throw new Error("HTTP 404");
					return JSON.stringify({ object: { type: "commit", sha: "b".repeat(40) } });
				}
				return f.run(args);
			};
			await expect(
				publishHelperRelease({
					repository,
					kind: "helpers",
					version: "1.0.0",
					protocolVersion: 1,
					commit,
					bundleDir: dir,
					run,
				}),
			).rejects.toThrow();
			expect(f.helperRelease.draft).toBe(true);
			expect(f.state.calls.every((args) => args[0] === "api")).toBe(true);
		});
	test("actual reviewer removal after final asset verification is re-read before publishing the draft", async () => {
		const f = draftFixture();
		const dir = await bundle();
		let idReads = 0;
		let reviewersPresent = true;
		const environment = {
			GITHUB_REPOSITORY: repository,
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_REF: "refs/heads/main",
			GITHUB_SHA: commit,
		};
		const calls: string[][] = [];
		const run: GhRunner = async (args) => {
			calls.push(args);
			if (args[1] === `repos/${repository}`)
				return JSON.stringify({ full_name: repository, default_branch: "main" });
			if (args[1] === `repos/${repository}/environments/release`)
				return JSON.stringify({
					name: "release",
					protection_rules: [
						{
							type: "required_reviewers",
							reviewers: reviewersPresent ? [{ type: "User", reviewer: { id: 1 } }] : [],
						},
					],
					deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
				});
			if (
				args[1]?.startsWith(`repos/${repository}/environments/release/deployment-branch-policies?`)
			)
				return JSON.stringify({
					total_count: 1,
					branch_policies: [{ name: "main", type: "branch" }],
				});
			if (args[1]?.includes("/git/ref/heads/"))
				return JSON.stringify({ object: { type: "commit", sha: "c".repeat(40) } });
			if (args[1]?.includes("/compare/"))
				return JSON.stringify({ status: "ahead", merge_base_commit: { sha: commit } });
			if (args[1] === `repos/${repository}/releases/1` && ++idReads === 2) reviewersPresent = false;
			return f.run(args);
		};
		await expect(
			publishHelperReleasePlan(
				{
					schemaVersion: 1,
					repository,
					defaultBranch: "main",
					tag: HELPER_RELEASE_TAG,
					commit,
					controlCommit: commit,
					kind: "helpers",
					version: "1.0.0",
					protocolVersion: 1,
					sourceRunId: "",
					publish: true,
				},
				dir,
				false,
				{ run, environment },
			),
		).rejects.toThrow("required reviewers");
		expect(f.helperRelease.draft).toBe(true);
		expect(calls.every((args) => args[0] === "api")).toBe(true);
		expect(
			calls.filter((args) => args[1] === `repos/${repository}/environments/release`).length,
		).toBe(2);
	});
	test("failed protected-environment recheck immediately before edit leaves the draft unpublished", async () => {
		const f = draftFixture();
		const dir = await bundle();
		await expect(
			publishHelperRelease({
				repository,
				kind: "helpers",
				version: "1.0.0",
				protocolVersion: 1,
				commit,
				bundleDir: dir,
				run: f.run,
				beforeWrite: async () => {
					throw new Error("reviewers removed");
				},
			}),
		).rejects.toThrow("reviewers removed");
		expect(f.helperRelease.draft).toBe(true);
		expect(f.state.calls.every((args) => args[0] === "api")).toBe(true);
	});
});

describe("immutable auxiliary publisher", () => {
	test("release-executor --target=github --dry-run consumes a bundle without server config, build or network", async () => {
		const dir = await mkdtemp(join(import.meta.dir, "../../.narrafork/helper-cli-test-"));
		dirs.push(dir);
		const outer = makeExecutor();
		const output = join(dir, "bundle");
		const bin = join(dir, "bin");
		await mkdir(output);
		await mkdir(bin);
		for (const file of Object.values(outer.manifest.platforms))
			await writeFile(join(output, file.filename), "binary");
		for (const file of outer.licenses) await writeFile(join(output, file.name), "license");
		await writeFile(join(output, EXECUTOR_MANIFEST_FILENAME), `${JSON.stringify(outer)}\n`);
		const planPath = join(dir, "plan.json");
		await writeFile(
			planPath,
			JSON.stringify({
				schemaVersion: 1,
				repository,
				defaultBranch: "main",
				tag: outer.tag,
				commit,
				controlCommit: commit,
				kind: "executor",
				version,
				protocolVersion: 1,
				sourceRunId: "",
				publish: false,
			}),
		);
		const marker = join(dir, "remote-called");
		for (const command of ["gh", "go", "curl"])
			await writeFile(join(bin, command), `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`, {
				mode: 0o755,
			});
		const result = Bun.spawnSync(
			[
				process.execPath,
				"scripts/release-executor.ts",
				version,
				"--target=github",
				"--dry-run",
				`--plan=${planPath}`,
				`--output=${output}`,
			],
			{
				cwd: join(import.meta.dir, "../.."),
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					GITHUB_REPOSITORY: repository,
					NF_UPDATE_SERVER: "http://127.0.0.1:1",
					NF_UPDATE_TOKEN: "fixture-only",
				},
				timeout: 5000,
				maxBuffer: 65536,
			},
		);
		expect(result.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(false);
		// Give the typo case an otherwise-valid approved publisher context: ignoring
		// this flag would reach gh and create the marker, so rejection is observable.
		const typo = Bun.spawnSync(
			[
				process.execPath,
				"scripts/release-helpers.ts",
				"publish",
				"--dry-rnu",
				`--plan=${planPath}`,
				`--output=${output}`,
			],
			{
				cwd: join(import.meta.dir, "../.."),
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					GITHUB_REPOSITORY: repository,
					GITHUB_EVENT_NAME: "workflow_dispatch",
					GITHUB_REF: "refs/heads/main",
					GITHUB_SHA: commit,
					GITHUB_RUN_ID: "456",
				},
				timeout: 5000,
				maxBuffer: 65536,
			},
		);
		expect(typo.exitCode).not.toBe(0);
		expect(typo.stderr.toString()).toContain("Unknown option for publish: --dry-rnu");
		expect(existsSync(marker)).toBe(false);
		const frozenSourcePlan = JSON.parse(await readFile(planPath, "utf8"));
		frozenSourcePlan.sourceRunId = "123";
		await writeFile(planPath, JSON.stringify(frozenSourcePlan));
		const swapped = Bun.spawnSync(
			[
				process.execPath,
				"scripts/release-helpers.ts",
				"restore",
				"--source-run-id=456",
				`--plan=${planPath}`,
				`--output=${output}`,
			],
			{
				cwd: join(import.meta.dir, "../.."),
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					GITHUB_REPOSITORY: repository,
					GITHUB_EVENT_NAME: "workflow_dispatch",
					GITHUB_REF: "refs/heads/main",
					GITHUB_SHA: commit,
					GITHUB_RUN_ID: "456",
				},
				timeout: 5000,
				maxBuffer: 65536,
			},
		);
		expect(swapped.exitCode).not.toBe(0);
		expect(swapped.stderr.toString()).toContain("frozen plan provenance");
		expect(existsSync(marker)).toBe(false);
	});
	test("preview validates bundle and does zero network operations", async () => {
		const f = fixture();
		const dir = await bundle();
		await publishHelperRelease({
			repository,
			kind: "helpers",
			version: "1.0.0",
			protocolVersion: 1,
			commit,
			bundleDir: dir,
			dryRun: true,
			run: f.options.run,
		});
		expect(f.calls.length).toBe(0);
	});
	test("corrupted local binary is rejected before any network call", async () => {
		const f = fixture();
		const dir = await bundle();
		await writeFile(join(dir, "rg-linux-x64"), "damage");
		await expect(
			publishHelperRelease({
				repository,
				kind: "helpers",
				version: "1.0.0",
				protocolVersion: 1,
				commit,
				bundleDir: dir,
				run: f.options.run,
			}),
		).rejects.toThrow("Local helper size/SHA-256 mismatch");
		expect(f.calls.length).toBe(0);
	});
	test("unknown local bundle entries are rejected", async () => {
		const dir = await bundle();
		await writeFile(join(dir, "extra"), "wrong");
		await expect(
			validateHelperReleaseBundle({
				repository,
				kind: "helpers",
				version: "1.0.0",
				protocolVersion: 1,
				commit,
				bundleDir: dir,
			}),
		).rejects.toThrow("not exact");
	});
	test("public helper release is immutable, with no upload/edit calls", async () => {
		const f = fixture();
		const dir = await bundle();
		await expect(
			publishHelperRelease({
				repository,
				kind: "helpers",
				version: "1.0.0",
				protocolVersion: 1,
				commit,
				bundleDir: dir,
				run: f.options.run,
			}),
		).rejects.toThrow("immutable");
		expect(f.calls.every((args) => args[0] === "api")).toBe(true);
	});
	test("resumes only missing draft assets, no overwrite/publication before complete hashes", async () => {
		const f = fixture();
		const dir = await bundle();
		f.helperRelease.draft = true;
		f.helperRelease.assets.splice(0, 2);
		const writes: string[][] = [];
		const run: GhRunner = async (args) => {
			if (args[0] === "api") return f.options.run(args);
			writes.push(args);
			if (args[1] === "upload") {
				const path = args[3] as string;
				const raw = await readFile(path);
				const name = path.split("/").at(-1) as string;
				f.helperRelease.assets.push(
					f.asset({
						name,
						size: raw.length,
						sha256: createHash("sha256").update(raw).digest("hex"),
					}),
				);
				return "";
			}
			if (args[1] === "edit") {
				f.helperRelease.draft = false;
				return "";
			}
			throw new Error("Unexpected write");
		};
		await publishHelperRelease({
			repository,
			kind: "helpers",
			version: "1.0.0",
			protocolVersion: 1,
			commit,
			bundleDir: dir,
			run,
		});
		expect(writes.filter((args) => args[1] === "upload").length).toBe(2);
		expect(writes.at(-1)?.[1]).toBe("edit");
		expect(JSON.stringify(writes)).not.toContain("clobber");
		expect(writes.at(-1)).toContain("--latest=false");
	});
	test("a conflicting draft asset is not overwritten", async () => {
		const f = fixture();
		const dir = await bundle();
		f.helperRelease.draft = true;
		(f.helperRelease.assets[0] as Remote["assets"][number]).digest = `sha256:${"0".repeat(64)}`;
		await expect(
			publishHelperRelease({
				repository,
				kind: "helpers",
				version: "1.0.0",
				protocolVersion: 1,
				commit,
				bundleDir: dir,
				run: f.options.run,
			}),
		).rejects.toThrow("mismatch");
		expect(f.calls.every((args) => args[0] === "api")).toBe(true);
	});
});
