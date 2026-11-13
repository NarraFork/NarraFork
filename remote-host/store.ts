import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	extractRemoteFrontendArtifact,
	snapshotRemoteFrontendArtifact,
	verifyRemoteFrontendInstallation,
} from "../scripts/lib/remote-frontend-artifact";
import {
	parseRemoteFrontendCatalog,
	REMOTE_FRONTEND_CATALOG_MAX_BYTES,
	type RemoteFrontendCatalog,
	type RemoteFrontendCatalogEntry,
	remoteFrontendManifestPath,
} from "../shared/remote-access/frontend-catalog";
import {
	isRemoteFrontendDigest,
	type RemoteFrontendManifest,
} from "../shared/remote-access/frontend-manifest";

/** Store mutations belong to the separate import/configure CLI, never the HTTP asset handler. */
export async function assertHostDirectory(path: string): Promise<void> {
	for (let current = resolve(path); ; current = dirname(current)) {
		const stat = await lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("REMOTE_HOST_UNSAFE_DIRECTORY");
		if (dirname(current) === current) return;
	}
}
export async function readHostControl(path: string, maximum: number): Promise<Buffer> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
		throw new Error("REMOTE_HOST_CONTROL_INVALID");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await handle.stat();
		if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev)
			throw new Error("REMOTE_HOST_CONTROL_CHANGED");
		const bytes = Buffer.alloc(maximum + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > maximum) throw new Error("REMOTE_HOST_CONTROL_TOO_LARGE");
		return bytes.subarray(0, length);
	} finally {
		await handle.close();
	}
}
export async function readRemoteFrontendCatalog(storePath: string): Promise<RemoteFrontendCatalog> {
	try {
		return parseRemoteFrontendCatalog(
			JSON.parse(
				(
					await readHostControl(join(storePath, "catalog.json"), REMOTE_FRONTEND_CATALOG_MAX_BYTES)
				).toString("utf8"),
			),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { schemaVersion: 1, bootstrapAbi: 1, entries: [] };
		throw error;
	}
}
async function atomicControl(store: string, name: string, value: unknown): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	if (bytes.length > REMOTE_FRONTEND_CATALOG_MAX_BYTES)
		throw new Error("REMOTE_HOST_CONTROL_TOO_LARGE");
	const temporary = join(store, `.${name}-${randomUUID()}.tmp`),
		handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, join(store, name));
	} finally {
		await rm(temporary, { force: true });
	}
}
async function locked<T>(
	storePath: string,
	signal: AbortSignal | undefined,
	run: (store: string) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted();
	const store = resolve(storePath);
	await mkdir(store, { recursive: true, mode: 0o700 });
	await assertHostDirectory(store);
	const info = await lstat(store);
	if (process.platform !== "win32" && (info.mode & 0o022) !== 0)
		throw new Error("REMOTE_HOST_WRITABLE_STORE");
	const lockPath = join(store, ".remote-host.lock");
	const lock = await open(lockPath, "wx", 0o600);
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid }));
		signal?.throwIfAborted();
		return await run(store);
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
	}
}
function catalogEntry(
	manifest: RemoteFrontendManifest,
	manifestSha256: string,
): RemoteFrontendCatalogEntry {
	return {
		buildId: manifest.buildId,
		repository: manifest.repository,
		nfVersion: manifest.nfVersion,
		bootstrapAbi: manifest.capability.bootstrapAbi,
		apiEpoch: manifest.capability.apiEpoch,
		wireVersion: manifest.capability.wireVersion,
		manifestPath: remoteFrontendManifestPath(manifest.buildId),
		manifestSha256,
		disabled: false,
	};
}

export async function importRemoteFrontend(options: {
	storePath: string;
	manifestPath: string;
	signal?: AbortSignal;
}): Promise<RemoteFrontendManifest> {
	return locked(options.storePath, options.signal, async (store) => {
		const staging = await mkdtemp(join(store, ".remote-import-"));
		try {
			const snapshot = join(staging, "package"),
				contents = join(staging, "contents");
			await mkdir(snapshot, { mode: 0o700 });
			await mkdir(contents, { mode: 0o700 });
			const target = await snapshotRemoteFrontendArtifact(
				resolve(options.manifestPath),
				snapshot,
				options.signal,
			);
			const { manifest, manifestSha256 } = await extractRemoteFrontendArtifact(
				snapshot,
				target,
				contents,
				options.signal,
			);
			const catalog = await readRemoteFrontendCatalog(store),
				entry = catalogEntry(manifest, manifestSha256),
				existing = catalog.entries.find((value) => value.buildId === manifest.buildId);
			if (existing && existing.manifestSha256 !== manifestSha256)
				throw new Error("REMOTE_HOST_IMMUTABLE_CONFLICT");
			const next = parseRemoteFrontendCatalog({
				...catalog,
				entries: existing ? catalog.entries : [...catalog.entries, entry],
			});
			const parent = join(store, "frontends");
			await mkdir(parent, { recursive: true, mode: 0o700 });
			await assertHostDirectory(parent);
			const destination = join(parent, manifest.buildId);
			let exists = false;
			try {
				const stat = await lstat(destination);
				if (!stat.isDirectory() || stat.isSymbolicLink())
					throw new Error("REMOTE_HOST_IMMUTABLE_CONFLICT");
				exists = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			options.signal?.throwIfAborted();
			if (exists) {
				const installed = await verifyRemoteFrontendInstallation(
					destination,
					manifestSha256,
					options.signal,
				);
				if (JSON.stringify(installed) !== JSON.stringify(manifest))
					throw new Error("REMOTE_HOST_IMMUTABLE_CONFLICT");
			} else {
				await rename(contents, destination);
			}
			// Catalog is published last. Interrupted installs remain immutable orphans, never half-served trees.
			await atomicControl(store, "catalog.json", next);
			return manifest;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	});
}
export async function setRemoteFrontendDisabled(
	storePath: string,
	buildId: string,
	disabled: boolean,
	signal?: AbortSignal,
): Promise<void> {
	if (!isRemoteFrontendDigest(buildId) || typeof disabled !== "boolean")
		throw new Error("REMOTE_HOST_BUILD_ID_INVALID");
	await locked(storePath, signal, async (store) => {
		const catalog = await readRemoteFrontendCatalog(store);
		if (!catalog.entries.some((entry) => entry.buildId === buildId))
			throw new Error("REMOTE_HOST_BUILD_NOT_FOUND");
		const next = parseRemoteFrontendCatalog({
			...catalog,
			entries: catalog.entries.map((entry) =>
				entry.buildId === buildId ? { ...entry, disabled } : entry,
			),
		});
		signal?.throwIfAborted();
		await atomicControl(store, "catalog.json", next);
	});
}
export async function configureRemoteBootstrap(
	storePath: string,
	buildId: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!isRemoteFrontendDigest(buildId)) throw new Error("REMOTE_HOST_BUILD_ID_INVALID");
	await locked(storePath, signal, async (store) => {
		const catalog = await readRemoteFrontendCatalog(store);
		if (!catalog.entries.some((entry) => entry.buildId === buildId && !entry.disabled))
			throw new Error("REMOTE_HOST_BOOTSTRAP_UNAVAILABLE");
		signal?.throwIfAborted();
		await atomicControl(store, "host.json", { schemaVersion: 1, bootstrapBuildId: buildId });
	});
}
export async function readRemoteBootstrap(storePath: string): Promise<string> {
	const value = JSON.parse(
		(await readHostControl(join(storePath, "host.json"), 4096)).toString("utf8"),
	) as { schemaVersion: unknown; bootstrapBuildId: unknown };
	if (
		value.schemaVersion !== 1 ||
		!isRemoteFrontendDigest(value.bootstrapBuildId) ||
		Object.keys(value).some((key) => key !== "schemaVersion" && key !== "bootstrapBuildId")
	)
		throw new Error("REMOTE_HOST_BOOTSTRAP_CONFIG_INVALID");
	return value.bootstrapBuildId;
}
