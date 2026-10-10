import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatChecksumsReport,
	formatMetadataJson,
	formatSha256Sums,
} from "../../scripts/lib/binary-metadata";
import {
	createBridgeGhRunner,
	runBridgeProcess,
} from "../../scripts/lib/ci-update-server-bridge-restore";
import { publishGitHubRelease } from "../../scripts/lib/github-release";
import { HELPER_LICENSE_FILES, publishHelperRelease } from "../../scripts/lib/helper-release";
import { prepareUpdateIndexRelease } from "../../scripts/lib/update-index";
import { publishUpdateIndex } from "../../scripts/lib/update-index-github";
import {
	getHelperAssetName,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
} from "../../shared/helper-distribution";

const roots: string[] = [];
const repository = "fixture-owner/fixture-repo";
const commit = "a".repeat(40);
const version = "1.2.0";
const publishedAt = "2026-10-09T00:00:00.000Z";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A complete executable gh shim: PATH contains ONLY this directory. No real gh,
// network, real credentials, prototype/module mocks, or original bundle writes.
const shim = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const path = process.env.FIXTURE_STATE;
const s = JSON.parse(readFileSync(path, "utf8"));
s.calls.push(args);
const save = () => writeFileSync(path, JSON.stringify(s));
const out = (value) => { save(); process.stdout.write(JSON.stringify(value)); };
const fail = () => {
 save();
 process.stdout.write(s.stdout || "");
 process.stderr.write(s.stderr ?? "gh: Not Found (HTTP 404)\n");
 process.exitCode = 1;
};
const next = () => (++s.sequence).toString(16).padStart(40, "0");
const graph = () => ({ data: { repository: { nameWithOwner: s.repository,
 releases: { nodes: s.present ? [{ databaseId: 1, tagName: s.release.tag_name,
 isDraft: s.release.draft, isPrerelease: false,
 publishedAt: s.release.draft ? null : s.release.published_at,
 releaseAssets: { totalCount: s.release.assets.length } }] : [],
 pageInfo: { hasNextPage: false, endCursor: null } } } } });
if (s.mode === "diagnostic") {
 save();
 if (s.ready) writeFileSync(s.ready, String(process.pid));
 process.stdout.write(s.stdout || "");
 if (s.cap) process[s.cap].write("x".repeat(1024 * 1024 + 1));
 process.stderr.write(s.stderr || "");
 if (s.wait) setInterval(() => {}, 1000);
 else if (s.signal) process.kill(process.pid, "SIGTERM");
 else process.exitCode = s.exitCode ?? 1;
} else if (args[0] === "release") {
 if (args[1] === "create") {
  if (s.present) throw new Error("Duplicate fixture draft creation");
  s.present = true;
  const notes = args.indexOf("--notes-file");
  if (notes >= 0) s.release.body = readFileSync(args[notes + 1], "utf8");
  out(null);
 } else if (args[1] === "upload") {
  const bytes = readFileSync(args[3]);
  const name = basename(args[3]);
  if (s.release.assets.some((a) => a.name === name)) throw new Error("Duplicate upload");
  s.release.assets.push({ id: s.release.assets.length + 10, name, size: bytes.length,
   state: "uploaded", digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") });
  s.contents[name] = bytes.toString("utf8");
  out(null);
 } else if (args[1] === "edit") { s.release.draft = false; out(null); }
 else throw new Error("Unexpected fixture release operation");
} else if (args[0] === "api") {
 const endpoint = args[1];
 const p = endpoint.replace("repos/" + s.repository + "/", "");
 const input = args.indexOf("--input");
 const body = input < 0 ? undefined : JSON.parse(readFileSync(args[input + 1], "utf8"));
 if (endpoint === "graphql") out(graph());
 else if (endpoint === "repos/" + s.repository) out({ full_name: s.repository, default_branch: "main" });
 else if (p.startsWith("git/ref/tags/")) out({ ref: "refs/tags/" + s.release.tag_name, object: { type: "commit", sha: s.commit } });
 else if (p.startsWith("releases/tags/")) {
  if (!s.present || s.release.draft || s.blockLookup) fail(); else out(s.release);
 } else if (p.startsWith("releases?")) out(s.present ? [{ id: 1, tag_name: s.release.tag_name }] : []);
 else if (p === "releases/1") out(s.release);
 else if (p.startsWith("releases/1/assets?")) out(s.release.assets);
 else if (p.startsWith("releases/assets/")) {
  const a = s.release.assets.find((a) => a.id === Number(p.slice(16)));
  if (!a) throw new Error("Missing fixture asset");
  save(); process.stdout.write(s.contents[a.name]);
 } else if (p === "git/ref/heads/narrafork-updates") {
  if (!s.head || s.blockRef) fail();
  else out({ ref: "refs/heads/narrafork-updates", object: { type: "commit", sha: s.head } });
 } else if (p === "git/blobs") { const sha = next(); s.blobs[sha] = body.content; out({ sha }); }
 else if (p === "git/trees") { const sha = next(); s.trees[sha] = body.tree; out({ sha }); }
 else if (p === "git/commits") { const sha = next(); s.commits[sha] = body; out({ sha }); }
 else if (p === "git/refs") {
  if (body.ref !== "refs/heads/narrafork-updates" || s.head) throw new Error("Unsafe fixture ref write");
  s.head = body.sha; out({ ref: body.ref, object: { type: "commit", sha: s.head } });
 } else if (p.startsWith("git/commits/")) {
  const sha = p.slice(12), c = s.commits[sha];
  out({ sha, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) });
 } else if (p.startsWith("contents/")) {
  const [file, sha] = p.slice(9).split("?ref=");
  const entry = s.trees[s.commits[sha].tree].find((entry) => entry.path === file);
  const raw = s.blobs[entry.sha];
  if (args.includes("Accept: application/vnd.github.raw+json")) { save(); process.stdout.write(raw); }
  else out({ type: "file", path: file, size: Buffer.byteLength(raw), encoding: "base64", content: Buffer.from(raw).toString("base64") });
 } else throw new Error("Unexpected fixture API operation");
} else throw new Error("Unexpected fixture command");
`;

interface ShimState {
	mode: string;
	repository: string;
	commit: string;
	present: boolean;
	release: {
		id: number;
		tag_name: string;
		draft: boolean;
		prerelease: boolean;
		body: string;
		published_at: string;
		assets: { id: number; name: string; size: number; state: string; digest: string }[];
	};
	contents: Record<string, string>;
	calls: string[][];
	sequence: number;
	head: string | null;
	blobs: Record<string, string>;
	trees: Record<string, unknown>;
	commits: Record<string, unknown>;
	stderr?: string;
	stdout?: string;
	blockLookup?: boolean;
	blockRef?: boolean;
	cap?: "stdout" | "stderr";
	wait?: boolean;
	ready?: string;
	exitCode?: number;
	signal?: boolean;
}
async function fixture(overrides: Partial<ShimState> = {}) {
	const root = await mkdtemp(join(tmpdir(), "gh-runner-contract-"));
	roots.push(root);
	const statePath = join(root, "state.json");
	const state: ShimState = {
		mode: "publication",
		repository,
		commit,
		present: false,
		release: {
			id: 1,
			tag_name: `v${version}`,
			draft: true,
			prerelease: false,
			body: "",
			published_at: publishedAt,
			assets: [],
		},
		contents: {},
		calls: [],
		sequence: 100,
		head: null,
		blobs: {},
		trees: {},
		commits: {},
		...overrides,
	};
	await writeFile(statePath, JSON.stringify(state));
	await writeFile(join(root, "gh"), `#!${process.execPath}\n${shim}`);
	await chmod(join(root, "gh"), 0o700);
	const environment = {
		PATH: root,
		FIXTURE_STATE: statePath,
		GH_TOKEN: "fixture-gh-secret",
		NF_UPDATE_TOKEN: "fixture-nf-secret",
		NF_UPDATE_SERVER: "https://fixture.invalid?token=fixture-nf-secret",
	};
	const controller = new AbortController();
	const runner = createBridgeGhRunner(controller.signal, environment);
	const run = async (args: string[]) => runner(args);
	const read = async (): Promise<ShimState> => JSON.parse(await readFile(statePath, "utf8"));
	const distDir = join(root, "assets");
	await mkdir(distDir);
	return { root, state, statePath, environment, controller, run, read, distDir };
}
async function mainBundle(f: Awaited<ReturnType<typeof fixture>>) {
	const name = `narrafork-${version}-linux-x64`;
	const bytes = Buffer.from("tiny immutable binary");
	const entry = computeBinaryMetadataFromBuffer(name, bytes, {
		version,
		platformId: "linux-x64",
		target: "bun-linux-x64",
		commit,
		buildDate: publishedAt,
	});
	await writeFile(join(f.distDir, name), bytes);
	await writeFile(join(f.distDir, `${name}.metadata.json`), formatMetadataJson(entry));
	await writeFile(join(f.distDir, `narrafork-${version}-SHA256SUMS`), formatSha256Sums([entry]));
	await writeFile(
		join(f.distDir, `narrafork-${version}-checksums.txt`),
		formatChecksumsReport(version, [entry]),
	);
	return {
		distDir: f.distDir,
		repository,
		version,
		commit,
		publishedAt,
		changelog: "",
		platformSuffixes: new Map([["linux-x64", "linux-x64"]]),
		run: f.run,
	};
}
async function helperBundle(f: Awaited<ReturnType<typeof fixture>>) {
	const identity = async (name: string, content: string) => {
		await writeFile(join(f.distDir, name), content);
		return { name, size: Buffer.byteLength(content), sha256: digest(content) };
	};
	const files = await Promise.all(
		HELPER_TOOLS.flatMap((tool) =>
			HELPER_PLATFORMS.map(async (platform) => ({
				tool,
				platform,
				toolVersion: HELPER_TOOL_VERSIONS[tool],
				...(await identity(getHelperAssetName(tool, platform), "tiny helper")),
			})),
		),
	);
	const licenses = await Promise.all(HELPER_LICENSE_FILES.map((name) => identity(name, "license")));
	await writeFile(
		join(f.distDir, HELPER_MANIFEST_FILENAME),
		JSON.stringify({
			schemaVersion: 1,
			repository,
			tag: HELPER_RELEASE_TAG,
			commit,
			catalogVersion: "1.0.0",
			files,
			licenses,
		}),
	);
	f.state.release.tag_name = HELPER_RELEASE_TAG;
	await writeFile(f.statePath, JSON.stringify(f.state));
	return {
		kind: "helpers" as const,
		bundleDir: f.distDir,
		repository,
		version: "1.0.0",
		protocolVersion: 1,
		commit,
		run: f.run,
	};
}
const mutations = (state: ShimState) =>
	state.calls.filter((args) => args[0] === "release" || args.includes("--method"));

describe("real async gh runner publication contract", () => {
	for (const existing of [false, true]) {
		test(`main publisher ${existing ? "recovers existing draft" : "creates first draft"} after tag 404`, async () => {
			const f = await fixture({ present: existing });
			const options = await mainBundle(f);
			await expect(publishGitHubRelease(options)).resolves.toMatchObject({
				alreadyPublished: false,
			});
			const state = await f.read();
			expect(state.release.draft).toBe(false);
			expect(state.calls.filter((args) => args[1] === "create")).toHaveLength(existing ? 0 : 1);
			expect(state.calls.some((args) => args[1]?.includes("releases?"))).toBe(true);
		});
		test(`helper publisher ${existing ? "recovers existing draft" : "creates first draft"} after tag 404`, async () => {
			const f = await fixture({ present: existing });
			await publishHelperRelease(await helperBundle(f));
			const state = await f.read();
			expect(state.release.draft).toBe(false);
			expect(state.calls.filter((args) => args[1] === "create")).toHaveLength(existing ? 0 : 1);
			expect(state.calls.some((args) => args[1] === "graphql")).toBe(true);
		});
	}
	test("first update index 404 creates fixed metadata ref and verifies generation readback", async () => {
		const f = await fixture();
		const options = await mainBundle(f);
		await publishGitHubRelease(options);
		const prepared = await prepareUpdateIndexRelease(options);
		await expect(
			publishUpdateIndex({ repository, ...prepared, run: f.run }),
		).resolves.toMatchObject({ generation: 1, unchanged: false });
		const state = await f.read();
		expect(state.head).toMatch(/^[a-f0-9]{40}$/);
		expect(state.calls.filter((args) => args[1] === `repos/${repository}/git/refs`)).toHaveLength(
			1,
		);
	});
	const failures = [
		["401", "gh: Bad credentials (HTTP 401)\n"],
		["403", "gh: Forbidden (HTTP 403)\n"],
		["429", "gh: Too Many Requests (HTTP 429)\n"],
		["500", "gh: Internal Server Error (HTTP 500)\n"],
		["body status", '{"message":"HTTP 404", "token":"fixture-gh-secret"}\n'],
		["secret in diagnostic", "gh: fixture-gh-secret HTTP 404 (HTTP 403)\n"],
		["secret 404 reason", "gh: fixture-gh-secret (HTTP 404)\n"],
		["conflicting diagnostics", "gh: Not Found (HTTP 404)\ngh: Forbidden (HTTP 403)\n"],
		["unknown exit", "unclassified fixture-gh-secret failure\n"],
	] as const;
	for (const [name, stderr] of failures) {
		for (const publisher of ["main", "helpers", "index"] as const)
			test(`${publisher}: ${name} is never treated as missing or allowed to write`, async () => {
				const f = await fixture({ stderr, blockLookup: publisher !== "index" });
				let task: Promise<unknown>;
				if (publisher === "helpers") task = publishHelperRelease(await helperBundle(f));
				else {
					const options = await mainBundle(f);
					if (publisher === "main") task = publishGitHubRelease(options);
					else {
						// Seed only fixture public assets; runner is still the actual spawned gh shim.
						f.state.present = true;
						f.state.release.draft = false;
						for (const asset of [
							`narrafork-${version}-linux-x64`,
							`narrafork-${version}-linux-x64.metadata.json`,
						]) {
							const bytes = await readFile(join(f.distDir, asset));
							f.state.contents[asset] = bytes.toString("utf8");
							f.state.release.assets.push({
								id: f.state.release.assets.length + 10,
								name: asset,
								size: bytes.length,
								state: "uploaded",
								digest: `sha256:${digest(bytes)}`,
							});
						}
						await writeFile(f.statePath, JSON.stringify(f.state));
						task = publishUpdateIndex({
							repository,
							...(await prepareUpdateIndexRelease(options)),
							run: f.run,
						});
					}
				}
				const error = await task.then(
					() => null,
					(error: unknown) => error,
				);
				expect(error).toBeInstanceOf(Error);
				expect(String(error)).not.toContain("HTTP 404");
				expect(String(error)).not.toContain("fixture-gh-secret");
				expect(String(error)).not.toContain("fixture-nf-secret");
				const state = await f.read();
				expect(mutations(state)).toHaveLength(0);
				expect(state.calls.at(-1)?.[1]).toBe(
					`repos/${repository}/${publisher === "index" ? "git/ref/heads/narrafork-updates" : `releases/tags/${publisher === "helpers" ? HELPER_RELEASE_TAG : `v${version}`}`}`,
				);
			});
	}
});

describe("real async gh runner diagnostic bounds and cancellation", () => {
	test("canonical 404 retains only numeric status, never stdout or diagnostic payload", async () => {
		const f = await fixture({
			mode: "diagnostic",
			stderr:
				"gh: Not Found (HTTP 404)\nfixture-gh-secret https://fixture.invalid?token=fixture-nf-secret\n",
			stdout: '{"message":"fixture-gh-secret HTTP 403"}',
		});
		const error = await f
			.run(["api", "repos/fixture-owner/fixture-repo/releases/tags/v1.2.0"])
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toBe("Error: GitHub publication subprocess failed (HTTP 404)");
		expect(JSON.stringify(error)).not.toContain("fixture-");
	});
	for (const status of [401, 403, 429, 500, 503])
		test(`HTTP ${status} retains only its numeric status despite secret diagnostic text`, async () => {
			const f = await fixture({
				mode: "diagnostic",
				stderr: `gh: fixture-gh-secret https://fixture.invalid?token=fixture-nf-secret (HTTP ${status})\n`,
			});
			const error = await f.run(["api", "fixture"]).catch((error: unknown) => error);
			expect(String(error)).toBe(`Error: GitHub publication subprocess failed (HTTP ${status})`);
			expect(JSON.stringify(error)).not.toContain("fixture-");
		});
	for (const stderr of [
		"",
		"HTTP 404\n",
		'{"message":"gh: Not Found (HTTP 404)"}\n',
		"body starts here\ngh: Not Found (HTTP 404)\n",
		"gh: Not Found (HTTP 404) suffix\n",
		"gh: Not Found (HTTP 404)\nrequest failed HTTP 403\n",
	])
		test(`untrusted or malformed diagnostic ${JSON.stringify(stderr)} fails closed`, async () => {
			const f = await fixture({ mode: "diagnostic", stderr, stdout: "gh: Not Found (HTTP 404)\n" });
			const error = await f.run(["api", "fixture"]).catch((error: unknown) => error);
			expect(String(error)).toBe("Error: GitHub publication subprocess failed");
		});
	test("exactly 1MiB stdout remains allowed on successful exit", async () => {
		const f = await fixture({ mode: "diagnostic", stdout: "x".repeat(1024 * 1024), exitCode: 0 });
		expect((await f.run(["api", "fixture"])).length).toBe(1024 * 1024);
	});
	test("success does not classify a stderr status as failure", async () => {
		const f = await fixture({
			mode: "diagnostic",
			stderr: "gh: Not Found (HTTP 404)\n",
			stdout: "ok",
			exitCode: 0,
		});
		expect(await f.run(["api", "fixture"])).toBe("ok");
	});
	test("spawn failure exposes neither arguments nor environment", async () => {
		const f = await fixture();
		await rm(join(f.root, "gh"));
		const error = await f.run(["api", "fixture-gh-secret"]).catch((error: unknown) => error);
		expect(String(error)).toBe("Error: GitHub publication subprocess failed");
	});
	for (const cap of ["stdout", "stderr"] as const)
		test(`${cap} over 1MiB wins over plausible 404 and remains a hard error`, async () => {
			const f = await fixture({ mode: "diagnostic", cap, stderr: "gh: Not Found (HTTP 404)\n" });
			await expect(f.run(["api", "fixture"])).rejects.toThrow("output exceeds limit");
		});
	test("an unrelated child diagnostic is not parsed as a gh API response", async () => {
		const f = await fixture({ mode: "diagnostic", stderr: "gh: Not Found (HTTP 404)\n" });
		await expect(
			runBridgeProcess(join(f.root, "gh"), ["api", "fixture"], {
				environment: f.environment,
				timeoutMs: 1000,
				maximumOutputBytes: 1024,
			}),
		).rejects.toThrow("GitHub publication subprocess failed");
		const error = await f.run(["release", "upload", "fixture"]).catch((error: unknown) => error);
		expect(String(error)).not.toContain("HTTP 404");
	});
	test("a child killed by signal cannot turn its prior diagnostic into missing", async () => {
		const f = await fixture({
			mode: "diagnostic",
			signal: true,
			stderr: "gh: Not Found (HTTP 404)\n",
		});
		const error = await f.run(["api", "fixture"]).catch((error: unknown) => error);
		expect(String(error)).toBe("Error: GitHub publication subprocess failed");
	});
	test("parent cancellation has priority over previously emitted 404 and waits for child close", async () => {
		const f = await fixture({
			mode: "diagnostic",
			wait: true,
			stderr: "gh: Not Found (HTTP 404)\n",
		});
		f.state.ready = join(f.root, "ready");
		await writeFile(f.statePath, JSON.stringify(f.state));
		const task = f.run(["api", "fixture"]);
		let pid: number | undefined;
		for (let attempts = 0; attempts < 100; attempts++) {
			try {
				pid = Number(await readFile(f.state.ready, "utf8"));
				break;
			} catch {
				await Bun.sleep(5);
			}
		}
		try {
			expect(pid).toBeGreaterThan(0);
			const reason = new Error("fixture publication cancelled");
			f.controller.abort(reason);
			await expect(task).rejects.toBe(reason);
			expect(() => process.kill(pid as number, 0)).toThrow();
		} finally {
			f.controller.abort();
			await task.catch(() => {});
		}
	});
	test("timeout is not rewritten as HTTP missing", async () => {
		const f = await fixture({
			mode: "diagnostic",
			wait: true,
			stderr: "gh: Not Found (HTTP 404)\n",
		});
		const error = await runBridgeProcess("gh", ["api", "fixture"], {
			environment: f.environment,
			timeoutMs: 100,
			maximumOutputBytes: 1024,
		}).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("HTTP 404");
		expect((error as Error).name).toBe("TimeoutError");
	});
});
