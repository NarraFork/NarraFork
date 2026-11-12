/** Optional, explicitly requested RTC helper distribution. Never starts the helper. */
import { type HelperSource, helperSourceIdentity } from "../../shared/helper-distribution";
import {
	REMOTE_PEER_BINARY_MAX_BYTES,
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PROTOCOL_VERSION,
	type RemotePeerManifest,
	type RemotePeerPlatform,
	remotePeerCachedFilename,
	resolveRemotePeerPlatform,
} from "../../shared/remote-peer";
import {
	parseRemotePeerManifest,
	parseRemotePeerReleaseManifest,
} from "../../shared/remote-peer-manifest";
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
	verifyDistributionFile,
	withDeadline,
	writeDistributionJson,
} from "./helper-distribution-runtime";
import { BUILD_REMOTE_PEER_DISTRIBUTION } from "./version";

const cache = new Map<string, { manifest: RemotePeerManifest; at: number }>();
const inflight = new Map<string, Promise<RemotePeerManifest | null>>();
const origins = new WeakMap<RemotePeerManifest, { source: HelperSource; tag: string }>();
const bindings = new WeakSet<RemotePeerArtifactBinding>();
export class RemotePeerDistributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemotePeerDistributionError";
	}
}
export function resetRemotePeerManifestCache(): void {
	cache.clear();
	inflight.clear();
}
function pin() {
	const value = BUILD_REMOTE_PEER_DISTRIBUTION;
	if (!value || value.protocolVersion !== REMOTE_PEER_PROTOCOL_VERSION)
		throw new RemotePeerDistributionError(
			"This NarraFork build has no compatible remote peer component pin",
		);
	return value;
}
function checkCompatibility(manifest: RemotePeerManifest): void {
	const expected = pin();
	if (
		manifest.version !== expected.version ||
		manifest.protocolVersion !== expected.protocolVersion
	)
		throw new RemotePeerDistributionError(
			"Remote peer version/protocol does not match this NarraFork build",
		);
}
function parseManifest(value: unknown, context: DistributionContext): RemotePeerManifest {
	const expected = pin();
	const result = parseRemotePeerReleaseManifest(value, {
		repository: context.source.repository,
		...expected,
	}).manifest;
	checkCompatibility(result);
	// Manifest identity cannot be changed between selection and binary acquisition.
	for (const entry of Object.values(result.platforms)) Object.freeze(entry);
	Object.freeze(result.platforms);
	Object.freeze(result);
	origins.set(result, { source: context.source, tag: expected.tag });
	return result;
}
async function fetchManifest(
	context: DistributionContext,
	signal?: AbortSignal,
): Promise<RemotePeerManifest | null> {
	const expected = pin();
	const path = distributionPath(
		context.source,
		`${expected.tag}\0${expected.version}\0${expected.protocolVersion}\0manifest`,
	);
	const deadline = withDeadline(signal, 10_000);
	try {
		const value = await readDistributionJson(
			await fetchDistributionAsset(
				context,
				expected.tag,
				REMOTE_PEER_MANIFEST_FILENAME,
				deadline.signal,
			),
			deadline.signal,
		);
		const result = parseManifest(value, context);
		if (!context.isCurrent() || context.isTransportCurrent?.() === false) return null;
		await writeDistributionJson(path, value);
		return context.isCurrent() && context.isTransportCurrent?.() !== false ? result : null;
	} catch {
		signal?.throwIfAborted();
		if (!context.isCurrent() || context.isTransportCurrent?.() === false) return null;
		try {
			const value = await readLocalDistributionJson(path);
			signal?.throwIfAborted();
			return context.isCurrent() ? parseManifest(value, context) : null;
		} catch {
			signal?.throwIfAborted();
			return null;
		}
	} finally {
		deadline.dispose();
	}
}
export async function getRemotePeerManifest(
	options: {
		forceRefresh?: boolean;
		source?: HelperSource;
		signal?: AbortSignal;
		fetcher?: DistributionFetch;
	} = {},
): Promise<RemotePeerManifest | null> {
	options.signal?.throwIfAborted();
	// An absent legacy pin is a disabled optional component, not an app-version fallback.
	if (!BUILD_REMOTE_PEER_DISTRIBUTION) return null;
	const expected = pin();
	const context = createDistributionContext(
		options.source ?? captureHelperSource(),
		options.fetcher,
	);
	if (!context.isCurrent() || context.isTransportCurrent?.() === false) return null;
	const key = `${context.key}\0${expected.tag}\0${expected.protocolVersion}`;
	const cached = cache.get(key);
	if (!options.forceRefresh && cached && Date.now() - cached.at < 10 * 60_000)
		return cached.manifest;
	const flightKey = `${key}\0${distributionCancellationKey(options.signal)}`;
	const existing = inflight.get(flightKey);
	if (!options.forceRefresh && existing) {
		const result = options.signal ? await abortable(existing, options.signal) : await existing;
		return context.isCurrent() && context.isTransportCurrent?.() !== false ? result : null;
	}
	const pending = (async () => {
		const result = await fetchManifest(context, options.signal);
		options.signal?.throwIfAborted();
		if (!context.isCurrent() || context.isTransportCurrent?.() === false) return null;
		if (result) {
			if (cache.size >= 64) cache.clear();
			cache.set(key, { manifest: result, at: Date.now() });
		}
		return result;
	})();
	inflight.set(flightKey, pending);
	try {
		return await pending;
	} finally {
		if (inflight.get(flightKey) === pending) inflight.delete(flightKey);
	}
}
export interface RemotePeerArtifactBinding {
	readonly source: HelperSource;
	readonly tag: string;
	readonly version: string;
	readonly protocolVersion: number;
	readonly platform: RemotePeerPlatform;
	readonly filename: string;
	readonly size: number;
	readonly sha256: string;
}
export function freezeRemotePeerArtifact(
	manifest: RemotePeerManifest,
	platform: RemotePeerPlatform,
): RemotePeerArtifactBinding {
	const parsed = parseRemotePeerManifest(manifest);
	checkCompatibility(parsed);
	const origin = origins.get(manifest);
	if (
		!origin ||
		helperSourceIdentity(origin.source) !== helperSourceIdentity(captureHelperSource())
	)
		throw new RemotePeerDistributionError(
			"Remote peer distribution source changed or manifest was not verified",
		);
	const entry = parsed.platforms[platform];
	if (!entry)
		throw new RemotePeerDistributionError(`Remote peer platform unavailable: ${platform}`);
	const binding = Object.freeze({
		...origin,
		version: parsed.version,
		protocolVersion: parsed.protocolVersion,
		platform,
		...entry,
	});
	bindings.add(binding);
	return binding;
}
export interface RemotePeerArtifactLocation {
	path: string;
	filename: string;
	version: string;
	protocolVersion: number;
	platform: RemotePeerPlatform;
	size: number;
	sha256: string;
}
/** Offline inspection only. No manifest fetch, binary download or process launch. */
export async function getInstalledRemotePeerBinary(
	signal?: AbortSignal,
): Promise<RemotePeerArtifactLocation | null> {
	const expected = pin();
	const platform = resolveRemotePeerPlatform(process.platform, process.arch);
	if (!platform) return null;
	const context = createDistributionContext(captureHelperSource());
	const deadline = withDeadline(signal, 10_000);
	try {
		const value = await readLocalDistributionJson(
			distributionPath(
				context.source,
				`${expected.tag}\0${expected.version}\0${expected.protocolVersion}\0manifest`,
			),
		);
		const manifest = parseManifest(value, context);
		const binding = freezeRemotePeerArtifact(manifest, platform);
		const helperPlatform = platform.replace("amd64", "x64");
		const path =
			distributionPath(
				context.source,
				`${binding.tag}\0${binding.tag}\0${helperPlatform}\0${binding.filename}\0${binding.sha256}`,
			) + (binding.filename.endsWith(".exe") ? ".exe" : "");
		if (
			!(await verifyDistributionFile(
				path,
				{ ...binding, platform: helperPlatform },
				deadline.signal,
			)) ||
			!context.isCurrent()
		)
			return null;
		return {
			path,
			filename: binding.filename,
			version: binding.version,
			protocolVersion: binding.protocolVersion,
			platform,
			size: binding.size,
			sha256: binding.sha256,
		};
	} catch {
		signal?.throwIfAborted();
		return null;
	} finally {
		deadline.dispose();
	}
}

/** Explicit acquisition only. Neither import, startup nor a status read invokes this function. */
export async function ensureRemotePeerBinary(
	platform: RemotePeerPlatform | undefined = undefined,
	options: {
		manifest?: RemotePeerManifest;
		binding?: RemotePeerArtifactBinding;
		signal?: AbortSignal;
		fetcher?: DistributionFetch;
	} = {},
): Promise<RemotePeerArtifactLocation> {
	options.signal?.throwIfAborted();
	const expected = pin();
	const selected = platform ?? resolveRemotePeerPlatform(process.platform, process.arch);
	if (!selected)
		throw new RemotePeerDistributionError("Remote peer is unavailable for this host platform");
	let binding = options.binding;
	if (!binding) {
		const manifest =
			options.manifest ??
			(await getRemotePeerManifest({ signal: options.signal, fetcher: options.fetcher }));
		if (!manifest)
			throw new RemotePeerDistributionError(
				"Remote peer component has not been published or is unavailable from the selected source",
			);
		binding = freezeRemotePeerArtifact(manifest, selected);
	}
	if (
		!bindings.has(binding) ||
		binding.platform !== selected ||
		binding.tag !== expected.tag ||
		binding.version !== expected.version ||
		binding.protocolVersion !== expected.protocolVersion ||
		helperSourceIdentity(binding.source) !== helperSourceIdentity(captureHelperSource())
	)
		throw new RemotePeerDistributionError(
			"Remote peer artifact binding mismatch; select a fresh verified manifest",
		);
	const context = createDistributionContext(binding.source, options.fetcher);
	const path = await downloadHelperBinary(
		{
			toolName: binding.filename,
			cachedName: remotePeerCachedFilename(binding.version, selected),
			displayName: "narrafork-remote-peer",
			expectedSize: binding.size,
			expectedSha256: binding.sha256,
			platform: selected.replace("amd64", "x64"),
		},
		{
			context,
			tag: binding.tag,
			signal: options.signal,
			allowUnsignedDownload: false,
			bypassFailureCache: true,
			timeoutMs: 120_000,
			maxBytes: REMOTE_PEER_BINARY_MAX_BYTES,
		},
	);
	options.signal?.throwIfAborted();
	if (!path || !context.isCurrent() || context.isTransportCurrent?.() === false)
		throw new RemotePeerDistributionError("Failed to acquire remote peer from the selected source");
	return {
		path,
		filename: binding.filename,
		version: binding.version,
		protocolVersion: binding.protocolVersion,
		platform: selected,
		size: binding.size,
		sha256: binding.sha256,
	};
}
