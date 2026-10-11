import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import {
	INTELLIGENT_UI_KIT_BUNDLE_NAME,
	INTELLIGENT_UI_KIT_DIRECTORY,
	INTELLIGENT_UI_KIT_DIST,
	INTELLIGENT_UI_KIT_ENTRY,
	INTELLIGENT_UI_KIT_LEGACY_BUNDLE,
	INTELLIGENT_UI_KIT_MANIFEST,
	INTELLIGENT_UI_KIT_META,
	INTELLIGENT_UI_KIT_VITE_CONFIG,
	type IntelligentUiKitBundle,
	type IntelligentUiKitManifest,
	type IntelligentUiKitStatus,
	intelligentUiKitBundleName,
	INTELLIGENT_UI_KIT_LIMITS as LIMITS,
	parseIntelligentUiKitManifest,
	renderIntelligentUiKitEntry,
	renderIntelligentUiKitViteConfig,
} from "@shared/intelligent-ui-kit";
import type { WorkspaceContext } from "@shared/workspace-context";
import { type AuthorizeFile, uiError, workspaceRoot } from "./files";

export interface KitLocation {
	root: string;
	kitDir: string;
	manifestPath: string;
	distDir: string;
	metaPath: string;
}

/**
 * What `kit_build` recorded about the bundle it produced. This file is the commit point
 * of a build: bundles are written under new names, and only rewriting the metadata makes
 * one current.
 */
interface KitMeta {
	version: 1;
	fingerprint: string;
	hash: string;
	builtAt: string;
	components: string[];
	hasSetup: boolean;
	/** Bare file names inside dist/. Validated on read: this is a workspace file. */
	js: string;
	css: string | null;
	/** Successful builds so far; part of the next bundle's name. */
	generation: number;
}

export interface KitSnapshot {
	location: KitLocation;
	status: IntelligentUiKitStatus;
	/** Present whenever kit.json parses, built or not. */
	manifest?: IntelligentUiKitManifest;
	meta?: KitMeta;
}

const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
const SETUP_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js"];
const BUNDLE_JS = /^kit-[0-9a-f]{12}\.js$/;
// `style.css` is what Vite before 6 calls a library's stylesheet.
const BUNDLE_CSS = /^(?:kit-[0-9a-f]{12}|kit|style)\.css$/;
const OWN_ARTIFACT = /^kit(?:-[0-9a-f]{12})?\.(?:js|css)$/;

export async function locateKit(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	signal: AbortSignal,
): Promise<KitLocation> {
	const root = await workspaceRoot(backend, workspace, signal);
	const kitDir = backend.paths.resolve(root, INTELLIGENT_UI_KIT_DIRECTORY);
	const distDir = backend.paths.resolve(kitDir, INTELLIGENT_UI_KIT_DIST);
	return {
		root,
		kitDir,
		manifestPath: backend.paths.resolve(kitDir, INTELLIGENT_UI_KIT_MANIFEST),
		distDir,
		metaPath: backend.paths.resolve(distDir, INTELLIGENT_UI_KIT_META),
	};
}

/** Bounded whole-file read; null when the file does not exist (or vanished meanwhile). */
async function readBounded(
	backend: ExecutionBackend,
	path: string,
	maxBytes: number,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<Uint8Array | null> {
	signal.throwIfAborted();
	const stat = await backend.statFile(path, { signal, timeoutMs: 15_000 });
	if (!stat?.isFile) return null;
	if (stat.size > maxBytes)
		throw uiError(`${backend.paths.basename(path)} exceeds its ${maxBytes}-byte limit`, 413);
	await authorize(path, signal);
	let read: Awaited<ReturnType<ExecutionBackend["readFileBytes"]>>;
	try {
		read = await backend.readFileBytes(path, { maxBytes, signal, timeoutMs: 15_000 });
	} catch (error) {
		// Deleted between the stat and the read (a rebuild, a branch switch): absent.
		if (!(await backend.fileExists(path))) return null;
		throw error;
	}
	if (read.truncated)
		throw uiError(`${backend.paths.basename(path)} exceeds its ${maxBytes}-byte limit`, 413);
	return read.bytes;
}

function sha256(...parts: Array<string | Uint8Array>): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const part of parts) {
		hasher.update(part);
		hasher.update("\0");
	}
	return hasher.digest("hex");
}

function viteRoot(backend: ExecutionBackend, location: KitLocation, root: string): string {
	const resolved = backend.paths.resolve(location.root, root);
	if (
		!backend.paths.equals(resolved, location.root) &&
		!backend.paths.contains(location.root, resolved)
	)
		throw uiError("kit.json root must stay inside the workspace", 403);
	return resolved;
}

async function findLockfile(
	backend: ExecutionBackend,
	directories: string[],
	signal: AbortSignal,
): Promise<{ name: string; path: string; size: number } | null> {
	for (const directory of directories) {
		for (const name of LOCKFILES) {
			const path = backend.paths.resolve(directory, name);
			const stat = await backend.statFile(path, { signal, timeoutMs: 15_000 });
			if (stat?.isFile) return { name, path, size: stat.size };
		}
	}
	return null;
}

/**
 * Identity of everything the bundle is built FROM that the host can observe cheaply:
 * the manifest, the setup wrapper, and the dependency set. Edits inside the component
 * library itself are not tracked; the user asks for an update when those matter.
 */
async function fingerprint(
	backend: ExecutionBackend,
	location: KitLocation,
	manifest: IntelligentUiKitManifest,
	manifestBytes: Uint8Array,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<string> {
	const parts: Array<string | Uint8Array> = [manifestBytes];
	if (manifest.setup && /^\.{1,2}\//.test(manifest.setup)) {
		for (const extension of SETUP_EXTENSIONS) {
			const path = backend.paths.resolve(location.kitDir, manifest.setup + extension);
			// The wrapper is hashed only where it is the workspace's own file.
			if (!backend.paths.contains(location.root, path)) break;
			const bytes = await readBounded(backend, path, LIMITS.setupBytes, authorize, signal);
			if (bytes) {
				parts.push(bytes);
				break;
			}
		}
	}
	const projectRoot = viteRoot(backend, location, manifest.root);
	const lockfile = await findLockfile(backend, [projectRoot, location.root], signal);
	// Size is a deliberate proxy: hashing a multi-megabyte lockfile on every status
	// check would put file IO on the request path for no practical gain.
	parts.push(lockfile ? `${lockfile.name}:${lockfile.size}` : "no-lockfile");
	return sha256(...parts);
}

function parseMeta(bytes: Uint8Array | null): KitMeta | undefined {
	if (!bytes) return undefined;
	try {
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		// Bundles built before they were named after their inputs.
		const js = raw.js === undefined ? INTELLIGENT_UI_KIT_LEGACY_BUNDLE : raw.js;
		const css = raw.css === undefined ? null : raw.css;
		if (
			raw.version !== 1 ||
			typeof raw.fingerprint !== "string" ||
			typeof raw.hash !== "string" ||
			raw.hash.length > 64 ||
			typeof raw.builtAt !== "string" ||
			!Array.isArray(raw.components) ||
			raw.components.length > LIMITS.components ||
			!raw.components.every((name) => typeof name === "string" && name.length <= 64) ||
			// These become paths the host reads: bare, expected names only.
			typeof js !== "string" ||
			(js !== INTELLIGENT_UI_KIT_LEGACY_BUNDLE && !BUNDLE_JS.test(js)) ||
			(css !== null && (typeof css !== "string" || !BUNDLE_CSS.test(css)))
		)
			return undefined;
		return {
			version: 1,
			fingerprint: raw.fingerprint,
			hash: raw.hash,
			builtAt: raw.builtAt,
			components: raw.components as string[],
			hasSetup: raw.hasSetup === true,
			js,
			css: css as string | null,
			generation:
				typeof raw.generation === "number" && Number.isSafeInteger(raw.generation)
					? Math.max(0, raw.generation)
					: 0,
		};
	} catch {
		return undefined;
	}
}

async function readManifest(
	backend: ExecutionBackend,
	location: KitLocation,
	authorize: AuthorizeFile,
	signal: AbortSignal,
) {
	return readBounded(backend, location.manifestPath, LIMITS.manifestBytes, authorize, signal);
}

/** The metadata of a bundle that is actually on disk. */
async function readServedMeta(
	backend: ExecutionBackend,
	location: KitLocation,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<KitMeta | undefined> {
	const meta = parseMeta(
		await readBounded(backend, location.metaPath, 64 * 1024, authorize, signal),
	);
	if (!meta) return undefined;
	const bundle = await backend.statFile(backend.paths.resolve(location.distDir, meta.js), {
		signal,
		timeoutMs: 15_000,
	});
	return bundle?.isFile ? meta : undefined;
}

/** Current kit state. Never throws for a malformed manifest: that is a state. */
export async function readKit(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<KitSnapshot> {
	const location = await locateKit(backend, workspace, signal);
	const manifestBytes = await readManifest(backend, location, authorize, signal);
	if (!manifestBytes) return { location, status: { state: "builtin", components: [] } };
	const served = await readServedMeta(backend, location, authorize, signal);
	const built = served
		? { components: served.components, hash: served.hash, builtAt: served.builtAt }
		: { components: [] };
	let manifest: IntelligentUiKitManifest;
	try {
		manifest = parseIntelligentUiKitManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
		viteRoot(backend, location, manifest.root);
	} catch (error) {
		return {
			location,
			meta: served,
			status: {
				state: "invalid",
				...built,
				reason: (error instanceof Error ? error.message : "kit.json is invalid").slice(0, 400),
			},
		};
	}
	if (!served) return { location, manifest, status: { state: "unbuilt", components: [] } };
	const current = await fingerprint(backend, location, manifest, manifestBytes, authorize, signal);
	return {
		location,
		manifest,
		meta: served,
		status: {
			state: current === served.fingerprint ? "ready" : "stale",
			...built,
			...(current === served.fingerprint
				? {}
				: { reason: "kit.json, the setup wrapper or the dependency lockfile changed" }),
		},
	};
}

/** The served bundle, built or stale. Throws when there is nothing to serve. */
export async function readKitBundle(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<IntelligentUiKitBundle> {
	const location = await locateKit(backend, workspace, signal);
	const meta = await readServedMeta(backend, location, authorize, signal);
	if (!meta) throw uiError("This workspace has no built component kit", 404);
	const js = await readBounded(
		backend,
		backend.paths.resolve(location.distDir, meta.js),
		LIMITS.bundleJsBytes,
		authorize,
		signal,
	);
	if (!js) throw uiError("Component kit bundle is missing; rebuild the kit", 404);
	const css = meta.css
		? await readBounded(
				backend,
				backend.paths.resolve(location.distDir, meta.css),
				LIMITS.bundleCssBytes,
				authorize,
				signal,
			)
		: null;
	const decoder = new TextDecoder();
	return {
		js: decoder.decode(js),
		css: css ? decoder.decode(css) : "",
		hash: meta.hash,
		components: meta.components,
		hasSetup: meta.hasSetup,
	};
}

function buildCommand(lockfile: string | undefined, config: string): string {
	const runner =
		lockfile === "bun.lock" || lockfile === "bun.lockb"
			? "bunx vite"
			: lockfile === "pnpm-lock.yaml"
				? "pnpm exec vite"
				: lockfile === "yarn.lock"
					? "yarn vite"
					: "npx --no-install vite";
	// `config` is built from a workspace-relative path the host generated; quotes and
	// shell metacharacters cannot appear in a directory the host itself located, but a
	// space can.
	return `${runner} build --mode production --config "${config}"`;
}

export interface KitBuildResult {
	ok: boolean;
	/** Bounded tail of the build output, for the agent to act on. */
	log: string;
	command: string;
	/** Where this build writes its bundle, relative to the kit directory. */
	bundle: string;
	manifest: IntelligentUiKitManifest;
	status: IntelligentUiKitStatus;
}

export interface KitBuildOptions {
	/** Called before each generated file is written. */
	authorizeWrite(path: string): Promise<void>;
	authorize: AuthorizeFile;
	signal: AbortSignal;
	/** The agent already ran the build itself; only verify and record its output. */
	skipBuild?: boolean;
}

let activeBuilds = 0;

/**
 * Generate the entry and Vite config from kit.json, run the project's own Vite once,
 * and record what it produced.
 *
 * The new bundle is written beside the one being served, under a name no earlier build
 * used, and becomes current only when its metadata is written. A build that fails, times
 * out or is cancelled therefore leaves the kit the workspace was using exactly as it was.
 */
export async function buildKit(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	options: KitBuildOptions,
): Promise<KitBuildResult> {
	const { authorize, signal } = options;
	const location = await locateKit(backend, workspace, signal);
	const manifestBytes = await readManifest(backend, location, authorize, signal);
	if (!manifestBytes)
		throw uiError(
			`${INTELLIGENT_UI_KIT_DIRECTORY}/${INTELLIGENT_UI_KIT_MANIFEST} does not exist; write it first`,
			404,
		);
	let manifest: IntelligentUiKitManifest;
	try {
		manifest = parseIntelligentUiKitManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
	} catch (error) {
		throw uiError(error instanceof Error ? error.message : "kit.json is invalid", 422);
	}
	const projectRoot = viteRoot(backend, location, manifest.root);
	// Files named by path are files the bundle will contain; they have to be the
	// workspace's own. Package names and import aliases are resolved by the project's
	// Vite and are its business: the build the user approved runs that project's code.
	for (const specifier of [
		manifest.setup,
		...manifest.styles,
		...manifest.components.map((component) => component.from),
	]) {
		if (!specifier || !/^(?:\.{1,2}[/\\]|[A-Za-z]:[/\\])/.test(specifier)) continue;
		const target = backend.paths.resolve(location.kitDir, specifier);
		if (!backend.paths.contains(location.root, target))
			throw uiError(
				`kit.json imports "${specifier.slice(0, 200)}", which is outside the workspace`,
				403,
			);
	}
	const previous = await readServedMeta(backend, location, authorize, signal);
	const print = await fingerprint(backend, location, manifest, manifestBytes, authorize, signal);
	const generation = (previous?.generation ?? 0) + 1;
	// Same inputs and same generation give the same name, so a retry after a failed
	// attempt (or the agent's own manual build) lands where this build looks; a
	// successful build moves the generation on, so the next one never overwrites it.
	const name = intelligentUiKitBundleName(sha256(print, String(generation)));
	if (!INTELLIGENT_UI_KIT_BUNDLE_NAME.test(name)) throw uiError("Invalid kit bundle name", 500);
	const bundleFile = `${name}.js`;
	const bundlePath = backend.paths.resolve(location.distDir, bundleFile);
	const bundle = `${INTELLIGENT_UI_KIT_DIST}/${bundleFile}`;
	const entryPath = backend.paths.resolve(location.kitDir, INTELLIGENT_UI_KIT_ENTRY);
	const configPath = backend.paths.resolve(location.kitDir, INTELLIGENT_UI_KIT_VITE_CONFIG);
	const relative = (from: string, to: string) =>
		backend.paths.relative(from, to).replaceAll("\\", "/") || ".";
	const encoder = new TextEncoder();
	for (const [path, text] of [
		[entryPath, renderIntelligentUiKitEntry(manifest)],
		[configPath, renderIntelligentUiKitViteConfig(relative(location.kitDir, projectRoot), name)],
	] as const) {
		await options.authorizeWrite(path);
		signal.throwIfAborted();
		await backend.writeFileBytes(path, encoder.encode(text), { signal, timeoutMs: 30_000 });
	}
	const lockfile = await findLockfile(backend, [projectRoot, location.root], signal);
	const command = buildCommand(lockfile?.name, relative(projectRoot, configPath));
	const unchanged = async (log: string): Promise<KitBuildResult> => ({
		ok: false,
		log: log.trim(),
		command,
		bundle,
		manifest,
		status: (await readKit(backend, workspace, authorize, signal)).status,
	});
	let log = "";
	if (!options.skipBuild) {
		if (activeBuilds >= 1)
			throw uiError("Another component kit build is running; retry shortly", 429);
		activeBuilds++;
		try {
			await options.authorizeWrite(location.distDir);
			const handle = await backend.execCommand({
				command,
				cwd: projectRoot,
				signal,
				// NODE_ENV is pinned, not inherited: the host may run as development or
				// test, and Vite would then compile the components with the development
				// JSX runtime while the bundle's React is the production build. The two
				// do not fit together, and the bundle fails only when a component renders.
				env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NODE_ENV: "production" },
			});
			const decoder = new TextDecoder();
			handle.onData((chunk) => {
				// Bound at the source: a watch-mode plugin or a noisy build must not
				// accumulate megabytes that are sliced only at the end.
				log += decoder.decode(chunk, { stream: true });
				if (log.length > LIMITS.buildLogBytes * 2) log = log.slice(-LIMITS.buildLogBytes);
			});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				void handle.kill();
			}, LIMITS.buildTimeoutMs);
			const code = await handle.exited.finally(() => clearTimeout(timer));
			log = log.slice(-LIMITS.buildLogBytes).trim();
			if (timedOut) log += `\nBuild stopped after ${LIMITS.buildTimeoutMs / 1000} seconds.`;
			if (code !== 0 || timedOut) return unchanged(log);
		} finally {
			activeBuilds--;
		}
	}
	const built = await backend.statFile(bundlePath, { signal, timeoutMs: 15_000 });
	if (!built?.isFile || built.size === 0)
		return unchanged(`${log}\nThe build did not produce ${bundle}.`);
	if (built.size > LIMITS.bundleJsBytes)
		return unchanged(
			`${log}\nThe bundle is ${built.size} bytes; the limit is ${LIMITS.bundleJsBytes}. List fewer components.`,
		);
	const files = (await backend.listDir(location.distDir))
		.filter((entry) => !entry.isDirectory)
		.map((entry) => entry.name);
	// Vite names the stylesheet after `cssFileName` (>= 6) or `style.css` (older).
	const css = files.includes(`${name}.css`)
		? `${name}.css`
		: files.includes("style.css")
			? "style.css"
			: null;
	const builtAt = new Date().toISOString();
	const meta: KitMeta = {
		version: 1,
		fingerprint: print,
		hash: sha256(print, builtAt, String(built.size)).slice(0, 20),
		builtAt,
		components: manifest.components.map((component) => component.name),
		hasSetup: manifest.setup !== undefined,
		js: bundleFile,
		css,
		generation,
	};
	await options.authorizeWrite(location.metaPath);
	await backend.writeFileBytes(
		location.metaPath,
		encoder.encode(JSON.stringify(meta, null, "\t")),
		{
			signal,
			timeoutMs: 30_000,
		},
	);
	// Only now are earlier bundles garbage. Best effort: a leftover costs disk space, a
	// failure here must not turn a finished build into an error.
	for (const file of files) {
		if (!OWN_ARTIFACT.test(file) || file === meta.js || file === meta.css) continue;
		await backend.removeFile(backend.paths.resolve(location.distDir, file)).catch(() => {});
	}
	return {
		ok: true,
		log,
		command,
		bundle,
		manifest,
		status: {
			state: "ready",
			components: meta.components,
			hash: meta.hash,
			builtAt: meta.builtAt,
		},
	};
}
