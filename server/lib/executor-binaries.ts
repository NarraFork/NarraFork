/** Immutable, source-bound remote executor distribution. */
import {
	HELPER_BINARY_MAX_BYTES,
	type HelperSource,
	helperSourceIdentity,
	parseExecutorReleaseManifest,
} from "../../shared/helper-distribution";
import {
	EXECUTOR_MANIFEST_FILENAME,
	type ExecutorManifest,
	type ExecutorPlatform,
	executorCachedFilename,
} from "../../shared/remote-executor";
import { parseExecutorManifest } from "../../shared/remote-executor-manifest";
import { DEVICE_PROTOCOL_VERSION } from "./agent/execution/rpc-types";
import { downloadHelperBinary } from "./helper-binaries";
import {
	abortable,
	captureHelperSource,
	createDistributionContext,
	type DistributionContext,
	type DistributionFetch,
	distributionCancellationKey,
	distributionPath,
	fetchDistributionAsset,
	readDistributionJson,
	readLocalDistributionJson,
	withDeadline,
	writeDistributionJson,
} from "./helper-distribution-runtime";
import { APP_VERSION } from "./version";

const cache = new Map<string, { manifest: ExecutorManifest; fetchedAt: number }>();
const inflight = new Map<string, Promise<ExecutorManifest | null>>();
const origins = new WeakMap<ExecutorManifest, { source: HelperSource; tag: string }>();
export class ExecutorDistributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutorDistributionError";
	}
}
export function resetExecutorManifestCache(): void {
	cache.clear();
	inflight.clear();
}
function assertCompatibility(manifest: ExecutorManifest): void {
	if (manifest.version !== APP_VERSION || manifest.protocolVersion !== DEVICE_PROTOCOL_VERSION)
		throw new ExecutorDistributionError(
			"Executor version/protocol does not match this NarraFork build",
		);
	if (Object.values(manifest.platforms).some((entry) => entry.size > HELPER_BINARY_MAX_BYTES))
		throw new ExecutorDistributionError("Executor binary exceeds size limit");
}
function parseManifest(value: unknown, source: HelperSource, tag: string): ExecutorManifest {
	const manifest =
		source.source === "github"
			? parseExecutorReleaseManifest(value, {
					repository: source.repository,
					tag,
					version: APP_VERSION,
					protocolVersion: DEVICE_PROTOCOL_VERSION,
				}).manifest
			: parseExecutorManifest(value);
	assertCompatibility(manifest);
	origins.set(manifest, { source, tag });
	return manifest;
}
async function fetchManifest(
	context: DistributionContext,
	tag: string,
	signal?: AbortSignal,
): Promise<ExecutorManifest | null> {
	const path = distributionPath(
		context.source,
		`${tag}\0${APP_VERSION}\0${DEVICE_PROTOCOL_VERSION}\0manifest`,
	);
	const deadline = withDeadline(signal, 10_000);
	try {
		const value = await readDistributionJson(
			await fetchDistributionAsset(context, tag, EXECUTOR_MANIFEST_FILENAME, deadline.signal),
			deadline.signal,
		);
		const manifest = parseManifest(value, context.source, tag);
		if (!context.isCurrent()) return null;
		await writeDistributionJson(path, value);
		return context.isCurrent() ? manifest : null;
	} catch {
		signal?.throwIfAborted();
		if (!context.isCurrent()) return null;
		try {
			const local = await readLocalDistributionJson(path);
			signal?.throwIfAborted();
			if (!context.isCurrent()) return null;
			return parseManifest(local, context.source, tag);
		} catch {
			signal?.throwIfAborted();
			return null;
		}
	} finally {
		deadline.dispose();
	}
}
export async function getExecutorManifest(
	options: {
		forceRefresh?: boolean;
		source?: HelperSource;
		signal?: AbortSignal;
		fetcher?: DistributionFetch;
	} = {},
): Promise<ExecutorManifest | null> {
	const context = createDistributionContext(
		options.source ?? captureHelperSource(),
		options.fetcher,
	);
	const tag = context.source.source === "github" ? `executor-v${APP_VERSION}` : "legacy-tools";
	const key = `${context.key}\0${tag}\0${APP_VERSION}\0${DEVICE_PROTOCOL_VERSION}`;
	options.signal?.throwIfAborted();
	if (!context.isCurrent()) return null;
	const cached = cache.get(key);
	if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < 10 * 60_000)
		return cached.manifest;
	const inflightKey = `${key}\0${distributionCancellationKey(options.signal)}`;
	const existing = inflight.get(inflightKey);
	if (!options.forceRefresh && existing) {
		const manifest = await (options.signal ? abortable(existing, options.signal) : existing);
		options.signal?.throwIfAborted();
		return context.isCurrent() ? manifest : null;
	}
	const pending = (async () => {
		const manifest = await fetchManifest(context, tag, options.signal);
		options.signal?.throwIfAborted();
		if (!context.isCurrent()) return null;
		if (manifest) {
			if (cache.size >= 64) cache.clear();
			cache.set(key, { manifest, fetchedAt: Date.now() });
		}
		return manifest;
	})();
	inflight.set(inflightKey, pending);
	try {
		const manifest = await pending;
		options.signal?.throwIfAborted();
		return context.isCurrent() ? manifest : null;
	} finally {
		if (inflight.get(inflightKey) === pending) inflight.delete(inflightKey);
	}
}
export interface ExecutorArtifactBinding {
	source: HelperSource;
	tag: string;
	version: string;
	protocolVersion: number;
	platform: ExecutorPlatform;
	filename: string;
	size: number;
	sha256: string;
}
export function freezeExecutorArtifact(
	manifest: ExecutorManifest,
	platform: ExecutorPlatform,
): ExecutorArtifactBinding {
	const parsed = parseExecutorManifest(manifest);
	assertCompatibility(parsed);
	const entry = parsed.platforms[platform];
	if (!entry)
		throw new ExecutorDistributionError(
			`Executor version ${parsed.version} does not publish a build for ${platform}`,
		);
	const origin = origins.get(manifest);
	const source = origin?.source ?? captureHelperSource();
	if (helperSourceIdentity(source) !== helperSourceIdentity(captureHelperSource())) {
		throw new ExecutorDistributionError(
			"Executor distribution source changed; request a fresh manifest",
		);
	}
	return {
		source: { ...source },
		tag:
			origin?.tag ?? (source.source === "github" ? `executor-v${parsed.version}` : "legacy-tools"),
		version: parsed.version,
		protocolVersion: parsed.protocolVersion,
		platform,
		...entry,
	};
}
export interface ExecutorArtifactLocation {
	path: string;
	filename: string;
	version: string;
	size: number;
	sha256: string;
}
export async function ensureExecutorBinary(
	platform: ExecutorPlatform,
	options: {
		manifest?: ExecutorManifest;
		binding?: ExecutorArtifactBinding;
		signal?: AbortSignal;
		fetcher?: DistributionFetch;
	} = {},
): Promise<ExecutorArtifactLocation> {
	let binding = options.binding;
	if (!binding) {
		const manifest =
			options.manifest ??
			(await getExecutorManifest({ signal: options.signal, fetcher: options.fetcher }));
		if (!manifest)
			throw new ExecutorDistributionError(
				"Executor manifest is unavailable; check the selected update source",
			);
		binding = freezeExecutorArtifact(manifest, platform);
	}
	const check = parseExecutorManifest({
		version: binding.version,
		protocolVersion: binding.protocolVersion,
		releasedAt: "2026-01-01T00:00:00.000Z",
		platforms: {
			[binding.platform]: {
				filename: binding.filename,
				size: binding.size,
				sha256: binding.sha256,
			},
		},
	});
	assertCompatibility(check);
	if (
		binding.platform !== platform ||
		binding.tag !==
			(binding.source.source === "github" ? `executor-v${binding.version}` : "legacy-tools")
	)
		throw new ExecutorDistributionError("Executor binding mismatch");
	const downloaded = await downloadHelperBinary(
		{
			toolName: binding.filename,
			cachedName: executorCachedFilename(binding.version, platform),
			displayName: "narrafork-executor",
			expectedSha256: binding.sha256,
			expectedSize: binding.size,
			platform: platform.replace("amd64", "x64"),
		},
		{
			source: binding.source,
			tag: binding.tag,
			signal: options.signal,
			fetcher: options.fetcher,
			allowFrozenSource: Boolean(options.binding),
			allowUnsignedDownload: false,
			maxBytes: HELPER_BINARY_MAX_BYTES,
			timeoutMs: 120_000,
			bypassFailureCache: true,
		},
	);
	if (!downloaded)
		throw new ExecutorDistributionError(
			`Failed to download executor for ${platform} from the selected source`,
		);
	return {
		path: downloaded,
		filename: binding.filename,
		version: binding.version,
		size: binding.size,
		sha256: binding.sha256,
	};
}
export function getExecutorArtifactDigest(
	manifest: ExecutorManifest,
	platform: ExecutorPlatform,
): string {
	const entry = manifest.platforms[platform];
	if (!entry)
		throw new ExecutorDistributionError(
			`Executor version ${manifest.version} does not publish a build for ${platform}`,
		);
	return entry.sha256;
}
