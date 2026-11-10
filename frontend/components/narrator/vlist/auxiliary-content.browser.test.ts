/**
 * Real Chromium regression for compact auxiliary content. The fixture uses
 * buildPretextDocumentLayout (including the production activity grouper), the real measure
 * registry and renderElement/RenderToolRun. ExactRow's query/WS/menu shell is outside this suite.
 * NF_AUXILIARY_CONTENT_SHOTS=<dir> writes optional screenshots; missing Chromium is a failure.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./auxiliary-content.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
type Report = ReturnType<typeof Fixture.report>;
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.NF_AUXILIARY_CONTENT_SHOTS;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "auxiliary-content.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("auxiliary fixture bundle missing");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 20,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		timeout: 20_000,
		protocolTimeout: 20_000,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	page.setDefaultNavigationTimeout(20_000);
	await page.goto(`http://127.0.0.1:${server.port}/`);
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function render(options: Fixture.FixtureOptions): Promise<Report> {
	await page.setViewport({ width: options.width, height: 900, deviceScaleFactor: 1 });
	await page.evaluate(
		(value) => (window as unknown as FixtureWindow).fixture.render(value),
		options,
	);
	return report();
}

async function report(): Promise<Report> {
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settle());
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

function assertGeometry(value: Report): void {
	expect(value.cards.length).toBeGreaterThan(0);
	expect(Math.abs(value.documentHeight - value.manifestHeight)).toBeLessThan(0.5);
	expect(value.pageOverflow).toBeLessThanOrEqual(0);
	for (const card of value.cards) {
		expect(Math.abs(card.painted - card.measured)).toBeLessThan(0.5);
		expect(card.scrollWidth).toBeLessThanOrEqual(card.width + 1);
		for (const row of card.traceRows) {
			expect(Math.abs(row.painted - row.measured)).toBeLessThan(0.5);
			if (row.expanded) expect(row.cardHeight).toBe(row.measured);
		}
	}
}

async function assertLogsReadable(): Promise<void> {
	for (const [marker, edge] of [
		["BACKGROUND_LOG_001", "start"],
		["BACKGROUND_LOG_080", "end"],
	] as const) {
		const log = await page.evaluate(
			(value) => (window as unknown as FixtureWindow).fixture.readLog(value.marker, value.edge),
			{ marker, edge },
		);
		expect(log.visible).toBe(true);
		expect(log.scrollHeight).toBeGreaterThan(log.height);
	}
}

async function screenshot(name: string): Promise<void> {
	if (!shots) return;
	mkdirSync(shots, { recursive: true });
	const shot = await page.$("#shot");
	if (!shot) throw new Error("screenshot surface missing");
	await shot.screenshot({ path: join(shots, `auxiliary-${name}.png`) });
}

for (const width of [320, 390]) {
	for (const lod of [1, 2] as const) {
		test(`L${lod} ${width}px: 80 Bash lines are one measured summary, real row click opens logs`, async () => {
			const compact = await render({ width, lod });
			assertGeometry(compact);
			expect(compact.units).toEqual(["activity"]);
			expect(compact.cards.map((card) => card.kind)).toEqual(["activity-trace"]);
			const card = compact.cards[0];
			expect(card?.traceRows).toHaveLength(1);
			expect(card?.traceRows[0]?.cardKind).toBe("auxiliary-content");
			expect(card?.traceRows[0]?.expanded).toBe(false);
			expect(card?.measured).toBeLessThan(32);
			expect(card?.traceTail).toBeLessThanOrEqual(4);
			expect(card?.text).toContain("frontend-build");
			expect(card?.text).not.toContain("BACKGROUND_LOG_");
			await screenshot(`L${lod}-${width}-compact`);
			await page.click("[data-nf-trace-titlerow][role=button]");
			const expanded = await report();
			assertGeometry(expanded);
			expect(expanded.cards[0]?.traceRows[0]?.expanded).toBe(true);
			expect(expanded.cards[0]?.measured).toBeGreaterThan(card?.measured ?? 0);
			expect(expanded.cards[0]?.text).toContain("BACKGROUND_LOG_001");
			expect(expanded.cards[0]?.text).toContain("BACKGROUND_LOG_080");
			expect(expanded.interactions).toEqual([
				{ kind: "row", specKey: card?.key, rowKey: card?.traceRows[0]?.key },
			]);
			await assertLogsReadable();
			await screenshot(`L${lod}-${width}-expanded`);
			// The nested production card header closes the SAME row-key channel again.
			await page.click("[data-nf-card-surface] [role=button][aria-expanded=true]");
			const closed = await report();
			expect(closed.cards[0]?.measured).toBe(card?.measured);
			expect(closed.cards[0]?.text).not.toContain("BACKGROUND_LOG_");
			console.info(
				`auxiliary L${lod}/${width}: ${card?.measured}px compact → ${expanded.cards[0]?.measured}px open`,
			);
		}, 15_000);
	}

	test(`${width}px: disabling compact preference restores the measured legacy injection bubble`, async () => {
		const legacy = await render({ width, lod: 2, compactAuxiliaryContent: false });
		assertGeometry(legacy);
		expect(legacy.cards.map((card) => card.kind)).toEqual(["injection-bubble"]);
		expect(legacy.cards[0]?.measured).toBeGreaterThan(150);
		expect(legacy.cards[0]?.text).toContain("BACKGROUND_LOG_");
		await screenshot(`legacy-${width}`);
	});

	test(`${width}px: L3 summary, L4 bounded recent preview/old summary, L5 full readable detail`, async () => {
		const summary = await render({ width, lod: 3 });
		assertGeometry(summary);
		expect(summary.cards.map((card) => card.kind)).toEqual(["auxiliary-content"]);
		expect(summary.cards[0]?.effectiveOpened).toBe(false);
		expect(summary.cards[0]?.text).not.toContain("BACKGROUND_LOG_");
		await page.click("[data-nf-card-surface] [role=button]");
		const clicked = await report();
		assertGeometry(clicked);
		expect(clicked.cards[0]?.text).toContain("BACKGROUND_LOG_080");
		expect(clicked.interactions[0]?.kind).toBe("card");

		const recent = await render({ width, lod: 4, recent: true });
		assertGeometry(recent);
		expect(recent.cards[0]?.effectiveOpened).toBe(true);
		expect(recent.cards[0]?.detailChars).toBeGreaterThan(0);
		expect(recent.cards[0]?.detailChars).toBeLessThanOrEqual(recent.previewBudget);
		expect(recent.cards[0]?.detailTruncated).toBe(true);
		expect(recent.cards[0]?.text).not.toContain("BACKGROUND_LOG_080");
		await screenshot(`L4-recent-${width}`);

		const old = await render({ width, lod: 4, recent: false });
		assertGeometry(old);
		expect(old.cards[0]?.effectiveOpened).toBe(false);
		expect(old.cards[0]?.detailChars).toBe(0);
		expect(old.cards[0]?.text).not.toContain("BACKGROUND_LOG_");

		const detail = await render({ width, lod: 5, recent: false });
		assertGeometry(detail);
		expect(detail.cards[0]?.effectiveOpened).toBe(true);
		expect(detail.cards[0]?.detailChars).toBeGreaterThan(detail.previewBudget);
		expect(detail.cards[0]?.detailTruncated).toBe(false);
		expect(detail.cards[0]?.text).toContain("BACKGROUND_LOG_001");
		expect(detail.cards[0]?.text).toContain("BACKGROUND_LOG_080");
		await assertLogsReadable();
		await screenshot(`L5-detail-${width}`);
	}, 15_000);

	for (const scene of ["send", "inbound"] as const) {
		test(`${width}px: ${scene} false/omitted remain ordinary rows; explicit true stays a bubble`, async () => {
			const value = await render({ scene, width, lod: 2 });
			assertGeometry(value);
			const trace = value.cards.filter((card) => card.kind === "activity-trace");
			expect(trace.flatMap((card) => card.traceRows)).toHaveLength(2);
			if (scene === "send") {
				// Ordinary Send summaries name the recipient, not the message body.
				expect(trace.flatMap((card) => card.traceRows.map((row) => row.key))).toEqual([
					"tool-send-internal-explicit-false",
					"tool-send-internal-default",
				]);
				expect(trace.map((card) => card.text).join("")).toContain("收件代理");
			} else {
				expect(trace.map((card) => card.text).join("")).toContain("received-explicit-false");
				expect(trace.map((card) => card.text).join("")).toContain("received-default");
			}
			const bubbles = value.cards.filter(
				(card) => card.kind === (scene === "send" ? "communication-bubble" : "injection-bubble"),
			);
			expect(bubbles).toHaveLength(1);
			expect(bubbles[0]?.text).toContain(
				scene === "send" ? "reader-intended-true" : "received-intended-true",
			);
			await page.click("[data-nf-trace-titlerow][role=button]");
			const inspected = await report();
			assertGeometry(inspected);
			expect(
				inspected.cards
					.filter((card) => card.kind === "activity-trace")
					.map((card) => card.text)
					.join(""),
			).toContain(scene === "send" ? "internal-explicit-false" : "received-explicit-false");
		});
	}

	for (const lod of [2, 5] as const) {
		test(`L${lod} ${width}px: knowledge detail opens its exact target only when the host can open it`, async () => {
			await render({ scene: "knowledge", width, lod, knowledgeOpener: true });
			if (lod === 2) await page.click("[data-nf-trace-titlerow][role=button]");
			const available = await report();
			assertGeometry(available);
			const selector = 'button[aria-label="知识条目：低 LOD 布局验收"]';
			expect(await page.$(selector)).not.toBeNull();
			await page.click(selector);
			const opened = await report();
			expect(opened.openedTargets).toEqual([
				{ kind: "knowledge", entryId: "knowledge-exact-target", scope: "personal" },
			]);
			await render({ scene: "knowledge", width, lod, knowledgeOpener: false });
			if (lod === 2) await page.click("[data-nf-trace-titlerow][role=button]");
			const unavailable = await report();
			assertGeometry(unavailable);
			expect(unavailable.cards[0]?.text).toContain("知识条目：低 LOD 布局验收");
			expect(await page.$(selector)).toBeNull();
			expect(unavailable.openedTargets).toEqual([]);
		});
	}

	test(`${width}px: background, internal Send and knowledge share the real three-row activity group`, async () => {
		const value = await render({ scene: "grouped", width, lod: 2 });
		assertGeometry(value);
		expect(value.units).toEqual(["activity"]);
		expect(value.cards.map((card) => card.kind)).toEqual(["activity-trace"]);
		expect(value.cards[0]?.traceRows.map((row) => row.cardKind)).toEqual([
			"auxiliary-content",
			"tool-call",
			"auxiliary-content",
		]);
		expect(value.cards[0]?.measured).toBeLessThan(80);
		expect(value.cards[0]?.traceTail).toBeLessThanOrEqual(4);
	});
}
