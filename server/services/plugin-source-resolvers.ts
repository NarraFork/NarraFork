import {
	type GithubPluginSource,
	PLUGIN_UPDATE_MAX_METADATA_BYTES,
	type PluginSource,
	type PluginUpdateErrorCode,
	pluginSourceVersionSchema,
	pluginWebsiteUpdateResponseSchema,
	type ResolvedPluginRelease,
	type WebsitePluginSource,
} from "@shared/plugin-source";
import { z } from "zod";

/** A public request transport; the host injects its real proxy/TLS policy. */
export interface PluginSourceTransport {
	fetch(url: string, init?: RequestInit): Promise<Response>;
	isCurrent(): boolean;
}

const GITHUB_ORIGINS = new Set([
	"https://github.com",
	"https://api.github.com",
	"https://release-assets.githubusercontent.com",
	"https://objects.githubusercontent.com",
	"https://github-releases.githubusercontent.com",
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export class PluginSourceFailure extends Error {
	constructor(
		readonly code: PluginUpdateErrorCode,
		readonly retryAfterMs = 0,
	) {
		super(`Plugin source operation failed: ${code}`);
	}
}

export function sourceAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new PluginSourceFailure("cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Strict SemVer ordering; no coercion of tags or lexicographic version comparison. */
export function comparePluginVersions(left: string, right: string): number {
	const parse = (value: string) => {
		if (!pluginSourceVersionSchema.safeParse(value).success)
			throw new PluginSourceFailure("invalid_release");
		const version = value.split("+", 1)[0] ?? "";
		const dash = version.indexOf("-");
		const base = dash < 0 ? version : version.slice(0, dash);
		const pre = dash < 0 ? undefined : version.slice(dash + 1);
		const core = base.split(".").map((part) => BigInt(part));
		const prerelease = pre?.split(".") ?? [];
		if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
			throw new PluginSourceFailure("invalid_release");
		return { core, prerelease };
	};
	const a = parse(left);
	const b = parse(right);
	for (let i = 0; i < 3; i++) {
		const x = a.core[i];
		const y = b.core[i];
		if (x === undefined || y === undefined) throw new PluginSourceFailure("invalid_release");
		if (x !== y) return x > y ? 1 : -1;
	}
	if (!a.prerelease.length || !b.prerelease.length) {
		return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
	}
	for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
		const x = a.prerelease[i];
		const y = b.prerelease[i];
		if (x === y) continue;
		if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
		if (xn !== yn) return xn ? -1 : 1;
		return x > y ? 1 : -1;
	}
	return 0;
}

export interface PluginSourceEnvironment {
	hostVersion: string;
	hostApiVersion: string;
	os: string;
	arch: string;
}
export interface LocalSourceDescriptor {
	pluginId: string;
	version: string;
	displayName: string;
	description?: string;
	source: Extract<PluginSource, { type: "local" }>;
	load(signal?: AbortSignal): Promise<{ bytes: Uint8Array; sha256: string }>;
}
export interface PluginSourceResolverOptions {
	transport: PluginSourceTransport;
	signal: AbortSignal;
	environment: PluginSourceEnvironment;
	getBuiltin(id: string): LocalSourceDescriptor | undefined;
}

export function safeSourceUrl(raw: string, allowHttp = false): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new PluginSourceFailure("unsafe_url");
	}
	if (
		raw.length > 2_048 ||
		raw.includes("\\") ||
		[...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
		/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw) ||
		url.username ||
		url.password ||
		url.hash ||
		(url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
	)
		throw new PluginSourceFailure("unsafe_url");
	return url;
}

function retryAfter(response: Response): number {
	const header = response.headers.get("retry-after");
	const reset = response.headers.get("x-ratelimit-reset");
	const raw =
		header && /^\d+(?:\.\d+)?$/.test(header)
			? Number(header) * 1_000
			: header
				? Date.parse(header) - Date.now()
				: reset
					? Number(reset) * 1_000 - Date.now()
					: 60_000;
	return Number.isFinite(raw) ? Math.min(24 * 60 * 60_000, Math.max(10_000, raw)) : 60_000;
}

export async function fetchPluginSource(
	url: URL,
	origins: ReadonlySet<string>,
	options: Pick<PluginSourceResolverOptions, "transport" | "signal">,
	allowHttp = false,
): Promise<Response> {
	let current = url;
	for (let count = 0; count <= MAX_REDIRECTS; count++) {
		options.signal.throwIfAborted();
		if (!options.transport.isCurrent()) throw new PluginSourceFailure("source_changed");
		if (!origins.has(current.origin)) throw new PluginSourceFailure("unsafe_url");
		safeSourceUrl(current.toString(), allowHttp);
		const pendingResponse = options.transport.fetch(current.toString(), {
			method: "GET",
			redirect: "manual",
			credentials: "omit",
			signal: options.signal,
			headers: {
				Accept: "application/json, application/octet-stream;q=0.9",
				"User-Agent": "NarraFork-Plugin-Updates",
			},
		});
		void pendingResponse
			.then((late) => {
				if (options.signal.aborted) void late.body?.cancel().catch(() => {});
			})
			.catch(() => {});
		const response = await sourceAbortable(pendingResponse, options.signal);
		if (
			response.redirected ||
			(response.url && new URL(response.url).toString() !== current.toString())
		) {
			void response.body?.cancel().catch(() => {});
			throw new PluginSourceFailure("unsafe_url");
		}
		if (REDIRECTS.has(response.status)) {
			void response.body?.cancel().catch(() => {});
			const location = response.headers.get("location");
			if (!location || count === MAX_REDIRECTS) throw new PluginSourceFailure("unsafe_url");
			current = safeSourceUrl(new URL(location, current).toString(), allowHttp);
			continue;
		}
		if (
			response.status === 429 ||
			(response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
		) {
			void response.body?.cancel().catch(() => {});
			throw new PluginSourceFailure("rate_limited", retryAfter(response));
		}
		return response;
	}
	throw new PluginSourceFailure("unsafe_url");
}

/** Reads only a bounded UTF-8 metadata body; deadline includes an abort-ignoring stream. */
export async function readPluginSourceText(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	const declared = response.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > PLUGIN_UPDATE_MAX_METADATA_BYTES)
	) {
		void response.body?.cancel().catch(() => {});
		throw new PluginSourceFailure("invalid_release");
	}
	if (!response.ok || !response.body) {
		void response.body?.cancel().catch(() => {});
		throw new PluginSourceFailure(response.status === 404 ? "no_release" : "request_failed");
	}
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const chunk = await sourceAbortable(reader.read(), signal);
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > PLUGIN_UPDATE_MAX_METADATA_BYTES)
				throw new PluginSourceFailure("invalid_release");
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		throw error instanceof PluginSourceFailure ? error : new PluginSourceFailure("invalid_release");
	} finally {
		signal.removeEventListener("abort", cancel);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const text = await readPluginSourceText(response, signal);
	try {
		return JSON.parse(text);
	} catch {
		throw new PluginSourceFailure("invalid_release");
	}
}

export function sourceDownloadPolicy(
	source: PluginSource,
	url: string,
): { origins: ReadonlySet<string>; allowHttp: boolean } {
	if (source.type === "github") {
		const parsed = safeSourceUrl(url);
		if (!GITHUB_ORIGINS.has(parsed.origin)) throw new PluginSourceFailure("unsafe_url");
		return { origins: GITHUB_ORIGINS, allowHttp: false };
	}
	if (source.type !== "website") throw new PluginSourceFailure("invalid_source");
	const root = safeSourceUrl(source.updateApi, source.allowInsecureHttp);
	const origins = new Set([
		root.origin,
		...source.downloadOrigins.map(
			(origin) => safeSourceUrl(origin, source.allowInsecureHttp).origin,
		),
	]);
	const artifact = safeSourceUrl(url, source.allowInsecureHttp);
	if (!origins.has(artifact.origin)) throw new PluginSourceFailure("unsafe_url");
	return { origins, allowHttp: source.allowInsecureHttp };
}

export function sourceAllowsAutomaticUpdate(source: PluginSource): boolean {
	if (source.type !== "website") return true;
	try {
		return (
			safeSourceUrl(source.updateApi).protocol === "https:" &&
			source.downloadOrigins.every((origin) => safeSourceUrl(origin).protocol === "https:")
		);
	} catch {
		return false;
	}
}

async function resolveWebsite(
	pluginId: string,
	currentVersion: string,
	source: WebsitePluginSource,
	options: PluginSourceResolverOptions,
): Promise<ResolvedPluginRelease | null> {
	const url = safeSourceUrl(source.updateApi, source.allowInsecureHttp);
	for (const [key, value] of Object.entries({
		pluginId,
		currentVersion,
		...options.environment,
		channel: "stable",
	}))
		url.searchParams.set(key, value);
	const response = await fetchPluginSource(
		url,
		new Set([url.origin]),
		options,
		source.allowInsecureHttp,
	);
	const parsed = pluginWebsiteUpdateResponseSchema.safeParse(
		await readJson(response, options.signal),
	);
	if (!parsed.success) throw new PluginSourceFailure("invalid_release");
	if (parsed.data.pluginId !== pluginId) throw new PluginSourceFailure("identity_mismatch");
	const latest = parsed.data.latest;
	if (!latest) return null;
	comparePluginVersions(latest.version, latest.version);
	if (latest.version.split("+")[0]?.includes("-")) throw new PluginSourceFailure("invalid_release");
	sourceDownloadPolicy(source, latest.artifact.url);
	return {
		pluginId,
		version: latest.version,
		sha256: latest.artifact.sha256,
		size: latest.artifact.size,
		...(latest.publishedAt ? { publishedAt: latest.publishedAt } : {}),
		...(latest.notes ? { notes: latest.notes } : {}),
		...(latest.compatibility ? { compatibility: latest.compatibility } : {}),
		artifact: { type: "http", url: latest.artifact.url },
	};
}

const githubReleaseSchema = z
	.object({
		draft: z.boolean(),
		prerelease: z.boolean(),
		tag_name: z.string().max(256),
		published_at: z.string().nullable().optional(),
		assets: z
			.array(
				z
					.object({
						name: z.string().min(1).max(256),
						size: z.number().int().positive(),
						browser_download_url: z.string().max(2048),
						digest: z.string().max(128).nullable().optional(),
					})
					.passthrough(),
			)
			.max(128),
	})
	.passthrough();
function assetName(template: string, version: string): string {
	if (/[{}]/.test(template.replaceAll("{version}", "")))
		throw new PluginSourceFailure("invalid_source");
	return template.replaceAll("{version}", version);
}

async function resolveGithub(
	pluginId: string,
	currentVersion: string,
	source: GithubPluginSource,
	options: PluginSourceResolverOptions,
): Promise<ResolvedPluginRelease | null> {
	const url = new URL(
		`https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/releases/latest`,
	);
	const response = await fetchPluginSource(url, new Set([url.origin]), options);
	if (response.status === 404) {
		void response.body?.cancel().catch(() => {});
		return null;
	}
	const parsed = githubReleaseSchema.safeParse(await readJson(response, options.signal));
	if (!parsed.success) throw new PluginSourceFailure("invalid_release");
	const release = parsed.data;
	if (release.draft || release.prerelease) throw new PluginSourceFailure("no_release");
	const tag = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : release.tag_name;
	let version = pluginSourceVersionSchema.safeParse(tag).success ? tag : "";
	let metadata: ResolvedPluginRelease | null = null;
	if (source.metadataAsset) {
		const name = assetName(source.metadataAsset, version || currentVersion);
		const asset = release.assets.filter((item) => item.name === name);
		const metadataAsset = asset[0];
		if (asset.length !== 1 || !metadataAsset) throw new PluginSourceFailure("invalid_release");
		const metadataUrl = safeSourceUrl(metadataAsset.browser_download_url);
		if (!GITHUB_ORIGINS.has(metadataUrl.origin)) throw new PluginSourceFailure("unsafe_url");
		const raw = await readJson(
			await fetchPluginSource(metadataUrl, GITHUB_ORIGINS, options),
			options.signal,
		);
		const dto = pluginWebsiteUpdateResponseSchema.safeParse(raw);
		if (!dto.success || dto.data.pluginId !== pluginId || !dto.data.latest)
			throw new PluginSourceFailure("invalid_release");
		const latest = dto.data.latest;
		if (version && version !== latest.version) throw new PluginSourceFailure("identity_mismatch");
		version = latest.version;
		metadata = {
			pluginId,
			version,
			sha256: latest.artifact.sha256,
			size: latest.artifact.size,
			...(latest.compatibility ? { compatibility: latest.compatibility } : {}),
			...(latest.notes ? { notes: latest.notes } : {}),
			...(latest.publishedAt ? { publishedAt: latest.publishedAt } : {}),
			artifact: { type: "http", url: latest.artifact.url },
		};
	}
	if (!version || version.split("+")[0]?.includes("-"))
		throw new PluginSourceFailure("invalid_release");
	comparePluginVersions(version, version);
	const name = assetName(source.assetName, version);
	if (!name.endsWith(".nfplugin")) throw new PluginSourceFailure("invalid_source");
	const selected = release.assets.filter((asset) => asset.name === name);
	const asset = selected[0];
	if (selected.length !== 1 || !asset) throw new PluginSourceFailure("invalid_release");
	sourceDownloadPolicy(source, asset.browser_download_url);
	if (asset.size > 100 * 1024 * 1024) throw new PluginSourceFailure("invalid_release");
	let sha256 = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
	if (metadata) {
		if (
			metadata.artifact.type !== "http" ||
			metadata.artifact.url !== asset.browser_download_url ||
			metadata.size !== asset.size ||
			(sha256 && sha256 !== metadata.sha256)
		)
			throw new PluginSourceFailure("identity_mismatch");
		sha256 ??= metadata.sha256;
	}
	if (!sha256 && source.checksumAsset) {
		const checksumName = assetName(source.checksumAsset, version);
		const checksums = release.assets.filter((item) => item.name === checksumName);
		const checksumAsset = checksums[0];
		if (checksums.length !== 1 || !checksumAsset) throw new PluginSourceFailure("invalid_release");
		const checksumUrl = safeSourceUrl(checksumAsset.browser_download_url);
		if (!GITHUB_ORIGINS.has(checksumUrl.origin)) throw new PluginSourceFailure("unsafe_url");
		const text = await readPluginSourceText(
			await fetchPluginSource(checksumUrl, GITHUB_ORIGINS, options),
			options.signal,
		);
		const matches = text
			.split(/\r?\n/)
			.map((line) => line.match(/^([a-f0-9]{64})[ \t]+\*?(.+?)\s*$/i))
			.filter((row) => row?.[2] === name);
		if (matches.length !== 1) throw new PluginSourceFailure("invalid_release");
		sha256 = matches[0]?.[1]?.toLowerCase();
		if (!sha256) throw new PluginSourceFailure("invalid_release");
	}
	if (!sha256) throw new PluginSourceFailure("manual_required");
	const publishedAt =
		release.published_at && Number.isFinite(Date.parse(release.published_at))
			? new Date(release.published_at).toISOString()
			: undefined;
	return {
		pluginId,
		version,
		sha256,
		size: asset.size,
		...(publishedAt ? { publishedAt } : {}),
		...(metadata?.compatibility ? { compatibility: metadata.compatibility } : {}),
		...(metadata?.notes ? { notes: metadata.notes } : {}),
		artifact: { type: "http", url: asset.browser_download_url },
	};
}

export async function resolvePluginSourceRelease(
	pluginId: string,
	currentVersion: string,
	source: PluginSource,
	options: PluginSourceResolverOptions,
): Promise<ResolvedPluginRelease | null> {
	if (source.type === "website") return resolveWebsite(pluginId, currentVersion, source, options);
	if (source.type === "github") return resolveGithub(pluginId, currentVersion, source, options);
	const descriptor = options.getBuiltin(source.builtinId);
	if (!descriptor || descriptor.pluginId !== pluginId || source.builtinId !== pluginId)
		throw new PluginSourceFailure("local_missing");
	const loaded = await sourceAbortable(descriptor.load(options.signal), options.signal);
	if (
		!/^[a-f0-9]{64}$/.test(loaded.sha256) ||
		!loaded.bytes.byteLength ||
		loaded.bytes.byteLength > 100 * 1024 * 1024
	)
		throw new PluginSourceFailure("invalid_release");
	return {
		pluginId,
		version: descriptor.version,
		sha256: loaded.sha256,
		size: loaded.bytes.byteLength,
		artifact: { type: "local", builtinId: descriptor.pluginId },
	};
}

export function assertPluginReleaseCompatible(
	release: ResolvedPluginRelease,
	environment: PluginSourceEnvironment,
): void {
	const compatible = release.compatibility;
	if (
		(compatible?.os && !compatible.os.includes(environment.os as "win32")) ||
		(compatible?.arch && !compatible.arch.includes(environment.arch as "x64"))
	)
		throw new PluginSourceFailure("incompatible");
	if (compatible?.hostApi) {
		let satisfies = false;
		try {
			const version = /^\d+\.\d+$/.test(environment.hostApiVersion)
				? `${environment.hostApiVersion}.0`
				: environment.hostApiVersion;
			satisfies = Bun.semver.satisfies(version, compatible.hostApi);
		} catch {
			/* Invalid ranges fail closed. */
		}
		if (!satisfies) throw new PluginSourceFailure("incompatible");
	}
}
