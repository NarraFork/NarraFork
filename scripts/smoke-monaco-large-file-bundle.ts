import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { build } from "vite";
import { MiB } from "./smoke-monaco-large-file-data";

export function fixtureHtml(base = "/") {
	return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#1e1e1e}</style></head><body><div id="root"></div><script type="module" src="${base}scripts/smoke-monaco-large-file-fixture.tsx"></script></body></html>`;
}
export interface FixtureAsset {
	path: string;
	bytes: number;
	mime: string;
}
export async function buildFixtureBundle(
	root: string,
	reportDir: string,
	base: string,
	htmlEntry = fixtureHtml(),
) {
	const entry = join(reportDir, "fixture.html");
	const directory = join(reportDir, "bundle");
	await writeFile(entry, htmlEntry);
	const start = performance.now();
	const result = await build({
		configFile: false,
		root,
		base,
		mode: "production",
		publicDir: false,
		logLevel: "error",
		cacheDir: join(reportDir, "vite-build-cache"),
		resolve: {
			alias: {
				"@frontend": join(root, "frontend"),
				"@server": join(root, "server"),
				"@shared": join(root, "shared"),
			},
		},
		esbuild: { jsx: "automatic", jsxDev: false },
		define: { "process.env.NODE_ENV": '"production"' },
		worker: { format: "es" },
		build: {
			outDir: directory,
			emptyOutDir: true,
			sourcemap: false,
			reportCompressedSize: false,
			target: "esnext",
			minify: "esbuild",
			rollupOptions: { input: entry },
		},
	});
	const assets = new Map<string, FixtureAsset>();
	const outputs = Array.isArray(result) ? result : [result];
	let html = "";
	let bytes = 0;
	const mime: Record<string, string> = {
		".js": "text/javascript",
		".css": "text/css",
		".woff": "font/woff",
		".woff2": "font/woff2",
		".ttf": "font/ttf",
		".svg": "image/svg+xml",
		".wasm": "application/wasm",
		".json": "application/json",
	};
	for (const output of outputs) {
		if (!("output" in output))
			throw new Error("Fixture build returned a watcher instead of assets");
		for (const asset of output.output) {
			if (asset.fileName.split("/").includes("..")) throw new Error("Unsafe fixture asset path");
			const source = asset.type === "chunk" ? asset.code : asset.source;
			const size = typeof source === "string" ? Buffer.byteLength(source) : source.byteLength;
			bytes += size;
			if (bytes > 64 * MiB || assets.size >= 1024 || size > 32 * MiB)
				throw new Error("Fixture production bundle exceeded its 64MiB / 1024-asset budget");
			if (asset.fileName.endsWith(".html"))
				html = typeof source === "string" ? source : new TextDecoder().decode(source);
			else
				assets.set(`${base}${asset.fileName}`, {
					path: join(directory, asset.fileName),
					bytes: size,
					mime: mime[extname(asset.fileName)] ?? "application/octet-stream",
				});
		}
	}
	if (!html) throw new Error("Fixture build did not emit an HTML entry");
	return {
		html,
		assets,
		metadata: {
			mode: "production",
			base,
			bytes,
			assets: assets.size,
			buildMs: performance.now() - start,
			configFile: false,
			scope: "Standalone production fixture bundle, not the full application/PWA build",
		},
	};
}
