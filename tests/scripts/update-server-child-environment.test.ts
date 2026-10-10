import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	computeBinaryMetadataFromBuffer,
	formatChecksumsReport,
	formatMetadataJson,
	formatSha256Sums,
} from "../../scripts/lib/binary-metadata";
import { downloadReleaseAsset, hashReleaseFile, runCiGh } from "../../scripts/lib/ci-release-io";
import { ciGhRunner } from "../../scripts/lib/ci-release-plan";
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
} from "../../scripts/lib/ci-release-types";
import { runGh } from "../../scripts/lib/github-release";
import { HELPER_LICENSE_FILES, resolveHelperTagCommit } from "../../scripts/lib/helper-release";
import {
	type HelperReleasePlan,
	restoreHelperReleaseBundle,
} from "../../scripts/lib/helper-release-control";
import {
	resolveUpdateServerBridgeConfig,
	UpdateServerBridgeHttp,
} from "../../scripts/lib/update-server-bridge-http";
import { prepareUpdateServerMainMirror } from "../../scripts/lib/update-server-main-mirror";
import {
	applyZstdPatch,
	applyZstdPatchToFile,
	generateZstdPatch,
	generateZstdPatchToFile,
} from "../../server/lib/zstd-patch";
import {
	getHelperAssetName,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
} from "../../shared/helper-distribution";
import { addToken, initConfig } from "../../update-server/lib/config";
import { invalidateProduct, setCachedRelease } from "../../update-server/lib/release-cache";
import { createCheckRoutes } from "../../update-server/routes/check";
import { createDownloadRoutes } from "../../update-server/routes/download";
import { createReleaseRoutes } from "../../update-server/routes/releases";
import { LocalStorage } from "../../update-server/storage/local";
import type { ReleaseMeta } from "../../update-server/types";

const roots: string[] = [];
const changedEnvironment = new Map<string, string | undefined>();
const sentinel = "fake-upload-only-child-env-sentinel";
const ghAuthentication = "fake-github-read-token";
const proxy = "http://fixture-proxy.invalid:8080";
const python = Bun.which("python3");
const zstd = Bun.which("zstd");
if (!python || !zstd) throw new Error("Child environment tests require real python3 and zstd");
const realPython = python;
const realZstd = zstd;
const realUnzip = Bun.which("unzip");
if (!realUnzip) throw new Error("Child environment tests require real unzip");
const commit = "a".repeat(40);
const workflowCommit = "b".repeat(40);

function setEnvironment(values: NodeJS.ProcessEnv) {
	for (const [name, value] of Object.entries(values)) {
		if (!changedEnvironment.has(name)) changedEnvironment.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}
afterEach(async () => {
	for (const [name, value] of changedEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	changedEnvironment.clear();
	invalidateProduct("narrafork");
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sandbox() {
	const root = await mkdtemp(join(tmpdir(), "nf-update-child-env-"));
	roots.push(root);
	const bin = join(root, "bin");
	await mkdir(bin);
	const log = join(root, "child-observations.jsonl");
	const environment = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		GH_TOKEN: ghAuthentication,
		GITHUB_TOKEN: "fake-github-fallback-token",
		HTTPS_PROXY: proxy,
		NO_PROXY: "127.0.0.1,localhost",
		NODE_EXTRA_CA_CERTS: join(root, "fixture-ca.pem"),
		NF_UPDATE_TOKEN: sentinel,
		NF_UPDATE_SERVER: "https://upload-only.invalid",
		nf_update_token: sentinel,
		Nf_Update_Server: "https://upload-only.invalid",
		FIXTURE_OBSERVATIONS: log,
	};
	const observe = `import os,sys,json\ne=os.environ\nkeys=[k for k in e if k.upper() in ('NF_UPDATE_TOKEN','NF_UPDATE_SERVER')]\nrecord={'tool':os.path.basename(sys.argv[0]),'forbidden':keys,'gh':e.get('GH_TOKEN'),'fallback':e.get('GITHUB_TOKEN'),'proxy':e.get('HTTPS_PROXY'),'noProxy':e.get('NO_PROXY'),'ca':e.get('NODE_EXTRA_CA_CERTS'),'homePresent':'HOME' in e,'pathPresent':'PATH' in e}\nwith open(e['FIXTURE_OBSERVATIONS'],'a') as f: f.write(json.dumps(record)+'\\n')\nsys.stderr.write('fixture child diagnostics; forbidden-present='+str(bool(keys))+'\\n')\n`;
	async function shim(name: string, body: string) {
		await writeFile(join(bin, name), `#!${realPython}\n${observe}${body}\n`);
		await chmod(join(bin, name), 0o700);
	}
	await shim(
		"zstd",
		`os.execv(${JSON.stringify(realZstd)},[${JSON.stringify(realZstd)}]+sys.argv[1:])`,
	);
	await shim(
		"python3",
		`os.execv(${JSON.stringify(realPython)},[${JSON.stringify(realPython)}]+sys.argv[1:])`,
	);
	await shim(
		"gh",
		`if 'FIXTURE_ASSET' in e and ('/releases/assets/' in ' '.join(sys.argv) or '/artifacts/' in ' '.join(sys.argv)):\n sys.stdout.buffer.write(open(e['FIXTURE_ASSET'],'rb').read())\nelif e.get('FIXTURE_GH_FAIL')=='1':\n sys.exit(7)\nelse:\n sys.stdout.write(e.get('FIXTURE_GH_RESPONSE','{}'))`,
	);
	async function observations() {
		const text = await readFile(log, "utf8");
		expect(text).not.toContain(sentinel);
		return text
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						tool: string;
						forbidden: string[];
						gh: string;
						fallback: string;
						proxy: string;
						noProxy: string;
						ca: string;
						homePresent: boolean;
						pathPresent: boolean;
					},
			);
	}
	async function assertChildren() {
		const records = await observations();
		expect(records.length).toBeGreaterThan(0);
		for (const record of records) {
			expect(record.forbidden).toEqual([]);
			expect(record.gh).toBe(ghAuthentication);
			expect(record.fallback).toBe(environment.GITHUB_TOKEN);
			expect(record.proxy).toBe(proxy);
			expect(record.noProxy).toBe(environment.NO_PROXY);
			expect(record.ca).toBe(environment.NODE_EXTRA_CA_CERTS);
			expect(record.homePresent).toBe(true);
			expect(record.pathPresent).toBe(true);
		}
		expect(environment.NF_UPDATE_TOKEN).toBe(sentinel);
		return records;
	}
	return { root, bin, log, environment, shim, observations, assertChildren };
}

function binary(version: string, platform: string) {
	return Buffer.from(`${version}:${platform}:tiny-real-binary\n`.repeat(256));
}
async function fullBundle(root: string, version = "2.0.0") {
	const bundleDir = join(root, "bundle");
	await mkdir(join(bundleDir, "dist"), { recursive: true });
	const manifest: CiReleaseManifest = {
		schemaVersion: 1,
		plan: {
			schemaVersion: 1,
			repository: CI_RELEASE_REPOSITORY,
			tag: `v${version}`,
			version,
			commit,
			workflowCommit,
			bunVersion: CI_RELEASE_BUN,
			channel: "stable",
			changelog: { version, date: "2026-10-09", en: "Fixture", "zh-CN": "夹具" },
			runId: 101,
			runAttempt: 2,
			baselines: [],
		},
		files: [],
		smoke: [],
	};
	const metadata = [];
	for (const target of CI_RELEASE_TARGETS) {
		const name = `narrafork-${version}-${target.suffix}`;
		const bytes = binary(version, target.platform);
		const sidecar = computeBinaryMetadataFromBuffer(name, bytes, {
			version,
			platformId: target.platform,
			target: `bun-${target.target}`,
			commit,
			repository: CI_RELEASE_REPOSITORY,
			buildDate: "2026-10-09T00:00:00.000Z",
		});
		metadata.push(sidecar);
		await writeFile(join(bundleDir, "dist", name), bytes);
		await writeFile(join(bundleDir, "dist", `${name}.metadata.json`), formatMetadataJson(sidecar));
		manifest.smoke.push({
			schemaVersion: 1,
			repository: CI_RELEASE_REPOSITORY,
			target: target.target,
			commit,
			version,
			size: sidecar.size,
			sha256: sidecar.sha256,
			sha512: sidecar.sha512,
			checks: {
				startup: true,
				frontend: true,
				database: true,
				watcher: true,
				pty: true,
				signature: target.target.startsWith("darwin-"),
			},
		});
	}
	await writeFile(
		join(bundleDir, "dist", `narrafork-${version}-SHA256SUMS`),
		formatSha256Sums(metadata),
	);
	await writeFile(
		join(bundleDir, "dist", `narrafork-${version}-checksums.txt`),
		formatChecksumsReport(version, metadata),
	);
	for (const name of await readdir(join(bundleDir, "dist"))) {
		manifest.files.push({ name, ...(await hashReleaseFile(join(bundleDir, "dist", name))) });
	}
	await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
	return { bundleDir, manifest };
}

async function mirrorFixture(f: Awaited<ReturnType<typeof sandbox>>, fallback = false) {
	const { bundleDir, manifest } = await fullBundle(f.root);
	const storage = new LocalStorage(join(f.root, "legacy-server"));
	const app = new Hono();
	app.route("/api/v2/products", createReleaseRoutes(storage));
	app.route("/api/v2/products", createCheckRoutes(storage));
	app.route("/api/v2/products", createDownloadRoutes(storage));
	const meta: ReleaseMeta = {
		version: "1.0.0",
		channel: "stable",
		releaseDate: "2026-10-01T00:00:00.000Z",
		platforms: {},
	};
	for (const target of CI_RELEASE_TARGETS) {
		const filename = `narrafork-1.0.0-${target.suffix}`;
		const bytes = binary("1.0.0", target.platform);
		meta.platforms[target.platform] = {
			filename,
			size: bytes.length,
			sha512: createHash("sha512").update(bytes).digest("base64"),
			hasZstdPatch: false,
		};
		if (!fallback || target !== CI_RELEASE_TARGETS[0]) {
			await storage.saveFile(
				`products/narrafork/releases/1.0.0/${target.platform}/${filename}`,
				bytes,
			);
		}
	}
	await storage.saveFile(
		"products/narrafork/releases/1.0.0/meta.json",
		Buffer.from(JSON.stringify(meta)),
	);
	setCachedRelease("narrafork", meta);
	await initConfig(join(f.root, "fixture-update-config.json"));
	const fixtureToken = (await addToken("test-child-environment-only", "upload")).token;
	const config = resolveUpdateServerBridgeConfig({
		...f.environment,
		NF_UPDATE_TOKEN: fixtureToken,
	});
	if (!config) throw new Error("Fixture bridge config missing");
	const requests: { method: string; path: string; status: number }[] = [];
	const http = new UpdateServerBridgeHttp(config, {
		fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(request.method).toBe("GET");
			const response = await app.request(request);
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				status: response.status,
			});
			return response;
		}) as typeof fetch,
	});
	return { manifest, bundleDir, bridgeDir: join(f.root, "bridge"), http, config, requests };
}

describe("upload-only credentials never enter release preparation subprocesses", () => {
	test("real eight-platform legacy Hono prepare generates and rebuilds zstd without upload authority", async () => {
		const f = await sandbox();
		const fixture = await mirrorFixture(f);
		const before = await readFile(join(fixture.bundleDir, "manifest.json"), "utf8");
		setEnvironment(f.environment);
		const prepared = await prepareUpdateServerMainMirror({
			...fixture,
			run: () => {
				throw new Error("Unexpected GH request");
			},
		});
		expect(prepared.seal.platforms).toHaveLength(8);
		expect(prepared.seal.platforms.every((entry) => entry.patches.length === 1)).toBe(true);
		for (const entry of prepared.seal.platforms) {
			expect(await readFile(join(fixture.bundleDir, "dist", entry.full.filename))).toEqual(
				binary("2.0.0", entry.platform),
			);
		}
		expect(await readFile(join(fixture.bundleDir, "manifest.json"), "utf8")).toBe(before);
		expect(JSON.stringify(prepared)).not.toContain(sentinel);
		expect(process.env.NF_UPDATE_TOKEN).toBe(sentinel);
		const records = await f.assertChildren();
		expect(records.filter((entry) => entry.tool === "zstd")).toHaveLength(16);
	});

	test("legacy 404 falls back to real gh child download and independent verified SHA512", async () => {
		const f = await sandbox();
		const fixture = await mirrorFixture(f, true);
		const target = CI_RELEASE_TARGETS[0];
		const bytes = binary("1.0.0", target.platform);
		const asset = join(f.root, "gh-asset");
		await writeFile(asset, bytes);
		setEnvironment({ ...f.environment, FIXTURE_ASSET: asset });
		const prepared = await prepareUpdateServerMainMirror({
			...fixture,
			run: () =>
				JSON.stringify({
					draft: false,
					tag_name: "v1.0.0",
					assets: [
						{
							id: 77,
							name: `narrafork-1.0.0-${target.suffix}`,
							size: bytes.length,
							state: "uploaded",
						},
					],
				}),
		});
		expect(prepared.seal.platforms).toHaveLength(8);
		expect(
			fixture.requests.some((entry) => entry.status === 404 && entry.path.includes("/download/")),
		).toBe(true);
		const records = await f.assertChildren();
		expect(records.filter((entry) => entry.tool === "gh")).toHaveLength(1);
	});

	test("buffer CLI generation/application preserves exact bytes and filters both synchronous calls", async () => {
		const f = await sandbox();
		setEnvironment(f.environment);
		const oldBytes = binary("1.0.0", "linux-x64");
		const newBytes = binary("2.0.0", "linux-x64");
		const generated = generateZstdPatch(oldBytes, newBytes, {
			fromVersion: "1.0.0",
			toVersion: "2.0.0",
		});
		expect(applyZstdPatch(oldBytes, generated.patch, generated.meta, join(f.bin, "zstd"))).toEqual(
			newBytes,
		);
		expect(await f.assertChildren()).toHaveLength(2);
		expect(process.env.NF_UPDATE_TOKEN).toBe(sentinel);
	});

	test("asynchronous file generation and application filter tool environments without changing bytes", async () => {
		const f = await sandbox();
		setEnvironment(f.environment);
		const oldFilePath = join(f.root, "old.bin");
		const newFilePath = join(f.root, "new.bin");
		const patchOutputPath = join(f.root, "patch.zst");
		const newBytes = binary("2.0.0", "linux-x64");
		await writeFile(oldFilePath, binary("1.0.0", "linux-x64"));
		await writeFile(newFilePath, newBytes);
		const meta = await generateZstdPatchToFile({
			oldFilePath,
			newFilePath,
			patchOutputPath,
			fromVersion: "1.0.0",
			toVersion: "2.0.0",
		});
		const outputFilePath = join(f.root, "rebuilt.bin");
		await applyZstdPatchToFile({
			oldFilePath,
			patchFilePath: patchOutputPath,
			outputFilePath,
			meta,
		});
		expect(await readFile(outputFilePath)).toEqual(newBytes);
		expect(await f.assertChildren()).toHaveLength(2);
		expect(process.env.NF_UPDATE_TOKEN).toBe(sentinel);
	});

	test("CI and release gh runners and async helper tag queries share the same filtered environment", async () => {
		const f = await sandbox();
		const response = JSON.stringify({ object: { type: "commit", sha: commit } });
		const explicitEnvironment = { ...f.environment, FIXTURE_GH_RESPONSE: response };
		// ciGhRunner must use its explicit environment, before any process env mutation.
		expect(
			await ciGhRunner(explicitEnvironment)([
				"api",
				"repos/Fixture/Fork/git/ref/tags/helpers-v1.0.0",
			]),
		).toBe(response);
		setEnvironment(explicitEnvironment);
		expect(await runGh(["api", "repos/Fixture/Fork/git/ref/tags/helpers-v1.0.0"])).toBe(response);
		expect(await resolveHelperTagCommit({ repository: "Fixture/Fork" }, HELPER_RELEASE_TAG)).toBe(
			commit,
		);
		expect(await f.assertChildren()).toHaveLength(3);
		expect(process.env.NF_UPDATE_TOKEN).toBe(sentinel);
		expect(explicitEnvironment.NF_UPDATE_TOKEN).toBe(sentinel);
	});

	test("read-only gh query and failed download diagnostics contain no fake upload token", async () => {
		const f = await sandbox();
		setEnvironment({ ...f.environment, FIXTURE_GH_FAIL: "1" });
		let queryError: unknown;
		try {
			runCiGh(["api", "repos/Fixture/Fork"]);
		} catch (error) {
			queryError = error;
		}
		expect(String(queryError)).toContain("fixture child diagnostics");
		expect(String(queryError)).not.toContain(sentinel);
		let downloadError: unknown;
		try {
			await downloadReleaseAsset({
				repository: "Fixture/Fork",
				assetId: 77,
				size: 8,
				outputPath: join(f.root, "failed-asset"),
			});
		} catch (error) {
			downloadError = error;
		}
		expect(String(downloadError)).toContain("fixture child diagnostics");
		expect(String(downloadError)).not.toContain(sentinel);
		expect(await readdir(f.root)).not.toContain("failed-asset");
		expect(await f.assertChildren()).toHaveLength(2);
	});
});

async function restoreFixture(f: Awaited<ReturnType<typeof sandbox>>) {
	const { bundleDir, manifest } = await fullBundle(f.root);
	const archive = join(f.root, "bundle.zip");
	execFileSync(
		realPython,
		[
			"-I",
			"-c",
			"import os,sys,zipfile\nroot,out=sys.argv[1:]\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n for current,dirs,files in os.walk(root):\n  for name in files:\n   path=os.path.join(current,name); z.write(path,os.path.relpath(path,root))",
			bundleDir,
			archive,
		],
		{ timeout: 10000, maxBuffer: 65536 },
	);
	const bytes = await readFile(archive);
	const source = {
		id: 101,
		run_attempt: 2,
		workflow_id: 77,
		path: CI_RELEASE_WORKFLOW,
		event: "workflow_dispatch",
		head_branch: "main",
		head_sha: workflowCommit,
		status: "completed",
		conclusion: "success",
		repository: { id: 55, full_name: CI_RELEASE_REPOSITORY },
		head_repository: { id: 55, full_name: CI_RELEASE_REPOSITORY },
	};
	const artifact = {
		id: 900,
		name: "release-bundle-101-2",
		expired: false,
		size_in_bytes: bytes.length,
		digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		workflow_run: {
			id: 101,
			repository_id: 55,
			head_repository_id: 55,
			head_branch: "main",
			head_sha: workflowCommit,
		},
	};
	function contents(value: unknown) {
		const content = Buffer.from(JSON.stringify(value));
		return JSON.stringify({
			type: "file",
			encoding: "base64",
			size: content.length,
			content: content.toString("base64"),
		});
	}
	const run = async (args: string[]) => {
		const path = args[1].replace(`repos/${CI_RELEASE_REPOSITORY}`, "").replace(/^\//, "");
		if (!path) return JSON.stringify({ full_name: CI_RELEASE_REPOSITORY, default_branch: "main" });
		if (path === "actions/runs/101") return JSON.stringify(source);
		if (path === "actions/workflows/77")
			return JSON.stringify({ id: 77, path: CI_RELEASE_WORKFLOW, state: "active" });
		if (path.startsWith("actions/runs/101/attempts/"))
			return JSON.stringify({
				total_count: REQUIRED_RELEASE_SOURCE_JOBS.length,
				jobs: REQUIRED_RELEASE_SOURCE_JOBS.map((name, index) => ({
					id: index + 1,
					run_id: 101,
					run_attempt: 2,
					name,
					status: "completed",
					conclusion: "success",
					head_sha: workflowCommit,
				})),
			});
		if (path.startsWith("actions/runs/101/artifacts?"))
			return JSON.stringify({ total_count: 1, artifacts: [artifact] });
		if (path === "actions/artifacts/900") return JSON.stringify(artifact);
		if (path === "git/ref/heads/main")
			return JSON.stringify({ object: { type: "commit", sha: workflowCommit } });
		if (path.startsWith("compare/"))
			return JSON.stringify({ status: "ahead", merge_base_commit: { sha: path.slice(8, 48) } });
		if (path === "git/ref/tags/v2.0.0")
			return JSON.stringify({ object: { type: "commit", sha: commit } });
		if (path === `contents/package.json?ref=${commit}`)
			return contents({ version: "2.0.0", packageManager: `bun@${CI_RELEASE_BUN}` });
		if (path === `contents/changelogs/v2.0.0.json?ref=${commit}`)
			return contents(manifest.plan.changelog);
		if (path === `contents/scripts/lib/ci-release-types.ts?ref=${commit}`)
			return JSON.stringify({ type: "file", size: 100 });
		throw new Error(`Unexpected source fixture API ${path}`);
	};
	const env: NodeJS.ProcessEnv = {
		...f.environment,
		GITHUB_REPOSITORY: CI_RELEASE_REPOSITORY,
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REF: "refs/heads/main",
		GITHUB_WORKFLOW_REF: `${CI_RELEASE_REPOSITORY}/${CI_RELEASE_WORKFLOW}@refs/heads/main`,
		GITHUB_WORKFLOW_SHA: workflowCommit,
		GITHUB_SHA: workflowCommit,
		GITHUB_RUN_ID: "102",
		GITHUB_RUN_ATTEMPT: "1",
	};
	return {
		root: f.root,
		tag: "v2.0.0",
		sourceRunId: "101",
		destination: join(f.root, "restored"),
		env,
		run,
		fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			return new Response(bytes);
		}) as typeof fetch,
	};
}

describe("source ZIP restore uses only filtered explicitly supplied environment", () => {
	test("real Python extractor restores full bundle without inheriting publisher credentials", async () => {
		const f = await sandbox();
		const options = await restoreFixture(f);
		// PATH and credentials exist only in options.env, not in the test process.
		const restored = await restoreCiReleaseBundle(options);
		expect(restored.sourceRunId).toBe(101);
		expect(
			await readFile(
				join(options.destination, "dist", `narrafork-2.0.0-${CI_RELEASE_TARGETS[0].suffix}`),
			),
		).toEqual(binary("2.0.0", CI_RELEASE_TARGETS[0].platform));
		const records = await f.assertChildren();
		expect(records.map((entry) => entry.tool)).toEqual(["python3"]);
		expect(options.env.NF_UPDATE_TOKEN).toBe(sentinel);
		expect((await readdir(f.root)).some((name) => name.startsWith(".restored-restore-"))).toBe(
			false,
		);
	});

	test("existing caller directory remains intact and extractor never runs", async () => {
		const f = await sandbox();
		const options = await restoreFixture(f);
		await mkdir(options.destination);
		await writeFile(join(options.destination, "user-data"), "preserve");
		await expect(restoreCiReleaseBundle(options)).rejects.toThrow("already exists");
		expect(await readFile(join(options.destination, "user-data"), "utf8")).toBe("preserve");
		expect(await Bun.file(f.log).exists()).toBe(false);
	});

	test("already cancelled download leaves no extraction directory or caller data deletion", async () => {
		const f = await sandbox();
		const options = await restoreFixture(f);
		const signal = AbortSignal.abort(new Error("fake parent cancelled"));
		await expect(restoreCiReleaseBundle({ ...options, signal })).rejects.toThrow(
			"fake parent cancelled",
		);
		expect(await Bun.file(f.log).exists()).toBe(false);
		expect((await readdir(f.root)).some((name) => name.startsWith(".restored-restore-"))).toBe(
			false,
		);
		expect(await readdir(f.root)).not.toContain("restored");
	});

	test("active Python extractor is cancelled, awaited and owned extraction files removed", async () => {
		const f = await sandbox();
		const options = await restoreFixture(f);
		const marker = join(f.root, "python-started");
		options.env.FIXTURE_MARKER = marker;
		await f.shim(
			"python3",
			"import signal\nwith open(e['FIXTURE_MARKER']+'.tmp','w') as f: f.write(str(os.getpid()))\nos.replace(e['FIXTURE_MARKER']+'.tmp',e['FIXTURE_MARKER'])\nsignal.pause()",
		);
		const parent = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let watcher: ReturnType<typeof watch> | undefined;
		const ready = new Promise<void>((resolve, reject) => {
			watcher = watch(f.root, (_event, name) => {
				if (name === "python-started") resolve();
			});
			timer = setTimeout(() => reject(new Error("Fixture Python extractor did not start")), 2000);
		});
		const task = restoreCiReleaseBundle({ ...options, signal: parent.signal }).then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await ready;
			const pid = Number(await readFile(marker, "utf8"));
			parent.abort(new Error("fixture parent cancelled active Python"));
			expect(await task).toBeInstanceOf(Error);
			expect(() => process.kill(pid, 0)).toThrow();
			expect((await readdir(f.root)).some((name) => name.startsWith(".restored-restore-"))).toBe(
				false,
			);
			expect(await readdir(f.root)).not.toContain("restored");
			expect(await f.assertChildren()).toHaveLength(1);
		} finally {
			parent.abort();
			watcher?.close();
			if (timer) clearTimeout(timer);
			await task;
		}
	});
});

async function helperZipFixture(f: Awaited<ReturnType<typeof sandbox>>) {
	const bundle = join(f.root, "helper-input");
	await mkdir(bundle);
	const identity = (name: string, value: string) => ({
		name,
		size: Buffer.byteLength(value),
		sha256: createHash("sha256").update(value).digest("hex"),
	});
	const manifest = {
		schemaVersion: 1,
		repository: "Fixture/Fork",
		tag: HELPER_RELEASE_TAG,
		commit,
		catalogVersion: "1.0.0",
		files: HELPER_TOOLS.flatMap((tool) =>
			HELPER_PLATFORMS.map((platform) => ({
				tool,
				platform,
				toolVersion: HELPER_TOOL_VERSIONS[tool],
				...identity(getHelperAssetName(tool, platform), "binary"),
			})),
		),
		licenses: HELPER_LICENSE_FILES.map((name) => identity(name, "license")),
	};
	for (const entry of manifest.files) await writeFile(join(bundle, entry.name), "binary");
	for (const entry of manifest.licenses) await writeFile(join(bundle, entry.name), "license");
	await writeFile(join(bundle, HELPER_MANIFEST_FILENAME), JSON.stringify(manifest));
	const archive = join(f.root, "helper-source.zip");
	execFileSync(
		realPython,
		[
			"-I",
			"-c",
			"import os,sys,zipfile\nroot,out=sys.argv[1:]\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n for name in os.listdir(root): z.write(os.path.join(root,name),name)",
			bundle,
			archive,
		],
		{ timeout: 10000, maxBuffer: 65536 },
	);
	const bytes = await readFile(archive);
	await f.shim(
		"git",
		"# Read-only merge-base fixture; never invokes real git\nassert sys.argv[1:3]==['merge-base','--is-ancestor']",
	);
	await f.shim(
		"unzip",
		`os.execv(${JSON.stringify(realUnzip)},[${JSON.stringify(realUnzip)}]+sys.argv[1:])`,
	);
	const plan: HelperReleasePlan = {
		schemaVersion: 1,
		repository: "Fixture/Fork",
		defaultBranch: "trunk",
		tag: HELPER_RELEASE_TAG,
		commit,
		controlCommit: commit,
		kind: "helpers",
		version: "1.0.0",
		protocolVersion: 1,
		sourceRunId: "11",
		publish: true,
	};
	const names = [
		"Helper preflight",
		"Assemble exact helper bundle",
		...HELPER_PLATFORMS.flatMap((platform) => [
			`Build (${platform})`,
			`Native smoke (${platform})`,
		]),
	];
	const run = async (args: string[]) => {
		const path = args[1];
		if (args[0] !== "api" || args.length !== 2) throw new Error("Read-only helper provenance only");
		if (path.endsWith("/actions/runs/11"))
			return JSON.stringify({
				id: 11,
				status: "completed",
				event: "workflow_dispatch",
				head_repository: { full_name: plan.repository },
				path: ".github/workflows/helpers-release.yml",
				head_branch: "trunk",
				head_sha: commit,
				run_attempt: 1,
			});
		if (path.includes("/jobs?"))
			return JSON.stringify({
				total_count: names.length,
				jobs: names.map((name) => ({ name, conclusion: "success", run_id: 11, head_sha: commit })),
			});
		if (path.includes("/artifacts?"))
			return JSON.stringify({
				total_count: 1,
				artifacts: [
					{
						id: 44,
						name: `helper-bundle-helpers-${commit}`,
						expired: false,
						size_in_bytes: bytes.length,
						digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
						workflow_run: { id: 11 },
					},
				],
			});
		throw new Error(`Unexpected helper provenance ${path}`);
	};
	const environment = { ...f.environment, FIXTURE_ASSET: archive, GITHUB_RUN_ID: "22" };
	return { plan, environment, run, output: join(f.root, "helper-restored") };
}

describe("helper ZIP restore environment boundaries", () => {
	test("read-only git, gh archive download and real unzip all lack upload authority", async () => {
		const f = await sandbox();
		const fixture = await helperZipFixture(f);
		setEnvironment(fixture.environment);
		const result = await restoreHelperReleaseBundle(f.root, fixture.plan, fixture.output, {
			run: fixture.run,
			environment: fixture.environment,
		});
		expect(result.artifactId).toBe(44);
		expect(await readFile(join(fixture.output, HELPER_MANIFEST_FILENAME), "utf8")).toContain(
			"Fixture/Fork",
		);
		const records = await f.assertChildren();
		expect(records.map((entry) => entry.tool)).toEqual(["git", "gh", "unzip"]);
		expect(process.env.NF_UPDATE_TOKEN).toBe(sentinel);
		expect(fixture.environment.nf_update_token).toBe(sentinel);
	});

	test("existing helper caller files survive rejection and no extractor starts", async () => {
		const f = await sandbox();
		const fixture = await helperZipFixture(f);
		setEnvironment(fixture.environment);
		await mkdir(fixture.output);
		await writeFile(join(fixture.output, "user-data"), "preserve helper caller");
		await expect(
			restoreHelperReleaseBundle(f.root, fixture.plan, fixture.output, {
				run: fixture.run,
				environment: fixture.environment,
			}),
		).rejects.toThrow();
		expect(await readFile(join(fixture.output, "user-data"), "utf8")).toBe(
			"preserve helper caller",
		);
		expect((await readdir(f.root)).some((name) => name.startsWith(".helper-restore-"))).toBe(false);
		const records = await f.assertChildren();
		expect(records.map((entry) => entry.tool)).toEqual(["git", "gh"]);
	});
});
