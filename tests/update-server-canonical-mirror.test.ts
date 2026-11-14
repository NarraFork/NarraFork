import { expect, spyOn, test } from "bun:test";
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
} from "../shared/helper-distribution";
import {
	MIRROR_MAIN_TRANSFER_TIMEOUT_MS,
	type MirrorAssetDescriptor,
	type MirrorSnapshot,
	type MirrorSnapshotV1,
	type MirrorSnapshotV2,
	mirrorAssetsForTarget,
	parseMirrorAvailability,
} from "../shared/independent-update-mirror";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "../shared/remote-executor";
import { mergeUpdateIndex, type UpdateIndexRelease } from "../shared/update-index";
import { createApp } from "../update-server/app";
import { initConfig } from "../update-server/lib/config";
import { MirrorIngestError, MirrorIngestService } from "../update-server/services/mirror-ingest";
import { LocalStorage } from "../update-server/storage/local";

const repository = "my-fork/my-release";

for (const kind of ["helpers", "executor"] as const) {
	test(`${kind} binary commit is manifest-bound, atomic, exact-tag and metadata-only compatible`, async () => {
		await withServer(async (ctx) => {
			const version = kind === "helpers" ? "1.0.0" : "1.2.0";
			const tag = `${kind}-v${version}`;
			const bytes = Buffer.alloc(128, 7);
			const sha256 = digest(bytes);
			const license = { name: "LICENSE.txt", size: 7, sha256: digest(Buffer.from("License")) };
			const manifest = {
				schemaVersion: 1,
				repository,
				tag,
				commit: "a".repeat(40),
				licenses: [license],
				...(kind === "helpers"
					? {
							catalogVersion: "1.0.0",
							files: HELPER_TOOLS.flatMap((tool) =>
								HELPER_PLATFORMS.map((platform) => ({
									tool,
									platform,
									toolVersion: HELPER_TOOL_VERSIONS[tool],
									name: getHelperAssetName(tool, platform),
									size: bytes.length,
									sha256,
								})),
							),
						}
					: {
							manifest: {
								version,
								protocolVersion: 1,
								releasedAt: "2026-07-01T00:00:00Z",
								platforms: Object.fromEntries(
									EXECUTOR_PLATFORMS.map((platform) => [
										platform,
										{
											filename: executorPublishedFilename(version, platform),
											size: bytes.length,
											sha256,
										},
									]),
								),
							},
						}),
			};
			const content = JSON.stringify(manifest);
			const binaries: MirrorAssetDescriptor[] =
				kind === "helpers"
					? HELPER_TOOLS.flatMap((tool) =>
							HELPER_PLATFORMS.map((platform) => ({
								kind: "helpers-binary" as const,
								version,
								platform,
								name: getHelperAssetName(tool, platform),
								size: bytes.length,
								sha256,
							})),
						)
					: EXECUTOR_PLATFORMS.map((platform) => ({
							kind: "executor-binary" as const,
							version,
							platform,
							name: executorPublishedFilename(version, platform),
							size: bytes.length,
							sha256,
						}));
			const projection = {
				schemaVersion: 1,
				repository,
				kind,
				tag,
				assets: [
					{
						name: kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME,
						size: Buffer.byteLength(content),
						sha256: digest(Buffer.from(content)),
						content,
					},
					{ ...license, content: "License" },
				],
			};
			const url = `${ctx.url}/tools/${kind}/${tag}`;
			const submit = (payload: unknown) =>
				ctx.app.request(url, {
					method: "POST",
					headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
					body: JSON.stringify(payload),
				});
			const assetUrl = `${url}/assets/${binaries[0].name}`;
			expect((await submit(projection)).status).toBe(200);
			expect((await ctx.app.request(assetUrl)).status).toBe(404);
			// Complete declarations cannot commit before their streamed objects exist.
			expect((await submit({ ...projection, binaries })).status).toBe(400);
			const descriptor = binaries[0];
			expect(
				(
					await ctx.app.request(`${ctx.url}/assets/${sha256}`, {
						method: "PUT",
						headers: headers(ctx.token, descriptor),
						body: Uint8Array.from(bytes),
					})
				).status,
			).toBe(200);
			expect((await ctx.app.request(assetUrl)).status).toBe(404);
			for (const bad of [
				binaries.slice(1),
				binaries.map((b, i) => (i ? b : { ...b, platform: "wrong" })),
				binaries.map((b, i) => (i ? b : { ...b, version: "9.9.9" })),
				binaries.map((b, i) => (i ? b : { ...b, sha256: "f".repeat(64) })),
				binaries.map((b, i) => (i ? b : { ...b, size: 32 * 1024 ** 2 + 1 })),
			])
				expect((await submit({ ...projection, binaries: bad })).status).toBe(400);
			const response = await submit({ ...projection, binaries });
			expect(response.status).toBe(200);
			expect((await response.json()).verified).toHaveLength(binaries.length + 2);
			expect(Buffer.from(await (await ctx.app.request(assetUrl)).arrayBuffer()).equals(bytes)).toBe(
				true,
			);
			expect(
				(await ctx.app.request(`${ctx.url}/tools/${kind}/${kind}-v9.9.9/assets/${descriptor.name}`))
					.status,
			).toBe(404);
			// An old producer can still retry, without erasing binary availability or changing its receipt shape.
			const legacy = await submit(projection);
			expect((await legacy.json()).verified).toHaveLength(2);
			expect((await ctx.app.request(assetUrl)).status).toBe(200);
			const restarted = createApp(ctx.storage, new MirrorIngestService(ctx.storage));
			expect((await restarted.request(assetUrl)).status).toBe(200);
			await ctx.storage.saveFile(`mirror-objects/${sha256}`, Buffer.alloc(bytes.length, 9));
			expect((await submit({ ...projection, binaries })).status).toBe(400);
		});
	});
}

test("canonical generation CAS rejects delayed N after N+1 and conflicting same-generation snapshots without consulting legacy v999", async () => {
	await withServer(async (ctx) => {
		await ctx.storage.saveFile(
			"products/narrafork/releases/999.0.0/meta.json",
			Buffer.from("untrusted legacy generation"),
		);
		const first = fixture();
		await uploadAll(ctx, first);
		expect((await commit(ctx, first.snapshot)).status).toBe(200);
		const next = fixture(false, "0.9.3");
		next.snapshot.index = mergeUpdateIndex(first.snapshot.index, next.release, repository);
		next.snapshot.indexCommit = "c".repeat(40);
		await uploadAll(ctx, next);
		expect((await commit(ctx, next.snapshot)).status).toBe(200);
		const before = await ctx.storage.getFile("mirror-snapshots/narrafork.json");
		// Late asset uploads still validate and succeed, but their old pointer cannot be committed.
		await uploadAll(ctx, first);
		const replay = await commit(ctx, first.snapshot);
		expect(replay.status).toBe(409);
		expect((await replay.json()).code).toBe("STALE_CANONICAL_SNAPSHOT");
		expect(await ctx.storage.getFile("mirror-snapshots/narrafork.json")).toEqual(before);
		for (const mutate of [
			(s: MirrorSnapshotV1) => {
				s.indexCommit = "d".repeat(40);
			},
			(s: MirrorSnapshotV1) => {
				s.index.generatedAt = "2026-10-14T00:00:00.000Z";
			},
		]) {
			const conflict = structuredClone(next.snapshot);
			mutate(conflict);
			const response = await commit(ctx, conflict);
			expect(response.status).toBe(409);
			expect((await response.json()).code).toBe("CANONICAL_SNAPSHOT_CONFLICT");
			expect(await ctx.storage.getFile("mirror-snapshots/narrafork.json")).toEqual(before);
		}
		expect((await commit(ctx, next.snapshot)).status).toBe(200);
		// A different current target projection is allowed under the exact same canonical catalog.
		const oldTargetWithFreshIndex = {
			...first.snapshot,
			index: next.snapshot.index,
			indexCommit: next.snapshot.indexCommit,
		};
		expect((await commit(ctx, oldTargetWithFreshIndex)).status).toBe(200);
		const index = await (await ctx.app.request(`${ctx.url}/index`)).json();
		expect(index.channels.stable).toBe("0.9.3");
		expect(index.generation).toBe(2);
		for (const target of [first, next]) {
			const availability = await (
				await ctx.app.request(`${ctx.url}/availability/${target.snapshot.targetVersion}/linux-x64`)
			).json();
			expect(availability.assets).toHaveLength(target.snapshot.assets.length);
			expect(
				(await ctx.app.request(`${ctx.url}/assets/${target.snapshot.assets[0].sha256}`)).status,
			).toBe(200);
		}
		const restarted = new MirrorIngestService(ctx.storage);
		expect((await restarted.readMain("narrafork"))?.assets).toHaveLength(
			first.snapshot.assets.length + next.snapshot.assets.length,
		);
		expect(await ctx.storage.getFile("products/narrafork/releases/999.0.0/meta.json")).toEqual(
			Buffer.from("untrusted legacy generation"),
		);
	});
});

test("legacy encoded download paths cannot bypass committed-only mirror asset visibility", async () => {
	await withServer(async (ctx) => {
		const current = fixture(false);
		await uploadAll(ctx, current);
		const sha = current.snapshot.assets[0].sha256;
		const filename = encodeURIComponent(`linux-x64/../../../../mirror-objects/${sha}`);
		const response = await ctx.app.request(
			`/api/v2/products/narrafork/releases/0.9.2/download/${filename}`,
		);
		expect(response.status).toBe(400);
		expect((await ctx.app.request(`${ctx.url}/assets/${sha}`)).status).toBe(404);
	});
});

test("mirror download is streaming-bounded and cancels disk readers on overflow or request abort", async () => {
	await withServer(async (ctx) => {
		const current = fixture(false);
		await uploadAll(ctx, current);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const asset = current.snapshot.assets[0];
		let cancelled = false;
		const real = ctx.storage.getFileStream.bind(ctx.storage);
		ctx.storage.getFileStream = async (path) =>
			path === `mirror-objects/${asset.sha256}`
				? new ReadableStream({
						start(c) {
							c.enqueue(new Uint8Array(asset.size + 1));
						},
						cancel() {
							cancelled = true;
						},
					})
				: real(path);
		const response = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`);
		await expect(response.arrayBuffer()).rejects.toThrow();
		expect(cancelled).toBe(true);
		cancelled = false;
		ctx.storage.getFileStream = async (path) =>
			path === `mirror-objects/${asset.sha256}`
				? new ReadableStream({
						cancel() {
							cancelled = true;
						},
					})
				: real(path);
		const controller = new AbortController();
		const stalled = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`, {
			signal: controller.signal,
		});
		controller.abort();
		await expect(stalled.arrayBuffer()).rejects.toThrow("aborted");
		expect(cancelled).toBe(true);
	});
});

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function fixture(patches = true, version = "0.9.2") {
	const name = `narrafork-${version}-linux-x64`;
	const binary = Buffer.from("never uploaded full binary");
	const sha512 = createHash("sha512").update(binary).digest("base64");
	const commit = "a".repeat(40);
	const sidecar = Buffer.from(
		JSON.stringify({
			name,
			version,
			platform: "linux-x64",
			target: "bun-linux-x64",
			commit,
			size: binary.length,
			sha256: digest(binary),
			sha512,
			repository,
		}),
	);
	const patchName = `${name}.from-0.8.3.zstd-patch`;
	const patch = Buffer.from("canonical patch bytes");
	const meta = Buffer.from(
		JSON.stringify({
			fromVersion: "0.8.3",
			toVersion: version,
			oldFileSize: 2,
			oldFileSha512: Buffer.alloc(64, 1).toString("base64"),
			stableEnd: 0,
			newTailSize: binary.length,
			patchSize: patch.length,
			newFileSize: binary.length,
			newFileSha512: sha512,
			mode: "patch-from",
		}),
	);
	const release: UpdateIndexRelease = {
		version,
		tag: `v${version}`,
		commit,
		prerelease: false,
		publishedAt: "2026-07-01T00:00:00.000Z",
		files: [
			{
				name,
				platform: "linux-x64",
				size: binary.length,
				sha256: digest(binary),
				sha512,
				metadata: { name: `${name}.metadata.json`, size: sidecar.length, sha256: digest(sidecar) },
				patches: patches
					? [
							{
								name: patchName,
								fromVersion: "0.8.3",
								size: patch.length,
								sha256: digest(patch),
								metadata: {
									name: `${patchName}.meta.json`,
									size: meta.length,
									sha256: digest(meta),
								},
							},
						]
					: [],
			},
		],
	};
	const index = mergeUpdateIndex(null, release, repository, "2026-07-01T00:00:00.000Z");
	const snapshot: MirrorSnapshotV1 = {
		schemaVersion: 1,
		repository,
		indexCommit: "b".repeat(40),
		index,
		targetVersion: version,
		assets: mirrorAssetsForTarget(index, version),
	};
	const bytes = new Map([
		[name, binary],
		[`${name}.metadata.json`, sidecar],
		[patchName, patch],
		[`${patchName}.meta.json`, meta],
	]);
	return { snapshot, bytes, release };
}
async function withServer(
	run: (ctx: {
		app: ReturnType<typeof createApp>;
		storage: LocalStorage;
		ingest: MirrorIngestService;
		token: string;
		root: string;
		url: string;
	}) => Promise<void>,
	overrides: Record<string, unknown> = {},
) {
	const root = mkdtempSync(join(tmpdir(), "nf-canonical-mirror-"));
	try {
		const config = join(root, "config.json");
		const initialized = await initConfig(config);
		const data = JSON.parse(await Bun.file(config).text());
		Object.assign(
			data,
			{
				mirrorRepositories: { narrafork: repository },
				mirrorLimits: { minFreeBytes: 0, quotaBytes: 1024 * 1024, uploadTimeoutMs: 500 },
			},
			overrides,
		);
		writeFileSync(config, JSON.stringify(data));
		await initConfig(config);
		const storage = new LocalStorage(join(root, "data"));
		const ingest = new MirrorIngestService(storage);
		await run({
			app: createApp(storage, ingest),
			storage,
			ingest,
			token: initialized.adminToken as string,
			root,
			url: "/api/v3/products/narrafork/mirror",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
function headers(token: string, asset: MirrorAssetDescriptor) {
	return {
		Authorization: `Bearer ${token}`,
		"x-mirror-repository": repository,
		"x-mirror-kind": asset.kind,
		"x-mirror-name": asset.name,
		"x-mirror-size": String(asset.size),
		"x-mirror-version": asset.version,
		...(asset.platform ? { "x-mirror-platform": asset.platform } : {}),
	};
}
async function uploadAll(
	ctx: Parameters<Parameters<typeof withServer>[0]>[0],
	current: { snapshot: MirrorSnapshot; bytes: Map<string, Buffer> },
) {
	for (const asset of current.snapshot.assets) {
		const response = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`, {
			method: "PUT",
			headers: headers(ctx.token, asset),
			body: Uint8Array.from(current.bytes.get(asset.name) as Buffer),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			verification: "server-sha256",
			name: asset.name,
			size: asset.size,
			sha256: asset.sha256,
		});
	}
}
async function commit(
	ctx: Parameters<Parameters<typeof withServer>[0]>[0],
	snapshot: MirrorSnapshot,
) {
	return ctx.app.request(`${ctx.url}/snapshot`, {
		method: "POST",
		headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
		body: JSON.stringify(snapshot),
	});
}

function fullSnapshot(snapshot: MirrorSnapshotV1): MirrorSnapshotV2 {
	return {
		...snapshot,
		schemaVersion: 2,
		assets: mirrorAssetsForTarget(snapshot.index, snapshot.targetVersion, 2),
	};
}

for (const legacyFormat of ["snapshot-v1", "catalog-v2"] as const) {
	test(`${legacyFormat} restart cannot expose cross-product binary objects; validated upgrade is monotonic`, async () => {
		await withServer(
			async (ctx) => {
				const current = fixture();
				await uploadAll(ctx, current);
				expect((await commit(ctx, current.snapshot)).status).toBe(200);
				const statePath = "mirror-snapshots/narrafork.json";
				if (legacyFormat === "snapshot-v1") {
					await ctx.storage.saveFile(statePath, Buffer.from(JSON.stringify(current.snapshot)));
				} else {
					const state = JSON.parse((await ctx.storage.getFile(statePath))?.toString() as string);
					for (const target of state.targets) delete target.projectionVersion;
					await ctx.storage.saveFile(statePath, Buffer.from(JSON.stringify(state)));
				}
				const full = fullSnapshot(current.snapshot);
				const binary = full.assets.find((a) => a.kind === "main-binary") as MirrorAssetDescriptor;
				// Even an exact globally content-addressed object ingested by another product is not evidence.
				await ctx.ingest.ingestAsset(
					"other",
					binary,
					new Blob([Uint8Array.from(current.bytes.get(binary.name) as Buffer)]).stream(),
					AbortSignal.timeout(5000),
				);
				const restarted = createApp(ctx.storage, new MirrorIngestService(ctx.storage));
				expect((await restarted.request(`${ctx.url}/assets/${binary.sha256}`)).status).toBe(404);
				expect((await commit(ctx, full)).status).toBe(200);
				const read = spyOn(ctx.storage, "getFile");
				try {
					expect((await commit(ctx, full)).status).toBe(200);
					expect(read.mock.calls.some(([path]) => path === `mirror-objects/${binary.sha256}`)).toBe(
						false,
					);
				} finally {
					read.mockRestore();
				}
				expect((await restarted.request(`${ctx.url}/assets/${binary.sha256}`)).status).toBe(200);
				const availability = parseMirrorAvailability(
					await (await restarted.request(`${ctx.url}/availability/0.9.2/linux-x64`)).json(),
					repository,
					"0.9.2",
					"linux-x64",
					full.index,
				);
				expect(availability.assets).toHaveLength(current.snapshot.assets.length);
				// Standalone v2 snapshots are also readable on restart before catalog conversion.
				await ctx.storage.saveFile(statePath, Buffer.from(JSON.stringify(full)));
				expect((await restarted.request(`${ctx.url}/assets/${binary.sha256}`)).status).toBe(200);
				// A v1 producer retry must neither revoke binary qualification nor claim it in its receipt.
				const legacyRetry = await commit(ctx, current.snapshot);
				expect((await legacyRetry.json()).verified).toHaveLength(current.snapshot.assets.length);
				expect((await restarted.request(`${ctx.url}/assets/${binary.sha256}`)).status).toBe(200);
				const stored = JSON.parse((await ctx.storage.getFile(statePath))?.toString() as string);
				expect(stored.targets[0].projectionVersion).toBe(2);
				const next = fixture(false, "0.9.3");
				next.snapshot.index = mergeUpdateIndex(full.index, next.release, repository);
				next.snapshot.indexCommit = "d".repeat(40);
				await uploadAll(ctx, next);
				expect((await commit(ctx, next.snapshot)).status).toBe(200);
				for (const asset of full.assets)
					expect((await restarted.request(`${ctx.url}/assets/${asset.sha256}`)).status).toBe(200);
			},
			{ mirrorRepositories: { narrafork: repository, other: "other/project" } },
		);
	});
}

test("v2 missing, corrupt, truncated and oversized main binaries never publish a partial snapshot", async () => {
	await withServer(async (ctx) => {
		const current = fixture();
		await uploadAll(ctx, current);
		const full = fullSnapshot(current.snapshot);
		const binary = full.assets[0];
		expect((await commit(ctx, full)).status).toBe(400);
		expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(404);
		for (const bytes of [
			Buffer.alloc(binary.size, 9),
			Buffer.alloc(binary.size - 1),
			Buffer.alloc(binary.size + 1),
		]) {
			const response = await ctx.app.request(`${ctx.url}/assets/${binary.sha256}`, {
				method: "PUT",
				headers: headers(ctx.token, binary),
				body: new Blob([Uint8Array.from(bytes)]).stream(),
			});
			expect(response.status).toBe(400);
			expect(await ctx.storage.fileExists(`mirror-objects/${binary.sha256}`)).toBe(false);
		}
		await uploadAll(ctx, { snapshot: full, bytes: current.bytes });
		expect((await commit(ctx, full)).status).toBe(200);
		await ctx.storage.saveFile(`mirror-objects/${binary.sha256}`, Buffer.alloc(binary.size, 7));
		expect((await commit(ctx, full)).status).toBe(400);
	});
});

test("cancelled full-binary commit verification never upgrades a legacy marker and releases its lock", async () => {
	await withServer(async (ctx) => {
		const current = fixture();
		await uploadAll(ctx, current);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const full = fullSnapshot(current.snapshot);
		await uploadAll(ctx, { snapshot: full, bytes: current.bytes });
		const binary = full.assets[0];
		const before = await ctx.storage.getFile("mirror-snapshots/narrafork.json");
		const entered = Promise.withResolvers<void>();
		let cancelled = false;
		const real = ctx.storage.getFileStream.bind(ctx.storage);
		const reading = spyOn(ctx.storage, "getFileStream").mockImplementation((path) =>
			path === `mirror-objects/${binary.sha256}`
				? Promise.resolve(
						new ReadableStream<Uint8Array>({
							pull() {
								entered.resolve();
							},
							cancel() {
								cancelled = true;
							},
						}),
					)
				: real(path),
		);
		const abort = new AbortController();
		try {
			const work = ctx.ingest.commitMain("narrafork", full, abort.signal);
			await entered.promise;
			abort.abort();
			await expect(work).rejects.toThrow("aborted");
			expect(cancelled).toBe(true);
			expect(await ctx.storage.getFile("mirror-snapshots/narrafork.json")).toEqual(before);
			expect((await ctx.app.request(`${ctx.url}/assets/${binary.sha256}`)).status).toBe(404);
		} finally {
			reading.mockRestore();
		}
		expect((await commit(ctx, full)).status).toBe(200);
	});
});

test("main binary uses bounded 15 minute direct budget and honours cancellation and stricter quota", async () => {
	await withServer(
		async (ctx) => {
			const current = fixture();
			const binary = fullSnapshot(current.snapshot).assets[0];
			const saving = spyOn(ctx.storage, "saveVerifiedFile");
			try {
				const controller = new AbortController();
				let cancelled = false;
				const pending = ctx.ingest.ingestAsset(
					"narrafork",
					binary,
					new ReadableStream({
						start(c) {
							c.enqueue(new Uint8Array([1]));
						},
						cancel() {
							cancelled = true;
						},
					}),
					controller.signal,
				);
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
				controller.abort();
				await expect(pending).rejects.toThrow();
				expect(cancelled).toBe(true);
				expect(saving.mock.calls[0][2].timeoutMs).toBe(MIRROR_MAIN_TRANSFER_TIMEOUT_MS);
				expect(await ctx.storage.listFiles("mirror-objects")).toEqual([]);
			} finally {
				saving.mockRestore();
			}
		},
		{ mirrorLimits: { minFreeBytes: 0 } },
	);
	await withServer(
		async (ctx) => {
			const current = fixture();
			const binary = fullSnapshot(current.snapshot).assets[0];
			await expect(
				ctx.ingest.ingestAsset(
					"narrafork",
					binary,
					new Blob([Uint8Array.from(current.bytes.get(binary.name) as Buffer)]).stream(),
					AbortSignal.timeout(5000),
				),
			).rejects.toThrow("quota");
			expect((await ctx.app.request(`${ctx.url}/assets/${binary.sha256}`)).status).toBe(404);
		},
		{ mirrorLimits: { quotaBytes: 1, minFreeBytes: 0 } },
	);
});

test("empty server mirrors current canonical assets without source history or full binaries; history v999 has no authority", async () => {
	await withServer(async (ctx) => {
		await ctx.storage.saveFile(
			"products/narrafork/releases/999.0.0/meta.json",
			Buffer.from("historical bytes"),
		);
		const current = fixture();
		await uploadAll(ctx, current);
		expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(404);
		expect(
			(await ctx.app.request(`${ctx.url}/assets/${current.snapshot.assets[0].sha256}`)).status,
		).toBe(404);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const index = await (await ctx.app.request(`${ctx.url}/index`)).json();
		expect(index.channels.stable).toBe("0.9.2");
		const availability = parseMirrorAvailability(
			await (await ctx.app.request(`${ctx.url}/availability/0.9.2/linux-x64`)).json(),
			repository,
			"0.9.2",
			"linux-x64",
			index,
		);
		expect(availability.assets).toHaveLength(3);
		for (const asset of availability.assets) {
			const response = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
				Uint8Array.from(current.bytes.get(asset.name) as Buffer),
			);
		}
		expect(await ctx.storage.getFile("products/narrafork/releases/999.0.0/meta.json")).toEqual(
			Buffer.from("historical bytes"),
		);
		expect(await ctx.storage.listFiles("products/narrafork")).toHaveLength(1);
	});
});
test("metadata-only canonical replacement withdraws old target patch union and can repair old corrupt same-digest storage", async () => {
	await withServer(async (ctx) => {
		const current = fixture();
		await uploadAll(ctx, current);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const asset = current.snapshot.assets[0];
		await ctx.storage.saveFile(`mirror-objects/${asset.sha256}`, Buffer.alloc(asset.size, 0));
		expect((await commit(ctx, current.snapshot)).status).toBe(400);
		await uploadAll(ctx, current);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const metadataOnly = fixture(false);
		metadataOnly.snapshot.index.generation = current.snapshot.index.generation + 1;
		await uploadAll(ctx, metadataOnly);
		expect((await commit(ctx, metadataOnly.snapshot)).status).toBe(200);
		const availability = await (
			await ctx.app.request(`${ctx.url}/availability/0.9.2/linux-x64`)
		).json();
		expect(availability.assets).toHaveLength(1);
		expect(
			(await ctx.app.request(`${ctx.url}/assets/${current.snapshot.assets[1].sha256}`)).status,
		).toBe(404);
		expect(
			await ctx.storage.fileExists(`mirror-objects/${current.snapshot.assets[1].sha256}`),
		).toBe(true);
	});
});
test("index historical entries do not claim locally mirrored patches", async () => {
	await withServer(async (ctx) => {
		const current = fixture(false);
		const old = fixture(true, "0.9.1");
		current.snapshot.index = mergeUpdateIndex(current.snapshot.index, old.release, repository);
		await uploadAll(ctx, current);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const historical = await (
			await ctx.app.request(`${ctx.url}/availability/0.9.1/linux-x64`)
		).json();
		expect(historical.assets).toEqual([]);
	});
});
test("wrong repo, missing canonical asset, bad digest, truncated and oversized streams cannot publish partial assets", async () => {
	await withServer(async (ctx) => {
		const current = fixture();
		expect((await commit(ctx, current.snapshot)).status).toBe(400);
		const asset = current.snapshot.assets[1];
		for (const payload of [
			Buffer.alloc(asset.size, 9),
			Buffer.alloc(asset.size - 1),
			Buffer.alloc(asset.size + 1),
		]) {
			const response = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`, {
				method: "PUT",
				headers: headers(ctx.token, asset),
				body: new ReadableStream({
					start(c) {
						c.enqueue(payload);
						c.close();
					},
				}),
			});
			expect(response.status).toBe(400);
			expect(await ctx.storage.fileExists(`mirror-objects/${asset.sha256}`)).toBe(false);
		}
		const wrong = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`, {
			method: "PUT",
			headers: { ...headers(ctx.token, asset), "x-mirror-repository": "upstream/other" },
			body: new Uint8Array([1]),
		});
		expect(wrong.status).toBe(400);
		const full = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`, {
			method: "PUT",
			headers: { ...headers(ctx.token, asset), "x-mirror-kind": "binary" },
			body: new Uint8Array([1]),
		});
		expect(full.status).toBe(400);
		expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(404);
		expect(readdirSync(join(ctx.root, "data", "mirror-objects"))).toEqual([]);
	});
});
test("operator repo configuration is required and authentication occurs before ingest", async () => {
	await withServer(
		async (ctx) => {
			const response = await ctx.app.request(`${ctx.url}/snapshot`, { method: "POST", body: "x" });
			expect(response.status).toBe(401);
			expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(400);
		},
		{ mirrorRepositories: {} },
	);
});
for (const budget of [
	{ label: "default", operator: undefined, selected: 120_000 },
	{ label: "operator above direct ceiling", operator: 900_000, selected: 120_000 },
	{ label: "stricter operator", operator: 45_000, selected: 45_000 },
]) {
	test(`direct HTTP retains ${budget.label} upload budget and ignores untrusted relay hints`, async () => {
		await withServer(
			async (ctx) => {
				const current = fixture();
				const asset = current.snapshot.assets.find((entry) => entry.kind === "patch");
				if (!asset) throw new Error("Expected canonical patch");
				const original = ctx.storage.saveVerifiedFile.bind(ctx.storage);
				// Accelerate only the intentionally stalled upload, not the healthy retry's disk IO.
				const saving = spyOn(ctx.storage, "saveVerifiedFile")
					.mockImplementation(original)
					.mockImplementationOnce((path, stream, options) =>
						original(path, stream, { ...options, timeoutMs: options.timeoutMs / 1000 }),
					);
				try {
					let cancelled = false;
					const response = await ctx.app.request(
						`${ctx.url}/assets/${asset.sha256}?delivery=relay&timeoutMs=900000`,
						{
							method: "PUT",
							headers: {
								...headers(ctx.token, asset),
								"x-mirror-delivery": "relay",
								"x-mirror-timeout-ms": "900000",
							},
							body: new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue((current.bytes.get(asset.name) as Buffer).subarray(0, 1));
								},
								cancel() {
									cancelled = true;
								},
							}),
						},
					);
					expect(saving.mock.calls[0]?.[2].timeoutMs).toBe(budget.selected);
					expect(response.status).toBe(400);
					expect((await response.json()).error).toContain("deadline");
					expect(cancelled).toBe(true);
					expect(await ctx.storage.listFiles("mirror-objects")).toEqual([]);
					expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(404);
					const retry = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`, {
						method: "PUT",
						headers: headers(ctx.token, asset),
						body: Uint8Array.from(current.bytes.get(asset.name) as Buffer),
					});
					expect(saving.mock.calls[1]?.[2].timeoutMs).toBe(budget.selected);
					expect(retry.status, await retry.text()).toBe(200);
					expect(await ctx.storage.getFile(`mirror-objects/${asset.sha256}`)).toEqual(
						current.bytes.get(asset.name) as Buffer,
					);
				} finally {
					saving.mockRestore();
				}
			},
			{ mirrorLimits: { uploadTimeoutMs: budget.operator, minFreeBytes: 0 } },
		);
	});
}

test("streaming upload deadline, abort, disk admission and quota reject without temporary leftovers", async () => {
	await withServer(async (ctx) => {
		const asset = fixture().snapshot.assets[1];
		const options = {
			size: asset.size,
			sha256: asset.sha256,
			signal: new AbortController().signal,
			timeoutMs: 15,
			quotaBytes: 1024 * 1024,
			minFreeBytes: 0,
		};
		let cancelled = false;
		await expect(
			ctx.storage.saveVerifiedFile(
				`mirror-objects/${asset.sha256}`,
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array([1]));
					},
					cancel() {
						cancelled = true;
					},
				}),
				options,
			),
		).rejects.toThrow("deadline");
		expect(cancelled).toBe(true);
		const controller = new AbortController();
		controller.abort();
		await expect(
			ctx.storage.saveVerifiedFile(`mirror-objects/${asset.sha256}`, new Blob(["x"]).stream(), {
				...options,
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted");
		await expect(
			ctx.storage.saveVerifiedFile(`mirror-objects/${asset.sha256}`, new Blob(["x"]).stream(), {
				...options,
				quotaBytes: 1,
			}),
		).rejects.toThrow("quota");
		await expect(
			ctx.storage.saveVerifiedFile(`mirror-objects/${asset.sha256}`, new Blob(["x"]).stream(), {
				...options,
				minFreeBytes: Number.MAX_SAFE_INTEGER,
			}),
		).rejects.toThrow("reserve");
		expect(readdirSync(join(ctx.root, "data", "mirror-objects"))).toEqual([]);
	});
});
test("LocalStorage stream writes chunks before EOF, bounds pending uploads and cleans a midstream error", async () => {
	await withServer(async (ctx) => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const began = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				c.enqueue(Buffer.from("first"));
			},
		});
		const saving = ctx.storage.saveFile("chunks/data", began);
		for (let i = 0; i < 100; i++) {
			const files = await ctx.storage.listFiles("chunks");
			if (files.length && (await ctx.storage.getFileSize(files[0])) === 5) break;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const temporary = (await ctx.storage.listFiles("chunks"))[0];
		expect(await ctx.storage.getFileSize(temporary)).toBe(5);
		expect(await ctx.storage.fileExists("chunks/data")).toBe(false);
		controller?.error(new Error("upstream cut off"));
		await expect(saving).rejects.toThrow("cut off");
		expect(await ctx.storage.listFiles("chunks")).toEqual([]);
		const asset = fixture().snapshot.assets[1];
		const options = {
			size: asset.size,
			sha256: asset.sha256,
			signal: new AbortController().signal,
			timeoutMs: 100,
			quotaBytes: 1024 * 1024,
			minFreeBytes: 0,
		};
		const uploads = Array.from({ length: 8 }, (_, i) =>
			ctx.storage
				.saveVerifiedFile(`mirror-objects/${String(i).repeat(64)}`, new ReadableStream(), options)
				.catch((error) => error),
		);
		await expect(
			ctx.storage.saveVerifiedFile(
				`mirror-objects/${"c".repeat(64)}`,
				new ReadableStream(),
				options,
			),
		).rejects.toThrow("concurrency");
		const results = await Promise.all(uploads);
		for (const error of results) expect(error.message).toContain("deadline");
	});
});

test("component metadata only accepts canonical manifest and declared licenses, leaving full binaries on GitHub", async () => {
	await withServer(async (ctx) => {
		const licence = Buffer.from("Original upstream licence\n");
		const manifest = {
			schemaVersion: 1,
			repository,
			tag: HELPER_RELEASE_TAG,
			commit: "a".repeat(40),
			catalogVersion: HELPER_CATALOG_VERSION,
			files: HELPER_TOOLS.flatMap((tool) =>
				HELPER_PLATFORMS.map((platform) => ({
					tool,
					platform,
					toolVersion: HELPER_TOOL_VERSIONS[tool],
					name: getHelperAssetName(tool, platform),
					size: 256,
					sha256: "a".repeat(64),
				})),
			),
			licenses: [{ name: "LICENSE-ripgrep.txt", size: licence.length, sha256: digest(licence) }],
		};
		const manifestBytes = Buffer.from(JSON.stringify(manifest));
		const payload = {
			schemaVersion: 1,
			repository,
			kind: "helpers",
			tag: HELPER_RELEASE_TAG,
			assets: [
				{
					name: HELPER_MANIFEST_FILENAME,
					size: manifestBytes.length,
					sha256: digest(manifestBytes),
					content: manifestBytes.toString("utf8"),
				},
				{
					name: "LICENSE-ripgrep.txt",
					size: licence.length,
					sha256: digest(licence),
					content: licence.toString("utf8"),
				},
			],
		};
		const url = `${ctx.url}/tools/helpers/${HELPER_RELEASE_TAG}`;
		const post = (value: unknown) =>
			ctx.app.request(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(value),
			});
		expect((await post(payload)).status).toBe(200);
		expect(await (await ctx.app.request(url)).json()).toEqual(payload);
		const original = await ctx.storage.getFile(
			`mirror-tools/narrafork/helpers/tags/${HELPER_RELEASE_TAG}.json`,
		);
		for (const mutate of [
			(p: typeof payload) => {
				p.repository = "upstream/not-fork";
			},
			(p: typeof payload) => {
				p.assets[1].sha256 = "f".repeat(64);
			},
			(p: typeof payload) => {
				p.assets.pop();
			},
			(p: typeof payload) => {
				p.assets.push({
					name: "rg-linux-x64",
					size: 3,
					sha256: digest(Buffer.from("bin")),
					content: "bin",
				});
			},
		]) {
			const changed = structuredClone(payload);
			mutate(changed);
			expect((await post(changed)).status).toBe(400);
			expect(
				await ctx.storage.getFile(`mirror-tools/narrafork/helpers/tags/${HELPER_RELEASE_TAG}.json`),
			).toEqual(original);
		}
		expect(await ctx.storage.listFiles("tools")).toEqual([]);
	});
});

test("metadata semantic identity is checked beyond digest, with old snapshot preserved on every failed commit", async () => {
	await withServer(async (ctx) => {
		const original = fixture();
		await uploadAll(ctx, original);
		expect((await commit(ctx, original.snapshot)).status).toBe(200);
		const before = await ctx.storage.getFile("mirror-snapshots/narrafork.json");
		for (const kind of ["binary-sidecar", "patch-meta"] as const) {
			const current = fixture();
			current.snapshot.index.generation = original.snapshot.index.generation + 1;
			const asset = current.snapshot.assets.find((a) => a.kind === kind) as MirrorAssetDescriptor;
			const value = JSON.parse((current.bytes.get(asset.name) as Buffer).toString("utf8"));
			if (kind === "binary-sidecar") value.repository = "upstream/untrusted";
			else value.toVersion = "0.9.3";
			const bytes = Buffer.from(JSON.stringify(value));
			current.bytes.set(asset.name, bytes);
			const file = current.snapshot.index.releases[0].files[0];
			const metadata = kind === "binary-sidecar" ? file.metadata : file.patches[0].metadata;
			metadata.size = bytes.length;
			metadata.sha256 = digest(bytes);
			current.snapshot.assets = mirrorAssetsForTarget(
				current.snapshot.index,
				current.snapshot.targetVersion,
			);
			await uploadAll(ctx, current);
			expect((await commit(ctx, current.snapshot)).status).toBe(400);
			expect(await ctx.storage.getFile("mirror-snapshots/narrafork.json")).toEqual(before);
		}
	});
});

test("new catalog invalidates changed or pruned target markers even when another target is committed", async () => {
	await withServer(async (ctx) => {
		const old = fixture(true, "0.9.1");
		const current = fixture(false);
		current.snapshot.index = mergeUpdateIndex(old.snapshot.index, current.release, repository);
		old.snapshot.index = current.snapshot.index;
		await uploadAll(ctx, old);
		await uploadAll(ctx, current);
		expect((await commit(ctx, old.snapshot)).status).toBe(200);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const changedIndex = structuredClone(current.snapshot.index);
		changedIndex.generation++;
		const changed = changedIndex.releases.find((r) => r.version === "0.9.1") as UpdateIndexRelease;
		changed.files[0].patches = [];
		const changedSnapshot = {
			...current.snapshot,
			index: changedIndex,
			indexCommit: "e".repeat(40),
		};
		expect((await commit(ctx, changedSnapshot)).status).toBe(200);
		const unavailable = await (
			await ctx.app.request(`${ctx.url}/availability/0.9.1/linux-x64`)
		).json();
		expect(unavailable.assets).toEqual([]);
		for (const asset of old.snapshot.assets) {
			expect((await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`)).status).toBe(404);
			expect(await ctx.storage.fileExists(`mirror-objects/${asset.sha256}`)).toBe(true);
		}
		const prunedIndex = structuredClone(changedIndex);
		prunedIndex.generation++;
		prunedIndex.releases = prunedIndex.releases.filter((r) => r.version !== "0.9.1");
		expect((await commit(ctx, { ...changedSnapshot, index: prunedIndex })).status).toBe(200);
		expect((await ctx.app.request(`${ctx.url}/availability/0.9.1/linux-x64`)).status).toBe(404);
		const persisted = await ctx.storage.getFile("mirror-snapshots/narrafork.json");
		expect(persisted?.length).toBeLessThanOrEqual(1024 * 1024);
		expect(JSON.parse(persisted?.toString() as string).targets).toHaveLength(1);
	});
});

test("single-target legacy state is read compatibly and atomically converted without dropping verified targets", async () => {
	await withServer(async (ctx) => {
		const old = fixture(false, "0.9.1");
		await uploadAll(ctx, old);
		await ctx.storage.saveAtomicFile(
			"mirror-snapshots/narrafork.json",
			Buffer.from(JSON.stringify(old.snapshot)),
		);
		expect(
			(await ctx.app.request(`${ctx.url}/assets/${old.snapshot.assets[0].sha256}`)).status,
		).toBe(200);
		const current = fixture(false);
		current.snapshot.index = mergeUpdateIndex(old.snapshot.index, current.release, repository);
		await uploadAll(ctx, current);
		expect((await commit(ctx, current.snapshot)).status).toBe(200);
		const persisted = JSON.parse(
			(await ctx.storage.getFile("mirror-snapshots/narrafork.json"))?.toString() as string,
		);
		expect(persisted.schemaVersion).toBe(2);
		expect(persisted.targets).toHaveLength(2);
		const restarted = createApp(ctx.storage, new MirrorIngestService(ctx.storage));
		expect(
			(await restarted.request(`${ctx.url}/assets/${old.snapshot.assets[0].sha256}`)).status,
		).toBe(200);
	});
});

test("direct HTTP and relay service share upload/commit locks, and receipts follow complete stream and durable commit", async () => {
	await withServer(async (ctx) => {
		const current = fixture(false);
		const asset = current.snapshot.assets[0];
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const pendingUpload = ctx.ingest.ingestAsset(
			"narrafork",
			asset,
			new ReadableStream({
				start(c) {
					streamController = c;
				},
			}),
			new AbortController().signal,
			"relay",
		);
		let acknowledged = false;
		void pendingUpload.then(() => {
			acknowledged = true;
		});
		const competingUpload = await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`, {
			method: "PUT",
			headers: headers(ctx.token, asset),
			body: Uint8Array.from(current.bytes.get(asset.name) as Buffer),
		});
		expect(competingUpload.status).toBe(429);
		expect(acknowledged).toBe(false);
		expect((await ctx.app.request(`${ctx.url}/assets/${asset.sha256}`)).status).toBe(404);
		streamController?.enqueue(current.bytes.get(asset.name) as Buffer);
		streamController?.close();
		expect((await pendingUpload).verification).toBe("server-sha256");
		let entered: () => void = () => {};
		const entering = new Promise<void>((r) => {
			entered = r;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const original = ctx.storage.saveAtomicFile.bind(ctx.storage);
		ctx.storage.saveAtomicFile = async (...args) => {
			entered();
			await gate;
			return original(...args);
		};
		let committed = false;
		const pendingCommit = ctx.ingest.commitMain(
			"narrafork",
			current.snapshot,
			new AbortController().signal,
		);
		void pendingCommit.then(() => {
			committed = true;
		});
		await entering;
		expect((await commit(ctx, current.snapshot)).status).toBe(409);
		expect(committed).toBe(false);
		expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(404);
		release();
		expect(await pendingCommit).toEqual({
			schemaVersion: 1,
			verification: "server-sha256",
			repository,
			indexCommit: current.snapshot.indexCommit,
			generation: current.snapshot.index.generation,
			targetVersion: current.snapshot.targetVersion,
			verified: current.snapshot.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
		});
		expect(committed).toBe(true);
		const old = fixture(false, "0.9.1");
		old.snapshot.index.generation = 1;
		const next = structuredClone(current.snapshot);
		next.index.generation = 2;
		await ctx.ingest.commitMain("narrafork", next, new AbortController().signal);
		try {
			await ctx.ingest.commitMain("narrafork", old.snapshot, new AbortController().signal);
			throw new Error("Expected stale");
		} catch (error) {
			expect(error).toBeInstanceOf(MirrorIngestError);
			expect((error as MirrorIngestError).code).toBe("STALE_CANONICAL_SNAPSHOT");
		}
	});
});

test("failed or cancelled atomic commits never acknowledge or publish, and release shared locks for retry", async () => {
	await withServer(async (ctx) => {
		const current = fixture(false);
		await uploadAll(ctx, current);
		const original = ctx.storage.saveAtomicFile.bind(ctx.storage);
		ctx.storage.saveAtomicFile = async () => {
			throw new Error("simulated disk failure");
		};
		await expect(
			ctx.ingest.commitMain("narrafork", current.snapshot, new AbortController().signal),
		).rejects.toThrow("simulated disk failure");
		expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(404);
		const tools = executorProjection("1.2.0");
		await expect(
			ctx.ingest.commitTools(
				"narrafork",
				"executor",
				tools.tag,
				tools,
				new AbortController().signal,
			),
		).rejects.toThrow("simulated disk failure");
		expect((await ctx.app.request(`${ctx.url}/tools/executor/${tools.tag}`)).status).toBe(404);
		ctx.storage.saveAtomicFile = original;
		const cancelled = new AbortController();
		cancelled.abort(new Error("cancelled fixture"));
		await expect(
			ctx.ingest.commitMain("narrafork", current.snapshot, cancelled.signal),
		).rejects.toThrow("cancelled fixture");
		await expect(
			ctx.ingest.commitTools("narrafork", "executor", tools.tag, tools, cancelled.signal),
		).rejects.toThrow("cancelled fixture");
		expect(
			(await ctx.ingest.commitMain("narrafork", current.snapshot, new AbortController().signal))
				.verification,
		).toBe("server-sha256");
		expect(
			(
				await ctx.ingest.commitTools(
					"narrafork",
					"executor",
					tools.tag,
					tools,
					new AbortController().signal,
				)
			).verification,
		).toBe("server-sha256");
	});
});

test("full 32-target canonical window keeps bounded atomic verification markers and rejects oversized stored state", async () => {
	await withServer(async (ctx) => {
		const targets = Array.from({ length: 33 }, (_, n) => fixture(false, `0.8.${n + 1}`));
		let index = targets[0].snapshot.index;
		for (const target of targets.slice(1))
			index = mergeUpdateIndex(index, target.release, repository);
		expect(index.releases).toHaveLength(32);
		const included = targets.filter((t) =>
			index.releases.some((r) => r.version === t.snapshot.targetVersion),
		);
		for (const target of included) {
			target.snapshot.index = index;
			await uploadAll(ctx, target);
			expect((await commit(ctx, target.snapshot)).status).toBe(200);
		}
		const persisted = await ctx.storage.getFile("mirror-snapshots/narrafork.json");
		expect(persisted?.length).toBeLessThanOrEqual(1024 * 1024);
		expect(JSON.parse(persisted?.toString() as string).targets).toHaveLength(32);
		expect((await new MirrorIngestService(ctx.storage).readMain("narrafork"))?.assets).toHaveLength(
			32,
		);
		await ctx.storage.saveFile(
			"mirror-snapshots/narrafork.json",
			Buffer.alloc(1024 * 1024 + 1, 32),
		);
		expect((await ctx.app.request(`${ctx.url}/index`)).status).toBe(400);
	});
});

function executorProjection(version: string, commit = "a".repeat(40)) {
	const tag = `executor-v${version}`;
	const content = JSON.stringify({
		schemaVersion: 1,
		repository,
		tag,
		commit,
		manifest: {
			version,
			protocolVersion: 1,
			releasedAt: "2026-07-01T00:00:00.000Z",
			platforms: Object.fromEntries(
				EXECUTOR_PLATFORMS.map((platform) => [
					platform,
					{
						filename: executorPublishedFilename(version, platform),
						size: 128,
						sha256: "f".repeat(64),
					},
				]),
			),
		},
		licenses: [{ name: "LICENSE-executor.txt", size: 7, sha256: digest(Buffer.from("License")) }],
	});
	return {
		schemaVersion: 1 as const,
		repository,
		kind: "executor" as const,
		tag,
		assets: [
			{
				name: EXECUTOR_MANIFEST_FILENAME,
				size: Buffer.byteLength(content),
				sha256: digest(Buffer.from(content)),
				content,
			},
			{
				name: "LICENSE-executor.txt",
				size: 7,
				sha256: digest(Buffer.from("License")),
				content: "License",
			},
		],
	};
}

for (const transport of ["direct", "pull-service"] as const) {
	test(`${transport} accepts canonical executor go-*.txt licences, rejecting undeclared files and binaries`, async () => {
		await withServer(async (ctx) => {
			const original = executorProjection("0.9.1");
			const licenses = [
				"go-stdlib.txt",
				"go-doublestar.txt",
				"go-coder-websocket.txt",
				"go-creack-pty.txt",
				"go-x-sys.txt",
				"go-purego.txt",
			].map((name) => {
				const content = `Canonical upstream licence text for ${name}\n`;
				return {
					name,
					size: Buffer.byteLength(content),
					sha256: digest(Buffer.from(content)),
					content,
				};
			});
			const manifest = JSON.parse(original.assets[0].content);
			manifest.licenses = licenses.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
			const content = JSON.stringify(manifest);
			const payload = {
				...original,
				assets: [
					{
						name: EXECUTOR_MANIFEST_FILENAME,
						size: Buffer.byteLength(content),
						sha256: digest(Buffer.from(content)),
						content,
					},
					...licenses,
				],
			};
			const url = `${ctx.url}/tools/executor/${payload.tag}`;
			const deliver = async (input: typeof payload) => {
				if (transport === "pull-service")
					return ctx.ingest.commitTools(
						"narrafork",
						"executor",
						payload.tag,
						input,
						new AbortController().signal,
					);
				const response = await ctx.app.request(url, {
					method: "POST",
					headers: { Authorization: `Bearer ${ctx.token}` },
					body: JSON.stringify(input),
				});
				if (response.status !== 200) throw new Error((await response.json()).error);
				return response.json();
			};
			const binary = {
				name: executorPublishedFilename("0.9.1", "linux-amd64"),
				size: 3,
				sha256: digest(Buffer.from("bin")),
				content: "bin",
			};
			for (const mutate of [
				(p: typeof payload) => {
					p.assets.push({ ...binary });
				},
				(p: typeof payload) => {
					p.assets.push({ ...binary, name: "undeclared.txt" });
				},
				(p: typeof payload) => {
					p.assets[1] = { ...binary };
				},
				(p: typeof payload) => {
					p.assets[1] = { ...p.assets[2] };
				},
				(p: typeof payload) => {
					p.assets[1].content += "\u0000";
					p.assets[1].size++;
					p.assets[1].sha256 = digest(Buffer.from(p.assets[1].content));
				},
				(p: typeof payload) => {
					p.assets[1].content += "altered";
					p.assets[1].size = Buffer.byteLength(p.assets[1].content);
					p.assets[1].sha256 = digest(Buffer.from(p.assets[1].content));
				},
				(p: typeof payload) => {
					p.assets[1].size++;
				},
				(p: typeof payload) => {
					p.assets[1].sha256 = "f".repeat(64);
				},
			]) {
				const invalid = structuredClone(payload);
				mutate(invalid);
				await expect(deliver(invalid)).rejects.toThrow();
				expect((await ctx.app.request(url)).status).toBe(404);
			}
			const receipt = await deliver(payload);
			expect(receipt.verification).toBe("server-sha256");
			expect(receipt.verified).toEqual(
				payload.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
			);
			expect(await (await ctx.app.request(url)).json()).toEqual(payload);
		});
	});
}

test("tools persist exact tags immutably across out-of-order requests and restart, with bounded legacy compatibility", async () => {
	await withServer(async (ctx) => {
		const next = executorProjection("1.2.0");
		const old = executorProjection("1.1.0");
		for (const payload of [next, old, next]) {
			const response = await ctx.app.request(`${ctx.url}/tools/executor/${payload.tag}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${ctx.token}` },
				body: JSON.stringify(payload),
			});
			expect(response.status, await response.clone().text()).toBe(200);
			expect(await response.json()).toEqual({
				schemaVersion: 1,
				verification: "server-sha256",
				repository,
				kind: "executor",
				tag: payload.tag,
				verified: payload.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
			});
		}
		const exactPath = `mirror-tools/narrafork/executor/tags/${next.tag}.json`;
		const before = await ctx.storage.getFile(exactPath);
		await ctx.ingest.commitTools(
			"narrafork",
			"executor",
			next.tag,
			{ ...next, assets: [...next.assets].reverse() },
			new AbortController().signal,
		);
		expect(await ctx.storage.getFile(exactPath)).toEqual(before);
		const conflict = executorProjection("1.2.0", "b".repeat(40));
		await expect(
			ctx.ingest.commitTools(
				"narrafork",
				"executor",
				next.tag,
				conflict,
				new AbortController().signal,
			),
		).rejects.toThrow("TOOLS_METADATA_CONFLICT");
		const restarted = new MirrorIngestService(ctx.storage);
		for (const payload of [next, old]) {
			expect(await restarted.readTools("narrafork", "executor", payload.tag)).toEqual(payload);
			expect(
				await (await ctx.app.request(`${ctx.url}/tools/executor/${payload.tag}`)).json(),
			).toEqual(payload);
		}
		const legacy = executorProjection("1.0.0");
		await ctx.storage.saveAtomicFile(
			"mirror-tools/narrafork/executor/current.json",
			Buffer.from(JSON.stringify(legacy)),
		);
		expect(await restarted.readTools("narrafork", "executor", legacy.tag)).toEqual(legacy);
		expect(await restarted.readTools("narrafork", "executor", "executor-v9.9.9")).toBeNull();
		await ctx.storage.saveAtomicFile(
			"mirror-tools/narrafork/executor/current.json",
			Buffer.from(JSON.stringify({ ...legacy, repository: "other/repository" })),
		);
		expect(await restarted.readTools("narrafork", "executor", legacy.tag)).toBeNull();
		expect(await ctx.storage.listFiles("tools")).toEqual([]);
	});
});
