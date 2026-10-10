import { afterEach, describe, expect, test } from "bun:test";
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

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
				? { helperDistribution: createHelperDistributionDependencies(plan.version) }
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
	const options: AssembleReleaseBundleOptions = { plan, platformsDir, smokeDir, bundleDir };
	return { root, options, plan, name: `narrafork-${plan.version}-linux-x64` };
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

describe("immutable eight-platform CI bundle", () => {
	test("assembles first full-only release and verifies without rewriting bytes", async () => {
		const f = await fixture();
		await writeFile(
			join(f.options.platformsDir, "linux-x64", "diagnostic.log"),
			"ignored build diagnostic",
		);
		const manifest = await assembleReleaseBundle(f.options);
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
		const manifest = await assembleReleaseBundle(f.options);
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
	test("network and zstd errors abort assembly and clean owned temporary files", async () => {
		for (const stage of ["network", "zstd"] as const) {
			const f = await fixture();
			await baseline(f);
			if (stage === "network")
				f.options.dependencies = {
					downloadAsset: async () => {
						throw new Error("network down");
					},
				};
			else
				f.options.dependencies = {
					...f.options.dependencies,
					generatePatch: async () => {
						throw new Error("zstd failed");
					},
				};
			await expect(assembleReleaseBundle(f.options)).rejects.toThrow(
				stage === "network" ? "network down" : "zstd failed",
			);
			expect((await readdir(f.root)).some((name) => name.startsWith(".ci-release-bundle-"))).toBe(
				false,
			);
		}
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
		expect(sealed.helperDistribution).toEqual(createHelperDistributionDependencies(f.plan.version));
		expect((await verifyReleaseBundle(f.options.bundleDir)).helperDistribution).toEqual(
			sealed.helperDistribution,
		);
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
