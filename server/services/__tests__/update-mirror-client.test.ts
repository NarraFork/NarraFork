import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { mirrorAssetsForTarget } from "../../../shared/independent-update-mirror";
import type { UpdateSourceIdentity } from "../../../shared/update-identity";
import {
	mergeUpdateIndex,
	UPDATE_INDEX_PLATFORMS,
	type UpdateIndexRelease,
	type UpdateIndexV1,
} from "../../../shared/update-index";
import { createApp } from "../../../update-server/app";
import { initConfig } from "../../../update-server/lib/config";
import { MirrorIngestService } from "../../../update-server/services/mirror-ingest";
import { LocalStorage } from "../../../update-server/storage/local";
import type { UpdateFetchContext } from "../../lib/net/update-fetch";
import { settings } from "../../lib/settings";
import { BUILD_PLATFORM } from "../../lib/version";
import {
	createGithubUpdateDeadline,
	downloadGithubUpdateToFile,
} from "../github-release-patch-apply";
import {
	checkMirrorUpdate,
	downloadMirrorBinary,
	downloadMirrorPatch,
	getMirrorNotes,
} from "../update-mirror-client";
import {
	checkForUpdate,
	downloadUpdate,
	getCurrentUpdateSourceIdentity,
	getUpdateDirectory,
	getUpdateStatus,
	isUpdateSourceCurrent,
	type ReleaseInfo,
} from "../update-service";

const hash = (bytes: Uint8Array | string, algorithm = "sha256") =>
	createHash(algorithm)
		.update(bytes)
		.digest(algorithm === "sha512" ? "base64" : "hex");
const currentVersion = "1.0.0";
const version = "1.0.1";
const binary = Buffer.from("canonical target fixture".repeat(400));
const baseBinary = Buffer.from("canonical source fixture".repeat(400));
const patchBytes = zstdCompressSync(binary);
const platform =
	BUILD_PLATFORM ||
	`${process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const name = `narrafork-${version}-${UPDATE_INDEX_PLATFORMS[platform]}`;
const patchName = `${name}.from-${currentVersion}.zstd-patch`;
const meta = {
	fromVersion: currentVersion,
	toVersion: version,
	oldFileSize: baseBinary.length,
	oldFileSha512: hash(baseBinary, "sha512"),
	newFileSize: binary.length,
	newFileSha512: hash(binary, "sha512"),
	patchSize: patchBytes.length,
	stableEnd: 0,
	newTailSize: binary.length,
	mode: "dictionary",
};
const identity: Extract<UpdateSourceIdentity, { source: "update-server" }> = {
	source: "update-server",
	repository: "fixture/fork",
	serverUrl: "https://mirror.example",
	product: "narrafork",
	channel: "stable",
	platform,
};
const notesBytes = Buffer.from(
	JSON.stringify({
		schemaVersion: 1,
		repository: identity.repository,
		version,
		notes: { en: "Canonical fixture notes", "zh-CN": "Canonical fixture notes" },
	}),
);
const baseUrl = `${identity.serverUrl}/api/v3/products/narrafork/mirror`;
const fullUrl = `${baseUrl}/assets/${hash(binary)}`;
const sidecarUrl = () => `${baseUrl}/assets/${hash(binarySidecar())}`;
const originalUpdate = structuredClone(settings.update);
const originalFetch = globalThis.fetch;
let directory: string;
let basePath: string;
let outputPath: string;
let calls: string[];
let mode: string;
let transport: UpdateFetchContext;
let binaryMetadataChanges: Record<string, unknown>;

function binarySidecar() {
	return Buffer.from(
		JSON.stringify({
			name,
			version,
			platform,
			size: binary.length,
			sha256: hash(binary),
			sha512: hash(binary, "sha512"),
			commit: "a".repeat(40),
			recoveryManifestVersions: [1, 2, 3],
			...binaryMetadataChanges,
		}),
	);
}

function fixturePatch() {
	return mode === "rebuild" ? zstdCompressSync(Buffer.alloc(binary.length)) : patchBytes;
}
function fixtureMetadata() {
	return Buffer.from(JSON.stringify({ ...meta, patchSize: fixturePatch().length }));
}

function index(): UpdateIndexV1 {
	return {
		schemaVersion: 1,
		repository: identity.repository,
		generation: 1,
		generatedAt: "2026-10-14T00:00:00Z",
		channels: { stable: version, beta: version },
		releases: [
			{
				version,
				tag: `v${version}`,
				commit: "a".repeat(40),
				prerelease: false,
				publishedAt: "2026-10-14T00:00:00Z",
				notes: {
					path: `notes/${version}-${hash(notesBytes)}.json`,
					size: notesBytes.length,
					sha256: hash(notesBytes),
				},
				files: [
					{
						name,
						size: binary.length,
						sha256: hash(binary),
						sha512: hash(binary, "sha512"),
						platform: identity.platform,
						metadata: {
							name: `${name}.metadata.json`,
							size: binarySidecar().length,
							sha256: hash(binarySidecar()),
						},
						patches: [
							{
								name: patchName,
								size: fixturePatch().length,
								sha256: hash(fixturePatch()),
								fromVersion: currentVersion,
								metadata: {
									name: `${patchName}.meta.json`,
									size: fixtureMetadata().length,
									sha256: hash(fixtureMetadata()),
								},
							},
						],
					},
				],
			},
		],
	};
}
function streamed(bytes: Uint8Array) {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, Math.max(1, bytes.length >> 1)));
				controller.enqueue(bytes.subarray(Math.max(1, bytes.length >> 1)));
				controller.close();
			},
		}),
		{ headers: { "Content-Length": String(bytes.length) } },
	);
}
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "nf-canonical-mirror-"));
	basePath = join(directory, "current");
	outputPath = join(directory, "output");
	await writeFile(basePath, baseBinary);
	calls = [];
	mode = "good";
	binaryMetadataChanges = {};
	transport = {
		key: "fixture-frozen-proxy",
		isCurrent: () => true,
		fetch: async (url, init) => {
			calls.push(url);
			expect(new URL(url).origin).toBe(identity.serverUrl);
			expect(init?.redirect).toBe("manual");
			if (url === `${baseUrl}/index`) return Response.json(index());
			if (url === sidecarUrl()) return streamed(binarySidecar());
			if (url === `${baseUrl}/assets/${hash(notesBytes)}`)
				return streamed(mode === "badnotes" ? Buffer.alloc(notesBytes.length) : notesBytes);
			if (url.startsWith(`${baseUrl}/availability/`)) {
				const file = index().releases[0].files[0];
				return Response.json({
					schemaVersion: 1,
					repository: identity.repository,
					version: mode === "wrongavailability" ? "999.0.0" : version,
					platform: identity.platform,
					assets:
						mode === "absent"
							? []
							: [file.patches[0], file.patches[0].metadata].map(({ name, size, sha256 }) => ({
									name,
									size,
									sha256,
								})),
				});
			}
			if (url === `${baseUrl}/assets/${hash(fixtureMetadata())}`)
				return streamed(
					mode === "badmeta" ? Buffer.alloc(fixtureMetadata().length) : fixtureMetadata(),
				);
			if (url === `${baseUrl}/assets/${hash(fixturePatch())}`) {
				if (mode === "404") return new Response(null, { status: 404 });
				if (mode === "redirect")
					return new Response(null, {
						status: 302,
						headers: { location: "https://github.com/forbidden/patch" },
					});
				if (mode === "corrupt") return streamed(Buffer.alloc(patchBytes.length));
				if (mode === "deadline")
					return new Promise((_resolve, reject) =>
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
							once: true,
						}),
					);
				return streamed(fixturePatch());
			}
			if (url === fullUrl) return streamed(binary);
			throw new Error(`Unexpected origin ${url}`);
		},
	};
});
afterEach(async () => {
	settings.update = structuredClone(originalUpdate);
	globalThis.fetch = originalFetch;
	await rm(directory, { recursive: true, force: true });
});

async function run(
	release: ReleaseInfo,
	signal = new AbortController().signal,
	cancelPatch?: () => void,
) {
	return downloadGithubUpdateToFile(
		{ release, currentVersion, basePath, outputPath, signal },
		{
			downloadPatch: (step, path, options) =>
				downloadMirrorPatch(
					release,
					path,
					{ ...options, onProgress: () => cancelPatch?.() },
					transport,
					step,
				),
			downloadFull: (target, path, options) =>
				downloadMirrorBinary(target, path, options, transport),
			resolveZstd: async () => null,
		},
	);
}
async function checked() {
	const result = await checkMirrorUpdate(identity, currentVersion, transport);
	if (!result.releaseInfo) throw new Error("Missing mirror release");
	return result.releaseInfo;
}
async function clean(output = true) {
	expect((await readdir(directory)).sort()).toEqual(output ? ["current", "output"] : ["current"]);
	if (output) expect(await readFile(outputPath)).toEqual(binary);
}

describe("real mirror routes and ingest", () => {
	function releaseFixture(targetVersion: string, fromVersion: string, old: Buffer, binary: Buffer) {
		const name = `narrafork-${targetVersion}-${UPDATE_INDEX_PLATFORMS[platform]}`;
		const patchName = `${name}.from-${fromVersion}.zstd-patch`;
		const patch = zstdCompressSync(binary);
		const metadata = Buffer.from(
			JSON.stringify({
				...meta,
				fromVersion,
				toVersion: targetVersion,
				oldFileSize: old.length,
				oldFileSha512: hash(old, "sha512"),
				newFileSize: binary.length,
				newFileSha512: hash(binary, "sha512"),
				patchSize: patch.length,
				newTailSize: binary.length,
			}),
		);
		const sidecar = Buffer.from(
			JSON.stringify({
				name,
				version: targetVersion,
				platform,
				target: `bun-${platform.replace(/^win-/, "windows-")}`,
				size: binary.length,
				sha256: hash(binary),
				sha512: hash(binary, "sha512"),
				commit: "a".repeat(40),
				recoveryManifestVersions: [1, 2, 3],
			}),
		);
		const release: UpdateIndexRelease = {
			version: targetVersion,
			tag: `v${targetVersion}`,
			commit: "a".repeat(40),
			prerelease: false,
			publishedAt: "2026-10-14T00:00:00Z",
			files: [
				{
					name,
					size: binary.length,
					sha256: hash(binary),
					sha512: hash(binary, "sha512"),
					platform,
					metadata: { name: `${name}.metadata.json`, size: sidecar.length, sha256: hash(sidecar) },
					patches: [
						{
							name: patchName,
							fromVersion,
							size: patch.length,
							sha256: hash(patch),
							metadata: {
								name: `${patchName}.meta.json`,
								size: metadata.length,
								sha256: hash(metadata),
							},
						},
					],
				},
			],
		};
		return {
			release,
			bytes: new Map([
				[name, binary],
				[`${name}.metadata.json`, sidecar],
				[patchName, patch],
				[`${patchName}.meta.json`, metadata],
			]),
		};
	}
	test.each([
		"count",
		"bytes",
	])("bounded discovery enforces version/concurrency/metadata %s budgets", async (budgetMode) => {
		const fixtures = Array.from({ length: 32 }, (_, index) =>
			releaseFixture(`1.0.${index + 1}`, currentVersion, baseBinary, binary),
		);
		const assets = new Map<string, Buffer>();
		for (const fixture of fixtures) {
			const file = fixture.release.files[0];
			const patch = file.patches[0];
			const alternativeName = `${file.name}.zstd-patch`;
			file.patches.push({
				...patch,
				name: alternativeName,
				metadata: { ...patch.metadata, name: `${alternativeName}.meta.json` },
			});
			for (const bytes of fixture.bytes.values()) assets.set(hash(bytes), bytes);
		}
		const catalog: UpdateIndexV1 = {
			...index(),
			channels: { stable: "1.0.32", beta: "1.0.32" },
			releases: fixtures.map((fixture) => fixture.release),
		};
		let active = 0;
		let maximum = 0;
		let metadataRequests = 0;
		let availabilityRequests = 0;
		const limited: UpdateFetchContext = {
			key: "bounded",
			isCurrent: () => true,
			fetch: async (url) => {
				calls.push(url);
				expect(new URL(url).origin).toBe(identity.serverUrl);
				if (url.endsWith("/index")) return Response.json(catalog);
				if (url.includes("/availability/")) {
					availabilityRequests++;
					active++;
					maximum = Math.max(maximum, active);
					await new Promise<void>((resolve) => setTimeout(resolve, 1));
					active--;
					const version = url.split("/").at(-2);
					const fixture = fixtures.find((fixture) => fixture.release.version === version);
					if (!fixture) throw new Error("Unexpected candidate version");
					const file = fixture.release.files[0];
					const value = JSON.stringify({
						schemaVersion: 1,
						repository: identity.repository,
						version,
						platform,
						assets: file.patches
							.flatMap((patch) => [patch, patch.metadata])
							.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
					});
					return new Response(budgetMode === "bytes" ? value.padEnd(250 * 1024, " ") : value);
				}
				const digest = url.split("/").at(-1) ?? "";
				const bytes = assets.get(digest);
				if (!bytes) throw new Error("Unexpected metadata identity");
				if (!bytes.toString().includes("recoveryManifestVersions")) metadataRequests++;
				return streamed(bytes);
			},
		};
		const checked = await checkMirrorUpdate(identity, currentVersion, limited);
		expect(checked.updateAvailable).toBe(true);
		expect(checked.releaseInfo?._mirror?.full.version).toBe("1.0.32");
		expect(maximum).toBeLessThanOrEqual(4);
		expect(availabilityRequests).toBeLessThanOrEqual(32);
		expect(metadataRequests).toBeLessThanOrEqual(32);
		if (budgetMode === "count") expect(metadataRequests).toBe(32);
		else expect(availabilityRequests).toBeLessThan(32);
	});
	async function realMirror() {
		const config = join(directory, "config.json");
		const initialized = await initConfig(config);
		const settings = JSON.parse(await Bun.file(config).text());
		settings.mirrorRepositories = { narrafork: identity.repository };
		settings.mirrorLimits = { minFreeBytes: 0, quotaBytes: 4 * 1024 * 1024, uploadTimeoutMs: 1000 };
		await writeFile(config, JSON.stringify(settings));
		await initConfig(config);
		const storage = new LocalStorage(join(directory, "storage"));
		const ingest = new MirrorIngestService(storage);
		const app = createApp(storage, ingest);
		const transport: UpdateFetchContext = {
			key: "real-routes",
			isCurrent: () => true,
			fetch: async (url, init) => {
				calls.push(url);
				expect(new URL(url).origin).toBe(identity.serverUrl);
				return app.request(new URL(url).pathname, init);
			},
		};
		let index: UpdateIndexV1 | null = null;
		const publish = async (fixture: ReturnType<typeof releaseFixture>, projection: 1 | 2 = 2) => {
			index = mergeUpdateIndex(index, fixture.release, identity.repository, "2026-10-14T00:00:00Z");
			const assets = mirrorAssetsForTarget(index, fixture.release.version, projection);
			for (const asset of assets) {
				const response = await app.request(`${baseUrl}/assets/${asset.sha256}`, {
					method: "PUT",
					headers: {
						authorization: `Bearer ${initialized.adminToken}`,
						"x-mirror-repository": identity.repository,
						"x-mirror-kind": asset.kind,
						"x-mirror-name": asset.name,
						"x-mirror-size": String(asset.size),
						"x-mirror-version": asset.version,
						...(asset.platform ? { "x-mirror-platform": asset.platform } : {}),
					},
					body: Uint8Array.from(fixture.bytes.get(asset.name) as Buffer),
				});
				expect(response.status).toBe(200);
			}
			const response = await app.request(`${baseUrl}/snapshot`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${initialized.adminToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: projection,
					repository: identity.repository,
					indexCommit: "b".repeat(40),
					index,
					targetVersion: fixture.release.version,
					assets,
				}),
			});
			expect(response.status, await response.text()).toBe(200);
		};
		return { app, storage, transport, publish };
	}
	test("v2 PUT/commit serves verified full and historical two-step reconstruction without GitHub", async () => {
		const real = await realMirror();
		const first = releaseFixture(version, currentVersion, baseBinary, binary);
		await real.publish(first);
		let checked = await checkMirrorUpdate(identity, currentVersion, real.transport);
		if (!checked.releaseInfo) throw new Error("Missing v2 mirror selection");
		await downloadMirrorBinary(
			checked.releaseInfo,
			outputPath,
			{ signal: new AbortController().signal },
			real.transport,
		);
		expect(await readFile(outputPath)).toEqual(binary);
		await rm(outputPath);
		const final = Buffer.from("second historical binary fixture".repeat(400));
		const second = releaseFixture("1.0.2", version, binary, final);
		await real.publish(second);
		checked = await checkMirrorUpdate(identity, currentVersion, real.transport);
		if (!checked.releaseInfo) throw new Error("Missing historical selection");
		expect(checked.releaseInfo._github).toBeUndefined();
		expect(checked.patchChain?.map((step) => [step.fromVersion, step.toVersion])).toEqual([
			[currentVersion, version],
			[version, "1.0.2"],
		]);
		const release = checked.releaseInfo;
		expect(
			await downloadGithubUpdateToFile(
				{ release, currentVersion, basePath, outputPath, signal: new AbortController().signal },
				{
					downloadPatch: (step, path, options) =>
						downloadMirrorPatch(release, path, options, real.transport, step),
					downloadFull: (target, path, options) =>
						downloadMirrorBinary(target, path, options, real.transport),
					resolveZstd: async () => null,
				},
			),
		).toBe("zstd");
		expect(await readFile(outputPath)).toEqual(final);
		const patchUrls = [first, second].map(
			(fixture) => `${baseUrl}/assets/${fixture.release.files[0].patches[0].sha256}`,
		);
		for (const url of patchUrls) expect(calls).toContain(url);
		expect(calls).toContain(`${baseUrl}/availability/${version}/${platform}`);
		expect(calls.every((url) => new URL(url).origin === identity.serverUrl)).toBe(true);
		// A missing intermediate is not silently reused from the index.
		await real.storage.deleteFile(`mirror-objects/${first.release.files[0].patches[0].sha256}`);
		const missing = await checkMirrorUpdate(identity, currentVersion, real.transport);
		expect(missing.strategy).toBe("full");
		expect(missing.patchChain).toBeUndefined();
		if (!missing.releaseInfo) throw new Error("Missing verified full after optional patch loss");
		await rm(outputPath);
		await downloadMirrorBinary(
			missing.releaseInfo,
			outputPath,
			{ signal: new AbortController().signal },
			real.transport,
		);
		expect(await readFile(outputPath)).toEqual(final);
		expect(calls.every((url) => new URL(url).origin === identity.serverUrl)).toBe(true);
	});
	test("v1 metadata-only mirror retains working delta but missing full fails at the mirror", async () => {
		const real = await realMirror();
		await real.publish(releaseFixture(version, currentVersion, baseBinary, binary), 1);
		const checked = await checkMirrorUpdate(identity, currentVersion, real.transport);
		if (!checked.releaseInfo) throw new Error("Missing legacy mirror selection");
		const release = checked.releaseInfo;
		expect(
			await downloadGithubUpdateToFile(
				{ release, currentVersion, basePath, outputPath, signal: new AbortController().signal },
				{
					downloadPatch: (step, path, options) =>
						downloadMirrorPatch(release, path, options, real.transport, step),
					downloadFull: (target, path, options) =>
						downloadMirrorBinary(target, path, options, real.transport),
					resolveZstd: async () => null,
				},
			),
		).toBe("zstd");
		expect(await readFile(outputPath)).toEqual(binary);
		await rm(outputPath);
		await expect(
			downloadMirrorBinary(
				release,
				outputPath,
				{ signal: new AbortController().signal },
				real.transport,
			),
		).rejects.toThrow("404");
		expect(calls.every((url) => new URL(url).origin === identity.serverUrl)).toBe(true);
	});
});

describe("canonical mirror recovery capabilities", () => {
	test("legacy mirror sidecars remain compatible without claiming v3", async () => {
		binaryMetadataChanges = { recoveryManifestVersions: undefined };
		expect((await checked()).recoveryManifestVersions).toEqual([1, 2]);
	});
	test("future protocol numbers do not imply v3", async () => {
		binaryMetadataChanges = { recoveryManifestVersions: [1, 2, 4] };
		expect((await checked()).recoveryManifestVersions).toEqual([1, 2, 4]);
	});
	for (const changes of [
		{ recoveryManifestVersions: null },
		{ recoveryManifestVersions: [3, 3] },
		{ recoveryManifestVersions: [] },
		{ recoveryManifestVersions: [1, 2, 256] },
		{ name: "another" },
		{ version: "999.0.0" },
		{ platform: "unknown" },
		{ size: binary.length + 1 },
		{ commit: "b".repeat(40) },
		{ sha256: "b".repeat(64) },
		{ sha512: hash("another", "sha512") },
	]) {
		test(`invalid mirror sidecar ${JSON.stringify(changes)} fails before patch selection`, async () => {
			binaryMetadataChanges = changes;
			await expect(checked()).rejects.toMatchObject({ code: "INVALID_METADATA" });
			expect(calls).toEqual([`${baseUrl}/index`, sidecarUrl()]);
		});
	}
	for (const failure of ["digest", "size", "oversize", "json", "unavailable", "redirect"]) {
		test(`mirror sidecar ${failure} cannot grant mirror v3 capabilities`, async () => {
			const original = transport.fetch;
			transport.fetch = async (url, init) => {
				if (url !== sidecarUrl()) return original(url, init);
				if (failure === "unavailable") return new Response(null, { status: 404 });
				if (failure === "redirect")
					return new Response(null, {
						status: 302,
						headers: { location: "https://evil.example/sidecar" },
					});
				if (failure === "oversize") return streamed(Buffer.alloc(64 * 1024 + 1));
				if (failure === "json") return new Response("{");
				if (failure === "size") return new Response(`${binarySidecar().toString()} `);
				return new Response(binarySidecar().toString().replace("[1,2,3]", "[1,2,4]"));
			};
			await expect(checked()).rejects.toThrow();
			expect(
				calls.some((url) => url.includes("availability") || url.includes("evil.example")),
			).toBe(false);
		});
	}
	test("same-version changed binary cannot reuse previously checked capabilities", async () => {
		expect((await checked()).recoveryManifestVersions).toContain(3);
		const changedDigest = hash("different target", "sha512");
		binaryMetadataChanges = { sha512: changedDigest, recoveryManifestVersions: undefined };
		const replacement = index();
		replacement.releases[0].files[0].sha512 = changedDigest;
		const original = transport.fetch;
		transport.fetch = async (url, init) =>
			url === `${baseUrl}/index` ? Response.json(replacement) : original(url, init);
		const release = await checked();
		expect(release.sha512).toBe(changedDigest);
		expect(release.recoveryManifestVersions).toEqual([1, 2]);
	});
	test("mirror sidecar request and stream honor the caller deadline", async () => {
		const original = transport.fetch;
		for (const stage of ["headers", "body"]) {
			transport.fetch = async (url, init) =>
				url !== sidecarUrl()
					? original(url, init)
					: stage === "headers"
						? new Promise(() => {})
						: new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(Buffer.from("{"));
									},
								}),
							);
			await expect(
				checkMirrorUpdate(identity, currentVersion, transport, AbortSignal.timeout(20)),
			).rejects.toThrow();
		}
	});
});

describe("canonical mirror actual file pipeline", () => {
	test("the check's actual overall deadline stops optional probes instead of returning full", async () => {
		const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
			originalTimeout(ms === 30_000 ? 20 : ms),
		);
		const original = transport.fetch;
		transport.fetch = async (url, init) =>
			url.includes("/availability/") ? new Promise(() => {}) : original(url, init);
		try {
			await expect(checkMirrorUpdate(identity, currentVersion, transport)).rejects.toThrow();
			expect(timeout).toHaveBeenCalledWith(30_000);
			expect(calls).not.toContain(fullUrl);
		} finally {
			timeout.mockRestore();
		}
	});
	test("full response-body deadline cancels a stalled stream and leaves no output", async () => {
		mode = "absent";
		const release = await checked();
		const original = transport.fetch;
		let cancelled = false;
		transport.fetch = async (url, init) =>
			url !== fullUrl
				? original(url, init)
				: new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(binary.subarray(0, 1));
							},
							cancel() {
								cancelled = true;
							},
						}),
					);
		const deadline = createGithubUpdateDeadline(undefined, 20);
		try {
			await expect(run(release, deadline.signal)).rejects.toThrow("overall deadline");
		} finally {
			deadline.dispose();
		}
		expect(cancelled).toBe(true);
		await clean(false);
	});
	test.each([
		"404",
		"corrupt",
		"redirect",
		"infinite",
		"sha512",
	])("full %s fails without leaving output or accessing GitHub", async (failure) => {
		mode = "absent";
		const release = await checked();
		const original = transport.fetch;
		transport.fetch = async (url, init) => {
			if (url !== fullUrl) return original(url, init);
			calls.push(url);
			if (failure === "404") return new Response(null, { status: 404 });
			if (failure === "redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "https://github.com/forbidden/full" },
				});
			if (failure === "infinite")
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(Buffer.alloc(binary.length));
						},
					}),
				);
			return streamed(failure === "corrupt" ? Buffer.alloc(binary.length) : binary);
		};
		if (failure === "sha512") {
			release.sha512 = hash("different", "sha512");
			release.files[0].sha512 = release.sha512;
			if (release._mirror) release._mirror.full.sha512 = release.sha512;
		}
		await expect(run(release)).rejects.toThrow();
		expect(calls.every((url) => new URL(url).origin === identity.serverUrl)).toBe(true);
		await clean(false);
	});
	test.each([
		"index",
		"availability",
		"notes",
	])("%s rejects cross-origin redirects without following them", async (stage) => {
		const original = transport.fetch;
		transport.fetch = async (url, init) => {
			if (
				(stage === "index" && url.endsWith("/index")) ||
				(stage === "availability" && url.includes("/availability/")) ||
				(stage === "notes" && url.endsWith(hash(notesBytes)))
			) {
				calls.push(url);
				return new Response(null, {
					status: 302,
					headers: { location: "https://github.com/forbidden/metadata" },
				});
			}
			return original(url, init);
		};
		if (stage === "index") await expect(checked()).rejects.toThrow("redirect");
		else if (stage === "notes")
			await expect(
				getMirrorNotes(identity, version, hash(binary, "sha512"), transport),
			).rejects.toThrow("redirect");
		else expect((await checked())._mirror?.patchChain).toBeUndefined();
		expect(calls.every((url) => new URL(url).origin === identity.serverUrl)).toBe(true);
	});
	test("stable channel without a published release reports NO_RELEASE rather than up-to-date", async () => {
		const betaOnly = index();
		betaOnly.releases[0].prerelease = true;
		betaOnly.channels.stable = null;
		transport.fetch = async (url) => {
			calls.push(url);
			expect(url).toBe(`${baseUrl}/index`);
			return Response.json(betaOnly);
		};
		const result = await checkMirrorUpdate(identity, currentVersion, transport);
		expect(result).toMatchObject({
			source: "update-server",
			repository: identity.repository,
			currentVersion,
			updateAvailable: false,
			errorCode: "NO_RELEASE",
		});
		expect(result.error).toBeTruthy();
		expect(result.latestVersion).toBeUndefined();
		expect(result.releaseInfo).toBeUndefined();
		expect(calls).toEqual([`${baseUrl}/index`]);
	});
	test("available direct patch verifies metadata/base/payload/output with zero GitHub requests", async () => {
		const release = await checked();
		expect(release.recoveryManifestVersions).toEqual([1, 2, 3]);
		expect(await run(release)).toBe("zstd");
		expect(calls.filter((url) => new URL(url).origin !== identity.serverUrl)).toEqual([]);
		await clean();
	});
	test.each([
		"absent",
		"badbase",
		"badbasesize",
		"404",
		"corrupt",
		"badmeta",
		"redirect",
		"rebuild",
		"wrongavailability",
	])("%s cleans owned temps and streams the same mirror full target", async (failure) => {
		mode = failure;
		const release = await checked();
		if (failure === "badbase") await writeFile(basePath, Buffer.alloc(baseBinary.length));
		if (failure === "badbasesize") await writeFile(basePath, "wrong size");
		expect(await run(release)).toBe("full");
		expect(calls).toContain(fullUrl);
		expect(calls.filter((url) => new URL(url).origin !== identity.serverUrl)).toEqual([]);
		expect(calls.some((url) => url.includes("api.github.com") || url.includes("/latest"))).toBe(
			false,
		);
		if (failure.startsWith("badbase"))
			expect(calls).not.toContain(`${baseUrl}/assets/${hash(patchBytes)}`);
		await clean();
	});
	test("zstd missing falls back without changing target", async () => {
		const release = await checked();
		const chain = release._mirror?.patchChain;
		if (!chain) throw new Error("Missing chain");
		chain[0].meta.mode = "patch-from";
		expect(await run(release)).toBe("full");
		await clean();
	});
	test("cancellation during actual patch body read has zero full requests", async () => {
		const release = await checked();
		const controller = new AbortController();
		await expect(
			run(release, controller.signal, () => controller.abort(new Error("cancel fixture"))),
		).rejects.toThrow("cancel fixture");
		expect(calls).not.toContain(fullUrl);
		await clean(false);
	});
	test("overall deadline cancels patch request and never starts full", async () => {
		const release = await checked();
		mode = "deadline";
		const deadline = createGithubUpdateDeadline(undefined, 20);
		try {
			await expect(run(release, deadline.signal)).rejects.toThrow("overall deadline");
		} finally {
			deadline.dispose();
		}
		expect(calls).not.toContain(fullUrl);
		await clean(false);
	});
	test("optional mirror notes are byte-verified and frozen to the selected repository/version/hash", async () => {
		const release = await checked();
		expect(release.notesAvailable).toBe(true);
		calls = [];
		expect((await getMirrorNotes(identity, version, release.sha512, transport)).notes).toEqual({
			en: "Canonical fixture notes",
			"zh-CN": "Canonical fixture notes",
		});
		mode = "badnotes";
		await expect(getMirrorNotes(identity, version, release.sha512, transport)).rejects.toThrow(
			"digest mismatch",
		);
		await expect(
			getMirrorNotes(identity, version, hash(Buffer.from("another"), "sha512"), transport),
		).rejects.toThrow("artifact changed");
		expect(calls.some((url) => url.includes("github.com"))).toBe(false);
	});

	test("actual main mirror check and full download preserve prepared identity on cancellation", async () => {
		settings.update = {
			...settings.update,
			source: "update-server",
			githubRepository: identity.repository,
			serverUrl: identity.serverUrl,
			product: identity.product,
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
			proxy: { mode: "direct" },
		};
		mode = "absent";
		globalThis.fetch = Object.assign(
			async (...args: Parameters<typeof fetch>) => transport.fetch(String(args[0]), args[1]),
			{ preconnect: originalFetch.preconnect },
		);
		const checked = await checkForUpdate({ force: true });
		if (!checked.releaseInfo) throw new Error("Missing actual mirror update");
		const downloaded = await downloadUpdate(checked.releaseInfo);
		expect(downloaded.success).toBe(true);
		expect(downloaded.preparedIdentity?.sourceIdentity).toEqual(checked.sourceIdentity ?? null);
		expect(downloaded.preparedIdentity?.recoveryManifestVersions).toEqual([1, 2, 3]);
		if (!downloaded.updatePath) throw new Error("Missing verified output");
		expect(await readFile(downloaded.updatePath)).toEqual(binary);
		const controller = new AbortController();
		const cancelled = await downloadUpdate(
			checked.releaseInfo,
			(progress) => {
				if (progress.phase === "downloading" && progress.bytesDownloaded > 0)
					controller.abort(new Error("cancel full fixture"));
			},
			{ signal: controller.signal },
		);
		expect(cancelled.success).toBe(false);
		expect(cancelled.error).toContain("cancel full fixture");
		expect((await getUpdateStatus()).preparedIdentity).toEqual(downloaded.preparedIdentity);
		expect(
			(await readdir(getUpdateDirectory())).filter(
				(path) => path.endsWith(".tmp") || path.startsWith(".github-patch-"),
			),
		).toEqual([]);
		expect(
			calls.filter((url) => url.includes("api.github.com") || url.includes("/latest")),
		).toEqual([]);
	});

	test("legacy mirror protocol and arbitrary full URL descriptors cannot become canonical releases", async () => {
		const unavailable = { ...transport, fetch: async () => new Response(null, { status: 410 }) };
		await expect(checkMirrorUpdate(identity, currentVersion, unavailable)).rejects.toThrow(
			"upgrade the mirror",
		);
		const poisoned = {
			...transport,
			fetch: async () => Response.json({ ...index(), fullUrl: "https://evil.example/binary" }),
		};
		await expect(checkMirrorUpdate(identity, currentVersion, poisoned)).rejects.toThrow(
			"unknown field",
		);
		expect(calls).toEqual([]);
	});

	test("wrong configured repository is refused without an asset request", async () => {
		await expect(
			checkMirrorUpdate({ ...identity, repository: "other/repo" }, currentVersion, transport),
		).rejects.toThrow("repository mismatch");
		expect(calls).toEqual([`${baseUrl}/index`]);
	});
	test.each([
		"repository",
		"serverUrl",
		"product",
		"channel",
	])("saved %s edit invalidates checked download before any new request", async (field) => {
		settings.update = {
			...settings.update,
			source: "update-server",
			githubRepository: identity.repository,
			serverUrl: identity.serverUrl,
			product: identity.product,
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
		};
		mode = "absent";
		const result = await checkForUpdate({ force: true, transport });
		if (!result.releaseInfo) throw new Error("Missing actual checked descriptor");
		const frozen = getCurrentUpdateSourceIdentity();
		if (field === "repository") settings.update.githubRepository = "other/repo";
		else if (field === "serverUrl") settings.update.serverUrl = "https://other.example";
		else if (field === "product") settings.update.product = "other";
		else settings.update.channel = "beta";
		expect(result.sourceIdentity).toEqual(frozen ?? undefined);
		expect(isUpdateSourceCurrent(result.releaseInfo)).toBe(false);
		const before = calls.length;
		expect((await downloadUpdate(result.releaseInfo)).success).toBe(false);
		expect(calls.length).toBe(before);
	});
});
