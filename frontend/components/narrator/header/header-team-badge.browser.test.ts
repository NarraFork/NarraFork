import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import type * as Fixture from "./header-team-badge.browser-fixture";

// Real Chromium and production Mantine CSS: the session header row with the coordinator's team
// badge, at narrow widths, in both locales. The badge is budgeted by the header arithmetic, so
// it must never push the overflow trigger or close button past the row edge.
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
type FixtureWindow = Window & { fixture: typeof Fixture };
const stubs: Record<string, string> = {
	"react-i18next": "export const useTranslation=()=>({t:(k,o)=>window.fixtureT(k,o)});",
	api: "export const api={};",
};
const LONG_TITLE = {
	en: "Coordinate the release checklist, changelog review and the staged rollout for v2",
	"zh-CN": "协调发布检查清单、更新日志评审以及第二版的分阶段灰度发布与回滚预案",
} as const;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./header-team-badge.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			{
				name: "header-fixture-stubs",
				setup(builder) {
					builder.onResolve({ filter: /(?:^react-i18next|lib\/api)$/ }, (args) => ({
						path: args.path,
						namespace: "header-fixture",
					}));
					builder.onLoad({ filter: /.*/, namespace: "header-fixture" }, (args) => ({
						contents: stubs[args.path.split("/").pop() as string] ?? "",
						loader: "js",
					}));
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script || !styles.length) throw new Error("Production component/CSS bundle missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
}, 60_000);
afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

for (const locale of ["en", "zh-CN"] as const) {
	test(`${locale}: overflow and close stay inside the row and clickable beside the team badge`, async () => {
		if (!browser || !server) throw new Error("Fixture not initialized");
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		try {
			await page.setViewport({ width: 1000, height: 400 });
			await page.goto(server.url.origin, { waitUntil: "networkidle0" });
			await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
			let shownAt = 0;
			let hiddenAt = 0;
			// From 248px up: below that even a badge-less row cannot fit back, actions, the 80px
			// title floor, overflow and close (a pre-existing floor the badge must not raise).
			for (const width of [250, 280, 320, 360, 400, 440, 520, 640, 800, 960]) {
				await page.evaluate(
					(options) => (window as unknown as FixtureWindow).fixture.start(options),
					{ width, locale, title: LONG_TITLE[locale] },
				);
				await page.waitForFunction(
					() => (window as unknown as FixtureWindow).fixture.snapshot().ready,
				);
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
						),
				);
				const s = await page.evaluate(() =>
					(window as unknown as FixtureWindow).fixture.snapshot(),
				);
				const row = s.row as NonNullable<typeof s.row>;
				const close = s.close as NonNullable<typeof s.close>;
				const overflow = s.overflow as NonNullable<typeof s.overflow>;
				const where = `${locale} @${width}px`;
				// The 16px row padding is the edge the arithmetic budgets against.
				expect(close.right, where).toBeLessThanOrEqual(row.right - 16 + 0.5);
				expect(overflow.right, where).toBeLessThanOrEqual(close.left);
				expect(s.closeHittable, where).toBe(true);
				expect(s.overflowHittable, where).toBe(true);
				if (s.badge) {
					shownAt = Math.max(shownAt, width);
					const toolbar = s.toolbar as NonNullable<typeof s.toolbar>;
					expect(s.badge.right, where).toBeLessThanOrEqual(toolbar.left + 0.5);
					// Painted at the budgeted width without ellipsizing its own label.
					expect(s.badgeLabelClipped, where).toBe(false);
					expect(s.badgeHref, where).toBe("/nf/projects/proj-1/teams/coord-1");
					expect(s.badgeText, where).toBe(locale === "en" ? "Team" : "团队");
				} else hiddenAt = width;
			}
			// Shown wherever it fits; given way only on the narrowest rows.
			expect(shownAt).toBe(960);
			expect(hiddenAt).toBeLessThan(400);
			// A real click on the narrowest layout reaches close and overflow.
			await page.evaluate(
				(options) => (window as unknown as FixtureWindow).fixture.start(options),
				{ width: 280, locale, title: LONG_TITLE[locale] },
			);
			await page.waitForSelector("[data-fixture='close']");
			await page.click("[data-fixture='overflow']");
			await page.click("[data-fixture='close']");
			const clicks = await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.snapshot(),
			);
			expect(clicks.overflowClicks).toBe(1);
			expect(clicks.closeClicks).toBe(1);
			expect(errors).toEqual([]);
		} finally {
			await page.close();
		}
	}, 60_000);
}
