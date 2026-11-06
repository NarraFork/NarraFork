/**
 * A permission card's textareas paint the rows the transcript's height model counts (D49), in
 * Chromium, for every card that has one: a plain approval (Bash), the plan-file approval while
 * its plan is edited, an outline plan's approval and an AskUserQuestion — at 288, 328, 360 and
 * 720px, in en and zh-CN, at 100%, 130% and 180% type and at the default and a 150% line height.
 *
 * The model counts each textarea row as `typographyMetrics().line.xsBase` (22px at the default)
 * and the vlist reserves that before the card paints. Mantine's textarea used to paint 1.55 × its
 * font size whatever the setting (18.6px), so every card came out shorter than reserved. Now, in
 * the transcript (the vlist's bridge), it paints with the reader's typography, so:
 *
 *   - every textarea is exactly the model's height for the rows it shows, on the model's line
 *     box and font size — also at the smallest line height, below Mantine's own min-height;
 *   - the empty feedback box shows the rows the vlist predicted for it: its text follows the
 *     reader's font size, so its placeholder wraps at a large size in a narrow card, and the
 *     prediction must count that row (review round 1 S1: a plain approval's prediction kept one
 *     row, and the card grew by a row after it painted);
 *   - the plain approval and the plan editor, whose other regions are fixed rows, are exactly as
 *     tall as measured, mounted as the transcript mounts them; the outline plan's approval is too,
 *     inside `.nf-type-scope` as its own suite paints it (its summary line is Mantine text, which
 *     only that scope maps onto the reader's typography);
 *   - moving the typography under a mounted card resizes its textarea (a slider drag changes only
 *     the CSS variables, which by themselves re-render nothing);
 *   - the same card outside the transcript (the question inbox) keeps Mantine's textarea, and so
 *     does an async question's form in the Details modal its transcript summary opens (review
 *     round 1 S2: the modal portals out of the transcript, but context followed it);
 *   - the zero-DOM copies' stand-in boxes paint the live textarea's text, letter spacing included.
 *
 * The AskUserQuestion card is checked by its textarea only: the vlist reserves nothing for it
 * (its height stays on the dynamic path), and its header, options and buttons are Mantine's own.
 *
 * This suite owns only an ephemeral static server and browser: it never touches NarraFork.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./permission-textarea.browser-fixture";

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

type FixtureWindow = Window & { fixture: typeof Fixture };
type Reading = Fixture.CardReading;
type Kind = Fixture.CardKind;

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page | undefined;
const errors: string[] = [];

beforeAll(async () => {
	if (!existsSync(executablePath))
		throw new Error(`Chromium unavailable at ${executablePath}; set NF_TEST_CHROMIUM_PATH`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./permission-textarea.browser-fixture.tsx", import.meta.url).pathname],
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
					`<!doctype html><html><head><meta charset="utf-8">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
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
	await page.setViewport({ width: 1000, height: 1200 });
	await page.goto(`${server.url.origin}/`, { waitUntil: "networkidle0" });
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}, 60_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

function measure(
	kind: Kind,
	lng: string,
	width: number,
	font: number,
	line: number,
	host: "transcript" | "scoped" | "inbox",
): Promise<Reading> {
	if (!page) throw new Error("no page");
	return page.evaluate(
		(...args) =>
			(window as unknown as FixtureWindow).fixture.measure(
				...(args as Parameters<typeof Fixture.measure>),
			),
		kind,
		lng,
		width,
		font,
		line,
		host,
	);
}

function retype(kind: Kind, lng: string, width: number, font: number, line: number) {
	if (!page) throw new Error("no page");
	return page.evaluate(
		(...args) =>
			(window as unknown as FixtureWindow).fixture.retype(
				...(args as Parameters<typeof Fixture.retype>),
			),
		kind,
		lng,
		width,
		font,
		line,
	);
}

function asyncQuestion(view: "form" | "summary", font: number, line: number) {
	if (!page) throw new Error("no page");
	return page.evaluate(
		(...args) =>
			(window as unknown as FixtureWindow).fixture.asyncQuestion(
				...(args as Parameters<typeof Fixture.asyncQuestion>),
			),
		view,
		font,
		line,
	);
}

function purePath(font: number, line: number, letterSpacing: number) {
	if (!page) throw new Error("no page");
	return page.evaluate(
		(...args) =>
			(window as unknown as FixtureWindow).fixture.purePath(
				...(args as Parameters<typeof Fixture.purePath>),
			),
		font,
		line,
		letterSpacing,
	);
}

/**
 * Every textarea of the card: the model's height for its rows, on the model's line box; and the
 * feedback box's rows as the vlist predicted them (the per-textarea check takes its rows from the
 * paint, so only this one catches a wrong row count).
 */
function expectTextareasAsModelled(card: Reading, what: string, count: number): void {
	expect(card.textareas.length, what).toBe(count);
	for (const [i, textarea] of card.textareas.entries()) {
		const which = `${what} textarea ${i}`;
		expect(textarea.line, which).toBe(card.modelLine);
		expect(textarea.fontSize, which).toBeCloseTo(card.modelFontSize, 5);
		expect(Math.abs(textarea.painted - textarea.model), which).toBeLessThanOrEqual(0.5);
		expect(textarea.minHeight, which).toBe(0);
	}
	if (card.feedback) {
		expect(card.feedback.predicted, `${what} feedback rows`).toBe(card.feedback.painted);
	}
}

const KINDS: ReadonlyArray<readonly [Kind, number]> = [
	["inline", 1],
	["plan-edit", 2],
	["outline-plan", 1],
	["ask", 1],
];
/** 288 and 180%: the plain approval's placeholder wraps to two rows there (review round 1 S1). */
const WIDTHS = [288, 328, 360, 720];
const LANGUAGES = ["en", "zh-CN"];
/** [font scale, line height] in percent. */
const TYPOGRAPHY = [
	[100, 100],
	[130, 100],
	[100, 150],
	[130, 150],
	[180, 100],
] as const;

for (const [kind, count] of KINDS) {
	test(`${kind}: every textarea is the model's rows, and the card is as tall as measured`, async () => {
		for (const lng of LANGUAGES) {
			for (const [font, line] of TYPOGRAPHY) {
				for (const width of WIDTHS) {
					const what = `${kind} ${lng} ${font}%/${line}% at ${width}px`;
					const card = await measure(kind, lng, width, font, line, "transcript");
					expectTextareasAsModelled(card, what, count);
					expect(card.overflowX, what).toBe(false);
					if (kind === "inline" || kind === "plan-edit") {
						expect(Math.abs(card.measured - card.rendered), what).toBeLessThanOrEqual(1);
					}
					if (kind === "outline-plan") {
						const scoped = await measure(kind, lng, width, font, line, "scoped");
						expectTextareasAsModelled(scoped, `${what} (scoped)`, count);
						expect(
							Math.abs(scoped.measured - scoped.rendered),
							`${what} (scoped)`,
						).toBeLessThanOrEqual(1);
					}
				}
			}
		}
		expect(errors).toEqual([]);
	}, 120_000);
}

test("at the smallest line height a textarea is still exactly its rows (no Mantine floor)", async () => {
	for (const [kind, count] of KINDS) {
		for (const lng of LANGUAGES) {
			const card = await measure(kind, lng, 360, 100, 60, "transcript");
			// 13px rows: one row (24px) is below the 30px Mantine gives an xs input.
			expect(card.modelLine, kind).toBe(13);
			expectTextareasAsModelled(card, `${kind} ${lng} 100%/60%`, count);
		}
	}
	expect(errors).toEqual([]);
}, 60_000);

test("moving the typography under a mounted card resizes its textareas", async () => {
	for (const [kind, count] of KINDS) {
		const before = await measure(kind, "en", 720, 100, 100, "transcript");
		expectTextareasAsModelled(before, `${kind} before`, count);
		const after = await retype(kind, "en", 720, 130, 150);
		expect(after.modelLine, kind).toBe(44);
		expectTextareasAsModelled(after, `${kind} after the change`, count);
		if (kind === "inline" || kind === "plan-edit") {
			expect(Math.abs(after.measured - after.rendered), kind).toBeLessThanOrEqual(1);
		}
	}
	expect(errors).toEqual([]);
}, 60_000);

test("outside the transcript the same card keeps Mantine's textarea", async () => {
	for (const [kind, count] of KINDS) {
		const card = await measure(kind, "en", 720, 100, 150, "inbox");
		expect(card.textareas.length, kind).toBe(count);
		for (const textarea of card.textareas) {
			// 12px × Mantine's 1.55, not the reader's 33px row.
			expect(textarea.line, kind).toBeCloseTo(18.6, 5);
		}
	}
	expect(errors).toEqual([]);
}, 60_000);

test("an async question's form follows the transcript; its summary's Details modal keeps Mantine's", async () => {
	// The form, inline in the transcript: the reader's row (33px at a 150% line height).
	const form = await asyncQuestion("form", 100, 150);
	expect(form.inModal).toBe(false);
	expect(form.textareas.length).toBe(1);
	expect(form.textareas[0]?.line).toBe(form.modelLine);
	expect(form.modelLine).toBe(33);
	expect(form.textareas[0]?.minHeight).toBe(0);
	// The same form opened from the transcript's summary, in its modal: Mantine's own textarea,
	// as the question inbox opens it.
	const modal = await asyncQuestion("summary", 100, 150);
	expect(modal.inModal).toBe(true);
	expect(modal.textareas.length).toBe(1);
	expect(modal.textareas[0]?.line).toBeCloseTo(18.6, 5);
	expect(modal.textareas[0]?.minHeight).toBe(30);
	expect(modal.textareas[0]?.painted).toBe(30);
	expect(errors).toEqual([]);
}, 60_000);

test("the zero-DOM copies' stand-in textareas paint the live textarea's text", async () => {
	const { standIns, live } = await purePath(130, 150, 25);
	// The plan editor, the feedback box and the custom answer.
	expect(standIns.length).toBe(3);
	expect(live.letterSpacing).toBeGreaterThan(0);
	for (const [i, standIn] of standIns.entries()) {
		expect(standIn.fontSize, `stand-in ${i}`).toBeCloseTo(live.fontSize, 5);
		expect(standIn.line, `stand-in ${i}`).toBe(live.line);
		expect(standIn.letterSpacing, `stand-in ${i}`).toBeCloseTo(live.letterSpacing, 5);
	}
	expect(errors).toEqual([]);
}, 60_000);
