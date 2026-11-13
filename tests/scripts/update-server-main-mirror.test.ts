import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveUpdateServerMirrorConfig,
	UpdateServerMirrorHttp,
} from "../../scripts/lib/update-server-bridge-http";
import {
	IndependentMirrorError,
	prepareUpdateServerMainMirror,
} from "../../scripts/lib/update-server-main-mirror";
import { mirrorPublishedGitHubRelease } from "../../scripts/mirror-update-server";
import { mergeUpdateIndex } from "../../shared/update-index";
import { createApp } from "../../update-server/app";
import { initConfig } from "../../update-server/lib/config";
import { LocalStorage } from "../../update-server/storage/local";
import { config, mirrorFixture, repository, sha } from "./mirror-fixture";

const options = (fixture: ReturnType<typeof mirrorFixture>) => ({
	kind: "main" as const,
	repository,
	tag: fixture.release.tag,
	config,
	run: fixture.run,
	http: fixture.http,
	downloadAsset: fixture.downloadAsset,
});
describe("canonical independent main mirror", () => {
	test("remote frontend release extras are ignored without extending main mirror or index DTOs", async () => {
		const f = mirrorFixture();
		const originalIndex = structuredClone(f.index);
		for (const [index, suffix] of ["tar.gz", "manifest.json"].entries())
			f.assets.push({
				id: 900 + index,
				name: `narrafork-${f.release.version}-remote-frontend.${suffix}`,
				size: 12,
				digest: `sha256:${"c".repeat(64)}`,
				state: "uploaded",
			});
		const receipt = await mirrorPublishedGitHubRelease(options(f));
		expect(receipt.status).toBe("MIRRORED");
		expect(f.committed?.index).toEqual(originalIndex);
		expect(f.committed?.assets.some((asset) => asset.name.includes("remote-frontend"))).toBe(false);
		expect(f.downloaded.some((id) => id >= 900)).toBe(false);
	});
	test("explicit overall deadline reaches main download instead of restarting the default budget", async () => {
		const f = mirrorFixture(true);
		const downloadAsset = async ({ signal }: { signal?: AbortSignal }) =>
			new Promise<void>((_, reject) => {
				if (signal?.aborted) return reject(signal.reason);
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		await expect(
			mirrorPublishedGitHubRelease({ ...options(f), downloadAsset, totalTimeoutMs: 40 }),
		).rejects.toThrow();
		expect(f.httpCalls.some((r) => r.method === "POST")).toBe(false);
	});
	for (const withPatch of [true, false])
		test(`empty real Hono and LocalStorage server commits ${withPatch ? "current raw patch" : "metadata-only"} with server verification and no GET readback`, async () => {
			const root = await mkdtemp(join(tmpdir(), "nf-producer-server-e2e-"));
			try {
				const configFile = join(root, "config.json");
				const initialized = await initConfig(configFile);
				if (!initialized.adminToken) throw new Error("Missing isolated fixture token");
				const operatorConfig = JSON.parse(await readFile(configFile, "utf8"));
				operatorConfig.mirrorRepositories = { narrafork: repository };
				operatorConfig.mirrorLimits = {
					minFreeBytes: 0,
					quotaBytes: 1024 * 1024,
					uploadTimeoutMs: 1000,
				};
				await writeFile(configFile, JSON.stringify(operatorConfig));
				await initConfig(configFile);
				const storage = new LocalStorage(join(root, "data"));
				const app = createApp(storage);
				const f = mirrorFixture(withPatch);
				const serverConfig = { ...config, token: initialized.adminToken };
				const requests: { path: string; method: string; status: number }[] = [];
				const http = new UpdateServerMirrorHttp(serverConfig, {
					fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
						const response = await app.request(String(url), init);
						requests.push({
							path: new URL(String(url)).pathname,
							method: init?.method ?? "GET",
							status: response.status,
						});
						return response;
					}) as unknown as typeof fetch,
				});
				const asset = [...f.raw.keys()].find((name) => name.endsWith(".metadata.json")) as string;
				const sidecar = f.raw.get(asset);
				if (!sidecar) throw new Error("Missing sidecar fixture");
				expect(
					(await app.request(`/api/v3/products/narrafork/mirror/assets/${sha(sidecar)}`)).status,
				).toBe(404);
				const result = await mirrorPublishedGitHubRelease({
					...options(f),
					config: serverConfig,
					http,
				});
				expect(result.status).toBe(withPatch ? "MIRRORED" : "METADATA_ONLY");
				expect(result.uploaded).toEqual(result.verified);
				expect(result.snapshotCommitted).toBe(true);
				const commitAt = requests.findIndex(
					(r) => r.method === "POST" && r.path.endsWith("/snapshot"),
				);
				expect(commitAt).toBeGreaterThan(0);
				expect(
					requests.slice(0, commitAt).every((r) => r.method === "PUT" && r.status === 200),
				).toBe(true);
				expect(requests.slice(commitAt + 1)).toHaveLength(0);
				expect(requests.some((r) => r.method === "GET")).toBe(false);
				expect(result.verification).toBe("server-sha256");
				expect(result.uploaded).not.toContain(f.name);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	test("copies only current raw patch/sidecars/notes; never full binary or historical server state", async () => {
		const f = mirrorFixture();
		const receipt = await mirrorPublishedGitHubRelease(options(f));
		expect(receipt.status).toBe("MIRRORED");
		expect(receipt.snapshotCommitted).toBe(true);
		expect(f.downloaded).toHaveLength(1);
		expect(f.committed?.index).toEqual(f.index);
		for (const asset of f.committed?.assets ?? []) {
			const expected = asset.kind === "notes" ? Buffer.from(f.notesRaw) : f.raw.get(asset.name);
			expect(f.stored.get(asset.sha256)).toEqual(expected);
			expect(asset.name).not.toBe(f.name);
		}
		const write = f.httpCalls.findIndex((c) => c.path.endsWith("/snapshot"));
		expect(
			f.httpCalls
				.slice(0, write)
				.every((c) => !c.path.includes("/index") && !c.path.includes("/availability")),
		).toBe(true);
		expect(f.indexReads).toBeGreaterThanOrEqual(2); // fresh GitHub index immediately before commit
		expect(
			f.httpCalls
				.filter((c) => c.method === "PUT")
				.every((c) => c.headers.get("authorization") === `Bearer ${config.token}`),
		).toBe(true);
	});
	test.each([
		true,
		false,
	])("build metadata version mirrors canonical assets (patch=%s)", async (withPatch) => {
		const f = mirrorFixture(withPatch, true, "1.2.0+build.42");
		const receipt = await mirrorPublishedGitHubRelease(options(f));
		expect(receipt.status).toBe(withPatch ? "MIRRORED" : "METADATA_ONLY");
		expect(receipt.tag).toBe("v1.2.0+build.42");
		expect(receipt.snapshotCommitted).toBe(true);
		expect(f.committed?.targetVersion).toBe("1.2.0+build.42");
		for (const asset of f.committed?.assets ?? []) {
			const expected = asset.kind === "notes" ? Buffer.from(f.notesRaw) : f.raw.get(asset.name);
			expect(f.stored.get(asset.sha256)).toEqual(expected);
		}
		expect(receipt.uploaded.some((name) => name.includes("+build.42"))).toBe(true);
		expect(receipt.uploaded).not.toContain(f.name);
	});
	test("no-patch current release is legal metadata-only even empty mirror or old v999 garbage", async () => {
		const f = mirrorFixture(false);
		f.stored.set(sha("historical-v999"), Buffer.from("unrelated old data"));
		expect((await mirrorPublishedGitHubRelease(options(f))).status).toBe("METADATA_ONLY");
		expect(f.downloaded).toHaveLength(0);
		expect(f.stored.has(sha("historical-v999"))).toBe(true);
	});
	test("preview revalidates public GitHub identity without mirror token or server calls", async () => {
		const f = mirrorFixture();
		expect(
			(await mirrorPublishedGitHubRelease({ ...options(f), config: undefined, dryRun: true }))
				.status,
		).toBe("DRY_RUN");
		expect(f.httpCalls).toHaveLength(0);
		expect(f.downloaded).toHaveLength(0);
	});
	test("two empty configuration fields skip without consuming primary/GitHub work", async () => {
		const f = mirrorFixture();
		expect(resolveUpdateServerMirrorConfig({})).toBeUndefined();
		expect((await mirrorPublishedGitHubRelease({ ...options(f), config: undefined })).status).toBe(
			"SKIPPED_UNCONFIGURED",
		);
		expect(f.ghCalls).toHaveLength(0);
		expect(f.httpCalls).toHaveLength(0);
	});
	for (const env of [
		{ NF_UPDATE_SERVER: config.serverUrl },
		{ NF_UPDATE_TOKEN: "only-token" },
		{ NF_UPDATE_SERVER: "http://bad.invalid", NF_UPDATE_TOKEN: "token" },
		{ NF_UPDATE_SERVER: `${config.serverUrl}/other`, NF_UPDATE_TOKEN: "token" },
	])
		test("partial/invalid configuration fails independently", () =>
			expect(() => resolveUpdateServerMirrorConfig(env)).toThrow());
	test("bad runtime configuration returns an independent config receipt before GitHub/network", async () => {
		const f = mirrorFixture();
		try {
			await mirrorPublishedGitHubRelease({
				...options(f),
				config: { ...config, serverUrl: "http://invalid" },
			});
			throw new Error("must reject");
		} catch (error) {
			expect(error).toBeInstanceOf(IndependentMirrorError);
			expect((error as IndependentMirrorError).receipt.failureCode).toBe("FAILED_CONFIG");
		}
		expect(f.ghCalls).toHaveLength(0);
	});
	for (const corrupt of ["draft", "tag", "digest", "index", "orphan"] as const)
		test(`rejects current source ${corrupt} without uploading`, async () => {
			const f = mirrorFixture();
			if (corrupt === "draft") f.publicRelease.draft = true;
			if (corrupt === "tag") f.publicRelease.tag_name = "v1.3.0";
			if (corrupt === "digest") f.assets[0].digest = "";
			if (corrupt === "index") f.index.releases[0].commit = "c".repeat(40);
			if (corrupt === "orphan")
				f.assets.splice(
					f.assets.findIndex((a) => a.name.endsWith(".meta.json")),
					1,
				);
			await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toBeInstanceOf(
				IndependentMirrorError,
			);
			expect(f.httpCalls).toHaveLength(0);
		});
	test.each([
		"../binary",
		"dir/binary",
		"binary\\path",
		"binary%2fpath",
		"binary?token=secret",
		"binary\n",
	])("unsafe public asset name %j still fails before uploading", async (name) => {
		const f = mirrorFixture();
		f.assets[0].name = name;
		await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toBeInstanceOf(
			IndependentMirrorError,
		);
		expect(f.httpCalls).toHaveLength(0);
	});
	test("fork repository never silently falls back to official", async () => {
		const f = mirrorFixture(false);
		await mirrorPublishedGitHubRelease(options(f));
		expect(f.ghCalls.every((args) => args[1].startsWith(`repos/${repository}/`))).toBe(true);
	});
	test("total byte budget rejects before download, with no server mutation", async () => {
		const f = mirrorFixture();
		await expect(
			mirrorPublishedGitHubRelease({ ...options(f), maxTotalBytes: 1 }),
		).rejects.toBeInstanceOf(IndependentMirrorError);
		expect(f.downloaded).toHaveLength(0);
		expect(f.httpCalls).toHaveLength(0);
	});
	test("partial upload failure retains real verified subset and never commits snapshot", async () => {
		const f = mirrorFixture();
		const patch = f.assets.find((a) => a.name.endsWith("zstd-patch"));
		f.failPath = patch?.digest.slice(7) as string;
		try {
			await mirrorPublishedGitHubRelease({ ...options(f), uploadConcurrency: 1 });
			throw new Error("must reject");
		} catch (error) {
			expect(error).toBeInstanceOf(IndependentMirrorError);
			const r = (error as IndependentMirrorError).receipt;
			expect(r.status).toBe("FAILED");
			expect(r.snapshotCommitted).toBe(false);
			expect(r.uploaded).toEqual([`${f.name}.metadata.json`]);
			expect(r.verified).toEqual([]);
		}
		expect(f.committed).toBeUndefined();
		expect(f.publicRelease.draft).toBe(false);
	});
	for (const malformed of [
		undefined,
		{ ok: true },
		{ schemaVersion: 1, verification: "server-sha256", repository, verified: [] },
	])
		test("missing/forged commit receipt fails with no asset GET fallback", async () => {
			const f = mirrorFixture();
			f.http.postJson = async () => malformed;
			try {
				await mirrorPublishedGitHubRelease(options(f));
				throw new Error("must reject");
			} catch (error) {
				expect(error).toBeInstanceOf(IndependentMirrorError);
				const r = (error as IndependentMirrorError).receipt;
				expect(r.status).toBe("FAILED");
				expect(r.snapshotCommitted).toBe(false);
				expect(r.verified).toEqual([]);
			}
			expect(f.httpCalls.every((r) => r.method !== "GET")).toBe(true);
		});
	for (const field of [
		"repository",
		"indexCommit",
		"generation",
		"targetVersion",
		"verification",
		"verified",
	])
		test(`commit receipt binds exact ${field} rather than trusting early success`, async () => {
			const f = mirrorFixture(false);
			const post = f.http.postJson.bind(f.http);
			f.http.postJson = async (...args) => {
				const acknowledgement = (await post(...args)) as Record<string, unknown>;
				acknowledgement[field] = field === "generation" ? 999 : field === "verified" ? [] : "wrong";
				return acknowledgement;
			};
			await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toThrow(
				"upgrade update server",
			);
			expect(f.httpCalls.some((r) => r.method === "GET")).toBe(false);
		});
	test("legacy upload ack fails before commit and never falls back to GET", async () => {
		const f = mirrorFixture();
		f.http.putRaw = async () => ({ schemaVersion: 1 });
		await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toBeInstanceOf(
			IndependentMirrorError,
		);
		expect(f.committed).toBeUndefined();
		expect(f.httpCalls).toHaveLength(0);
	});
	test("corrupt patch byte stream rejects before a canonical snapshot is visible", async () => {
		const f = mirrorFixture();
		const patch = [...f.raw.keys()].find((n) => n.endsWith("zstd-patch")) as string;
		f.raw.set(patch, Buffer.from("corrupt"));
		await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toBeInstanceOf(
			IndependentMirrorError,
		);
		expect(f.committed).toBeUndefined();
	});
	test("canonical target changed during transfer cannot replace newer snapshot", async () => {
		const f = mirrorFixture(false);
		f.onIndexRead = () => {
			if (f.indexReads > 1) f.index.releases[0].commit = "c".repeat(40);
		};
		await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toBeInstanceOf(
			IndependentMirrorError,
		);
		expect(f.committed).toBeUndefined();
	});
	test("parent cancellation has a truthful cancelled receipt and zero network", async () => {
		const f = mirrorFixture();
		const controller = new AbortController();
		controller.abort();
		try {
			await mirrorPublishedGitHubRelease({ ...options(f), signal: controller.signal });
			throw new Error("must reject");
		} catch (error) {
			expect((error as IndependentMirrorError).receipt.failureCode).toBe("CANCELLED");
		}
		expect(f.httpCalls).toHaveLength(0);
	});
	test("fresh canonical index preserves a newer GitHub channel instead of electing the target or old server versions", async () => {
		const f = mirrorFixture(false, false);
		const next = structuredClone(f.release);
		next.version = "1.3.0";
		next.tag = "v1.3.0";
		for (const file of next.files) {
			file.name = file.name.replace("1.2.0", "1.3.0");
			file.metadata.name = `${file.name}.metadata.json`;
		}
		f.onIndexRead = () => {
			if (f.indexReads === 2) f.index = mergeUpdateIndex(f.index, next, repository);
		};
		expect((await mirrorPublishedGitHubRelease(options(f))).status).toBe("METADATA_ONLY");
		expect(f.committed?.index.channels.stable).toBe("1.3.0");
		expect(f.committed?.targetVersion).toBe("1.2.0");
	});
	test("canonical 409 refreshes only GitHub and retries snapshot without uploading patches twice", async () => {
		const f = mirrorFixture(true, false);
		const next = structuredClone(f.release);
		next.version = "1.3.0";
		next.tag = "v1.3.0";
		for (const file of next.files) {
			file.name = file.name.replace("1.2.0", "1.3.0");
			file.metadata.name = `${file.name}.metadata.json`;
			file.patches = [];
		}
		f.snapshotConflicts = 1;
		f.onSnapshotConflict = () => {
			f.index = mergeUpdateIndex(f.index, next, repository);
		};
		expect((await mirrorPublishedGitHubRelease(options(f))).status).toBe("MIRRORED");
		expect(f.committed?.index.channels.stable).toBe("1.3.0");
		expect(f.httpCalls.filter((c) => c.method === "POST")).toHaveLength(2);
		expect(f.httpCalls.filter((c) => c.method === "PUT")).toHaveLength(3);
		expect(f.downloaded).toHaveLength(1);
	});
	test("repeated canonical conflicts exhaust a finite budget without reading mirror history", async () => {
		const f = mirrorFixture(false);
		f.snapshotConflicts = 10;
		await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toThrow();
		expect(f.httpCalls.filter((c) => c.method === "POST")).toHaveLength(3);
		expect(f.httpCalls.every((c) => c.method !== "GET")).toBe(true);
		expect(f.committed).toBeUndefined();
	});
	test("canonical conflict cannot revive a target pruned from the latest GitHub window", async () => {
		const f = mirrorFixture(false, false);
		f.snapshotConflicts = 1;
		f.onSnapshotConflict = () => {
			const next = structuredClone(f.release);
			next.version = "1.3.0";
			next.tag = "v1.3.0";
			for (const file of next.files) {
				file.name = file.name.replace("1.2.0", "1.3.0");
				file.metadata.name = `${file.name}.metadata.json`;
			}
			f.index = mergeUpdateIndex(null, next, repository);
		};
		await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toThrow();
		expect(f.httpCalls.filter((c) => c.method === "POST")).toHaveLength(1);
		expect(f.committed).toBeUndefined();
	});
	test("a current orphan patch is never misclassified as legal no-patch", async () => {
		const f = mirrorFixture(false);
		f.assets.push({
			id: 99,
			name: "unknown-platform.from-1.0.0.zstd-patch",
			size: 3,
			digest: `sha256:${sha("raw")}`,
			state: "uploaded",
		});
		await expect(mirrorPublishedGitHubRelease(options(f))).rejects.toThrow();
		expect(f.httpCalls).toHaveLength(0);
	});
	test("preview rejects corrupted canonical notes without any mirror access", async () => {
		const f = mirrorFixture(false);
		const run = (args: string[]) =>
			args[1].includes("/contents/notes/") ? f.notesRaw.replace("exact", "wrong") : f.run(args);
		await expect(
			mirrorPublishedGitHubRelease({ ...options(f), dryRun: true, run }),
		).rejects.toThrow();
		expect(f.httpCalls).toHaveLength(0);
	});
	test("disk-full download fails only this mirror and never commits incomplete projection", async () => {
		const f = mirrorFixture();
		await expect(
			mirrorPublishedGitHubRelease({
				...options(f),
				downloadAsset: async () => {
					throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
				},
			}),
		).rejects.toThrow();
		expect(f.committed).toBeUndefined();
		expect(f.publicRelease.draft).toBe(false);
	});
	test("raw PUT has bounded backpressure and hashes exact chunks without collecting the payload", async () => {
		const chunk = new Uint8Array(64 * 1024).fill(7);
		const count = 64;
		const hash = createHash("sha256");
		for (let i = 0; i < count; i++) hash.update(chunk);
		let produced = 0;
		let consumed = 0;
		let ahead = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced === count) {
					controller.close();
					return;
				}
				produced++;
				ahead = Math.max(ahead, produced - consumed);
				controller.enqueue(chunk);
			},
		});
		const http = new UpdateServerMirrorHttp(config, {
			fetchImpl: (async (_url: unknown, init?: RequestInit) => {
				const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
				try {
					while (true) {
						const item = await reader.read();
						if (item.done) break;
						consumed++;
						await Promise.resolve();
					}
				} finally {
					reader.releaseLock();
				}
				return Response.json({ ok: true });
			}) as unknown as typeof fetch,
		});
		await http.putRaw("/api/v3/products/narrafork/mirror/assets/raw", stream, {
			maxBytes: chunk.length * count,
			expected: { size: chunk.length * count, sha256: hash.digest("hex") },
			headers: {},
		});
		expect(consumed).toBe(count);
		expect(ahead).toBeLessThanOrEqual(3);
	});
	test("deprecated pre-publication bridge entry refuses instead of selecting historical artifacts", async () => {
		await expect(prepareUpdateServerMainMirror({ bridgeArtifactId: 11912974901 })).rejects.toThrow(
			"retired",
		);
	});
	test("raw streaming upload cancels its body on parent abort", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise(() => {});
			},
			cancel() {
				cancelled = true;
			},
		});
		const http = new UpdateServerMirrorHttp(config, {
			fetchImpl: (async (_url: unknown, init?: RequestInit) => {
				controller.abort();
				await new Response(init?.body).arrayBuffer();
				return Response.json({ ok: true });
			}) as unknown as typeof fetch,
		});
		await expect(
			http.putRaw("/api/v3/products/narrafork/mirror/assets/a", body, {
				maxBytes: 8,
				signal: controller.signal,
				expected: { size: 8, sha256: "a".repeat(64) },
				headers: {},
			}),
		).rejects.toThrow();
		expect(cancelled).toBe(true);
	});
});
