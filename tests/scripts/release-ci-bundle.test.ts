import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatMetadataJson,
} from "../../scripts/lib/binary-metadata";
import {
	type AssembleReleaseBundleOptions,
	assembleReleaseBundle,
	verifyReleaseBundle,
} from "../../scripts/lib/ci-release-bundle";
import {
	downloadReleaseAsset,
	hashReleaseFile,
	type ReleaseAssetDownloader,
} from "../../scripts/lib/ci-release-io";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_TARGETS,
	type CiReleaseBaseline,
	type CiReleaseManifest,
	type CiReleasePlan,
	type CiReleaseSmokeResult,
} from "../../scripts/lib/ci-release-types";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";

import { REMOTE_FRONTEND_CAPABILITY } from "../../shared/remote-access/application";
import { remoteReleaseFixture } from "./remote-frontend-release.fixture";

const roots: string[] = [];
let infoCalls: unknown[][] = [];
let restoreInfo: (() => void) | undefined;
beforeEach(() => {
	infoCalls = [];
	const logger = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
		infoCalls.push(args);
	});
	restoreInfo = () => logger.mockRestore();
});
afterEach(async () => {
	restoreInfo?.();
	restoreInfo = undefined;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface PhaseRecord {
	event: "release.phase";
	id: number;
	parentId?: number;
	phase: string;
	state: "start" | "end";
	timestamp: string;
	durationMs?: number;
	status?: "success" | "error" | "cancelled";
	controllerRssBytes: number;
	errorKind?: "Error" | "AbortError" | "TimeoutError";
	platform?: string;
	version?: string;
	fromVersion?: string;
	inputBytes?: number;
	outputBytes?: number;
	fileCount?: number;
	targetCount?: number;
	baselineCount?: number;
}

function phaseRecords(): PhaseRecord[] {
	return infoCalls.flatMap(([message]) => {
		if (typeof message !== "string" || !message.startsWith("{")) return [];
		const record = JSON.parse(message);
		return record.event === "release.phase" ? [record as PhaseRecord] : [];
	});
}

function expectPairedPhases(records: PhaseRecord[]) {
	expect(records.length).toBeGreaterThan(0);
	const starts = records.filter((record) => record.state === "start");
	expect(starts.length * 2).toBe(records.length);
	expect(new Set(starts.map((record) => record.id)).size).toBe(starts.length);
	const safeKeys = new Set([
		"event",
		"id",
		"parentId",
		"phase",
		"state",
		"timestamp",
		"durationMs",
		"status",
		"controllerRssBytes",
		"errorKind",
		"platform",
		"version",
		"fromVersion",
		"inputBytes",
		"outputBytes",
		"fileCount",
		"targetCount",
		"baselineCount",
	]);
	for (const record of records) {
		expect(Object.keys(record).every((key) => safeKeys.has(key))).toBe(true);
		expect(record.phase).toMatch(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/);
		expect(record.phase.length).toBeLessThanOrEqual(96);
		expect(Number.isFinite(Date.parse(record.timestamp))).toBe(true);
		expect(record.controllerRssBytes).toBeGreaterThan(0);
	}
	for (const start of starts) {
		const pair = records.filter((record) => record.id === start.id);
		expect(pair).toHaveLength(2);
		const end = pair[1];
		if (!end) throw new Error("fixture missing phase end boundary");
		expect(end).toMatchObject({ phase: start.phase, state: "end" });
		expect(end.parentId).toBe(start.parentId);
		expect(end.durationMs).toBeGreaterThanOrEqual(0);
		if (end.status === undefined) throw new Error("fixture missing phase end status");
		expect(["success", "error", "cancelled"]).toContain(end.status);
		expect(start.status).toBeUndefined();
		expect(start.durationMs).toBeUndefined();
		if (start.parentId !== undefined) {
			const parent = records.find(
				(record) => record.id === start.parentId && record.state === "start",
			);
			const parentEnd = records.find(
				(record) => record.id === start.parentId && record.state === "end",
			);
			expect(parent).toBeDefined();
			expect(parentEnd).toBeDefined();
			if (!parent || !parentEnd || !end) throw new Error("fixture missing phase boundary");
			expect(records.indexOf(parent)).toBeLessThan(records.indexOf(start));
			expect(records.indexOf(parentEnd)).toBeGreaterThan(records.indexOf(end));
		}
	}
}

async function fixture(declareHelpers = false) {
	const root = await mkdtemp(join(tmpdir(), "nf-ci-bundle-test-"));
	roots.push(root);
	const plan: CiReleasePlan = {
		schemaVersion: 1,
		repository: "NarraFork/NarraFork",
		tag: "v2.0.0",
		version: "2.0.0",
		commit: "a".repeat(40),
		workflowCommit: "b".repeat(40),
		bunVersion: CI_RELEASE_BUN,
		channel: "stable",
		changelog: { version: "2.0.0", date: "2026-10-08", en: "Release", "zh-CN": "发布" },
		runId: 1,
		runAttempt: 1,
		baselines: [],
	};
	const platformsDir = join(root, "platforms");
	const smokeDir = join(root, "smoke");
	const bundleDir = join(root, "bundle");
	for (const target of CI_RELEASE_TARGETS) {
		const directory = join(platformsDir, target.target);
		const smokeDirectory = join(smokeDir, target.target);
		await mkdir(directory, { recursive: true });
		await mkdir(smokeDirectory, { recursive: true });
		const name = `narrafork-${plan.version}-${target.suffix}`;
		const bytes = Buffer.from(`new-${target.platform}-binary-content\n`.repeat(1024));
		const metadata = computeBinaryMetadataFromBuffer(name, bytes, {
			version: plan.version,
			platformId: target.platform,
			target: `bun-${target.target}`,
			commit: plan.commit.slice(0, 12),
			buildDate: "2026-10-08T00:00:00.000Z",
			...(declareHelpers
				? { helperDistribution: createHelperDistributionDependencies("0.9.1") }
				: {}),
		});
		await writeFile(join(directory, name), bytes);
		await writeFile(join(directory, `${name}.metadata.json`), formatMetadataJson(metadata));
		const smoke: CiReleaseSmokeResult = {
			schemaVersion: 1,
			target: target.target,
			commit: plan.commit,
			version: plan.version,
			size: metadata.size,
			sha256: metadata.sha256,
			sha512: metadata.sha512,
			checks: {
				startup: true,
				frontend: true,
				database: true,
				watcher: true,
				pty: true,
				signature: target.target.startsWith("darwin-"),
			},
		};
		await writeFile(join(smokeDirectory, "smoke.json"), JSON.stringify(smoke));
	}
	const options: AssembleReleaseBundleOptions = {
		plan,
		platformsDir,
		smokeDir,
		bundleDir,
		...(declareHelpers
			? { targetHelperDistribution: createHelperDistributionDependencies("0.9.1") }
			: {}),
	};
	return { root, options, plan, name: `narrafork-${plan.version}-linux-x64` };
}

async function fixtureSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
	return Promise.all(
		CI_RELEASE_TARGETS.map(async (target) => {
			const name = `narrafork-${f.plan.version}-${target.suffix}`;
			const directory = join(f.options.platformsDir, target.target);
			return {
				binary: await readFile(join(directory, name)),
				sidecar: await readFile(join(directory, `${name}.metadata.json`)),
				smoke: await readFile(join(f.options.smokeDir, target.target, "smoke.json")),
			};
		}),
	);
}

async function baseline(f: Awaited<ReturnType<typeof fixture>>) {
	const bytes = Buffer.from("old-linux-x64-binary-content\n".repeat(1024));
	const name = "narrafork-1.0.0-linux-x64";
	const metadata = computeBinaryMetadataFromBuffer(name, bytes, {
		version: "1.0.0",
		platformId: "linux-x64",
		target: "bun-linux-x64",
		commit: "c".repeat(40),
		buildDate: "2026-10-01T00:00:00.000Z",
	});
	const sidecar = formatMetadataJson(metadata);
	const base: CiReleaseBaseline = {
		releaseId: 1,
		version: "1.0.0",
		platform: "linux-x64",
		binaryAsset: { id: 2, name, size: bytes.length },
		metadataAsset: { id: 3, name: `${name}.metadata.json`, size: Buffer.byteLength(sidecar) },
		metadataSha256: createHash("sha256").update(sidecar).digest("hex"),
		metadata,
	};
	f.plan.baselines.push(base);
	const downloaded: number[] = [];
	const downloadAsset: ReleaseAssetDownloader = async (options) => {
		downloaded.push(options.assetId);
		await writeFile(options.outputPath, options.assetId === 2 ? bytes : sidecar, { flag: "wx" });
	};
	f.options.dependencies = { downloadAsset };
	return { base, bytes, downloaded };
}

async function changeManifest(
	f: Awaited<ReturnType<typeof fixture>>,
	change: (manifest: CiReleaseManifest) => void,
) {
	const path = join(f.options.bundleDir, "manifest.json");
	const manifest = JSON.parse(await readFile(path, "utf8")) as CiReleaseManifest;
	change(manifest);
	await writeFile(path, JSON.stringify(manifest));
}

async function refreshFileRecord(f: Awaited<ReturnType<typeof fixture>>, name: string) {
	const identity = await hashReleaseFile(join(f.options.bundleDir, "dist", name));
	await changeManifest(f, (manifest) => {
		const record = manifest.files.find((entry) => entry.name === name);
		if (!record) throw new Error("fixture missing file");
		Object.assign(record, identity);
	});
}

async function withFakeGh(script: string, run: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "nf-ci-download-test-"));
	roots.push(root);
	await writeFile(join(root, "gh"), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
	const originalPath = process.env.PATH;
	process.env.PATH = `${root}:${originalPath ?? ""}`;
	try {
		await run(root);
	} finally {
		process.env.PATH = originalPath;
	}
}

describe("bounded production gh asset streaming with a local fixture executable", () => {
	test("requests an exact API asset ID and streams successful bytes", async () => {
		await withFakeGh(
			`if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["api", "repos/NarraFork/NarraFork/releases/assets/42", "-H", "Accept: application/octet-stream"])) process.exit(7); process.stdout.write("asset-bytes");`,
			async (root) => {
				const outputPath = join(root, "asset");
				await downloadReleaseAsset({
					repository: "NarraFork/NarraFork",
					assetId: 42,
					size: 11,
					outputPath,
				});
				expect(await readFile(outputPath, "utf8")).toBe("asset-bytes");
			},
		);
	});
	test("too many/too few bytes and nonzero exit fail and remove only owned output", async () => {
		for (const script of [
			'process.stdout.write("too many bytes");',
			'process.stdout.write("x");',
			'process.stderr.write("denied");process.exit(1);',
		]) {
			await withFakeGh(script, async (root) => {
				const outputPath = join(root, "asset");
				await expect(
					downloadReleaseAsset({
						repository: "NarraFork/NarraFork",
						assetId: 42,
						size: 4,
						outputPath,
					}),
				).rejects.toThrow();
				expect(await readdir(root)).not.toContain("asset");
			});
		}
	});
	test("cancellation terminates the owned gh child and removes partial output", async () => {
		await withFakeGh('process.stdout.write("part");setInterval(() => {}, 1000);', async (root) => {
			const outputPath = join(root, "asset");
			await expect(
				downloadReleaseAsset({
					repository: "NarraFork/NarraFork",
					assetId: 42,
					size: 100,
					outputPath,
					signal: AbortSignal.timeout(100),
				}),
			).rejects.toThrow();
			expect(await readdir(root)).not.toContain("asset");
		});
	});
	test("stderr flood is bounded and a failed exclusive open preserves existing data", async () => {
		await withFakeGh(
			'process.stderr.write("x".repeat(100000));setInterval(() => {}, 1000);',
			async (root) => {
				await expect(
					downloadReleaseAsset({
						repository: "NarraFork/NarraFork",
						assetId: 42,
						size: 4,
						outputPath: join(root, "asset"),
					}),
				).rejects.toThrow();
			},
		);
		await withFakeGh('process.stdout.write("data");', async (root) => {
			const outputPath = join(root, "asset");
			await writeFile(outputPath, "existing");
			await expect(
				downloadReleaseAsset({
					repository: "NarraFork/NarraFork",
					assetId: 42,
					size: 4,
					outputPath,
				}),
			).rejects.toThrow();
			expect(await readFile(outputPath, "utf8")).toBe("existing");
		});
	});
});

describe("remote frontend bundle contract", () => {
	test("seals the exact two assets and binds declaration to expected target", async () => {
		const f = await fixture();
		f.plan.remoteFrontend = REMOTE_FRONTEND_CAPABILITY;
		const remote = await remoteReleaseFixture(f.root, f.plan);
		const manifest = await assembleReleaseBundle({
			...f.options,
			remoteFrontendDir: remote.directory,
		});
		expect(manifest.files).toHaveLength(20);
		for (const name of Object.values(remote.names))
			expect(await readFile(join(f.options.bundleDir, "dist", name))).toEqual(
				await readFile(join(remote.directory, name)),
			);
		expect((await verifyReleaseBundle(f.options.bundleDir, f.plan)).plan.remoteFrontend).toEqual(
			REMOTE_FRONTEND_CAPABILITY,
		);
		await expect(
			verifyReleaseBundle(f.options.bundleDir, { ...f.plan, remoteFrontend: undefined }),
		).rejects.toThrow("remoteFrontend");
	});
	test("declared target cannot seal without artifacts and historical target cannot acquire them", async () => {
		const f = await fixture();
		f.plan.remoteFrontend = REMOTE_FRONTEND_CAPABILITY;
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("artifact is missing");
		f.plan.remoteFrontend = undefined;
		const remote = await remoteReleaseFixture(f.root, f.plan);
		await expect(
			assembleReleaseBundle({ ...f.options, remoteFrontendDir: remote.directory }),
		).rejects.toThrow("Historical plan");
	});
	test("remote corruption and a self-consistently rehashed wrong source commit cannot pass restore", async () => {
		const f = await fixture();
		f.plan.remoteFrontend = REMOTE_FRONTEND_CAPABILITY;
		const remote = await remoteReleaseFixture(f.root, f.plan);
		await assembleReleaseBundle({ ...f.options, remoteFrontendDir: remote.directory });
		await writeFile(join(f.options.bundleDir, "dist", remote.names.archive), "broken");
		await refreshFileRecord(f, remote.names.archive);
		await expect(verifyReleaseBundle(f.options.bundleDir, f.plan)).rejects.toThrow();
	});
});

describe("immutable eight-platform CI bundle", () => {
	test("assembles first full-only release and verifies without rewriting bytes", async () => {
		const f = await fixture();
		await writeFile(
			join(f.options.platformsDir, "linux-x64", "diagnostic.log"),
			"ignored build diagnostic",
		);
		const manifest = await assembleReleaseBundle(f.options);
		const records = phaseRecords();
		expectPairedPhases(records);
		expect(
			records
				.filter((record) => record.state === "end")
				.every((record) => record.status === "success"),
		).toBe(true);
		for (const phase of [
			"bundle.assemble",
			"platform.read",
			"platform.metadata.read",
			"platform.binary.hash",
			"platform.metadata.verify",
			"platform.smoke.verify",
			"platform.stage.binary.copy",
			"platform.stage.sidecar.copy",
			"platform.stage.binary.hash",
			"bundle.manifest.hash",
			"bundle.manifest.write",
			"bundle.verify",
			"bundle.verify.assets.hash",
			"bundle.verify.platforms.read",
			"bundle.verify.platform.read",
			"bundle.verify.smoke.verify",
			"bundle.verify.publisher.dryrun",
			"bundle.seal.rename",
			"bundle.staging.cleanup",
		]) {
			expect(records.some((record) => record.phase === phase)).toBe(true);
		}
		const assembly = records.find(
			(record) => record.phase === "bundle.assemble" && record.state === "end",
		);
		expect(assembly).toMatchObject({ version: f.plan.version, targetCount: 8, baselineCount: 0 });
		const hashes = records.find(
			(record) => record.phase === "bundle.manifest.hash" && record.state === "end",
		);
		expect(hashes).toMatchObject({
			fileCount: 18,
			outputBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
		});
		const dryRun = records.find(
			(record) => record.phase === "bundle.verify.publisher.dryrun" && record.state === "end",
		);
		const verify = records.find(
			(record) => record.phase === "bundle.verify" && record.state === "start",
		);
		expect(dryRun).toMatchObject({
			status: "success",
			version: f.plan.version,
			fileCount: 18,
			parentId: verify?.id,
		});
		expect(dryRun?.durationMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(records)).not.toContain(f.root);
		expect(JSON.stringify(records)).not.toContain("ignored build diagnostic");
		expect(manifest.files).toHaveLength(18);
		expect(manifest.smoke).toHaveLength(8);
		expect((await readdir(f.options.bundleDir)).sort()).toEqual(["dist", "manifest.json"]);
		const before = await readFile(join(f.options.bundleDir, "manifest.json"));
		expect(await verifyReleaseBundle(f.options.bundleDir, f.plan)).toEqual(manifest);
		expect(await readFile(join(f.options.bundleDir, "manifest.json"))).toEqual(before);
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("already exists");
	});
	test("missing one platform is fatal, not a partial release", async () => {
		const f = await fixture();
		await rm(join(f.options.platformsDir, "windows-arm64"), { recursive: true });
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("build platforms");
	});
	test("extra platform is rejected even if it contains valid-looking files", async () => {
		const f = await fixture();
		await mkdir(join(f.options.platformsDir, "surprise"));
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("build platforms");
	});
	test("rejects metadata and smoke hash mismatch before sealing", async () => {
		const f = await fixture();
		await writeFile(join(f.options.platformsDir, "linux-x64", f.name), "changed binary");
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow();
		const g = await fixture();
		const path = join(g.options.smokeDir, "linux-x64", "smoke.json");
		const smoke = JSON.parse(await readFile(path, "utf8"));
		smoke.sha256 = "f".repeat(64);
		await writeFile(path, JSON.stringify(smoke));
		await expect(assembleReleaseBundle(g.options)).rejects.toThrow("smoke linux-x64");
	});
	test("requires genuine watcher/PTy success and macOS signature", async () => {
		for (const [target, key] of [
			["linux-x64", "watcher"],
			["windows-arm64", "pty"],
			["darwin-arm64", "signature"],
		] as const) {
			const f = await fixture();
			const path = join(f.options.smokeDir, target, "smoke.json");
			const smoke = JSON.parse(await readFile(path, "utf8"));
			smoke.checks[key] = false;
			await writeFile(path, JSON.stringify(smoke));
			await expect(assembleReleaseBundle(f.options)).rejects.toThrow();
		}
	});
	test("does not consume symlinked binary or platform directories", async () => {
		const f = await fixture();
		const path = join(f.options.platformsDir, "linux-x64", f.name);
		const bytes = await readFile(path);
		await rm(path);
		const other = join(f.root, "external");
		await writeFile(other, bytes);
		await symlink(other, path);
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("size/type");
		const g = await fixture();
		const dir = join(g.options.platformsDir, "linux-x64");
		await rm(dir, { recursive: true });
		await symlink(join(g.options.platformsDir, "linux-arm64"), dir);
		await expect(assembleReleaseBundle(g.options)).rejects.toThrow("directory type");
	});
	test("streaming hashes enforce size bounds and cancellation", async () => {
		const f = await fixture();
		const path = join(f.options.platformsDir, "linux-x64", f.name);
		await expect(hashReleaseFile(path, 10)).rejects.toThrow("size/type");
		await expect(hashReleaseFile(path, undefined, AbortSignal.abort())).rejects.toThrow();
		await expect(
			assembleReleaseBundle({ ...f.options, signal: AbortSignal.abort() }),
		).rejects.toThrow();
	});
	test("detects file tampering and expected release target mismatch", async () => {
		const f = await fixture();
		await assembleReleaseBundle(f.options);
		await expect(
			verifyReleaseBundle(f.options.bundleDir, { ...f.plan, commit: "c".repeat(40) }),
		).rejects.toThrow("expected target");
		await writeFile(join(f.options.bundleDir, "dist", f.name), "tampered");
		await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow("size/hash");
	});
	test("rejects traversal names, duplicate manifest entries, and nonstrict schemas", async () => {
		for (const mode of ["path", "duplicate", "extra", "version"] as const) {
			const f = await fixture();
			await assembleReleaseBundle(f.options);
			await changeManifest(f, (manifest) => {
				const first = manifest.files[0];
				if (!first) throw new Error("fixture");
				if (mode === "path") first.name = "../escape";
				if (mode === "duplicate") manifest.files.push(first);
				if (mode === "extra") Object.assign(manifest, { unexpected: true });
				if (mode === "version") Object.assign(manifest, { schemaVersion: 2 });
			});
			await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow();
		}
	});
	test("rejects extra dist/root entries, directory assets and symlinks", async () => {
		for (const mode of ["extra", "root", "directory", "link"] as const) {
			const f = await fixture();
			await assembleReleaseBundle(f.options);
			const path = join(f.options.bundleDir, "dist", f.name);
			if (mode === "extra") await writeFile(join(f.options.bundleDir, "dist", "extra"), "x");
			if (mode === "root") await writeFile(join(f.options.bundleDir, "extra"), "x");
			if (mode === "directory") {
				await rm(path);
				await mkdir(path);
			}
			if (mode === "link") {
				await rm(path);
				await symlink(join(f.options.platformsDir, "linux-x64", f.name), path);
			}
			await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow();
		}
	});
	test("missing complete platform or duplicate smoke cannot be hidden by updating manifest", async () => {
		const f = await fixture();
		await assembleReleaseBundle(f.options);
		await rm(join(f.options.bundleDir, "dist", f.name));
		await changeManifest(f, (manifest) => {
			manifest.files = manifest.files.filter((entry) => entry.name !== f.name);
		});
		await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow();
		const g = await fixture();
		await assembleReleaseBundle(g.options);
		await changeManifest(g, (manifest) => {
			const smoke = manifest.smoke[0];
			if (!smoke) throw new Error("fixture");
			manifest.smoke[1] = smoke;
		});
		await expect(verifyReleaseBundle(g.options.bundleDir)).rejects.toThrow("smoke platforms");
	});
	test("checksum content is revalidated even after the manifest hashes are changed", async () => {
		const f = await fixture();
		await assembleReleaseBundle(f.options);
		const name = `narrafork-${f.plan.version}-SHA256SUMS`;
		await writeFile(join(f.options.bundleDir, "dist", name), "bad sums\n");
		await refreshFileRecord(f, name);
		await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow("checksum content");
	});
	test("downloads exact base IDs and generates/applies a real zstd patch locally", async () => {
		const f = await fixture();
		const base = await baseline(f);
		const snapshot = await fixtureSnapshot(f);
		const manifest = await assembleReleaseBundle(f.options);
		const records = phaseRecords();
		expectPairedPhases(records);
		for (const phase of [
			"baseline.sidecar.download",
			"baseline.sidecar.verify",
			"baseline.binary.download",
			"baseline.binary.hash",
			"baseline.patch.generate",
			"baseline.patch.hash",
			"baseline.patch.rebuild",
			"baseline.patch.rebuild.hash",
			"baseline.patch.copy",
			"baseline.patch.metadata.write",
			"baseline.scratch.cleanup",
		]) {
			expect(
				records.find((record) => record.phase === phase && record.state === "end"),
			).toMatchObject({
				status: "success",
				platform: base.base.platform,
				version: f.plan.version,
				fromVersion: base.base.version,
			});
		}
		const patch = manifest.files.find((file) => file.name.endsWith(".zstd-patch"));
		expect(
			records.find((record) => record.phase === "baseline.patch.hash" && record.state === "end"),
		).toMatchObject({ outputBytes: patch?.size });
		expect(await fixtureSnapshot(f)).toEqual(snapshot);
		expect(base.downloaded).toEqual([3, 2]);
		expect(manifest.files).toHaveLength(20);
		expect(manifest.files.some((file) => file.name === `${f.name}.from-1.0.0.zstd-patch`)).toBe(
			true,
		);
		expect(await verifyReleaseBundle(f.options.bundleDir)).toEqual(manifest);
	});
	test("bad downloaded base or sidecar is fatal; there is no full-only fallback", async () => {
		for (const assetId of [2, 3]) {
			const f = await fixture();
			await baseline(f);
			const original = f.options.dependencies?.downloadAsset;
			if (!original) throw new Error("fixture");
			f.options.dependencies = {
				downloadAsset: async (options) => {
					if (options.assetId === assetId) await writeFile(options.outputPath, "corrupt");
					else await original(options);
				},
			};
			await expect(assembleReleaseBundle(f.options)).rejects.toThrow();
			expect(await readdir(f.root)).not.toContain("bundle");
			expect((await readdir(f.root)).some((name) => name.startsWith(".ci-release-bundle-"))).toBe(
				false,
			);
		}
	});
	test("network and zstd errors preserve errors and snapshots while timing cleanup", async () => {
		for (const stage of ["network", "zstd"] as const) {
			infoCalls = [];
			const f = await fixture();
			await baseline(f);
			const snapshot = await fixtureSnapshot(f);
			const failure = new Error(`private-${stage}-diagnostic https://secret.invalid/token`);
			if (stage === "network")
				f.options.dependencies = {
					downloadAsset: async () => {
						throw failure;
					},
				};
			else
				f.options.dependencies = {
					...f.options.dependencies,
					generatePatch: async () => {
						throw failure;
					},
				};
			await expect(assembleReleaseBundle(f.options)).rejects.toBe(failure);
			const records = phaseRecords();
			expectPairedPhases(records);
			for (const phase of [
				"bundle.assemble",
				stage === "network" ? "baseline.sidecar.download" : "baseline.patch.generate",
			]) {
				expect(
					records.find((record) => record.phase === phase && record.state === "end"),
				).toMatchObject({ status: "error", errorKind: "Error" });
			}
			for (const phase of ["baseline.scratch.cleanup", "bundle.staging.cleanup"]) {
				expect(
					records.find((record) => record.phase === phase && record.state === "end"),
				).toMatchObject({ status: "success" });
			}
			expect(JSON.stringify(records)).not.toContain(failure.message);
			expect(JSON.stringify(records)).not.toContain(f.root);
			expect(await fixtureSnapshot(f)).toEqual(snapshot);
			expect((await readdir(f.root)).sort()).toEqual(["platforms", "smoke"]);
		}
	});
	test("cancelled patch generation keeps the original reason and still times cleanup", async () => {
		const f = await fixture();
		await baseline(f);
		const snapshot = await fixtureSnapshot(f);
		const controller = new AbortController();
		const reason = new DOMException("private cancelled diagnostic", "AbortError");
		f.options.signal = controller.signal;
		f.options.dependencies = {
			...f.options.dependencies,
			generatePatch: async (options) => {
				controller.abort(reason);
				options.signal?.throwIfAborted();
				throw new Error("fixture did not propagate cancellation");
			},
		};
		await expect(assembleReleaseBundle(f.options)).rejects.toBe(reason);
		const records = phaseRecords();
		expectPairedPhases(records);
		for (const phase of ["baseline.patch.generate", "bundle.assemble"]) {
			expect(
				records.find((record) => record.phase === phase && record.state === "end"),
			).toMatchObject({ status: "cancelled", errorKind: "AbortError" });
		}
		for (const phase of ["baseline.scratch.cleanup", "bundle.staging.cleanup"]) {
			expect(
				records.find((record) => record.phase === phase && record.state === "end"),
			).toMatchObject({ status: "success" });
		}
		expect(JSON.stringify(records)).not.toContain(reason.message);
		expect(await fixtureSnapshot(f)).toEqual(snapshot);
		expect((await readdir(f.root)).sort()).toEqual(["platforms", "smoke"]);
	});
	test("reconstructed output is independently hashed, not trusted from apply's return", async () => {
		const f = await fixture();
		await baseline(f);
		f.options.dependencies = {
			...f.options.dependencies,
			applyPatch: async (options) => {
				await writeFile(options.outputFilePath, "incorrect reconstruction");
				return { sizeBytes: options.meta.newFileSize, sha512: options.meta.newFileSha512 };
			},
		};
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("restored patch");
	});
	test("a verified patch no smaller than full is omitted rather than published", async () => {
		const f = await fixture();
		const { base } = await baseline(f);
		const targetPath = join(f.options.platformsDir, "linux-x64", f.name);
		const target = await hashReleaseFile(targetPath);
		let applied = false;
		f.options.dependencies = {
			...f.options.dependencies,
			generatePatch: async (options) => {
				await writeFile(options.patchOutputPath, Buffer.alloc(target.size));
				return {
					fromVersion: base.version,
					toVersion: f.plan.version,
					oldFileSize: base.metadata.size,
					oldFileSha512: base.metadata.sha512,
					stableEnd: 0,
					newTailSize: target.size,
					patchSize: target.size,
					newFileSize: target.size,
					newFileSha512: target.sha512,
					mode: "patch-from",
				};
			},
			applyPatch: async (options) => {
				applied = true;
				await writeFile(options.outputFilePath, await readFile(targetPath));
				return { sizeBytes: target.size, sha512: target.sha512 };
			},
		};
		const manifest = await assembleReleaseBundle(f.options);
		expect(applied).toBe(true);
		expect(manifest.files).toHaveLength(18);
	});
	test("patch sidecar must still reference its frozen baseline after tamper+rehash", async () => {
		const f = await fixture();
		await baseline(f);
		await assembleReleaseBundle(f.options);
		const name = `${f.name}.from-1.0.0.zstd-patch.meta.json`;
		const path = join(f.options.bundleDir, "dist", name);
		const meta = JSON.parse(await readFile(path, "utf8"));
		meta.oldFileSha512 = createHash("sha512").update("other base").digest("base64");
		await writeFile(path, JSON.stringify(meta));
		await refreshFileRecord(f, name);
		await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow("baseline identity");
	});
});

describe("immutable helper dependencies in release bundles", () => {
	test("all eight new sidecars seal and restore the same declaration without network readiness", async () => {
		const f = await fixture(true);
		const sealed = await assembleReleaseBundle(f.options);
		expect(sealed.helperDistribution).toEqual(createHelperDistributionDependencies("0.9.1"));
		expect((await verifyReleaseBundle(f.options.bundleDir)).helperDistribution).toEqual(
			sealed.helperDistribution,
		);
	});
	test("different component pins or protocols cannot be mixed across platforms", async () => {
		for (const helperDistribution of [
			createHelperDistributionDependencies("0.9.2"),
			createHelperDistributionDependencies("0.9.1", 2),
		]) {
			const f = await fixture(true);
			const path = join(f.options.platformsDir, "linux-x64", `${f.name}.metadata.json`);
			const metadata = JSON.parse(await readFile(path, "utf8"));
			await writeFile(path, JSON.stringify({ ...metadata, helperDistribution }));
			await expect(assembleReleaseBundle(f.options)).rejects.toThrow("Inconsistent");
		}
	});
	test("eight agreeing sidecars must still match target JSON rather than current control pin", async () => {
		const f = await fixture(true);
		f.options.targetHelperDistribution = createHelperDistributionDependencies("0.9.2");
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow(
			"target component configuration",
		);
		f.options.targetHelperDistribution = undefined;
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("Legacy target");
		f.options.targetHelperDistribution = createHelperDistributionDependencies("0.9.1");
		expect((await assembleReleaseBundle(f.options)).helperDistribution?.executor.version).toBe(
			"0.9.1",
		);
	});
	test("component evidence must match all sidecars and its original expected plan", async () => {
		const f = await fixture(true);
		f.plan.componentEvidence = {
			executor: {
				version: "0.9.1",
				protocolVersion: 1,
				tag: "executor-v0.9.1",
				commit: "d".repeat(40),
				manifestSha256: "e".repeat(64),
				buildInputsSha256: "f".repeat(64),
			},
		};
		await assembleReleaseBundle(f.options);
		await expect(
			verifyReleaseBundle(f.options.bundleDir, { ...f.plan, componentEvidence: undefined }),
		).rejects.toThrow("componentEvidence");
		await changeManifest(f, (manifest) => {
			if (!manifest.plan.componentEvidence) throw new Error("fixture");
			manifest.plan.componentEvidence.executor.protocolVersion = 2;
		});
		await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow("evidence/dependency");
	});
	test("legacy bundles do not invent dependencies from the current control code", async () => {
		const f = await fixture();
		expect((await assembleReleaseBundle(f.options)).helperDistribution).toBeUndefined();
		expect((await verifyReleaseBundle(f.options.bundleDir)).helperDistribution).toBeUndefined();
	});
	test("one missing platform declaration cannot silently create a legacy bundle", async () => {
		const f = await fixture(true);
		const path = join(f.options.platformsDir, "linux-x64", `${f.name}.metadata.json`);
		const metadata = JSON.parse(await readFile(path, "utf8"));
		delete metadata.helperDistribution;
		await writeFile(path, JSON.stringify(metadata));
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("Inconsistent");
	});
	test("removing the sealed dependency record is detected during restore", async () => {
		const f = await fixture(true);
		await assembleReleaseBundle(f.options);
		await changeManifest(f, (manifest) => {
			delete manifest.helperDistribution;
		});
		await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow("declaration mismatch");
	});
});

describe("re-verified release bundle provenance", () => {
	function buildSource(single = false) {
		return {
			runId: 20,
			runAttempt: 3,
			workflowCommit: "c".repeat(40),
			controlArtifact: { id: 900, digest: `sha256:${"d".repeat(64)}`, size: 1000 },
			platforms: CI_RELEASE_TARGETS.slice(0, single ? 1 : undefined).map(({ target }, index) => ({
				target,
				artifact: { id: 901 + index, digest: `sha256:${"e".repeat(64)}`, size: 1000 },
			})),
		};
	}
	test("refuses to assemble a single-platform diagnostic even when eight old result files exist", async () => {
		const f = await fixture();
		f.plan.buildSource = buildSource(true);
		await expect(assembleReleaseBundle(f.options)).rejects.toThrow("Single-platform");
		await expect(readdir(f.options.bundleDir)).rejects.toThrow();
	});
	test("seals all eight re-verified original binaries and binds the exact build origin", async () => {
		const f = await fixture();
		f.plan.buildSource = buildSource();
		const sealed = await assembleReleaseBundle(f.options);
		expect(sealed.plan.buildSource).toEqual(f.plan.buildSource);
		for (const { target, suffix } of CI_RELEASE_TARGETS) {
			const name = `narrafork-${f.plan.version}-${suffix}`;
			expect(sealed.files.find((file) => file.name === name)).toBeDefined();
			expect(await readFile(join(f.options.bundleDir, "dist", name))).toEqual(
				await readFile(join(f.options.platformsDir, target, name)),
			);
		}
		await expect(
			verifyReleaseBundle(f.options.bundleDir, {
				...f.plan,
				buildSource: { ...f.plan.buildSource, runAttempt: 2 },
			}),
		).rejects.toThrow("buildSource");
		await expect(
			verifyReleaseBundle(f.options.bundleDir, { ...f.plan, buildSource: undefined }),
		).rejects.toThrow("buildSource");
		await changeManifest(f, (manifest) => {
			manifest.plan.buildSource = buildSource(true);
		});
		await expect(verifyReleaseBundle(f.options.bundleDir)).rejects.toThrow("Single-platform");
	});
});
