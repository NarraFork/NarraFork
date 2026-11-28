import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { neutralizeAmbientProxyEnv, resetProxyEnvStateForTest } from "../../net/proxy-env";
import { settings } from "../../settings";
import { closeBrowser, connectBrowser, EDGE_NO_RELAUNCH_ARG, findChromePath } from "../pool";
import { closeSession, createSession, getSession } from "../session";

const executablePath = findChromePath();
const chromeTest = executablePath ? test : test.skip;

chromeTest(
	"one manual context enforces proxy hits and misses on redirects, scripts and navigation",
	async () => {
		const savedProxy = settings.proxy;
		const savedBrowserProxy = settings.agent.browserProxy;
		const envKeys = [
			"NO_PROXY",
			"no_proxy",
			"HTTP_PROXY",
			"http_proxy",
			"HTTPS_PROXY",
			"https_proxy",
			"ALL_PROXY",
			"all_proxy",
		];
		const savedEnv = envKeys.map((key) => [key, process.env[key]] as const);
		const proxy = createServer((req, res) => {
			// A forward request has an absolute request target. Do not forward anywhere.
			const target = req.url ?? "";
			res.setHeader("Connection", "close");
			if (!target.startsWith("http://")) return res.end("direct to proxy fixture");
			if (target.endsWith("/proxied.js")) {
				res.setHeader("Content-Type", "text/javascript");
				return res.end("document.documentElement.dataset.asset = 'proxied'");
			}
			res.setHeader("Content-Type", "text/html");
			res.end("<title>proxied</title>");
		});
		await new Promise<void>((resolve, reject) => {
			proxy.once("error", reject);
			proxy.listen(0, "127.0.0.1", resolve);
		});
		const proxyPort = (proxy.address() as AddressInfo).port;
		const origin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (new URL(request.url).pathname === "/redirect") {
					return Response.redirect(`http://miss.invalid:${server.port}/redirected`);
				}
				return new Response(
					`<title>direct</title><script src="http://miss.invalid:${server.port}/proxied.js"></script>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			},
		});
		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
		const narratorId = `manual-proxy-${crypto.randomUUID()}`;
		try {
			process.env.NO_PROXY = ".env.test";
			resetProxyEnvStateForTest();
			neutralizeAmbientProxyEnv();
			settings.proxy = {
				mode: "direct",
				noProxyRules: [
					{ match: "wildcard", pattern: "cfg.test" },
					{ match: "wildcard", pattern: `port.test:${origin.port}` },
				],
			};
			settings.agent.browserProxy = { mode: "custom", url: `http://127.0.0.1:${proxyPort}` };
			const env = { ...process.env };
			if (process.platform === "win32" && env.USERPROFILE && env.NARRAFORK_TEST === "1") {
				// Preload gives Chromium a disposable Windows profile without AppData.
				env.LOCALAPPDATA = join(env.USERPROFILE, "AppData", "Local");
				env.APPDATA = join(env.USERPROFILE, "AppData", "Roaming");
				await Promise.all([
					mkdir(env.LOCALAPPDATA, { recursive: true }),
					mkdir(env.APPDATA, { recursive: true }),
				]);
			}
			browser = await puppeteer.launch({
				executablePath,
				env,
				headless: true,
				timeout: 10_000,
				args: [
					"--no-proxy-server",
					EDGE_NO_RELAUNCH_ARG,
					"--no-sandbox",
					"--disable-setuid-sandbox",
					"--host-resolver-rules=MAP *.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
				],
			});
			await connectBrowser(true, browser.wsEndpoint());
			const session = await createSession(
				narratorId,
				`http://env.test:${origin.port}/redirect`,
				true,
				undefined,
				false,
				undefined,
				{ managedManual: true },
			);
			expect(session.inUserBrowser).toBe(false);
			expect(getSession(narratorId, session.id)).toBe(session);
			expect(await session.page.title()).toBe("proxied");
			expect(session.page.url()).toBe(`http://miss.invalid:${origin.port}/redirected`);
			for (const host of [
				"env.test",
				"sub.env.test",
				"cfg.test",
				"sub.cfg.test",
				"port.test",
				"127.0.0.1",
			]) {
				await session.page.goto(`http://${host}:${origin.port}/check`, { timeout: 5_000 });
				expect(await session.page.title()).toBe("direct");
				expect(await session.page.evaluate(() => document.documentElement.dataset.asset)).toBe(
					"proxied",
				);
			}
			for (const [host, port] of [
				["somecfg.test", origin.port],
				["sub.port.test", origin.port],
				["port.test", proxyPort],
				// These are implicitly exempt in Chrome, but not in the browser policy.
				["localhost.", origin.port],
				["169.254.42.1", origin.port],
			] as const) {
				await session.page.goto(`http://${host}:${port}/check`, { timeout: 5_000 });
				expect(await session.page.title()).toBe("proxied");
			}
			await closeSession(narratorId, session.id);
			expect(getSession(narratorId, session.id)).toBeUndefined();
		} finally {
			settings.proxy = savedProxy;
			settings.agent.browserProxy = savedBrowserProxy;
			resetProxyEnvStateForTest();
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await closeBrowser();
			await browser?.close();
			origin.stop(true);
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	},
	45_000,
);
