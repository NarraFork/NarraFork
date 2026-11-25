import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import viteConfig from "../../frontend/vite.config";

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

const fixtureId = "\0version-check-browser-fixture.js";
const fixtureSource = `
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useVersionCheck } from "/hooks/useVersionCheck.ts";
function Probe() {
	const result = useVersionCheck(25);
	useEffect(() => { document.body.dataset.mounted = "true"; }, []);
	return createElement("output", { id: "version-probe" }, JSON.stringify({
		updateAvailable: result.updateAvailable,
		dev: import.meta.env.DEV,
		injectedPortType: typeof __DEV_VITE_PORT__,
	}));
}
createRoot(document.getElementById("root")).render(createElement(Probe));
`;

test("production-mode Vite injects the serve define before the browser mounts the version hook", async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const cacheDir = mkdtempSync(join(tmpdir(), "nf-version-vite-"));
	const originalNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	let vite: ViteDevServer | undefined;
	let browser: Browser | undefined;
	let documents = 0;
	let healthRequests = 0;
	const fixture: Plugin = {
		name: "version-check-browser-fixture",
		enforce: "pre",
		resolveId: (id) => (id === "/version-check-fixture.js" ? fixtureId : undefined),
		load: (id) => (id === fixtureId ? fixtureSource : undefined),
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const path = request.url?.split("?", 1)[0];
				if (path === "/api/health") {
					healthRequests++;
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ status: "ok", version: "999.0.0+different" }));
					return;
				}
				if (path !== "/version-check-fixture") return next();
				documents++;
				void server
					.transformIndexHtml(
						path,
						'<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/version-check-fixture.js"></script></body></html>',
					)
					.then((html) => {
						response.setHeader("Content-Type", "text/html");
						response.end(html);
					})
					.catch(next);
			});
		},
	};
	try {
		const config = await viteConfig({ command: "serve", mode: "production" });
		vite = await createServer({
			...config,
			configFile: false,
			mode: "production",
			cacheDir,
			server: {
				...config.server,
				host: "127.0.0.1",
				port: 0,
				strictPort: false,
				hmr: false,
				watch: null,
			},
			optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client"] },
			plugins: [fixture, ...(config.plugins ?? [])],
		});
		await vite.listen();
		const address = vite.httpServer?.address();
		if (!address || typeof address === "string") throw new Error("Missing Vite address");
		browser = await puppeteer.launch({
			executablePath,
			headless: true,
			args: ["--no-sandbox"],
			timeout: 15_000,
		});
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.goto(`http://127.0.0.1:${address.port}/version-check-fixture`, {
			waitUntil: "networkidle0",
			timeout: 15_000,
		});
		await page.waitForFunction(() => document.body.dataset.mounted === "true", {
			timeout: 5000,
		});
		await page.evaluate(async () => {
			window.dispatchEvent(new Event("online"));
			window.dispatchEvent(new Event("pageshow"));
			document.dispatchEvent(new Event("visibilitychange"));
			navigator.serviceWorker?.dispatchEvent(
				new MessageEvent("message", { data: { type: "VERSION_MISMATCH" } }),
			);
			// Observe several 25ms polling windows without a health request or reload.
			await new Promise((resolve) => setTimeout(resolve, 150));
		});
		const result = await page.$eval("#version-probe", (element) =>
			JSON.parse(element.textContent ?? "null"),
		);
		expect(result).toEqual({
			updateAvailable: false,
			dev: false,
			injectedPortType: "number",
		});
		expect(healthRequests).toBe(0);
		expect(documents).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		try {
			await browser?.close();
		} finally {
			try {
				await vite?.close();
			} finally {
				rmSync(cacheDir, { recursive: true, force: true });
				if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
				else process.env.NODE_ENV = originalNodeEnv;
			}
		}
	}
}, 60_000);
