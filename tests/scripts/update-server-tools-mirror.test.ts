import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseAssetDownloader } from "../../scripts/lib/ci-release-io";
import { UpdateServerMirrorHttp } from "../../scripts/lib/update-server-bridge-http";
import { IndependentMirrorError } from "../../scripts/lib/update-server-main-mirror";
import { prepareUpdateServerToolsMirror } from "../../scripts/lib/update-server-tools-mirror";
import { mirrorPublishedGitHubRelease } from "../../scripts/mirror-update-server";
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
import {
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PLATFORMS,
	remotePeerPublishedFilename,
} from "../../shared/remote-peer";
import { WebDavClient } from "../../shared/webdav-transport";
import { createApp } from "../../update-server/app";
import { initConfig } from "../../update-server/lib/config";
import { MirrorIngestService, parseTools } from "../../update-server/services/mirror-ingest";
import { MirrorRelayPuller } from "../../update-server/services/mirror-relay-pull";
import { LocalStorage } from "../../update-server/storage/local";
import { createWebDavFixture } from "../fixtures/webdav-fixture";
import { commit, config, repository, sha } from "./mirror-fixture";

function fixture(kind: "helpers" | "executor" | "remote-peer", versionOverride?: string) {
	const files = new Map<string, Buffer>();
	const artifact = (name: string) => {
		const content = Buffer.from(`${name}\n`);
		files.set(name, content);
		return { name, size: content.length, sha256: sha(content) };
	};
	const licenseName = kind === "remote-peer" ? "remote-peer-LICENSES.txt" : "LICENSE-test.txt";
	const licenses = [artifact(licenseName)];
	const version = versionOverride ?? (kind === "remote-peer" ? "0.1.0-alpha.1" : "1.2.0");
	const tag = kind === "helpers" ? HELPER_RELEASE_TAG : `${kind}-v${version}`;
	const manifest =
		kind === "helpers"
			? {
					schemaVersion: 1,
					repository,
					tag,
					commit,
					catalogVersion: "1.0.0",
					files: HELPER_TOOLS.flatMap((tool) =>
						HELPER_PLATFORMS.map((platform) => ({
							tool,
							platform,
							toolVersion: HELPER_TOOL_VERSIONS[tool],
							...artifact(getHelperAssetName(tool, platform)),
						})),
					),
					licenses,
				}
			: {
					schemaVersion: 1,
					repository,
					tag,
					commit,
					manifest: {
						version,
						protocolVersion: 1,
						releasedAt: "2026-07-01T00:00:00Z",
						platforms: Object.fromEntries(
							(kind === "remote-peer" ? REMOTE_PEER_PLATFORMS : EXECUTOR_PLATFORMS).map(
								(platform) => {
									const a = artifact(
										kind === "remote-peer"
											? remotePeerPublishedFilename(version, platform)
											: executorPublishedFilename(version, platform),
									);
									return [platform, { filename: a.name, size: a.size, sha256: a.sha256 }];
								},
							),
						),
					},
					licenses,
				};
	const manifestName =
		kind === "helpers"
			? HELPER_MANIFEST_FILENAME
			: kind === "executor"
				? EXECUTOR_MANIFEST_FILENAME
				: REMOTE_PEER_MANIFEST_FILENAME;
	files.set(manifestName, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
	const assets = [...files].map(([name, bytes], i) => ({
		id: i + 1,
		name,
		size: bytes.length,
		digest: `sha256:${sha(bytes)}`,
		state: "uploaded",
	}));
	const downloaded: string[] = [];
	const run = async (args: string[]) => {
		const path = args[1];
		if (!path.startsWith(`repos/${repository}/`)) throw new Error("Official fallback forbidden");
		if (path.includes("git/ref/tags/"))
			return JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: commit } });
		if (path.includes("releases/tags/"))
			return JSON.stringify({
				id: 9,
				tag_name: tag,
				draft: false,
				prerelease: kind === "remote-peer" && version.includes("-"),
				published_at: "2026-07-01T00:00:00Z",
			});
		if (path.includes("releases/9/assets?")) return JSON.stringify(assets);
		if (path.includes("releases/assets/")) {
			const asset = assets.find((a) => a.id === Number(path.split("/").at(-1)));
			if (!asset || ![manifestName, licenseName].includes(asset.name))
				throw new Error("Full helper/executor download forbidden");
			downloaded.push(asset.name);
			return files.get(asset.name)?.toString("utf8") ?? "";
		}
		throw new Error("Unrecognized read-only request");
	};
	let stored: unknown;
	const requests: string[] = [];
	const http = new UpdateServerMirrorHttp(config, {
		fetchImpl: (async (url: unknown, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			requests.push(path);
			if (init?.method === "PUT" && path.startsWith("/api/v3/products/narrafork/mirror/assets/")) {
				const headers = new Headers(init.headers);
				const name = headers.get("x-mirror-name") as string;
				const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
				expect(bytes.equals(files.get(name) ?? Buffer.alloc(0))).toBe(true);
				return Response.json({
					schemaVersion: 1,
					verification: "server-sha256",
					name,
					size: bytes.length,
					sha256: sha(bytes),
				});
			}
			if (path !== `/api/v3/products/narrafork/mirror/tools/${kind}/${tag}`)
				throw new Error("Old tools aliases forbidden");
			if (init?.method !== "POST") throw new Error("Producer GET is forbidden");
			stored = JSON.parse(String(init.body));
			const projection = stored as {
				assets: { name: string; size: number; sha256: string }[];
				binaries: { name: string; size: number; sha256: string }[];
			};
			return Response.json({
				schemaVersion: 1,
				verification: "server-sha256",
				repository,
				kind,
				tag,
				verified: [...projection.assets, ...projection.binaries].map(({ name, size, sha256 }) => ({
					name,
					size,
					sha256,
				})),
			});
		}) as unknown as typeof fetch,
	});
	const downloadAsset: ReleaseAssetDownloader = async ({ assetId, outputPath }) => {
		const asset = assets.find((a) => a.id === assetId);
		if (!asset) throw new Error("Unknown binary asset");
		await Bun.write(outputPath, files.get(asset.name) as Buffer);
	};
	return {
		options: { kind, repository, tag, config, run, http, downloadAsset },
		manifestName,
		licenseName,
		assets,
		files,
		downloaded,
		requests,
		get stored() {
			return stored;
		},
	};
}
function pause(signal: AbortSignal | undefined, ms: number) {
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
function concurrencyProbe(f: ReturnType<typeof fixture>, limit: number) {
	let releaseFirstBatch: () => void = () => {};
	const firstBatch = new Promise<void>((resolve) => {
		releaseFirstBatch = resolve;
	});
	let arrivals = 0;
	const live = new Map<string, string>();
	const paths: string[] = [];
	let peakFiles = 0;
	let active = 0;
	let peak = 0;
	const download = f.options.downloadAsset;
	f.options.downloadAsset = async (o) => {
		const hash = f.assets.find((a) => a.id === o.assetId)?.digest.slice(7) as string;
		live.set(hash, o.outputPath);
		paths.push(o.outputPath);
		peakFiles = Math.max(peakFiles, live.size);
		try {
			await download(o);
		} catch (error) {
			live.delete(hash);
			throw error;
		}
	};
	return {
		live,
		paths,
		get peak() {
			return peak;
		},
		get peakFiles() {
			return peakFiles;
		},
		async upload<T>(
			hash: string,
			signal: AbortSignal | undefined,
			action: () => Promise<T>,
		): Promise<T> {
			if (!live.has(hash)) return action();
			active++;
			peak = Math.max(peak, active);
			// Hold only the first batch: fixed delays depend on IO scheduling, and
			// later batches may have fewer than limit binaries remaining.
			if (++arrivals === limit) releaseFirstBatch();
			let abort: () => void = () => {};
			try {
				await new Promise<void>((resolve, reject) => {
					abort = () => reject(signal?.reason);
					signal?.addEventListener("abort", abort, { once: true });
					if (signal?.aborted) abort();
					else firstBatch.then(resolve);
				});
				return await action();
			} finally {
				signal?.removeEventListener("abort", abort);
				active--;
				live.delete(hash);
			}
		},
		verify(limit: number) {
			expect(peak).toBe(limit);
			expect(peakFiles).toBeLessThanOrEqual(limit);
			expect(active).toBe(0);
			expect(live.size).toBe(0);
			expect(new Set(paths).size).toBe(paths.length);
			for (const path of paths) expect(existsSync(path)).toBe(false);
		},
	};
}
describe("canonical auxiliary binary mirror", () => {
	for (const mode of [
		"draft",
		"unpublished",
		"prerelease",
		"origin",
		"commit",
		"tag",
		"partial",
		"missing-license",
		"license-limit",
		"metadata-count",
		"metadata-digest",
		"binary-digest",
		"binary-limit",
	] as const)
		test(`remote-peer ${mode} refuses before binary transfer or mirror writes`, async () => {
			const f = fixture("remote-peer");
			const manifest = JSON.parse(f.files.get(f.manifestName)?.toString() ?? "null");
			const updateAsset = (name: string, bytes: Buffer) => {
				f.files.set(name, bytes);
				const asset = f.assets.find((a) => a.name === name);
				if (!asset) throw new Error("fixture asset missing");
				asset.size = bytes.length;
				asset.digest = `sha256:${sha(bytes)}`;
			};
			if (mode === "origin") manifest.repository = "upstream/project";
			if (mode === "commit") manifest.commit = "f".repeat(40);
			if (mode === "tag") manifest.tag = "executor-v0.1.0-alpha.1";
			if (mode === "partial") delete manifest.manifest.platforms[REMOTE_PEER_PLATFORMS[0]];
			if (mode === "metadata-count")
				manifest.licenses = Array.from({ length: 16 }, () => ({ ...manifest.licenses[0] }));
			if (mode === "license-limit") {
				const bytes = Buffer.alloc(64 * 1024 + 1, 97);
				updateAsset(f.licenseName, bytes);
				Object.assign(manifest.licenses[0], { size: bytes.length, sha256: sha(bytes) });
			}
			if (mode === "binary-limit")
				manifest.manifest.platforms[REMOTE_PEER_PLATFORMS[0]].size = 32 * 1024 * 1024 + 1;
			updateAsset(f.manifestName, Buffer.from(JSON.stringify(manifest)));
			if (mode === "missing-license")
				f.assets.splice(
					f.assets.findIndex((a) => a.name === f.licenseName),
					1,
				);
			if (mode === "metadata-digest" || mode === "binary-digest") {
				const name =
					mode === "metadata-digest"
						? f.manifestName
						: manifest.manifest.platforms[REMOTE_PEER_PLATFORMS[0]].filename;
				const asset = f.assets.find((a) => a.name === name);
				if (!asset) throw new Error("fixture digest asset missing");
				asset.digest = `sha256:${"f".repeat(64)}`;
			}
			const run = f.options.run;
			f.options.run = async (args) => {
				const raw = await run(args);
				if (args[1].includes("releases/tags/")) {
					const release = JSON.parse(raw);
					if (mode === "draft") release.draft = true;
					if (mode === "unpublished") release.published_at = null;
					if (mode === "prerelease") release.prerelease = false;
					return JSON.stringify(release);
				}
				return raw;
			};
			let downloads = 0;
			f.options.downloadAsset = async () => {
				downloads++;
			};
			await expect(mirrorPublishedGitHubRelease(f.options)).rejects.toThrow();
			expect(downloads).toBe(0);
			expect(f.requests).toHaveLength(0);
		});
	test("peer tag ingress uses shared version bounds without widening legacy component tags", () => {
		for (const tag of [
			`remote-peer-v0.1.0-${"R".repeat(59)}`,
			"remote-peer-v0.1.0-alpha..RC1",
			"remote-peer-v0.1.0-alpha/RC1",
			"remote-peer-v0.1.0-alpha%2fRC1",
			"Remote-peer-v0.1.0-alpha.RC1",
			"executor-v0.1.0-alpha.RC1",
		])
			expect(() => parseTools({}, repository, "remote-peer", tag)).toThrow();
		for (const kind of ["helpers", "executor"] as const) {
			for (const version of ["0.1.0-alpha.RC1", `0.1.0-${"r".repeat(58)}`])
				expect(() => parseTools({}, repository, kind, `${kind}-v${version}`)).toThrow(
					"Invalid component identity",
				);
		}
	});
	test("remote-peer changed public prerelease summary is rejected before upload", async () => {
		const f = fixture("remote-peer");
		const run = f.options.run;
		let queries = 0;
		f.options.run = async (args) => {
			const result = await run(args);
			if (args[1].includes("releases/tags/") && ++queries === 2)
				return JSON.stringify({ ...JSON.parse(result), prerelease: false });
			return result;
		};
		await expect(mirrorPublishedGitHubRelease(f.options)).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	test("remote-peer projection preserves metadata-only compatibility and enforces exact complete descriptors", async () => {
		const f = fixture("remote-peer");
		await mirrorPublishedGitHubRelease(f.options);
		const projection = parseTools(f.stored, repository, "remote-peer", f.options.tag);
		expect(projection.binaries).toHaveLength(6);
		expect(
			parseTools({ ...projection, binaries: undefined }, repository, "remote-peer", f.options.tag)
				.binaries,
		).toBeUndefined();
		for (const changed of [
			{ ...projection, repository: "upstream/project" },
			{ ...projection, kind: "executor" },
			{ ...projection, tag: "executor-v0.1.0-alpha.1" },
			{ ...projection, binaries: projection.binaries?.slice(1) },
			{
				...projection,
				binaries: projection.binaries?.map((a) => ({ ...a, kind: "executor-binary" })),
			},
			{
				...projection,
				binaries: projection.binaries?.map((a) => ({ ...a, sha256: "f".repeat(64) })),
			},
			{ ...projection, assets: projection.assets.slice(0, 1) },
			{ ...projection, assets: Array.from({ length: 17 }, () => projection.assets[0]) },
		])
			expect(() => parseTools(changed, repository, "remote-peer", f.options.tag)).toThrow();
		expect(() => parseTools(projection, repository, "executor", f.options.tag)).toThrow("identity");
	});
	for (const kind of ["helpers", "executor", "remote-peer"] as const)
		for (const transport of ["direct", "webdav"] as const)
			test(`${kind} ${transport} failure cancels and joins in-flight uploads without commit or ready`, async () => {
				const f = fixture(kind);
				const binaries = f.assets.filter(
					(a) => a.name !== f.licenseName && !a.name.endsWith(".json"),
				);
				const successHash = binaries[0].digest.slice(7);
				const failureHash = binaries[1].digest.slice(7);
				let success: () => void = () => {};
				const accepted = new Promise<void>((resolve) => {
					success = resolve;
				});
				let active = 0;
				let canceled = 0;
				let commits = 0;
				const paths: string[] = [];
				const download = f.options.downloadAsset;
				f.options.downloadAsset = async (o) => {
					paths.push(o.outputPath);
					await download(o);
				};
				const transfer = async <T>(
					hash: string,
					signal: AbortSignal | undefined,
					action: () => Promise<T>,
				): Promise<T> => {
					active++;
					try {
						if (hash === successHash) {
							const result = await action();
							success();
							return result;
						}
						if (hash === failureHash) {
							await accepted;
							await pause(signal, 20);
							throw new Error("physical binary upload failed");
						}
						await pause(signal, 1000);
						return await action();
					} catch (error) {
						if (signal?.aborted) canceled++;
						throw error;
					} finally {
						active--;
					}
				};
				const raw = f.options.http.putRaw.bind(f.options.http);
				f.options.http.putRaw = (path, body, options) =>
					transfer(path.split("/").at(-1) as string, options.signal, () =>
						raw(path, body, options),
					);
				f.options.http.postJson = async () => {
					commits++;
					throw new Error("Partial commit forbidden");
				};
				const dav = createWebDavFixture();
				const davConfig = { url: dav.baseUrl, feed: "default", auth: { bearerToken: "fixture" } };
				const fetchDav = (async (url: unknown, init?: RequestInit) => {
					const path = new URL(String(url)).pathname;
					if (init?.method === "PUT" && path.includes("/objects/"))
						return transfer(path.split("/").at(-1) as string, init.signal ?? undefined, () =>
							dav.fetchImpl(url as string, init),
						);
					return dav.fetchImpl(url as string, init);
				}) as typeof fetch;
				try {
					await mirrorPublishedGitHubRelease({
						...f.options,
						transport,
						config: transport === "direct" ? config : undefined,
						relay: {
							config: davConfig,
							signingKey: Buffer.alloc(32, 3).toString("base64"),
							client: new WebDavClient(davConfig, { fetchImpl: fetchDav }),
						},
					});
					throw new Error("Expected failure");
				} catch (error) {
					expect(error).toBeInstanceOf(IndependentMirrorError);
					expect((error as IndependentMirrorError).receipt).toMatchObject({
						status: "FAILED",
						failureCode: "MIRROR_FAILED",
						uploaded: [binaries[0].name],
						verified: [],
						snapshotCommitted: false,
					});
				}
				expect(active).toBe(0);
				expect(canceled).toBeGreaterThan(0);
				expect(commits).toBe(0);
				expect([...dav.objects.keys()].some((p) => p.includes("/ready/"))).toBe(false);
				expect(paths.length).toBeLessThanOrEqual(4);
				for (const path of paths) expect(existsSync(path)).toBe(false);
			});
	for (const { kind, version } of [
		{ kind: "helpers", version: undefined },
		{ kind: "executor", version: undefined },
		{ kind: "remote-peer", version: undefined },
		{ kind: "remote-peer", version: "0.1.0-alpha.RC1" },
		{ kind: "remote-peer", version: `0.1.0-${"r".repeat(58)}` },
	] as const)
		for (const transport of ["direct", "webdav"] as const)
			for (const concurrency of [undefined, 8])
				test(`${kind} ${version ?? "default-version"} ${transport} concurrency=${concurrency ?? "default"} real producer/server roundtrip exposes verified exact-tag bytes`, async () => {
					const directory = await mkdtemp(join(tmpdir(), "nf-tools-roundtrip-"));
					let puller: MirrorRelayPuller | undefined;
					try {
						const configPath = join(directory, "config.json");
						const initialized = await initConfig(configPath);
						const operator = JSON.parse(await readFile(configPath, "utf8"));
						operator.mirrorRepositories = { narrafork: repository };
						operator.mirrorLimits = { minFreeBytes: 0, quotaBytes: 1024 * 1024 };
						await writeFile(configPath, JSON.stringify(operator));
						await initConfig(configPath);
						const storage = new LocalStorage(join(directory, "data"));
						const ingest = new MirrorIngestService(storage);
						const app = createApp(storage, ingest);
						const f = fixture(kind, version);
						if (kind === "remote-peer") {
							if (version?.length === 64) expect(f.options.tag.length).toBeGreaterThan(64);
							await ingest.commitTools(
								"narrafork",
								kind,
								f.options.tag,
								{
									schemaVersion: 1,
									repository,
									kind,
									tag: f.options.tag,
									assets: [f.manifestName, f.licenseName].map((name) => {
										const bytes = f.files.get(name) as Buffer;
										return {
											name,
											size: bytes.length,
											sha256: sha(bytes),
											content: bytes.toString(),
										};
									}),
								},
								new AbortController().signal,
							);
							expect(
								(await ingest.readTools("narrafork", kind, f.options.tag))?.binaries,
							).toBeUndefined();
							const unavailable = await app.request(
								`/api/v3/products/narrafork/mirror/tools/${kind}/${f.options.tag}/assets/${remotePeerPublishedFilename(f.options.tag.slice("remote-peer-v".length), "linux-amd64")}`,
							);
							expect(unavailable.status).toBe(404);
						}
						const limit = Math.min(
							concurrency ?? (transport === "direct" ? 2 : 3),
							f.assets.filter((a) => a.name !== f.licenseName && !a.name.endsWith(".json")).length,
						);
						const probe = concurrencyProbe(f, limit);
						const dav = createWebDavFixture();
						const webdav = { url: dav.baseUrl, feed: "default", auth: { bearerToken: "fixture" } };
						const signingKey = Buffer.alloc(32, 2).toString("base64");
						const requests: string[] = [];
						const configWithToken = { ...config, token: initialized.adminToken as string };
						const result = await mirrorPublishedGitHubRelease({
							...f.options,
							transport,
							uploadConcurrency: concurrency,
							config: transport === "direct" ? configWithToken : undefined,
							http: new UpdateServerMirrorHttp(configWithToken, {
								fetchImpl: (async (url: unknown, init?: RequestInit) => {
									requests.push(init?.method ?? "GET");
									if (init?.method === "PUT")
										return probe.upload(
											new URL(String(url)).pathname.split("/").at(-1) as string,
											init.signal ?? undefined,
											async () => app.request(String(url), init),
										);
									if (init?.method === "POST") expect(probe.live.size).toBe(0);
									return app.request(String(url), init);
								}) as typeof fetch,
							}),
							relay: {
								config: webdav,
								signingKey,
								client: new WebDavClient(webdav, {
									fetchImpl: (async (url: unknown, init?: RequestInit) => {
										const path = new URL(String(url)).pathname;
										if (init?.method === "PUT" && path.includes("/objects/"))
											return probe.upload(
												path.split("/").at(-1) as string,
												init.signal ?? undefined,
												() => dav.fetchImpl(url as string, init),
											);
										return dav.fetchImpl(url as string, init);
									}) as typeof fetch,
								}),
							},
						});
						if (transport === "webdav") {
							expect(result.status).toBe("STAGED_FOR_PULL");
							expect(result.verified).toHaveLength(0);
							expect(requests).toHaveLength(0);
							puller = new MirrorRelayPuller(
								storage,
								ingest,
								{
									webdav,
									signingKey,
									pollIntervalMs: 60_000,
									products: [{ product: "narrafork", repository }],
								},
								{ fetchImpl: dav.fetchImpl },
							);
							let committed = 0;
							for (let i = 0; i < 3; i++) committed += (await puller.pollOnce()).committed;
							expect(committed).toBe(1);
						} else {
							expect(result.status).toBe("MIRRORED");
							expect(result.verified).toHaveLength(f.assets.length);
							expect(requests).not.toContain("GET");
						}
						probe.verify(limit);
						const projection = await ingest.readTools("narrafork", kind, f.options.tag);
						expect(projection?.binaries?.length).toBe(kind === "helpers" ? 12 : 6);
						if (kind === "remote-peer") {
							await ingest.commitTools(
								"narrafork",
								kind,
								f.options.tag,
								{ ...projection, binaries: undefined },
								new AbortController().signal,
							);
							expect(
								(await ingest.readTools("narrafork", kind, f.options.tag))?.binaries,
							).toHaveLength(6);
						}
						for (const binary of projection?.binaries ?? []) {
							const response = await app.request(
								`/api/v3/products/narrafork/mirror/tools/${kind}/${f.options.tag}/assets/${binary.name}`,
							);
							expect(response.status).toBe(200);
							expect(
								Buffer.from(await response.arrayBuffer()).equals(
									f.files.get(binary.name) as Buffer,
								),
							).toBe(true);
						}
					} finally {
						await puller?.stop();
						await rm(directory, { recursive: true, force: true });
					}
				});
	test("explicit overall deadline aborts a stalled binary before uploads and retains failure receipt", async () => {
		const f = fixture("executor");
		f.options.downloadAsset = async ({ signal }) =>
			new Promise<void>((_, reject) => {
				if (signal?.aborted) return reject(signal.reason);
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		try {
			await mirrorPublishedGitHubRelease({ ...f.options, totalTimeoutMs: 40 });
			throw new Error("Expected deadline failure");
		} catch (error) {
			expect(
				(error as { receipt: { failureCode: string; snapshotCommitted: boolean } }).receipt,
			).toMatchObject({ failureCode: "CANCELLED", snapshotCommitted: false });
		}
		expect(f.requests).toHaveLength(0);
	});
	test("corrupt GitHub binary download never reaches server or ready publication", async () => {
		const f = fixture("helpers");
		f.options.downloadAsset = async ({ outputPath, size }) => {
			await Bun.write(outputPath, Buffer.alloc(size, 1));
		};
		await expect(mirrorPublishedGitHubRelease(f.options)).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	test("binary bytes count toward the bounded total before any download/upload", async () => {
		const f = fixture("executor");
		let downloaded = false;
		f.options.downloadAsset = async () => {
			downloaded = true;
		};
		await expect(
			mirrorPublishedGitHubRelease({ ...f.options, maxTotalBytes: 1 }),
		).rejects.toThrow();
		expect(downloaded).toBe(false);
		expect(f.requests).toHaveLength(0);
	});
	test("cancelled producer never uploads or commits after binary download", async () => {
		const f = fixture("executor");
		const controller = new AbortController();
		f.options.downloadAsset = async () => {
			controller.abort();
		};
		await expect(
			mirrorPublishedGitHubRelease({ ...f.options, signal: controller.signal }),
		).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	for (const kind of ["helpers", "executor", "remote-peer"] as const)
		test(`${kind} mirrors raw manifest/license metadata and separate streamed binaries`, async () => {
			const f = fixture(kind);
			const result = await mirrorPublishedGitHubRelease(f.options);
			expect(result.status).toBe("MIRRORED");
			expect(result.snapshotCommitted).toBe(true);
			expect(f.downloaded.sort()).toEqual([f.manifestName, f.licenseName].sort());
			expect(f.requests).toHaveLength(f.assets.length - 1);
			const stored = f.stored as { assets: { name: string; content: string }[] };
			expect(stored.assets).toHaveLength(2);
			for (const asset of stored.assets) {
				const bytes = f.files.get(asset.name);
				if (!bytes) throw new Error("Missing expected metadata fixture");
				expect(asset.content).toBe(bytes.toString("utf8"));
			}
		});
	for (const kind of ["helpers", "executor", "remote-peer"] as const) {
		test(`${kind} WebDAV staging is accepted bytes only, no server requests`, async () => {
			const f = fixture(kind);
			const dav = createWebDavFixture();
			const davConfig = {
				url: dav.baseUrl,
				feed: "default",
				auth: { bearerToken: "fixture-token" },
			};
			const result = await mirrorPublishedGitHubRelease({
				...f.options,
				config: undefined,
				transport: "webdav",
				relay: {
					config: davConfig,
					signingKey: Buffer.alloc(32, 1).toString("base64"),
					client: new WebDavClient(davConfig, { fetchImpl: dav.fetchImpl }),
				},
			});
			expect(result.status).toBe("STAGED_FOR_PULL");
			expect(result.snapshotCommitted).toBe(false);
			expect(result.uploaded).toHaveLength(f.assets.length);
			expect(result.verified).toEqual([]);
			expect(f.requests).toHaveLength(0);
			expect(dav.requests.some((r) => r.method === "GET")).toBe(false);
			expect(dav.requests.filter((r) => r.method === "PUT").at(-1)?.path).toContain(
				`/ready/narrafork/${kind}/`,
			);
		});
		for (const field of [
			"download_count",
			"label",
			"url",
			"browser_download_url",
			"id",
			"name",
			"size",
			"digest",
			"state",
		] as const)
			test(`${kind} final source check binds identity, not volatile ${field}`, async () => {
				const f = fixture(kind);
				const run = f.options.run;
				let assetReads = 0;
				f.options.run = async (args) => {
					if (args[1].includes("/releases/9/assets?") && ++assetReads === 2)
						Object.assign(f.assets[0], {
							[field]: {
								download_count: 123,
								label: "updated label",
								url: "https://api.example.test/changed",
								browser_download_url: "https://downloads.example.test/changed",
								id: 999,
								name: "renamed-asset",
								size: f.assets[0].size + 1,
								digest: `sha256:${"f".repeat(64)}`,
								state: "deleted",
							}[field],
						});
					return run(args);
				};
				if (["id", "name", "size", "digest", "state"].includes(field)) {
					await expect(mirrorPublishedGitHubRelease(f.options)).rejects.toThrow();
					expect(f.requests).toHaveLength(0);
				} else {
					expect((await mirrorPublishedGitHubRelease(f.options)).status).toBe("MIRRORED");
					expect(f.requests).toHaveLength(f.assets.length - 1);
				}
				expect(assetReads).toBe(["id", "name", "size", "digest", "state"].includes(field) ? 2 : 3);
			});
		for (const result of [
			{ ok: true },
			{
				schemaVersion: 1,
				verification: "server-sha256",
				repository,
				kind,
				tag: "wrong",
				verified: [],
			},
		])
			test(`${kind} legacy/forged commit receipt never triggers GET fallback`, async () => {
				const f = fixture(kind);
				f.options.http.postJson = async () => result;
				await expect(mirrorPublishedGitHubRelease(f.options)).rejects.toThrow(
					"upgrade update server",
				);
				expect(f.requests).toHaveLength(f.assets.length - 2);
			});
	}
	test("missing trusted public binary digest rejects metadata projection without downloading it", async () => {
		const f = fixture("executor");
		f.assets[0].digest = "";
		await expect(mirrorPublishedGitHubRelease(f.options)).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	test("wrong declared license hash rejects before mirror writes", async () => {
		const f = fixture("helpers");
		f.files.set("LICENSE-test.txt", Buffer.from("corrupt"));
		await expect(mirrorPublishedGitHubRelease(f.options)).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	test("online preview is read-only and uses no mirror config", async () => {
		const f = fixture("executor");
		expect(
			(await mirrorPublishedGitHubRelease({ ...f.options, config: undefined, dryRun: true }))
				.status,
		).toBe("DRY_RUN");
		expect(f.requests).toHaveLength(0);
	});
	test("pre-publication bundle sealing cannot revive retired tool aliases", async () => {
		await expect(prepareUpdateServerToolsMirror({ bridgeDir: "untrusted" })).rejects.toThrow(
			"retired",
		);
	});
});
