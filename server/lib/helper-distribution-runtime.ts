import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	HELPER_BINARY_MAX_BYTES,
	HELPER_MANIFEST_FILENAME,
	HELPER_MANIFEST_MAX_BYTES,
	HELPER_RELEASE_TAG,
	type HelperManifest,
	type HelperSource,
	helperSourceIdentity,
	normalizeHelperSource,
	parseHelperManifest,
} from "../../shared/helper-distribution";
import { matchesWindowsPeArch } from "../../shared/windows-pe";
import { createUpdateFetchContext, type UpdateFetchContext } from "./net/update-fetch";
import { narraforkDir, settings } from "./settings";

export type DistributionFetch = (url: string, init?: RequestInit) => Promise<Response>;
export const DISTRIBUTION_CACHE_DIR = join(narraforkDir, "bin", "distribution");
export interface DistributionContext {
	source: HelperSource;
	key: string;
	fetcher: DistributionFetch;
	/** Source validity, independent of a later proxy edit. */
	isCurrent(): boolean;
	isTransportCurrent?(): boolean;
}
export function captureHelperSource(): HelperSource {
	return normalizeHelperSource(settings.update ?? {});
}
export function createDistributionContext(
	source = captureHelperSource(),
	fetcher?: DistributionFetch,
	transport: UpdateFetchContext = createUpdateFetchContext(),
): DistributionContext {
	const frozen = Object.freeze(normalizeHelperSource(source));
	const identity = helperSourceIdentity(frozen);
	return {
		source: frozen,
		key: `${identity}\0${transport.key}`,
		fetcher: fetcher ?? transport.fetch,
		isCurrent: () => identity === helperSourceIdentity(captureHelperSource()),
		isTransportCurrent: transport.isCurrent,
	};
}
export function distributionPath(source: HelperSource, qualifier: string): string {
	const key = createHash("sha256")
		.update(`${helperSourceIdentity(source)}\0${qualifier}`)
		.digest("hex");
	return join(DISTRIBUTION_CACHE_DIR, key);
}
export function distributionAssetUrl(source: HelperSource, tag: string, name: string): string {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name) ||
		name.includes("..") ||
		!/^[A-Za-z0-9._-]+$/.test(tag)
	)
		throw new Error("Invalid distribution asset");
	return source.source === "github"
		? `https://github.com/${source.repository}/releases/download/${tag}/${name}`
		: `${source.serverUrl}/api/v2/tools/${name}`;
}
export function withDeadline(
	parent: AbortSignal | undefined,
	milliseconds: number,
): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new DOMException("Distribution timeout", "TimeoutError")),
		Math.max(1, milliseconds),
	);
	return {
		signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
		dispose: () => clearTimeout(timeout),
	};
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
const GITHUB_ASSET_HOSTS = new Set([
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"github-releases.githubusercontent.com",
]);
export async function fetchDistributionAsset(
	context: DistributionContext,
	tag: string,
	name: string,
	signal: AbortSignal,
): Promise<Response> {
	let url = distributionAssetUrl(context.source, tag, name);
	const origin = new URL(url).origin;
	for (let hop = 0; hop <= 5; hop++) {
		const parsed = new URL(url);
		if (
			parsed.username ||
			parsed.password ||
			(context.source.source === "github"
				? parsed.protocol !== "https:" ||
					parsed.port !== "" ||
					!GITHUB_ASSET_HOSTS.has(parsed.hostname)
				: parsed.origin !== origin)
		)
			throw new Error("Untrusted distribution redirect");
		const response = await abortable(context.fetcher(url, { redirect: "manual", signal }), signal);
		if (response.redirected || (response.url && response.url !== url)) {
			void response.body?.cancel().catch(() => {});
			throw new Error("Unexpected distribution redirect");
		}
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		void response.body?.cancel().catch(() => {});
		const location = response.headers.get("location");
		if (!location || hop === 5) throw new Error("Distribution redirect limit exceeded");
		url = new URL(location, url).href;
	}
	throw new Error("Distribution redirect limit exceeded");
}
export async function readDistributionJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		throw new Error(`Distribution manifest unavailable (${response.status})`);
	}
	if (Number(response.headers.get("content-length")) > HELPER_MANIFEST_MAX_BYTES) {
		void response.body?.cancel().catch(() => {});
		throw new Error("Manifest exceeds size limit");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Manifest has no body");
	const bytes = new Uint8Array(HELPER_MANIFEST_MAX_BYTES);
	let length = 0;
	try {
		while (true) {
			const chunk = await abortable(reader.read(), signal);
			if (chunk.done) break;
			if (length + chunk.value.length > bytes.length)
				throw new Error("Manifest exceeds size limit");
			bytes.set(chunk.value, length);
			length += chunk.value.length;
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
	} finally {
		void reader.cancel().catch(() => {});
	}
}
export async function readLocalDistributionJson(path: string): Promise<unknown | null> {
	try {
		const file = await open(path, "r");
		try {
			if (!(await file.stat()).isFile()) return null;
			const buffer = Buffer.alloc(HELPER_MANIFEST_MAX_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const chunk = await file.read(buffer, length, buffer.length - length, length);
				if (chunk.bytesRead === 0) break;
				length += chunk.bytesRead;
			}
			if (length > HELPER_MANIFEST_MAX_BYTES) return null;
			return JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
			);
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}
export async function writeDistributionJson(path: string, value: unknown): Promise<void> {
	await mkdir(DISTRIBUTION_CACHE_DIR, { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temp, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(value));
		} finally {
			await file.close();
		}
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => {});
	}
}
const cancellationScopes = new WeakMap<AbortSignal, string>();
let cancellationScopeSequence = 0;
/** Distinct parent operations must not cancel each other's shared fetch. */
export function distributionCancellationKey(signal?: AbortSignal): string {
	if (!signal) return "unscoped";
	let key = cancellationScopes.get(signal);
	if (!key) {
		key = String(++cancellationScopeSequence);
		cancellationScopes.set(signal, key);
	}
	return key;
}
const helperManifests = new Map<string, HelperManifest>();
const helperInflight = new Map<string, Promise<HelperManifest | null>>();
export function resetHelperDistributionCache(): void {
	helperManifests.clear();
	helperInflight.clear();
}
export async function getHelperManifest(
	context: DistributionContext,
	signal: AbortSignal,
	cancellationScope = "unscoped",
): Promise<HelperManifest | null> {
	signal.throwIfAborted();
	if (context.source.source !== "github") return null;
	const source = context.source;
	const key = `${context.key}\0${HELPER_RELEASE_TAG}`;
	const cached = helperManifests.get(key);
	if (cached) return cached;
	const inflightKey = `${key}\0${cancellationScope}`;
	const existing = helperInflight.get(inflightKey);
	if (existing) return abortable(existing, signal);
	const pending = (async () => {
		const path = distributionPath(source, `${HELPER_RELEASE_TAG}:manifest`);
		const deadline = withDeadline(signal, 10_000);
		let manifest: HelperManifest | null = null;
		try {
			manifest = parseHelperManifest(
				await readDistributionJson(
					await fetchDistributionAsset(
						context,
						HELPER_RELEASE_TAG,
						HELPER_MANIFEST_FILENAME,
						deadline.signal,
					),
					deadline.signal,
				),
				{ repository: source.repository },
			);
			if (!context.isCurrent()) return null;
			await writeDistributionJson(path, manifest);
		} catch {
			signal.throwIfAborted();
			try {
				manifest = parseHelperManifest(await readLocalDistributionJson(path), {
					repository: source.repository,
				});
			} catch {
				return null;
			}
		} finally {
			deadline.dispose();
		}
		if (!context.isCurrent()) return null;
		if (helperManifests.size >= 64) helperManifests.clear();
		helperManifests.set(key, manifest);
		return manifest;
	})();
	helperInflight.set(inflightKey, pending);
	try {
		return await pending;
	} finally {
		if (helperInflight.get(inflightKey) === pending) helperInflight.delete(inflightKey);
	}
}
export async function matchesBinaryArchitecture(path: string, platform?: string): Promise<boolean> {
	if (!platform) return true;
	const arch = platform.endsWith("arm64") ? "arm64" : "x64";
	const file = await open(path, "r");
	try {
		const header = Buffer.alloc(64);
		if ((await file.read(header, 0, 64, 0)).bytesRead < 64) return false;
		if (platform.startsWith("windows-") || platform.startsWith("win-")) {
			const offset = header.readUInt32LE(60);
			if (offset < 64 || offset > 1024 * 1024) return false;
			const bytes = Buffer.alloc(offset + 6);
			if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length) return false;
			return matchesWindowsPeArch(bytes, arch);
		}
		if (platform.startsWith("linux-"))
			return (
				header.readUInt32BE(0) === 0x7f454c46 &&
				header[4] === 2 &&
				header[5] === 1 &&
				header.readUInt16LE(18) === (arch === "arm64" ? 183 : 62)
			);
		if (platform.startsWith("darwin-"))
			return (
				header.readUInt32LE(0) === 0xfeedfacf &&
				header.readUInt32LE(4) === (arch === "arm64" ? 0x0100000c : 0x01000007)
			);
		return false;
	} finally {
		await file.close();
	}
}
export async function verifyDistributionFile(
	path: string,
	expected: { size?: number; sha256?: string; platform?: string },
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		signal?.throwIfAborted();
		const file = Bun.file(path);
		const info = await file.stat();
		if (
			info.size > HELPER_BINARY_MAX_BYTES ||
			info.size < 1 ||
			(expected.size !== undefined && info.size !== expected.size) ||
			!expected.sha256
		)
			return false;
		const hasher = new Bun.CryptoHasher("sha256");
		let bytes = 0;
		for await (const chunk of file.stream()) {
			signal?.throwIfAborted();
			bytes += chunk.length;
			if (bytes > HELPER_BINARY_MAX_BYTES || (expected.size !== undefined && bytes > expected.size))
				return false;
			for (let offset = 0; offset < chunk.length; offset += 64 * 1024)
				hasher.update(chunk.subarray(offset, offset + 64 * 1024));
		}
		return (
			(expected.size === undefined || bytes === expected.size) &&
			hasher.digest("hex") === expected.sha256 &&
			(await matchesBinaryArchitecture(path, expected.platform))
		);
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}
export async function downloadDistributionFile(
	context: DistributionContext,
	tag: string,
	name: string,
	path: string,
	expected: { size?: number; sha256?: string; platform?: string },
	options: {
		signal?: AbortSignal;
		timeoutMs: number;
		maxBytes?: number;
		allowUnsigned?: boolean;
		allowFrozenSource?: boolean;
	},
): Promise<string> {
	const deadline = withDeadline(options.signal, options.timeoutMs);
	const maxBytes = Math.min(options.maxBytes ?? HELPER_BINARY_MAX_BYTES, HELPER_BINARY_MAX_BYTES);
	let temp: string | undefined;
	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		deadline.signal.throwIfAborted();
		if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error("Invalid binary size limit");
		if (!expected.sha256 && !options.allowUnsigned) throw new Error("Unsigned distribution binary");
		response = await fetchDistributionAsset(context, tag, name, deadline.signal);
		if (!response.ok || Number(response.headers.get("content-length")) > maxBytes)
			throw new Error("Distribution binary unavailable/oversized");
		reader = response.body?.getReader();
		if (!reader) throw new Error("Binary has no body");
		await mkdir(DISTRIBUTION_CACHE_DIR, { recursive: true });
		temp = `${path}.${randomUUID()}.tmp`;
		const file = await open(temp, "wx", 0o700);
		const hasher = new Bun.CryptoHasher("sha256");
		let bytes = 0;
		try {
			while (true) {
				const chunk = await abortable(reader.read(), deadline.signal);
				if (chunk.done) break;
				bytes += chunk.value.length;
				if (bytes > maxBytes || (expected.size !== undefined && bytes > expected.size))
					throw new Error("Binary exceeds size limit");
				for (let offset = 0; offset < chunk.value.length; offset += 64 * 1024) {
					deadline.signal.throwIfAborted();
					const slice = chunk.value.subarray(offset, offset + 64 * 1024);
					hasher.update(slice);
					let written = 0;
					while (written < slice.length) {
						const result = await file.write(slice, written, slice.length - written);
						if (result.bytesWritten < 1) throw new Error("Binary write made no progress");
						written += result.bytesWritten;
					}
				}
			}
		} finally {
			void reader.cancel().catch(() => {});
			await file.close();
		}
		if (
			bytes < 1 ||
			(expected.size !== undefined && bytes !== expected.size) ||
			(expected.sha256 && hasher.digest("hex") !== expected.sha256) ||
			!(await matchesBinaryArchitecture(temp, expected.platform))
		)
			throw new Error("Binary integrity/architecture mismatch");
		deadline.signal.throwIfAborted();
		if (!options.allowFrozenSource && !context.isCurrent())
			throw new Error("Distribution source changed");
		await chmod(temp, 0o755).catch(() => {});
		await rename(temp, path);
		temp = undefined;
		deadline.signal.throwIfAborted();
		if (!options.allowFrozenSource && !context.isCurrent())
			throw new Error("Distribution source changed");
		return path;
	} finally {
		deadline.dispose();
		void reader?.cancel().catch(() => {});
		void response?.body?.cancel().catch(() => {});
		if (temp) await unlink(temp).catch(() => {});
	}
}
