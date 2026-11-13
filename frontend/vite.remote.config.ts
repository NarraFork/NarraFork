import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { bundledLanguagesAlias, bundledLanguagesInfo } from "shiki";
import { defineConfig, type Plugin } from "vite";
import { editorCodecBuffer } from "./build/editor-codec-buffer";
import { remoteModuleBoundaries } from "./build/remote-boundaries";
import { createShikiLanguageAliasMap } from "./build/shiki-language-aliases";

const root = resolve(import.meta.dirname);
const aliases = createShikiLanguageAliasMap(bundledLanguagesInfo, bundledLanguagesAlias);
function shikiAliases(): Plugin {
	return {
		name: "remote-shiki-aliases",
		enforce: "pre",
		load(id) {
			if (
				id.split("?")[0].replace(/\\/g, "/") ===
				resolve(root, "lib/shiki-language-aliases.ts").replace(/\\/g, "/")
			)
				return `export const SHIKI_LANGUAGE_ALIASES = ${JSON.stringify(aliases)};`;
		},
	};
}
function staticResources(): Plugin {
	return {
		name: "remote-static-resources",
		generateBundle() {
			this.emitFile({
				type: "asset",
				fileName: "index.html",
				source: readFileSync(resolve(root, "remote/index.html")),
			});
			for (const kind of ["langs", "themes"]) {
				const directory = resolve(root, `../node_modules/@shikijs/${kind}/dist`);
				for (const name of readdirSync(directory)) {
					if (/^[a-z0-9_-]+\.mjs$/i.test(name))
						this.emitFile({
							type: "asset",
							fileName: `shiki/${kind}/${name}`,
							source: readFileSync(join(directory, name)),
						});
				}
			}
			for (const name of ["favicon.svg", "pwa-192x192.png", "apple-touch-icon-180x180.png"])
				this.emitFile({
					type: "asset",
					fileName: name,
					source: readFileSync(resolve(root, "public", name)),
				});
		},
	};
}

/** Intentionally does not import the native config, router plugin, PWA or plugin host. */
export default defineConfig({
	root,
	base: "./",
	publicDir: false,
	plugins: [
		remoteModuleBoundaries(root),
		editorCodecBuffer(),
		shikiAliases(),
		staticResources(),
		react(),
	],
	define: {
		__NF_REMOTE_BUILD__: "true",
		__APP_VERSION__: JSON.stringify(
			JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8")).version,
		),
		__DEV_VITE_PORT__: "undefined",
		__DEV_BACKEND_PORT__: "undefined",
	},
	resolve: { alias: { "@frontend": root, "@shared": resolve(root, "../shared") } },
	worker: {
		format: "es",
		plugins: () => [remoteModuleBoundaries(root, false), editorCodecBuffer(), shikiAliases()],
	},
	build: {
		target: ["es2020", "safari14"],
		outDir: resolve(root, "../dist/frontend-remote"),
		emptyOutDir: true,
		manifest: true,
		cssCodeSplit: true,
		modulePreload: {
			resolveDependencies: (_filename, dependencies, context) =>
				context.hostType === "js" ? [] : dependencies,
		},
		rolldownOptions: {
			input: {
				bootstrap: resolve(root, "remote/bootstrap.ts"),
				mount: resolve(root, "remote/mount.tsx"),
			},
			preserveEntrySignatures: "strict",
			output: {
				format: "es",
				entryFileNames: "[name].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
