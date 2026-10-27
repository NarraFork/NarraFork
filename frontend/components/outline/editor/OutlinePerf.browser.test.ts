/**
 * The live editor on the largest page a session takes (P0 acceptance item 7 of design §6.9):
 * 2000 blocks open, typing and splitting work, the other person sees it. Behaviour only; the
 * timings are printed with `NF_OUTLINE_PERF_LOG=1` (headless Chromium, no GPU: relative
 * numbers, measured locally, never asserted in CI).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	errorsOf,
	type Harness,
	openEditor,
	resetHarness,
	seedPage,
	serverText,
	settle,
	startHarness,
	stopHarness,
	until,
} from "./outline-live-harness.browser-fixture";

let h: Harness;

beforeAll(async () => {
	h = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(h);
});

afterEach(async () => {
	await resetHarness(h);
});

const LOG = process.env.NF_OUTLINE_PERF_LOG === "1";

function summary(values: number[]) {
	const s = [...values].sort((a, b) => a - b);
	const at = (p: number) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
	return { n: s.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

test("a 2000-block page: opens, takes typing and splits, and the other person sees them", async () => {
	// 1999 blocks under the page (2000 with it): every 10th at the top, the rest under it.
	const words = ["大纲", "块模型", "真相", "编辑器", "live", "session", "**粗体**", "`code`"];
	const lines = Array.from({ length: 1999 }, (_, i) => {
		const text = Array.from({ length: 4 + (i % 9) }, (_, k) => words[(i + k) % words.length]).join(
			" ",
		);
		return i % 10 === 0 ? text : `  ${text}`;
	});
	// The block typed in ends in plain text (typing after bold would continue the bold).
	lines[1001] = "  中间的块 plain";
	const t0 = performance.now();
	const { pageId, ids } = await seedPage(h, "Perf", lines);
	const seedMs = performance.now() - t0;
	const t1 = performance.now();
	const a = await openEditor(h, h.owner, pageId);
	const openA = performance.now() - t1;
	const t2 = performance.now();
	const b = await openEditor(h, h.writer, pageId);
	const openB = performance.now() - t2;
	expect(await a.call((f) => f.blockCount())).toBe(2000);
	expect(await a.call(() => document.querySelectorAll(".ob-block").length)).toBe(2000);

	// Type in the middle of the page, measuring keydown to the next frame.
	const mid = ids[1001] as string;
	await a.call((f, id) => {
		f.caret(id as never);
		f.dom(id as never)?.scrollIntoView({ block: "center" });
		const w = window as unknown as { __lat: Array<{ key: string; ms: number }> };
		w.__lat = [];
		f.view().pm.dom.addEventListener(
			"keydown",
			(ev) => {
				const t = performance.now();
				requestAnimationFrame(() => w.__lat.push({ key: ev.key, ms: performance.now() - t }));
			},
			true,
		);
	}, mid);
	const before = serverText(pageId, mid) ?? "";
	await a.page.keyboard.type("abc大纲编辑器defghij", { delay: 30 });
	const want = `${before}abc大纲编辑器defghij`;
	const t3 = performance.now();
	await until(b, (f, id, w) => f.viewText(id as never) === w, [mid, want], 10_000);
	const remoteMs = performance.now() - t3;
	await settle(a, b);
	expect(serverText(pageId, mid)).toBe(want);

	// Splits (a structural transaction on a large page each).
	for (let i = 0; i < 5; i++) await a.page.keyboard.press("Enter");
	await settle(a, b);
	expect(await b.call((f) => f.blockCount())).toBe(2005);
	const lat = await a.page.evaluate(
		() => (window as unknown as { __lat: Array<{ key: string; ms: number }> }).__lat,
	);
	const heapMB = await a.page.evaluate(
		() =>
			((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
				0) / 1048576,
	);
	if (LOG) {
		console.log(
			JSON.stringify(
				{
					seedMs: Math.round(seedMs),
					openFirstMs: Math.round(openA),
					openSecondMs: Math.round(openB),
					keyToFrameMs: summary(lat.filter((x) => x.key !== "Enter").map((x) => x.ms)),
					enterToFrameMs: summary(lat.filter((x) => x.key === "Enter").map((x) => x.ms)),
					lastKeyToOtherEditorMs: Math.round(remoteMs),
					heapMB: +heapMB.toFixed(1),
					stats: await a.call((f) => f.stats()),
				},
				null,
				1,
			),
		);
	}
	expect(errorsOf(a)).toEqual([]);
	expect(errorsOf(b)).toEqual([]);
}, 120_000);
