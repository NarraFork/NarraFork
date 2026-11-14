import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { BinaryMetadata } from "../../scripts/lib/binary-metadata";
import {
	computeCiBinaryMetadata,
	runCiBuildCommand,
	signCiBinary,
	validateCiBuildIdentity,
	validateCiMetadata,
	verifyCiSidecar,
	writeBuildAggregates,
} from "../../scripts/lib/ci-build-strict";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";
import { MAX_RELEASE_BINARY_BYTES } from "../../shared/release-patch";
import { CURRENT_RECOVERY_MANIFEST_VERSIONS } from "../../shared/update-identity";

const dirs: string[] = [];
function temp() {
	const path = mkdtempSync(join(process.cwd(), ".narrafork/ci-build-"));
	dirs.push(path);
	return path;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const platform = {
	target: "bun-linux-x64",
	platformId: "linux-x64",
	name: "narrafork-1.2.3-linux-x64",
};
const identity = {
	...platform,
	version: "1.2.3",
	commit: "a".repeat(40),
	repository: "Fork/Custom",
};
const input = { ...identity, buildDate: "2026-10-08T00:00:00.000Z" };

async function worker(
	distDir: string,
	releaseCi = true,
	recoveryManifestVersions?: readonly number[],
): Promise<{ metadata: BinaryMetadata; logs: string[] }> {
	return new Promise((resolve, reject) => {
		const w = new Worker(join(process.cwd(), "scripts/post-process-worker.ts"), {
			workerData: {
				platform,
				distDir,
				root: process.cwd(),
				version: identity.version,
				commit: identity.commit,
				repository: identity.repository,
				helperDistribution: createHelperDistributionDependencies("0.9.1"),
				releaseCi,
				recoveryManifestVersions,
			},
		});
		const logs: string[] = [];
		let result: BinaryMetadata | undefined;
		const timer = setTimeout(() => {
			void w.terminate();
			reject(new Error("Worker fixture timeout"));
		}, 5000);
		w.on("message", (msg) => {
			if (msg.type === "log") logs.push(msg.message);
			if (msg.type === "done") result = msg.metadata;
		});
		w.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		w.on("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0 || !result) reject(new Error(`Worker failed: ${code}`));
			else resolve({ metadata: result, logs });
		});
	});
}

describe("strict CI builds fail closed without compiling or publishing", () => {
	test("requires exact pinned Bun and a complete commit", () => {
		validateCiBuildIdentity("bun@1.4.3", "1.4.3", identity.commit);
		for (const pin of [undefined, "bun@latest", "bun@^1.4.3", "bun@1.4.2"]) {
			expect(() => validateCiBuildIdentity(pin, "1.4.3", identity.commit)).toThrow("Bun");
		}
		expect(() => validateCiBuildIdentity("bun@1.4.3", "1.4.3", "a123456")).toThrow("commit");
	});
	test("macOS uses system codesign, verifies, and propagates sign/verify failures", async () => {
		const commands: string[][] = [];
		await signCiBinary("bun-darwin-arm64", "darwin", "fixture", async (cmd) => {
			commands.push(cmd);
		});
		expect(commands).toEqual([
			["codesign", "--force", "--sign", "-", "fixture"],
			["codesign", "--verify", "--strict", "--verbose=2", "fixture"],
		]);
		await expect(
			signCiBinary("bun-darwin-x64", "linux", "fixture", async () => {}),
		).rejects.toThrow("native macOS");
		for (const failAt of [1, 2]) {
			let count = 0;
			await expect(
				signCiBinary("bun-darwin-arm64", "darwin", "fixture", async () => {
					if (++count === failAt) throw new Error("fixture signing failed");
				}),
			).rejects.toThrow("signing failed");
			expect(count).toBe(failAt);
		}
	});
	test("worker skips implicit old-dist baselines and writes full-provenance sidecar", async () => {
		const dist = temp();
		writeFileSync(join(dist, platform.name), "fixture executable");
		// An old matching directory would make legacy patch reading fail. CI must not scan it.
		mkdirSync(join(dist, "narrafork-1.2.2-linux-x64"));
		const result = await worker(dist);
		expect(result.metadata.commit).toBe(identity.commit);
		expect(
			result.logs.some(
				(line) => line.includes("Generating zstd") || line.includes("patch generation failed"),
			),
		).toBe(false);
		expect(existsSync(join(dist, `${platform.name}.zstd-patch`))).toBe(false);
		await expect(verifyCiSidecar(join(dist, platform.name), identity)).resolves.toEqual(
			result.metadata,
		);
	});
	test("main build explicitly declares capabilities through local and strict post-processing", async () => {
		const source = readFileSync(join(process.cwd(), "scripts/build-cross-platform.ts"), "utf8");
		expect(source).toContain("recoveryManifestVersions: CURRENT_RECOVERY_MANIFEST_VERSIONS");
		for (const releaseCi of [false, true]) {
			const dist = temp();
			const binary = join(dist, platform.name);
			writeFileSync(binary, "fixture executable");
			const { metadata } = await worker(dist, releaseCi, CURRENT_RECOVERY_MANIFEST_VERSIONS);
			expect(metadata.recoveryManifestVersions).toEqual([1, 2, 3]);
			const expected = {
				...identity,
				recoveryManifestVersions: CURRENT_RECOVERY_MANIFEST_VERSIONS,
			};
			await expect(verifyCiSidecar(binary, expected)).resolves.toEqual(metadata);
			for (const recoveryManifestVersions of [undefined, [1, 2], [3, 3], [], [256]]) {
				expect(() =>
					validateCiMetadata({ ...metadata, recoveryManifestVersions }, expected),
				).toThrow();
			}
		}
	});
	test("strict generic metadata does not invent main-program capabilities for legacy or component callers", async () => {
		const binary = join(temp(), platform.name);
		writeFileSync(binary, "fixture executable");
		const metadata = await computeCiBinaryMetadata(binary, input);
		expect(Object.hasOwn(metadata, "recoveryManifestVersions")).toBe(false);
		validateCiMetadata(metadata, identity);
		expect(() =>
			validateCiMetadata({ ...metadata, recoveryManifestVersions: [3, 3] }, identity),
		).toThrow("recoveryManifestVersions");
		await expect(
			computeCiBinaryMetadata(binary, { ...input, recoveryManifestVersions: [0, 3] }),
		).rejects.toThrow("recoveryManifestVersions");
	});
	test("APP and executor versions differ while frozen component pin remains strict", async () => {
		const path = join(temp(), platform.name);
		writeFileSync(path, "fixture executable");
		const dependencies = createHelperDistributionDependencies("0.9.1");
		const metadata = await computeCiBinaryMetadata(path, {
			...input,
			helperDistribution: dependencies,
		});
		const expected = { ...identity, helperDistribution: dependencies };
		validateCiMetadata(metadata, expected);
		expect(metadata.version).toBe("1.2.3");
		expect(metadata.helperDistribution).toEqual(dependencies);
		for (const helperDistribution of [
			undefined,
			createHelperDistributionDependencies("0.9.2"),
			createHelperDistributionDependencies("0.9.1", 2),
			{ ...dependencies, executor: { ...dependencies.executor, tag: "executor-v0.9.2" } },
		]) {
			expect(() => validateCiMetadata({ ...metadata, helperDistribution }, expected)).toThrow();
		}
	});
	test("metadata write failure fails strict worker but local mode remains best effort", async () => {
		const dist = temp();
		writeFileSync(join(dist, platform.name), "fixture executable");
		mkdirSync(join(dist, `${platform.name}.metadata.json`));
		await expect(worker(dist)).rejects.toThrow();
		const local = await worker(dist, false);
		expect(local.logs.some((line) => line.includes("Metadata generation failed"))).toBe(true);
	});
	test("metadata rejects missing identity and binary/sidecar tampering", async () => {
		const path = join(temp(), platform.name);
		writeFileSync(path, "fixture executable");
		const metadata = await computeCiBinaryMetadata(path, input);
		validateCiMetadata(metadata, identity);
		for (const changes of [
			{ commit: "a123456" },
			{ repository: undefined },
			{ repository: "NarraFork/NarraFork" },
			{ target: "bun-windows-arm64" },
			{ platform: "win-x64" },
			{ version: "1.2.2" },
			{ size: 0 },
			{ sha256: "fake" },
			{ sha512: "fake" },
		]) {
			expect(() => validateCiMetadata({ ...metadata, ...changes }, identity)).toThrow();
		}
		expect(() => validateCiMetadata(undefined, identity)).toThrow();
		writeFileSync(`${path}.metadata.json`, JSON.stringify(metadata));
		writeFileSync(path, "altered bytes");
		await expect(verifyCiSidecar(path, identity)).rejects.toThrow("hash/size");
		rmSync(path);
		symlinkSync(`${path}.metadata.json`, path);
		await expect(computeCiBinaryMetadata(path, input)).rejects.toThrow("Invalid release");
	});
	test("metadata descriptors allow above 1GiB through 4GiB, but not one byte more", async () => {
		const path = join(temp(), platform.name);
		writeFileSync(path, "fixture executable");
		const metadata = await computeCiBinaryMetadata(path, input);
		expect(MAX_RELEASE_BINARY_BYTES).toBe(4 * 1024 ** 3);
		for (const size of [1024 ** 3 + 1, MAX_RELEASE_BINARY_BYTES])
			expect(() => validateCiMetadata({ ...metadata, size }, identity)).not.toThrow();
		expect(() =>
			validateCiMetadata({ ...metadata, size: MAX_RELEASE_BINARY_BYTES + 1 }, identity),
		).toThrow("metadata");
		truncateSync(path, MAX_RELEASE_BINARY_BYTES + 1);
		await expect(computeCiBinaryMetadata(path, input)).rejects.toThrow("Invalid release binary");
	});
	test("aggregation failure propagates, and valid checksums reflect final bytes", async () => {
		const dir = temp();
		const binary = join(dir, platform.name);
		writeFileSync(binary, "final signed bytes");
		const metadata = await computeCiBinaryMetadata(binary, input);
		const paths = writeBuildAggregates(dir, identity.version, [metadata]);
		expect(readFileSync(join(dir, paths[0]), "utf8")).toContain(metadata.sha256);
		expect(() => writeBuildAggregates(dir, identity.version, [])).toThrow("missing");
		rmSync(join(dir, paths[1]));
		mkdirSync(join(dir, paths[1]));
		expect(() => writeBuildAggregates(dir, identity.version, [metadata])).toThrow();
	});
	test("bounded command runner propagates exit failures and hard timeout", async () => {
		await runCiBuildCommand([process.execPath, "-e", "process.exit(0)"]);
		await expect(
			runCiBuildCommand([
				process.execPath,
				"-e",
				"console.error('fixture failure');process.exit(7)",
			]),
		).rejects.toThrow("fixture failure");
		await expect(
			runCiBuildCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], 30),
		).rejects.toThrow("timed out");
		await expect(
			runCiBuildCommand([
				process.execPath,
				"-e",
				"for(let i=0;i<66;i++) await Bun.write(Bun.stdout, Buffer.alloc(1024*1024, 120));",
			]),
		).rejects.toThrow("64 MiB");
	});
});
