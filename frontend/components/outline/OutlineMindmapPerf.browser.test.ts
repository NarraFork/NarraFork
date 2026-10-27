/**
 * The mind map on the largest live page, and the quick switcher over 10,000 blocks (plan §10.2
 * items 1 and 6 in the product), in both hosts (the outline page and a dock panel).
 *
 * In CI only behaviour is asserted: the map draws a 2000-block page, switches complete, the anchor
 * block is on screen after each switch, editing in a node lays out again, and the switcher finds
 * titles, aliases and text in the current page and in other pages and focuses them. The numbers
 * (layout p95, first draw, frame times during switches, anchor drift, key to focus) are measured
 * locally and printed with `NF_OUTLINE_PERF_LOG=1` (headless Chromium without a GPU: relative
 * numbers, reported in the PR, never asserted).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { KeyInput, Page } from "puppeteer-core";
import { writeOutline } from "../../../server/services/outline/write";
import { seedPage, settle } from "./editor/outline-live-harness.browser-fixture";
import {
	type Host,
	type MapEditor,
	type MapHarness,
	openHost,
	resetMap,
	settled,
	startMapHarness,
	stopMapHarness,
	summary,
} from "./outline-mindmap-harness.browser-fixture";

let h: MapHarness;

beforeAll(async () => {
	h = await startMapHarness();
}, 60_000);

afterAll(async () => {
	await stopMapHarness(h);
});

afterEach(async () => {
	await resetMap(h);
});

const LOG = process.env.NF_OUTLINE_PERF_LOG === "1";
const HOSTS: Host[] = ["page", "panel"];
const VIEWPORT = { width: 1280, height: 900 };

async function press(page: Page, ...keys: KeyInput[]): Promise<void> {
	const last = keys[keys.length - 1] as KeyInput;
	for (const m of keys.slice(0, -1)) await page.keyboard.down(m);
	await page.keyboard.press(last);
	for (const m of keys.slice(0, -1).reverse()) await page.keyboard.up(m);
}

const WORDS = ["大纲", "块模型", "真相", "编辑器", "live", "session", "**粗体**", "`code`", "导图"];

/** `n` blocks under a page, three levels: every 10th at the top, then two levels under it. */
function bigLines(n: number, tag: string, extra: (i: number) => string = () => ""): string[] {
	return Array.from({ length: n }, (_, i) => {
		const text = `${tag}-${i} ${Array.from({ length: 3 + (i % 7) }, (_, k) => WORDS[(i + k) % WORDS.length]).join(" ")}${extra(i)}`;
		const r = i % 10;
		return r === 0 ? text : r <= 4 ? `  ${text}` : `    ${text}`;
	});
}

/** Frame intervals of each switch, from its start to the end of its animation (plus a frame). */
function frameWindows(
	log: Array<{ kind: string; at: number; doneAt?: number }>,
	frames: number[],
): { all: number[]; per: Array<{ kind: string; frames: number; max: number; over50: number }> } {
	const all: number[] = [];
	const per: Array<{ kind: string; frames: number; max: number; over50: number }> = [];
	for (const e of log) {
		const end = (e.doneAt ?? e.at) + 20;
		const ds: number[] = [];
		for (let i = 1; i < frames.length; i++) {
			if ((frames[i] as number) < e.at) continue;
			if ((frames[i - 1] as number) > end) break;
			ds.push((frames[i] as number) - (frames[i - 1] as number));
		}
		all.push(...ds);
		per.push({
			kind: e.kind,
			frames: ds.length,
			max: +Math.max(0, ...ds).toFixed(1),
			over50: ds.filter((d) => d > 50).length,
		});
	}
	return { all, per };
}

const SEQUENCE: Array<{
	kind: string;
	op: { view?: "outline" | "map"; layout?: "right" | "down" };
}> = [
	{ kind: "toOutline", op: { view: "outline" } },
	{ kind: "toMap", op: { view: "map" } },
	{ kind: "down", op: { layout: "down" } },
	{ kind: "right", op: { layout: "right" } },
	{ kind: "toOutline", op: { view: "outline" } },
	{ kind: "toMap", op: { view: "map" } },
	{ kind: "down", op: { layout: "down" } },
	{ kind: "toOutline", op: { view: "outline" } },
	{ kind: "toMap(down)", op: { view: "map" } },
	{ kind: "right", op: { layout: "right" } },
	{ kind: "toOutline", op: { view: "outline" } },
	{ kind: "toMap", op: { view: "map" } },
];

async function middle(a: MapEditor, ids: string[]): Promise<string> {
	const mid = ids[1001] as string;
	await a.call((f, x) => f.caret(x as never, 3), mid);
	await a.call((f, x) => f.centerRow(x as never), mid);
	await new Promise((r) => setTimeout(r, 200));
	return mid;
}

for (const host of HOSTS) {
	test(`${host}: a 2000-block page in the map — draw, switch, anchor, lay out (item 1)`, async () => {
		const { pageId, ids } = await seedPage(h, `Perf ${host}`, bigLines(1999, "B"));
		const metrics: Record<string, unknown> = {};

		// Without measuring ahead: the first switch measures 2000 bodies on the spot.
		{
			const cold = await openHost(h, host, pageId, { ...VIEWPORT, noWorker: true });
			await middle(cold, ids);
			const first = await cold.call((f) => f.switchToPaint({ view: "map" }));
			const st = await cold.call((f) => f.mapStats());
			metrics.coldNoWorker = {
				firstDrawMs: +first.painted.toFixed(1),
				syncMs: +first.sync.toFixed(1),
				measured: st.measure.misses,
				measureMs: +st.measure.ms.toFixed(1),
				firstLayoutMs: +(st.layouts[0] ?? 0).toFixed(1),
			};
			expect((await cold.call((f) => f.mapState())).active).toBe(true);
			await resetMap(h);
		}

		const a = await openHost(h, host, pageId, VIEWPORT);
		expect(await a.call((f) => f.client().visible.subtree(f.client().pageId).length)).toBe(2000);
		metrics.prewarm = await a.call((f) => f.prewarmDone());
		await middle(a, ids);
		await a.call((f) => f.recordFrames(true));
		const first = await a.call((f) => f.switchToPaint({ view: "map" }));
		metrics.firstDraw = {
			ms: +first.painted.toFixed(1),
			syncMs: +first.sync.toFixed(1),
			shownMs: +first.shown.toFixed(1),
		};
		await settled(a);
		expect((await a.call((f) => f.mapState())).active).toBe(true);
		expect((await a.call((f) => f.mapState())).nodesInDom).toBeLessThan(400);
		for (const step of SEQUENCE) {
			await new Promise((r) => setTimeout(r, 150));
			await a.call((f, op) => f.switchToPaint(op as never), step.op);
			await settled(a);
		}
		await new Promise((r) => setTimeout(r, 100));
		const frames = await a.call((f) => f.recordFrames(false));
		const log = await a.call((f) => f.log());
		const windows = frameWindows(log, frames);
		metrics.frames = {
			all: summary(windows.all),
			over50: windows.all.filter((d) => d > 50).length,
			per: windows.per,
		};
		// Anchor drift: after each switch, where the anchor block's body is vs. before.
		const drift: Array<{ kind: string; dx: number; dy: number }> = [];
		for (const step of SEQUENCE) {
			await new Promise((r) => setTimeout(r, 100));
			await a.call((f, op) => f.switchToPaint(op as never), step.op);
			await settled(a);
			const last = (await a.call((f) => f.log())).at(-1);
			const anchor = last?.anchor;
			if (!anchor) continue;
			const p = await a.call((f, x) => f.anchorScreen(x as never), anchor.blockId);
			expect(p).not.toBeNull();
			if (!p) continue;
			drift.push({
				kind: step.kind,
				dx: +Math.abs(p.x - anchor.x).toFixed(2),
				dy: +Math.abs(p.y - anchor.y).toFixed(2),
			});
		}
		expect(drift.length).toBe(SEQUENCE.length);
		metrics.anchorDriftPx = {
			worst: Math.max(...drift.map((d) => (d.kind === "toOutline" ? d.dy : Math.max(d.dx, d.dy)))),
			toOutlineDxMax: Math.max(0, ...drift.filter((d) => d.kind === "toOutline").map((d) => d.dx)),
			per: drift,
		};

		// Layout while editing in the map: typing in a node, adding children, folding.
		await a.call((f) => f.setView("map"));
		await settled(a);
		const before = (await a.call((f) => f.mapStats())).layouts.length;
		const target = ids[1200] as string;
		await a.call((f, x) => f.mapSelect(x as never), target);
		await a.call((f) => f.recordKeyLatency(true));
		await a.page.keyboard.press("F2");
		await a.page.keyboard.type("abcdefghijklmnopqrstuvwxyz0123456789".repeat(2), { delay: 30 });
		await new Promise((r) => setTimeout(r, 100));
		const typing = (await a.call((f) => f.recordKeyLatency(false)))
			.slice(1)
			.filter((x) => x.key.length === 1)
			.map((x) => x.ms);
		await a.page.keyboard.press("Escape");
		for (let i = 0; i < 5; i++) {
			await a.page.keyboard.press("Tab");
			await a.page.keyboard.type(`子${i}`);
			await a.page.keyboard.press("Escape");
			await a.page.keyboard.press("ArrowLeft");
			await new Promise((r) => setTimeout(r, 30));
		}
		const withKids = await a.call((f) => {
			const m = f.surface().map;
			return m.order.filter((id) => m.info.get(id)?.hasKids).slice(10, 20);
		});
		for (const id of withKids) {
			await a.call((f, x) => f.mapSelect(x as never), id);
			await a.page.keyboard.press(" ");
			await new Promise((r) => setTimeout(r, 20));
			await a.page.keyboard.press(" ");
			await new Promise((r) => setTimeout(r, 20));
		}
		await settle(a);
		const st = await a.call((f) => f.mapStats());
		const lay = st.layouts.slice(before);
		expect(lay.length).toBeGreaterThan(20);
		metrics.layout = {
			all: summary(lay),
			treeOnly: summary(st.treeMs.slice(before)),
			measureOnly: summary(st.measureMs.slice(before)),
		};
		metrics.nodeTypingKeyToPaint = summary(typing);
		metrics.accuracy = await a.call((f) => f.nodeAccuracy());
		expect((await a.call((f, x) => f.text(x as never), target)).includes("abcdefghij")).toBe(true);
		expect(a.errors).toEqual([]);
		if (LOG) console.log(JSON.stringify({ item: 1, host, ...metrics }, null, 1));
	}, 240_000);
}

for (const host of HOSTS) {
	test(`${host}: the quick switcher over 10,000 blocks — title, alias, text, here and elsewhere (item 6)`, async () => {
		// Five pages of 2000 blocks (10,000 blocks, 10,005 with the pages) in the current space.
		const pages: Array<{ pageId: string; ids: string[] }> = [];
		for (let p = 1; p <= 5; p++) {
			pages.push(
				await seedPage(
					h,
					`Switch ${host} P${p}`,
					// Pages 1 and 3 get one more block below (an alias): 2000 with the page, the
					// live limit.
					bigLines(p === 1 || p === 3 ? 1998 : 1999, `${host}P${p}`, (i) =>
						i % 97 === 48 ? `\n第二行 tok${host}P${p}x${i}` : "",
					),
				),
			);
		}
		const aliasPage = pages[2] as { pageId: string; ids: string[] };
		const aliased = await writeOutline({
			spaceId: h.space.id,
			ops: [
				{
					op: "insert",
					parent: { id: aliasPage.pageId },
					content: `带别名的块 ${host}`,
					alias: `别名${host}P3`,
				},
				{
					op: "insert",
					parent: { id: (pages[0] as { pageId: string }).pageId },
					content: `本页带别名 ${host}`,
					alias: `别名${host}P1`,
				},
			],
			actor: { kind: "human", id: h.owner },
			responsibleUserId: h.owner,
		});
		const [aliasP3, aliasP1] = aliased.results.map((r) => r.blockId) as [string, string];
		const p1 = pages[0] as { pageId: string; ids: string[] };
		const a = await openHost(h, host, p1.pageId, VIEWPORT);
		const lat: Array<{ name: string; ms: number; editableMs: number; readOnlyFirst: boolean }> = [];
		const queryMs: number[] = [];
		const builds: Array<{ name: string; buildMs: number; parsed: number }> = [];
		const idOfText = async (text: string, page: { pageId: string; ids: string[] }) => {
			const { outlineStore } = await import("../../../server/services/outline/store");
			for (const id of page.ids) {
				const b = await outlineStore.getBlock(id);
				if (b?.content.includes(text)) return id;
			}
			throw new Error(`no block with ${text}`);
		};
		/** Mod-K, type, wait for the expected first row, Enter; returns Enter → focus landed. */
		const jump = async (name: string, q: string, want: string, via: string) => {
			const where = await a.call((f) => f.focusWhere());
			await press(a.page, "Control", "k");
			await a.page
				.waitForSelector("[data-testid=outline-switcher] input", { timeout: 5000 })
				.catch(() => {
					throw new Error(`${name}: Mod-K opened no switcher (keyboard focus: ${where})`);
				});
			await a.page.keyboard.type(q, { delay: 10 });
			try {
				await a.page.waitForFunction(
					(w) => {
						const row = document.querySelector(
							"[data-testid=outline-switcher] [role=option]",
						) as HTMLElement | null;
						return row?.dataset.block === w;
					},
					{ timeout: 10_000, polling: 10 },
					want,
				);
			} catch {
				throw new Error(
					`${name}: first row is not ${want}: ${JSON.stringify(await a.call((f) => f.switcherRows()))}`,
				);
			}
			const rows = await a.call((f) => f.switcherRows());
			expect({ name, via: rows[0]?.via }).toEqual({ name, via });
			const ix = await a.call((f) => f.switcherIndexStats());
			queryMs.push(ix.queryMs);
			builds.push({ name, buildMs: +ix.buildMs.toFixed(1), parsed: ix.parsed });
			const r = await a.call((f, w) => f.switcherEnterToFocus(w as never), want);
			expect({ name, focused: r.focused, live: r.editableMs > 0 }).toEqual({
				name,
				focused: true,
				live: true,
			});
			lat.push({
				name,
				ms: +r.ms.toFixed(1),
				editableMs: +r.editableMs.toFixed(1),
				readOnlyFirst: r.wasSeeded,
			});
			await settled(a);
			// The keyboard is there too: in the map's stage, or in the outline.
			const view = await a.call((f) => f.surface().view);
			expect({ name, keys: await a.call((f) => f.focusWhere()) }).toEqual({
				name,
				keys: view === "map" ? "map-stage" : "outline",
			});
		};

		// The keyboard is in the editor (Mod-K is the surface's key, not the document's).
		await a.call((f, x) => f.caret(x as never, 0), p1.ids[0]);
		// The page on screen: its own index (title, text), and an alias the server knows.
		await jump("title, this page", `${host}P1-600 `, await idOfText(`${host}P1-600 `, p1), "title");
		await jump(
			"text on a second line, this page",
			`tok${host}P1x145`,
			await idOfText(`tok${host}P1x145`, p1),
			"body",
		);
		await jump("alias, this page", `别名${host}P1`, aliasP1, "alias");
		// The map: the target becomes the root and is selected.
		await a.call((f) => f.setView("map"));
		await settled(a);
		const mapTarget = await idOfText(`${host}P1-700 `, p1);
		await jump("title in the map, this page", `${host}P1-700 `, mapTarget, "title");
		expect((await a.call((f) => f.mapState())).root).toBe(mapTarget);
		expect((await a.call((f) => f.mapState())).selected).toBe(mapTarget);
		// Recently focused first: the empty query lists them.
		await press(a.page, "Control", "k");
		await a.page.waitForSelector("[data-testid=outline-switcher] input");
		await new Promise((r) => setTimeout(r, 50));
		expect((await a.call((f) => f.switcherRows()))[0]?.id).toBe(mapTarget);
		await a.page.keyboard.press("Escape");
		expect(await a.call((f) => f.switcherOpen())).toBe(false);
		// Other pages of the space (the server's search): the surface switches page in place; the
		// map stays the map.
		const p4Target = await idOfText(`${host}P4-1250 `, pages[3] as never);
		await jump("title in the map, another page", `${host}P4-1250 `, p4Target, "title");
		expect((await a.call((f) => f.mapState())).root).toBe(p4Target);
		// Another page itself, in the map: the whole page waits for the Worker's measurements
		// (no 2000 measurements on the main thread), then draws.
		const p5 = pages[4] as { pageId: string };
		await jump("whole page in the map, another page", `Switch ${host} P5`, p5.pageId, "title");
		expect((await a.call((f) => f.mapState())).root).toBe(p5.pageId);
		const drawn = (await a.call((f) => f.mapState())).nodesInDom;
		expect(drawn).toBeGreaterThan(10);
		expect(drawn).toBeLessThan(400);
		// The outline behind a map shown since the page arrived is built and laid out on the
		// first switch when it comes before the quiet warm-up: that switch's time and longest
		// frame (measured, not asserted).
		// (Cold unless the surface sat quiet long enough to warm it: reported, not asserted.)
		const coldSwitch = await a.call((f) => f.timedSetView("outline"));
		await settled(a);
		expect(await a.call((f) => f.surface().view)).toBe("outline");
		await jump("alias, another page", `别名${host}P3`, aliasP3, "alias");
		await jump(
			"text on a second line, another page",
			`tok${host}P2x48`,
			await idOfText(`tok${host}P2x48`, pages[1] as never),
			"body",
		);
		// It is live there: typing goes into the focused block.
		await a.call((f) => f.surface().focusActiveView());
		await a.page.keyboard.type("！");
		await settle(a);
		expect(a.errors).toEqual([]);
		if (LOG)
			console.log(
				JSON.stringify(
					{
						item: 6,
						host,
						indexBuilds: builds,
						firstSwitchAfterColdMap: {
							wasCold: coldSwitch.wasCold,
							syncMs: +coldSwitch.syncMs.toFixed(1),
							maxFrameMs: +coldSwitch.maxFrameMs.toFixed(1),
						},
						keyToFocusMs: lat,
						keyToFocusThisPage: summary(
							lat.filter((x) => /this page/.test(x.name)).map((x) => x.ms),
						),
						keyToFocusOtherPage: summary(
							lat.filter((x) => /another/.test(x.name) && !/whole/.test(x.name)).map((x) => x.ms),
						),
						keyToEditableOtherPage: summary(
							lat
								.filter((x) => /another/.test(x.name) && !/whole/.test(x.name))
								.map((x) => x.editableMs),
						),
						localQueryMs: summary(queryMs),
					},
					null,
					1,
				),
			);
	}, 300_000);
}
