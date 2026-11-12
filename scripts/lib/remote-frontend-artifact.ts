import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RemoteFrontendCapability } from "../../shared/remote-access/application";
import {
	parseRemoteFrontendManifest,
	REMOTE_FRONTEND_MANIFEST_MAX_BYTES,
	type RemoteFrontendManifest,
	remoteFrontendArtifactNames,
} from "../../shared/remote-access/frontend-manifest";
import { runRemoteFrontendArchiveOperation } from "./remote-frontend-archive-worker";

export interface RemoteFrontendArtifactTarget {
	repository: string;
	version: string;
	commit: string;
	capability: RemoteFrontendCapability;
}
export interface RemoteFrontendArtifactBuildOptions {
	root: string;
	inputDir: string;
	outputDir: string;
	target: RemoteFrontendArtifactTarget;
	signal?: AbortSignal;
}
export interface VerifiedRemoteFrontendExtraction {
	manifest: RemoteFrontendManifest;
	manifestSha256: string;
}
/** CLI-only API: run in the independent build/CI/import process, never an NF HTTP handler.
 * Static imports let sealed CI control.js include the complete verifier without target code/deps.
 * There is no worker failure fallback; the CLI process itself is the isolation boundary.
 */
async function execute(operation: string, payload: Record<string, unknown>, signal?: AbortSignal) {
	return (await runRemoteFrontendArchiveOperation(operation, payload, signal)) as unknown as Record<
		string,
		unknown
	>;
}

export async function verifyRemoteFrontendArtifact(
	directory: string,
	target: RemoteFrontendArtifactTarget,
	signal?: AbortSignal,
): Promise<RemoteFrontendManifest> {
	return parseRemoteFrontendManifest(
		await execute("verify", { directory: resolve(directory), target }, signal),
	);
}

/** The caller supplies an empty, exclusively owned staging directory; never a public destination. */
export async function extractRemoteFrontendArtifact(
	directory: string,
	target: RemoteFrontendArtifactTarget,
	staging: string,
	signal?: AbortSignal,
): Promise<VerifiedRemoteFrontendExtraction> {
	const result = await execute(
		"extract",
		{ directory: resolve(directory), target, staging: resolve(staging) },
		signal,
	);
	if (typeof result.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.manifestSha256))
		throw new Error("REMOTE_FRONTEND_ARCHIVE_RESULT_INVALID");
	return {
		manifest: parseRemoteFrontendManifest(result.manifest),
		manifestSha256: result.manifestSha256,
	};
}

/** Re-hash installed files inside the CLI process before exposing a host created after a restart. */
export async function verifyRemoteFrontendInstallation(
	directory: string,
	expectedManifestSha256: string,
	signal?: AbortSignal,
): Promise<RemoteFrontendManifest> {
	return parseRemoteFrontendManifest(
		await execute("installed", { directory: resolve(directory), expectedManifestSha256 }, signal),
	);
}

export async function buildRemoteFrontendArtifact(
	options: RemoteFrontendArtifactBuildOptions,
): Promise<RemoteFrontendManifest> {
	options.signal?.throwIfAborted();
	const output = resolve(options.outputDir);
	await mkdir(output, { recursive: true });
	if (!(await lstat(output)).isDirectory() || (await lstat(output)).isSymbolicLink())
		throw new Error("REMOTE_FRONTEND_OUTPUT_INVALID");
	const staging = await mkdtemp(join(output, ".remote-frontend-build-"));
	const created: string[] = [];
	try {
		const manifest = parseRemoteFrontendManifest(
			await execute(
				"build",
				{
					root: resolve(options.root),
					inputDir: resolve(options.inputDir),
					outputDir: staging,
					target: options.target,
				},
				options.signal,
			),
		);
		options.signal?.throwIfAborted();
		const names = remoteFrontendArtifactNames(options.target.version);
		for (const name of [names.archive, names.manifest]) {
			try {
				// Same-filesystem exclusive publication; never overwrite another build's assets.
				await link(join(staging, name), join(output, name));
				created.push(join(output, name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || created.length) throw error;
				const existing = await verifyRemoteFrontendArtifact(output, options.target, options.signal);
				if (JSON.stringify(existing) !== JSON.stringify(manifest))
					throw new Error("REMOTE_FRONTEND_OUTPUT_CONFLICT");
				return existing;
			}
		}
		return manifest;
	} catch (error) {
		for (const path of created) await rm(path, { force: true });
		throw error;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** Only small manifest control data is read here; archive content is streamed by the CLI-only archive core. */
export async function readRemoteFrontendManifestFile(
	path: string,
): Promise<{ manifest: RemoteFrontendManifest; raw: Uint8Array }> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > REMOTE_FRONTEND_MANIFEST_MAX_BYTES)
		throw new Error("REMOTE_FRONTEND_MANIFEST_INVALID");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const after = await handle.stat();
		if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino)
			throw new Error("REMOTE_FRONTEND_MANIFEST_CHANGED");
		const buffer = Buffer.alloc(REMOTE_FRONTEND_MANIFEST_MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > REMOTE_FRONTEND_MANIFEST_MAX_BYTES)
			throw new Error("REMOTE_FRONTEND_MANIFEST_TOO_LARGE");
		const raw = buffer.subarray(0, length);
		return { manifest: parseRemoteFrontendManifest(JSON.parse(raw.toString("utf8"))), raw };
	} finally {
		await handle.close();
	}
}

/** Copy untrusted source assets into a privately owned directory before verification/import. */
export async function snapshotRemoteFrontendArtifact(
	manifestPath: string,
	destination: string,
	signal?: AbortSignal,
): Promise<RemoteFrontendArtifactTarget> {
	signal?.throwIfAborted();
	const { manifest } = await readRemoteFrontendManifestFile(manifestPath);
	const names = remoteFrontendArtifactNames(manifest.nfVersion);
	if (resolve(manifestPath) !== resolve(dirname(manifestPath), names.manifest))
		throw new Error("REMOTE_FRONTEND_MANIFEST_NAME_INVALID");
	// Copy and validate inside the CLI process, so even sparse/changed hostile source files stay bounded.
	await execute(
		"snapshot",
		{
			directory: dirname(resolve(manifestPath)),
			destination: resolve(destination),
			target: {
				repository: manifest.repository,
				version: manifest.nfVersion,
				commit: manifest.sourceCommit,
				capability: manifest.capability,
			},
		},
		signal,
	);
	return {
		repository: manifest.repository,
		version: manifest.nfVersion,
		commit: manifest.sourceCommit,
		capability: manifest.capability,
	};
}
