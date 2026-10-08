import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
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
const identity = { ...platform, version: "1.2.3", commit: "a".repeat(40) };
const input = { ...identity, buildDate: "2026-10-08T00:00:00.000Z" };

async function worker(
	distDir: string,
	releaseCi = true,
): Promise<{ metadata: BinaryMetadata; logs: string[] }> {
	return new Promise((resolve, reject) => {
		const w = new Worker(join(process.cwd(), "scripts/post-process-worker.ts"), {
			workerData: {
				platform,
				distDir,
				root: process.cwd(),
				version: identity.version,
				commit: identity.commit,
				releaseCi,
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
		validateCiBuildIdentity("bun@1.4.2", "1.4.2", identity.commit);
		for (const pin of [undefined, "bun@latest", "bun@^1.4.2", "bun@1.4.1"]) {
			expect(() => validateCiBuildIdentity(pin, "1.4.2", identity.commit)).toThrow("Bun");
		}
		expect(() => validateCiBuildIdentity("bun@1.4.2", "1.4.2", "a123456")).toThrow("commit");
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
