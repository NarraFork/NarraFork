import { resolve } from "node:path";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(__dirname),
	plugins: [
		TanStackRouterVite({
			target: "react",
			autoCodeSplitting: true,
			routesDirectory: resolve(__dirname, "routes"),
			generatedRouteTree: resolve(__dirname, "routeTree.gen.ts"),
		}),
		react(),
	],
	build: {
		outDir: resolve(__dirname, "..", "dist", "frontend"),
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: "http://localhost:7778",
				changeOrigin: true,
			},
			"/ws": {
				target: "ws://localhost:7778",
				ws: true,
			},
		},
	},
	resolve: {
		alias: {
			"@frontend": resolve(__dirname),
		},
	},
});
