import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dir, "..");
const PROVIDER_QUOTA_ID = "io.narrafork.provider-quota";
const PROVIDER_QUOTA_VERSION = "1.0.3";
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface BundledPluginBuildAsset {
	pluginId: string;
	version: string;
	/** Independent, content-addressed build input; never the mutable public archive. */
	archivePath: string;
	/** Metadata frozen next to the content-addressed archive. */
	metadataPath: string;
	size: number;
	sha256: string;
}

export interface BuildBundledPluginsOptions {
	/** Build the target checkout, never the compiler/control checkout's plugin. */
	root?: string;
	outDir?: string;
	generatedDir?: string;
	/** Immutable runtime builders provide this module in memory and must not churn generated files. */
	publishGenerated?: boolean;
}

export interface BuildBundledPluginsResult {
	generatedModulePath: string;
	generatedModuleSource: string;
	assets: readonly BundledPluginBuildAsset[];
}

async function readManifest(path: string): Promise<{ pluginId: string; version: string }> {
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size <= 0 || info.size > MAX_MANIFEST_BYTES) {
			throw new Error("Bundled plugin manifest exceeds the 64 KiB byte budget");
		}
		const bytes = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) throw new Error("Bundled plugin manifest changed while reading");
			offset += bytesRead;
		}
		if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) {
			throw new Error("Bundled plugin manifest changed while reading");
		}
		const manifest = JSON.parse(bytes.toString("utf8"));
		if (manifest.pluginId !== PROVIDER_QUOTA_ID || manifest.version !== PROVIDER_QUOTA_VERSION) {
			throw new Error("Bundled Provider Quota source identity differs from the pinned descriptor");
		}
		return manifest;
	} finally {
		await handle.close();
	}
}

export async function bundledPluginArchiveIdentity(
	path: string,
): Promise<{ size: number; sha256: string }> {
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (
			!info.isFile() ||
			!Number.isSafeInteger(info.size) ||
			info.size <= 0 ||
			info.size > MAX_ARCHIVE_BYTES
		) {
			throw new Error("Bundled plugin archive exceeds the 16 MiB byte budget");
		}
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(Math.min(info.size, 64 * 1024));
		let offset = 0;
		while (offset < info.size) {
			const { bytesRead } = await handle.read(
				buffer,
				0,
				Math.min(buffer.length, info.size - offset),
				offset,
			);
			if (bytesRead === 0) throw new Error("Bundled plugin archive changed while hashing");
			hash.update(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}
		const { bytesRead } = await handle.read(buffer, 0, 1, offset);
		if (bytesRead !== 0) throw new Error("Bundled plugin archive changed while hashing");
		return { size: info.size, sha256: hash.digest("hex") };
	} finally {
		await handle.close();
	}
}

/** Link only a private copy: canonical output must never share the cache's inode. */
async function freezeArchive(
	source: string,
	path: string,
	identity: { size: number; sha256: string },
): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await copyFile(source, temporary, constants.COPYFILE_EXCL);
		const writer = await open(temporary, "r+");
		try {
			await writer.sync();
		} finally {
			await writer.close();
		}
		const copied = await bundledPluginArchiveIdentity(temporary);
		if (copied.size !== identity.size || copied.sha256 !== identity.sha256)
			throw new Error("Immutable bundled plugin build asset identity mismatch");
		try {
			// Atomic no-replace publication; concurrent identical builders may safely converge.
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!(await lstat(path)).isFile())
			throw new Error("Immutable bundled plugin build asset identity mismatch");
		const stored = await bundledPluginArchiveIdentity(path);
		if (stored.size !== identity.size || stored.sha256 !== identity.sha256)
			throw new Error("Immutable bundled plugin build asset identity mismatch");
	} finally {
		await rm(temporary, { force: true });
	}
}

async function freezeMetadata(path: string, content: string): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const writer = await open(temporary, "wx");
		try {
			await writer.writeFile(content);
			await writer.sync();
		} finally {
			await writer.close();
		}
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!(await lstat(path)).isFile())
			throw new Error("Immutable bundled plugin metadata identity mismatch");
		const stored = await open(path, "r");
		try {
			const size = Buffer.byteLength(content);
			if ((await stored.stat()).size !== size)
				throw new Error("Immutable bundled plugin metadata identity mismatch");
			const bytes = Buffer.alloc(size + 1);
			const { bytesRead } = await stored.read(bytes, 0, bytes.length, 0);
			if (bytesRead !== size || bytes.subarray(0, bytesRead).toString("utf8") !== content)
				throw new Error("Immutable bundled plugin metadata identity mismatch");
		} finally {
			await stored.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

export function renderBundledPluginModule(
	asset: Pick<BundledPluginBuildAsset, "pluginId" | "version" | "size" | "sha256">,
	archiveImport: string,
): string {
	if (
		asset.pluginId !== PROVIDER_QUOTA_ID ||
		asset.version !== PROVIDER_QUOTA_VERSION ||
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		asset.size > MAX_ARCHIVE_BYTES ||
		!/^[a-f0-9]{64}$/.test(asset.sha256)
	) {
		throw new Error("Invalid pinned bundled plugin build metadata");
	}
	return `// AUTO-GENERATED by scripts/build-bundled-plugins.ts — DO NOT EDIT
// Plugin JavaScript is an opaque package member, never a host import or worker entrypoint.
import providerQuotaArchive from ${JSON.stringify(archiveImport.replaceAll("\\", "/"))} with { type: "file" };

export const embeddedBundledPluginAssets = Object.freeze([
	Object.freeze({
		pluginId: ${JSON.stringify(asset.pluginId)},
		version: ${JSON.stringify(asset.version)},
		archivePath: providerQuotaArchive,
		size: ${asset.size},
		sha256: ${JSON.stringify(asset.sha256)},
	}),
]);
`;
}

/** Build one bounded archive, freeze it by digest, then publish public build outputs. */
export async function buildBundledPlugins(
	options: BuildBundledPluginsOptions = {},
): Promise<BuildBundledPluginsResult> {
	const root = resolve(options.root ?? ROOT);
	const source = join(root, "plugins", "provider-quota");
	await readManifest(join(source, "manifest.json"));
	const canonicalDist = resolve(source, "dist");
	const publishGenerated = options.publishGenerated !== false;
	const requestedOutDir = options.outDir ? resolve(options.outDir) : undefined;
	if (requestedOutDir && requestedOutDir !== canonicalDist && publishGenerated)
		throw new Error(
			"Bundled plugin generation cannot publish generated metadata from a non-canonical output directory",
		);
	const outDir =
		requestedOutDir ??
		(publishGenerated ? canonicalDist : join(root, ".narrafork", "bundled-plugin-build-output"));
	const generatedDir = resolve(options.generatedDir ?? join(root, "server", "generated"));
	const cacheDir = join(root, ".narrafork", "bundled-plugin-build-assets");
	await mkdir(cacheDir, { recursive: true });
	// Only the package build recipe runs here, in an explicit build process. Its server entry
	// remains inside the archive and is never imported into the NF runtime/module graph.
	const { buildProviderQuotaPlugin } = (await import(
		pathToFileURL(join(source, "build.ts")).href
	)) as {
		buildProviderQuotaPlugin: (options: {
			outDir: string;
			preparePublication?: (staged: {
				archivePath: string;
				packageRoot: string;
			}) => Promise<readonly { path: string; content: string }[]>;
		}) => Promise<{ archivePath: string; packageRoot: string }>;
	};
	let metadata:
		| { schemaVersion: 1; pluginId: string; version: string; size: number; sha256: string }
		| undefined;
	let archivePath = "";
	let metadataPath = "";
	const generatedModulePath = join(generatedDir, "embedded-bundled-plugins.ts");
	let generatedModuleSource = "";
	await buildProviderQuotaPlugin({
		outDir,
		async preparePublication(staged) {
			await readManifest(join(staged.packageRoot, "manifest.json"));
			const identity = await bundledPluginArchiveIdentity(staged.archivePath);
			metadata = {
				schemaVersion: 1,
				pluginId: PROVIDER_QUOTA_ID,
				version: PROVIDER_QUOTA_VERSION,
				...identity,
			};
			archivePath = join(cacheDir, `${metadata.sha256}.nfplugin`);
			metadataPath = join(cacheDir, `${metadata.sha256}.asset.json`);
			const metadataJson = `${JSON.stringify(metadata, null, 2)}\n`;
			await freezeArchive(staged.archivePath, archivePath, identity);
			await freezeMetadata(metadataPath, metadataJson);
			const archiveImport = relative(generatedDir, archivePath).replaceAll("\\", "/");
			const importPath = archiveImport.startsWith(".") ? archiveImport : `./${archiveImport}`;
			generatedModuleSource = renderBundledPluginModule(metadata, importPath);
			const publicMetadataPath = join(outDir, "provider-quota.asset.json");
			const sidecars = [{ path: publicMetadataPath, content: metadataJson }];
			if (publishGenerated)
				sidecars.push({ path: generatedModulePath, content: generatedModuleSource });
			return sidecars;
		},
	});
	if (!metadata || !archivePath || !metadataPath)
		throw new Error("Bundled plugin publication did not produce a verified archive identity");
	return {
		generatedModulePath,
		generatedModuleSource,
		assets: [{ ...metadata, archivePath, metadataPath }],
	};
}

if (import.meta.main) console.log(JSON.stringify(await buildBundledPlugins()));
