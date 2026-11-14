/**
 * Previous-stable patches are generated locally for GitHub publication. The independent
 * server mirrors their original bytes, executables and metadata; it never generates patches.
 * Client download checks below are separate from producer traffic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatMetadataJson,
} from "../../scripts/lib/binary-metadata";
import type { GhRunner } from "../../scripts/lib/github-release";
import { validatePublishedPatchSources } from "../../scripts/lib/local-github-patch-source";
import {
	planStableBaselinePatches,
	selectPreviousStableRelease,
} from "../../scripts/lib/stable-baseline-patch";
import { UpdateServerMirrorHttp } from "../../scripts/lib/update-server-bridge-http";
import { mirrorPublishedMainRelease } from "../../scripts/lib/update-server-main-mirror";
import { computeFileIdentity, getBaselineMismatch } from "../../server/lib/release-baseline";
import { applyZstdPatch, generateZstdPatch } from "../../server/lib/zstd-patch";
import { parseMirrorAvailability } from "../../shared/independent-update-mirror";
import { mergeUpdateIndex } from "../../shared/update-index";
import { createApp } from "../../update-server/app";
import { initConfig } from "../../update-server/lib/config";
import { LocalStorage } from "../../update-server/storage/local";
import { commit, mirrorFixture, repository, sha } from "./mirror-fixture";

const PLATFORM = "linux-x64";
const STABLE_BASE = "0.5.1";
const INTERMEDIATE_BETA = "0.5.21";
const TARGET = "0.5.22";
const filename = (version: string) => `narrafork-${version}-${PLATFORM}`;
function makeBinary(seed: string, size = 256 * 1024): Buffer {
	const buffer = Buffer.alloc(size);
	let state = 0;
	for (let i = 0; i < seed.length; i++) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
	for (let i = 0; i < size; i++) {
		state = (state * 1103515245 + 12345) >>> 0;
		buffer[i] = i % 64 === 0 ? state & 0xff : 0x41;
	}
	return buffer;
}
const sha512 = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");
const binaries = new Map([STABLE_BASE, INTERMEDIATE_BETA, TARGET].map((v) => [v, makeBinary(v)]));
const fixtures = new Map(
	[STABLE_BASE, INTERMEDIATE_BETA, TARGET].map((v) => [v, mirrorFixture(false, false, v)]),
);
const target = fixtures.get(TARGET) as ReturnType<typeof mirrorFixture>;
const targetFile = target.release.files[0];
const generated = new Map<string, ReturnType<typeof generateZstdPatch>>();
const history = [
	{ version: STABLE_BASE, channel: "stable", platforms: [PLATFORM] },
	{ version: INTERMEDIATE_BETA, channel: "beta", platforms: [PLATFORM] },
	{ version: TARGET, channel: "stable", platforms: [PLATFORM] },
];
let directory: string;
let distDir: string;
let storage: LocalStorage;
let app: ReturnType<typeof createApp>;
let token: string;
const producerCalls: { method: string; path: string }[] = [];
const clientCalls: string[] = [];
const githubCalls: string[][] = [];
const downloaded: string[] = [];

/** Public GitHub fixture: source reads only, including real baseline metadata identities. */
const run: GhRunner = async (args) => {
	githubCalls.push(args);
	if (args[0] !== "api" || args.some((a) => ["-X", "-F", "-f", "--method", "--input"].includes(a)))
		throw new Error("GitHub fixture only permits read-only public source queries");
	const path = args[1];
	if (!path.startsWith(`repos/${repository}/`)) throw new Error("Unexpected GitHub repository");
	for (const f of fixtures.values()) {
		if (path.endsWith(`git/ref/tags/${f.release.tag}`))
			return JSON.stringify({
				ref: `refs/tags/${f.release.tag}`,
				object: { type: "commit", sha: commit },
			});
		if (path.endsWith(`releases/tags/${f.release.tag}`)) return JSON.stringify(f.publicRelease);
		if (path.includes(`/releases/${f.publicRelease.id}/assets?`)) return JSON.stringify(f.assets);
		const asset = f.assets.find((a) => path.endsWith(`/releases/assets/${a.id}`));
		if (asset) {
			if (asset.name === f.name || asset.name.endsWith(".zstd-patch"))
				throw new Error("Full binaries and patch bodies cannot use text-buffered GitHub reads");
			return (f.raw.get(asset.name) as Buffer).toString("utf8");
		}
	}
	if (path.includes("git/ref/heads/") || path.includes("/contents/")) return target.run(args);
	throw new Error(`Unexpected GitHub source endpoint: ${path}`);
};
function producerOptions() {
	const config = { serverUrl: "https://only-in-process.invalid", token };
	return {
		kind: "main" as const,
		repository,
		tag: `v${TARGET}`,
		config,
		run,
		http: new UpdateServerMirrorHttp(config, {
			fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				const method = init?.method ?? "GET";
				producerCalls.push({ method, path });
				if (method !== "PUT" && method !== "POST")
					throw new Error("Producer readback is forbidden");
				if (!path.startsWith("/api/v3/products/narrafork/mirror/"))
					throw new Error("Legacy upload is forbidden");
				return app.request(path, init);
			}) as typeof fetch,
		}),
		downloadAsset: async (o: { assetId: number; outputPath: string; signal?: AbortSignal }) => {
			o.signal?.throwIfAborted();
			const asset = target.assets.find((a) => a.id === o.assetId);
			if (!asset || (!asset.name.endsWith(".zstd-patch") && asset.name !== filename(TARGET)))
				throw new Error("Only public patch or target binary bytes may be downloaded");
			downloaded.push(asset.name);
			await writeFile(o.outputPath, target.raw.get(asset.name) as Buffer, { flag: "wx" });
		},
	};
}
async function clientGet(path: string) {
	clientCalls.push(path);
	const response = await app.request(path);
	expect(response.status).toBe(200);
	return response;
}
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "nf-stable-canonical-e2e-"));
	distDir = join(directory, "dist");
	await mkdir(distDir);
	let ordinal = 0;
	for (const [version, f] of fixtures) {
		const bytes = binaries.get(version) as Buffer;
		await writeFile(join(distDir, filename(version)), bytes);
		const metadata = computeBinaryMetadataFromBuffer(filename(version), bytes, {
			version,
			platformId: PLATFORM,
			target: "bun-linux-x64",
			commit,
			repository,
			buildDate: f.release.publishedAt,
		});
		const raw = Buffer.from(formatMetadataJson(metadata));
		f.raw.set(filename(version), bytes);
		f.raw.set(f.release.files[0].metadata.name, raw);
		Object.assign(f.release.files[0], {
			size: bytes.length,
			sha256: sha(bytes),
			sha512: metadata.sha512,
		});
		Object.assign(f.release.files[0].metadata, { size: raw.length, sha256: sha(raw) });
		f.publicRelease.id = ++ordinal * 100;
		if (version === INTERMEDIATE_BETA) {
			f.release.prerelease = true;
			f.publicRelease.prerelease = true;
		}
		for (const asset of f.assets) {
			asset.id += ordinal * 1000;
			const content = asset.name === filename(version) ? bytes : raw;
			Object.assign(asset, { size: content.length, digest: `sha256:${sha(content)}` });
		}
	}
	const baseline = selectPreviousStableRelease(TARGET, history, PLATFORM);
	expect(baseline?.version).toBe(STABLE_BASE);
	const plan = planStableBaselinePatches({
		targetVersion: TARGET,
		platformSuffixes: new Map([[PLATFORM, PLATFORM]]),
		baselineVersions: new Map([[PLATFORM, baseline?.version as string]]),
		existingPatchFromVersions: new Map([[PLATFORM, [INTERMEDIATE_BETA]]]),
		availableFilenames: [...binaries.keys()].map(filename),
	});
	expect(plan.plans.map((p) => p.baselineVersion)).toEqual([STABLE_BASE]);
	for (const fromVersion of [STABLE_BASE, INTERMEDIATE_BETA]) {
		const value = generateZstdPatch(
			binaries.get(fromVersion) as Buffer,
			binaries.get(TARGET) as Buffer,
			{ fromVersion, toVersion: TARGET },
		);
		generated.set(fromVersion, value);
		const name = `${filename(TARGET)}.from-${fromVersion}.zstd-patch`;
		const metaName = `${name}.meta.json`;
		const meta = Buffer.from(JSON.stringify(value.meta));
		target.raw.set(name, value.patch);
		target.raw.set(metaName, meta);
		await writeFile(join(distDir, name), value.patch);
		await writeFile(join(distDir, metaName), meta);
		targetFile.patches.push({
			name,
			size: value.patch.length,
			sha256: sha(value.patch),
			fromVersion,
			metadata: { name: metaName, size: meta.length, sha256: sha(meta) },
		});
		for (const [assetName, bytes] of [
			[name, value.patch],
			[metaName, meta],
		] as const)
			target.assets.push({
				id: 4000 + target.assets.length,
				name: assetName,
				size: bytes.length,
				digest: `sha256:${sha(bytes)}`,
				state: "uploaded",
			});
	}
	let index = mergeUpdateIndex(
		null,
		fixtures.get(STABLE_BASE)?.release as typeof target.release,
		repository,
	);
	index = mergeUpdateIndex(
		index,
		fixtures.get(INTERMEDIATE_BETA)?.release as typeof target.release,
		repository,
	);
	target.index = mergeUpdateIndex(index, target.release, repository);
	await validatePublishedPatchSources({
		distDir,
		version: TARGET,
		repository,
		platformSuffixes: new Map([[PLATFORM, PLATFORM]]),
		run,
	});
	const configPath = join(directory, "config.json");
	const config = await initConfig(configPath);
	token = config.adminToken as string;
	const persisted = JSON.parse(await readFile(configPath, "utf8"));
	persisted.mirrorRepositories = { narrafork: repository };
	persisted.mirrorLimits = { quotaBytes: 4 * 1024 * 1024, minFreeBytes: 0, uploadTimeoutMs: 1000 };
	await writeFile(configPath, JSON.stringify(persisted));
	await initConfig(configPath);
	storage = new LocalStorage(join(directory, "storage"));
	app = createApp(storage);
	expect((await app.request("/api/v3/products/narrafork/mirror/index")).status).toBe(404);
	const receipt = await mirrorPublishedMainRelease(producerOptions());
	expect(receipt.status).toBe("MIRRORED");
	expect(receipt.verification).toBe("server-sha256");
	expect(receipt.snapshotCommitted).toBe(true);
	expect(receipt.uploaded).toEqual(receipt.verified);
	expect(receipt.uploaded).toHaveLength(6);
});
afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

describe("GitHub-produced previous-stable patches through the independent mirror", () => {
	test("stable selection bypasses beta and preserves local missing-baseline planning", () => {
		expect(selectPreviousStableRelease(TARGET, history, PLATFORM)).toEqual({
			version: STABLE_BASE,
		});
		const result = planStableBaselinePatches({
			targetVersion: TARGET,
			platformSuffixes: new Map([[PLATFORM, PLATFORM]]),
			baselineVersions: new Map([[PLATFORM, STABLE_BASE]]),
			existingPatchFromVersions: new Map(),
			availableFilenames: [filename(TARGET)],
		});
		expect(result.plans).toEqual([]);
		expect(result.skips).toEqual([
			{ platform: PLATFORM, reason: `missing local binaries: ${filename(STABLE_BASE)}` },
		]);
	});
	test("producer sends original binary/sidecar/patch bytes, never rebuilds or GET readback", async () => {
		expect(producerCalls.map((c) => c.method)).toEqual([
			"PUT",
			"PUT",
			"PUT",
			"PUT",
			"PUT",
			"PUT",
			"POST",
		]);
		expect(downloaded.sort()).toEqual(
			[filename(TARGET), ...targetFile.patches.map((p) => p.name)].sort(),
		);
		expect(await storage.listFiles("products")).toEqual([]);
		expect(await storage.fileExists(`mirror-objects/${targetFile.sha256}`)).toBe(true);
		for (const bytes of target.raw.values())
			expect(await storage.getFile(`mirror-objects/${sha(bytes)}`)).toEqual(bytes);
	});
	test("canonical availability exposes both exact patch pairs and clients reconstruct the target", async () => {
		const index = await (await clientGet("/api/v3/products/narrafork/mirror/index")).json();
		expect(index).toEqual(target.index);
		expect(index.channels.stable).toBe(TARGET);
		const availability = parseMirrorAvailability(
			await (
				await clientGet(`/api/v3/products/narrafork/mirror/availability/${TARGET}/${PLATFORM}`)
			).json(),
			repository,
			TARGET,
			PLATFORM,
			target.index,
		);
		expect(availability.assets).toHaveLength(5);
		for (const fromVersion of [STABLE_BASE, INTERMEDIATE_BETA]) {
			const patch = targetFile.patches.find((p) => p.fromVersion === fromVersion);
			expect(patch).toBeDefined();
			if (!patch) throw new Error("Missing canonical patch");
			for (const asset of [patch, patch.metadata])
				expect(
					availability.assets.some(
						(a) => a.name === asset.name && a.sha256 === asset.sha256 && a.size === asset.size,
					),
				).toBe(true);
			const bytes = Buffer.from(
				await (
					await clientGet(`/api/v3/products/narrafork/mirror/assets/${patch.sha256}`)
				).arrayBuffer(),
			);
			const metaBytes = Buffer.from(
				await (
					await clientGet(`/api/v3/products/narrafork/mirror/assets/${patch.metadata.sha256}`)
				).arrayBuffer(),
			);
			const expectedPatch = generated.get(fromVersion);
			const expectedMeta = target.raw.get(patch.metadata.name);
			const baselineBytes = binaries.get(fromVersion);
			const targetBytes = binaries.get(TARGET);
			if (!expectedPatch || !expectedMeta || !baselineBytes || !targetBytes)
				throw new Error("Missing exact generated patch/baseline fixture bytes");
			expect(bytes).toEqual(Buffer.from(expectedPatch.patch));
			expect(metaBytes).toEqual(Buffer.from(expectedMeta));
			const meta = JSON.parse(metaBytes.toString());
			expect(meta.fromVersion).toBe(fromVersion);
			expect(meta.toVersion).toBe(TARGET);
			expect(meta.oldFileSize).toBe(baselineBytes.length);
			expect(meta.oldFileSha512).toBe(sha512(baselineBytes));
			expect(applyZstdPatch(baselineBytes, bytes, meta)).toEqual(targetBytes);
		}
		const chainFirst = generateZstdPatch(
			binaries.get(STABLE_BASE) as Buffer,
			binaries.get(INTERMEDIATE_BETA) as Buffer,
			{ fromVersion: STABLE_BASE, toVersion: INTERMEDIATE_BETA },
		);
		expect(generated.get(STABLE_BASE)?.patch.length).toBeLessThan(
			chainFirst.patch.length + (generated.get(INTERMEDIATE_BETA)?.patch.length as number),
		);
		expect(clientCalls).toHaveLength(6);
		expect(producerCalls.some((c) => c.method === "GET")).toBe(false);
	});
	test("rerunning the stable plan is a no-op and mirroring is byte-idempotent", async () => {
		const plan = planStableBaselinePatches({
			targetVersion: TARGET,
			platformSuffixes: new Map([[PLATFORM, PLATFORM]]),
			baselineVersions: new Map([[PLATFORM, STABLE_BASE]]),
			existingPatchFromVersions: new Map([
				[PLATFORM, targetFile.patches.map((p) => p.fromVersion)],
			]),
			availableFilenames: [...binaries.keys()].map(filename),
		});
		expect(plan).toEqual({ plans: [], skips: [] });
		const before = await storage.getFile("mirror-snapshots/narrafork.json");
		const receipt = await mirrorPublishedMainRelease(producerOptions());
		expect(receipt.status).toBe("MIRRORED");
		expect(await storage.getFile("mirror-snapshots/narrafork.json")).toEqual(before);
		for (const bytes of target.raw.values())
			expect(await storage.getFile(`mirror-objects/${sha(bytes)}`)).toEqual(bytes);
	});
	test("wrong baseline size/hash is refused by the canonical GitHub source guard before publishing", async () => {
		const patch = targetFile.patches.find((p) => p.fromVersion === STABLE_BASE);
		if (!patch) throw new Error("Missing stable patch");
		const path = join(distDir, patch.metadata.name);
		const original = target.raw.get(patch.metadata.name) as Buffer;
		const before = await storage.getFile("mirror-snapshots/narrafork.json");
		for (const change of [
			{ oldFileSize: 1 },
			{ oldFileSha512: Buffer.alloc(64, 9).toString("base64") },
		]) {
			await writeFile(path, JSON.stringify({ ...JSON.parse(original.toString()), ...change }));
			try {
				await expect(
					validatePublishedPatchSources({
						distDir,
						version: TARGET,
						repository,
						platformSuffixes: new Map([[PLATFORM, PLATFORM]]),
						run,
					}),
				).rejects.toThrow("Public GitHub patch source identity mismatch");
			} finally {
				await writeFile(path, original);
			}
		}
		const localBase = join(distDir, filename(STABLE_BASE));
		await writeFile(localBase, makeBinary("tampered-baseline"));
		try {
			expect(
				getBaselineMismatch(computeFileIdentity(localBase), {
					filename: filename(STABLE_BASE),
					size: binaries.get(STABLE_BASE)?.length as number,
					sha512: sha512(binaries.get(STABLE_BASE) as Buffer),
				}),
			).toContain("sha512");
		} finally {
			await writeFile(localBase, binaries.get(STABLE_BASE) as Buffer);
		}
		expect(await storage.getFile("mirror-snapshots/narrafork.json")).toEqual(before);
	});
	for (const legacyKind of ["binary", "patch"] as const)
		test(`legacy ${legacyKind} upload is exactly retired with no storage side effects`, async () => {
			const before = await storage.getFile("mirror-snapshots/narrafork.json");
			const objectsBefore = (await storage.listFiles("mirror-objects")).sort();
			const form = new FormData();
			if (legacyKind === "binary")
				form.append("file", new Blob(["small rejected binary"]), filename(TARGET));
			else {
				form.append(
					"zstdPatch",
					new Blob([Uint8Array.from(generated.get(STABLE_BASE)?.patch as Buffer)]),
					"legacy.zstd-patch",
				);
				form.append("zstdPatchMeta", new Blob(["{}"]), "legacy.zstd-patch.meta.json");
			}
			const response = await app.request("/api/v2/products/narrafork/releases", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: form,
			});
			expect(response.status).toBe(410);
			expect((await response.json()).error).toBe(
				"Binary and legacy patch publishing is deprecated; publish to GitHub then use /api/v3/products/:product/mirror",
			);
			expect(await storage.listFiles("products")).toEqual([]);
			expect(await storage.getFile("mirror-snapshots/narrafork.json")).toEqual(before);
			expect((await storage.listFiles("mirror-objects")).sort()).toEqual(objectsBefore);
			for (const bytes of target.raw.values())
				expect(await storage.getFile(`mirror-objects/${sha(bytes)}`)).toEqual(bytes);
		});
});
