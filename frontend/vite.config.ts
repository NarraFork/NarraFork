import { resolve } from "node:path";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const vitePort = Number(process.env.VITE_PORT) || 7778;
const backendPort = Number(process.env.BACKEND_PORT) || 7779;

export default defineConfig(({ mode }) => {
	const isDev = mode === "development";
	const appName = isDev ? "NarraFork Dev" : "NarraFork";
	const shortName = isDev ? "NarraFork Dev" : "NarraFork";

	return {
		root: resolve(__dirname),
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
			proxy: {
				"/api": {
					target: `http://localhost:${backendPort}`,
					changeOrigin: true,
				},
				"/ws": {
					target: `ws://localhost:${backendPort}`,
					ws: true,
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
