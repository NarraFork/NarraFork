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
		"LICENCE",
		"LICENCE.md",
		"License",
		"LICENSE-MIT",
	];

	for (const name of Object.keys(all)) {
		try {
			const depPkgPath = join(nodeModules, name, "package.json");
			if (!existsSync(depPkgPath)) continue;
			const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
			const repo = depPkg.repository?.url ?? depPkg.repository ?? depPkg.homepage ?? "";
			const repoStr = (typeof repo === "string" ? repo : (repo.url ?? ""))
				.replace(/^git\+/, "")
				.replace(/\.git$/, "");

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

export default defineConfig(({ mode }) => {
	const isDev = mode === "development";
	const appName = isDev ? "NarraFork Dev" : "NarraFork";
	const shortName = isDev ? "NarraFork Dev" : "NarraFork";

	return {
		root: resolve(__dirname),
		define: isDev
			? {
					__DEV_VITE_PORT__: JSON.stringify(vitePort),
					__DEV_BACKEND_PORT__: JSON.stringify(backendPort),
					__APP_VERSION__: JSON.stringify(appVersion),
					__LICENSE_DATA__: JSON.stringify(licenseData),
				}
			: {
					__DEV_VITE_PORT__: "undefined",
					__DEV_BACKEND_PORT__: "undefined",
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
				registerType: "autoUpdate",
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
				workbox: {
					globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
					navigateFallback: "index.html",
					runtimeCaching: [
						{
							urlPattern: /^https?:\/\/.*\/api\//,
							handler: "NetworkOnly",
						},
					],
				},
			}),
		],
		build: {
			outDir: resolve(__dirname, "..", "dist", "frontend"),
			emptyOutDir: true,
			rollupOptions: {
				output: {
					manualChunks: {
						xterm: ["@xterm/xterm", "@xterm/addon-fit"],
					},
				},
			},
			minify: "terser",
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
			},
		},
	};
});
