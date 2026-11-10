import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Browser, launch, type Page } from "puppeteer-core";

// The iframe fixture calls the actual inline bridge, not a mocked production module.
declare global {
	interface Window {
		overlayPlugin: {
			bounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<unknown>;
			crash: () => void;
		};
	}
}

async function chromePath() {
	const configured = process.env.NF_TEST_CHROMIUM_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
	if (configured) return configured;
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache)) {
		for await (const path of new Bun.Glob("chrome/*/**/chrome").scan({
			cwd: cache,
			absolute: true,
		}))
			return path;
	}
	return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(
		existsSync,
	);
}
const chrome = await chromePath();
if (!chrome)
	console.warn("SKIP plugin overlay browser regression: Chrome is unavailable (unverified)");
const browserTest = chrome ? test : test.skip;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page;
let releaseMissing: (() => void) | undefined;
const revoked = new Set<string>();
const sessions = new Map<string, { pluginId: string; generation: number }>();
const generations = new Map<string, number>();

function pluginEntry(pluginId: string, generation: number) {
	return `(() => {
		const bridge = window.narrafork;
		const full = ${JSON.stringify(pluginId.includes("-full"))};
		const painted = document.createElement("div");
		painted.id = "painted-overlay";
		Object.assign(painted.style, {position:"fixed", left:"0", top:"0", width:full?"100vw":"100px", height:full?"100vh":"100px", background:"rgb(220, 50, 40)"});
		document.body.appendChild(painted);
		const focusTrap = document.createElement("button");
		focusTrap.textContent = "Plugin must not receive keyboard focus";
		document.body.appendChild(focusTrap);
		window.overlayPlugin = {
			bounds: (bounds) => bridge.overlay.setBounds(bounds),
			crash: () => bridge.notify("plugin.lifecycle", {state:"crashed", reason:"fixture-crash"})
		};
		bridge.onNotification((message) => {
			if (message.method === "overlay.pointer") {
				document.body.dataset.pointer = message.params.type;
				document.body.dataset.pointerId = String(message.params.pointerId);
			}
		});
		// A replacement session deliberately requests no bounds. The production
		// provider, not this fixture, must clear its predecessor's hit region.
		if (${generation} === 1) bridge.overlay.setBounds(full
			? {x:0,y:0,width:10000,height:10000}
			: {x:20,y:20,width:100,height:100}).then(() => document.body.dataset.boundsReady = "true");
		document.body.dataset.entryReady = "true";
	})();`;
}

beforeAll(async () => {
	if (!chrome) return;
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "plugin-overlay.browser-fixture.tsx")],
		target: "browser",
		minify: true,
		define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
	});
	if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 8_000));
	if (build.outputs.reduce((bytes, output) => bytes + output.size, 0) > 32 * 1024 * 1024)
		throw new Error("Plugin overlay fixture exceeds 32MiB");
	const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const html = `<!doctype html><html><head>${build.outputs
		.filter((output) => output.path.endsWith(".css"))
		.map((output) => `<link rel="stylesheet" href="/${basename(output.path)}">`)
		.join("")}</head><body><div id="root"></div>${build.outputs
		.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"))
		.map((output) => `<script type="module" src="/${basename(output.path)}"></script>`)
		.join("")}</body></html>`;
	// Isolated loopback server and fresh browser profile: no real server/token/user data.
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 10,
		maxRequestBodySize: 4096,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/api/plugins/ui/sessions" && request.method === "POST") {
				const body = (await request.json()) as { pluginId: string; surface: string };
				if (body.surface !== "overlay") return new Response(null, { status: 400 });
				const generation = (generations.get(body.pluginId) ?? 0) + 1;
				generations.set(body.pluginId, generation);
				const id = `session-${sessions.size + 1}`;
				sessions.set(id, { pluginId: body.pluginId, generation });
				return Response.json({
					session: { sessionId: id, connectNonce: "fixture-connect-nonce-1234567890" },
					sessionToken: "fixture-session-token-1234567890",
					assetToken: "fixture-asset-token-1234567890",
				});
			}
			if (path.startsWith("/api/plugins/ui/sessions/") && request.method === "DELETE") {
				revoked.add(path.split("/").at(-1) ?? "");
				return Response.json({ ok: true });
			}
			if (request.method !== "GET") return new Response(null, { status: 405 });
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			const asset = path.match(/\/asset\/([^/]+)\/[^/]+\/(entry|missing)\.js$/);
			if (asset) {
				const session = sessions.get(asset[1]);
				if (!session) return new Response(null, { status: 404 });
				if (asset[2] === "missing") {
					// Keep the real shell in its loading state until the test inspects it.
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, 5_000);
						releaseMissing = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					return new Response(null, { status: 404 });
				}
				return new Response(pluginEntry(session.pluginId, session.generation), {
					headers: { "content-type": "application/javascript" },
				});
			}
			return new Response(assets.get(path) ?? null, { status: assets.has(path) ? 200 : 404 });
		},
	});
	browser = await launch({
		executablePath: chrome,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		timeout: 15_000,
	});
}, 30_000);

afterEach(async () => {
	releaseMissing?.();
	releaseMissing = undefined;
	await page?.close();
});
afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		await server?.stop(true);
	}
});

async function open(scenario: string, hits = 1, noOverlay = false) {
	if (!browser || !server) throw new Error("Browser fixture was not initialized");
	page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => {
		if (errors.length < 8) errors.push(String(error).slice(0, 1_000));
	});
	page.setDefaultTimeout(5_000);
	await page.setViewport({ width: 800, height: 600 });
	await page.goto(
		`http://127.0.0.1:${server.port}/?scenario=${scenario}${noOverlay ? "&nfNoOverlay=1" : ""}`,
		{ timeout: 10_000 },
	);
	try {
		await page.waitForFunction(() => !!window.overlayFixture);
	} catch (error) {
		throw new Error(`Fixture failed to mount: ${errors.join("; ")}`, { cause: error });
	}
	if (hits) {
		await page.waitForFunction(
			(count) => document.querySelectorAll("[data-plugin-overlay-hit]").length === count,
			{},
			hits,
		);
	}
}

async function waitForStub(condition: () => boolean) {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture HTTP request");
		await Bun.sleep(10);
	}
}

async function pluginFrame() {
	const element = await page.waitForSelector("[data-plugin-overlay] iframe");
	const frame = await element?.contentFrame();
	if (!frame) throw new Error("Missing real plugin iframe");
	await frame.waitForFunction(() => !!window.overlayPlugin);
	return frame;
}

async function clickUnderlay(x = 400, y = 200, expected = "1") {
	await page.mouse.click(x, y);
	await page.waitForFunction(
		(value) => document.getElementById("clicks")?.textContent === value,
		{},
		expected,
	);
}

for (const input of ["mouse", "keyboard"]) {
	browserTest(
		`full-screen overlays retain host dismiss via ${input}, including multiple sessions`,
		async () => {
			await open(`full-${input}`, 2);
			const state = await page.evaluate(() => window.overlayFixture.inspect());
			expect(state.sessions.map((session) => session.status)).toEqual(["ready", "ready"]);
			expect(
				await page.$$eval("iframe", (frames) =>
					frames.every((frame) => frame.inert && frame.tabIndex === -1),
				),
			).toBe(true);
			for (const frame of page.frames().filter((frame) => frame !== page.mainFrame())) {
				expect(
					await frame.$eval("#painted-overlay", (element) => ({
						width: element.clientWidth,
						height: element.clientHeight,
					})),
				).toEqual({ width: 800, height: 600 });
			}
			await page.mouse.click(400, 200);
			expect(await page.$eval("#clicks", (element) => element.textContent)).toBe("0");
			const dismiss = "[data-plugin-overlay-dismiss]";
			if (input === "mouse") {
				await page.click(dismiss);
			} else {
				await page.focus("#underlay");
				await page.keyboard.press("Tab");
				expect(
					await page.evaluate(() =>
						document.activeElement?.hasAttribute("data-plugin-overlay-dismiss"),
					),
				).toBe(true);
				await page.keyboard.press("Enter");
			}
			await page.waitForFunction(
				() => document.querySelectorAll("[data-plugin-overlay]").length === 0,
			);
			expect(await page.evaluate(() => window.overlayFixture.inspect())).toEqual({
				sessions: [],
				bounds: [],
			});
			await waitForStub(() =>
				state.sessions.every((session) => !!session.backendId && revoked.has(session.backendId)),
			);
			await clickUnderlay();
		},
		20_000,
	);
}

browserTest(
	"normal hit regions pass outside clicks through and crash restores underlying input",
	async () => {
		await open("normal");
		await clickUnderlay();
		const frame = await pluginFrame();
		await page.mouse.click(40, 40);
		await frame.waitForFunction(() => document.body.dataset.pointer === "up");
		expect(await page.$eval("#clicks", (element) => element.textContent)).toBe("1");
		await page.mouse.down();
		await frame.waitForFunction(() => document.body.dataset.pointer === "down");
		// A move commits the browser's pending capture before explicitly losing it.
		await page.mouse.move(42, 42);
		await frame.waitForFunction(() => document.body.dataset.pointer === "move");
		const pointerId = await frame.evaluate(() => Number(document.body.dataset.pointerId));
		await page.$eval(
			"[data-plugin-overlay-hit]",
			(element, id) => element.releasePointerCapture(id),
			pointerId,
		);
		await page.mouse.move(45, 45);
		await frame.waitForFunction(() => document.body.dataset.pointer === "cancel");
		await page.mouse.up();
		await page.mouse.click(40, 40);
		await frame.waitForFunction(() => document.body.dataset.pointer === "up");
		await frame.evaluate(() => window.overlayPlugin.crash());
		await page.waitForFunction(
			() => window.overlayFixture.inspect().sessions[0]?.status === "crashed",
		);
		expect(await page.$$eval("[data-plugin-overlay-hit]", (elements) => elements.length)).toBe(0);
		expect(await page.evaluate(() => window.overlayFixture.inspect().bounds)).toEqual([]);
		await clickUnderlay(40, 40, "2");
	},
	20_000,
);

browserTest(
	"entry 404 leaves both loading shell and failed overlay transparent and click-through",
	async () => {
		await open("missing", 0);
		await waitForStub(() => !!releaseMissing);
		const element = await page.waitForSelector("[data-plugin-overlay] iframe");
		const frame = await element?.contentFrame();
		if (!frame) throw new Error("Missing loading shell");
		expect(
			await frame.evaluate(() => ({
				html: getComputedStyle(document.documentElement).backgroundColor,
				body: getComputedStyle(document.body).backgroundColor,
				splash: !!document.getElementById("plugin-shell-splash"),
			})),
		).toEqual({ html: "rgba(0, 0, 0, 0)", body: "rgba(0, 0, 0, 0)", splash: false });
		const clip = { x: 200, y: 400, width: 20, height: 20 };
		const loadingPixels = await page.screenshot({ clip });
		// CSS transparency alone is insufficient: mismatched iframe/document color
		// schemes make Chromium paint an opaque canvas. Verify actual compositing
		// under both host themes without changing the production iframe or shell.
		const themedPixels: Uint8Array[] = [];
		for (const scheme of ["light", "dark"]) {
			await page.evaluate((value) => {
				document.documentElement.dataset.mantineColorScheme = value;
			}, scheme);
			themedPixels.push(await page.screenshot({ clip }));
		}
		await clickUnderlay();
		releaseMissing?.();
		await page.waitForFunction(
			() => window.overlayFixture.inspect().sessions[0]?.status === "crashed",
		);
		expect(await page.$eval("[data-plugin-overlay]", (element) => element.textContent)).toBe("");
		expect(await page.$$eval("[data-plugin-overlay-hit]", (elements) => elements.length)).toBe(0);
		const failedPixels = await page.screenshot({ clip });
		await page.evaluate(() => window.overlayFixture.remove("uninstalled"));
		await page.waitForFunction(() => !document.querySelector("[data-plugin-overlay]"));
		const underlayPixels = await page.screenshot({ clip });
		expect(loadingPixels).toEqual(underlayPixels);
		for (const pixels of themedPixels) expect(pixels).toEqual(underlayPixels);
		expect(failedPixels).toEqual(underlayPixels);
		await clickUnderlay(400, 200, "2");
	},
	20_000,
);

browserTest(
	"reload discards old bounds; offscreen, zero-area and viewport shrink never leave stale hits",
	async () => {
		await open("reload");
		const frame = await pluginFrame();
		await frame.evaluate(() =>
			window.overlayPlugin.bounds({ x: -30, y: -20, width: 100, height: 90 }),
		);
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLElement>("[data-plugin-overlay-hit]")?.style.width === "70px",
		);
		expect(
			await page.$eval("[data-plugin-overlay-hit]", (element) => {
				const rect = element.getBoundingClientRect();
				return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			}),
		).toEqual({ x: 0, y: 0, width: 70, height: 70 });
		for (const bounds of [
			{ x: -200, y: 0, width: 100, height: 90 },
			{ x: 20, y: 20, width: 0, height: 90 },
		]) {
			await frame.evaluate((value) => window.overlayPlugin.bounds(value), bounds);
			await page.waitForFunction(() => !document.querySelector("[data-plugin-overlay-hit]"));
			await clickUnderlay(40, 40, bounds.x < 0 ? "1" : "2");
		}
		await frame.evaluate(() =>
			window.overlayPlugin.bounds({ x: 500, y: 400, width: 300, height: 200 }),
		);
		await page.waitForSelector("[data-plugin-overlay-hit]");
		await page.setViewport({ width: 400, height: 300 });
		await page.waitForFunction(() => !document.querySelector("[data-plugin-overlay-hit]"));
		await frame.evaluate(() =>
			window.overlayPlugin.bounds({ x: 10, y: 10, width: 100, height: 100 }),
		);
		await page.waitForSelector("[data-plugin-overlay-hit]");
		const old = await page.evaluate(() => window.overlayFixture.inspect().sessions[0]?.backendId);
		await page.evaluate(() => window.overlayFixture.reload());
		await page.waitForFunction(
			(id) => {
				const session = window.overlayFixture.inspect().sessions[0];
				return session?.status === "ready" && session.backendId !== id;
			},
			{},
			old,
		);
		await pluginFrame();
		expect(await page.evaluate(() => window.overlayFixture.inspect().bounds)).toEqual([]);
		expect(await page.$$eval("[data-plugin-overlay-hit]", (elements) => elements.length)).toBe(0);
		await waitForStub(() => !!old && revoked.has(old));
		await clickUnderlay(40, 40, "3");
	},
	20_000,
);

browserTest(
	"nfNoOverlay cold-start escape hatch creates neither layers nor backend sessions",
	async () => {
		const before = sessions.size;
		await open("escape-hatch", 0, true);
		await clickUnderlay();
		expect(
			await page.$$eval(
				"[data-plugin-overlay], [data-plugin-overlay-dismiss]",
				(elements) => elements.length,
			),
		).toBe(0);
		expect(await page.evaluate(() => window.overlayFixture.inspect())).toEqual({
			sessions: [],
			bounds: [],
		});
		expect(sessions.size).toBe(before);
	},
	20_000,
);

for (const kind of ["disabled", "uninstalled"] as const) {
	browserTest(
		`${kind} contributions dispose sessions and restore underlay input`,
		async () => {
			await open(kind);
			const old = await page.evaluate(() => window.overlayFixture.inspect().sessions[0]?.backendId);
			await page.evaluate((value) => window.overlayFixture.remove(value), kind);
			await page.waitForFunction(() => !document.querySelector("[data-plugin-overlay]"));
			expect(await page.evaluate(() => window.overlayFixture.inspect())).toEqual({
				sessions: [],
				bounds: [],
			});
			await waitForStub(() => !!old && revoked.has(old));
			await clickUnderlay(40, 40);
		},
		20_000,
	);
}
