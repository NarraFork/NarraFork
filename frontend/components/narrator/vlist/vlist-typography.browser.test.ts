/**
 * The transcript's measured heights are its painted heights, at the new default line height
 * (the old 120%) and at a non-default setting — in Chromium, with real fonts.
 *
 * The height model measures text with pretext before anything is drawn (CONTRACT §0 rule 2);
 * the line-height knob is a measurement input. If the line box it measures with and the one the
 * render layer paints with ever disagree, rows overlap or clip with nothing logged. This drives
 * real transcript rows — a user message, an assistant markdown answer (heading, mixed
 * Chinese/English paragraph, list with inline code, code block), a Bash card — through the
 * list's own segments → adapter → measure → render chain, and checks the paint against the
 * measurement with what the browser decides on its own:
 *
 *   - the row box is the measured height by construction (the list positions rows by it), so it
 *     proves nothing by itself; what does: no glyph is painted below the row or past its right
 *     edge (the browser needed more room than measured), and no measured line break comes early
 *     (the browser would have fitted the next word or CJK character on the line) — together the
 *     measured line count is the browser's natural one;
 *   - the same paragraph laid out by the browser with the `--nf-type-*` variables (how the
 *     outline paints), with no height given, is exactly as tall as the transcript measured it.
 *
 * With `NF_TYPOGRAPHY_SHOTS=<dir>` set, the rows are saved as screenshots in both themes.
 *
 * This suite owns only an ephemeral static server and browser: it never touches NarraFork.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./vlist-typography.browser-fixture";

const cachedChromium =
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const executablePath = process.env.NF_TEST_CHROMIUM_PATH ?? cachedChromium;
const SHOTS = process.env.NF_TYPOGRAPHY_SHOTS;

type FixtureWindow = Window & { fixture: typeof Fixture };
type Report = ReturnType<typeof Fixture.report>;

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page | undefined;
const errors: string[] = [];

beforeAll(async () => {
	if (!existsSync(executablePath))
		throw new Error(`Chromium unavailable at ${executablePath}; set NF_TEST_CHROMIUM_PATH`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./vlist-typography.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("Browser fixture bundle has no entry point");
	const script = `/${basename(entry.path)}`;
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8">
					${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}
					<style>html,body { margin: 0; }</style>
					</head><body><div id="root"></div><script type="module">
					window.fixture = await import(${JSON.stringify(script)});
					</script></body></html>`,
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
	page = await browser.newPage();
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 2 });
	await page.goto(`${server.url.origin}/`, { waitUntil: "networkidle0" });
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}, 60_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

async function renderAt(
	typography: Parameters<typeof Fixture.render>[0],
	width: number,
	scheme: "dark" | "light" = "dark",
): Promise<Report> {
	if (!page) throw new Error("no page");
	await page.evaluate(
		(t, w, s) => (window as unknown as FixtureWindow).fixture.render(t, w, s),
		typography,
		width,
		scheme,
	);
	await page.evaluate(
		() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
	);
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

const SETTINGS = {
	default: { fontScalePercent: 100, lineHeightScalePercent: 100, letterSpacingPercent: 0 },
	larger: { fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 },
} as const;

for (const [name, setting] of Object.entries(SETTINGS)) {
	for (const width of [640, 420]) {
		test(`${name} at ${width}px: every row paints exactly what it measured`, async () => {
			const report = await renderAt(setting, width);
			if (name === "default") {
				// The new default body line: 14px × 1.45 × 1.2 (the old 120%).
				expect(report.lineBody).toBe(24);
			} else {
				expect(report.lineBody).toBe(Math.round(16.1 * 1.45 * 1.32));
			}
			expect(report.rows.map((row) => row.kind)).toEqual([
				"message-bubble",
				"markdown",
				"tool-call",
				"markdown",
			]);
			for (const row of report.rows) {
				// The box is the measured height by construction (nothing is proven by that)…
				expect(row.boxHeight, row.kind).toBeCloseTo(row.measured, 1);
				// …every measured text line is painted inside it,
				expect(row.paintedBottom, row.kind).toBeLessThanOrEqual(row.measured + 0.5);
				// no measured break comes earlier than the browser's own would,
				expect(row.earlyBreaks, row.kind).toEqual([]);
				// no glyph of the row (bubble, card or markdown) is painted below it or past
				// its right edge (the browser wraps nothing the measurement did not),
				expect(row.textBottom, row.kind).toBeLessThanOrEqual(row.measured + 0.5);
				expect(row.textRight, row.kind).toBeLessThanOrEqual(0.5);
				expect(row.overflowRight, row.kind).toBeLessThanOrEqual(0.5);
			}
			// and the markdown lines are painted at the measured body line box.
			for (const row of report.rows.filter((r) => r.kind === "markdown")) {
				expect(row.bodyLines, "markdown body lines").toBeGreaterThanOrEqual(2);
			}
			// The wrap check saw real wraps (a vacuous pass would prove nothing).
			expect(report.rows.reduce((n, row) => n + row.wrapsChecked, 0)).toBeGreaterThanOrEqual(3);

			// The outline's way (browser layout + `--nf-type-*`): the same paragraph, as tall as
			// the transcript measured it — the two surfaces agree line for line.
			const gt = report.groundTruth;
			expect(gt.lineHeight).toBe(`${report.lineBody}px`);
			expect(gt.painted).toBeCloseTo(gt.measured, 0);
			expect(gt.measured / report.lineBody).toBeGreaterThanOrEqual(2);
			expect(errors).toEqual([]);

			if (SHOTS && width === 640) {
				mkdirSync(SHOTS, { recursive: true });
				for (const scheme of ["light", "dark"] as const) {
					await renderAt(setting, width, scheme);
					const shot = await page?.$("#shot");
					await shot?.screenshot({ path: `${SHOTS}/after-transcript-${name}-${scheme}.png` });
				}
			}
		}, 30_000);
	}
}
