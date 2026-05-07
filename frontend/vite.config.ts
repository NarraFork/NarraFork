import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const vitePort = Number(process.env.VITE_PORT) || 7778;
const backendPort = Number(process.env.BACKEND_PORT) || 7779;

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

export default defineConfig(({ mode, command }) => {
	const isDev = mode === "development";
	const isServe = command === "serve";
	const appName = isDev ? "NarraFork Dev" : "NarraFork";
	const shortName = isDev ? "NarraFork Dev" : "NarraFork";

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
			TanStackRouterVite({
				target: "react",
				autoCodeSplitting: true,
				routesDirectory: resolve(__dirname, "routes"),
				generatedRouteTree: resolve(__dirname, "routeTree.gen.ts"),
			}),
			react(),
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
						"assets/**/*.{js,css,woff,woff2,ttf,png,svg}",
					],
					maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
				},
			}),
		],
		// Target Safari 14+ to support iPadOS / older macOS WebKit views
		// used when accessing NarraFork as a PWA or via in-app browsers.
		oxc: {
			target: "es2020",
		},
		build: {
			target: ["es2020", "safari14"],
			outDir: resolve(__dirname, "..", "dist", "frontend"),
			emptyOutDir: true,
			rolldownOptions: {
				output: {
					manualChunks(id) {
						if (id.includes("@xterm/xterm") || id.includes("@xterm/addon-fit")) {
							return "xterm";
						}
					},
				},
			},
		},
		server: {
			port: vitePort,
			host: "0.0.0.0",
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
