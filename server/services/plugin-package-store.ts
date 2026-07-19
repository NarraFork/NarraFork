import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { AsyncMutex } from "../lib/async-mutex";
import { formatZodError, ValidationError } from "../lib/errors";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { isInsidePath } from "../lib/platform-path";
import { type Manifest, pluginIdSchema, safeParseManifest } from "../lib/plugins/manifest";
import { safeSpawn } from "../lib/spawn";

const DEFAULT_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_ARCHIVE_OUTPUT_BYTES = 8 * 1024 * 1024;
const CURRENT_POINTER_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const currentPointerMutex = new AsyncMutex();

export interface PackageStoreLimits {
	maxArchiveBytes: number;
	maxUnpackedBytes: number;
	maxFileBytes: number;
	maxManifestBytes: number;
	maxFiles: number;
	timeoutMs: number;
}

export interface PackageStoreOptions {
	root?: string;
	limits?: Partial<PackageStoreLimits>;
	/** Injectable for failure-path tests; only the current pointer uses this hook. */
	renameCurrent?: (from: string, to: string) => Promise<void>;
}

export interface CurrentPackagePointer {
	version: string;
	hash: string;
}

export interface CurrentPointerFile {
	version: number;
	plugins: Record<string, CurrentPackagePointer>;
}

export interface SetCurrentOptions {
	/** null means the plugin must currently have no pointer; undefined disables CAS. */
	expectedCurrent?: CurrentPackagePointer | null;
	operationId?: string;
}

export interface PackageInstallOptions extends SetCurrentOptions {
	/** Upgrade coordination stages immutable packages before changing current.json. */
	updateCurrent?: boolean;
}

export interface InstalledPackageResult {
	pluginId: string;
	version: string;
	hash: string;
	packagePath: string;
	path: string;
	manifest: Manifest;
	alreadyInstalled: boolean;
	currentUpdated: boolean;
}

export type PackageSource = string | URL | File | Uint8Array | ArrayBuffer | SharedArrayBuffer;

interface WalkStats {
	files: number;
	totalBytes: number;
}

interface PackageStorePaths {
	root: string;
	staging: string;
	packages: string;
	current: string;
}

function createLimits(overrides?: Partial<PackageStoreLimits>): PackageStoreLimits {
	return {
		maxArchiveBytes: overrides?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
		maxUnpackedBytes: overrides?.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES,
		maxFileBytes: overrides?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		maxManifestBytes: overrides?.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
		maxFiles: overrides?.maxFiles ?? DEFAULT_MAX_FILES,
		timeoutMs: overrides?.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ValidationError(`${label} timed out`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function assertSegment(value: string, label: string): void {
	if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
		throw new ValidationError(`${label} contains an unsafe path segment`);
	}
}

function assertArchiveRelativePath(value: string): string {
	if (!value || value.includes("\0") || value.includes("\\")) {
		throw new ValidationError(`Package path is invalid: ${JSON.stringify(value)}`);
	}
	if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:[\\/]/.test(value)) {
		throw new ValidationError(`Package path is absolute: ${JSON.stringify(value)}`);
	}
	const segments = value.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new ValidationError(`Package path escapes its root: ${JSON.stringify(value)}`);
	}
	return segments.join("/");
}

function safeJoin(parent: string, ...segments: string[]): string {
	const child = resolve(parent, ...segments);
	if (!isInsidePath(parent, child)) {
		throw new ValidationError("Package path escapes the plugin store root");
	}
	return child;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function removeBestEffort(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch {
		// Staging cleanup must never mask the original installation diagnostic.
	}
}

async function readCappedText(
	path: string,
	maxBytes: number,
	timeoutMs: number,
	label: string,
): Promise<string> {
	const info = await withTimeout(lstat(path), timeoutMs, `${label} stat`);
	if (!info.isFile()) throw new ValidationError(`${label} is not a regular file`);
	if (info.size > maxBytes) {
		throw new ValidationError(`${label} exceeds the ${maxBytes} byte limit`);
	}
	const bytes = await withTimeout(readFile(path), timeoutMs, `${label} read`);
	if (bytes.byteLength > maxBytes) {
		throw new ValidationError(`${label} exceeds the ${maxBytes} byte limit`);
	}
	return new TextDecoder().decode(bytes);
}

async function readJsonFile(path: string, limits: PackageStoreLimits): Promise<unknown> {
	const text = await readCappedText(
		path,
		limits.maxManifestBytes,
		limits.timeoutMs,
		"manifest.json",
	);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ValidationError("manifest.json is not valid JSON");
	}
}

async function assertNoSymlinkTree(root: string, limits: PackageStoreLimits): Promise<WalkStats> {
	const realRoot = await withTimeout(realpath(root), limits.timeoutMs, "package realpath");
	const stats: WalkStats = { files: 0, totalBytes: 0 };

	const walk = async (directory: string): Promise<void> => {
		const entries = await withTimeout(
			readdir(directory, { withFileTypes: true }),
			limits.timeoutMs,
			"package scan",
		);
		for (const entry of entries) {
			const child = join(directory, entry.name);
			const relativePath = relative(root, child).split(sep).join("/");
			assertArchiveRelativePath(relativePath);
			const childInfo = await withTimeout(lstat(child), limits.timeoutMs, "package entry stat");
			if (childInfo.isSymbolicLink()) {
				throw new ValidationError(`Package contains a symlink: ${relativePath}`);
			}
			const childRealPath = await withTimeout(
				realpath(child),
				limits.timeoutMs,
				"package entry realpath",
			);
			if (!isInsidePath(realRoot, childRealPath)) {
				throw new ValidationError(`Package entry escapes its root: ${relativePath}`);
			}
			if (childInfo.isDirectory()) {
				await walk(child);
				continue;
			}
			if (!childInfo.isFile()) {
				throw new ValidationError(
					`Package contains an unsupported filesystem entry: ${relativePath}`,
				);
			}
			stats.files += 1;
			stats.totalBytes += childInfo.size;
			if (stats.files > limits.maxFiles) {
				throw new ValidationError(`Package contains more than ${limits.maxFiles} files`);
			}
			if (childInfo.size > limits.maxFileBytes) {
				throw new ValidationError(
					`Package file exceeds the ${limits.maxFileBytes} byte limit: ${relativePath}`,
				);
			}
			if (stats.totalBytes > limits.maxUnpackedBytes) {
				throw new ValidationError(
					`Package exceeds the ${limits.maxUnpackedBytes} byte unpacked limit`,
				);
			}
		}
	};

	await walk(root);
	return stats;
}

async function copyDirectoryTree(
	sourceRoot: string,
	destinationRoot: string,
	limits: PackageStoreLimits,
): Promise<void> {
	const sourceRealRoot = await withTimeout(
		realpath(sourceRoot),
		limits.timeoutMs,
		"source realpath",
	);
	const stats: WalkStats = { files: 0, totalBytes: 0 };

	const copyTree = async (source: string, destination: string): Promise<void> => {
		const entries = await withTimeout(
			readdir(source, { withFileTypes: true }),
			limits.timeoutMs,
			"source scan",
		);
		for (const entry of entries) {
			const sourcePath = join(source, entry.name);
			const relativePath = relative(sourceRoot, sourcePath).split(sep).join("/");
			assertArchiveRelativePath(relativePath);
			const destinationPath = safeJoin(destination, entry.name);
			const info = await withTimeout(lstat(sourcePath), limits.timeoutMs, "source entry stat");
			if (info.isSymbolicLink()) {
				throw new ValidationError(`Package source contains a symlink: ${relativePath}`);
			}
			const sourceRealPath = await withTimeout(
				realpath(sourcePath),
				limits.timeoutMs,
				"source entry realpath",
			);
			if (!isInsidePath(sourceRealRoot, sourceRealPath)) {
				throw new ValidationError(`Package source escapes its root: ${relativePath}`);
			}
			if (info.isDirectory()) {
				await withTimeout(
					mkdir(destinationPath, { recursive: true }),
					limits.timeoutMs,
					"package directory create",
				);
				await copyTree(sourcePath, destinationPath);
				continue;
			}
			if (!info.isFile()) {
				throw new ValidationError(`Package source contains an unsupported entry: ${relativePath}`);
			}
			stats.files += 1;
			stats.totalBytes += info.size;
			if (stats.files > limits.maxFiles)
				throw new ValidationError(`Package contains more than ${limits.maxFiles} files`);
			if (info.size > limits.maxFileBytes) {
				throw new ValidationError(
					`Package file exceeds the ${limits.maxFileBytes} byte limit: ${relativePath}`,
				);
			}
			if (stats.totalBytes > limits.maxUnpackedBytes) {
				throw new ValidationError(
					`Package exceeds the ${limits.maxUnpackedBytes} byte unpacked limit`,
				);
			}
			await withTimeout(
				mkdir(destinationRoot, { recursive: true }),
				limits.timeoutMs,
				"package directory create",
			);
			await withTimeout(
				copyFile(sourcePath, destinationPath),
				limits.timeoutMs,
				"package file copy",
			);
		}
	};

	await withTimeout(
		mkdir(destinationRoot, { recursive: true }),
		limits.timeoutMs,
		"package directory create",
	);
	await copyTree(sourceRoot, destinationRoot);
}

async function hashFileInto(
	hash: ReturnType<typeof createHash>,
	path: string,
	limits: PackageStoreLimits,
): Promise<number> {
	const info = await withTimeout(stat(path), limits.timeoutMs, "package hash stat");
	if (!info.isFile()) throw new ValidationError("Cannot hash a non-file package entry");
	if (info.size > limits.maxFileBytes)
		throw new ValidationError("Package file exceeds the file-size limit");
	let bytes = 0;
	const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
	try {
		await withTimeout(
			(async () => {
				for await (const chunk of stream) {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					bytes += buffer.byteLength;
					if (bytes > limits.maxFileBytes)
						throw new ValidationError("Package file exceeds the file-size limit");
					hash.update(buffer);
				}
			})(),
			limits.timeoutMs,
			"package hash",
		);
	} finally {
		stream.destroy();
	}
	return bytes;
}

async function computePackageHash(root: string, limits: PackageStoreLimits): Promise<string> {
	const hash = createHash("sha256");
	let totalBytes = 0;
	const walk = async (directory: string): Promise<void> => {
		const entries = await withTimeout(
			readdir(directory, { withFileTypes: true }),
			limits.timeoutMs,
			"package hash scan",
		);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const child = join(directory, entry.name);
			const rel = relative(root, child).split(sep).join("/");
			assertArchiveRelativePath(rel);
			if (entry.isDirectory()) {
				await walk(child);
				continue;
			}
			if (!entry.isFile())
				throw new ValidationError(`Cannot hash unsupported package entry: ${rel}`);
			hash.update(rel);
			hash.update("\0");
			totalBytes += await hashFileInto(hash, child, limits);
			if (totalBytes > limits.maxUnpackedBytes) {
				throw new ValidationError(
					`Package exceeds the ${limits.maxUnpackedBytes} byte unpacked limit`,
				);
			}
		}
	};
	await walk(root);
	return hash.digest("hex");
}

function parseZipEntryNames(output: string, maxEntries: number): string[] {
	const names = output.split(/\r?\n/).filter(Boolean);
	if (names.length > maxEntries)
		throw new ValidationError(`Package contains more than ${maxEntries} archive entries`);
	const seen = new Set<string>();
	const caseFolded = new Set<string>();
	for (const name of names) {
		const normalized = assertArchiveRelativePath(name.endsWith("/") ? name.slice(0, -1) : name);
		if (!normalized) continue;
		if (seen.has(normalized))
			throw new ValidationError(`Package archive contains a duplicate entry: ${normalized}`);
		seen.add(normalized);
		const folded = normalized.toLocaleLowerCase("en-US");
		if (caseFolded.has(folded))
			throw new ValidationError(`Package archive contains a case collision: ${normalized}`);
		caseFolded.add(folded);
	}
	return names;
}

function inspectZipMetadata(output: string, limits: PackageStoreLimits): void {
	let totalUnpacked = 0;
	let sizeCount = 0;
	for (const line of output.split(/\r?\n/)) {
		const attributes = line.match(/Unix file attributes \(([0-7]+) octal\):\s+([^\s]+)/);
		if (attributes && /^[lbcps]/.test(attributes[2])) {
			throw new ValidationError("Package archive contains a symlink or special filesystem entry");
		}
		const size = line.match(/^\s*uncompressed size:\s*([0-9]+) bytes/);
		if (!size) continue;
		const bytes = Number(size[1]);
		if (!Number.isSafeInteger(bytes))
			throw new ValidationError("Package archive contains an invalid file size");
		sizeCount += 1;
		if (bytes > limits.maxFileBytes)
			throw new ValidationError("Package file exceeds the file-size limit");
		totalUnpacked += bytes;
		if (totalUnpacked > limits.maxUnpackedBytes) {
			throw new ValidationError("Package exceeds the unpacked-size limit");
		}
	}
	if (sizeCount === 0) throw new ValidationError("Package archive has no readable file entries");
}

async function extractZip(
	archivePath: string,
	destination: string,
	limits: PackageStoreLimits,
): Promise<void> {
	const listing = await withTimeout(
		safeSpawn({
			cmd: ["unzip", "-Z1", archivePath],
			timeout: limits.timeoutMs,
			maxOutputBytes: DEFAULT_ARCHIVE_OUTPUT_BYTES,
		}),
		limits.timeoutMs,
		"package archive listing",
	);
	if (listing.exitCode !== 0 || listing.stdoutTruncated) {
		throw new ValidationError("Unable to inspect plugin package archive entries");
	}
	parseZipEntryNames(listing.stdout, limits.maxFiles);
	const metadata = await withTimeout(
		safeSpawn({
			cmd: ["unzip", "-Z", "-v", archivePath],
			timeout: limits.timeoutMs,
			maxOutputBytes: DEFAULT_ARCHIVE_OUTPUT_BYTES,
		}),
		limits.timeoutMs,
		"package archive metadata",
	);
	if (metadata.exitCode !== 0 || metadata.stdoutTruncated) {
		throw new ValidationError("Unable to inspect plugin package metadata");
	}
	inspectZipMetadata(metadata.stdout, limits);
	await withTimeout(
		mkdir(destination, { recursive: true }),
		limits.timeoutMs,
		"package extraction directory create",
	);
	const extracted = await withTimeout(
		safeSpawn({
			cmd: ["unzip", "-q", "-o", archivePath, "-d", destination],
			timeout: limits.timeoutMs,
			maxOutputBytes: DEFAULT_ARCHIVE_OUTPUT_BYTES,
		}),
		limits.timeoutMs,
		"package extraction",
	);
	if (extracted.exitCode !== 0) {
		throw new ValidationError(
			`Plugin package extraction failed: ${extracted.stderr.slice(0, 500)}`,
		);
	}
}

function isArchivePath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".nfplugin") || lower.endsWith(".zip") || extname(lower) === ".nfplugin";
}

async function sourceToStaging(
	source: PackageSource,
	stagingRoot: string,
	limits: PackageStoreLimits,
): Promise<{ packageRoot: string; archivePath?: string }> {
	const packageRoot = safeJoin(stagingRoot, "package");
	if (typeof source === "string" || source instanceof URL) {
		const sourcePath = resolve(source instanceof URL ? source.pathname : source);
		const info = await withTimeout(lstat(sourcePath), limits.timeoutMs, "package source stat");
		if (info.isDirectory()) {
			await copyDirectoryTree(sourcePath, packageRoot, limits);
			return { packageRoot };
		}
		if (!info.isFile())
			throw new ValidationError("Plugin package source must be a directory or archive file");
		if (info.size > limits.maxArchiveBytes)
			throw new ValidationError("Plugin package archive exceeds the size limit");
		if (!isArchivePath(sourcePath))
			throw new ValidationError("Plugin package archive must be a .nfplugin or .zip file");
		const archivePath = safeJoin(stagingRoot, `input${extname(sourcePath) || ".nfplugin"}`);
		await withTimeout(
			copyFile(sourcePath, archivePath),
			limits.timeoutMs,
			"plugin package archive copy",
		);
		await extractZip(archivePath, packageRoot, limits);
		return { packageRoot, archivePath };
	}

	let bytes: Uint8Array;
	if (source instanceof File) {
		if (source.size > limits.maxArchiveBytes)
			throw new ValidationError("Plugin package archive exceeds the size limit");
		bytes = new Uint8Array(
			await withTimeout(source.arrayBuffer(), limits.timeoutMs, "plugin package archive read"),
		);
	} else if (source instanceof ArrayBuffer || source instanceof SharedArrayBuffer) {
		bytes = new Uint8Array(source);
	} else {
		bytes = source;
	}
	if (bytes.byteLength > limits.maxArchiveBytes)
		throw new ValidationError("Plugin package archive exceeds the size limit");
	const archivePath = safeJoin(stagingRoot, "input.nfplugin");
	await withTimeout(
		writeFile(archivePath, bytes),
		limits.timeoutMs,
		"plugin package archive write",
	);
	await extractZip(archivePath, packageRoot, limits);
	return { packageRoot, archivePath };
}

function parseCurrentPointer(value: unknown, label: string): CurrentPackagePointer {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${label} is invalid`);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.version !== "string" || !VERSION_PATTERN.test(record.version)) {
		throw new ValidationError(`${label} has an invalid version`);
	}
	if (typeof record.hash !== "string" || !HASH_PATTERN.test(record.hash)) {
		throw new ValidationError(`${label} has an invalid hash`);
	}
	return { version: record.version, hash: record.hash };
}

function pointersEqual(
	left: CurrentPackagePointer | undefined,
	right: CurrentPackagePointer | null | undefined,
): boolean {
	if (!left || !right) return !left && !right;
	return left.version === right.version && left.hash === right.hash;
}

function pointerFromUnknown(value: unknown): CurrentPointerFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError("current.json is invalid");
	}
	const object = value as Record<string, unknown>;
	const rawPlugins = object.plugins && typeof object.plugins === "object" ? object.plugins : object;
	if (!rawPlugins || typeof rawPlugins !== "object" || Array.isArray(rawPlugins)) {
		throw new ValidationError("current.json is invalid");
	}
	const plugins: Record<string, CurrentPackagePointer> = {};
	for (const [pluginId, pointer] of Object.entries(rawPlugins)) {
		if (!pluginIdSchema.safeParse(pluginId).success) {
			throw new ValidationError(`current.json has an invalid pluginId: ${pluginId}`);
		}
		plugins[pluginId] = parseCurrentPointer(pointer, `current.json pointer for ${pluginId}`);
	}
	return { version: CURRENT_POINTER_VERSION, plugins };
}

export async function readPluginCurrentPointer(root: string): Promise<CurrentPointerFile> {
	const currentPath = safeJoin(resolve(root), "current.json");
	try {
		const text = await readCappedText(
			currentPath,
			256 * 1024,
			DEFAULT_OPERATION_TIMEOUT_MS,
			"current.json",
		);
		return pointerFromUnknown(JSON.parse(text) as unknown);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: CURRENT_POINTER_VERSION, plugins: {} };
		}
		if (error instanceof SyntaxError) throw new ValidationError("current.json is not valid JSON");
		throw error;
	}
}

export class PluginPackageStore {
	readonly paths: PackageStorePaths;
	readonly limits: PackageStoreLimits;
	private readonly renameCurrent: (from: string, to: string) => Promise<void>;

	constructor(rootOrOptions: string | PackageStoreOptions = {}) {
		const options = typeof rootOrOptions === "string" ? { root: rootOrOptions } : rootOrOptions;
		const root = resolve(options.root ?? getNarraforkPath("plugins"));
		this.paths = {
			root,
			staging: safeJoin(root, "staging"),
			packages: safeJoin(root, "packages"),
			current: safeJoin(root, "current.json"),
		};
		this.limits = createLimits(options.limits);
		this.renameCurrent = options.renameCurrent ?? rename;
	}

	get root(): string {
		return this.paths.root;
	}

	get stagingPath(): string {
		return this.paths.staging;
	}

	get packagesPath(): string {
		return this.paths.packages;
	}

	get currentPath(): string {
		return this.paths.current;
	}

	packagePath(pluginId: string, version: string, hash: string): string {
		assertSegment(pluginId, "pluginId");
		assertSegment(version, "version");
		assertSegment(hash, "hash");
		return safeJoin(this.paths.packages, pluginId, version, hash);
	}

	async readCurrent(): Promise<CurrentPointerFile> {
		return readPluginCurrentPointer(this.paths.root);
	}

	async ensureDirectories(): Promise<void> {
		await withTimeout(
			mkdir(this.paths.staging, { recursive: true }),
			this.limits.timeoutMs,
			"plugin staging directory create",
		);
		await withTimeout(
			mkdir(this.paths.packages, { recursive: true }),
			this.limits.timeoutMs,
			"plugin package directory create",
		);
	}

	async cleanupStaging(): Promise<number> {
		await this.ensureDirectories();
		const entries = await withTimeout(
			readdir(this.paths.staging, { withFileTypes: true }),
			this.limits.timeoutMs,
			"plugin staging cleanup scan",
		);
		await Promise.all(
			entries.map((entry) =>
				withTimeout(
					rm(safeJoin(this.paths.staging, entry.name), { recursive: true, force: true }),
					this.limits.timeoutMs,
					"plugin staging cleanup",
				),
			),
		);
		return entries.length;
	}

	async setCurrent(
		pluginId: string,
		pointer: CurrentPackagePointer | undefined,
		options: SetCurrentOptions = {},
	): Promise<CurrentPointerFile> {
		if (!pluginIdSchema.safeParse(pluginId).success) throw new ValidationError("Invalid pluginId");
		const nextPointer = pointer
			? parseCurrentPointer(pointer, `current pointer for ${pluginId}`)
			: undefined;
		const expectedCurrent =
			options.expectedCurrent === null
				? null
				: options.expectedCurrent
					? parseCurrentPointer(options.expectedCurrent, `expected current pointer for ${pluginId}`)
					: undefined;
		return currentPointerMutex.acquire(this.paths.root, async () => {
			await this.ensureDirectories();
			const current = await this.readCurrent();
			const actual = current.plugins[pluginId];
			if (expectedCurrent !== undefined && !pointersEqual(actual, expectedCurrent)) {
				throw new ValidationError(
					`Current pointer changed for ${pluginId}; expected ${expectedCurrent ? `${expectedCurrent.version}@${expectedCurrent.hash}` : "no pointer"}`,
				);
			}
			const plugins = { ...current.plugins };
			if (nextPointer) plugins[pluginId] = nextPointer;
			else delete plugins[pluginId];
			const next: CurrentPointerFile = { version: CURRENT_POINTER_VERSION, plugins };
			await this.writeCurrentLocked(next, options.operationId);
			return structuredClone(next);
		});
	}

	private async writeCurrentLocked(
		document: CurrentPointerFile,
		operationId = generateShortId(12),
	): Promise<void> {
		assertSegment(operationId, "operationId");
		const temporaryPath = safeJoin(
			this.paths.staging,
			`${operationId}.${generateShortId(8)}.current.json.tmp`,
		);
		const json = `${JSON.stringify(document, null, 2)}\n`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await withTimeout(
				open(temporaryPath, "wx", 0o600),
				this.limits.timeoutMs,
				"current pointer temp open",
			);
			await withTimeout(
				handle.writeFile(json, { encoding: "utf8" }),
				this.limits.timeoutMs,
				"current pointer write",
			);
			await handle.chmod(0o600);
			await withTimeout(handle.sync(), this.limits.timeoutMs, "current pointer fsync");
			await handle.close();
			handle = undefined;
			await withTimeout(
				this.renameCurrent(temporaryPath, this.paths.current),
				this.limits.timeoutMs,
				"current pointer update",
			);
			await this.syncDirectory(this.paths.root);
			await this.syncDirectory(this.paths.staging);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await removeBestEffort(temporaryPath);
			throw new ValidationError(
				`Unable to atomically update current plugin pointer: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async syncDirectory(path: string): Promise<void> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(path, "r");
			await handle.sync();
		} catch (error) {
			if (process.platform !== "win32") {
				logger.warn("Unable to fsync plugin package directory", {
					path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	async install(
		source: PackageSource,
		options: PackageInstallOptions = {},
	): Promise<InstalledPackageResult> {
		await this.ensureDirectories();
		const operationId = generateShortId(12);
		const stagingRoot = safeJoin(this.paths.staging, operationId);
		await withTimeout(
			mkdir(stagingRoot, { recursive: true }),
			this.limits.timeoutMs,
			"plugin staging create",
		);
		let packageRoot: string | undefined;
		try {
			const staged = await sourceToStaging(source, stagingRoot, this.limits);
			packageRoot = staged.packageRoot;
			const stats = await assertNoSymlinkTree(packageRoot, this.limits);
			if (stats.files === 0) throw new ValidationError("Plugin package is empty");
			const manifestPath = safeJoin(packageRoot, "manifest.json");
			const rawManifest = await readJsonFile(manifestPath, this.limits);
			const parsed = safeParseManifest(rawManifest);
			if (!parsed.success)
				throw new ValidationError(`Invalid plugin manifest: ${formatZodError(parsed.error)}`);
			const manifest = parsed.data;
			const entryPaths = [
				manifest.server?.entry,
				manifest.ui?.entry,
				manifest.ui?.style,
				...manifest.contributes.views.flatMap((view) => [view.entry, view.style]),
			].filter(
				(path, index, paths): path is string => Boolean(path) && paths.indexOf(path) === index,
			);
			for (const entry of entryPaths) {
				const entryPath = safeJoin(packageRoot, ...entry.split("/"));
				const info = await withTimeout(
					lstat(entryPath),
					this.limits.timeoutMs,
					"plugin entry stat",
				);
				if (!info.isFile())
					throw new ValidationError(`Plugin entry is missing or not a regular file: ${entry}`);
			}
			const hash = await computePackageHash(packageRoot, this.limits);
			const packagePath = this.packagePath(manifest.pluginId, manifest.version, hash);
			const versionRoot = safeJoin(this.paths.packages, manifest.pluginId, manifest.version);
			const existingVersionEntries = await (async () => {
				try {
					return await readdir(versionRoot, { withFileTypes: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
					throw error;
				}
			})();
			for (const entry of existingVersionEntries) {
				if (entry.name !== hash && entry.isDirectory()) {
					throw new ValidationError(
						`Plugin version ${manifest.pluginId}@${manifest.version} is already installed with a different hash`,
					);
				}
			}
			const alreadyInstalled = await pathExists(packagePath);
			if (!alreadyInstalled) {
				await withTimeout(
					mkdir(versionRoot, { recursive: true }),
					this.limits.timeoutMs,
					"plugin package parent create",
				);
				await withTimeout(
					rename(packageRoot, packagePath),
					this.limits.timeoutMs,
					"plugin package commit",
				);
				packageRoot = undefined;
			}
			const updateCurrent = options.updateCurrent ?? true;
			if (updateCurrent) {
				await this.setCurrent(
					manifest.pluginId,
					{ version: manifest.version, hash },
					{
						expectedCurrent: options.expectedCurrent,
						operationId: options.operationId ?? operationId,
					},
				);
			}
			logger.info("Plugin package installed", {
				pluginId: manifest.pluginId,
				version: manifest.version,
				hash,
				alreadyInstalled,
			});
			return {
				pluginId: manifest.pluginId,
				version: manifest.version,
				hash,
				packagePath,
				path: packagePath,
				manifest,
				alreadyInstalled,
				currentUpdated: updateCurrent,
			};
		} catch (error) {
			if (error instanceof ValidationError) throw error;
			throw new ValidationError(
				`Plugin package installation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			await removeBestEffort(stagingRoot);
		}
	}

	installPackage(
		source: PackageSource,
		options: PackageInstallOptions = {},
	): Promise<InstalledPackageResult> {
		return this.install(source, options);
	}
}

export const pluginPackageStore = new PluginPackageStore();

/** Exported for the Catalog and tests; no package code is executed by this helper. */
export const pluginPackageHashPattern = HASH_PATTERN;
export const pluginPackageVersionPattern = VERSION_PATTERN;
