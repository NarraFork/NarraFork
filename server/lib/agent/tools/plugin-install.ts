import { lookup } from "node:dns/promises";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../db";
import { users } from "../../../db/schema";
import { getNarraforkPath } from "../../narrafork-home";
import { settings } from "../../settings";
import type { ToolDefinition, ToolResult } from "../types";

const MAX_INSTALL_PATH = 4_096;
const MAX_SOURCES = 200;
const SAFE_ARCHIVE_EXTENSIONS = new Set([".zip", ".nfplugin"]);
/** Max bytes accepted for a URL-downloaded plugin package (64 MiB). */
const MAX_PLUGIN_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** Per-request timeout for URL downloads. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Max manual redirect hops when following a download URL. */
const MAX_DOWNLOAD_REDIRECTS = 3;

type PluginInstallAction = "list_sources" | "list_installed" | "install" | "install_and_enable";

type PluginInstallArgs = {
	action: PluginInstallAction;
	path?: string;
	url?: string;
	pluginId?: string;
};

type PluginInstallManager = {
	readonly disabled?: boolean;
	isEnabled?(): boolean;
	install(source: string | Uint8Array): Promise<unknown> | unknown;
	enable(pluginId: string): Promise<unknown> | unknown;
	list?(): Promise<unknown[]> | unknown[];
};

/** Minimal fetch shape used for URL downloads (avoids bun's extra fetch props). */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Minimal DNS lookup shape used by the SSRF guard. */
type LookupLike = (
	hostname: string,
	options?: { all?: boolean },
) => Promise<Array<{ address: string; family: number }>>;

export interface PluginInstallToolDeps {
	manager?: PluginInstallManager;
	installRoots?: string[];
	isAdminUser?: (userId: string | null | undefined) => Promise<boolean> | boolean;
	pluginsEnabled?: (manager: PluginInstallManager) => boolean;
	/** Test seam: fetch implementation used for URL downloads. Defaults to global fetch. */
	fetchImpl?: FetchLike;
	/** Test seam: DNS lookup used by the SSRF guard. Defaults to node:dns/promises lookup. */
	lookupImpl?: LookupLike;
}

function defaultInstallRoots(): string[] {
	return [getNarraforkPath("plugin-imports")];
}

function defaultPluginsEnabled(manager: PluginInstallManager): boolean {
	const value = process.env.NF_PLUGINS_ENABLED ?? process.env.NARRAFORK_PLUGINS_ENABLED;
	if (value !== undefined) return value === "1" || value.toLowerCase() === "true";
	return (
		manager.isEnabled?.() ??
		(typeof manager.disabled === "boolean"
			? !manager.disabled
			: (settings.plugins?.enabled ?? true))
	);
}

async function defaultIsAdminUser(userId: string | null | undefined): Promise<boolean> {
	if (!userId) return false;
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	return user?.role === "admin";
}

function isContained(root: string, candidate: string): boolean {
	const remainder = relative(resolve(root), resolve(candidate));
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

function validateInstallPathInput(input: string): string | undefined {
	if (input.length < 1) return "path is required";
	if (input.length > MAX_INSTALL_PATH) return `path exceeds ${MAX_INSTALL_PATH} characters`;
	if (input.includes("\0")) return "path contains a NUL character";
	if (input.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
		return "path traversal is not allowed";
	}
	if (input.startsWith("//") || /^\\\\/.test(input)) return "network paths are not allowed";
	return undefined;
}

function resolveInstallPath(input: string, roots: string[]): string {
	const inputError = validateInstallPathInput(input);
	if (inputError) throw new Error(inputError);
	if (roots.length === 0) throw new Error("No plugin import root is configured");
	const root = resolve(roots[0]);
	const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
	if (!roots.some((allowed) => isContained(resolve(allowed), candidate))) {
		throw new Error("Plugin package path is outside the allowed import roots");
	}
	if (!SAFE_ARCHIVE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
		throw new Error("Plugin package must be a .nfplugin or .zip file");
	}
	return candidate;
}

async function listInstallSources(
	roots: string[],
): Promise<Array<{ name: string; path: string; size: number }>> {
	const sources: Array<{ name: string; path: string; size: number }> = [];
	for (const root of roots) {
		const resolvedRoot = resolve(root);
		let entries: string[];
		try {
			entries = await readdir(resolvedRoot);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (sources.length >= MAX_SOURCES) break;
			if (!SAFE_ARCHIVE_EXTENSIONS.has(extname(entry).toLowerCase())) continue;
			const full = join(resolvedRoot, entry);
			if (!isContained(resolvedRoot, full)) continue;
			try {
				const info = await stat(full);
				if (!info.isFile()) continue;
				sources.push({ name: basename(entry), path: entry, size: info.size });
			} catch {
				// Skip unreadable entries.
			}
		}
		if (sources.length >= MAX_SOURCES) break;
	}
	sources.sort((a, b) => a.name.localeCompare(b.name));
	return sources;
}

function sanitizeText(value: unknown, max = 1_000): string | undefined {
	if (typeof value !== "string") return undefined;
	return value
		.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
		.replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
		.slice(-max);
}

function sanitizeContribution(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const item = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of [
		"id",
		"fullId",
		"kind",
		"title",
		"topic",
		"entryPath",
		"stylePath",
		"entry",
		"style",
		"execution",
	]) {
		if (typeof item[key] === "string") result[key] = String(item[key]).slice(0, 500);
	}
	if (typeof item.allowBackground === "boolean") result.allowBackground = item.allowBackground;
	if (typeof item.hasSchema === "boolean") result.hasSchema = item.hasSchema;
	if (Array.isArray(item.surfaces)) {
		const surfaces = item.surfaces.filter(
			(surface): surface is string =>
				surface === "workspace" ||
				surface === "director" ||
				surface === "focus" ||
				surface === "settings",
		);
		if (surfaces.length > 0) result.surfaces = surfaces;
	}
	return result;
}

function sanitizeDiagnostic(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { code: "UNKNOWN", message: "Unknown plugin diagnostic" };
	}
	const item = value as Record<string, unknown>;
	const result: Record<string, unknown> = {
		code: typeof item.code === "string" ? item.code.slice(0, 128) : "UNKNOWN",
		message: sanitizeText(item.message) ?? "Plugin diagnostic",
	};
	if (typeof item.phase === "string") result.phase = item.phase.slice(0, 64);
	return result;
}

function sanitizePluginSummary(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sanitizePluginSummary);
	const item = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of [
		"pluginId",
		"status",
		"desiredState",
		"runtimeState",
		"compatibility",
		"version",
		"hash",
		"isCurrent",
		"displayName",
		"description",
		"current",
		"crashCount",
		"restartCount",
		"consecutiveFailures",
		"runtimeGeneration",
	]) {
		if (item[key] === undefined) continue;
		if (key === "description") result[key] = sanitizeText(item[key], 500);
		else if (key === "current" && item[key] && typeof item[key] === "object") {
			const current = item[key] as Record<string, unknown>;
			result.current = {
				...(typeof current.version === "string" ? { version: current.version } : {}),
				...(typeof current.hash === "string" ? { hash: current.hash } : {}),
			};
		} else result[key] = item[key];
	}
	if (Array.isArray(item.contributions))
		result.contributions = item.contributions.map(sanitizeContribution);
	if (Array.isArray(item.diagnostics))
		result.diagnostics = item.diagnostics.map(sanitizeDiagnostic);
	if (typeof item.diagnosticCount === "number") result.diagnosticCount = item.diagnosticCount;
	if (item.lastError && typeof item.lastError === "object")
		result.lastError = sanitizeDiagnostic(item.lastError);
	if (item.stderr !== undefined) result.stderrSummary = sanitizeText(item.stderr);
	if (item.stderrSummary !== undefined) result.stderrSummary = sanitizeText(item.stderrSummary);
	return result;
}

function readPluginId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const direct = (value as Record<string, unknown>).pluginId;
	return typeof direct === "string" && direct.trim() ? direct : undefined;
}

function errorResult(message: string): ToolResult {
	return { output: message, isError: true, title: "PluginInstall failed" };
}

// ─── URL download safety (SSRF guard + size/time limits) ───

/** Whether a hostname is a bare IP literal (IPv4 dotted quad or IPv6). */
function isIpLiteral(hostname: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

/** Whether an IP literal is loopback, link-local, or a private/reserved range. */
export function isPrivateIp(ip: string): boolean {
	const value = ip.toLowerCase();
	// IPv4-mapped IPv6 (::ffff:1.2.3.4) — unwrap to the embedded IPv4.
	if (value.startsWith("::ffff:")) return isPrivateIpv4(value.slice("::ffff:".length));
	if (value === "::" || value === "::1" || value === "0.0.0.0") return true;
	if (value.includes(":")) {
		// IPv6: loopback ::1/128, link-local fe80::/10, unique-local fc00::/7.
		return (
			value === "::1" ||
			value.startsWith("fe80:") ||
			value.startsWith("fc") ||
			value.startsWith("fd")
		);
	}
	return isPrivateIpv4(value);
}

function isPrivateIpv4(ip: string): boolean {
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false; // Not an IP literal — caller falls back to DNS.
	const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
	const [a, b] = parts;
	if (!Number.isInteger(a) || !Number.isInteger(b) || parts.some((p) => p > 255)) return true; // Malformed — unsafe.
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	if (a === 0 || a >= 224) return true; // 0.0.0.0/8, multicast/reserved
	return false;
}

const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/\.localhost$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^0\./,
];

/** Reject URLs that could reach localhost / private networks (SSRF guard). */
export function assertPublicUrl(url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported download protocol: ${url.protocol.replace(/:$/, "")}`);
	}
	if (url.username || url.password) {
		throw new Error("Download URLs must not contain embedded credentials");
	}
	const hostname = normalizeHostname(url.hostname);
	if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
		throw new Error(`Download URL host is not public: ${hostname}`);
	}
	if (isIpLiteral(hostname) && isPrivateIp(hostname)) {
		throw new Error(`Download URL host is not public: ${hostname}`);
	}
}

/** Strip IPv6 brackets and lower-case a hostname for checks. */
function normalizeHostname(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Resolve a hostname and reject it when any A/AAA record is private. */
export async function assertPublicHost(
	hostname: string,
	options: { lookupImpl?: LookupLike } = {},
): Promise<void> {
	const normalized = normalizeHostname(hostname);
	if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(normalized))) return;
	if (isIpLiteral(normalized)) return; // IP literals were already checked in assertPublicUrl.
	const lookupImpl: LookupLike =
		options.lookupImpl ??
		((hostname: string, opts?: { all?: boolean }) => lookup(hostname, opts as { all: true }));
	let records: Array<{ address: string }>;
	try {
		records = await lookupImpl(normalized, { all: true });
	} catch {
		// DNS failure — let fetch surface the connection error instead of a raw lookup error.
		return;
	}
	if (records.some((record) => isPrivateIp(record.address))) {
		throw new Error(`Download URL host resolves to a private address: ${normalized}`);
	}
}

/** Origin + path only — never echoes query strings (may contain tokens). */
export function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "(invalid url)";
	}
}

async function readBodyWithLimit(response: Response): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const size = Number.parseInt(declared, 10);
		if (Number.isFinite(size) && size > MAX_PLUGIN_DOWNLOAD_BYTES) {
			throw new Error(
				`Plugin package download exceeds the ${Math.floor(MAX_PLUGIN_DOWNLOAD_BYTES / (1024 * 1024))} MiB limit`,
			);
		}
	}
	if (!response.body) {
		throw new Error("Plugin package download returned no body");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			if (total > MAX_PLUGIN_DOWNLOAD_BYTES) {
				await reader.cancel().catch(() => {});
				throw new Error(
					`Plugin package download exceeds the ${Math.floor(MAX_PLUGIN_DOWNLOAD_BYTES / (1024 * 1024))} MiB limit`,
				);
			}
			chunks.push(value);
		}
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

/**
 * Download a plugin package from a public URL with SSRF guard, redirect
 * re-validation, size cap, and a per-request timeout.
 */
export async function downloadPluginPackage(
	url: string,
	options: { fetchImpl?: FetchLike; lookupImpl?: LookupLike } = {},
): Promise<Uint8Array> {
	const fetchImpl = options.fetchImpl ?? fetch;
	let current = url;
	for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
		const parsed = new URL(current);
		assertPublicUrl(parsed);
		await assertPublicHost(parsed.hostname, { lookupImpl: options.lookupImpl });

		const response = await fetchImpl(current, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new Error(`Download redirect (${response.status}) has no Location header`);
			}
			current = new URL(location, current).toString();
			continue;
		}
		if (!response.ok) {
			throw new Error(`Plugin package download failed with HTTP ${response.status}`);
		}
		const bytes = await readBodyWithLimit(response);
		if (bytes.length === 0) throw new Error("Plugin package download returned an empty body");
		return bytes;
	}
	throw new Error(`Plugin package download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`);
}

/** Map of installed pluginId -> version snapshot for upgrade detection. */
async function installedVersionSnapshot(
	manager: PluginInstallManager,
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const installed = (await manager.list?.()) ?? [];
	for (const item of installed) {
		const pluginId = readPluginId(item);
		const version =
			item && typeof item === "object" && "version" in item && typeof item.version === "string"
				? item.version
				: undefined;
		if (pluginId && version) result.set(pluginId, version);
	}
	return result;
}

async function defaultManager(): Promise<PluginInstallManager> {
	const mod = await import("../../../services/plugin-manager");
	return mod.pluginManager;
}

export function createPluginInstallTool(deps: PluginInstallToolDeps = {}): ToolDefinition {
	return {
		name: "PluginInstall",
		description:
			"Install or update plugin packages (admin only, requires approval). action=list_sources lists .zip/.nfplugin files in the import directory; action=list_installed lists installed plugins with versions (use it to detect outdated plugins); action=install installs a package without enabling it; action=install_and_enable installs then enables it (required to resume an updated plugin after upgrade). The package source is either `path` (a file in the import directory) or `url` (downloads from a public http/https URL with SSRF/size protection). Installing a new version of an already-installed plugin upgrades it, keeping its authorizations; the updated plugin must be enabled again to run. Does not grant plugin permissions.",
		parameters: z.object({
			action: z
				.enum(["list_sources", "list_installed", "install", "install_and_enable"])
				.describe("The plugin installation action to perform."),
			path: z
				.string()
				.max(MAX_INSTALL_PATH)
				.optional()
				.describe(
					"Plugin archive path or filename under the plugin import directory. Mutually exclusive with url.",
				),
			url: z
				.string()
				.url()
				.max(2000)
				.optional()
				.describe(
					"Public http/https URL of a .zip/.nfplugin plugin package to download and install. Mutually exclusive with path.",
				),
			pluginId: z
				.string()
				.optional()
				.describe(
					"Optional plugin id to enable after install; if omitted, the installed status pluginId is used.",
				),
		}),
		async execute(args, ctx): Promise<ToolResult> {
			const input = args as PluginInstallArgs;
			const manager = deps.manager ?? (await defaultManager());
			const installRoots = deps.installRoots ?? defaultInstallRoots();
			const isAdminUser = deps.isAdminUser ?? defaultIsAdminUser;
			const pluginsEnabled = deps.pluginsEnabled ?? defaultPluginsEnabled;
			try {
				if (!pluginsEnabled(manager)) return errorResult("Plugin system is disabled.");

				if (input.action === "list_sources") {
					const sources = await listInstallSources(installRoots);
					return {
						output:
							sources.length === 0
								? "No installable plugin packages found in the plugin import directory."
								: JSON.stringify(sources, null, 2),
						title: "Plugin install sources",
						metadata: {
							tool: "PluginInstall",
							action: input.action,
							count: sources.length,
							sources,
						},
					};
				}

				if (input.action === "list_installed") {
					const installed = (await manager.list?.()) ?? [];
					const sanitized = installed.map(sanitizePluginSummary);
					return {
						output:
							sanitized.length === 0 ? "No plugins installed." : JSON.stringify(sanitized, null, 2),
						title: "Installed plugins",
						metadata: {
							tool: "PluginInstall",
							action: input.action,
							count: sanitized.length,
						},
					};
				}

				if (!(await isAdminUser(ctx.userId))) {
					return errorResult("Plugin lifecycle operations require an administrator.");
				}

				const hasPath = typeof input.path === "string" && input.path.length > 0;
				const hasUrl = typeof input.url === "string" && input.url.length > 0;
				if (hasPath && hasUrl) {
					return errorResult("Error: provide either 'path' or 'url', not both.");
				}
				if (!hasPath && !hasUrl) {
					return errorResult("Error: 'path' or 'url' is required for install actions.");
				}

				const before = await installedVersionSnapshot(manager);
				const source: string | Uint8Array = hasPath
					? resolveInstallPath(input.path as string, installRoots)
					: await downloadPluginPackage(input.url as string, {
							fetchImpl: deps.fetchImpl,
							lookupImpl: deps.lookupImpl,
						});

				const decision = await ctx.requestPermission(
					"PluginInstall",
					{
						action: input.action,
						...(hasPath ? { path: input.path, resolvedPath: source } : {}),
						...(hasUrl
							? { url: redactUrl(input.url as string), source: "url" as const }
							: { source: "path" as const }),
						...(input.pluginId ? { pluginId: input.pluginId } : {}),
						warning:
							input.action === "install_and_enable"
								? "This will install and enable a third-party plugin package. Enabling may start the plugin lifecycle. It will not grant plugin capabilities."
								: "This will install a third-party plugin package without enabling it. It will not grant plugin capabilities.",
					},
					ctx.currentToolUseId ?? "PluginInstall",
				);
				if (decision.behavior === "dangerReflection") {
					return errorResult("PluginInstall is waiting for danger reflection approval.");
				}
				if (decision.behavior !== "allow") {
					return errorResult(decision.message ?? "PluginInstall was denied by the user.");
				}

				const installed = await manager.install(source);
				const installedPluginId = readPluginId(installed);
				const previousVersion = installedPluginId ? before.get(installedPluginId) : undefined;
				const installedVersion =
					installed && typeof installed === "object" && "version" in installed
						? String(installed.version)
						: undefined;
				const upgraded =
					previousVersion !== undefined &&
					installedVersion !== undefined &&
					previousVersion !== installedVersion;
				if (input.action === "install") {
					const sanitized = sanitizePluginSummary(installed);
					return {
						output: JSON.stringify(sanitized, null, 2),
						title: upgraded ? "Plugin upgraded" : "Plugin installed",
						metadata: {
							tool: "PluginInstall",
							action: input.action,
							pluginId: installedPluginId,
							...(upgraded ? { upgraded: true, previousVersion, installedVersion } : {}),
						},
					};
				}

				const pluginId = input.pluginId ?? installedPluginId;
				if (!pluginId) {
					return errorResult(
						"Plugin was installed, but no pluginId was returned; enable was skipped.",
					);
				}
				const enabled = await manager.enable(pluginId);
				const sanitized = {
					installed: sanitizePluginSummary(installed),
					enabled: sanitizePluginSummary(enabled),
				};
				return {
					output: JSON.stringify(sanitized, null, 2),
					title: upgraded ? "Plugin upgraded and enabled" : "Plugin installed and enabled",
					metadata: {
						tool: "PluginInstall",
						action: input.action,
						pluginId,
						...(upgraded ? { upgraded: true, previousVersion, installedVersion } : {}),
					},
				};
			} catch (error) {
				return errorResult(
					`PluginInstall failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}

export const pluginInstallTool: ToolDefinition = createPluginInstallTool();
