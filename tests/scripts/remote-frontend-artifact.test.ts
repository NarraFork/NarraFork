import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { runPublicationProcess } from "../../scripts/lib/ci-publication-runtime";
import {
	buildRemoteFrontendArtifact,
	extractRemoteFrontendArtifact,
	type RemoteFrontendArtifactTarget,
	verifyRemoteFrontendArtifact,
} from "../../scripts/lib/remote-frontend-artifact";
import { REMOTE_FRONTEND_CAPABILITY } from "../../shared/remote-access/application";
import { remoteFrontendArtifactNames } from "../../shared/remote-access/frontend-manifest";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-remote-artifact-"));
	directories.push(root);
	const input = join(root, "input"),
		output = join(root, "output");
	await mkdir(join(input, ".vite"), { recursive: true });
	await mkdir(join(input, "assets"));
	await writeFile(join(input, "bootstrap.js"), "export const bootstrap = true;");
	await writeFile(join(input, "mount.js"), "export function mount() {}");
	await writeFile(join(input, "assets", "main.css"), "body { color: indigo }");
	await writeFile(
		join(input, "remote-module-graph.json"),
		JSON.stringify({ privateDevelopmentPath: "/home/private/source" }),
	);
	await writeFile(
		join(input, ".vite", "manifest.json"),
		JSON.stringify({
			"remote/bootstrap.ts": { name: "bootstrap", file: "bootstrap.js", isEntry: true },
			"remote/mount.tsx": { name: "mount", file: "mount.js", isEntry: true, imports: ["shared"] },
			shared: { file: "mount.js", css: ["assets/main.css"] },
		}),
	);
	const target: RemoteFrontendArtifactTarget = {
		repository: "owner/repo",
		version: "1.2.3",
		commit: "a".repeat(40),
		capability: REMOTE_FRONTEND_CAPABILITY,
	};
	return { root, input, output, target };
}
function checksum(header: Buffer) {
	header.fill(32, 148, 156);
	const value = header.reduce((sum, n) => sum + n, 0);
	header.write(`${value.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}
async function corruptArchive(output: string, version: string, mutate: (tar: Buffer) => Buffer) {
	const names = remoteFrontendArtifactNames(version),
		manifestPath = join(output, names.manifest);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const tar = gunzipSync(await readFile(join(output, names.archive))),
		archive = gzipSync(mutate(tar));
	manifest.archive.size = archive.length;
	manifest.archive.sha256 = createHash("sha256").update(archive).digest("hex");
	await writeFile(join(output, names.archive), archive);
	await writeFile(manifestPath, JSON.stringify(manifest));
}

describe("isolated remote frontend artifact", () => {
	test("build/verify/extract are deterministic, exact and omit development metadata", async () => {
		const f = await fixture(),
			manifest = await buildRemoteFrontendArtifact({
				root: f.root,
				inputDir: f.input,
				outputDir: f.output,
				target: f.target,
			});
		expect(manifest.css).toEqual(["assets/main.css"]);
		expect(manifest.files.map((file) => file.path)).toEqual([
			"assets/main.css",
			"bootstrap.js",
			"mount.js",
		]);
		expect(await verifyRemoteFrontendArtifact(f.output, f.target)).toEqual(manifest);
		expect(
			await buildRemoteFrontendArtifact({
				root: f.root,
				inputDir: f.input,
				outputDir: f.output,
				target: f.target,
			}),
		).toEqual(manifest);
		const staging = join(f.root, "stage");
		await mkdir(staging);
		const result = await extractRemoteFrontendArtifact(f.output, f.target, staging);
		expect(result.manifest).toEqual(manifest);
		expect(await readFile(join(staging, "mount.js"), "utf8")).toBe("export function mount() {}");
		expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
	}, 15000);
	test("rejects wrong target, raw archive corruption and buildId mismatch", async () => {
		const f = await fixture();
		await buildRemoteFrontendArtifact({
			root: f.root,
			inputDir: f.input,
			outputDir: f.output,
			target: f.target,
		});
		await expect(
			verifyRemoteFrontendArtifact(f.output, { ...f.target, commit: "b".repeat(40) }),
		).rejects.toThrow("TARGET_MISMATCH");
		const names = remoteFrontendArtifactNames(f.target.version),
			path = join(f.output, names.manifest),
			manifest = JSON.parse(await readFile(path, "utf8"));
		const archivePath = join(f.output, names.archive),
			archive = await readFile(archivePath);
		archive[4] ^= 1;
		await writeFile(archivePath, archive);
		await expect(verifyRemoteFrontendArtifact(f.output, f.target)).rejects.toThrow(
			"ARCHIVE_HASH_MISMATCH",
		);
		archive[4] ^= 1;
		await writeFile(archivePath, archive);
		manifest.buildId = "0".repeat(64);
		await writeFile(path, JSON.stringify(manifest));
		await expect(verifyRemoteFrontendArtifact(f.output, f.target)).rejects.toThrow(
			"BUILD_ID_MISMATCH",
		);
	}, 15000);
	test.each([
		"traversal",
		"symlink",
		"hardlink",
		"duplicate",
		"undeclared",
		"size",
		"checksum",
		"filehash",
		"trailing",
	])("rejects hostile tar %s even with matching outer hash", async (kind) => {
		const f = await fixture();
		await buildRemoteFrontendArtifact({
			root: f.root,
			inputDir: f.input,
			outputDir: f.output,
			target: f.target,
		});
		await corruptArchive(f.output, f.target.version, (tar) => {
			const header = tar.subarray(0, 512);
			if (kind === "traversal") {
				header.fill(0, 0, 100);
				header.write("../escape", 0);
			}
			if (kind === "symlink" || kind === "hardlink") {
				header[156] = kind === "symlink" ? 50 : 49;
				header.write("target", 157);
			}
			if (kind === "undeclared") {
				header.fill(0, 0, 100);
				header.write("extra.css", 0);
			}
			if (kind === "size") header.write("77777777777\0", 124, "ascii");
			if (kind === "checksum") {
				header[148] ^= 1;
				return tar;
			}
			checksum(header);
			if (kind === "filehash") tar[512] ^= 1;
			if (kind === "duplicate") return Buffer.concat([tar.subarray(0, 1024), tar]);
			if (kind === "trailing") return Buffer.concat([tar, Buffer.from("hidden")]);
			return tar;
		});
		await expect(verifyRemoteFrontendArtifact(f.output, f.target)).rejects.toThrow(
			"REMOTE_FRONTEND_",
		);
	}, 15000);
	test("sealed control bundle verifies without adjacent worker source or installed dependencies", async () => {
		const f = await fixture(),
			manifest = await buildRemoteFrontendArtifact({
				root: f.root,
				inputDir: f.input,
				outputDir: f.output,
				target: f.target,
			});
		const entry = join(f.root, "control-entry.ts");
		await writeFile(
			entry,
			`import {verifyRemoteFrontendArtifact} from ${JSON.stringify(resolve(import.meta.dirname, "../../scripts/lib/remote-frontend-artifact.ts"))}; const [directory,target]=process.argv.slice(2);console.log((await verifyRemoteFrontendArtifact(directory,JSON.parse(target))).buildId);`,
		);
		const result = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			format: "esm",
			minify: true,
		});
		expect(result.success).toBe(true);
		expect(result.outputs).toHaveLength(1);
		const bundle = join(f.root, "control.js");
		await Bun.write(bundle, result.outputs[0]);
		const output = await runPublicationProcess(
			process.execPath,
			[bundle, f.output, JSON.stringify(f.target)],
			{ timeoutMs: 15000, maximumOutputBytes: 8192 },
		);
		expect(output.trim()).toBe(manifest.buildId);
	}, 20000);
	test("manifest, file, expanded, archive and file-count budgets reject before large allocations", async () => {
		const f = await fixture();
		await buildRemoteFrontendArtifact({
			root: f.root,
			inputDir: f.input,
			outputDir: f.output,
			target: f.target,
		});
		const names = remoteFrontendArtifactNames(f.target.version),
			manifestPath = join(f.output, names.manifest),
			original = JSON.parse(await readFile(manifestPath, "utf8"));
		await writeFile(manifestPath, " ".repeat(1024 * 1024 + 1));
		await expect(verifyRemoteFrontendArtifact(f.output, f.target)).rejects.toThrow();
		for (const mutate of [
			(value: typeof original) => {
				value.files[0].size = 64 * 1024 * 1024 + 1;
			},
			(value: typeof original) => {
				value.archive.size = 128 * 1024 * 1024 + 1;
			},
			(value: typeof original) => {
				value.files = [
					...value.files,
					...Array.from({ length: 9 }, (_, i) => ({
						path: `extra${i}.bin`,
						size: 64 * 1024 * 1024,
						sha256: "a".repeat(64),
					})),
				];
			},
			(value: typeof original) => {
				value.files = Array.from({ length: 4097 }, (_, i) => ({
					path: `extra${i}.bin`,
					size: 0,
					sha256: "a".repeat(64),
				}));
			},
		]) {
			const value = structuredClone(original);
			mutate(value);
			await writeFile(manifestPath, JSON.stringify(value));
			await expect(verifyRemoteFrontendArtifact(f.output, f.target)).rejects.toThrow();
		}
		const sparse = await open(join(f.input, "oversized.bin"), "wx");
		await sparse.truncate(64 * 1024 * 1024 + 1);
		await sparse.close();
		await expect(
			buildRemoteFrontendArtifact({
				root: f.root,
				inputDir: f.input,
				outputDir: join(f.root, "rejected"),
				target: f.target,
			}),
		).rejects.toThrow("FILE_OR_EXPANDED_LIMIT");
		expect(await readdir(join(f.root, "rejected"))).toHaveLength(0);
	}, 15000);
	test("an in-flight cancellation removes owned staging instead of publishing a partial pair", async () => {
		const f = await fixture(),
			stop = new AbortController();
		const pending = buildRemoteFrontendArtifact({
			root: f.root,
			inputDir: f.input,
			outputDir: f.output,
			target: f.target,
			signal: stop.signal,
		});
		stop.abort(new Error("cancelled-in-flight"));
		await expect(pending).rejects.toThrow("cancelled-in-flight");
		expect(await readdir(f.output)).toHaveLength(0);
	});
	test("rejects symlink inputs, case collisions and cancellation without publishing", async () => {
		const f = await fixture();
		await symlink(join(f.input, "mount.js"), join(f.input, "linked.js"));
		await expect(
			buildRemoteFrontendArtifact({
				root: f.root,
				inputDir: f.input,
				outputDir: f.output,
				target: f.target,
			}),
		).rejects.toThrow("FILE_TYPE");
		await rm(join(f.input, "linked.js"));
		await writeFile(join(f.input, "MOUNT.js"), "conflict");
		await expect(
			buildRemoteFrontendArtifact({
				root: f.root,
				inputDir: f.input,
				outputDir: f.output,
				target: f.target,
			}),
		).rejects.toThrow("CASE_COLLISION");
		await expect(
			buildRemoteFrontendArtifact({
				root: f.root,
				inputDir: f.input,
				outputDir: f.output,
				target: f.target,
				signal: AbortSignal.abort(new Error("cancelled")),
			}),
		).rejects.toThrow("cancelled");
	}, 15000);
});
