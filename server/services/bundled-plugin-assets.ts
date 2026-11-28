import { resolve } from "node:path";
import legacyQuotaArchive from "../../tests/fixtures/provider-quota-1.0.3.nfplugin" with {
	type: "file",
};
import { isCompiledModuleUrl, isCompiledRuntime } from "../lib/runtime-target";

const PROVIDER_QUOTA_ID = "io.narrafork.provider-quota";
const PROVIDER_QUOTA_VERSION = "1.0.4";
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 10_000;
const BUILD_TIMEOUT_MS = 60_000;
const BUILD_OUTPUT_BYTES = 64 * 1024;
const SLOW_LOAD_MS = 1_000;

export interface BundledPluginDescriptor {
	pluginId: string;
	version: string;
	load: (
		signal?: AbortSignal,
	) => Promise<{ bytes: Uint8Array; sha256: string; packageHash?: string }>;
}

interface AssetIdentity {
	pluginId: string;
	version: string;
	size: number;
	sha256: string;
	packageHash?: string;
}

type LoadedAsset = Awaited<ReturnType<BundledPluginDescriptor["load"]>>;
interface PendingLoad {
	promise: Promise<LoadedAsset>;
	controller: AbortController;
	waiters: number;
}

function checkCancelled(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw signal.reason ?? new DOMException("Asset load cancelled", "AbortError");
}

function validateIdentity(value: unknown): AssetIdentity {
	if (!value || typeof value !== "object") throw new Error("Invalid bundled plugin metadata");
	const asset = value as Partial<AssetIdentity>;
	if (asset.pluginId !== PROVIDER_QUOTA_ID || asset.version !== PROVIDER_QUOTA_VERSION) {
		throw new Error("Bundled plugin identity differs from the pinned Provider Quota descriptor");
	}
	if (
		typeof asset.size !== "number" ||
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		asset.size > MAX_ARCHIVE_BYTES
	) {
		throw new Error("Bundled plugin archive exceeds the 16 MiB byte budget");
	}
	if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
		throw new Error("Invalid bundled plugin SHA-256 metadata");
	}
	if (
		asset.packageHash !== undefined &&
		(typeof asset.packageHash !== "string" || !/^[a-f0-9]{64}$/.test(asset.packageHash))
	)
		throw new Error("Invalid bundled plugin content identity");
	return asset as AssetIdentity;
}

async function readBoundedFile(
	path: string,
	maxBytes: number,
	signal: AbortSignal,
	expectedSize?: number,
): Promise<Uint8Array<ArrayBuffer>> {
	checkCancelled(signal);
	const file = Bun.file(path);
	const size = file.size;
	if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
		throw new Error("Bundled plugin asset exceeds its byte budget");
	}
	if (expectedSize !== undefined && size !== expectedSize) {
		throw new Error("Bundled plugin archive size mismatch");
	}
	// A stream into a fixed allocation bounds stat/read races and checks the exact generated size.
	const bytes = new Uint8Array(size);
	const reader = file.stream().getReader();
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new Error("Bundled plugin asset read deadline exceeded")),
		READ_TIMEOUT_MS,
	);
	const readSignal = AbortSignal.any([signal, deadline.signal]);
	const cancelReader = () => {
		void reader.cancel(readSignal.reason).catch(() => {});
	};
	readSignal.addEventListener("abort", cancelReader, { once: true });
	let offset = 0;
	try {
		for (;;) {
			checkCancelled(readSignal);
			const chunk = await reader.read();
			checkCancelled(readSignal);
			if (chunk.done) break;
			if (offset + chunk.value.byteLength > bytes.byteLength) {
				throw new Error("Bundled plugin asset grew beyond its byte budget");
			}
			bytes.set(chunk.value, offset);
			offset += chunk.value.byteLength;
		}
		if (offset !== size) throw new Error("Bundled plugin archive size mismatch");
		return bytes;
	} finally {
		clearTimeout(timer);
		readSignal.removeEventListener("abort", cancelReader);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function loadArchive(
	path: string,
	identity: AssetIdentity,
	signal: AbortSignal,
): Promise<LoadedAsset> {
	const bytes = await readBoundedFile(path, MAX_ARCHIVE_BYTES, signal, identity.size);
	checkCancelled(signal);
	// Web Crypto keeps the bounded but potentially 16 MiB digest off the request thread.
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	checkCancelled(signal);
	const sha256 = Buffer.from(digest).toString("hex");
	if (sha256 !== identity.sha256) throw new Error("Bundled plugin archive SHA-256 mismatch");
	return { bytes, sha256, ...(identity.packageHash ? { packageHash: identity.packageHash } : {}) };
}

async function loadCompiledAsset(signal: AbortSignal): Promise<LoadedAsset> {
	checkCancelled(signal);
	// No catch/fallback: a missing generated module must fail compilation or loading closed.
	const { embeddedBundledPluginAssets } = await import(
		"@server/generated/embedded-bundled-plugins"
	);
	checkCancelled(signal);
	if (!Array.isArray(embeddedBundledPluginAssets) || embeddedBundledPluginAssets.length !== 1) {
		throw new Error("Invalid bundled plugin asset inventory");
	}
	const embedded = embeddedBundledPluginAssets[0];
	const identity = validateIdentity(embedded);
	if (typeof embedded.archivePath !== "string" || !isCompiledModuleUrl(embedded.archivePath)) {
		throw new Error("Bundled plugin archive is not an embedded file asset");
	}
	return loadArchive(embedded.archivePath, identity, signal);
}

async function loadSourceAsset(signal: AbortSignal): Promise<LoadedAsset> {
	const root = resolve(import.meta.dir, "../..");
	const archivePath = resolve(root, "plugins/provider-quota/dist/provider-quota.nfplugin");
	const metadataPath = resolve(root, "plugins/provider-quota/dist/provider-quota.asset.json");
	checkCancelled(signal);
	const exists = await Promise.all([
		Bun.file(archivePath).exists(),
		Bun.file(metadataPath).exists(),
	]);
	checkCancelled(signal);
	if (exists.some((present) => !present)) {
		const { safeSpawn } = await import("../lib/spawn");
		checkCancelled(signal);
		const built = await safeSpawn({
			cmd: [process.execPath, resolve(root, "scripts/build-bundled-plugins.ts")],
			cwd: root,
			signal,
			timeout: BUILD_TIMEOUT_MS,
			maxOutputBytes: BUILD_OUTPUT_BYTES,
			stdoutStream: { maxBytes: BUILD_OUTPUT_BYTES, onChunk: () => undefined },
			maxStderrBytes: BUILD_OUTPUT_BYTES,
			killProcessTree: true,
		});
		checkCancelled(signal);
		if (built.exitCode !== 0 || built.terminationReason || built.stderrTruncated) {
			throw new Error(
				`Bundled Provider Quota build failed (${built.terminationReason ?? built.exitCode}): ${built.stderr}`,
			);
		}
	}
	const raw = JSON.parse(
		new TextDecoder().decode(await readBoundedFile(metadataPath, MAX_METADATA_BYTES, signal)),
	) as unknown;
	if (!raw || typeof raw !== "object" || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
		throw new Error("Invalid bundled plugin metadata schema");
	}
	return loadArchive(archivePath, validateIdentity(raw), signal);
}

let loaded: LoadedAsset | undefined;
let pending: PendingLoad | undefined;

function waitForLoad(load: PendingLoad, signal?: AbortSignal): Promise<LoadedAsset> {
	checkCancelled(signal);
	load.waiters++;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = () => {
			settled = true;
			signal?.removeEventListener("abort", cancelled);
			load.waiters--;
		};
		const cancelled = () => {
			if (settled) return;
			finish();
			if (load.waiters === 0) load.controller.abort(signal?.reason);
			reject(signal?.reason ?? new DOMException("Asset load cancelled", "AbortError"));
		};
		signal?.addEventListener("abort", cancelled, { once: true });
		load.promise.then(
			(result) => {
				if (settled) return;
				finish();
				resolve(result);
			},
			(error) => {
				if (settled) return;
				finish();
				reject(error);
			},
		);
	});
}

function loadProviderQuota(signal?: AbortSignal): Promise<LoadedAsset> {
	try {
		checkCancelled(signal);
	} catch (error) {
		return Promise.reject(error);
	}
	if (loaded) return Promise.resolve(loaded);
	if (!pending || pending.controller.signal.aborted) {
		const started = performance.now();
		const controller = new AbortController();
		const promise = isCompiledRuntime()
			? loadCompiledAsset(controller.signal)
			: loadSourceAsset(controller.signal);
		const current: PendingLoad = { promise, controller, waiters: 0 };
		pending = current;
		void promise
			.then((asset) => {
				if (!controller.signal.aborted) loaded = asset;
			})
			.catch(() => {})
			.finally(() => {
				if (pending === current) pending = undefined;
				const elapsedMs = performance.now() - started;
				if (elapsedMs >= SLOW_LOAD_MS) {
					console.warn("Bundled plugin asset load slow", {
						pluginId: PROVIDER_QUOTA_ID,
						elapsedMs,
					});
				}
			});
	}
	return waitForLoad(pending, signal);
}

const descriptors: readonly BundledPluginDescriptor[] = Object.freeze([
	Object.freeze({
		pluginId: PROVIDER_QUOTA_ID,
		version: PROVIDER_QUOTA_VERSION,
		load: loadProviderQuota,
	}),
]);

/** Enumeration is synchronous and does no disk I/O, package building, or plugin execution. */
export function getBundledPluginDescriptors(): readonly BundledPluginDescriptor[] {
	return descriptors;
}

/** Only an inherited enabled legacy quota choice selects this frozen compatibility package.
 * It carries the already supported capability set; upgrades to the new package are explicit.
 */
export const legacyQuotaUpgradeDescriptor: BundledPluginDescriptor = Object.freeze({
	pluginId: PROVIDER_QUOTA_ID,
	version: "1.0.3",
	load: (signal?: AbortSignal) =>
		loadArchive(
			legacyQuotaArchive,
			{
				pluginId: PROVIDER_QUOTA_ID,
				version: "1.0.3",
				size: 75527,
				sha256: "5491feaad8e0d35a92b9f49edfc24eb02c618d0fc6710fdca3a235c486c7a24f",
				packageHash: "e5385806c109df55e62a6f6a52cd4e067c5b13646fe6a0e10af9dc219a212f59",
			},
			signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
		),
});
