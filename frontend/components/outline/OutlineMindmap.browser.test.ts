/**
 * The outline's two views in Chromium (plan §10.2 in the product, design §6.10, D29, D29a, D29b,
 * D33, D34): the outline and the mind map of a live page, in both hosts of the surface — the
 * outline page (its route: the URL is the focus, history is the browser's) and an outline dock
 * panel beside a session (its params and its own history) — against the real outline routes and
 * live sessions, with a second person in the bare live editor.
 *
 *   2. State carries over: focus, folding, block selection, caret block (and offsets) survive 20
 *      round trips between the views, ten after the animation and ten in the middle of it.
 *   3. Mind-map editing produces the same outline transactions as the outline view: the same
 *      semantic steps done with the map's keys and drags and with the outline's keys give the
 *      same block tree after every step; undo and redo continue across the views; another person
 *      editing the same block at the same time converges.
 *   4. IME in a node while a remote edit arrives: nothing is lost (PR8's IME harness, CDP).
 *   5. Focus: Alt+→ / Alt+←, the breadcrumbs, back and forward (the browser's on the page, the
 *      panel's own in a panel), the same in the map, and operations during an animation.
 *   7. Reduced motion: every switch completes at once with no animation.
 *   8. Touch: one-finger pan, pinch, tap to select, double tap to edit, long-press drag.
 *
 * Read-only first (owner's decision for item 6): another page is shown from its HTTP read at
 * once, in the outline and in the map, and turns live in place — the same rows and nodes,
 * focus, folding, cursor and viewport — while what was typed meanwhile is merged and structural
 * keys wait (the "connecting" badge nudges); a panel hidden before that leaves the session as
 * soon as its join is answered.
 *
 * Items 1 and 6 (performance, quick switcher on 10,000 blocks) are in
 * `OutlineMindmapPerf.browser.test.ts`. Behaviour only: no timing is asserted here.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { KeyInput, Page } from "puppeteer-core";
import { liveSessionOf } from "../../../server/services/outline/live/registry";
import {
	ime,
	seedPage,
	serverOutline,
	serverText,
	settle,
} from "./editor/outline-live-harness.browser-fixture";
import type { TreeNode } from "./outline-mindmap.browser-fixture";
import {
	type Host,
	type MapEditor,
	type MapHarness,
	openBob,
	openHost,
	resetMap,
	settled,
	startMapHarness,
	stopMapHarness,
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

const HOSTS: Host[] = ["page", "panel"];

/** Top-level blocks T1…T9; T2 has two children. */
const LINES = [
	"T1 块模型是真相",
	"T2 编辑器文档只是投影",
	"  T2a 每个块节点带块 id",
	"  T2b 选中第三到第六个字",
	"T3 第三块：拼接视图里也会出现",
	"T4 第四块",
	"T5 第五块",
	"T6 第六块",
	"T7 第七块",
	"T8 第八块",
	"T9 最后一块",
];

interface Seeded {
	pageId: string;
	id: (label: string) => string;
}

async function seed(title: string): Promise<Seeded> {
	const { pageId, ids } = await seedPage(h, title, LINES);
	const byLabel = new Map<string, string>();
	LINES.forEach((line, i) => {
		byLabel.set(line.trim().split(" ")[0] as string, ids[i] as string);
	});
	return {
		pageId,
		id: (label) => {
			const v = byLabel.get(label);
			if (!v) throw new Error(`no block ${label}`);
			return v;
		},
	};
}

async function press(page: Page, ...keys: KeyInput[]): Promise<void> {
	const last = keys[keys.length - 1] as KeyInput;
	const mods = keys.slice(0, -1);
	for (const m of mods) await page.keyboard.down(m);
	await page.keyboard.press(last);
	for (const m of [...mods].reverse()) await page.keyboard.up(m);
}

const tree = (e: MapEditor): Promise<TreeNode[]> => e.call((f) => f.blockTree());
const state = (e: MapEditor) => e.call((f) => f.state());
const map = (e: MapEditor) => e.call((f) => f.mapState());

async function idle(e: MapEditor): Promise<void> {
	expect(await e.call((f) => f.idle())).toBe(true);
}

/** Drag a node onto another: `frac` along the sibling axis (0.5: its middle). */
async function drag(e: MapEditor, id: string, target: string, frac: number): Promise<void> {
	const a = await e.call((f, x) => f.nodeRect(x as never), id);
	const b = await e.call((f, x) => f.nodeRect(x as never), target);
	if (!a || !b) throw new Error(`no node DOM: ${id} / ${target}`);
	const mouse = e.page.mouse;
	await mouse.move(a.x + a.w / 2, a.y + a.h / 2);
	await mouse.down();
	await mouse.move(a.x + a.w / 2 + 10, a.y + a.h / 2 + 10, { steps: 3 });
	await mouse.move(b.x + b.w / 2, b.y + b.h * frac, { steps: 8 });
	await mouse.up();
}

/** Click an outline block's frame part (arrow or bullet). */
async function clickGutter(e: MapEditor, id: string, part: "arrow" | "bullet"): Promise<void> {
	await e.page.evaluate(
		(x, p) => {
			const el = document.querySelector(
				`.nf-outline-scroller .ob-block[data-id="${x}"] > .ob-gutter .ob-${p}`,
			);
			el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		},
		id,
		part,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. State carries over
// ─────────────────────────────────────────────────────────────────────────────

for (const host of HOSTS) {
	test(`${host}: focus, folding, selection and caret survive 20 round trips (item 2)`, async () => {
		const s = await seed(`State ${host}`);
		const a = await openHost(h, host, s.pageId);
		const kb = a.page.keyboard;
		const keep = async () => {
			const st = await state(a);
			return {
				focus: st.focus,
				collapsed: st.collapsed,
				caret: st.caret,
				blocks: st.blocks,
				layout: st.layout,
			};
		};
		const drift: number[] = [];
		const trips = async (
			label: string,
			want: Awaited<ReturnType<typeof keep>>,
			via: "api" | "button",
		) => {
			const bad: unknown[] = [];
			for (let i = 0; i < 20; i++) {
				const wait = i < 10;
				if (via === "button") await a.call((f) => f.clickView("map"));
				else await a.call((f) => f.setView("map"));
				if (wait) {
					await settled(a);
					const st = await state(a);
					const p = st.anchor
						? await a.call((f, x) => f.anchorScreen(x as never), st.anchor.blockId)
						: null;
					if (st.anchor && p)
						drift.push(Math.max(Math.abs(p.x - st.anchor.x), Math.abs(p.y - st.anchor.y)));
				}
				if (via === "button") await a.call((f) => f.clickView("outline"));
				else await a.call((f) => f.setView("outline"));
				if (wait) {
					await settled(a);
					const st = await state(a);
					const p = st.anchor
						? await a.call((f, x) => f.anchorScreen(x as never), st.anchor.blockId)
						: null;
					if (st.anchor && p) drift.push(Math.abs(p.y - st.anchor.y));
				}
				const now = await keep();
				if (JSON.stringify(now) !== JSON.stringify(want)) bad.push({ i, now });
			}
			await settled(a);
			expect({ label, state: await keep() }).toEqual({ label, state: want });
			expect(bad).toEqual([]);
		};

		// One: T3 indented under T2b... a fold, a focus and a selection inside a block.
		await a.call((f, x) => f.caret(x as never, 0), s.id("T4"));
		await press(a.page, "Tab"); // T4 under T3
		await idle(a);
		await clickGutter(a, s.id("T3"), "arrow"); // fold T3
		await clickGutter(a, s.id("T2"), "bullet"); // focus T2
		await settled(a);
		await a.call((f, x) => f.caret(x as never, 3, 6), s.id("T2b"));
		const S1 = await keep();
		expect(S1).toEqual({
			focus: s.id("T2"),
			collapsed: [s.id("T3")],
			caret: { blockId: s.id("T2b"), anchor: 3, head: 6 },
			blocks: [],
			layout: "right",
		});
		await trips("focus + fold + selection", S1, "api");
		expect(await a.call((f) => f.selection())).toEqual({
			anchor: { blockId: s.id("T2b"), offset: 3 },
			head: { blockId: s.id("T2b"), offset: 6 },
		});

		// Two: the whole page, downward, block selection (Esc) of the folded T3.
		await a.call((f, p) => f.focusBlock(p as never), s.pageId);
		await settled(a);
		await a.call((f) => f.setLayout("down"));
		await a.call((f, x) => f.caret(x as never, 2), s.id("T3"));
		await kb.press("Escape");
		const S2 = await keep();
		expect(S2.blocks).toEqual([s.id("T3")]);
		expect(S2.layout).toBe("down");
		await trips("block selection + downward (toolbar)", S2, "button");

		// Three: changed in the map, carried to the outline — space folds T2, Shift-click selects
		// T9, T6 selected.
		await kb.press("Escape");
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f) => f.setLayout("right"));
		await settled(a);
		await a.call((f, x) => f.mapSelect(x as never), s.id("T2"));
		await kb.press(" ");
		await a.call((f) => f.mapFit());
		await a.call((f, x) => f.mapSelect(x as never), s.id("T6"));
		const r9 = await a.call((f, x) => f.nodeRect(x as never), s.id("T9"));
		if (!r9) throw new Error("T9 not drawn");
		await kb.down("Shift");
		await a.page.mouse.click(r9.x + r9.w / 2, r9.y + r9.h / 2);
		await kb.up("Shift");
		await a.call((f) => f.setView("outline"));
		await settled(a);
		const S3 = await keep();
		expect([...S3.collapsed].sort()).toEqual([s.id("T2"), s.id("T3")].sort());
		expect(S3.blocks).toEqual([s.id("T9")]);
		expect(S3.caret?.blockId).toBe(s.id("T6"));
		await trips("changed in the map", S3, "api");

		// The anchor stays put (measured after the animation; numbers in the PR).
		expect(drift.length).toBeGreaterThan(20);
		expect(Math.max(...drift)).toBeLessThanOrEqual(2);
		expect(a.errors).toEqual([]);
	}, 180_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Editing in the map = editing in the outline; undo across views; concurrency
// ─────────────────────────────────────────────────────────────────────────────

async function scenario(
	host: Host,
	kind: "map" | "outline",
): Promise<{ steps: string[]; trees: TreeNode[][]; errors: string[] }> {
	const s = await seed(`Edit ${kind} ${host}`);
	const a = await openHost(h, host, s.pageId);
	const kb = a.page.keyboard;
	const steps: string[] = [];
	const trees: TreeNode[][] = [];
	const snap = async (label: string) => {
		await idle(a);
		steps.push(label);
		trees.push(await tree(a));
	};
	const end = async (id: string) => (await a.call((f, x) => f.text(x as never), id)).length;
	if (kind === "map") {
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f, x) => f.mapSelect(x as never), s.id("T3"));
		await kb.press("Tab");
		await kb.type("子一");
		await kb.press("Escape");
		await snap("Tab adds a child");
		expect(await a.call((f) => f.focusWhere())).toBe("map-stage");
		await kb.press("Enter");
		expect(await a.call((f) => f.focusWhere())).toBe("map-editor");
		await kb.type("子二");
		await press(a.page, "Shift", "Enter");
		await kb.type("换行");
		await kb.press("Escape");
		await snap("Enter adds a sibling");
		await kb.press("F2");
		expect(await a.call((f) => f.focusWhere())).toBe("map-editor");
		await kb.press("Escape");
		await press(a.page, "Shift", "Tab");
		await snap("Shift-Tab outdents");
		// Arrows, rightward: ↑↓ siblings, → first child, ← parent.
		const sel = async () => (await map(a)).selected;
		const child =
			(await a.call((f) => f.mapTree())).find((x) => x.parent === s.id("T3"))?.id ?? null;
		expect(child).not.toBeNull();
		await kb.press("ArrowUp");
		expect(await sel()).toBe(s.id("T3"));
		await kb.press("ArrowRight");
		expect(await sel()).toBe(child);
		await kb.press("ArrowLeft");
		expect(await sel()).toBe(s.id("T3"));
		await kb.press("ArrowDown");
		const sib = await sel();
		expect(sib && sib !== s.id("T3")).toBe(true);
		await kb.press("ArrowUp");
		// Downward: the arrows turn 90°.
		await a.call((f) => f.setLayout("down"));
		await settled(a);
		await kb.press("ArrowDown");
		expect(await sel()).toBe(child);
		await kb.press("ArrowUp");
		expect(await sel()).toBe(s.id("T3"));
		await kb.press("ArrowRight");
		expect(await sel()).toBe(sib);
		await kb.press("ArrowLeft");
		await a.call((f) => f.setLayout("right"));
		await settled(a);
		await press(a.page, "Alt", "ArrowDown");
		await snap("Alt+↓ moves down");
		await a.call((f, x) => f.mapSelect(x as never), s.id("T2"));
		await kb.press(" ");
		await snap("space folds");
		expect((await state(a)).collapsed).toContain(s.id("T2"));
		await a.call((f, x) => f.mapSelect(x as never), s.id("T9"));
		await press(a.page, "Control", "Enter");
		await snap("Mod-Enter makes a task");
		await a.call((f) => f.mapFit());
		await drag(a, s.id("T9"), s.id("T5"), 0.5);
		await snap("drag onto a node");
		await a.call((f) => f.mapFit());
		await drag(a, s.id("T1"), s.id("T5"), 0.92);
		await snap("drag between siblings");
		expect((await map(a)).selected).toBe(s.id("T1"));
	} else {
		await a.call((f, x, o) => f.caret(x as never, o as never), s.id("T3"), await end(s.id("T3")));
		await kb.press("Enter");
		await kb.press("Tab");
		await kb.type("子一");
		await snap("Tab adds a child");
		await kb.press("Enter");
		await kb.type("子二");
		await press(a.page, "Shift", "Enter");
		await kb.type("换行");
		await snap("Enter adds a sibling");
		await press(a.page, "Shift", "Tab");
		await snap("Shift-Tab outdents");
		await a.call((f, x) => f.caret(x as never, 0), s.id("T3"));
		await press(a.page, "Alt", "ArrowDown");
		await snap("Alt+↓ moves down");
		await clickGutter(a, s.id("T2"), "arrow");
		await snap("space folds");
		expect((await state(a)).collapsed).toContain(s.id("T2"));
		await a.call((f, x) => f.caret(x as never, 0), s.id("T9"));
		await press(a.page, "Control", "Enter");
		await snap("Mod-Enter makes a task");
		for (let i = 0; i < 3; i++) await press(a.page, "Alt", "ArrowUp");
		await kb.press("Tab");
		await snap("drag onto a node");
		await a.call((f, x) => f.caret(x as never, 0), s.id("T1"));
		for (let i = 0; i < 5; i++) await press(a.page, "Alt", "ArrowDown");
		await snap("drag between siblings");
	}
	await settle(a);
	expect(await a.call((f) => f.outline())).toBe(serverOutline(s.pageId));
	return { steps, trees, errors: a.errors };
}

for (const host of HOSTS) {
	test(`${host}: the map's keys and drags make the outline's transactions (item 3)`, async () => {
		const viaMap = await scenario(host, "map");
		await resetMap(h);
		const viaOutline = await scenario(host, "outline");
		expect(viaMap.steps).toEqual(viaOutline.steps);
		for (let i = 0; i < viaMap.steps.length; i++) {
			expect({ step: viaMap.steps[i], tree: viaMap.trees[i] }).toEqual({
				step: viaOutline.steps[i],
				tree: viaOutline.trees[i],
			});
		}
		expect(viaMap.errors).toEqual([]);
		expect(viaOutline.errors).toEqual([]);
	}, 180_000);

	test(`${host}: undo and redo continue across the views (item 3)`, async () => {
		const s = await seed(`Undo ${host}`);
		const a = await openHost(h, host, s.pageId);
		const kb = a.page.keyboard;
		const S = [await tree(a)];
		const step = async () => {
			await idle(a);
			S.push(await tree(a));
		};
		const end = async (id: string) => (await a.call((f, x) => f.text(x as never), id)).length;
		await a.call((f, x, o) => f.caret(x as never, o as never), s.id("T9"), await end(s.id("T9")));
		await kb.type("甲");
		await step();
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f, x) => f.mapSelect(x as never), s.id("T3"));
		await kb.press("Tab");
		await step();
		await kb.type("乙");
		await kb.press("Escape");
		await step();
		await a.call((f, x) => f.mapSelect(x as never), s.id("T3"));
		await press(a.page, "Alt", "ArrowDown");
		await step();
		await a.call((f) => f.setView("outline"));
		await settled(a);
		await a.call((f, x, o) => f.caret(x as never, o as never), s.id("T1"), await end(s.id("T1")));
		await kb.press("Enter");
		await step();
		await kb.type("丙");
		await step();
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f, x) => f.mapSelect(x as never), s.id("T1"));
		await press(a.page, "Control", "Enter");
		await step();
		expect(S.length).toBe(8);
		expect(new Set(S.map((x) => JSON.stringify(x))).size).toBe(8);
		// Undo three steps in the map, four in the outline; redo three in the outline, four in the map.
		for (let i = 7; i >= 5; i--) {
			await press(a.page, "Control", "z");
			await idle(a);
			expect({ undo: i, tree: await tree(a) }).toEqual({ undo: i, tree: S[i - 1] as TreeNode[] });
		}
		await a.call((f) => f.setView("outline"));
		await settled(a);
		for (let i = 4; i >= 1; i--) {
			await press(a.page, "Control", "z");
			await idle(a);
			expect({ undo: i, tree: await tree(a) }).toEqual({ undo: i, tree: S[i - 1] as TreeNode[] });
		}
		for (let i = 1; i <= 3; i++) {
			await press(a.page, "Control", "Shift", "z");
			await idle(a);
			expect({ redo: i, tree: await tree(a) }).toEqual({ redo: i, tree: S[i] as TreeNode[] });
		}
		await a.call((f) => f.setView("map"));
		await settled(a);
		for (let i = 4; i <= 7; i++) {
			await press(a.page, "Control", "Shift", "z");
			await idle(a);
			expect({ redo: i, tree: await tree(a) }).toEqual({ redo: i, tree: S[i] as TreeNode[] });
		}
		await settle(a);
		expect(await a.call((f) => f.outline())).toBe(serverOutline(s.pageId));
		expect(a.errors).toEqual([]);
	}, 180_000);

	test(`${host}: another person edits the block being edited in the map (item 3)`, async () => {
		const s = await seed(`Concurrent ${host}`);
		const a = await openHost(h, host, s.pageId);
		const b = await openBob(h, s.pageId);
		const kb = a.page.keyboard;
		const t3 = s.id("T3");
		const orig = await a.call((f, x) => f.text(x as never), t3);
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f, x) => f.mapSelect(x as never), t3);
		await kb.press("F2");
		await kb.type("甲甲");
		await b.call((f, x) => f.insertAt(x as never, 0, "乙乙" as never), t3);
		await kb.type("丙");
		await b.call((f, x) => f.cmd("moveDown", x as never, 0), t3);
		await kb.type("丁");
		await settle(a, b);
		const want = `乙乙${orig}甲甲丙丁`;
		expect(serverText(s.pageId, t3)).toBe(want);
		expect(await b.call((f, x) => f.text(x as never), t3)).toBe(want);
		expect((await a.call((f) => f.nodeEditor()))?.text).toBe(want);
		expect((await map(a)).editing).toBe(t3);
		// Alice adds a child while her network is held; Bob indents the same block meanwhile.
		await kb.press("Escape");
		await a.call((f) => f.net().hold(true));
		await kb.press("Tab");
		await kb.type("新子块");
		await kb.press("Escape");
		await b.call((f, x) => f.cmd("indent", x as never, 0), t3);
		await a.call((f) => f.net().hold(false));
		await settle(a, b);
		const server = serverOutline(s.pageId);
		expect(await a.call((f) => f.outline())).toBe(server);
		expect(await b.call((f) => f.outline())).toBe(server);
		expect(server).toMatch(/- 乙乙T3[^\n]*\n\s+- 新子块/);
		// Bob deletes the block Alice is editing: the node editor closes, nothing breaks.
		await a.call((f, x) => f.mapSelect(x as never), s.id("T9"));
		await kb.press("F2");
		await kb.type("x");
		await b.call((f, x) => f.deleteBlock(x as never), s.id("T9"));
		await settle(a, b);
		await a.call((f) => f.mapFlush());
		expect((await map(a)).editing).toBe(null);
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
	}, 120_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. IME in a node while a remote edit arrives
// ─────────────────────────────────────────────────────────────────────────────

for (const host of HOSTS) {
	test(`${host}: composing in a node while another person edits the block (item 4)`, async () => {
		const s = await seed(`IME ${host}`);
		const a = await openHost(h, host, s.pageId);
		const b = await openBob(h, s.pageId);
		const input = ime(a);
		const t3 = s.id("T3");
		const orig = await a.call((f, x) => f.text(x as never), t3);
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f, x) => f.mapEdit(x as never, 3 as never), t3);
		await input.set("n");
		await input.set("ni");
		await input.set("nihao");
		await settle(a, b);
		expect((await a.call((f) => f.nodeEditor()))?.text).toBe(
			`${orig.slice(0, 3)}nihao${orig.slice(3)}`,
		);
		expect(serverText(s.pageId, t3)).toBe(orig);
		expect(await b.call((f, x) => f.text(x as never), t3)).toBe(orig);
		await input.commit("你好");
		await settle(a, b);
		const want1 = `${orig.slice(0, 3)}你好${orig.slice(3)}`;
		expect(serverText(s.pageId, t3)).toBe(want1);
		expect((await a.call((f) => f.nodeEditor()))?.head).toEqual({ blockId: t3, offset: 5 });

		// Bob writes before and after while Alice composes: deferred, the node DOM kept, no loss.
		await input.set("x");
		await input.set("xin");
		expect(await a.call((f) => f.markNodeDom())).toBe(true);
		await b.call((f, x) => f.insertAt(x as never, 0, "【前】" as never), t3);
		await b.call(
			(f, x, o) => f.insertAt(x as never, o as never, "【后】" as never),
			t3,
			want1.length + 3,
		);
		await settle(a, b);
		expect(await a.call((f, x) => f.text(x as never), t3)).toBe(`【前】${want1}【后】`);
		expect((await a.call((f) => f.nodeEditor()))?.composing).toBe(true);
		expect(await a.call((f) => f.nodeDomKept())).toBe(true);
		await input.commit("信息");
		await settle(a, b);
		const want2 = `【前】${orig.slice(0, 3)}你好信息${orig.slice(3)}【后】`;
		expect(serverText(s.pageId, t3)).toBe(want2);
		expect((await a.call((f) => f.nodeEditor()))?.text).toBe(want2);
		expect(await b.call((f, x) => f.text(x as never), t3)).toBe(want2);
		expect((await a.call((f) => f.nodeEditor()))?.head).toEqual({ blockId: t3, offset: 10 });
		await a.page.keyboard.type("！");
		await settle(a, b);
		expect(serverText(s.pageId, t3)).toBe(
			`【前】${orig.slice(0, 3)}你好信息！${orig.slice(3)}【后】`,
		);

		// Bob adds a block before while Alice composes: the node moves, the composition goes on.
		await input.set("zhong");
		const before = await a.call((f, x) => f.nodeRect(x as never), t3);
		await b.call((f, x) => f.cmd("split", x as never, 0), s.id("T2"));
		await settle(a, b);
		await a.call((f) => f.mapFlush());
		const after = await a.call((f, x) => f.nodeRect(x as never), t3);
		expect(after?.y).not.toBe(before?.y);
		expect((await a.call((f) => f.nodeEditor()))?.composing).toBe(true);
		await input.commit("中");
		await settle(a, b);
		expect(serverText(s.pageId, t3)).toBe(
			`【前】${orig.slice(0, 3)}你好信息！中${orig.slice(3)}【后】`,
		);

		// Enter and arrows while composing (keyCode 229) neither split nor move; a real Enter
		// afterwards splits and editing follows to the new block.
		const tops = (await a.call((f, p) => f.kids(p as never), s.pageId)).length;
		await input.set("hao");
		await input.key("Enter");
		await input.key("ArrowDown");
		await input.commit("好");
		await settle(a, b);
		expect((await a.call((f, p) => f.kids(p as never), s.pageId)).length).toBe(tops);
		expect((await map(a)).editing).toBe(t3);
		await a.page.keyboard.press("Enter");
		await settle(a, b);
		const ed = (await map(a)).editing;
		expect(ed && ed !== t3).toBe(true);
		expect((await a.call((f, p) => f.kids(p as never), s.pageId)).length).toBe(tops + 1);
		expect(await a.call((f) => f.outline())).toBe(serverOutline(s.pageId));
		expect(await b.call((f) => f.outline())).toBe(serverOutline(s.pageId));
		expect(a.errors).toEqual([]);
	}, 120_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Focus
// ─────────────────────────────────────────────────────────────────────────────

for (const host of HOSTS) {
	test(`${host}: focus with keys, bullets, breadcrumbs, back and forward (item 5)`, async () => {
		const s = await seed(`Focus ${host}`);
		const a = await openHost(h, host, s.pageId);
		const kb = a.page.keyboard;
		const focus = async () => (await state(a)).focus;
		/** The host's focus: the URL on the page, the panel's params in a panel. */
		const hostFocus = async (): Promise<string | undefined> =>
			host === "page"
				? (await a.call((f) => f.location())).split("/").pop()
				: ((await a.call((f) => f.panelParams()))?.blockId as string | undefined);
		const waitHost = async (id: string) => {
			const end = Date.now() + 5000;
			while (Date.now() < end && (await hostFocus()) !== id)
				await new Promise((r) => setTimeout(r, 15));
			expect(await hostFocus()).toBe(id);
		};
		/**
		 * A navigation the host makes (back, forward, a breadcrumb) has landed: the host moved
		 * from `from`, the page shows the host's focus, and its transition is over. State, not
		 * time: the host renders the change, then the page animates to it, both later under load.
		 */
		const landed = async (what: string, from: string | undefined) => {
			const end = Date.now() + 10_000;
			let seen = "";
			while (Date.now() < end) {
				const there = await hostFocus();
				const here = await focus();
				const moving = await a.call((f) => f.animating());
				if (there !== from && there === here && !moving) return;
				seen = `host ${there}, page ${here}${moving ? ", animating" : ""}`;
				await new Promise((r) => setTimeout(r, 15));
			}
			throw new Error(`${what} did not land: ${seen}`);
		};
		const back = async () => {
			const from = await hostFocus();
			if (host === "page") await a.call((f) => f.goBack());
			else expect(await a.call((f) => f.clickTestId("outline-history-back"))).toBe(true);
			await landed("back", from);
		};
		const forward = async () => {
			const from = await hostFocus();
			if (host === "page") await a.call((f) => f.goForward());
			else await press(a.page, "Control", "]");
			await landed("forward", from);
		};
		const t2 = s.id("T2");
		const t2a = s.id("T2a");
		// Alt+→ focuses the cursor's block; the host records it; the breadcrumbs follow.
		await a.call((f, x) => f.caret(x as never, 2), t2);
		await press(a.page, "Alt", "ArrowRight");
		await settled(a);
		expect(await focus()).toBe(t2);
		await waitHost(t2);
		expect((await a.call((f) => f.crumbs())).at(-1)).toBe("T2 编辑器文档只是投影");
		expect((await a.call((f) => f.selection()))?.head.blockId).toBe(t2);
		await a.call((f, x) => f.caret(x as never, 0), t2a);
		await press(a.page, "Alt", "ArrowRight");
		await settled(a);
		expect(await focus()).toBe(t2a);
		await waitHost(t2a);
		await press(a.page, "Alt", "ArrowLeft");
		await settled(a);
		expect(await focus()).toBe(t2);
		await waitHost(t2);
		// A breadcrumb: back to the page.
		const fromCrumb = await hostFocus();
		expect(await a.call((f, t) => f.clickCrumb(t as never), `Focus ${host}`)).toBe(true);
		await landed("the breadcrumb", fromCrumb);
		expect(await hostFocus()).toBe(s.pageId);
		expect(await focus()).toBe(s.pageId);
		// Back and forward walk focus: page → T2 → T2a → T2 → page.
		await back();
		expect(await focus()).toBe(t2);
		await back();
		expect(await focus()).toBe(t2a);
		await back();
		expect(await focus()).toBe(t2);
		await back();
		expect(await focus()).toBe(s.pageId);
		await forward();
		expect(await focus()).toBe(t2);
		await forward();
		expect(await focus()).toBe(t2a);
		await waitHost(t2a);
		// The bullet focuses too.
		await a.call((f, p) => f.focusBlock(p as never), s.pageId);
		await settled(a);
		await clickGutter(a, s.id("T3"), "bullet");
		await settled(a);
		expect(await focus()).toBe(s.id("T3"));
		await a.call((f, p) => f.focusBlock(p as never), s.pageId);
		await settled(a);

		// The map: focus lays out from the focused block.
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f, x) => f.mapSelect(x as never), t2);
		await press(a.page, "Alt", "ArrowRight");
		await settled(a);
		expect((await map(a)).root).toBe(t2);
		expect((await a.call((f) => f.mapTree())).map((x) => x.id)).toEqual([t2, t2a, s.id("T2b")]);
		await waitHost(t2);
		await press(a.page, "Alt", "ArrowLeft");
		await settled(a);
		expect((await map(a)).root).toBe(s.pageId);
		await waitHost(s.pageId);
		await back();
		expect((await map(a)).root).toBe(t2);
		await forward();
		expect((await map(a)).root).toBe(s.pageId);
		// Downward: Alt+↓ focuses, Alt+↑ goes up.
		await a.call((f) => f.setLayout("down"));
		await settled(a);
		await a.call((f, x) => f.mapSelect(x as never), t2);
		await press(a.page, "Alt", "ArrowDown");
		await settled(a);
		expect((await map(a)).root).toBe(t2);
		await press(a.page, "Alt", "ArrowUp");
		await settled(a);
		expect((await map(a)).root).toBe(s.pageId);
		await a.call((f) => f.setLayout("right"));
		await settled(a);
		// Mod-↑ / Mod-↓ fold and unfold everything; Alt+1 opens one level.
		await a.call((f, x) => f.mapSelect(x as never), s.id("T3"));
		await kb.press("Tab");
		await kb.type("孙辈的父");
		await kb.press("Tab");
		await kb.type("孙辈");
		await kb.press("Escape");
		await idle(a);
		await press(a.page, "Control", "ArrowUp");
		await a.call((f) => f.mapFlush());
		expect((await state(a)).collapsed.length).toBe(3);
		await press(a.page, "Control", "ArrowDown");
		await a.call((f) => f.mapFlush());
		expect((await state(a)).collapsed).toEqual([]);
		await press(a.page, "Alt", "2");
		expect((await state(a)).collapsed.length).toBe(1);
		await press(a.page, "Control", "ArrowDown");

		// Operations during the animations, without waiting: focus, type, switch, unfocus,
		// change direction, structure keys, switch back, type.
		await a.call((f) => f.setView("outline"));
		await settled(a);
		const t2text = await a.call((f, x) => f.text(x as never), t2);
		await a.call((f, x, o) => f.caret(x as never, o as never), t2, t2text.length);
		await press(a.page, "Alt", "ArrowRight");
		await kb.type("壹");
		await a.call((f) => f.clickView("map"));
		await press(a.page, "Alt", "ArrowLeft");
		await a.call((f) => f.clickTestId("outline-map-layout"));
		await kb.press("ArrowRight");
		await press(a.page, "Alt", "ArrowDown");
		await a.call((f) => f.clickView("outline"));
		await kb.type("贰");
		await press(a.page, "Alt", "ArrowRight");
		await press(a.page, "Alt", "ArrowLeft");
		await a.call((f) => f.setLayout("right"));
		await settled(a);
		await settle(a);
		const fin = await state(a);
		expect(fin.view).toBe("outline");
		expect(fin.focus).toBe(s.pageId);
		expect(fin.layout).toBe("right");
		await waitHost(s.pageId);
		const server = serverOutline(s.pageId);
		expect(server.split("壹").length - 1).toBe(1);
		expect(server.split("贰").length - 1).toBe(1);
		expect((serverText(s.pageId, t2) ?? "").endsWith("壹")).toBe(true);
		expect(await a.call((f) => f.outline())).toBe(server);
		expect(await a.call((f) => f.frameAnimations())).toBe(0);
		expect((await map(a)).active).toBe(false);
		expect(await a.call((f) => f.focusWhere())).toBe("outline");
		expect(a.errors).toEqual([]);
	}, 180_000);
}

for (const host of HOSTS) {
	test(`${host}: a focus and its return told before the host renders the first: the host ends where the page is, and back still works (item 5)`, async () => {
		const s = await seed(`Focus quick ${host}`);
		const a = await openHost(h, host, s.pageId);
		const t2 = s.id("T2");
		const there = host === "page" ? "f.location().split('/').pop()" : "f.panelParams()?.blockId";
		const hostFocus = async (): Promise<string | undefined> =>
			a.page.evaluate(`((f) => ${there})(window.fixture)`) as Promise<string | undefined>;
		const entries0 = await a.page.evaluate(() => history.length);
		// Both in one task: the page tells the host of the two in a row, and the host may render
		// only once (its focus seems never to change). The panel used to compare the return with
		// a render that had not caught up and drop it (the panel kept T2 while the page showed the
		// whole page); the page used to take a later "back to T2" for the echo of its own T2.
		await a.call(
			(f, x, p) => {
				f.focusBlock(x as never);
				f.focusBlock(p as never);
			},
			t2,
			s.pageId,
		);
		await settled(a);
		expect((await state(a)).focus).toBe(s.pageId);
		// The host took the first (a history entry), then the host and the page agree.
		await until(
			a,
			"the host took the focus",
			host === "page"
				? `() => history.length >= ${entries0 + 2}`
				: `() => document.querySelector("[data-testid=outline-history-back]")?.disabled === false`,
		);
		const end = Date.now() + 5_000;
		while (Date.now() < end && (await hostFocus()) !== (await state(a)).focus)
			await new Promise((r) => setTimeout(r, 15));
		expect(await hostFocus()).toBe(s.pageId);
		// Both are in the host's history: back to T2, then back to where it started.
		const back = async () => {
			if (host === "page") await a.call((f) => f.goBack());
			else expect(await a.call((f) => f.clickTestId("outline-history-back"))).toBe(true);
		};
		const at = (id: string) =>
			`(f) => ${there} === ${JSON.stringify(id)} && f.state().focus === ${JSON.stringify(id)} && !f.animating()`;
		await back();
		await until(a, "back to T2", at(t2));
		await back();
		await until(a, "back to the page", at(s.pageId));
		if (host === "panel") {
			expect(
				await a.call(
					() =>
						(
							document.querySelector(
								"[data-testid=outline-history-back]",
							) as HTMLButtonElement | null
						)?.disabled,
				),
			).toBe(true);
		}
		expect(a.errors).toEqual([]);
	}, 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Reduced motion
// ─────────────────────────────────────────────────────────────────────────────

for (const host of HOSTS) {
	test(`${host}: with reduced motion every switch completes at once, unanimated (item 7)`, async () => {
		const s = await seed(`Motion ${host}`);
		const a = await openHost(h, host, s.pageId);
		await a.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
		const t2 = s.id("T2");
		/** Run an operation and read, in the same task, the animations and the state. */
		const act = (src: string) =>
			a.page.evaluate((code) => {
				const f = (window as unknown as { fixture: Record<string, (...x: unknown[]) => unknown> })
					.fixture;
				new Function("f", code)(f);
				const s = (
					f.surface as () => {
						animating: boolean;
						log: Array<{ animated: number; doneAt?: number }>;
						state: { view: string; focus: string; layout: string };
						map: { active: boolean; rootId: string };
					}
				)();
				const last = s.log[s.log.length - 1];
				return {
					anims: (f.frameAnimations as () => number)(),
					animating: s.animating,
					view: s.state.view,
					focus: s.state.focus,
					layout: s.state.layout,
					mapActive: s.map.active,
					mapRoot: s.map.active ? s.map.rootId : null,
					lastAnimated: last?.animated ?? null,
					lastDone: last?.doneAt !== undefined,
				};
			}, src);
		const steps: Array<[string, string, Record<string, unknown>]> = [
			["to the map", `f.setView("map")`, { view: "map", mapActive: true }],
			["downward", `f.setLayout("down")`, { layout: "down" }],
			["focus in the map", `f.focusBlock(${JSON.stringify(t2)})`, { focus: t2, mapRoot: t2 }],
			[
				"unfocus in the map",
				`f.focusBlock(${JSON.stringify(s.pageId)})`,
				{ focus: s.pageId, mapRoot: s.pageId },
			],
			["rightward", `f.setLayout("right")`, { layout: "right" }],
			["to the outline", `f.setView("outline")`, { view: "outline", mapActive: false }],
			["focus in the outline", `f.focusBlock(${JSON.stringify(t2)})`, { focus: t2 }],
			["unfocus in the outline", `f.focusBlock(${JSON.stringify(s.pageId)})`, { focus: s.pageId }],
		];
		for (const [name, src, want] of steps) {
			const r = await act(src);
			expect({
				name,
				anims: r.anims,
				animating: r.animating,
				lastAnimated: r.lastAnimated,
			}).toEqual({
				name,
				anims: 0,
				animating: false,
				lastAnimated: 0,
			});
			expect({ name, ...r }).toMatchObject({ name, lastDone: true, ...want });
		}
		await a.call((f, x) => f.caret(x as never, 1), t2);
		await press(a.page, "Alt", "ArrowRight");
		expect(await a.call((f) => f.frameAnimations())).toBe(0);
		expect((await state(a)).focus).toBe(t2);
		// Without reduced motion the same switch animates.
		await a.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
		await a.call((f) => f.setView("map"));
		await new Promise((r) => setTimeout(r, 60));
		expect(await a.call((f) => f.frameAnimations())).toBeGreaterThan(0);
		await settled(a);
		expect(a.errors).toEqual([]);
	}, 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Touch
// ─────────────────────────────────────────────────────────────────────────────

for (const host of HOSTS) {
	test(`${host}: touch pans, pinches, taps, double-taps to edit, long-press drags (item 8)`, async () => {
		const s = await seed(`Touch ${host}`);
		const a = await openHost(h, host, s.pageId, { width: 900, height: 1000, touch: true });
		const cdp = await a.page.createCDPSession();
		const touch = (type: string, pts: Array<[number, number]>) =>
			cdp.send("Input.dispatchTouchEvent", {
				type: type as "touchStart",
				touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
			});
		const tap = async (x: number, y: number) => {
			await touch("touchStart", [[x, y]]);
			await touch("touchEnd", []);
		};
		const center = (r: { x: number; y: number; w: number; h: number }): [number, number] => [
			r.x + r.w / 2,
			r.y + r.h / 2,
		];
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f) => f.mapFit());
		const frame = await a.page.evaluate(() => {
			const r = (document.querySelector(".mm-stage") as HTMLElement).getBoundingClientRect();
			return { x: r.left, y: r.top, w: r.width, h: r.height };
		});
		const bg: [number, number] = [frame.x + frame.w - 20, frame.y + frame.h - 20];
		expect(
			await a.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, bg),
		).toContain("mm-stage");
		// One finger on the background pans.
		const m0 = await map(a);
		await touch("touchStart", [bg]);
		for (let i = 1; i <= 6; i++) await touch("touchMove", [[bg[0] - i * 20, bg[1] - i * 10]]);
		await touch("touchEnd", []);
		const m1 = await map(a);
		expect(Math.abs(m1.tx - m0.tx + 120)).toBeLessThan(2);
		expect(Math.abs(m1.ty - m0.ty + 60)).toBeLessThan(2);
		expect(m1.scale).toBe(m0.scale);
		// Two fingers pinch: about twice as large, the midpoint stays.
		const cx = frame.x + frame.w / 2;
		const cy = frame.y + frame.h / 2;
		const p0 = await map(a);
		await touch("touchStart", [[cx - 40, cy]]);
		await touch("touchStart", [
			[cx - 40, cy],
			[cx + 40, cy],
		]);
		for (let i = 1; i <= 8; i++)
			await touch("touchMove", [
				[cx - 40 - i * 5, cy],
				[cx + 40 + i * 5, cy],
			]);
		await touch("touchEnd", []);
		const p1 = await map(a);
		expect(Math.abs(p1.scale / p0.scale - 2)).toBeLessThan(0.05);
		const sx = cx - frame.x;
		const sy = cy - frame.y;
		expect(Math.abs((sx - p0.tx) / p0.scale - (sx - p1.tx) / p1.scale)).toBeLessThan(1);
		expect(Math.abs((sy - p0.ty) / p0.scale - (sy - p1.ty) / p1.scale)).toBeLessThan(1);
		await a.call((f) => f.mapFit());
		// A tap selects; a double tap edits and takes typing.
		const t3 = s.id("T3");
		const r3 = await a.call((f, x) => f.nodeRect(x as never), t3);
		if (!r3) throw new Error("no T3 node");
		await tap(...center(r3));
		expect((await map(a)).selected).toBe(t3);
		expect((await map(a)).editing).toBe(null);
		await new Promise((r) => setTimeout(r, 400));
		await tap(...center(r3));
		await new Promise((r) => setTimeout(r, 80));
		await tap(...center(r3));
		expect((await map(a)).editing).toBe(t3);
		await a.page.keyboard.type("（触屏）");
		await settle(a);
		expect((serverText(s.pageId, t3) ?? "").endsWith("（触屏）")).toBe(true);
		await tap(...bg);
		expect((await map(a)).editing).toBe(null);
		// A long press drags: T9 under T5.
		await a.call((f) => f.mapFit());
		const p9 = center((await a.call((f, x) => f.nodeRect(x as never), s.id("T9"))) as never);
		const p5 = center((await a.call((f, x) => f.nodeRect(x as never), s.id("T5"))) as never);
		await touch("touchStart", [p9]);
		await new Promise((r) => setTimeout(r, 600));
		expect(
			await a.page.evaluate(
				(id) => document.querySelector(`.mm-node[data-id="${id}"]`)?.classList.contains("dragging"),
				s.id("T9"),
			),
		).toBe(true);
		for (let i = 1; i <= 8; i++)
			await touch("touchMove", [
				[p9[0] + ((p5[0] - p9[0]) * i) / 8, p9[1] + ((p5[1] - p9[1]) * i) / 8],
			]);
		await touch("touchEnd", []);
		await settle(a);
		expect(await a.call((f, x) => f.kids(x as never), s.id("T5"))).toEqual([s.id("T9")]);
		const out = serverOutline(s.pageId);
		// A swipe on a node (no long press) pans, the tree stays.
		await a.call((f) => f.mapFit());
		const q0 = await map(a);
		const p2 = center((await a.call((f, x) => f.nodeRect(x as never), s.id("T2"))) as never);
		await touch("touchStart", [p2]);
		for (let i = 1; i <= 5; i++) await touch("touchMove", [[p2[0] + i * 12, p2[1]]]);
		await touch("touchEnd", []);
		await settle(a);
		expect(Math.abs((await map(a)).tx - q0.tx - 60)).toBeLessThan(2);
		expect(serverOutline(s.pageId)).toBe(out);
		expect(a.errors).toEqual([]);
	}, 90_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only first: another page is shown from its HTTP read, then turns live in place
// ─────────────────────────────────────────────────────────────────────────────

/** A small page of its own words (the switcher finds it, not the other pages' blocks). */
async function seedWords(tag: string): Promise<Seeded> {
	const lines = [
		`${tag}1 第一`,
		`  ${tag}1a 子`,
		`${tag}2 第二`,
		`  ${tag}2a 子`,
		`    ${tag}2a1 孙`,
		`  ${tag}2b 子`,
		`${tag}3 第三`,
	];
	const { pageId, ids } = await seedPage(h, `${tag} 页`, lines);
	const byLabel = new Map<string, string>();
	lines.forEach((line, i) => {
		byLabel.set(line.trim().split(" ")[0] as string, ids[i] as string);
	});
	return {
		pageId,
		id: (label) => {
			const v = byLabel.get(label);
			if (!v) throw new Error(`no block ${label}`);
			return v;
		},
	};
}

/** Mod-K, the query, its first row is `want`, Enter. */
async function switchTo(e: MapEditor, q: string, want: string): Promise<void> {
	await press(e.page, "Control", "k");
	await e.page.waitForSelector("[data-testid=outline-switcher] input", { timeout: 5000 });
	await e.page.keyboard.type(q, { delay: 5 });
	await e.page.waitForFunction(
		(w) =>
			(document.querySelector("[data-testid=outline-switcher] [role=option]") as HTMLElement | null)
				?.dataset.block === w,
		{ timeout: 10_000, polling: 10 },
		want,
	);
	await e.page.keyboard.press("Enter");
}

async function until(e: MapEditor, what: string, check: string, timeout = 10_000): Promise<void> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await e.page.evaluate(`(${check})(window.fixture)`)) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error(`${what}: not within ${timeout} ms`);
}

for (const host of HOSTS) {
	test(`${host}: read-only first — another page shows from its read, turns live in place; typing kept, structure waits`, async () => {
		const tag = host === "page" ? "Ra" : "Rb";
		const p1 = await seed(`RO start ${host}`);
		const p2 = await seedWords(tag);
		const a = await openHost(h, host, p1.pageId);
		const b = await openBob(h, p2.pageId);
		await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
		// Alice's live socket holds (her join waits); her HTTP reads do not.
		await a.call((f) => f.net().hold(true));
		const q2 = p2.id(`${tag}2`);
		const q2a = p2.id(`${tag}2a`);
		const q2b = p2.id(`${tag}2b`);
		await switchTo(a, `${tag}2 第二`, q2);
		await until(
			a,
			"shown from the read",
			`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(q2)})`,
		);
		expect((await a.call((f) => f.connectingBadge())).shown).toBe(true);
		// Folding works on the read; the cursor moves; typing goes in (queued).
		await clickGutter(a, q2a, "arrow");
		const end = (await a.call((f, x) => f.text(x as never), q2b)).length;
		await a.call((f, x, o) => f.caret(x as never, o as never), q2b, end);
		await a.page.keyboard.type("xyz");
		// Structure waits: Enter and Tab change nothing, the badge nudges.
		const before = await a.call((f, x) => f.blockTree(x as never), q2);
		await a.page.keyboard.press("Enter");
		await press(a.page, "Shift", "Tab");
		await a.page.keyboard.press("Tab");
		expect(await a.call((f, x) => f.blockTree(x as never), q2)).toEqual(before);
		// Enter and Tab are refused (Shift-Tab cannot leave the focused block anyway).
		expect((await a.call((f) => f.connectingBadge())).nudges).toBeGreaterThanOrEqual(2);
		expect(await a.call((f) => f.shownFrom())).toBe("seed");
		// Meanwhile Bob changes the start of the same block (live).
		await b.call((f, x) => f.caret(x as never, 0), q2b);
		await b.page.keyboard.type("B:");
		await settle(b);
		expect(serverText(p2.pageId, q2b)).toBe(`B:${tag}2b 子`);
		const marked = await a.call((f, ids) => f.markShown(ids as never), [q2, q2a, q2b]);
		expect(marked).toBe(3);
		const st = await a.call((f) => f.state());
		// Released: the page turns live in place.
		await a.call((f) => f.net().hold(false));
		await until(a, "live", `(f) => f.shownFrom() === "live"`);
		await settle(a, b);
		// Typing merged onto Bob's change, nothing else.
		expect(serverText(p2.pageId, q2b)).toBe(`B:${tag}2b 子xyz`);
		expect(await a.call((f, x) => f.text(x as never), q2b)).toBe(`B:${tag}2b 子xyz`);
		expect(await b.call((f, x) => f.text(x as never), q2b)).toBe(`B:${tag}2b 子xyz`);
		expect(await a.call((f) => f.outline())).toBe(serverOutline(p2.pageId));
		// The same rows (no re-render), focus, folding and the cursor (after Bob's two characters).
		expect(await a.call((f, ids) => f.shownKept(ids as never), [q2, q2a, q2b])).toEqual({
			rows: 3,
			nodes: 0,
		});
		const after = await a.call((f) => f.state());
		expect(after.focus).toBe(st.focus);
		expect(after.collapsed).toEqual(st.collapsed);
		expect(after.collapsed).toContain(q2a);
		expect(after.caret).toEqual({ blockId: q2b, anchor: end + 5, head: end + 5 });
		expect(await a.call((f) => f.connectingBadge())).toMatchObject({ shown: false });
		// Live now: Enter splits.
		await a.page.keyboard.press("Enter");
		await settle(a);
		expect((await a.call((f, x) => f.kids(x as never), q2)).length).toBe(3);
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
	}, 90_000);

	test(`${host}: read-only first in the map — the whole page draws from the read and turns live in place`, async () => {
		const tag = host === "page" ? "Rc" : "Rd";
		const p1 = await seed(`RO map ${host}`);
		const p2 = await seedWords(tag);
		const a = await openHost(h, host, p1.pageId);
		await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
		await a.call((f) => f.setView("map"));
		await settled(a);
		await a.call((f) => f.net().hold(true));
		await switchTo(a, `${tag} 页`, p2.pageId);
		await until(
			a,
			"drawn from the read",
			`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(p2.pageId)})`,
		);
		await settled(a);
		expect((await a.call((f) => f.mapState())).root).toBe(p2.pageId);
		// Navigation works on the read; structure waits.
		const q1 = p2.id(`${tag}1`);
		const q2 = p2.id(`${tag}2`);
		await a.call((f, x) => f.mapSelect(x as never), q1);
		await a.page.keyboard.press("ArrowDown");
		expect((await a.call((f) => f.mapState())).selected).toBe(q2);
		const tree = await a.call((f) => f.blockTree());
		await a.page.keyboard.press("Tab");
		await a.page.keyboard.press("Enter");
		await a.page.keyboard.press("Escape");
		expect(await a.call((f) => f.blockTree())).toEqual(tree);
		expect((await a.call((f) => f.connectingBadge())).nudges).toBeGreaterThanOrEqual(2);
		expect(
			await a.call((f, ids) => f.markShown(ids as never), [p2.pageId, q1, q2]),
		).toBeGreaterThanOrEqual(3);
		const viewport = await a.call((f) => f.mapViewport());
		await a.call((f) => f.net().hold(false));
		await until(a, "live", `(f) => f.shownFrom() === "live"`);
		await settled(a);
		// The same nodes where they were; the selection kept.
		expect(await a.call((f) => f.mapViewport())).toEqual(viewport);
		expect((await a.call((f, ids) => f.shownKept(ids as never), [p2.pageId, q1, q2])).nodes).toBe(
			3,
		);
		expect((await a.call((f) => f.mapState())).selected).toBe(q2);
		// The outline behind the map was never built: it warms in a quiet moment once live.
		await until(a, "outline warmed", `(f) => !f.outlineCold()`, 8000);
		expect(await a.call((f) => f.mapViewport())).toEqual(viewport);
		// Live now: Tab adds a child.
		await a.page.keyboard.press("Tab");
		await a.page.keyboard.type("新");
		await a.page.keyboard.press("Escape");
		await settle(a);
		expect((await a.call((f, x) => f.kids(x as never), q2)).length).toBe(3);
		expect(a.errors).toEqual([]);
	}, 90_000);
}

for (const host of HOSTS) {
	test(`${host}: read-only first — composing while it connects, the page turning live mid-composition`, async () => {
		const tag = host === "page" ? "Ri" : "Rj";
		const p1 = await seed(`RO ime ${host}`);
		const p2 = await seedWords(tag);
		const a = await openHost(h, host, p1.pageId);
		const b = await openBob(h, p2.pageId);
		const input = ime(a);
		await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
		await a.call((f) => f.net().hold(true));
		const q2 = p2.id(`${tag}2`);
		const q2b = p2.id(`${tag}2b`);
		await switchTo(a, `${tag}2 第二`, q2);
		await until(
			a,
			"shown from the read",
			`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(q2)})`,
		);
		const orig = await a.call((f, x) => f.text(x as never), q2b);
		await a.call((f, x, o) => f.caret(x as never, o as never), q2b, orig.length);
		await input.set("n");
		await input.set("nihao");
		await b.call((f, x) => f.caret(x as never, 0), q2b);
		await b.page.keyboard.type("B:");
		await settle(b);
		// Live while still composing.
		await a.call((f) => f.net().hold(false));
		await until(a, "live", `(f) => f.shownFrom() === "live"`);
		await input.commit("你好");
		await settle(a, b);
		expect(serverText(p2.pageId, q2b)).toBe(`B:${orig}你好`);
		expect(await a.call((f, x) => f.text(x as never), q2b)).toBe(`B:${orig}你好`);
		expect(await b.call((f, x) => f.text(x as never), q2b)).toBe(`B:${orig}你好`);
		expect(a.errors).toEqual([]);
	}, 90_000);
}

test("page: read-only first — a block typed in is gone before the snapshot: the text is kept and added back as a new block", async () => {
	const p1 = await seed("RO deleted start");
	const p2 = await seedWords("Rk");
	const a = await openHost(h, "page", p1.pageId);
	const b = await openBob(h, p2.pageId);
	await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
	await a.call((f) => f.net().hold(true));
	const q2 = p2.id("Rk2");
	const q2b = p2.id("Rk2b");
	await switchTo(a, "Rk2 第二", q2);
	await until(
		a,
		"shown from the read",
		`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(q2)})`,
	);
	const end = (await a.call((f, x) => f.text(x as never), q2b)).length;
	await a.call((f, x, o) => f.caret(x as never, o as never), q2b, end);
	await a.page.keyboard.type(" 我的字");
	// Bob deletes it (live) before Alice's snapshot.
	await b.call((f, x) => f.deleteBlock(x as never), q2b);
	await settle(b);
	await a.call((f) => f.net().hold(false));
	await until(a, "live", `(f) => f.shownFrom() === "live"`);
	await settle(a, b);
	const notice = await a.page.waitForSelector("[data-testid=outline-unsaved-notice]", {
		timeout: 5000,
	});
	// Not "deleted": the block may have moved to another page.
	expect(await notice?.evaluate((el) => el.textContent ?? "")).toContain(
		"no longer on this page (deleted or moved)",
	);
	expect(await a.call((f) => f.unsavedNotice())).toEqual({
		texts: ["Rk2b 子 我的字"],
		reasons: ["moved_away"],
	});
	expect(await a.page.$("[data-testid=outline-deleted-notice]")).toBeNull();
	// Nothing was written on its own; adding it back makes a new block under the same parent.
	expect(serverOutline(p2.pageId)).not.toContain("我的字");
	await a.page.click("[data-testid=outline-unsaved-restore]");
	await settle(a, b);
	// Acknowledged: the kept text is done.
	await a.page.waitForFunction(
		() => !document.querySelector("[data-testid=outline-unsaved-notice]"),
		{
			timeout: 5000,
		},
	);
	const kids = await a.call((f, x) => f.kids(x as never), q2);
	expect(kids).toHaveLength(2);
	expect(serverText(p2.pageId, kids[1] as string)).toBe("Rk2b 子 我的字");
	expect(await b.call((f, x) => f.text(x as never), kids[1] as string)).toBe("Rk2b 子 我的字");
	expect(a.errors).toEqual([]);
}, 90_000);

test("page: read-only first — a page over the live limits takes no typing on its read, then shows read only", async () => {
	const p1 = await seed("RO large start");
	const lines = Array.from({ length: 2001 }, (_, i) => (i === 0 ? "Rl0 大页首块" : `Rl${i} 块`));
	const big = await seedPage(h, "Rl 大页", lines);
	const first = big.ids[0] as string;
	const a = await openHost(h, "page", p1.pageId);
	await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
	await a.call((f) => f.net().hold(true));
	await switchTo(a, "Rl0 大页首块", first);
	await until(
		a,
		"shown from the read",
		`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(first)})`,
	);
	// Not editable while it connects: typing changes nothing.
	expect(await a.call((f) => f.surface().client.editable)).toBe(false);
	await a.page.keyboard.type("xyz");
	expect(await a.call((f, x) => f.text(x as never), first)).toBe("Rl0 大页首块");
	await a.call((f) => f.net().hold(false));
	// Refused (too large): the read-only view with its notice, no unsaved text.
	await a.page.waitForFunction(
		() => document.body.textContent?.includes("too large to edit live") === true,
		{ timeout: 10_000 },
	);
	expect(await a.page.$("[data-testid=outline-unsaved-notice]")).toBeNull();
	expect(a.errors).toEqual([]);
}, 90_000);

test("page: read-only first — refused after typing (access gone): read only, the typing kept to copy", async () => {
	const p1 = await seed("RO refused start");
	const p2 = await seedWords("Rm");
	const a = await openHost(h, "page", p1.pageId);
	await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
	await a.call((f) => {
		f.net().hold(true);
		f.net().refuseNextJoin = "access_denied";
	});
	const q2 = p2.id("Rm2");
	const q2b = p2.id("Rm2b");
	await switchTo(a, "Rm2 第二", q2);
	await until(
		a,
		"shown from the read",
		`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(q2)})`,
	);
	const end = (await a.call((f, x) => f.text(x as never), q2b)).length;
	await a.call((f, x, o) => f.caret(x as never, o as never), q2b, end);
	await a.page.keyboard.type(" 没存上");
	await a.call((f) => f.net().hold(false));
	// The read-only view, with what was typed and a copy action; nothing reached the page.
	await a.page.waitForFunction(
		() =>
			!document.querySelector("[data-testid=outline-editor]") &&
			document.querySelector("[data-testid=outline-unsaved-notice]") !== null,
		{ timeout: 10_000 },
	);
	expect(await a.call((f) => f.unsavedNotice())).toEqual({
		texts: ["Rm2b 子 没存上"],
		reasons: ["refused"],
	});
	const notice = await a.page.$("[data-testid=outline-unsaved-notice]");
	expect(await notice?.evaluate((el) => el.textContent ?? "")).toContain("Copy text");
	expect(serverText(p2.pageId, q2b) ?? "").not.toContain("没存上");
	// Dismissed: gone, the read-only view stays.
	await a.page.evaluate(() => {
		const button = [
			...document.querySelectorAll("[data-testid=outline-unsaved-notice] button"),
		].find((el) => el.textContent?.trim() === "Dismiss") as HTMLButtonElement | undefined;
		button?.click();
	});
	await a.page.waitForFunction(
		() => !document.querySelector("[data-testid=outline-unsaved-notice]"),
		{ timeout: 10_000 },
	);
	expect(await a.page.$("[data-testid=outline-editor]")).toBeNull();
	expect(a.errors).toEqual([]);
}, 90_000);

test("panel: a panel hidden before its page turned live leaves the session at once", async () => {
	const p1 = await seed("RO hide start");
	const p3 = await seedWords("Rh");
	const a = await openHost(h, "panel", p1.pageId);
	await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
	await a.call((f) => f.net().hold(true));
	await switchTo(a, "Rh2 第二", p3.id("Rh2"));
	await until(a, "shown from the read", `(f) => f.shownFrom() === "seed"`);
	expect((await a.call((f) => f.liveSessions())).map((s) => s.pageId)).toContain(p3.pageId);
	// Hidden while its join is still on its way.
	expect(await a.call((f) => f.coverOutlinePanel())).toBe(true);
	await new Promise((r) => setTimeout(r, 100));
	const released = Date.now();
	await a.call((f) => f.net().hold(false));
	// Well before the grace period (5 s): gone here and on the server.
	const end = released + 2000;
	let gone = false;
	while (Date.now() < end) {
		const here = (await a.call((f) => f.liveSessions())).some((s) => s.pageId === p3.pageId);
		const there = liveSessionOf(p3.pageId)?.participants.size ?? 0;
		if (!here && there === 0) {
			gone = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	expect(gone).toBe(true);
	// And it stays gone (no participant left behind by a leave that overtook the join).
	await new Promise((r) => setTimeout(r, 300));
	expect(liveSessionOf(p3.pageId)?.participants.size ?? 0).toBe(0);
	expect(a.errors).toEqual([]);
}, 60_000);

test("panel: refused while typing, the panel hidden and shown again: the typing is shown again (probe P2′)", async () => {
	const p1 = await seed("RO keep start");
	const p2 = await seedWords("Rn");
	const a = await openHost(h, "panel", p1.pageId);
	await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
	await a.call((f) => {
		f.net().hold(true);
		f.net().refuseNextJoin = "access_denied";
	});
	const q2 = p2.id("Rn2");
	const q2b = p2.id("Rn2b");
	await switchTo(a, "Rn2 第二", q2);
	await until(
		a,
		"shown from the read",
		`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(q2)})`,
	);
	const end = (await a.call((f, x) => f.text(x as never), q2b)).length;
	await a.call((f, x, o) => f.caret(x as never, o as never), q2b, end);
	await a.page.keyboard.type(" 别丢");
	await a.call((f) => f.net().hold(false));
	const kept = { texts: ["Rn2b 子 别丢"], reasons: ["refused"] };
	await until(a, "the notice", `(f) => f.unsavedNotice()?.texts[0] === "Rn2b 子 别丢"`);
	expect(await a.call((f) => f.unsavedNotice())).toEqual(kept);
	// Hidden: no notice on screen, and no session of the page (the refused one went).
	expect(await a.call((f) => f.coverOutlinePanel())).toBe(true);
	await until(
		a,
		"hidden, its session gone",
		`(f) => f.unsavedNotice() === null && !f.liveSessions().some((s) => s.pageId === ${JSON.stringify(p2.pageId)})`,
	);
	// Shown again: the same text, still to copy.
	expect(await a.call((f) => f.showOutlinePanel())).toBe(true);
	await until(a, "the notice again", `(f) => f.unsavedNotice() !== null`);
	expect(await a.call((f) => f.unsavedNotice())).toEqual(kept);
	expect(serverText(p2.pageId, q2b) ?? "").not.toContain("别丢");
	expect(a.errors).toEqual([]);
}, 90_000);

test("panel: typed while connecting, hidden before the page refused it: shown again, the new editor shows the typing", async () => {
	const p1 = await seed("RO keep hidden start");
	const p2 = await seedWords("Ro");
	const a = await openHost(h, "panel", p1.pageId);
	await a.call((f, x) => f.caret(x as never, 0), p1.id("T1"));
	await a.call((f) => {
		f.net().hold(true);
		f.net().refuseNextJoin = "access_denied";
	});
	const q2 = p2.id("Ro2");
	const q2b = p2.id("Ro2b");
	await switchTo(a, "Ro2 第二", q2);
	await until(
		a,
		"shown from the read",
		`(f) => f.shownFrom() === "seed" && f.focusShown(${JSON.stringify(q2)})`,
	);
	const end = (await a.call((f, x) => f.text(x as never), q2b)).length;
	await a.call((f, x, o) => f.caret(x as never, o as never), q2b, end);
	await a.page.keyboard.type(" 藏起来也别丢");
	// Hidden while its join is on its way: the editor (and the view the typing is in) goes; the
	// session waits for the answer with the typing inside.
	expect(await a.call((f) => f.coverOutlinePanel())).toBe(true);
	await until(
		a,
		"the editor gone",
		`() => !document.querySelector("[data-testid=outline-editor]")`,
	);
	await a.call((f) => f.net().hold(false));
	// Refused while hidden: the session goes, the typing is kept (not on screen yet).
	await until(
		a,
		"refused, its session gone",
		`(f) => !f.liveSessions().some((s) => s.pageId === ${JSON.stringify(p2.pageId)})`,
	);
	expect(await a.call((f) => f.unsavedNotice())).toBeNull();
	// Shown again: the page joins anew (live now), and its editor shows what was kept.
	expect(await a.call((f) => f.showOutlinePanel())).toBe(true);
	await until(a, "live again", `(f) => f.shownFrom() === "live"`);
	await until(a, "the notice", `(f) => f.unsavedNotice() !== null`);
	expect(await a.call((f) => f.unsavedNotice())).toEqual({
		texts: ["Ro2b 子 藏起来也别丢"],
		reasons: ["refused"],
	});
	expect(
		await a.page.$("[data-testid=outline-editor] [data-testid=outline-unsaved-notice]"),
	).not.toBeNull();
	expect(serverText(p2.pageId, q2b) ?? "").not.toContain("别丢");
	expect(a.errors).toEqual([]);
}, 90_000);
