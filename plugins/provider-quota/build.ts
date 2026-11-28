import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import manifest from "./manifest.json";

const SOURCE_ROOT = import.meta.dir;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
// A fixed UTC timestamp and entry mode make package contents and ZIP metadata reproducible.
// The ZIP epoch is also a valid SPDX creation time; this is not the machine's build clock.
const BUILD_TIMESTAMP = "1980-01-01T00:00:00.000Z";
export interface BuildProviderQuotaOptions {
	outDir?: string;
	/** Derive sidecars from the completed, private archive before publishing any public path. */
	preparePublication?: (
		staged: BuildProviderQuotaResult,
	) => Promise<readonly { path: string; content: string }[]>;
}
export interface BuildProviderQuotaResult {
	archivePath: string;
	packageRoot: string;
}
async function cappedRead(path: string, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > maxBytes)
			throw new Error(`Build input exceeds byte budget: ${relative(SOURCE_ROOT, path)}`);
		const bytes = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead === 0) throw new Error("Build input changed while reading");
			offset += bytesRead;
		}
		const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, offset);
		if (bytesRead !== 0) throw new Error("Build input changed while reading");
		return bytes;
	} finally {
		await handle.close();
	}
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Roll back handled failures; this is not a multi-file transaction for non-cooperating readers. */
async function publishBuild(
	staging: string,
	outDir: string,
	sidecars: readonly { path: string; content: string }[],
): Promise<void> {
	if (sidecars.length > 4) throw new Error("Build sidecar count exceeds budget");
	const entries = [
		{ staged: join(staging, "package"), target: join(outDir, "package"), directory: true },
		...sidecars.map((sidecar, index) => ({
			staged: join(staging, `sidecar-${index}`),
			target: resolve(sidecar.path),
			directory: false,
		})),
		{
			staged: join(staging, "provider-quota.nfplugin"),
			target: join(outDir, "provider-quota.nfplugin"),
			directory: false,
		},
	].map((entry, index) => ({
		...entry,
		backup: join(staging, `previous-${index}`),
		existed: false,
		backedUp: false,
		published: false,
	}));
	if (new Set(entries.map((entry) => entry.target)).size !== entries.length)
		throw new Error("Duplicate build publication path");
	for (const [index, sidecar] of sidecars.entries()) {
		if (Buffer.byteLength(sidecar.content) > 64 * 1024)
			throw new Error("Build sidecar exceeds byte budget");
		const writer = await open(join(staging, `sidecar-${index}`), "wx");
		try {
			await writer.writeFile(sidecar.content);
			await writer.sync();
		} finally {
			await writer.close();
		}
	}
	const archive = await open(join(staging, "provider-quota.nfplugin"), "r+");
	try {
		await archive.sync();
	} finally {
		await archive.close();
	}
	// Complete every fallible preparation before changing public files.
	for (const entry of entries) {
		await mkdir(dirname(entry.target), { recursive: true });
		try {
			const info = await lstat(entry.target);
			if (entry.directory ? !info.isDirectory() || info.isSymbolicLink() : !info.isFile())
				throw new Error(`Build publication target has an unexpected type: ${entry.target}`);
			entry.existed = true;
			if (!entry.directory) {
				await writeFile(entry.backup, await cappedRead(entry.target, MAX_ARCHIVE_BYTES), {
					flag: "wx",
				});
				entry.backedUp = true;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	try {
		for (const entry of entries) {
			if (entry.directory && entry.existed) {
				await rename(entry.target, entry.backup);
				entry.backedUp = true;
			}
			await rename(entry.staged, entry.target);
			entry.published = true;
		}
	} catch (error) {
		const failures: unknown[] = [error];
		for (const entry of [...entries].reverse()) {
			try {
				if (entry.directory && entry.published)
					await rm(entry.target, { recursive: true, force: true });
				if (entry.backedUp && (entry.published || entry.directory))
					await rename(entry.backup, entry.target);
				else if (!entry.existed && entry.published) await rm(entry.target, { force: true });
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
		}
		if (failures.length > 1)
			throw new AggregateError(
				failures,
				`Build rollback failed; preserve staging and lock at ${staging}`,
			);
		throw error;
	}
}

/** Builds only this independently installable plugin; no host settings, DB or runtime imports. */
export async function buildProviderQuotaPlugin(
	options: BuildProviderQuotaOptions = {},
): Promise<BuildProviderQuotaResult> {
	const outDir = resolve(options.outDir ?? join(SOURCE_ROOT, "dist"));
	await mkdir(outDir, { recursive: true });
	const lockPath = join(outDir, ".provider-quota-build.lock");
	const lock = await open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "EEXIST")
			throw new Error(
				`Provider quota build lock already exists: ${lockPath}; verify its owner before manual recovery`,
			);
		throw error;
	});
	let staging: string | undefined;
	let preserveRecovery = false;
	try {
		await lock.writeFile(`${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`);
		staging = await mkdtemp(join(outDir, ".provider-quota-staging-"));
		const staged = await buildStagedPlugin(staging);
		// Standalone builds must keep an existing host-readable sidecar in step with the ZIP.
		// Bundled builds derive their cache and generated module from the same private bytes.
		const sidecars = options.preparePublication
			? await options.preparePublication(staged)
			: await standaloneMetadata(staged, outDir);
		await publishBuild(staging, outDir, sidecars);
		return {
			archivePath: join(outDir, "provider-quota.nfplugin"),
			packageRoot: join(outDir, "package"),
		};
	} catch (error) {
		preserveRecovery = error instanceof AggregateError;
		throw error;
	} finally {
		await lock.close();
		if (!preserveRecovery) {
			if (staging) await rm(staging, { recursive: true, force: true });
			await rm(lockPath);
		}
	}
}

/** Match the host store's sorted, depth-first content identity without importing host code. */
async function packageContentHash(root: string): Promise<string> {
	const hash = createHash("sha256");
	let entries = 0;
	let bytes = 0;
	const deadline = Date.now() + 10000;
	const walk = async (directory: string): Promise<void> => {
		if (Date.now() > deadline) throw new Error("Package identity deadline exceeded");
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe build directory");
		const children = await readdir(directory, { withFileTypes: true });
		entries += children.length;
		if (entries > 128) throw new Error("Package identity entry budget exceeded");
		children.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			const path = join(directory, child.name);
			if (child.isDirectory()) await walk(path);
			else {
				const stat = await lstat(path);
				if (!child.isFile() || !stat.isFile() || stat.isSymbolicLink())
					throw new Error("Unsafe build file");
				const data = await cappedRead(path);
				bytes += data.byteLength;
				if (bytes > MAX_PACKAGE_BYTES || Date.now() > deadline)
					throw new Error("Package identity budget exceeded");
				hash.update(relative(root, path).replaceAll("\\", "/"));
				hash.update("\0");
				hash.update(data);
			}
		}
	};
	await walk(root);
	return hash.digest("hex");
}

async function standaloneMetadata(
	staged: BuildProviderQuotaResult,
	outDir: string,
): Promise<readonly { path: string; content: string }[]> {
	const bytes = await cappedRead(staged.archivePath, MAX_ARCHIVE_BYTES);
	const packageHash = await packageContentHash(staged.packageRoot);
	return [
		{
			path: join(outDir, "provider-quota.asset.json"),
			content: `${JSON.stringify(
				{
					schemaVersion: 1,
					pluginId: manifest.pluginId,
					version: manifest.version,
					size: bytes.byteLength,
					sha256: sha256(bytes),
					packageHash,
				},
				null,
				2,
			)}\n`,
		},
	];
}

async function buildStagedPlugin(outDir: string): Promise<BuildProviderQuotaResult> {
	const sourceBytes = await cappedRead(join(SOURCE_ROOT, "plugin-source.json"), 16 * 1024);
	const metadata = JSON.parse(sourceBytes.toString("utf8"));
	if (
		metadata?.schemaVersion !== 1 ||
		metadata.pluginId !== manifest.pluginId ||
		metadata.source?.type !== "local" ||
		metadata.source.builtinId !== manifest.pluginId ||
		Object.keys(metadata).sort().join(",") !== "pluginId,schemaVersion,source" ||
		Object.keys(metadata.source).sort().join(",") !== "builtinId,type"
	)
		throw new Error(
			"Provider Quota source metadata must be its local builtin identity without a homepage",
		);
	const packageRoot = join(outDir, "package");
	const serverRoot = join(packageRoot, "server");
	await mkdir(serverRoot, { recursive: true });
	await mkdir(join(packageRoot, "licenses"), { recursive: true });
	await mkdir(join(packageRoot, "sources", "src"), { recursive: true });
	const built = await Bun.build({
		entrypoints: [join(SOURCE_ROOT, "src", "index.ts")],
		// Omitting outdir keeps Bun's output in memory; Bun.build has no write:false option.
		// Validate it before our exclusive write to the private staging directory.
		target: "bun",
		format: "esm",
		minify: true,
		sourcemap: "none",
		naming: "index.js",
	});
	if (!built.success)
		throw new Error(
			`Provider quota build failed: ${built.logs.map((log) => log.message).join("; ")}`,
		);
	if (built.outputs.length !== 1 || !built.outputs[0] || built.outputs[0].size > MAX_FILE_BYTES)
		throw new Error("Build server output exceeds file count/byte budget");
	await writeFile(
		join(serverRoot, "index.js"),
		new Uint8Array(await built.outputs[0].arrayBuffer()),
		{ flag: "wx" },
	);
	const files = [
		"server/index.js",
		"manifest.json",
		"plugin-source.json",
		"LICENSE",
		"licenses/zod.LICENSE",
	];
	await writeFile(join(packageRoot, "plugin-source.json"), sourceBytes);
	await writeFile(
		join(packageRoot, "manifest.json"),
		await cappedRead(join(SOURCE_ROOT, "manifest.json")),
	);
	await writeFile(join(packageRoot, "LICENSE"), await cappedRead(join(SOURCE_ROOT, "LICENSE")));
	const zodJsonPath = fileURLToPath(import.meta.resolve("zod/package.json"));
	const zodMetadataBytes = await cappedRead(zodJsonPath);
	const zod = JSON.parse(zodMetadataBytes.toString("utf8")) as {
		name: string;
		version: string;
		license: string;
	};
	if (zod.name !== "zod" || zod.version !== "4.3.6" || zod.license !== "MIT")
		throw new Error("Bundled zod metadata differs from the independent package dependency");
	await writeFile(
		join(packageRoot, "licenses", "zod.LICENSE"),
		await cappedRead(join(dirname(zodJsonPath), "LICENSE")),
	);
	// MPL source availability accompanies the package, rather than pointing at host directories.
	for (const entry of await readdir(join(SOURCE_ROOT, "src"), { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (files.length >= 64) throw new Error("Build source file count exceeds budget");
		await writeFile(
			join(packageRoot, "sources", "src", entry.name),
			await cappedRead(join(SOURCE_ROOT, "src", entry.name)),
		);
		files.push(`sources/src/${entry.name}`);
	}
	for (const name of [
		"package.json",
		"tsconfig.json",
		"manifest.json",
		"plugin-source.json",
		"build.ts",
		"LICENSE",
	]) {
		if (name === "plugin-source.json") {
			await writeFile(join(packageRoot, "sources", name), sourceBytes);
		} else {
			await writeFile(
				join(packageRoot, "sources", name),
				await cappedRead(join(SOURCE_ROOT, name)),
			);
		}
		files.push(`sources/${name}`);
	}
	files.sort();
	let totalBytes = 0;
	const fileRecords = [];
	const fileSha1s = [];
	for (const [index, file] of files.entries()) {
		const bytes = await cappedRead(join(packageRoot, file));
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("Build package exceeds byte budget");
		fileSha1s.push(createHash("sha1").update(bytes).digest("hex"));
		fileRecords.push({
			SPDXID: `SPDXRef-File-${index}`,
			fileName: `./${file}`,
			checksums: [{ algorithm: "SHA256", checksumValue: sha256(bytes) }],
			licenseConcluded:
				file === "server/index.js"
					? "MPL-2.0 AND MIT"
					: file === "licenses/zod.LICENSE"
						? "MIT"
						: "MPL-2.0",
			copyrightText: "NOASSERTION",
		});
	}
	const packageVerificationCode = createHash("sha1")
		.update(fileSha1s.sort().join(""))
		.digest("hex");
	const sbom = {
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name: manifest.pluginId,
		documentNamespace: `https://narrafork.local/sbom/${manifest.pluginId}/${manifest.version}/${packageVerificationCode}`,
		creationInfo: {
			created: BUILD_TIMESTAMP,
			creators: ["Organization: NarraFork", `Tool: Bun-${Bun.version}`],
		},
		packages: [
			{
				SPDXID: "SPDXRef-provider-quota",
				name: manifest.pluginId,
				versionInfo: manifest.version,
				downloadLocation: "NOASSERTION",
				licenseDeclared: manifest.license,
				licenseConcluded: manifest.license,
				filesAnalyzed: true,
				packageVerificationCode: {
					packageVerificationCodeValue: packageVerificationCode,
					packageVerificationCodeExcludedFiles: ["sbom.spdx.json"],
				},
				supplier: "Organization: NarraFork",
			},
			{
				SPDXID: "SPDXRef-zod",
				name: zod.name,
				versionInfo: zod.version,
				downloadLocation: `https://registry.npmjs.org/zod/-/zod-${zod.version}.tgz`,
				filesAnalyzed: false,
				licenseDeclared: zod.license,
				licenseConcluded: zod.license,
				sourceInfo: `Bundled from installed zod package.json SHA256 ${sha256(zodMetadataBytes)}; see licenses/zod.LICENSE and server/index.js`,
				externalRefs: [
					{
						referenceCategory: "PACKAGE-MANAGER",
						referenceType: "purl",
						referenceLocator: `pkg:npm/zod@${zod.version}`,
					},
				],
			},
		],
		files: fileRecords,
		relationships: [
			{
				spdxElementId: "SPDXRef-DOCUMENT",
				relationshipType: "DESCRIBES",
				relatedSpdxElement: "SPDXRef-provider-quota",
			},
			{
				spdxElementId: "SPDXRef-provider-quota",
				relationshipType: "DEPENDS_ON",
				relatedSpdxElement: "SPDXRef-zod",
			},
			...fileRecords.map((file) => ({
				spdxElementId: "SPDXRef-provider-quota",
				relationshipType: "CONTAINS",
				relatedSpdxElement: file.SPDXID,
			})),
		],
	};
	await writeFile(join(packageRoot, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
	files.push("sbom.spdx.json");
	files.sort();
	const archivePath = join(outDir, "provider-quota.nfplugin");
	const archive = archiver("zip", { zlib: { level: 9 }, forceLocalTime: false });
	let archiveBytes = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			archiveBytes += chunk.byteLength;
			callback(
				archiveBytes > MAX_ARCHIVE_BYTES ? new Error("Build archive exceeds byte budget") : null,
				chunk,
			);
		},
	});
	const sink = createWriteStream(archivePath, { flags: "wx" });
	const completed = pipeline(archive, limiter, sink);
	// A stream may fail while bounded inputs are still being appended; observe it immediately.
	void completed.catch(() => undefined);
	const timer = setTimeout(() => {
		archive.abort();
		sink.destroy(new Error("Build archive deadline exceeded"));
	}, 30_000);
	try {
		for (const file of files) {
			// Append bounded bytes, not filesystem stats (mtime/mode vary by machine and checkout).
			archive.append(await cappedRead(join(packageRoot, file)), {
				name: file,
				date: new Date(BUILD_TIMESTAMP),
				mode: 0o644,
			});
		}
		await Promise.all([archive.finalize(), completed]);
	} catch (error) {
		archive.abort();
		sink.destroy(error instanceof Error ? error : new Error(String(error)));
		await completed.catch(() => undefined);
		throw error;
	} finally {
		clearTimeout(timer);
	}
	return { archivePath, packageRoot };
}
if (import.meta.main) console.log(JSON.stringify(await buildProviderQuotaPlugin()));
