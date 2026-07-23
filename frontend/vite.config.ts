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
import { createShikiLanguageAliasMap } from "./build/shiki-language-aliases";

const vitePort = Number(process.env.VITE_PORT) || 7778;
const backendPort = Number(process.env.BACKEND_PORT) || 7779;
const frontendOutDir = resolve(__dirname, "..", "dist", "frontend");
const SHIKI_LANGUAGE_ALIASES_ID = "virtual:shiki-language-aliases";
const RESOLVED_SHIKI_LANGUAGE_ALIASES_ID = `\0${SHIKI_LANGUAGE_ALIASES_ID}`;

const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
const appVersion = pkg.version ?? "0.0.0";

/** Collect direct dependency license info at build time. */
function collectLicenses() {
	const deps = pkg.dependencies ?? {};
	const devDeps = pkg.devDependencies ?? {};
	const all = { ...deps, ...devDeps };
	const nodeModules = resolve(__dirname, "..", "node_modules");
	const results: Array<{
		name: string;
		version: string;
		license: string;
		author: string;
		repository: string;
		isDev: boolean;
		licenseText: string;
	}> = [];

	const licenseFileNames = [
		"LICENSE",
		"LICENSE.md",
		"LICENSE.txt",
		"license",
		"license.md",
		"LICENCE",
		"LICENCE.md",
		"License",
		"LICENSE-MIT",
		"LICENSE-APACHE",
	];

	for (const name of Object.keys(all)) {
		try {
			const depPkgPath = join(nodeModules, name, "package.json");
			if (!existsSync(depPkgPath)) continue;
			const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
			const repo = depPkg.repository?.url ?? depPkg.repository ?? depPkg.homepage ?? "";
			let repoStr = (typeof repo === "string" ? repo : (repo.url ?? ""))
				.replace(/^git\+/, "")
				.replace(/^git:\/\//, "https://")
				.replace(/\.git$/, "");
			// Convert GitHub shorthand "user/repo" to full URL
			if (repoStr && !repoStr.includes("://")) {
				repoStr = `https://github.com/${repoStr}`;
			}

			let licenseText = "";
			const depDir = join(nodeModules, name);
			for (const candidate of licenseFileNames) {
				const lp = join(depDir, candidate);
				if (existsSync(lp)) {
					licenseText = readFileSync(lp, "utf8");
					break;
				}
			}

			results.push({
				name,
				version: depPkg.version ?? "",
				license: depPkg.license ?? "UNKNOWN",
				author: typeof depPkg.author === "string" ? depPkg.author : (depPkg.author?.name ?? ""),
				repository: repoStr,
				isDev: name in devDeps,
				licenseText,
			});
		} catch {
			// skip unreadable packages
		}
	}
	return results;
}

const licenseData = collectLicenses();

/** Inject only Shiki's serializable alias -> canonical asset id map. */
function shikiLanguageAliases(): Plugin {
	const aliases = createShikiLanguageAliasMap(bundledLanguagesInfo, bundledLanguagesAlias);
	const source = `export default ${JSON.stringify(aliases)};`;

	return {
		name: "narrafork-shiki-language-aliases",
		resolveId(id) {
			return id === SHIKI_LANGUAGE_ALIASES_ID ? RESOLVED_SHIKI_LANGUAGE_ALIASES_ID : null;
		},
		load(id) {
			return id === RESOLVED_SHIKI_LANGUAGE_ALIASES_ID ? source : null;
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
			__LICENSE_DATA__: JSON.stringify(licenseData),
		},
		plugins: [
			shikiLanguageAliases(),
			shikiRuntimeAssets(),
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
