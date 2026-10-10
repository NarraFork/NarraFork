/** Source-bound downloads for CLI helpers and the remote executor. */
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	HELPER_BINARY_MAX_BYTES,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	type HelperPlatform,
	type HelperSource,
	type HelperTool,
	helperSourceIdentity,
} from "../../shared/helper-distribution";
import { isWindowsPeFile, type WindowsPeArch } from "../../shared/windows-pe";
import {
	abortable,
	captureHelperSource,
	createDistributionContext,
	type DistributionContext,
	type DistributionFetch,
	distributionCancellationKey,
	distributionPath,
	downloadDistributionFile,
	getHelperManifest,
	verifyDistributionFile,
	withDeadline,
} from "./helper-distribution-runtime";
import { logger } from "./logger";
import { narraforkDir, settings } from "./settings";

export { captureHelperSource } from "./helper-distribution-runtime";
export const HELPER_BIN_DIR = join(narraforkDir, "bin");
const failures = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();
export interface HelperBinarySpec {
	toolName: string;
	cachedName: string;
	displayName: string;
	expectedSha256?: string;
	expectedSize?: number;
	windowsArch?: WindowsPeArch;
	tool?: HelperTool;
	platform?: HelperPlatform | string;
}
/** Legacy API only: source selection never calls this in GitHub mode. */
export function getHelperBinaryServerBaseUrl(): string {
	return (settings.update?.serverUrl || "https://narrafork-update.b.domexie.cn").replace(
		/\/+$/,
		"",
	);
}
/** Existence-only legacy API. Callers must verify a trusted digest before executing. */
export function getCachedHelperBinaryPath(
	cachedName: string,
	windowsArch?: WindowsPeArch,
): string | null {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cachedName) || cachedName.includes("..")) return null;
	const path = join(HELPER_BIN_DIR, cachedName);
	return existsSync(path) && (!windowsArch || isWindowsPeFile(path, windowsArch)) ? path : null;
}
export interface DownloadHelperBinaryOptions {
	useCache?: boolean;
	timeoutMs?: number;
	maxBytes?: number;
	allowUnsignedDownload?: boolean;
	bypassFailureCache?: boolean;
	source?: HelperSource;
	signal?: AbortSignal;
	fetcher?: DistributionFetch;
	/** A caller can freeze transport together with its parent update operation. */
	context?: DistributionContext;
	/** Executor tickets may retain their immutable chosen source after settings change. */
	allowFrozenSource?: boolean;
	/** Only executor distribution sets this; CLI helpers always use the fixed catalog tag. */
	tag?: string;
}
interface SelectedHelper {
	context: DistributionContext;
	name: string;
	tag: string;
	path: string;
	sha256?: string;
	size?: number;
	platform?: string;
}
async function selectHelper(
	spec: HelperBinarySpec,
	options: DownloadHelperBinaryOptions,
	signal: AbortSignal,
): Promise<SelectedHelper | null> {
	const context =
		options.context ??
		createDistributionContext(options.source ?? captureHelperSource(), options.fetcher);
	let platform = spec.platform ?? (spec.windowsArch ? `windows-${spec.windowsArch}` : undefined);
	let name = spec.toolName;
	let sha256 = spec.expectedSha256;
	let size = spec.expectedSize;
	const tag =
		options.tag ?? (context.source.source === "github" ? HELPER_RELEASE_TAG : "legacy-tools");
	let version = "legacy";
	if (context.source.source === "github" && !options.tag) {
		const manifest = await getHelperManifest(
			context,
			signal,
			`${distributionCancellationKey(options.signal)}:${options.timeoutMs ?? 60_000}`,
		);
		const entry = manifest?.files.find(
			(entry) =>
				entry.name === spec.toolName &&
				(!spec.tool || entry.tool === spec.tool) &&
				(!platform || entry.platform === platform),
		);
		if (!entry) return null;
		name = entry.name;
		sha256 = entry.sha256;
		size = entry.size;
		platform = entry.platform;
		version = HELPER_TOOL_VERSIONS[entry.tool];
	} else if (options.tag) version = options.tag;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name) || name.includes("..")) return null;
	return {
		context,
		name,
		sha256,
		size,
		platform,
		tag,
		path:
			distributionPath(
				context.source,
				`${tag}\0${version}\0${platform ?? name}\0${name}\0${sha256 ?? "unsigned"}`,
			) + (name.endsWith(".exe") ? ".exe" : ""),
	};
}
async function verifiedCache(
	selected: SelectedHelper,
	spec: HelperBinarySpec,
	signal: AbortSignal,
): Promise<string | null> {
	if (await verifyDistributionFile(selected.path, selected, signal)) {
		await chmod(selected.path, 0o755).catch(() => {});
		return selected.path;
	}
	const legacy = getCachedHelperBinaryPath(spec.cachedName, spec.windowsArch);
	if (!legacy || !(await verifyDistributionFile(legacy, selected, signal))) return null;
	// Migrate only a byte-for-byte trusted match, and never remove the old file.
	await mkdir(join(HELPER_BIN_DIR, "distribution"), { recursive: true });
	const temp = `${selected.path}.${randomUUID()}.tmp`;
	try {
		await copyFile(legacy, temp, constants.COPYFILE_EXCL);
		if (!(await verifyDistributionFile(temp, selected, signal))) return null;
		await chmod(temp, 0o755).catch(() => {});
		signal.throwIfAborted();
		if (!selected.context.isCurrent()) return null;
		await rename(temp, selected.path);
		return selected.path;
	} finally {
		await unlink(temp).catch(() => {});
	}
}
export async function getVerifiedCachedHelperBinaryPath(
	spec: HelperBinarySpec,
	options: DownloadHelperBinaryOptions = {},
): Promise<string | null> {
	const deadline = withDeadline(options.signal, Math.min(options.timeoutMs ?? 60_000, 60_000));
	try {
		const selected = await selectHelper(spec, options, deadline.signal);
		if (!selected) return null;
		const path = await verifiedCache(selected, spec, deadline.signal);
		return options.allowFrozenSource || selected.context.isCurrent() ? path : null;
	} catch {
		options.signal?.throwIfAborted();
		return null;
	} finally {
		deadline.dispose();
	}
}
export function resetHelperBinaryDownloadCache(): void {
	failures.clear();
	inflight.clear();
}
export async function downloadHelperBinary(
	spec: HelperBinarySpec,
	options: DownloadHelperBinaryOptions = {},
): Promise<string | null> {
	const deadline = withDeadline(
		options.signal,
		Math.min(options.timeoutMs ?? 60_000, options.tag ? 120_000 : 60_000),
	);
	try {
		const selected = await selectHelper(spec, options, deadline.signal);
		if (!selected) return null;
		if (options.useCache !== false) {
			const cached = await verifiedCache(selected, spec, deadline.signal);
			if (cached && (options.allowFrozenSource || selected.context.isCurrent())) return cached;
		}
		const key = `${selected.context.key}\0${helperSourceIdentity(selected.context.source)}\0${selected.path}`;
		if (options.bypassFailureCache) failures.delete(key);
		else if ((failures.get(key) ?? 0) > Date.now()) return null;
		const inflightKey = `${key}\0${distributionCancellationKey(options.signal)}\0${options.timeoutMs ?? 60_000}\0${options.maxBytes ?? HELPER_BINARY_MAX_BYTES}\0${Boolean(options.allowFrozenSource)}`;
		const existing = inflight.get(inflightKey);
		if (existing) return await abortable(existing, deadline.signal);
		const pending = (async () => {
			try {
				return await downloadDistributionFile(
					selected.context,
					selected.tag,
					selected.name,
					selected.path,
					selected,
					{
						signal: deadline.signal,
						timeoutMs: Math.min(options.timeoutMs ?? 60_000, options.tag ? 120_000 : 60_000),
						maxBytes: Math.min(
							options.maxBytes ?? HELPER_BINARY_MAX_BYTES,
							HELPER_BINARY_MAX_BYTES,
						),
						allowUnsigned:
							selected.context.source.source === "update-server" &&
							(options.allowUnsignedDownload ?? true),
						allowFrozenSource: options.allowFrozenSource,
					},
				);
			} catch {
				options.signal?.throwIfAborted();
				if (selected.context.isCurrent() && selected.context.isTransportCurrent?.() !== false) {
					if (failures.size >= 128) failures.clear();
					failures.set(key, Date.now() + 60_000);
				}
				logger.debug("Helper binary unavailable", { toolName: selected.name });
				return null;
			}
		})();
		inflight.set(inflightKey, pending);
		try {
			return await pending;
		} finally {
			if (inflight.get(inflightKey) === pending) inflight.delete(inflightKey);
		}
	} catch {
		options.signal?.throwIfAborted();
		return null;
	} finally {
		deadline.dispose();
	}
}
