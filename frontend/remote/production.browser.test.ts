import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import puppeteer, { type Browser } from "puppeteer-core";

// Run explicitly after the separately-owned production build. Never substitute a dev build.
const enabled = process.env.NF_REMOTE_PRODUCTION_TEST === "1";
const dist = resolve(
	process.env.NF_REMOTE_PRODUCTION_DIST ??
		resolve(import.meta.dirname, "../../dist/frontend-remote"),
);
const base = `/remote/frontends/${"b".repeat(64)}/`;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const toolInput = { path: "/fixture/report.html" };
const toolOutput = {
	_text: "Historical shared report",
	_metadata: {
		shareId: "old-share",
		downloadUrl: "/api/shares/old-share",
		previewUrl: "/api/shares/old-share/preview",
		filename: "report.html",
		previewRequested: true,
	},
};
const historicalRow = rowWithElements(
	{
		id: "history",
		narratorId: "n".repeat(21),
		role: "assistant",
		seq: 1,
		parentMessageId: null,
		createdAt: "2026-01-01T00:00:00Z",
		toolCalls: [
			{
				toolUseId: "old-tool",
				toolName: "ShareFile",
				inputJson: toolInput,
				outputJson: toolOutput,
				status: "completed",
			},
		],
	},
	[
		{ type: "text", text: "Historical record ![untrusted](https://remote-leak.invalid/image.png)" },
		{
			type: "tool_use",
			id: "old-tool",
			name: "ShareFile",
			input: toolInput,
			inputJson: toolInput,
			outputJson: toolOutput,
			status: "completed",
		},
	],
);
const { blocks: historyBlocks, ...historyEnvelope } = historicalRow;
const historyPage = {
	messages: [{ ...historyEnvelope, blockIds: historyBlocks.map((block) => block.id) }],
	blocks: historyBlocks.map((block, ordinal) => ({ ...block, ordinal, messageId: "history" })),
	minSeq: 1,
	maxSeq: 1,
	hasNext: false,
	hasPrev: false,
	messageVersion: 1,
};

describe.skipIf(!enabled)("production remote frontend native-network boundary", () => {
	beforeAll(async () => {
		if (!existsSync(resolve(dist, "mount.js")))
			throw new Error("Build dist/frontend-remote before this test");
		const chromium =
			process.env.NF_TEST_CHROMIUM_PATH ??
			"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
		if (!existsSync(chromium)) throw new Error(`Chromium unavailable: ${chromium}`);
		const fixture = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
			await Bun.file(new URL("./production.browser.fixture.ts", import.meta.url)).text(),
		);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/fixture.js")
					return new Response(
						`window.remoteFixtureHistory=${JSON.stringify(historyPage)};\n${fixture}`,
						{ headers: { "content-type": "text/javascript" } },
					);
				if (pathname.startsWith(base)) {
					const suffix = pathname.slice(base.length);
					if (!suffix || suffix.includes("..") || suffix.includes("\\"))
						return new Response("Invalid path", { status: 400 });
					const path = resolve(dist, suffix);
					return existsSync(path)
						? new Response(Bun.file(path), { headers: { "cache-control": "no-store" } })
						: new Response("Missing static asset", { status: 404 });
				}
				if (pathname.startsWith("/api/") || pathname.startsWith("/ws/"))
					return new Response("Business routes do not exist on this host", { status: 404 });
				return new Response(
					'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		browser = await puppeteer.launch({
			executablePath: chromium,
			headless: true,
			args: ["--no-sandbox"],
			timeout: 15_000,
		});
	}, 30_000);
	afterAll(async () => {
		try {
			await browser?.close();
		} finally {
			server?.stop(true);
		}
	});

	for (const staleCache of [false, true])
		test(`cold production modules with stale branding/plugins=${staleCache} never send host business traffic`, async () => {
			if (!browser || !server) throw new Error("Fixture unavailable");
			const context = await browser.createBrowserContext();
			const page = await context.newPage();
			const leaks: string[] = [];
			const errors: string[] = [];
			try {
				await page.setCacheEnabled(false);
				await page.evaluateOnNewDocument((oldCache) => {
					localStorage.clear();
					const objectUrls = new Set<string>();
					Reflect.set(window, "remoteOpenObjectUrls", objectUrls);
					Reflect.set(window, "remoteCreatedObjectUrls", 0);
					const createObjectURL = URL.createObjectURL.bind(URL);
					const revokeObjectURL = URL.revokeObjectURL.bind(URL);
					URL.createObjectURL = (object) => {
						const url = createObjectURL(object);
						objectUrls.add(url);
						Reflect.set(
							window,
							"remoteCreatedObjectUrls",
							Reflect.get(window, "remoteCreatedObjectUrls") + 1,
						);
						return url;
					};
					URL.revokeObjectURL = (url) => {
						objectUrls.delete(url);
						revokeObjectURL(url);
					};
					if (oldCache) {
						localStorage.setItem("narrafork_brand_name", "Old private instance");
						localStorage.setItem("narrafork_brand_icon_color", "#ff0011");
						localStorage.setItem("narrafork_plugin_theme", "old-plugin:theme");
						localStorage.setItem("narrafork_active_plugin_theme", "old-plugin:theme");
					}
				}, staleCache);
				page.on("request", (request) => {
					const url = new URL(request.url());
					if (url.protocol === "blob:" || url.protocol === "data:") return;
					if (url.origin !== server?.url.origin || /^\/(api|ws)(\/|$)/.test(url.pathname))
						leaks.push(request.url());
				});
				page.on("pageerror", (error) => errors.push(String(error)));
				const cdp = await page.createCDPSession();
				await cdp.send("Network.enable");
				cdp.on("Network.webSocketCreated", (event) => leaks.push(event.url));
				await page.goto(`${server.url.origin}/login`, { waitUntil: "domcontentloaded" });
				await page.waitForSelector('input[autocomplete="username"]', { timeout: 30_000 });
				await page.type('input[autocomplete="username"]', "admin");
				await page.type('input[autocomplete="current-password"]', "password");
				await page.click('button[type="submit"]');
				await page.waitForSelector('input[autocomplete="one-time-code"]');
				expect(await page.evaluate(() => localStorage.getItem("narrafork_token"))).toBeNull();
				await page.type('input[autocomplete="one-time-code"]', "123456");
				await page.click('button[type="submit"]');
				await page.waitForSelector('a[href="/projects/ppppppppppppppppppppp"]');
				await page.click('a[href="/projects/ppppppppppppppppppppp"]');
				await page.waitForSelector('a[href="/narrators/nnnnnnnnnnnnnnnnnnnnn"]');
				await page.click('a[href="/narrators/nnnnnnnnnnnnnnnnnnnnn"]');
				await page.waitForSelector('[data-inline-composer] [contenteditable="true"]', {
					timeout: 30_000,
				});
				await page.waitForSelector('[data-remote-unsupported="true"]', { timeout: 30_000 });
				expect(await page.evaluate(() => document.body.textContent?.includes("ShareFile"))).toBe(
					true,
				);
				expect(await page.$('iframe,a[href*="/api/shares/"]')).toBeNull();
				const order = await page.evaluate(() => Reflect.get(window, "remoteFixtureAuthOrder"));
				expect(order[0]).toBe("authenticate");
				expect(order).toContain("/api/narrators/nnnnnnnnnnnnnnnnnnnnn");
				await page.type(
					'[data-inline-composer] [contenteditable="true"]',
					"Remote production message",
				);
				await page.evaluate(() => {
					const input = document.querySelector<HTMLInputElement>('input[type="file"]');
					if (!input) throw new Error("Attachment input missing");
					const transfer = new DataTransfer();
					transfer.items.add(
						new File(["small remote attachment"], "中文附件.txt", { type: "text/plain" }),
					);
					const png = Uint8Array.from(
						atob(
							"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
						),
						(value) => value.charCodeAt(0),
					);
					transfer.items.add(new File([png], "小图片.png", { type: "image/png" }));
					input.files = transfer.files;
					input.dispatchEvent(new Event("change", { bubbles: true }));
				});
				await page.waitForSelector('[data-composer-atom="attachment"]');
				await page.click('[data-inline-composer] [contenteditable="true"]');
				await page.keyboard.press("Enter");
				await page.waitForFunction(() =>
					(Reflect.get(window, "remoteFixtureCalls") as { path: string; method: string }[]).some(
						(call) =>
							call.path === "/api/narrators/nnnnnnnnnnnnnnnnnnnnn/messages" &&
							call.method === "UPLOAD",
					),
				);
				await page.evaluate(() => {
					const button = [...document.querySelectorAll("button")].find(
						(item) => item.textContent?.trim() === "Sign out",
					);
					if (!button) throw new Error("Logout unavailable");
					button.click();
				});
				await page.waitForFunction(() => Reflect.get(window, "remoteFixtureClosed") === true);
				await page.waitForFunction(() =>
					document.body.textContent?.includes("The remote session has ended."),
				);
				expect(
					await page.evaluate(() =>
						[...document.querySelectorAll("button")].some(
							(button) => button.textContent?.trim() === "Reconnect",
						),
					),
				).toBe(true);
				expect(
					await page.evaluate(() =>
						document.body.textContent?.includes("Remote connection failed"),
					),
				).toBe(false);
				expect(await page.evaluate(() => localStorage.getItem("narrafork_token"))).toBeNull();
				expect(
					await page.evaluate(() => Reflect.get(window, "remoteCreatedObjectUrls")),
				).toBeGreaterThan(0);
				await page.waitForFunction(
					() => (Reflect.get(window, "remoteOpenObjectUrls") as Set<string>).size === 0,
				);
				expect(leaks).toEqual([]);
				expect(errors).toEqual([]);
			} finally {
				await context.close();
			}
		}, 60_000);
});
