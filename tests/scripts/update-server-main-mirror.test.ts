import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	computeBinaryMetadataFromBuffer,
	formatMetadataJson,
} from "../../scripts/lib/binary-metadata";
import { hashReleaseFile } from "../../scripts/lib/ci-release-io";
import { CI_RELEASE_TARGETS, type CiReleaseManifest } from "../../scripts/lib/ci-release-types";
import {
	BRIDGE_POST_LIMIT,
	resolveUpdateServerBridgeConfig,
	UpdateServerBridgeHttp,
} from "../../scripts/lib/update-server-bridge-http";
import { generateBridgePatch } from "../../scripts/lib/update-server-bridge-patch";
import {
	MAIN_MIRROR_TOTAL_TIMEOUT_MS,
	MirrorPublicationError,
	prepareUpdateServerMainMirror,
	publishUpdateServerMainMirror,
	restorePreparedMainMirror,
	verifyPreparedMainMirror,
} from "../../scripts/lib/update-server-main-mirror";
import { addToken, initConfig } from "../../update-server/lib/config";
import { invalidateProduct, setCachedRelease } from "../../update-server/lib/release-cache";
import { createCheckRoutes } from "../../update-server/routes/check";
import { createDownloadRoutes } from "../../update-server/routes/download";
import { createReleaseRoutes } from "../../update-server/routes/releases";
import { LocalStorage } from "../../update-server/storage/local";
import type { ReleaseMeta } from "../../update-server/types";

const roots: string[] = [];
let authRoot: string;
let token: string;
beforeAll(async () => {
	authRoot = await mkdtemp(join(tmpdir(), "nf-main-mirror-auth-"));
	await initConfig(join(authRoot, "config.json"));
	token = (await addToken("test-main-mirror-only", "upload")).token;
});
afterEach(async () => {
	invalidateProduct("narrafork");
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => {
	await rm(authRoot, { recursive: true, force: true });
});
function bytes(version: string, platform: string) {
	return Buffer.from(`${version}-${platform}-original-binary\n`.repeat(1024));
}
function sha512(value: Buffer) {
	return createHash("sha512").update(value).digest("base64");
}
async function fixture(channels: ("stable" | "beta")[] = ["beta"]) {
	invalidateProduct("narrafork");
	const root = await mkdtemp(join(tmpdir(), "nf-main-mirror-"));
	roots.push(root);
	const bundleDir = join(root, "bundle");
	const bridgeDir = join(root, "bridge");
	await mkdir(join(bundleDir, "dist"), { recursive: true });
	const storage = new LocalStorage(join(root, "server"));
	const app = new Hono();
	app.route("/api/v2/products", createReleaseRoutes(storage));
	app.route("/api/v2/products", createCheckRoutes(storage));
	app.route("/api/v2/products", createDownloadRoutes(storage));
	const config = resolveUpdateServerBridgeConfig({
		NF_UPDATE_SERVER: "https://bridge.example",
		NF_UPDATE_TOKEN: token,
	});
	if (!config) throw new Error("fixture configuration missing");
	const manifest: CiReleaseManifest = {
		schemaVersion: 1,
		plan: {
			schemaVersion: 1,
			repository: "NarraFork/NarraFork",
			tag: "v2.0.0",
			version: "2.0.0",
			commit: "a".repeat(40),
			workflowCommit: "b".repeat(40),
			bunVersion: "1.4.2",
			channel: "stable",
			changelog: { version: "2.0.0", date: "2026-10-09", en: "Release", "zh-CN": "发布" },
			runId: 12,
			runAttempt: 2,
			baselines: [],
		},
		files: [],
		smoke: [],
	};
	for (const target of CI_RELEASE_TARGETS) {
		const name = `narrafork-2.0.0-${target.suffix}`;
		const binary = bytes("2.0.0", target.platform);
		const sidecar = computeBinaryMetadataFromBuffer(name, binary, {
			version: "2.0.0",
			platformId: target.platform,
			target: `bun-${target.target}`,
			commit: manifest.plan.commit,
			repository: manifest.plan.repository,
			buildDate: "2026-10-09T00:00:00.000Z",
		});
		await writeFile(join(bundleDir, "dist", name), binary);
		await writeFile(join(bundleDir, "dist", `${name}.metadata.json`), formatMetadataJson(sidecar));
		for (const filename of [name, `${name}.metadata.json`])
			manifest.files.push({
				name: filename,
				...(await hashReleaseFile(join(bundleDir, "dist", filename))),
			});
	}
	await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
	async function seed(version: string, channel: "stable" | "beta", includeFull = true) {
		const meta: ReleaseMeta = {
			version,
			channel,
			releaseDate: "2026-10-01T00:00:00.000Z",
			platforms: {},
		};
		for (const target of CI_RELEASE_TARGETS) {
			const filename = `narrafork-${version}-${target.suffix}`;
			const binary = bytes(version, target.platform);
			meta.platforms[target.platform] = {
				filename,
				size: binary.length,
				sha512: sha512(binary),
				hasZstdPatch: false,
			};
			if (includeFull)
				await storage.saveFile(
					`products/narrafork/releases/${version}/${target.platform}/${filename}`,
					binary,
				);
		}
		await storage.saveFile(
			`products/narrafork/releases/${version}/meta.json`,
			Buffer.from(JSON.stringify(meta)),
		);
		setCachedRelease("narrafork", meta);
		return meta;
	}
	for (const channel of channels) await seed(channel === "stable" ? "1.0.0" : "1.1.0", channel);
	const requests: { method: string; path: string; platform?: string }[] = [];
	let failPlatform: string | undefined;
	let fakeSuccess = false;
	let requestHook: ((request: Request) => Promise<void> | void) | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		await requestHook?.(request);
		let platform: string | undefined;
		if (request.method === "POST")
			platform = (await request.clone().formData()).get("platform") as string;
		requests.push({ method: request.method, path, platform });
		if (request.method === "POST" && platform === failPlatform)
			return Response.json({ error: "test injected failure" }, { status: 503 });
		if (request.method === "POST" && fakeSuccess) return Response.json({ success: true });
		return app.request(request);
	}) as typeof fetch;
	const http = new UpdateServerBridgeHttp(config, { fetchImpl });
	const options = {
		manifest,
		bundleDir,
		bridgeDir,
		config,
		http,
		run: () => {
			throw new Error("Unexpected GitHub request in local fixture");
		},
	};
	return {
		root,
		manifest,
		bundleDir,
		bridgeDir,
		storage,
		app,
		config,
		options,
		http,
		requests,
		seed,
		hook(callback?: (request: Request) => Promise<void> | void) {
			requestHook = callback;
		},
		fail(platform?: string) {
			failPlatform = platform;
		},
		fake(value: boolean) {
			fakeSuccess = value;
		},
	};
}
async function addBundlePatch(f: Awaited<ReturnType<typeof fixture>>, matchSource = true) {
	const platform = CI_RELEASE_TARGETS[0];
	const full = `narrafork-2.0.0-${platform.suffix}`;
	const basis = join(f.root, "gh-source");
	await writeFile(basis, bytes(matchSource ? "1.1.0" : "1.0.9", platform.platform));
	const name = `${full}.from-1.1.0.zstd-patch`;
	const path = join(f.bundleDir, "dist", name);
	const metadata = await generateBridgePatch({
		oldFilePath: basis,
		newFilePath: join(f.bundleDir, "dist", full),
		patchOutputPath: path,
		fromVersion: "1.1.0",
		toVersion: "2.0.0",
		maxPatchBytes: 1024 * 1024,
		signal: AbortSignal.timeout(5000),
	});
	await writeFile(`${path}.meta.json`, JSON.stringify(metadata));
	for (const filename of [name, `${name}.meta.json`])
		f.manifest.files.push({
			name: filename,
			...(await hashReleaseFile(join(f.bundleDir, "dist", filename))),
		});
	await writeFile(join(f.bundleDir, "manifest.json"), JSON.stringify(f.manifest));
	return { name, metadata };
}

describe("eight-platform legacy mirror with real update-server routes and real zstd", () => {
	test("plans both legacy channels, reconstructs exact full bytes, keeps GH bundle unchanged, publishes and skips complete retry", async () => {
		const f = await fixture(["stable", "beta"]);
		const before = new Map(
			await Promise.all(
				f.manifest.files.map(
					async (file) =>
						[file.name, await hashReleaseFile(join(f.bundleDir, "dist", file.name))] as const,
				),
			),
		);
		const prepared = await prepareUpdateServerMainMirror(f.options);
		expect(prepared.seal.platforms).toHaveLength(8);
		expect(prepared.seal.platforms.every((platform) => platform.patches.length === 2)).toBe(true);
		expect(f.requests.every((request) => request.method === "GET")).toBe(true);
		expect(JSON.stringify(prepared)).not.toContain(token);
		expect(
			(await readdir(f.bridgeDir)).some(
				(name) => name.endsWith(".basis") || name.endsWith(".rebuilt"),
			),
		).toBe(false);
		for (const file of f.manifest.files) {
			const prior = before.get(file.name);
			if (!prior) throw new Error("Missing original fixture identity");
			expect(await hashReleaseFile(join(f.bundleDir, "dist", file.name))).toEqual(prior);
		}
		const receipt = await publishUpdateServerMainMirror(prepared, f.config, { http: f.http });
		expect(receipt.status).toBe("mirrored");
		expect(receipt.platforms.every((item) => item.status === "verified")).toBe(true);
		expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(16);
		for (const target of CI_RELEASE_TARGETS) {
			const response = await f.app.request(
				`https://bridge.example/api/v2/products/narrafork/releases/latest?channel=stable&platform=${target.platform}&version=1.0.0`,
			);
			const check = await response.json();
			expect(check.version).toBe("2.0.0");
			expect(check.zstdPatch.fromVersion).toBe("1.0.0");
		}
		await f.seed("3.0.0", "beta");
		await publishUpdateServerMainMirror(prepared, f.config, { http: f.http });
		expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(16);
	});
	test("exact GH patch is reused only with old server identity match", async () => {
		const f = await fixture();
		const gh = await addBundlePatch(f);
		const prepared = await prepareUpdateServerMainMirror(f.options);
		expect(prepared.seal.platforms[0].patches[0].origin).toBe("github-bundle");
		expect(await readFile(join(f.bridgeDir, gh.name))).toEqual(
			await readFile(join(f.bundleDir, "dist", gh.name)),
		);
	});
	test("large legacy dictionary GH patch is regenerated with streaming patch-from instead of whole-file buffering", async () => {
		const f = await fixture();
		const gh = await addBundlePatch(f);
		const target = CI_RELEASE_TARGETS[0];
		const oldBytes = Buffer.alloc(9 * 1024 * 1024, 65);
		const sourceMeta = await f.seed("1.1.0", "beta");
		const file = sourceMeta.platforms[target.platform];
		file.size = oldBytes.length;
		file.sha512 = sha512(oldBytes);
		await f.storage.saveFile(
			`products/narrafork/releases/1.1.0/${target.platform}/${file.filename}`,
			oldBytes,
		);
		await f.storage.saveFile(
			"products/narrafork/releases/1.1.0/meta.json",
			Buffer.from(JSON.stringify(sourceMeta)),
		);
		setCachedRelease("narrafork", sourceMeta);
		const metadataPath = join(f.bundleDir, "dist", `${gh.name}.meta.json`);
		await writeFile(
			metadataPath,
			JSON.stringify({
				...gh.metadata,
				mode: "dictionary",
				oldFileSize: file.size,
				oldFileSha512: file.sha512,
			}),
		);
		const record = f.manifest.files.find((entry) => entry.name === `${gh.name}.meta.json`);
		if (!record) throw new Error("Missing GH patch metadata fixture");
		Object.assign(record, await hashReleaseFile(metadataPath));
		await writeFile(join(f.bundleDir, "manifest.json"), JSON.stringify(f.manifest));
		const prepared = await prepareUpdateServerMainMirror(f.options);
		expect(prepared.seal.platforms[0].patches[0].origin).toBe("bridge-generated");
		expect(prepared.seal.platforms[0].patches[0].metadata.mode).toBe("patch-from");
		expect(prepared.seal.platforms[0].patches[0].metadata.oldFileSize).toBe(oldBytes.length);
	});
	test("different GH basis bytes produce separate bridge patch without modifying GH patch", async () => {
		const f = await fixture();
		const gh = await addBundlePatch(f, false);
		const original = await readFile(join(f.bundleDir, "dist", gh.name));
		const prepared = await prepareUpdateServerMainMirror(f.options);
		expect(prepared.seal.platforms[0].patches[0].origin).toBe("bridge-generated");
		expect(prepared.seal.platforms[0].patches[0].metadata.oldFileSha512).not.toBe(
			gh.metadata.oldFileSha512,
		);
		expect(await readFile(join(f.bundleDir, "dist", gh.name))).toEqual(original);
	});
	test("delta-only source uses exact already-public GH binary fallback, not tag rebuild", async () => {
		const f = await fixture();
		for (const target of CI_RELEASE_TARGETS)
			await f.storage.deleteFile(
				`products/narrafork/releases/1.1.0/${target.platform}/narrafork-1.1.0-${target.suffix}`,
			);
		const runArgs: string[][] = [];
		const prepared = await prepareUpdateServerMainMirror({
			...f.options,
			run: (args: string[]) => {
				runArgs.push(args);
				return JSON.stringify({
					draft: false,
					tag_name: "v1.1.0",
					assets: CI_RELEASE_TARGETS.map((target, index) => ({
						id: index + 1,
						name: `narrafork-1.1.0-${target.suffix}`,
						size: bytes("1.1.0", target.platform).length,
						state: "uploaded",
					})),
				});
			},
			downloadAsset: async ({ assetId, outputPath }) => {
				await writeFile(outputPath, bytes("1.1.0", CI_RELEASE_TARGETS[assetId - 1].platform), {
					flag: "wx",
				});
			},
		});
		expect(prepared.seal.platforms).toHaveLength(8);
		expect(runArgs).toHaveLength(8);
		expect(runArgs.every((args) => args.join(" ").includes("releases/tags/v1.1.0"))).toBe(true);
	});
	test("missing old full and unavailable GH stops instead of full-only success", async () => {
		const f = await fixture();
		const target = CI_RELEASE_TARGETS[0];
		await f.storage.deleteFile(
			`products/narrafork/releases/1.1.0/${target.platform}/narrafork-1.1.0-${target.suffix}`,
		);
		await expect(prepareUpdateServerMainMirror(f.options)).rejects.toThrow(
			"Legacy source binary unavailable",
		);
		expect(f.requests.every((request) => request.method === "GET")).toBe(true);
		expect((await readdir(f.bridgeDir)).includes("prepared-main-mirror.json")).toBe(false);
	});
	test("corrupt old full is not hidden by GH fallback", async () => {
		const f = await fixture();
		const target = CI_RELEASE_TARGETS[0];
		await f.storage.saveFile(
			`products/narrafork/releases/1.1.0/${target.platform}/narrafork-1.1.0-${target.suffix}`,
			Buffer.from("corrupt"),
		);
		let calls = 0;
		await expect(
			prepareUpdateServerMainMirror({
				...f.options,
				run: () => {
					calls++;
					return "{}";
				},
			}),
		).rejects.toThrow();
		expect(calls).toBe(0);
		expect(f.requests.every((request) => request.method === "GET")).toBe(true);
	});
	test("bad GH fallback bytes fail SHA512 even if tag/name/size agree", async () => {
		const f = await fixture();
		const target = CI_RELEASE_TARGETS[0];
		const original = bytes("1.1.0", target.platform);
		await f.storage.deleteFile(
			`products/narrafork/releases/1.1.0/${target.platform}/narrafork-1.1.0-${target.suffix}`,
		);
		await expect(
			prepareUpdateServerMainMirror({
				...f.options,
				run: () =>
					JSON.stringify({
						draft: false,
						tag_name: "v1.1.0",
						assets: [
							{
								id: 1,
								name: `narrafork-1.1.0-${target.suffix}`,
								size: original.length,
								state: "uploaded",
							},
						],
					}),
				downloadAsset: async ({ outputPath }) => {
					await writeFile(outputPath, Buffer.alloc(original.length, 1));
				},
			}),
		).rejects.toThrow("hash mismatch");
	});
	test("all target conflicts preflight before downloading or writing any platform", async () => {
		const f = await fixture();
		await f.seed("2.0.0", "stable");
		const metaResponse = await f.app.request(
			"https://bridge.example/api/v2/products/narrafork/releases/2.0.0/metadata",
		);
		const meta = (await metaResponse.json()) as ReleaseMeta;
		meta.platforms["darwin-arm64"].sha512 = sha512(Buffer.from("different"));
		setCachedRelease("narrafork", meta);
		await expect(prepareUpdateServerMainMirror(f.options)).rejects.toThrow("409");
		expect(
			f.requests.some(
				(request) => request.path.includes("/download/") || request.method === "POST",
			),
		).toBe(false);
	});
	test("newer server latest prevents initial stale mirror", async () => {
		const f = await fixture();
		await f.seed("3.0.0", "beta");
		await expect(prepareUpdateServerMainMirror(f.options)).rejects.toThrow("newer release");
		expect(f.requests.every((request) => request.method === "GET")).toBe(true);
	});
	test("invalid original full fails before any network read", async () => {
		const f = await fixture();
		await writeFile(join(f.bundleDir, "dist", f.manifest.files[0].name), "tampered");
		await expect(prepareUpdateServerMainMirror(f.options)).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	test("multipart capacity failure happens before network or any publication", async () => {
		const f = await fixture();
		const binary = f.manifest.files[0];
		const path = join(f.bundleDir, "dist", binary.name);
		const handle = await open(path, "r+");
		await handle.truncate(BRIDGE_POST_LIMIT - 32 * 1024);
		await handle.close();
		Object.assign(binary, await hashReleaseFile(path));
		const sidecarName = `${binary.name}.metadata.json`;
		const sidecarPath = join(f.bundleDir, "dist", sidecarName);
		const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
		Object.assign(sidecar, { size: binary.size, sha256: binary.sha256, sha512: binary.sha512 });
		await writeFile(sidecarPath, JSON.stringify(sidecar));
		const record = f.manifest.files.find((file) => file.name === sidecarName);
		if (!record) throw new Error("Missing sidecar fixture");
		Object.assign(record, await hashReleaseFile(sidecarPath));
		await writeFile(join(f.bundleDir, "manifest.json"), JSON.stringify(f.manifest));
		await expect(prepareUpdateServerMainMirror(f.options)).rejects.toThrow("256MiB");
		expect(f.requests).toHaveLength(0);
		expect(await Bun.file(join(f.bridgeDir, "prepared-main-mirror.json")).exists()).toBe(false);
	});
	test("no legacy basis is an explicit failure, never patchless publication", async () => {
		const f = await fixture([]);
		await expect(prepareUpdateServerMainMirror(f.options)).rejects.toThrow("full-only");
		expect(f.requests.every((request) => request.method === "GET")).toBe(true);
	});
	test("partial immediate-public upload yields recoverable receipt; original seal restores without choosing new basis", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		f.fail("linux-arm64");
		try {
			await publishUpdateServerMainMirror(prepared, f.config, { http: f.http });
			throw new Error("expected fail");
		} catch (error) {
			expect(error).toBeInstanceOf(MirrorPublicationError);
			if (!(error instanceof MirrorPublicationError)) throw error;
			expect(error.receipt.status).toBe("partial");
			expect(error.receipt.platforms.filter((item) => item.status === "verified")).toHaveLength(2);
			expect(JSON.stringify(error)).not.toContain(token);
		}
		const readsBefore = f.requests.length;
		const restored = await restorePreparedMainMirror({
			manifest: f.manifest,
			bundleDir: f.bundleDir,
			bridgeDir: f.bridgeDir,
			config: f.config,
			sealSha256: prepared.sealSha256,
		});
		expect(f.requests).toHaveLength(readsBefore);
		expect(restored.seal.platforms[0].patches[0].source.version).toBe("1.1.0");
		f.fail();
		const receipt = await publishUpdateServerMainMirror(restored, f.config, { http: f.http });
		expect(receipt.status).toBe("mirrored");
		expect(
			f.requests.filter((request) => request.method === "POST" && request.platform === "linux-x64"),
		).toHaveLength(1);
	});
	test("parent cancellation during serial publish preserves partial receipt and cleans snapshots", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		const controller = new AbortController();
		let writes = 0;
		f.hook(async (request) => {
			if (request.method === "POST" && ++writes === 3) {
				controller.abort();
				await new Promise<void>(() => {}); // transport fixture ignores abort; caller must still finish
			}
		});
		try {
			await publishUpdateServerMainMirror(prepared, f.config, {
				http: f.http,
				signal: controller.signal,
			});
			throw new Error("Expected cancellation");
		} catch (error) {
			expect(error).toBeInstanceOf(MirrorPublicationError);
			if (!(error instanceof MirrorPublicationError)) throw error;
			expect(error.receipt.failureCode).toBe("CANCELLED");
			expect(error.receipt.platforms.filter((item) => item.status === "verified")).toHaveLength(2);
		}
		const receipt = JSON.parse(
			await readFile(join(f.bridgeDir, "receipt-main-mirror.json"), "utf8"),
		);
		expect(receipt.status).toBe("partial");
		expect(receipt.failureCode).toBe("CANCELLED");
		expect((await readdir(f.bridgeDir)).some((name) => name.startsWith(".upload-"))).toBe(false);
	});
	test("success:true without public readback remains failure and recoverable", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		f.fake(true);
		await expect(
			publishUpdateServerMainMirror(prepared, f.config, { http: f.http }),
		).rejects.toBeInstanceOf(MirrorPublicationError);
		const receipt = JSON.parse(
			await readFile(join(f.bridgeDir, "receipt-main-mirror.json"), "utf8"),
		);
		expect(receipt.status).toBe("partial");
		expect(receipt.platforms.every((item: { status: string }) => item.status === "pending")).toBe(
			true,
		);
	});
	test("incomplete restore keeps original basis but refuses writes after legacy basis advances", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		await f.seed("1.2.0", "beta");
		const readsBefore = f.requests.length;
		const restored = await restorePreparedMainMirror({
			manifest: f.manifest,
			bundleDir: f.bundleDir,
			bridgeDir: f.bridgeDir,
			config: f.config,
			sealSha256: prepared.sealSha256,
		});
		expect(f.requests).toHaveLength(readsBefore);
		expect(restored.seal.platforms[0].patches[0].source.version).toBe("1.1.0");
		try {
			await publishUpdateServerMainMirror(restored, f.config, { http: f.http });
			throw new Error("Expected baseline failure");
		} catch (error) {
			expect(error).toBeInstanceOf(MirrorPublicationError);
			if (!(error instanceof MirrorPublicationError)) throw error;
			expect(error.receipt.failureCode).toBe("BASELINE_ADVANCED");
		}
		expect(f.requests.every((request) => request.method === "GET")).toBe(true);
	});
	test("frozen source drift prevents any new write", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		const old = await f.seed("1.1.0", "beta");
		old.platforms["darwin-arm64"].sha512 = sha512(Buffer.from("drift"));
		setCachedRelease("narrafork", old);
		await expect(
			publishUpdateServerMainMirror(prepared, f.config, { http: f.http }),
		).rejects.toBeInstanceOf(MirrorPublicationError);
		expect(f.requests.every((request) => request.method === "GET")).toBe(true);
	});
	test("restoration rejects wrong server, seal digest and patch tampering", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		await expect(
			verifyPreparedMainMirror(prepared, { serverUrl: "https://different.example", token }),
		).rejects.toThrow("server/product");
		await expect(
			verifyPreparedMainMirror({ ...prepared, sealSha256: "0".repeat(64) }, f.config),
		).rejects.toThrow("seal");
		await writeFile(join(f.bridgeDir, prepared.seal.platforms[0].patches[0].file), "tampered");
		await expect(verifyPreparedMainMirror(prepared, f.config)).rejects.toThrow("bytes changed");
	});
	test("parent cancellation aborts preparation before network", async () => {
		const f = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			prepareUpdateServerMainMirror({ ...f.options, signal: controller.signal }),
		).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	test("real route rejects changed published target with 409 and mismatched patch old identity with 400", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		const platform = prepared.seal.platforms[0];
		const patch = platform.patches[0];
		await f.seed("2.0.0", "stable");
		const form = new FormData();
		form.set("version", "2.0.0");
		form.set("channel", "stable");
		form.set("platform", platform.platform);
		form.set("file", new Blob(["different"]), platform.full.filename);
		const conflict = await f.app.request(
			"https://bridge.example/api/v2/products/narrafork/releases",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: form,
			},
		);
		expect(conflict.status).toBe(409);
		form.set(
			"file",
			Bun.file(join(f.bundleDir, "dist", platform.full.filename)),
			platform.full.filename,
		);
		form.set("zstdPatch", Bun.file(join(f.bridgeDir, patch.file)), patch.file);
		form.set(
			"zstdPatchMeta",
			new Blob([
				JSON.stringify({ ...patch.metadata, oldFileSha512: sha512(Buffer.from("wrong-old")) }),
			]),
			patch.metadataFile,
		);
		const mismatch = await f.app.request(
			"https://bridge.example/api/v2/products/narrafork/releases",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: form,
			},
		);
		expect(mismatch.status).toBe(400);
	});
	test.each([
		"full",
		"patch",
		"metadata",
	] as const)("same-length %s byte drift during public preflight fails before first POST", async (field) => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		const platform = prepared.seal.platforms[0];
		const patch = platform.patches[0];
		const path =
			field === "full"
				? join(f.bundleDir, "dist", platform.full.filename)
				: join(f.bridgeDir, field === "patch" ? patch.file : patch.metadataFile);
		const original = await readFile(path);
		let mutated = false;
		f.hook(async (request) => {
			if (!mutated && request.method === "GET") {
				mutated = true;
				const changed = Buffer.from(original);
				changed[0] ^= 1;
				await writeFile(path, changed); // same size, same source inode
			}
		});
		await expect(
			publishUpdateServerMainMirror(prepared, f.config, { http: f.http }),
		).rejects.toBeInstanceOf(MirrorPublicationError);
		expect(mutated).toBe(true);
		expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0);
		expect((await readdir(f.bridgeDir)).some((name) => name.startsWith(".upload-"))).toBe(false);
	});
	test.each([
		{ field: "full", replace: false },
		{ field: "patch", replace: false },
		{ field: "metadata", replace: false },
		{ field: "full", replace: true },
		{ field: "patch", replace: true },
		{ field: "metadata", replace: true },
	] as const)("private readonly multipart snapshot survives network-await source drift %#", async ({
		field,
		replace,
	}) => {
		const f = await fixture();
		const prepared = await prepareUpdateServerMainMirror(f.options);
		const platform = prepared.seal.platforms[0];
		const patch = platform.patches[0];
		const originalFull = await readFile(join(f.bundleDir, "dist", platform.full.filename));
		const originalPatch = await readFile(join(f.bridgeDir, patch.file));
		const originalMeta = await readFile(join(f.bridgeDir, patch.metadataFile));
		const path =
			field === "full"
				? join(f.bundleDir, "dist", platform.full.filename)
				: join(f.bridgeDir, field === "patch" ? patch.file : patch.metadataFile);
		const original = await readFile(path);
		let mutated = false;
		f.hook(async (request) => {
			if (!mutated && request.method === "POST") {
				mutated = true;
				const changed = Buffer.from(original);
				changed[0] ^= 1;
				if (replace) {
					await writeFile(`${path}.replacement`, changed);
					await rename(`${path}.replacement`, path);
				} else await writeFile(path, changed);
				// The request body has not been consumed yet. Only detached read-only snapshot FDs remain.
			}
		});
		const receipt = await publishUpdateServerMainMirror(prepared, f.config, { http: f.http });
		expect(mutated).toBe(true);
		expect(receipt.status).toBe("mirrored");
		const base = `products/narrafork/releases/2.0.0/${platform.platform}`;
		expect(await f.storage.getFile(`${base}/${platform.full.filename}`)).toEqual(originalFull);
		expect(await f.storage.getFile(`${base}/${patch.file}`)).toEqual(originalPatch);
		expect(await f.storage.getFile(`${base}/${patch.metadataFile}`)).toEqual(originalMeta);
		expect((await readdir(f.bridgeDir)).some((name) => name.startsWith(".upload-"))).toBe(false);
	});
	test("main mirror cannot exceed the existing 30-minute publisher wall budget", () => {
		expect(MAIN_MIRROR_TOTAL_TIMEOUT_MS).toBe(30 * 60 * 1000);
	});
	test("bounded zstd output cap fails, cleans file and does not publish", async () => {
		const f = await fixture();
		const basis = join(f.root, "basis");
		await writeFile(basis, bytes("1.1.0", "linux-x64"));
		const output = join(f.root, "limited.zstd-patch");
		await expect(
			generateBridgePatch({
				oldFilePath: basis,
				newFilePath: join(f.bundleDir, "dist", f.manifest.files[0].name),
				patchOutputPath: output,
				fromVersion: "1.1.0",
				toVersion: "2.0.0",
				maxPatchBytes: 1,
				signal: AbortSignal.timeout(5000),
			}),
		).rejects.toThrow("budget");
		expect(await Bun.file(output).exists()).toBe(false);
		expect(f.requests).toHaveLength(0);
	});
});
