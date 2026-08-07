/**
 * End-to-end coverage for the direct previous-stable upgrade path: generate a real zstd
 * patch from local binaries, upload it through the actual release route, then have the check
 * route hand it back to a client sitting on the previous stable version and apply it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureStableBaselinePatches } from "../../scripts/lib/stable-baseline-patch";
import { applyZstdPatch, generateZstdPatch } from "../../server/lib/zstd-patch";
import { addToken, initConfig } from "../../update-server/lib/config";
import { createCheckRoutes } from "../../update-server/routes/check";
import { createDownloadRoutes } from "../../update-server/routes/download";
import { createReleaseRoutes } from "../../update-server/routes/releases";
import { LocalStorage } from "../../update-server/storage/local";

const PRODUCT = `stable-patch-${randomUUID()}`;
const PLATFORM = "linux-x64";
const SUFFIX = "linux-x64";
const STABLE_BASE = "0.5.1";
const INTERMEDIATE_BETA = "0.5.21";
const TARGET = "0.5.22";

/** Deterministic pseudo-binary: compressible, but different enough per version. */
function makeBinary(seed: string, size = 256 * 1024): Buffer {
	const buffer = Buffer.alloc(size);
	let state = 0;
	for (let i = 0; i < seed.length; i += 1) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
	for (let i = 0; i < size; i += 1) {
		state = (state * 1103515245 + 12345) >>> 0;
		// Keep long identical runs so patches stay small, like a real binary.
		buffer[i] = i % 64 === 0 ? state & 0xff : 0x41;
	}
	return buffer;
}

function sha512(buffer: Buffer): string {
	return createHash("sha512").update(buffer).digest("base64");
}

let workDir: string;
let distDir: string;
let storageDir: string;
let configDir: string;
let app: Hono;
let uploadToken: string;
let server: ReturnType<typeof Bun.serve>;
let serverUrl: string;

const binaries = new Map<string, Buffer>();

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "nf-stable-e2e-"));
	distDir = join(workDir, "dist");
	storageDir = join(workDir, "storage");
	configDir = join(workDir, "config");
	for (const dir of [distDir, storageDir, configDir]) mkdirSync(dir, { recursive: true });

	await initConfig(join(configDir, "config.json"));
	uploadToken = (await addToken("release-e2e", "upload")).token;

	const storage = new LocalStorage(storageDir);
	app = new Hono();
	app.route("/api/v2/products", createReleaseRoutes(storage));
	app.route("/api/v2/products", createCheckRoutes(storage));
	app.route("/api/v2/products", createDownloadRoutes(storage));

	server = Bun.serve({ port: 0, fetch: app.fetch });
	serverUrl = `http://127.0.0.1:${server.port}`;

	for (const version of [STABLE_BASE, INTERMEDIATE_BETA, TARGET]) {
		const binary = makeBinary(version);
		binaries.set(version, binary);
		writeFileSync(join(distDir, `narrafork-${version}-${SUFFIX}`), binary);
	}

	// Publish the release history the way the build script does: each version carries only a
	// patch from its immediate predecessor.
	await publish(STABLE_BASE, "stable", null);
	await publish(INTERMEDIATE_BETA, "beta", STABLE_BASE);
	await publish(TARGET, "beta", INTERMEDIATE_BETA);
});

afterAll(() => {
	server?.stop(true);
	rmSync(workDir, { recursive: true, force: true });
});

async function publish(version: string, channel: string, fromVersion: string | null) {
	const binary = binaries.get(version) as Buffer;
	const filename = `narrafork-${version}-${SUFFIX}`;
	const form = new FormData();
	form.append("version", version);
	form.append("channel", channel);
	form.append("platform", PLATFORM);
	form.append("filename", filename);
	form.append("size", String(binary.length));
	form.append("sha512", sha512(binary));
	form.append("file", new Blob([Uint8Array.from(binary)]), filename);

	if (fromVersion) {
		const { patch, meta } = generateZstdPatch(binaries.get(fromVersion) as Buffer, binary, {
			fromVersion,
			toVersion: version,
		});
		form.append("zstdPatch", new Blob([Uint8Array.from(patch)]), `${filename}.zstd-patch`);
		form.append(
			"zstdPatchMeta",
			new Blob([JSON.stringify(meta)]),
			`${filename}.zstd-patch.meta.json`,
		);
	}

	const response = await fetch(`${serverUrl}/api/v2/products/${PRODUCT}/releases`, {
		method: "POST",
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: form,
	});
	expect(response.status).toBe(200);
}

async function promoteToStable(version: string) {
	const response = await fetch(
		`${serverUrl}/api/v2/products/${PRODUCT}/releases/${version}/promote`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${uploadToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ channel: "stable" }),
		},
	);
	expect(response.status).toBe(200);
}

function checkUpdate(currentVersion: string, channel = "stable") {
	return fetch(
		`${serverUrl}/api/v2/products/${PRODUCT}/releases/latest?channel=${channel}&platform=${PLATFORM}&version=${currentVersion}`,
	).then(
		(r) =>
			r.json() as Promise<{
				version?: string;
				zstdPatch?: { fromVersion: string; patchSize: number; url: string; metaUrl: string } | null;
				patchChain?: Array<{ fromVersion: string; toVersion: string }>;
			}>,
	);
}

function runEnsure() {
	return ensureStableBaselinePatches({
		client: { serverUrl, token: uploadToken, product: PRODUCT },
		targetVersion: TARGET,
		distDir,
		platformSuffixes: new Map([[PLATFORM, SUFFIX]]),
		availableFilenames: readdirSync(distDir),
	});
}

describe("direct previous-stable upgrade path", () => {
	test("a stable client has no single-step patch before promotion completes", async () => {
		const before = await checkUpdate(STABLE_BASE);
		expect(before.version).toBe(STABLE_BASE);
		expect(before.zstdPatch ?? null).toBeNull();
	});

	test("promotion plus the baseline step gives stable clients one direct patch", async () => {
		await promoteToStable(TARGET);

		// Right after the channel flip the only patch base is the intermediate beta, so a stable
		// client would have to replay the chain.
		const chained = await checkUpdate(STABLE_BASE);
		expect(chained.version).toBe(TARGET);
		expect(chained.zstdPatch ?? null).toBeNull();
		expect(chained.patchChain?.map((step) => step.fromVersion)).toEqual([
			STABLE_BASE,
			INTERMEDIATE_BETA,
		]);

		const result = await runEnsure();
		expect(result.failed).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.uploaded.map((plan) => plan.baselineVersion)).toEqual([STABLE_BASE]);

		const direct = await checkUpdate(STABLE_BASE);
		expect(direct.version).toBe(TARGET);
		expect(direct.zstdPatch?.fromVersion).toBe(STABLE_BASE);
		expect(direct.zstdPatch?.url).toContain(`fromVersion=${STABLE_BASE}`);
	});

	test("the uploaded patch reconstructs the exact published target binary", async () => {
		const direct = await checkUpdate(STABLE_BASE);
		const patchUrl = direct.zstdPatch?.url as string;
		const metaUrl = direct.zstdPatch?.metaUrl as string;

		const [patchResponse, metaResponse] = await Promise.all([
			fetch(`${serverUrl}${patchUrl}`),
			fetch(`${serverUrl}${metaUrl}`),
		]);
		expect(patchResponse.status).toBe(200);
		expect(metaResponse.status).toBe(200);

		const patch = Buffer.from(await patchResponse.arrayBuffer());
		const meta = (await metaResponse.json()) as Parameters<typeof applyZstdPatch>[2];
		expect(meta.fromVersion).toBe(STABLE_BASE);
		expect(meta.toVersion).toBe(TARGET);

		const rebuilt = applyZstdPatch(binaries.get(STABLE_BASE) as Buffer, patch, meta);
		expect(sha512(rebuilt)).toBe(sha512(binaries.get(TARGET) as Buffer));

		// A single direct patch must beat replaying the chain, otherwise the extra upload is
		// pointless for stable users.
		const chainBytes = ["0.5.21", "0.5.22"].reduce((sum, version) => {
			const stem = `narrafork-${version}-${SUFFIX}`;
			const metaPath = join(
				storageDir,
				"products",
				PRODUCT,
				"releases",
				version,
				PLATFORM,
				`${stem}.zstd-patch.meta.json`,
			);
			return sum + (JSON.parse(readFileSync(metaPath, "utf8")) as { patchSize: number }).patchSize;
		}, 0);
		expect(patch.length).toBeLessThan(chainBytes);
	});

	test("adding the stable patch does not clobber the existing intermediate patch", async () => {
		// Clients coming from the intermediate beta must keep their own one-step patch: the new
		// base is stored alongside it, not in place of it.
		const fromBeta = await checkUpdate(INTERMEDIATE_BETA);
		expect(fromBeta.version).toBe(TARGET);
		expect(fromBeta.zstdPatch?.fromVersion).toBe(INTERMEDIATE_BETA);

		const metadata = (await fetch(
			`${serverUrl}/api/v2/products/${PRODUCT}/releases/${TARGET}/metadata`,
		).then((r) => r.json())) as {
			platforms: Record<string, { zstdPatchFromVersions?: string[] }>;
		};
		expect(metadata.platforms[PLATFORM]?.zstdPatchFromVersions).toEqual([
			STABLE_BASE,
			INTERMEDIATE_BETA,
		]);
	});

	test("re-running the baseline step is a no-op", async () => {
		const result = await runEnsure();
		expect(result.uploaded).toEqual([]);
		expect(result.failed).toEqual([]);
		expect(result.skipped).toEqual([]);
	});

	test("a corrupted local baseline is refused instead of publishing a bad patch", async () => {
		const otherPlatform = "linux-arm64";
		const otherSuffix = "linux-arm64";
		// Publish a stable predecessor and target for a second platform...
		for (const [version, channel] of [
			[STABLE_BASE, "stable"],
			[TARGET, "beta"],
		] as const) {
			const binary = makeBinary(`${version}-${otherSuffix}`);
			const filename = `narrafork-${version}-${otherSuffix}`;
			writeFileSync(join(distDir, filename), binary);
			const form = new FormData();
			form.append("version", version);
			form.append("channel", channel);
			form.append("platform", otherPlatform);
			form.append("filename", filename);
			form.append("size", String(binary.length));
			form.append("sha512", sha512(binary));
			form.append("file", new Blob([Uint8Array.from(binary)]), filename);
			const response = await fetch(`${serverUrl}/api/v2/products/${PRODUCT}/releases`, {
				method: "POST",
				headers: { Authorization: `Bearer ${uploadToken}` },
				body: form,
			});
			expect(response.status).toBe(200);
		}

		// ...then tamper with the local copy of the baseline binary.
		writeFileSync(
			join(distDir, `narrafork-${STABLE_BASE}-${otherSuffix}`),
			makeBinary("tampered-baseline"),
		);

		const result = await ensureStableBaselinePatches({
			client: { serverUrl, token: uploadToken, product: PRODUCT },
			targetVersion: TARGET,
			distDir,
			platformSuffixes: new Map([[otherPlatform, otherSuffix]]),
			availableFilenames: readdirSync(distDir),
		});

		expect(result.uploaded).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].platform).toBe(otherPlatform);
		expect(result.failed[0].reason).toContain("does not match published");

		const check = await checkUpdate(STABLE_BASE, "stable");
		expect(check.zstdPatch?.fromVersion).not.toBe(undefined);
	});

	test("platforms without a local baseline binary are reported, not silently dropped", async () => {
		const result = await ensureStableBaselinePatches({
			client: { serverUrl, token: uploadToken, product: PRODUCT },
			targetVersion: TARGET,
			distDir,
			platformSuffixes: new Map([["win-x64", "windows-x64.exe"]]),
			availableFilenames: readdirSync(distDir),
		});
		expect(result.uploaded).toEqual([]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].platform).toBe("win-x64");
	});
});
