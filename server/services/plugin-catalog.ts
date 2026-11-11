import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { formatZodError } from "../lib/errors";
import { getNarraforkPath } from "../lib/narrafork-home";
import { isInsidePath } from "../lib/platform-path";
import { type Manifest, safeParseManifest, type ViewSurface } from "../lib/plugins/manifest";
import { NARRAFORK_RPC_PROTOCOL } from "../lib/plugins/protocol";
import { compileThemeContribution } from "../lib/plugins/theme-compiler";
import {
	type CurrentPackagePointer,
	type CurrentPointerFile,
	pluginPackageHashPattern,
	pluginPackageVersionPattern,
	readPluginCurrentPointer,
} from "./plugin-package-store";

const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_FILES_PER_PACKAGE = 10_000;
const READ_TIMEOUT_MS = 10_000;
const HOST_API_VERSION = "1.0";

/**
 * Stable identity for a builtin package.
 *
 * A shipped package has no `<hash>` directory to quote. Deriving it from the manifest keeps the
 * shape the rest of the host expects (`version` + 64-hex `hash`) without inventing a second
 * identity scheme, and it changes exactly when the manifest does.
 */
/**
 * The "current" pointer for a builtin plugin: whatever its single shipped package is.
 * Builtin packages are not versioned by `current.json`, so the pointer is derived from the
 * package that was actually read.
 */
function builtinCurrentPointer(
	packages: PluginPackageSummary[],
): CurrentPackagePointer | undefined {
	const shipped = packages.find((item) => item.builtin);
	return shipped ? { version: shipped.version, hash: shipped.hash } : undefined;
}

function builtinPackageHash(manifest: Manifest): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export type PluginPackageStatus = "compatible" | "incompatible" | "corrupt" | "missing";
export type PluginStatus = PluginPackageStatus | "installed" | "empty";

export interface PluginDiagnostic {
	code: string;
	message: string;
	path?: string;
}

/** Host surfaces a plugin view may be mounted on. */
export type PluginViewSurface = ViewSurface;

export interface PluginContributionSummary {
	pluginId: string;
	version: string;
	hash: string;
	id: string;
	fullId: string;
	kind: "provider" | "tool" | "command" | "event" | "view" | "theme";
	/** Surfaces a view contribution may mount on; absent for non-view kinds. */
	surfaces?: PluginViewSurface[];
	title?: string;
	description?: string;
	topic?: string;
	/** Per-contribution UI asset paths; never fall back to manifest.ui for a view. */
	entryPath?: string;
	stylePath?: string;
	/** Legacy aliases retained for the existing UI route adapter. */
	entry?: string;
	style?: string;
	/** View binding scope used by the UI picker to choose a compatible host surface. */
	scope?: "workspace" | "narrator" | "project" | "global";
	/**
	 * Set when a view opts into the host's shared UI runtime, so the client's iframe shell
	 * knows to inject it before the view's entry. Absent for views that ship their own DOM.
	 */
	runtime?: "host-react";
	/** Tool metadata used by host-side registries and diagnostics. */
	inputSchema?: Readonly<Record<string, unknown>>;
	execution?: "server" | "ui";
	allowBackground?: boolean;
	/** Theme color scheme; only set for `kind === "theme"`. */
	colorScheme?: "light" | "dark" | "both";
	/**
	 * Compiled, sanitized CSS for a theme contribution (only for
	 * `kind === "theme"`). Built once here at catalog-refresh time so the API
	 * layer only reads a cached string. Empty when the tokens produced no safe
	 * declarations.
	 */
	themeCss?: string;
	hasSchema: boolean;
}

export interface PluginManifestSummary {
	schemaVersion: number;
	pluginId: string;
	version: string;
	displayName: string;
	description?: string;
	publisher?: { id?: string; name?: string };
	engine: Manifest["engine"];
	server?: { entry: string; protocol: string };
	ui?: { entry: string; style?: string };
	activationEvents: string[];
}

export interface PluginPackageSummary {
	pluginId: string;
	version: string;
	hash: string;
	path: string;
	status: PluginPackageStatus;
	isCurrent: boolean;
	/** Shipped with the application instead of installed into the package store. */
	builtin?: boolean;
	manifest?: PluginManifestSummary;
	contributions: PluginContributionSummary[];
	diagnostics: PluginDiagnostic[];
}

export interface PluginCatalogPlugin {
	pluginId: string;
	status: PluginStatus;
	current: CurrentPackagePointer | null;
	packages: PluginPackageSummary[];
	contributions: PluginContributionSummary[];
	diagnostics: PluginDiagnostic[];
	/** Shipped with the application instead of installed into the package store. */
	builtin?: boolean;
}

export interface PluginCatalogSnapshot {
	generatedAt: string;
	plugins: PluginCatalogPlugin[];
	packages: PluginPackageSummary[];
	diagnostics: PluginDiagnostic[];
}

export interface PluginCatalogOptions {
	root?: string;
	/**
	 * Package directories that ship with the application. Each is read with the same package
	 * reader as an installed package; only the directory layout differs (a builtin package is
	 * its own manifest root rather than `<store>/<id>/<version>/<hash>`).
	 */
	builtinRoots?: readonly string[];
	maxManifestBytes?: number;
	maxFilesPerPackage?: number;
	timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function diagnostic(code: string, message: string, path?: string): PluginDiagnostic {
	return path ? { code, message, path } : { code, message };
}

function packageSort(a: { pluginId: string; version: string; hash: string }, b: typeof a): number {
	return (
		a.pluginId.localeCompare(b.pluginId) ||
		a.version.localeCompare(b.version) ||
		a.hash.localeCompare(b.hash)
	);
}

function contributionSort(a: PluginContributionSummary, b: PluginContributionSummary): number {
	return a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind);
}

function toManifestSummary(manifest: Manifest): PluginManifestSummary {
	return {
		schemaVersion: manifest.schemaVersion,
		pluginId: manifest.pluginId,
		version: manifest.version,
		displayName: manifest.displayName,
		description: manifest.description,
		publisher: manifest.publisher
			? { id: manifest.publisher.id, name: manifest.publisher.name }
			: undefined,
		engine: manifest.engine,
		server: manifest.server
			? { entry: manifest.server.entry, protocol: manifest.server.protocol }
			: undefined,
		ui: manifest.ui ? { entry: manifest.ui.entry, style: manifest.ui.style } : undefined,
		activationEvents: [...manifest.activationEvents],
	};
}

function contributionSummaries(
	manifest: Manifest,
	version: string,
	hash: string,
): PluginContributionSummary[] {
	const result: PluginContributionSummary[] = [];
	const add = (
		kind: PluginContributionSummary["kind"],
		items: Array<Record<string, unknown>>,
	): void => {
		for (const item of items) {
			const id = String(item.id);
			const title = typeof item.title === "string" ? item.title : undefined;
			const description =
				typeof item.description === "string" ? item.description.slice(0, 500) : undefined;
			const topic = typeof item.topic === "string" ? item.topic : undefined;
			const entryPath = typeof item.entry === "string" ? item.entry : undefined;
			const stylePath = typeof item.style === "string" ? item.style : undefined;
			const inputSchema =
				item.inputSchema && typeof item.inputSchema === "object" && !Array.isArray(item.inputSchema)
					? (structuredClone(item.inputSchema) as Record<string, unknown>)
					: undefined;
			const execution =
				item.execution === "server" || item.execution === "ui" ? item.execution : undefined;
			const allowBackground =
				typeof item.allowBackground === "boolean" ? item.allowBackground : undefined;
			// Surfaces decide where a view may mount. The host needs them to filter views per
			// surface; the session route re-checks them, so this is a routing hint rather than
			// an authorization decision. `manifest` is already schema-validated here, so the
			// names are known-good and only the array shape needs narrowing for the type.
			// An empty list is passed on as-is: it is what a view that only declared the
			// retired `graph` surface parses to, and it must reach the client as "mounts
			// nowhere" — an absent list reads as "no restriction".
			const surfaces =
				kind === "view" && Array.isArray(item.surfaces)
					? (item.surfaces as PluginViewSurface[])
					: undefined;
			const scope =
				kind === "view" &&
				(item.scope === "workspace" ||
					item.scope === "narrator" ||
					item.scope === "project" ||
					item.scope === "global")
					? item.scope
					: undefined;
			// Opt-in shared UI runtime. Narrowed to the one known literal rather than passed
			// through, for the same reason `surfaces` is: the client acts on this value.
			const runtime = kind === "view" && item.runtime === "host-react" ? item.runtime : undefined;
			const hasSchema =
				inputSchema !== undefined ||
				(typeof item.configSchema === "object" && item.configSchema !== null) ||
				(typeof item.filter === "object" && item.filter !== null);
			result.push({
				pluginId: manifest.pluginId,
				version,
				hash,
				id,
				fullId: `${manifest.pluginId}/${id}`,
				kind,
				title,
				description,
				topic,
				...(entryPath ? { entryPath, entry: entryPath } : {}),
				...(stylePath ? { stylePath, style: stylePath } : {}),
				...(scope ? { scope } : {}),
				...(runtime ? { runtime } : {}),
				...(surfaces ? { surfaces } : {}),
				...(inputSchema ? { inputSchema } : {}),
				...(execution ? { execution } : {}),
				...(allowBackground === undefined ? {} : { allowBackground }),
				hasSchema,
			});
		}
	};
	add("provider", manifest.contributes.providers as unknown as Array<Record<string, unknown>>);
	add("tool", manifest.contributes.tools as unknown as Array<Record<string, unknown>>);
	add("command", manifest.contributes.commands as unknown as Array<Record<string, unknown>>);
	add("event", manifest.contributes.events as unknown as Array<Record<string, unknown>>);
	add("view", manifest.contributes.views as unknown as Array<Record<string, unknown>>);
	// Themes carry compiled CSS instead of asset paths; build it once here so the
	// API layer only reads a cached, sanitized string (never on a request path).
	for (const theme of manifest.contributes.themes) {
		const themeCss = compileThemeContribution(theme, manifest.pluginId, { version, hash });
		result.push({
			pluginId: manifest.pluginId,
			version,
			hash,
			id: theme.id,
			fullId: `${manifest.pluginId}/${theme.id}`,
			kind: "theme",
			title: theme.title,
			colorScheme: theme.colorScheme,
			themeCss,
			hasSchema: false,
		});
	}
	return result.sort(contributionSort);
}

function parseVersionPart(value: string): number[] | undefined {
	const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersion(a: number[], b: number[]): number {
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

function hostApiCompatible(range: string): boolean {
	const host = parseVersionPart(HOST_API_VERSION);
	if (!host) return false;
	const clauses = range.trim().split(/\s+/).filter(Boolean);
	if (clauses.length === 0) return false;
	for (const clause of clauses) {
		if (clause === "*" || clause.toLowerCase() === "x") continue;
		const operatorMatch = /^(>=|<=|>|<|=|\^|~)?\s*(\d+(?:\.\d+)?(?:\.\d+)?)$/.exec(clause);
		if (!operatorMatch) return false;
		const version = parseVersionPart(operatorMatch[2]);
		if (!version) return false;
		const operator = operatorMatch[1] ?? "=";
		const comparison = compareVersion(host, version);
		if (operator === ">=" && comparison < 0) return false;
		if (operator === ">" && comparison <= 0) return false;
		if (operator === "<" && comparison >= 0) return false;
		if (operator === "<=" && comparison > 0) return false;
		if (operator === "=" && comparison !== 0) return false;
		if (operator === "^" && (host[0] !== version[0] || comparison < 0)) return false;
		if (operator === "~" && (host[0] !== version[0] || host[1] !== version[1] || comparison < 0))
			return false;
	}
	return true;
}

function compatibilityDiagnostics(manifest: Manifest): PluginDiagnostic[] {
	const diagnostics: PluginDiagnostic[] = [];
	if (
		manifest.engine.os?.length &&
		!manifest.engine.os.includes(process.platform as "linux" | "darwin" | "win32")
	) {
		diagnostics.push(
			diagnostic("INCOMPATIBLE_PLATFORM", `Plugin does not support ${process.platform}`),
		);
	}
	if (
		manifest.engine.arch?.length &&
		!manifest.engine.arch.includes(process.arch as "x64" | "arm64" | "ia32")
	) {
		diagnostics.push(diagnostic("INCOMPATIBLE_ARCH", `Plugin does not support ${process.arch}`));
	}
	if (manifest.engine.rpc !== NARRAFORK_RPC_PROTOCOL) {
		diagnostics.push(
			diagnostic(
				"INCOMPATIBLE_RPC",
				`Plugin requires ${manifest.engine.rpc}; host supports ${NARRAFORK_RPC_PROTOCOL}`,
			),
		);
	}
	if (manifest.server && manifest.server.protocol !== manifest.engine.rpc) {
		diagnostics.push(
			diagnostic("MANIFEST_PROTOCOL_MISMATCH", "server.protocol does not match engine.rpc"),
		);
	}
	if (!hostApiCompatible(manifest.engine.hostApi)) {
		diagnostics.push(
			diagnostic(
				"INCOMPATIBLE_HOST_API",
				`Plugin requires unsupported Host API range ${manifest.engine.hostApi}`,
			),
		);
	}
	return diagnostics;
}

async function readRegularFile(path: string, timeoutMs: number): Promise<boolean> {
	try {
		const info = await withTimeout(lstat(path), timeoutMs, "package entry stat");
		return info.isFile();
	} catch {
		return false;
	}
}

export class PluginCatalog {
	readonly root: string;
	readonly packagesPath: string;
	readonly currentPath: string;
	readonly builtinRoots: readonly string[];
	readonly maxManifestBytes: number;
	readonly maxFilesPerPackage: number;
	readonly timeoutMs: number;

	constructor(rootOrOptions: string | PluginCatalogOptions = {}) {
		const options = typeof rootOrOptions === "string" ? { root: rootOrOptions } : rootOrOptions;
		this.root = options.root ? resolve(options.root) : getNarraforkPath("plugins");
		this.packagesPath = join(this.root, "packages");
		this.currentPath = join(this.root, "current.json");
		this.builtinRoots = (options.builtinRoots ?? []).map((entry) => resolve(entry));
		this.maxManifestBytes = options.maxManifestBytes ?? MAX_MANIFEST_BYTES;
		this.maxFilesPerPackage = options.maxFilesPerPackage ?? MAX_FILES_PER_PACKAGE;
		this.timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
	}

	async scan(): Promise<PluginCatalogSnapshot> {
		const snapshotDiagnostics: PluginDiagnostic[] = [];
		let current: CurrentPointerFile;
		try {
			current = await readPluginCurrentPointer(this.root);
		} catch (error) {
			current = { version: 1, plugins: {} };
			snapshotDiagnostics.push(
				diagnostic(
					"CURRENT_POINTER_CORRUPT",
					error instanceof Error ? error.message : "current.json is invalid",
					this.currentPath,
				),
			);
		}
		const packageSummaries: PluginPackageSummary[] = [];
		const pluginDiagnostics = new Map<string, PluginDiagnostic[]>();
		const packagePluginIds = new Set<string>();
		let pluginDirectories: import("node:fs").Dirent[] = [];
		try {
			pluginDirectories = await withTimeout(
				readdir(this.packagesPath, { withFileTypes: true }),
				this.timeoutMs,
				"plugin package directory scan",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				snapshotDiagnostics.push(
					diagnostic(
						"PACKAGES_SCAN_FAILED",
						error instanceof Error ? error.message : String(error),
						this.packagesPath,
					),
				);
			}
		}

		for (const pluginDirectory of pluginDirectories) {
			if (!pluginDirectory.isDirectory() || pluginDirectory.isSymbolicLink()) {
				snapshotDiagnostics.push(
					diagnostic(
						"PACKAGE_PLUGIN_ENTRY_IGNORED",
						`Ignored non-directory package entry ${pluginDirectory.name}`,
						join(this.packagesPath, pluginDirectory.name),
					),
				);
				continue;
			}
			const pluginId = pluginDirectory.name;
			packagePluginIds.add(pluginId);
			const currentPointer = current.plugins[pluginId];
			const packagesForPlugin = await this.scanPluginPackages(pluginId, currentPointer);
			for (const summary of packagesForPlugin) {
				packageSummaries.push(summary);
				if (summary.diagnostics.length) {
					pluginDiagnostics.set(pluginId, [
						...(pluginDiagnostics.get(pluginId) ?? []),
						...summary.diagnostics,
					]);
				}
			}
			if (
				currentPointer &&
				!packagesForPlugin.some(
					(item) => item.version === currentPointer.version && item.hash === currentPointer.hash,
				)
			) {
				const missing = this.missingPackageSummary(pluginId, currentPointer);
				packageSummaries.push(missing);
				pluginDiagnostics.set(pluginId, [
					...(pluginDiagnostics.get(pluginId) ?? []),
					...missing.diagnostics,
				]);
			}
		}

		for (const [pluginId, pointer] of Object.entries(current.plugins)) {
			if (packagePluginIds.has(pluginId)) continue;
			const missing = this.missingPackageSummary(pluginId, pointer);
			packageSummaries.push(missing);
			pluginDiagnostics.set(pluginId, [
				diagnostic(
					"CURRENT_PACKAGE_MISSING",
					`Current package ${pointer.version}/${pointer.hash} is missing`,
					this.packagePath(pluginId, pointer),
				),
			]);
		}
		// Builtin packages ship with the application, so they are read the same way but are
		// never recorded in `current.json` — they are always current by construction.
		const builtinPackageIds = new Set<string>();
		for (const builtinRoot of this.builtinRoots) {
			const summary = await this.scanBuiltinPackage(builtinRoot);
			if (!summary) continue;
			packageSummaries.push(summary);
			builtinPackageIds.add(summary.pluginId);
			packagePluginIds.add(summary.pluginId);
			if (summary.diagnostics.length) {
				pluginDiagnostics.set(summary.pluginId, [
					...(pluginDiagnostics.get(summary.pluginId) ?? []),
					...summary.diagnostics,
				]);
			}
		}
		packageSummaries.sort(packageSort);

		const pluginIds = new Set([...packagePluginIds, ...Object.keys(current.plugins)]);
		const plugins: PluginCatalogPlugin[] = [...pluginIds].sort().map((pluginId) => {
			const packages = packageSummaries
				.filter((item) => item.pluginId === pluginId)
				.sort(packageSort);
			const builtin = builtinPackageIds.has(pluginId);
			const currentPointer: CurrentPackagePointer | null = builtin
				? (builtinCurrentPointer(packages) ?? null)
				: (current.plugins[pluginId] ?? null);
			const currentPackage = currentPointer
				? packages.find(
						(item) => item.version === currentPointer.version && item.hash === currentPointer.hash,
					)
				: undefined;
			const contributions = (
				currentPackage?.contributions ??
				packages.find((item) => item.status === "compatible")?.contributions ??
				[]
			).sort(contributionSort);
			const diagnostics = [...(pluginDiagnostics.get(pluginId) ?? [])];
			const status: PluginStatus =
				currentPackage?.status ?? (packages.length ? "installed" : "missing");
			return {
				pluginId,
				status,
				current: currentPointer,
				packages,
				contributions,
				diagnostics,
				builtin: builtin || undefined,
			};
		});
		return {
			generatedAt: new Date().toISOString(),
			plugins,
			packages: packageSummaries,
			diagnostics: snapshotDiagnostics,
		};
	}

	list(): Promise<PluginCatalogSnapshot> {
		return this.scan();
	}

	getSnapshot(): Promise<PluginCatalogSnapshot> {
		return this.scan();
	}

	private missingPackageSummary(
		pluginId: string,
		pointer: CurrentPackagePointer,
	): PluginPackageSummary {
		return {
			pluginId,
			version: pointer.version,
			hash: pointer.hash,
			path: this.packagePath(pluginId, pointer),
			status: "missing",
			isCurrent: true,
			contributions: [],
			diagnostics: [diagnostic("CURRENT_PACKAGE_MISSING", "Current package directory is missing")],
		};
	}

	private packagePath(pluginId: string, pointer: CurrentPackagePointer): string {
		return join(this.packagesPath, pluginId, pointer.version, pointer.hash);
	}

	private async scanPluginPackages(
		pluginId: string,
		current: CurrentPackagePointer | undefined,
	): Promise<PluginPackageSummary[]> {
		const pluginPath = join(this.packagesPath, pluginId);
		const summaries: PluginPackageSummary[] = [];
		let versionDirectories: import("node:fs").Dirent[] = [];
		try {
			versionDirectories = await withTimeout(
				readdir(pluginPath, { withFileTypes: true }),
				this.timeoutMs,
				"plugin version scan",
			);
		} catch (error) {
			return [
				{
					pluginId,
					version: "0.0.0",
					hash: "0".repeat(64),
					path: pluginPath,
					status: "corrupt",
					isCurrent: false,
					contributions: [],
					diagnostics: [
						diagnostic(
							"PLUGIN_SCAN_FAILED",
							error instanceof Error ? error.message : String(error),
							pluginPath,
						),
					],
				},
			];
		}
		for (const versionDirectory of versionDirectories) {
			if (!versionDirectory.isDirectory() || versionDirectory.isSymbolicLink()) {
				summaries.push({
					pluginId,
					version: versionDirectory.name,
					hash: "0".repeat(64),
					path: join(pluginPath, versionDirectory.name),
					status: "corrupt",
					isCurrent: false,
					contributions: [],
					diagnostics: [
						diagnostic(
							"PACKAGE_VERSION_ENTRY_INVALID",
							"Version directory is not a real directory",
							join(pluginPath, versionDirectory.name),
						),
					],
				});
				continue;
			}
			if (!pluginPackageVersionPattern.test(versionDirectory.name)) {
				summaries.push({
					pluginId,
					version: versionDirectory.name,
					hash: "0".repeat(64),
					path: join(pluginPath, versionDirectory.name),
					status: "corrupt",
					isCurrent: false,
					contributions: [],
					diagnostics: [
						diagnostic(
							"PACKAGE_VERSION_INVALID",
							"Package version directory is not SemVer",
							join(pluginPath, versionDirectory.name),
						),
					],
				});
				continue;
			}
			let hashDirectories: import("node:fs").Dirent[] = [];
			try {
				hashDirectories = await withTimeout(
					readdir(join(pluginPath, versionDirectory.name), { withFileTypes: true }),
					this.timeoutMs,
					"plugin hash scan",
				);
			} catch (error) {
				summaries.push({
					pluginId,
					version: versionDirectory.name,
					hash: "0".repeat(64),
					path: join(pluginPath, versionDirectory.name),
					status: "corrupt",
					isCurrent: false,
					contributions: [],
					diagnostics: [
						diagnostic(
							"PACKAGE_HASH_SCAN_FAILED",
							error instanceof Error ? error.message : String(error),
							join(pluginPath, versionDirectory.name),
						),
					],
				});
				continue;
			}
			for (const hashDirectory of hashDirectories) {
				if (
					!hashDirectory.isDirectory() ||
					hashDirectory.isSymbolicLink() ||
					!pluginPackageHashPattern.test(hashDirectory.name)
				) {
					summaries.push({
						pluginId,
						version: versionDirectory.name,
						hash: hashDirectory.name,
						path: join(pluginPath, versionDirectory.name, hashDirectory.name),
						status: "corrupt",
						isCurrent: false,
						contributions: [],
						diagnostics: [
							diagnostic(
								"PACKAGE_HASH_INVALID",
								"Package hash directory is invalid",
								join(pluginPath, versionDirectory.name, hashDirectory.name),
							),
						],
					});
					continue;
				}
				summaries.push(
					await this.scanPackage(pluginId, versionDirectory.name, hashDirectory.name, current),
				);
			}
		}
		return summaries.sort(packageSort);
	}

	private async scanPackage(
		pluginId: string,
		version: string,
		hash: string,
		current: CurrentPackagePointer | undefined,
		location?: { packagePath: string; resolutionRoot: string; builtin: true },
	): Promise<PluginPackageSummary> {
		const packagePath = location?.packagePath ?? join(this.packagesPath, pluginId, version, hash);
		const resolutionRoot = location?.resolutionRoot ?? this.packagesPath;
		const isCurrent = location ? true : current?.version === version && current.hash === hash;
		const diagnostics: PluginDiagnostic[] = [];
		const base: PluginPackageSummary = {
			pluginId,
			version,
			hash,
			path: packagePath,
			status: "corrupt",
			isCurrent,
			builtin: location?.builtin,
			contributions: [],
			diagnostics,
		};
		try {
			const packageRealPath = await withTimeout(
				realpath(packagePath),
				this.timeoutMs,
				"package realpath",
			);
			if (!isInsidePath(resolutionRoot, packageRealPath)) {
				diagnostics.push(
					diagnostic(
						"PACKAGE_PATH_ESCAPE",
						"Package real path escapes the package store",
						packagePath,
					),
				);
				return base;
			}
			const manifestPath = join(packagePath, "manifest.json");
			const manifestInfo = await withTimeout(lstat(manifestPath), this.timeoutMs, "manifest stat");
			if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
				diagnostics.push(
					diagnostic(
						"MANIFEST_MISSING",
						"manifest.json is missing or not a regular file",
						manifestPath,
					),
				);
				return base;
			}
			if (manifestInfo.size > this.maxManifestBytes) {
				diagnostics.push(
					diagnostic("MANIFEST_TOO_LARGE", "manifest.json exceeds the size limit", manifestPath),
				);
				return base;
			}
			const manifestRealPath = await withTimeout(
				realpath(manifestPath),
				this.timeoutMs,
				"manifest realpath",
			);
			if (!isInsidePath(packageRealPath, manifestRealPath)) {
				diagnostics.push(
					diagnostic(
						"MANIFEST_PATH_ESCAPE",
						"manifest.json escapes the package directory",
						manifestPath,
					),
				);
				return base;
			}
			const manifestBytes = await withTimeout(
				readFile(manifestPath),
				this.timeoutMs,
				"manifest read",
			);
			if (manifestBytes.byteLength > this.maxManifestBytes) {
				diagnostics.push(
					diagnostic("MANIFEST_TOO_LARGE", "manifest.json exceeds the size limit", manifestPath),
				);
				return base;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
			} catch {
				diagnostics.push(
					diagnostic("MANIFEST_INVALID_JSON", "manifest.json is not valid JSON", manifestPath),
				);
				return base;
			}
			const parsed = safeParseManifest(raw);
			if (!parsed.success) {
				diagnostics.push(
					diagnostic("MANIFEST_INVALID", formatZodError(parsed.error), manifestPath),
				);
				return base;
			}
			const manifest = parsed.data;
			if (manifest.pluginId !== pluginId || manifest.version !== version) {
				diagnostics.push(
					diagnostic(
						"MANIFEST_ID_MISMATCH",
						"Manifest identity does not match its package path",
						manifestPath,
					),
				);
				return base;
			}
			const declaredEntries = [
				manifest.server?.entry,
				manifest.ui?.entry,
				manifest.ui?.style,
				...manifest.contributes.views.flatMap((view) => [view.entry, view.style]),
			].filter(
				(value, index, values): value is string =>
					Boolean(value) && values.indexOf(value) === index,
			);
			for (const entry of declaredEntries) {
				const entryPath = join(packagePath, ...entry.split("/"));
				if (!(await readRegularFile(entryPath, this.timeoutMs))) {
					diagnostics.push(
						diagnostic("ENTRY_MISSING", `Package entry is missing: ${entry}`, entryPath),
					);
				}
				const entryRealPath = await realpath(entryPath).catch(() => null);
				if (entryRealPath && !isInsidePath(packageRealPath, entryRealPath)) {
					diagnostics.push(
						diagnostic("ENTRY_PATH_ESCAPE", `Package entry escapes its root: ${entry}`, entryPath),
					);
				}
			}
			const packageFiles = await this.inspectPackageEntries(packagePath, packageRealPath);
			if (packageFiles.length > this.maxFilesPerPackage) {
				diagnostics.push(
					diagnostic(
						"PACKAGE_TOO_MANY_FILES",
						`Package contains more than ${this.maxFilesPerPackage} files`,
						packagePath,
					),
				);
			}
			const compatibility = compatibilityDiagnostics(manifest);
			diagnostics.push(...compatibility);
			base.manifest = toManifestSummary(manifest);
			base.contributions = contributionSummaries(manifest, version, hash);
			base.status = diagnostics.some((item) => item.code.startsWith("INCOMPATIBLE_"))
				? "incompatible"
				: diagnostics.length
					? "corrupt"
					: "compatible";
			return base;
		} catch (error) {
			diagnostics.push(
				diagnostic(
					"PACKAGE_SCAN_FAILED",
					error instanceof Error ? error.message : String(error),
					packagePath,
				),
			);
			return base;
		}
	}

	/**
	 * Read one builtin package through the installed-package reader.
	 *
	 * A builtin package is its own manifest root, so its identity and version come from the
	 * manifest rather than from a `<id>/<version>/<hash>` path. Every other rule — size caps,
	 * JSON parsing, schema validation, entry existence, compatibility, symlink and escape
	 * checks — is the store reader's, so a broken builtin manifest fails the same way an
	 * installed one would.
	 */
	private async scanBuiltinPackage(root: string): Promise<PluginPackageSummary | undefined> {
		let realRoot: string;
		let manifest: Manifest;
		try {
			realRoot = await withTimeout(realpath(root), this.timeoutMs, "builtin realpath");
			const manifestPath = join(realRoot, "manifest.json");
			const manifestInfo = await withTimeout(lstat(manifestPath), this.timeoutMs, "manifest stat");
			if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) return undefined;
			if (manifestInfo.size > this.maxManifestBytes) {
				return {
					pluginId: relative(this.builtinBase(), realRoot).split(sep).join("/"),
					version: "0.0.0",
					hash: "0".repeat(64),
					path: realRoot,
					status: "corrupt",
					isCurrent: true,
					builtin: true,
					contributions: [],
					diagnostics: [
						diagnostic("MANIFEST_TOO_LARGE", "manifest.json exceeds the size limit", manifestPath),
					],
				};
			}
			const manifestBytes = await withTimeout(
				readFile(manifestPath),
				this.timeoutMs,
				"manifest read",
			);
			const raw: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
			const parsed = safeParseManifest(raw);
			if (!parsed.success) {
				return {
					pluginId: relative(this.builtinBase(), realRoot).split(sep).join("/"),
					version: "0.0.0",
					hash: "0".repeat(64),
					path: realRoot,
					status: "corrupt",
					isCurrent: true,
					builtin: true,
					contributions: [],
					diagnostics: [diagnostic("MANIFEST_INVALID", formatZodError(parsed.error), manifestPath)],
				};
			}
			manifest = parsed.data;
		} catch {
			return undefined;
		}
		return this.scanPackage(
			manifest.pluginId,
			manifest.version,
			builtinPackageHash(manifest),
			undefined,
			{
				packagePath: realRoot,
				resolutionRoot: realRoot,
				builtin: true,
			},
		);
	}

	/** Parent directory the builtin roots live in, used only to name an unreadable package. */
	private builtinBase(): string {
		return this.builtinRoots.length > 0 ? dirname(this.builtinRoots[0] as string) : this.root;
	}

	private async inspectPackageEntries(
		packagePath: string,
		packageRealPath: string,
	): Promise<string[]> {
		const files: string[] = [];
		const walk = async (directory: string): Promise<void> => {
			const entries = await withTimeout(
				readdir(directory, { withFileTypes: true }),
				this.timeoutMs,
				"package file scan",
			);
			for (const entry of entries) {
				const child = join(directory, entry.name);
				const childRelative = relative(packagePath, child).split(sep).join("/");
				const info = await withTimeout(lstat(child), this.timeoutMs, "package file stat");
				if (info.isSymbolicLink()) {
					throw new Error(`Package contains a symlink: ${childRelative}`);
				}
				const childRealPath = await withTimeout(
					realpath(child),
					this.timeoutMs,
					"package file realpath",
				);
				if (!isInsidePath(packageRealPath, childRealPath))
					throw new Error(`Package entry escapes its root: ${childRelative}`);
				if (info.isDirectory()) {
					await walk(child);
				} else if (info.isFile()) {
					files.push(childRelative);
					if (files.length > this.maxFilesPerPackage) return;
				} else {
					throw new Error(`Unsupported package filesystem entry: ${childRelative}`);
				}
			}
		};
		await walk(packagePath);
		return files;
	}
}

export const pluginCatalog = new PluginCatalog();
