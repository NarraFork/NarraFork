import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getHelperAssetName,
	HELPER_CATALOG_VERSION,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
} from "../../../shared/helper-distribution";
import type { MirrorAssetDescriptor } from "../../../shared/independent-update-mirror";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "../../../shared/remote-executor";
import {
	REMOTE_PEER_LICENSE_FILES,
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PLATFORMS,
	remotePeerPublishedFilename,
} from "../../../shared/remote-peer";
import { createApp } from "../../../update-server/app";
import { initConfig } from "../../../update-server/lib/config";
import { LocalStorage } from "../../../update-server/storage/local";
import { ensureExecutorBinary, resetExecutorManifestCache } from "../executor-binaries";
import {
	downloadHelperBinary,
	HELPER_BIN_DIR,
	resetHelperBinaryDownloadCache,
} from "../helper-binaries";
import { getCliHelperSpec } from "../helper-binary-platform";
import * as distribution from "../helper-distribution-runtime";
import { ensureRemotePeerBinary, resetRemotePeerManifestCache } from "../remote-peer-binaries";
import { settings } from "../settings";
import { BUILD_EXECUTOR_DISTRIBUTION, BUILD_REMOTE_PEER_DISTRIBUTION } from "../version";

const repository = "offline/fixture";
const originalFetch = globalThis.fetch;
const originalUpdate = settings.update;
const peer = BUILD_REMOTE_PEER_DISTRIBUTION;
if (!peer) throw new Error("Offline integration fixture requires the optional peer pin");
const executor = BUILD_EXECUTOR_DISTRIBUTION;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function binary(platform: string) {
	const bytes = Buffer.alloc(256);
	const arm = platform.endsWith("arm64");
	if (platform.startsWith("linux")) {
		bytes.writeUInt32BE(0x7f454c46, 0);
		bytes[4] = 2;
		bytes[5] = 1;
		bytes.writeUInt16LE(arm ? 183 : 62, 18);
	} else if (platform.startsWith("darwin")) {
		bytes.writeUInt32LE(0xfeedfacf, 0);
		bytes.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4);
	} else {
		bytes.write("MZ");
		bytes.writeUInt32LE(128, 60);
		bytes.writeUInt32LE(0x4550, 128);
		bytes.writeUInt16LE(arm ? 0xaa64 : 0x8664, 132);
	}
	return bytes;
}
function projection(kind: "helpers" | "executor" | "remote-peer") {
	const pin = kind === "remote-peer" ? peer : executor;
	if (!pin) throw new Error("Missing peer pin");
	const version = kind === "helpers" ? HELPER_CATALOG_VERSION : pin.version;
	const tag = `${kind}-v${version}`;
	const files =
		kind === "helpers"
			? HELPER_TOOLS.flatMap((tool) =>
					HELPER_PLATFORMS.map((platform) => ({
						tool,
						toolVersion: HELPER_TOOL_VERSIONS[tool],
						platform,
						name: getHelperAssetName(tool, platform),
					})),
				)
			: (kind === "executor" ? EXECUTOR_PLATFORMS : REMOTE_PEER_PLATFORMS).map((platform) => ({
					platform,
					name:
						kind === "executor"
							? executorPublishedFilename(version, platform)
							: remotePeerPublishedFilename(version, platform),
				}));
	const binaries: MirrorAssetDescriptor[] = files.map((file) => ({
		kind: `${kind}-binary`,
		version,
		platform: file.platform,
		name: file.name,
		size: 256,
		sha256: sha(binary(file.platform)),
	}));
	const content = "Fixture license\n";
	const licenses = (kind === "remote-peer" ? REMOTE_PEER_LICENSE_FILES : ["LICENSE.txt"]).map(
		(name) => ({ name, size: Buffer.byteLength(content), sha256: sha(Buffer.from(content)) }),
	);
	const manifest = {
		schemaVersion: 1,
		repository,
		tag,
		commit: "a".repeat(40),
		licenses,
		...(kind === "helpers"
			? {
					catalogVersion: HELPER_CATALOG_VERSION,
					files: files.map((file, i) => ({ ...file, size: 256, sha256: binaries[i].sha256 })),
				}
			: {
					manifest: {
						version,
						protocolVersion: pin.protocolVersion,
						releasedAt: "2026-10-27T00:00:00Z",
						platforms: Object.fromEntries(
							binaries.map((file) => [
								file.platform,
								{ filename: file.name, size: file.size, sha256: file.sha256 },
							]),
						),
					},
				}),
	};
	const manifestContent = JSON.stringify(manifest);
	const name =
		kind === "helpers"
			? HELPER_MANIFEST_FILENAME
			: kind === "executor"
				? EXECUTOR_MANIFEST_FILENAME
				: REMOTE_PEER_MANIFEST_FILENAME;
	return {
		schemaVersion: 1,
		repository,
		kind,
		tag,
		binaries,
		assets: [
			{
				name,
				content: manifestContent,
				size: Buffer.byteLength(manifestContent),
				sha256: sha(Buffer.from(manifestContent)),
			},
			...licenses.map((license) => ({ ...license, content })),
		],
	};
}
function resetMemory() {
	resetExecutorManifestCache();
	resetRemotePeerManifestCache();
	resetHelperBinaryDownloadCache();
	distribution.resetHelperDistributionCache();
}
let root: string;
let storage: LocalStorage;
let url: string;
let server: ReturnType<typeof Bun.serve>;
let githubRequests: string[];
let requests: string[];
let intercept: ((request: Request, response: Response) => Response | Promise<Response>) | undefined;
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "nf-offline-component-mirror-"));
	const config = join(root, "config.json");
	const { adminToken } = await initConfig(config);
	const data = JSON.parse(await Bun.file(config).text());
	data.mirrorRepositories = { narrafork: repository, another: repository };
	data.mirrorLimits = { minFreeBytes: 0, quotaBytes: 1024 * 1024 };
	writeFileSync(config, JSON.stringify(data));
	await initConfig(config);
	storage = new LocalStorage(join(root, "data"));
	const app = createApp(storage);
	intercept = undefined;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 1,
		async fetch(request) {
			const response = await app.fetch(request);
			return intercept ? intercept(request, response) : response;
		},
	});
	url = `http://127.0.0.1:${server.port}`;
	githubRequests = [];
	requests = [];
	globalThis.fetch = (async (input, init) => {
		const address =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requests.push(address);
		if (/(^|\.)(github\.com|githubusercontent\.com)$/.test(new URL(address).hostname)) {
			githubRequests.push(address);
			throw new Error("This host cannot reach GitHub");
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	settings.update = {
		...(originalUpdate ?? { channel: "stable", checkIntervalMinutes: 60, autoDownload: false }),
		source: "update-server",
		serverUrl: url,
		product: "narrafork",
		githubRepository: repository,
		proxy: { mode: "direct" },
	};
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	resetMemory();
	for (const kind of ["helpers", "executor", "remote-peer"] as const) {
		const value = projection(kind);
		for (const descriptor of value.binaries) {
			const uploaded = await fetch(
				`${url}/api/v3/products/narrafork/mirror/assets/${descriptor.sha256}`,
				{
					method: "PUT",
					headers: {
						authorization: `Bearer ${adminToken}`,
						"x-mirror-repository": repository,
						"x-mirror-kind": descriptor.kind,
						"x-mirror-name": descriptor.name,
						"x-mirror-size": String(descriptor.size),
						"x-mirror-version": descriptor.version,
						"x-mirror-platform": descriptor.platform ?? "",
					},
					body: Uint8Array.from(binary(descriptor.platform ?? "")),
				},
			);
			expect(uploaded.status).toBe(200);
			await uploaded.body?.cancel();
		}
		const committed = await fetch(
			`${url}/api/v3/products/narrafork/mirror/tools/${kind}/${value.tag}`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
				body: JSON.stringify(value),
			},
		);
		expect(committed.status).toBe(200);
		await committed.body?.cancel();
	}
	requests.length = 0;
});
afterEach(async () => {
	try {
		expect(githubRequests).toEqual([]);
	} finally {
		globalThis.fetch = originalFetch;
		settings.update = originalUpdate;
		mock.restore();
		resetMemory();
		await server?.stop(true);
		rmSync(root, { recursive: true, force: true });
		rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	}
});
function helper(tool: "rg" | "zstd" = "zstd") {
	const spec = getCliHelperSpec(tool, "linux", "x64");
	if (!spec) throw new Error("Missing helper fixture");
	return spec;
}
describe("cold-cache component mirror without any GitHub connectivity", () => {
	test("real ingest -> manifest -> verified peer/executor/rg/zstd binaries, with zero GitHub fetches", async () => {
		const result = await Promise.all([
			ensureRemotePeerBinary("linux-amd64"),
			ensureExecutorBinary("linux-amd64"),
			downloadHelperBinary(helper("rg")),
			downloadHelperBinary(helper("zstd")),
		]);
		for (const entry of result) {
			const path = typeof entry === "string" ? entry : entry?.path;
			if (!path) throw new Error("Expected verified mirror binary");
			expect(await Bun.file(path).bytes()).toEqual(binary("linux-x64"));
		}
		expect(requests).toHaveLength(7); // Three manifests (one shared catalog), four binaries.
		expect(
			requests.every((address) =>
				address.startsWith(`${url}/api/v3/products/narrafork/mirror/tools/`),
			),
		).toBe(true);
		expect(requests.filter((address) => address.endsWith(".json"))).toHaveLength(3);
		resetMemory();
		intercept = () => new Response(null, { status: 503 });
		expect((await ensureRemotePeerBinary("linux-amd64")).sha256).toBe(sha(binary("linux-x64")));
		expect((await ensureExecutorBinary("linux-amd64")).sha256).toBe(sha(binary("linux-x64")));
	});
	for (const field of ["repository", "tag", "filename", "protocol", "version"] as const)
		test(`mirror manifest with wrong ${field} is refused offline`, async () => {
			intercept = async (request, response) => {
				if (!request.url.endsWith(REMOTE_PEER_MANIFEST_FILENAME)) return response;
				const value = await response.json();
				if (field === "repository") value.repository = "foreign/namespace";
				if (field === "tag") value.tag = "remote-peer-v9.9.9";
				if (field === "filename") value.manifest.platforms["linux-amd64"].filename = "wrong-name";
				if (field === "protocol") value.manifest.protocolVersion++;
				if (field === "version") value.manifest.version = "9.9.9";
				return Response.json(value);
			};
			await expect(ensureRemotePeerBinary("linux-amd64")).rejects.toThrow(/not been published/);
			expect(requests).toHaveLength(1);
		});
	for (const mode of ["missing", "hash", "size", "arch", "redirect", "github-redirect"] as const)
		test(`${mode} binary fails without GitHub fallback or leftover temporary files`, async () => {
			intercept = (request, response) => {
				if (request.url.endsWith(".json")) return response;
				if (mode === "missing") return new Response(null, { status: 404 });
				if (mode === "redirect" || mode === "github-redirect")
					return new Response(null, {
						status: 302,
						headers: {
							location:
								mode === "redirect"
									? "https://foreign.example/file"
									: "https://github.com/offline/fixture/file",
						},
					});
				const bytes = binary(mode === "arch" ? "linux-arm64" : "linux-x64");
				if (mode === "hash") bytes[100] = 1;
				return new Response(Uint8Array.from(mode === "size" ? bytes.subarray(0, 100) : bytes));
			};
			await expect(ensureExecutorBinary("linux-amd64")).rejects.toThrow(/Failed to download/);
			expect(requests).toHaveLength(2);
			expect(requests.every((address) => address.startsWith(url))).toBe(true);
			expect(
				readdirSync(distribution.DISTRIBUTION_CACHE_DIR).some((name) => name.endsWith(".tmp")),
			).toBe(false);
		});
	test("same-length stored binary corruption is rejected against the mirrored manifest", async () => {
		await storage.saveFile(`mirror-objects/${sha(binary("linux-x64"))}`, Buffer.alloc(256, 1));
		await expect(ensureRemotePeerBinary("linux-amd64")).rejects.toThrow(/Failed to acquire/);
		expect(requests).toHaveLength(2);
	});
	for (const destination of [
		"https://github.com/offline/fixture/file",
		"https://api.github.com/repos/offline/fixture",
		"https://raw.githubusercontent.com/offline/fixture/manifest",
		"https://foreign.example/file",
	])
		test(`manifest redirect to ${new URL(destination).hostname} is blocked before fetch`, async () => {
			intercept = () => new Response(null, { status: 302, headers: { location: destination } });
			await expect(ensureRemotePeerBinary("linux-amd64")).rejects.toThrow(/not been published/);
			expect(requests).toHaveLength(1);
		});
	test("same-origin redirects keep both manifest and binary on the selected mirror", async () => {
		intercept = (request, response) =>
			request.url.includes("?redirected=1")
				? response
				: new Response(null, { status: 302, headers: { location: `${request.url}?redirected=1` } });
		expect((await ensureExecutorBinary("linux-amd64")).sha256).toBe(sha(binary("linux-x64")));
		expect(requests).toHaveLength(4);
	});
	test("GitHub-authority disk caches cannot masquerade as the new mirror's manifest", async () => {
		const qualifier = `${HELPER_RELEASE_TAG}:manifest`;
		const oldIdentity = `github:${repository}\0mirror:${url}\0narrafork`;
		const oldPath = join(
			distribution.DISTRIBUTION_CACHE_DIR,
			createHash("sha256").update(`${oldIdentity}\0${qualifier}`).digest("hex"),
		);
		const value = JSON.parse(projection("helpers").assets[0].content);
		await distribution.writeDistributionJson(oldPath, value);
		await distribution.writeDistributionJson(
			distribution.distributionPath({ source: "github", repository }, qualifier),
			value,
		);
		intercept = () => new Response(null, { status: 404 });
		expect(await downloadHelperBinary(helper())).toBeNull();
		expect(requests).toHaveLength(1);
	});
	test("missing mirror manifest fails closed with no GitHub fallback", async () => {
		intercept = () => new Response(null, { status: 404 });
		await expect(ensureExecutorBinary("linux-amd64")).rejects.toThrow(/manifest is unavailable/);
		expect(requests).toHaveLength(1);
	});
	test("stored manifest/license corruption and undeclared paths are never served", async () => {
		const base = `${url}/api/v3/products/narrafork/mirror/tools/helpers/${HELPER_RELEASE_TAG}/assets`;
		const license = await fetch(`${base}/LICENSE.txt`);
		expect(license.status).toBe(200);
		expect(await license.text()).toBe("Fixture license\n");
		expect((await fetch(`${base}/arbitrary.json`)).status).toBe(404);
		const value = projection("helpers");
		value.assets[1].content = "Corrupt license\n";
		await storage.saveFile(
			`mirror-tools/narrafork/helpers/tags/${HELPER_RELEASE_TAG}.json`,
			Buffer.from(JSON.stringify(value)),
		);
		expect((await fetch(`${base}/${HELPER_MANIFEST_FILENAME}`)).status).toBe(400);
		expect(await downloadHelperBinary(helper())).toBeNull();
	});
	for (const change of ["mode", "server", "product", "repository"] as const)
		test(`${change} switch cannot reuse a different source's manifest/binary cache`, async () => {
			const first = await downloadHelperBinary(helper());
			expect(first).not.toBeNull();
			const originalSource = distribution.captureHelperSource();
			if (!settings.update) throw new Error("Missing update settings");
			settings.update = {
				...settings.update,
				...(change === "mode"
					? { source: "github" as const }
					: change === "server"
						? { serverUrl: `${url}/another-server` }
						: change === "product"
							? { product: "another" }
							: { githubRepository: "other/namespace" }),
			};
			const nextSource = distribution.captureHelperSource();
			expect(distribution.distributionPath(nextSource, "manifest")).not.toBe(
				distribution.distributionPath(originalSource, "manifest"),
			);
			// Switching to direct GitHub is checked by identity only: no such request is allowed here.
			if (change !== "mode") expect(await downloadHelperBinary(helper())).toBeNull();
		});
	test("mirror manifest timeout and parent cancellation do not consult GitHub", async () => {
		const originalDeadline = distribution.withDeadline;
		const deadline = spyOn(distribution, "withDeadline").mockImplementation(
			(signal, milliseconds) => originalDeadline(signal, Math.min(milliseconds, 35)),
		);
		intercept = () => new Response(new ReadableStream());
		await expect(ensureRemotePeerBinary("linux-amd64")).rejects.toThrow(/not been published/);
		expect(deadline).toHaveBeenCalledWith(undefined, 10_000);
		const controller = new AbortController();
		const pending = ensureExecutorBinary("linux-amd64", { signal: controller.signal });
		controller.abort(new Error("offline mirror cancelled"));
		await expect(pending).rejects.toThrow("offline mirror cancelled");
	});
	test("mirrored helper binary response deadline is bounded and cleans temporary files", async () => {
		intercept = (request, response) =>
			request.url.endsWith(".json") ? response : new Response(new ReadableStream());
		expect(await downloadHelperBinary(helper(), { timeoutMs: 75 })).toBeNull();
		expect(requests).toHaveLength(2);
		expect(
			readdirSync(distribution.DISTRIBUTION_CACHE_DIR).some((name) => name.endsWith(".tmp")),
		).toBe(false);
	});
});
