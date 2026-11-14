import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { BridgeHttpError } from "../../scripts/lib/update-server-bridge-http";
import { IndependentMirrorError } from "../../scripts/lib/update-server-main-mirror";
import { mirrorPublishedGitHubRelease } from "../../scripts/mirror-update-server";
import { mirrorAssetsForTarget } from "../../shared/independent-update-mirror";
import { mergeUpdateIndex } from "../../shared/update-index";
import { UPDATE_INDEX_PLATFORMS } from "../../shared/update-index-types";
import { WebDavClient } from "../../shared/webdav-transport";
import { createWebDavFixture } from "../fixtures/webdav-fixture";
import { config, mirrorFixture, repository, sha } from "./mirror-fixture";

function pause(signal: AbortSignal | undefined, ms: number) {
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
function allPlatformFixture() {
	const f = mirrorFixture();
	const first = f.release.files[0];
	const originalSidecar = JSON.parse(f.raw.get(first.metadata.name)?.toString() ?? "");
	const patch = first.patches[0];
	const originalMeta = JSON.parse(f.raw.get(patch.metadata.name)?.toString() ?? "");
	const descriptor = (name: string, bytes: Buffer) => {
		f.raw.set(name, bytes);
		return { name, size: bytes.length, sha256: sha(bytes) };
	};
	for (const [platform, suffix] of Object.entries(UPDATE_INDEX_PLATFORMS)) {
		if (platform === first.platform) continue;
		const name = `narrafork-${f.release.version}-${suffix}`;
		descriptor(name, f.raw.get(first.name) as Buffer);
		const metadata = descriptor(
			`${name}.metadata.json`,
			Buffer.from(
				JSON.stringify({
					...originalSidecar,
					name,
					platform,
					target: `bun-${platform.replace(/^win-/, "windows-")}`,
				}),
			),
		);
		const patchAsset = descriptor(
			`${name}.from-${patch.fromVersion}.zstd-patch`,
			Buffer.from(`distinct canonical ${platform} patch bytes`),
		);
		const patchMetadata = descriptor(
			`${patchAsset.name}.meta.json`,
			Buffer.from(JSON.stringify({ ...originalMeta, patchSize: patchAsset.size })),
		);
		f.release.files.push({
			...first,
			name,
			platform,
			metadata,
			patches: [{ ...patch, ...patchAsset, metadata: patchMetadata }],
		});
		for (const asset of [{ ...first, name }, metadata, patchAsset, patchMetadata])
			f.assets.push({
				id: f.assets.length + 1,
				name: asset.name,
				size: asset.size,
				digest: `sha256:${asset.sha256}`,
				state: "uploaded",
			});
	}
	f.index = mergeUpdateIndex(null, f.release, repository, "2026-07-01T00:00:00.000Z");
	return f;
}
test("default main direct stays within an old server's two upload slots without probing or retrying", async () => {
	const f = allPlatformFixture();
	const raw = f.http.putRaw.bind(f.http);
	let active = 0;
	let peak = 0;
	let rejected = 0;
	f.http.putRaw = async (path, body, options) => {
		active++;
		peak = Math.max(peak, active);
		try {
			if (active > 2) {
				rejected++;
				throw new BridgeHttpError(429);
			}
			await pause(options.signal, 15);
			return await raw(path, body, options);
		} finally {
			active--;
		}
	};
	const result = await mirrorPublishedGitHubRelease({
		kind: "main",
		repository,
		tag: f.release.tag,
		config,
		run: f.run,
		http: f.http,
		downloadAsset: f.downloadAsset,
	});
	expect(result.status).toBe("MIRRORED");
	expect(peak).toBe(2);
	expect(rejected).toBe(0);
	expect(active).toBe(0);
	expect(result.uploaded).toEqual(
		mirrorAssetsForTarget(f.index, f.release.version, 2).map((a) => a.name),
	);
});

for (const transport of ["direct", "webdav"] as const)
	for (const fail of [false, true]) {
		test(`main ${transport} overlaps patch pipelines, bounds live downloads, and settles before ${fail ? "failure" : "commit"}`, async () => {
			const f = allPlatformFixture();
			const sourcePaths: string[] = [];
			const liveFiles = new Set<string>();
			let peakFiles = 0;
			let patchTasks = 0;
			let peakPatches = 0;
			let activeUploads = 0;
			let peakUploads = 0;
			let canceled = 0;
			let uploadNumber = 0;
			const accepted: string[] = [];
			const descriptors = mirrorAssetsForTarget(f.index, f.release.version, 2);
			const names = new Map(descriptors.map((a) => [a.sha256, a.name]));
			const download = f.downloadAsset;
			f.downloadAsset = async (options) => {
				liveFiles.add(options.outputPath);
				sourcePaths.push(options.outputPath);
				peakFiles = Math.max(peakFiles, liveFiles.size);
				patchTasks++;
				peakPatches = Math.max(peakPatches, patchTasks);
				try {
					await pause(options.signal, 10);
					await download(options);
				} catch (error) {
					liveFiles.delete(options.outputPath);
					patchTasks--;
					throw error;
				}
			};
			const uploading = async (
				hash: string,
				signal: AbortSignal | undefined,
				action: () => Promise<unknown>,
			) => {
				activeUploads++;
				peakUploads = Math.max(peakUploads, activeUploads);
				const attempt = ++uploadNumber;
				try {
					if (fail && attempt === 2) {
						await pause(signal, 20);
						throw new Error("physical upload failed");
					}
					await pause(signal, fail && attempt > 2 ? 500 : 15);
					const result = await action();
					accepted.push(...descriptors.filter((a) => a.sha256 === hash).map((a) => a.name));
					return result;
				} catch (error) {
					if (signal?.aborted) canceled++;
					throw error;
				} finally {
					activeUploads--;
					for (const path of liveFiles)
						if (path.endsWith(hash)) {
							liveFiles.delete(path);
							patchTasks--;
						}
				}
			};
			const putRaw = f.http.putRaw.bind(f.http);
			f.http.putRaw = (path, body, options) =>
				uploading(path.split("/").at(-1) as string, options.signal, () =>
					putRaw(path, body, options),
				);
			const postJson = f.http.postJson.bind(f.http);
			f.http.postJson = async (...args) => {
				expect(activeUploads).toBe(0);
				expect(liveFiles.size).toBe(0);
				return postJson(...args);
			};
			const dav = createWebDavFixture();
			const davConfig = { url: dav.baseUrl, feed: "default", auth: { bearerToken: "fixture" } };
			const fetchDav = (async (url: unknown, init?: RequestInit) => {
				const path = new URL(String(url)).pathname;
				if (init?.method === "PUT" && path.includes("/objects/")) {
					const hash = path.split("/").at(-1) as string;
					if (names.has(hash))
						return uploading(hash, init.signal ?? undefined, () =>
							dav.fetchImpl(url as string, init),
						) as Promise<Response>;
					expect(activeUploads).toBe(0);
					expect(liveFiles.size).toBe(0);
				}
				return dav.fetchImpl(url as string, init);
			}) as typeof fetch;
			try {
				const result = await mirrorPublishedGitHubRelease({
					kind: "main",
					repository,
					tag: f.release.tag,
					config,
					transport,
					run: f.run,
					http: f.http,
					uploadConcurrency: 3,
					downloadAsset: f.downloadAsset,
					relay: {
						config: davConfig,
						signingKey: Buffer.alloc(32, 4).toString("base64"),
						client: new WebDavClient(davConfig, { fetchImpl: fetchDav }),
					},
				});
				expect(fail).toBe(false);
				expect(result.uploaded).toEqual(descriptors.map((a) => a.name));
				expect(result.status).toBe(transport === "direct" ? "MIRRORED" : "STAGED_FOR_PULL");
				expect(peakPatches).toBeGreaterThan(1);
			} catch (error) {
				if (!fail) throw error;
				expect(error).toBeInstanceOf(IndependentMirrorError);
				const receipt = (error as IndependentMirrorError).receipt;
				expect(receipt.failureCode).toBe("MIRROR_FAILED");
				expect(receipt.uploaded).toEqual(
					descriptors.filter((a) => accepted.includes(a.name)).map((a) => a.name),
				);
				expect(receipt.uploaded.length).toBeGreaterThan(0);
				expect(receipt.snapshotCommitted).toBe(false);
				expect(canceled).toBeGreaterThan(0);
				expect(f.committed).toBeUndefined();
				expect([...dav.objects.keys()].some((p) => p.includes("/ready/"))).toBe(false);
			}
			expect(peakUploads).toBeGreaterThan(1);
			expect(peakUploads).toBeLessThanOrEqual(3);
			expect(peakFiles).toBeLessThanOrEqual(3);
			expect(activeUploads).toBe(0);
			expect(sourcePaths.length).toBeGreaterThan(0);
			expect(new Set(sourcePaths).size).toBe(sourcePaths.length);
			for (const path of sourcePaths) expect(existsSync(path)).toBe(false);
		});
	}
