/**
 * Builds the shared plugin UI runtime (React + Mantine) that plugin panels load.
 *
 * Kept out of `vite.config.ts` so the same build function serves both paths it needs to
 * cover: the dev middleware and the production `emitFile`. A plugin panel that only worked
 * in one of them would be worse than not having the runtime at all, because the failure
 * shows up as an unstyled panel rather than an error.
 *
 * ## Why a separate bundler run instead of a second Vite entry
 *
 * Adding `frontend/plugin-runtime/vendor.ts` to `rolldownOptions.input` would pull it into
 * the app's own graph: code splitting would share chunks between the app and the runtime,
 * `modulePreload` would reference them from `index.html`, and the PWA manifest logic in
 * `vite.config.ts` would try to precache them. All of that is wrong here — the runtime is a
 * self-contained IIFE loaded by an iframe, not part of the app shell, and it must not be
 * fetched by users who never open a plugin panel.
 *
 * `format: "iife"` is required: the iframe has no module loader, and the shell injects the
 * file with a plain `<script src>`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLUGIN_UI_RUNTIME_CSS_PATH, PLUGIN_UI_RUNTIME_JS_PATH } from "../plugin-runtime/paths";

export interface PluginUiRuntimeBundle {
	js: string;
	css: string;
}

export { PLUGIN_UI_RUNTIME_CSS_PATH, PLUGIN_UI_RUNTIME_JS_PATH };

/** The subset of a resolved Vite config this module needs to classify a build. */
export interface PluginUiRuntimeBuildConfig {
	build: { lib?: unknown; ssr?: unknown };
}

/**
 * Whether this build is the main application build, i.e. the one whose `outDir` the runtime
 * belongs in.
 *
 * `vite-plugin-pwa`'s `injectManifest` starts a NESTED Vite library build for the service
 * worker that writes into the same `outDir` with `emptyOutDir: false`. Emitting from there
 * would re-run this ~800 KB React + Mantine bundle only to overwrite byte-identical files —
 * invisible except as a slower build. Whether the nested build inherits this plugin depends
 * on the PWA plugin's own filtering (with the pinned version it does not, so the guard is
 * currently inert), but that filtering is not an API contract, and
 * `captureFinalAppShellHtml` in `vite.config.ts` already needs the same check for the same
 * reason.
 *
 * It lives here rather than inline so the rule is testable without importing the Vite config,
 * which scans `node_modules` for licenses at import time.
 */
export function isMainApplicationBuild(config: PluginUiRuntimeBuildConfig): boolean {
	return !config.build.lib && !config.build.ssr;
}

const ENTRY = resolve(import.meta.dir ?? __dirname, "..", "plugin-runtime", "vendor.ts");

/**
 * Bundle the runtime once.
 *
 * `minify` is on even though committed plugin artifacts are deliberately unminified: this
 * output is generated at build time and never reviewed as a diff, and it is the largest
 * thing an iframe loads (~819 KB minified against ~1.6 MB unminified).
 *
 * `NODE_ENV=production` matters beyond size — without it React ships development warnings
 * and its slower dev-only paths.
 */
export async function buildPluginUiRuntime(): Promise<PluginUiRuntimeBundle> {
	const outDir = await mkdtemp(join(tmpdir(), "narrafork-plugin-runtime-"));
	try {
		await runBunBuild(outDir);
		// `import "@mantine/core/styles.css"` makes this a two-output build: one entry point and
		// one CSS asset. Both are required, so a missing one is a build error rather than
		// something to paper over with an empty string.
		const [js, css] = await Promise.all([
			readFile(join(outDir, "vendor.js"), "utf8"),
			readFile(join(outDir, "vendor.css"), "utf8"),
		]);
		return { js, css };
	} finally {
		await rm(outDir, { recursive: true, force: true });
	}
}

/**
 * Wall-clock ceiling for one runtime build.
 *
 * Bundling React + Mantine takes a couple of seconds on a warm machine; a minute means the
 * subprocess is wedged (a hung install, an unreadable FS, a `bun` that is waiting on stdin
 * we never write). Without a bound, the dev middleware's request and the production
 * `generateBundle` both hang forever with no output, which reads as "the build is slow"
 * rather than as a failure.
 */
const BUILD_TIMEOUT_MS = 60_000;

/**
 * Resolve the `bun` executable to run the build with.
 *
 * Bare `"bun"` relies on PATH, which is not a safe assumption everywhere this runs: a
 * compiled binary or a restricted CI shell can have a `bun` that is absent or a different
 * version than the one executing this code. `process.execPath` is that exact interpreter when
 * we are already under Bun, so prefer it and fall back through `Bun.which` to PATH.
 *
 * `Bun` is guarded because this module also runs inside Vite's rolldown worker, where the
 * global does not exist (see `runBunBuild`).
 */
function resolveBunExecutable(): string {
	const execPath = process.execPath;
	if (execPath && /(?:^|[\\/])bun(?:\.exe)?$/i.test(execPath)) return execPath;
	const viaWhich = typeof Bun === "undefined" ? null : Bun.which("bun");
	return viaWhich ?? "bun";
}

/**
 * Run the build in a `bun build` subprocess.
 *
 * The obvious implementation is `Bun.build`, and that is what this was. It fails in the
 * production path: Vite's rolldown runs plugin hooks on a worker where the `Bun` global does
 * not exist, so `generateBundle` died with `ReferenceError: Bun is not defined` while the dev
 * middleware — running on the main thread — worked fine. A build step that only works in dev
 * is worse than none, because the artifact silently goes missing from the shipped frontend.
 *
 * A subprocess is indifferent to which thread called it, so both paths use one code path.
 */
async function runBunBuild(outDir: string): Promise<void> {
	const args = [
		"build",
		ENTRY,
		`--outdir=${outDir}`,
		"--target=browser",
		"--format=iife",
		"--minify",
		"--define",
		// Without this React ships its development build: larger, slower, and noisy with
		// warnings that make no sense from inside a plugin panel.
		`process.env.NODE_ENV=${JSON.stringify("production")}`,
	];
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(resolveBunExecutable(), args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolvePromise();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(
				new Error(
					`Plugin UI runtime build timed out after ${BUILD_TIMEOUT_MS}ms:\n${stderr || "(no output)"}`,
				),
			);
		}, BUILD_TIMEOUT_MS);
		// Do not hold the process open on the timer alone: a caller that already gave up
		// should not keep a dev server or build alive until the timeout elapses.
		timer.unref?.();
		// Bounded: a runaway compiler error must not accumulate without limit.
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 64 * 1024) stderr += chunk.toString();
		});
		child.stdout?.resume();
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(`Plugin UI runtime build failed (exit ${String(code)}):\n${stderr}`));
		});
	});
}
