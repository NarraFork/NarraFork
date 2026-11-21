import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { build, type Manifest } from "vite";

/** Build the actual production dependency graph and new-URL module Worker into one owned sandbox. */
export async function serveGitChangesBrowserAssets(
	isolation: string,
	entryFile: "git-changes.browser-fixture.tsx" = "git-changes.browser-fixture.tsx",
) {
	const root = resolve(import.meta.dir, "../../..");
	const outDir = resolve(isolation, "browser-assets");
	const previousNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	try {
		await build({
			configFile: false,
			root: import.meta.dir,
			publicDir: false,
			mode: "production",
			cacheDir: resolve(isolation, "vite"),
			logLevel: "error",
			clearScreen: false,
			resolve: {
				alias: { "@frontend": resolve(root, "frontend"), "@shared": resolve(root, "shared") },
			},
			esbuild: { jsx: "automatic" },
			worker: { format: "es" },
			build: {
				outDir,
				emptyOutDir: true,
				manifest: true,
				minify: true,
				sourcemap: "hidden",
				target: "es2022",
				watch: null,
				rolldownOptions: { input: resolve(import.meta.dir, entryFile) },
			},
			plugins: [
				{
					name: "isolated-git-production-fixture",
					configResolved(config) {
						if (config.command !== "build" || !config.isProduction) {
							throw new Error("Git browser acceptance requires an actual production build");
						}
					},
				},
			],
		});
	} finally {
		if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previousNodeEnv;
	}
	const manifest = JSON.parse(
		await readFile(resolve(outDir, ".vite", "manifest.json"), "utf8"),
	) as Manifest;
	const entry = Object.values(manifest).find(
		(chunk) => chunk.isEntry && chunk.src?.endsWith(entryFile),
	);
	if (!entry?.file || !entry.css?.length) {
		throw new Error("Git browser production fixture must include its entry and Mantine CSS assets");
	}
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${entry.css.map((css) => `<link rel="stylesheet" href="/${css}">`).join("")}</head><body style="margin:0"><div id="root"></div><script type="module" src="/${entry.file}"></script></body></html>`;
	const contentSecurityPolicy = [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"worker-src 'self'",
		"connect-src 'self'",
		"img-src 'self' data:",
		"font-src 'self' data:",
	].join("; ");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(html, {
					headers: {
						"Content-Type": "text/html",
						"Content-Security-Policy": contentSecurityPolicy,
					},
				});
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			const shiki = /^\/shiki\/(langs|themes)\/([a-z0-9-]+\.mjs)$/.exec(path);
			if (shiki) {
				const file = Bun.file(
					resolve(root, "node_modules", "@shikijs", shiki[1], "dist", shiki[2]),
				);
				if (await file.exists())
					return new Response(file, { headers: { "Content-Type": "application/javascript" } });
			}
			const absolute = resolve(outDir, `.${decodeURIComponent(path)}`);
			if (!absolute.startsWith(`${outDir}${sep}`))
				return new Response("Not found", { status: 404 });
			const file = Bun.file(absolute);
			if (!(await file.exists())) return new Response("Not found", { status: 404 });
			return new Response(file);
		},
	});
	console.info(
		"Git changes browser assets",
		JSON.stringify({
			mode: "production-build",
			entry: entry.file,
			cssAssets: entry.css.length,
			manifestEntries: Object.keys(manifest).length,
		}),
	);
	return server;
}
