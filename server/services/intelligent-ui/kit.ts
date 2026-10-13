import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { AppError } from "@server/lib/errors";
import {
	INTELLIGENT_UI_KIT_BUNDLE_NAME,
	INTELLIGENT_UI_KIT_DIRECTORY,
	INTELLIGENT_UI_KIT_DIST,
	INTELLIGENT_UI_KIT_ENTRY,
	INTELLIGENT_UI_KIT_LEGACY_BUNDLE,
	INTELLIGENT_UI_KIT_MANIFEST,
	INTELLIGENT_UI_KIT_META,
	INTELLIGENT_UI_KIT_STAGING,
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
import { type AuthorizeFile, uiError, workspaceKey, workspaceRoot } from "./files";
import {
	type KitSignedFields,
	kitFileSha256,
	signKitFields,
	verifyKitFields,
} from "./kit-signature";

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
 *
 * It is a workspace file the agent can write, so it counts only with the host's signature
 * over its fields and over the bytes of the files it names (see kit-signature.ts).
 */
interface KitMeta {
	version: 1;
	/** Workspace this signature was made for. A copy into another workspace does not match. */
	workspace: string;
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
	jsSha256: string;
	/** "" when there is no CSS. */
	cssSha256: string;
	/** Hex HMAC of the fields above. */
	signature: string;
}

/** A verified meta and the exact bytes its signature covers. */
interface ServedKit {
	meta: KitMeta;
	js: Uint8Array;
	css: Uint8Array | null;
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
// `style.css` is what Vite before 6 calls a library's stylesheet. It is accepted in a
// signature so an older record still parses; a new build publishes `kit-<generation>.css`.
const BUNDLE_CSS = /^(?:kit-[0-9a-f]{12}|kit|style)\.css$/;
const LEFTOVER = /^(?:kit(?:-[0-9a-f]{12})?\.(?:js|css)|style\.css)$/;
const WORKSPACE_KEY = /^[^\0/\\]{1,128}$/;

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
		// Bundles built before they were named after their inputs. Still only with a
		// signature: an unsigned meta is never served, whatever file it names.
		const js = raw.js === undefined ? INTELLIGENT_UI_KIT_LEGACY_BUNDLE : raw.js;
		const css = raw.css === undefined ? null : raw.css;
		if (
			raw.version !== 1 ||
			typeof raw.workspace !== "string" ||
			!WORKSPACE_KEY.test(raw.workspace) ||
			typeof raw.fingerprint !== "string" ||
			typeof raw.hash !== "string" ||
			raw.hash.length > 64 ||
			typeof raw.builtAt !== "string" ||
			!Array.isArray(raw.components) ||
			raw.components.length > LIMITS.components ||
			!raw.components.every((name) => typeof name === "string" && name.length <= 64) ||
			typeof raw.hasSetup !== "boolean" ||
			typeof raw.generation !== "number" ||
			!Number.isSafeInteger(raw.generation) ||
			raw.generation < 0 ||
			typeof raw.jsSha256 !== "string" ||
			typeof raw.cssSha256 !== "string" ||
			typeof raw.signature !== "string" ||
			// These become paths the host reads: bare, expected names only.
			typeof js !== "string" ||
			(js !== INTELLIGENT_UI_KIT_LEGACY_BUNDLE && !BUNDLE_JS.test(js)) ||
			(css !== null && (typeof css !== "string" || !BUNDLE_CSS.test(css)))
		)
			return undefined;
		return {
			version: 1,
			workspace: raw.workspace,
			fingerprint: raw.fingerprint,
			hash: raw.hash,
			builtAt: raw.builtAt,
			components: raw.components as string[],
			hasSetup: raw.hasSetup,
			js,
			css: css as string | null,
			generation: raw.generation,
			jsSha256: raw.jsSha256,
			cssSha256: raw.cssSha256,
			signature: raw.signature,
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

/** Like `readBounded`, but a file over its limit is simply not there. */
async function readServedFile(
	backend: ExecutionBackend,
	path: string,
	maxBytes: number,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<Uint8Array | null> {
	try {
		return await readBounded(backend, path, maxBytes, authorize, signal);
	} catch (error) {
		if (error instanceof AppError && error.statusCode === 413) return null;
		throw error;
	}
}

/**
 * The host's signature over the metadata, plus a stat that the named files exist.
 *
 * This is the status path (every render, every kit overview). It must not read the
 * bundle: that is up to 8 MiB of JS and 2 MiB of CSS, and hashing it here would put
 * that IO on every chat turn. The signature proves the host wrote this record. The
 * bytes themselves are checked in `readServedBundle`, the only path that sends them
 * to a browser. A file swapped after signing still fails there.
 */
async function readSignedMeta(
	backend: ExecutionBackend,
	location: KitLocation,
	authorize: AuthorizeFile,
	signal: AbortSignal,
	boundWorkspace: string,
): Promise<KitMeta | undefined> {
	const meta = parseMeta(
		await readServedFile(backend, location.metaPath, 64 * 1024, authorize, signal),
	);
	if (!meta) return undefined;
	const signed = await verifyKitFields(meta, meta.signature);
	// The signature names its workspace. Another workspace's copy verifies under this
	// host's key and still must not be served here.
	if (!signed || meta.workspace !== boundWorkspace) return undefined;
	const named = async (name: string, maxBytes: number) => {
		const stat = await backend.statFile(backend.paths.resolve(location.distDir, name), {
			signal,
			timeoutMs: 15_000,
		});
		return Boolean(stat?.isFile && stat.size > 0 && stat.size <= maxBytes);
	};
	if (!(await named(meta.js, LIMITS.bundleJsBytes))) return undefined;
	if (meta.css && !(await named(meta.css, LIMITS.bundleCssBytes))) return undefined;
	return meta;
}

/**
 * The bundle the host signed, if those are still the bytes on disk. Anything else
 * (no signature, a different file, a missing one, edited metadata) is "nothing
 * built", not an error.
 */
async function readServedBundle(
	backend: ExecutionBackend,
	location: KitLocation,
	authorize: AuthorizeFile,
	signal: AbortSignal,
	boundWorkspace: string,
): Promise<ServedKit | undefined> {
	const meta = await readSignedMeta(backend, location, authorize, signal, boundWorkspace);
	if (!meta) return undefined;
	const file = (name: string, maxBytes: number) =>
		readServedFile(
			backend,
			backend.paths.resolve(location.distDir, name),
			maxBytes,
			authorize,
			signal,
		);
	const js = await file(meta.js, LIMITS.bundleJsBytes);
	if (!js || kitFileSha256(js) !== meta.jsSha256) return undefined;
	const css = meta.css ? await file(meta.css, LIMITS.bundleCssBytes) : null;
	if (meta.css && (!css || kitFileSha256(css) !== meta.cssSha256)) return undefined;
	if (!meta.css && meta.cssSha256 !== "") return undefined;
	return { meta, js, css };
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
	const served = await readSignedMeta(
		backend,
		location,
		authorize,
		signal,
		workspaceKey(workspace),
	);
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
	const served = await readServedBundle(
		backend,
		location,
		authorize,
		signal,
		workspaceKey(workspace),
	);
	if (!served) throw uiError("This workspace has no built component kit", 404);
	// Exactly the bytes the signature was checked against, not a second read.
	const { meta, js, css } = served;
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

export interface KitBuildRun {
	command: string;
	cwd: string;
	/** Where the command has to write the bundle. */
	bundlePath: string;
	signal: AbortSignal;
}

export interface KitBuildOptions {
	/** Called before each generated file is written. */
	authorizeWrite(path: string): Promise<void>;
	authorize: AuthorizeFile;
	signal: AbortSignal;
	/**
	 * Runs the build command in place of the backend. A host and test seam only: what it
	 * writes gets signed, so nothing the agent controls may supply it.
	 */
	runCommand?(request: KitBuildRun): Promise<{ code: number; log: string }>;
}

let activeBuilds = 0;

async function execBuild(
	backend: ExecutionBackend,
	request: KitBuildRun,
): Promise<{ code: number; log: string }> {
	const handle = await backend.execCommand({
		command: request.command,
		cwd: request.cwd,
		signal: request.signal,
		// NODE_ENV is pinned, not inherited: the host may run as development or
		// test, and Vite would then compile the components with the development
		// JSX runtime while the bundle's React is the production build. The two
		// do not fit together, and the bundle fails only when a component renders.
		env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NODE_ENV: "production" },
	});
	const decoder = new TextDecoder();
	let log = "";
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
	// null is a signal exit: a failure like any other non-zero code.
	if (!timedOut) return { code: code ?? -1, log };
	return { code: -1, log: `${log}\nBuild stopped after ${LIMITS.buildTimeoutMs / 1000} seconds.` };
}

/**
 * Drop whatever is already in the staging directory. A file that survives the removal
 * is remembered, so a later build cannot sign bytes it did not write.
 */
async function clearStaging(
	backend: ExecutionBackend,
	stagingDir: string,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<Map<string, { size: number; sha256: string }>> {
	const survivors = new Map<string, { size: number; sha256: string }>();
	let entries: Awaited<ReturnType<ExecutionBackend["listDir"]>>;
	try {
		entries = await backend.listDir(stagingDir);
	} catch {
		return survivors;
	}
	for (const entry of entries) {
		if (entry.isDirectory) continue;
		const path = backend.paths.resolve(stagingDir, entry.name);
		await backend.removeFile(path).catch(() => {});
		signal.throwIfAborted();
		const left = await backend.statFile(path, { signal, timeoutMs: 15_000 });
		if (!left?.isFile) continue;
		const bytes = await readServedFile(
			backend,
			path,
			Math.max(LIMITS.bundleJsBytes, LIMITS.bundleCssBytes),
			authorize,
			signal,
		);
		survivors.set(entry.name, {
			size: bytes?.length ?? left.size,
			sha256: bytes ? kitFileSha256(bytes) : "",
		});
	}
	return survivors;
}

function keptFromBefore(
	survivors: Map<string, { size: number; sha256: string }>,
	name: string,
	bytes: Uint8Array,
): boolean {
	const prior = survivors.get(name);
	if (!prior) return false;
	// Unreadable leftover: nothing this build is allowed to produce can be told from it.
	if (!prior.sha256) return true;
	return prior.size === bytes.length && prior.sha256 === kitFileSha256(bytes);
}

/**
 * Generate the entry and Vite config from kit.json, run the project's own Vite once,
 * and record what it produced under the host's signature.
 *
 * Vite writes into `.staging`, which is emptied first and is not served. `dist/` is
 * updated only after that output has been copied under a new name and the metadata
 * naming it has been signed. A build that fails, times out or is cancelled therefore
 * leaves the kit the workspace was using exactly as it was, stylesheet included.
 *
 * The single-build lock is held from before the generation is chosen until that
 * metadata is written, so a second build cannot delete or reuse the files of the first.
 */
export async function buildKit(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	options: KitBuildOptions,
): Promise<KitBuildResult> {
	if (activeBuilds >= 1)
		throw uiError("Another component kit build is running; retry shortly", 429);
	activeBuilds++;
	try {
		return await buildKitLocked(backend, workspace, options);
	} finally {
		activeBuilds--;
	}
}

async function buildKitLocked(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	options: KitBuildOptions,
): Promise<KitBuildResult> {
	const { authorize, signal } = options;
	const boundWorkspace = workspaceKey(workspace);
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
	const previous = await readSignedMeta(backend, location, authorize, signal, boundWorkspace);
	const print = await fingerprint(backend, location, manifest, manifestBytes, authorize, signal);
	const generation = (previous?.generation ?? 0) + 1;
	// Same inputs and same generation give the same name, so a retry after a failed
	// attempt lands where this build looks; a successful build moves the generation on,
	// so the next one never overwrites it.
	const name = intelligentUiKitBundleName(sha256(print, String(generation)));
	if (!INTELLIGENT_UI_KIT_BUNDLE_NAME.test(name)) throw uiError("Invalid kit bundle name", 500);
	const bundleFile = `${name}.js`;
	const cssFile = `${name}.css`;
	const stagingDir = backend.paths.resolve(location.kitDir, INTELLIGENT_UI_KIT_STAGING);
	const bundlePath = backend.paths.resolve(stagingDir, bundleFile);
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
	const unchanged = async (log: string): Promise<KitBuildResult> => {
		await clearStaging(backend, stagingDir, authorize, signal).catch(() => {});
		return {
			ok: false,
			log: log.trim(),
			command,
			bundle,
			manifest,
			status: (await readKit(backend, workspace, authorize, signal)).status,
		};
	};
	// The one way to a signed meta: this call ran the build, it succeeded, and the
	// bytes copied out of staging are what that run wrote. dist/ is not a source.
	await options.authorizeWrite(stagingDir);
	await options.authorizeWrite(location.distDir);
	await backend.mkdirp(stagingDir);
	await backend.mkdirp(location.distDir);
	const survivors = await clearStaging(backend, stagingDir, authorize, signal);
	const request: KitBuildRun = { command, cwd: projectRoot, bundlePath, signal };
	const run = options.runCommand
		? await options.runCommand(request)
		: await execBuild(backend, request);
	const log = run.log.slice(-LIMITS.buildLogBytes).trim();
	if (run.code !== 0) return unchanged(log);
	const built = await backend.statFile(bundlePath, { signal, timeoutMs: 15_000 });
	if (!built?.isFile || built.size === 0)
		return unchanged(`${log}\nThe build did not produce ${bundle}.`);
	if (built.size > LIMITS.bundleJsBytes)
		return unchanged(
			`${log}\nThe bundle is ${built.size} bytes; the limit is ${LIMITS.bundleJsBytes}. List fewer components.`,
		);
	const js = await readServedFile(backend, bundlePath, LIMITS.bundleJsBytes, authorize, signal);
	if (!js?.length) return unchanged(`${log}\nThe build did not produce ${bundle}.`);
	if (keptFromBefore(survivors, bundleFile, js))
		return unchanged(
			`${log}\nThe build did not produce ${bundle}: the file there was not written by this build.`,
		);
	let stagedNames: string[] = [];
	try {
		stagedNames = (await backend.listDir(stagingDir))
			.filter((entry) => !entry.isDirectory)
			.map((entry) => entry.name);
	} catch {
		stagedNames = [];
	}
	// Vite names the stylesheet after `cssFileName` (>= 6) or `style.css` (older).
	// Either way it is read from staging and published under this build's own name.
	const cssSource = stagedNames.includes(cssFile)
		? cssFile
		: stagedNames.includes("style.css")
			? "style.css"
			: null;
	const cssBytes = cssSource
		? await readServedFile(
				backend,
				backend.paths.resolve(stagingDir, cssSource),
				LIMITS.bundleCssBytes,
				authorize,
				signal,
			)
		: null;
	if (cssSource && !cssBytes)
		return unchanged(
			`${log}\nThe stylesheet ${cssSource} is missing or over its ${LIMITS.bundleCssBytes}-byte limit.`,
		);
	if (cssSource && cssBytes && keptFromBefore(survivors, cssSource, cssBytes))
		return unchanged(
			`${log}\nThe build did not produce ${bundle}: the stylesheet there was not written by this build.`,
		);
	const publishedCss = cssBytes ? cssFile : null;
	await options.authorizeWrite(backend.paths.resolve(location.distDir, bundleFile));
	await backend.writeFileBytes(backend.paths.resolve(location.distDir, bundleFile), js, {
		signal,
		timeoutMs: 30_000,
	});
	if (cssBytes && publishedCss) {
		await options.authorizeWrite(backend.paths.resolve(location.distDir, publishedCss));
		await backend.writeFileBytes(backend.paths.resolve(location.distDir, publishedCss), cssBytes, {
			signal,
			timeoutMs: 30_000,
		});
	}
	const builtAt = new Date().toISOString();
	const fields: KitSignedFields = {
		version: 1,
		workspace: boundWorkspace,
		fingerprint: print,
		hash: sha256(print, builtAt, String(js.length)).slice(0, 20),
		builtAt,
		components: manifest.components.map((component) => component.name),
		hasSetup: manifest.setup !== undefined,
		js: bundleFile,
		css: publishedCss,
		generation,
		jsSha256: kitFileSha256(js),
		cssSha256: cssBytes ? kitFileSha256(cssBytes) : "",
	};
	const meta: KitMeta = { ...fields, signature: await signKitFields(fields) };
	await options.authorizeWrite(location.metaPath);
	await backend.writeFileBytes(
		location.metaPath,
		encoder.encode(JSON.stringify(meta, null, "\t")),
		{
			signal,
			timeoutMs: 30_000,
		},
	);
	await clearStaging(backend, stagingDir, authorize, signal).catch(() => {});
	// Only now are earlier bundles garbage. Best effort: a leftover costs disk space, a
	// failure here must not turn a finished build into an error. `style.css` is included
	// so a Vite < 6 name left in dist/ cannot shadow a later build.
	let published: string[] = [];
	try {
		published = (await backend.listDir(location.distDir))
			.filter((entry) => !entry.isDirectory)
			.map((entry) => entry.name);
	} catch {
		published = [];
	}
	for (const file of published) {
		if (!LEFTOVER.test(file) || file === meta.js || file === meta.css) continue;
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
