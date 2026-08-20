import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { bundledLanguagesAlias, bundledLanguagesInfo } from "shiki";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import {
	assertAppShellJavaScriptIsPrecached,
	type EmittedBundle,
	extractEmittedHtml,
	filterAppShellManifest,
} from "./build/app-shell-precache";
import {
	buildPluginUiRuntime,
	isMainApplicationBuild as isMainPluginRuntimeBuild,
	PLUGIN_UI_RUNTIME_CSS_PATH,
	PLUGIN_UI_RUNTIME_JS_PATH,
	type PluginUiRuntimeBundle,
} from "./build/plugin-ui-runtime";
import { createShikiLanguageAliasMap } from "./build/shiki-language-aliases";

const vitePort = Number(process.env.VITE_PORT) || 7778;
const backendPort = Number(process.env.BACKEND_PORT) || 7779;
const frontendOutDir = resolve(__dirname, "..", "dist", "frontend");
/**
 * Path of the module `shikiLanguageAliases()` substitutes, normalized to forward
 * slashes. Vite hands `load()` ids with `/` separators even on Windows, while
 * `resolve()` there returns `\` — comparing the two raw would silently never
 * match, letting the real `shiki/langs` registry (hundreds of grammar chunks)
 * back into the browser graph with no error to notice.
 */
const SHIKI_LANGUAGE_ALIASES_MODULE = normalizeModulePath(
	resolve(__dirname, "lib/shiki-language-aliases.ts"),
);

/** Separator-agnostic module path for comparing against Vite/Rollup ids. */
function normalizeModulePath(path: string): string {
	return path.replace(/\\/g, "/");
}

const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
const appVersion = pkg.version ?? "0.0.0";

/**
 * Replace `lib/shiki-language-aliases.ts` with the precomputed alias map.
 *
 * The real module derives the map from `shiki/langs`, whose `bundledLanguagesInfo`
 * carries a `() => import(...)` loader per grammar. Letting that registry into the
 * browser graph makes Rolldown treat hundreds of grammar chunks as dynamic
 * dependencies and preload them on the narrator route. Substituting a plain object
 * literal here keeps `shiki/langs` out of the bundle while leaving the module
 * resolvable for Bun, tests and type checking (see that file's header).
 */
function shikiLanguageAliases(): Plugin {
	const aliases = createShikiLanguageAliasMap(bundledLanguagesInfo, bundledLanguagesAlias);
	const source = `export const SHIKI_LANGUAGE_ALIASES = ${JSON.stringify(aliases)};`;
	let substituted = false;

	return {
		name: "narrafork-shiki-language-aliases",
		enforce: "pre",
		load(id) {
			// `id` may carry a query suffix (?used, ?v=) — compare the path only,
			// with separators normalized so Windows matches too.
			const path = normalizeModulePath(id.split("?")[0] ?? "");
			if (path !== SHIKI_LANGUAGE_ALIASES_MODULE) return null;
			substituted = true;
			return source;
		},
		/**
		 * Fail the build if the substitution silently stopped working.
		 *
		 * Every failure mode here is invisible at runtime: a moved/renamed module, a
		 * resolved id that no longer matches (symlinked root, a future separator quirk),
		 * or dep pre-bundling taking a different path. The app still works — it just
		 * quietly ships `shiki/langs` and preloads hundreds of grammar chunks on the
		 * narrator route. Without this check nobody would notice until someone profiled
		 * the bundle, so turn it into a hard error at the only point where we can still
		 * observe both facts: whether `load()` fired, and what actually got emitted.
		 */
		generateBundle(_options, bundle) {
			if (!substituted) {
				this.error(
					`narrafork-shiki-language-aliases never matched ${SHIKI_LANGUAGE_ALIASES_MODULE}. ` +
						"The module was probably moved or renamed — update SHIKI_LANGUAGE_ALIASES_MODULE, " +
						"otherwise shiki/langs ships to the browser with hundreds of grammar chunks.",
				);
				return;
			}
			// `bundledLanguagesInfo` is the registry whose per-grammar dynamic imports cause
			// the chunk explosion; its presence in any emitted chunk means it leaked in
			// through some other import path.
			for (const [fileName, output] of Object.entries(bundle)) {
				if (output.type !== "chunk") continue;
				if (!output.code.includes("bundledLanguagesInfo")) continue;
				this.error(
					`shiki/langs leaked into ${fileName}: the emitted bundle still references ` +
						"bundledLanguagesInfo. Find the import that pulls shiki/langs into the browser " +
						"graph — leaving it in preloads hundreds of grammar chunks on the narrator route.",
				);
				return;
			}
		},
	};
}

/**
 * Watch `shared/` explicitly — it sits OUTSIDE the Vite `root` (`frontend/`).
 *
 * Out-of-root modules are served fine (via `/@fs/…`) but the dev server's watcher
 * does not pick them up, so the transform result is cached for the lifetime of the
 * process: editing `shared/**` leaves the browser importing the PREVIOUS version.
 * The failure is silent and misleading — a newly added export shows up as
 * "does not provide an export named 'X'" even though the file on disk has it, and
 * disk-based checks (`bun test`, `tsgo`) all pass because they never consult the
 * dev server's graph. Adding the directory to the watcher makes an edit under
 * `shared/` invalidate the module the same way an in-root edit does.
 */
function watchSharedDirectory(): Plugin {
	const sharedDir = resolve(__dirname, "..", "shared");
	return {
		name: "narrafork-watch-shared",
		apply: "serve",
		configureServer(server) {
			server.watcher.add(sharedDir);
		},
	};
}

/**
 * Vite 8/Rolldown closes the input build before output hooks run. Move PWA's SW
 * generation to writeBundle so final emitted HTML can be captured first.
 */
function deferPwaServiceWorkerBuildUntilWriteBundle(plugins: Plugin[]): Plugin[] {
	const buildPlugin = plugins.find((plugin) => plugin.name === "vite-plugin-pwa:build");
	const closeBundle = buildPlugin?.closeBundle;
	if (!buildPlugin || !closeBundle) {
		throw new Error("vite-plugin-pwa build plugin is missing its closeBundle hook");
	}

	const closeBundleHandler = (
		typeof closeBundle === "function" ? closeBundle : closeBundle.handler
	) as (this: object, error?: Error) => void | Promise<void>;
	const order = typeof closeBundle === "object" ? closeBundle.order : undefined;
	buildPlugin.closeBundle = undefined;
	buildPlugin.writeBundle = {
		order,
		sequential: true,
		async handler() {
			await closeBundleHandler.call(this);
		},
	};

	return plugins;
}

function captureFinalAppShellHtml(setHtml: (html: string | null) => void): Plugin {
	let isMainApplicationBuild = false;
	const capture = (bundle: EmittedBundle) => {
		if (!isMainApplicationBuild) return;
		const html = extractEmittedHtml(bundle);
		if (html != null) setHtml(html);
	};

	return {
		name: "narrafork-capture-final-app-shell-html",
		enforce: "post",
		apply: "build",
		configResolved(config) {
			// injectManifest starts a nested Vite library build for src-sw.ts. Never let
			// that build reset or replace the HTML captured from the main application.
			isMainApplicationBuild = !config.build.lib && !config.build.ssr;
		},
		buildStart() {
			if (isMainApplicationBuild) setHtml(null);
		},
		generateBundle(_options, bundle) {
			capture(bundle);
		},
		writeBundle(_options, bundle) {
			capture(bundle);
		},
	};
}

/**
 * Serve Shiki grammars/themes as standalone runtime assets. Keeping these files
 * outside Rollup's module graph prevents route-level modulepreload from seeing
 * every language while still allowing the highlighter to import one on demand.
 */
/**
 * Serve and emit the shared plugin UI runtime (React + Mantine) that plugin panels load.
 *
 * Modelled on `shikiRuntimeAssets()` below: one plugin covers the dev server (middleware)
 * and the production build (`emitFile`) so there is no path where the runtime exists in one
 * mode and not the other. A plugin panel with a missing runtime renders unstyled rather than
 * erroring, which is exactly the kind of failure that survives review.
 *
 * The two files land at fixed, unhashed paths because the iframe shell references them by
 * constant. Content changes are handled by `Cache-Control: no-cache` plus revalidation
 * instead of by the filename — with a hashed name the shell would need a lookup table, and
 * with a hashed name *and* long caching a host upgrade would keep serving a stale runtime.
 *
 * These paths are outside `assets/`, which keeps them out of the PWA precache globs in
 * `VitePWA` below. That is intended: 1.2 MB should not be fetched by users who never open a
 * plugin panel.
 */
function pluginUiRuntimeAssets(): Plugin {
	// Built lazily and cached: in dev the middleware would otherwise rebundle React and
	// Mantine on every request.
	let cached: Promise<PluginUiRuntimeBundle> | undefined;
	const bundle = () => {
		cached ??= buildPluginUiRuntime();
		return cached;
	};
	let isMainApplicationBuild = false;

	return {
		name: "narrafork-plugin-ui-runtime",
		configResolved(config) {
			// Same guard as `captureFinalAppShellHtml` above, for the same reason: PWA's
			// injectManifest starts a nested Vite library build for src-sw.ts that writes into
			// the same outDir with `emptyOutDir: false`. Emitting from there would re-run the
			// ~800 KB React + Mantine bundle only to overwrite identical files. See the
			// predicate's own comment for why this is kept even though the pinned PWA version
			// does not currently hand this plugin to that build.
			isMainApplicationBuild = isMainPluginRuntimeBuild(config);
		},
		configureServer(server) {
			// Editing the runtime entry (or the shared theme it imports) must invalidate the
			// cache; otherwise a dev session keeps serving the first build forever.
			server.watcher.add(resolve(__dirname, "plugin-runtime"));
			server.watcher.on("all", (_event, file) => {
				const normalized = normalizeModulePath(file);
				if (
					normalized.includes("/frontend/plugin-runtime/") ||
					normalized.endsWith("/frontend/lib/mantine-theme.ts")
				) {
					cached = undefined;
				}
			});

			server.middlewares.use((req, res, next) => {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				const isJs = pathname === `/${PLUGIN_UI_RUNTIME_JS_PATH}`;
				const isCss = pathname === `/${PLUGIN_UI_RUNTIME_CSS_PATH}`;
				if (!isJs && !isCss) {
					next();
					return;
				}
				bundle()
					.then((built) => {
						res.statusCode = 200;
						res.setHeader(
							"Content-Type",
							isJs ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
						);
						// Fixed filenames, so correctness depends on revalidation rather than the URL.
						res.setHeader("Cache-Control", "no-cache");
						res.end(isJs ? built.js : built.css);
					})
					.catch((error: unknown) => {
						res.statusCode = 500;
						res.setHeader("Content-Type", "text/plain; charset=utf-8");
						res.end(`Plugin UI runtime build failed: ${String(error)}`);
					});
			});
		},
		async generateBundle() {
			if (!isMainApplicationBuild) return;
			const built = await bundle();
			this.emitFile({ type: "asset", fileName: PLUGIN_UI_RUNTIME_JS_PATH, source: built.js });
			this.emitFile({ type: "asset", fileName: PLUGIN_UI_RUNTIME_CSS_PATH, source: built.css });
		},
	} satisfies Plugin;
}

function shikiRuntimeAssets(): Plugin {
	const packageRoots = {
		langs: resolve(__dirname, "..", "node_modules/@shikijs/langs/dist"),
		themes: resolve(__dirname, "..", "node_modules/@shikijs/themes/dist"),
	} as const;

	function resolveAsset(kind: keyof typeof packageRoots, fileName: string) {
		if (!/^[a-z0-9_-]+\.mjs$/i.test(fileName)) return null;
		const filePath = join(packageRoots[kind], fileName);
		return existsSync(filePath) ? filePath : null;
	}

	function listAssets(kind: keyof typeof packageRoots) {
		return readdirSync(packageRoots[kind]).filter((fileName) =>
			/^[a-z0-9_-]+\.mjs$/i.test(fileName),
		);
	}

	return {
		name: "narrafork-shiki-runtime-assets",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				const match = pathname.match(/^\/shiki\/(langs|themes)\/([^/]+)$/);
				if (!match) {
					next();
					return;
				}

				const filePath = resolveAsset(match[1] as keyof typeof packageRoots, match[2]);
				if (!filePath) {
					res.statusCode = 404;
					res.end("Not found");
					return;
				}

				res.statusCode = 200;
				res.setHeader("Content-Type", "text/javascript; charset=utf-8");
				res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
				res.end(readFileSync(filePath));
			});
		},
		generateBundle() {
			for (const kind of ["langs", "themes"] as const) {
				for (const fileName of listAssets(kind)) {
					const filePath = resolveAsset(kind, fileName);
					if (!filePath) continue;
					this.emitFile({
						type: "asset",
						fileName: `shiki/${kind}/${fileName}`,
						source: readFileSync(filePath),
					});
				}
			}
		},
	} satisfies Plugin;
}

export default defineConfig(({ mode, command }) => {
	const isDev = mode === "development";
	const isServe = command === "serve";
	const appName = isDev ? "NarraFork Dev" : "NarraFork";
	const shortName = isDev ? "NarraFork Dev" : "NarraFork";
	let finalAppShellHtml: string | null = null;

	return {
		root: resolve(__dirname),
		define: {
			// Inject dev ports whenever running the dev server (regardless of mode)
			// so that WS URL rewriting works in start:dev (production mode + vite serve)
			__DEV_VITE_PORT__: isServe ? JSON.stringify(vitePort) : "undefined",
			__DEV_BACKEND_PORT__: isServe ? JSON.stringify(backendPort) : "undefined",
			__APP_VERSION__: JSON.stringify(appVersion),
		},
		plugins: [
			watchSharedDirectory(),
			shikiLanguageAliases(),
			shikiRuntimeAssets(),
			pluginUiRuntimeAssets(),
			TanStackRouterVite({
				target: "react",
				autoCodeSplitting: true,
				routesDirectory: resolve(__dirname, "routes"),
				generatedRouteTree: resolve(__dirname, "routeTree.gen.ts"),
			}),
			react(),
			captureFinalAppShellHtml((html) => {
				finalAppShellHtml = html;
			}),
			...deferPwaServiceWorkerBuildUntilWriteBundle(
				VitePWA({
					strategies: "injectManifest",
					srcDir: ".",
					filename: "src-sw.ts",
					registerType: "autoUpdate",
					injectRegister: "auto",
					includeAssets: ["favicon.svg", "apple-touch-icon-180x180.png"],
					manifest: {
						name: appName,
						short_name: shortName,
						description: "AI-powered collaborative programming with narrative forking",
						theme_color: "#1a1b1e",
						background_color: "#1a1b1e",
						display: "standalone",
						scope: "/",
						start_url: "/",
						icons: [
							{
								src: "pwa-192x192.png",
								sizes: "192x192",
								type: "image/png",
							},
							{
								src: "pwa-512x512.png",
								sizes: "512x512",
								type: "image/png",
							},
							{
								src: "pwa-512x512.png",
								sizes: "512x512",
								type: "image/png",
								purpose: "maskable",
							},
						],
					},
					injectManifest: {
						// Use IIFE output for the custom service worker to avoid Rolldown's
						// deprecated inlineDynamicImports path in the plugin's ES build mode.
						rollupFormat: "iife",
						globPatterns: [
							"index.html",
							"registerSW.js",
							"manifest.webmanifest",
							"favicon.svg",
							"apple-touch-icon-180x180.png",
							"pwa-*.png",
							// Let Workbox discover JS, then retain only the final HTML's script and
							// modulepreload references. Route-only lazy chunks stay runtime-cached.
							"assets/**/*.js",
							"assets/**/*.{css,woff,woff2,ttf,png,svg}",
						],
						maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
						manifestTransforms: [
							(manifest) => {
								const html =
									finalAppShellHtml ?? readFileSync(join(frontendOutDir, "index.html"), "utf8");
								const filtered = filterAppShellManifest(manifest, html);
								assertAppShellJavaScriptIsPrecached(html, filtered);

								return { manifest: filtered };
							},
						],
					},
				}),
			),
		],
		// Target Safari 14+ to support iPadOS / older macOS WebKit views
		// used when accessing NarraFork as a PWA or via in-app browsers.
		oxc: {
			target: "es2020",
		},
		build: {
			modulePreload: {
				resolveDependencies(filename, deps) {
					if (filename.includes("_narratorId")) return [];
					return deps;
				},
			},
			target: ["es2020", "safari14"],
			outDir: frontendOutDir,
			emptyOutDir: true,
			rolldownOptions: {
				output: {
					// Keep the app shell at medium granularity while leaving heavy route-only
					// dependencies (graph, editor, Markdown, and syntax highlighting) lazy.
					codeSplitting: {
						minSize: 12 * 1024,
						minShareCount: 2,
						groups: [
							{
								name: "framework",
								test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler|use-sync-external-store)[\\/]/,
								priority: 100,
								minSize: 0,
								minShareCount: 2,
							},
							{
								name: "router-query",
								test: /[\\/]node_modules[\\/]@tanstack[\\/](?:react-router|router-core|react-query)[\\/]/,
								priority: 90,
								minSize: 0,
								minShareCount: 2,
							},
							{
								name: "mantine-shell",
								test: /[\\/]node_modules[\\/]@mantine[\\/]core[\\/]esm[\\/]components[\\/](?:ActionIcon|Badge|Button|Center|CloseButton|Collapse|FocusTrap|Group|Input|InputBase|Loader|Menu|Modal|Paper|Popover|Portal|ScrollArea|Stack|Text|Tooltip|Transition|UnstyledButton)[\\/]/,
								priority: 85,
								minSize: 0,
								minShareCount: 2,
							},
							{
								name: "mantine-runtime",
								test: /[\\/]node_modules[\\/](?:@mantine[\\/]hooks[\\/]|@mantine[\\/]core[\\/]esm[\\/]core[\\/]|@floating-ui[\\/]react[\\/])/,
								priority: 80,
								minSize: 0,
								minShareCount: 2,
							},
							{
								name: "terminal",
								test: /[\\/]node_modules[\\/]@xterm[\\/]/,
								priority: 70,
								minSize: 0,
								minShareCount: 1,
							},
						],
					},
				},
			},
		},
		server: {
			port: vitePort,
			host: "0.0.0.0",
			allowedHosts: [
				"narraforkhotreloadorigin.narrafork.dev",
				"nfgotest1.narrafork.dev",
				"nfgocf1.narrafork.dev",
			],
			proxy: {
				"/api": {
					target: `http://localhost:${backendPort}`,
					changeOrigin: true,
				},
				// NOTE: WS proxy via Vite does NOT work when Vite runs under
				// `bunx` because Bun's node:http compat layer mishandles HTTP 101
				// upgrade responses.  In dev mode, frontend/lib/ws.ts detects
				// local direct access and rewrites WS URLs to the backend port.
				// The entry below is kept so that if Vite is ever run with real
				// Node.js, the proxy will work out of the box.
				"/ws": {
					target: `http://localhost:${backendPort}`,
					ws: true,
					changeOrigin: true,
				},
			},
		},
		resolve: {
			alias: {
				"@frontend": resolve(__dirname),
				"@shared": resolve(__dirname, "..", "shared"),
			},
		},
	};
});
