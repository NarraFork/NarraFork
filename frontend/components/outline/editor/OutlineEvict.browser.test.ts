/**
 * A block's text document dropped under a real editor (pageless plan L2, document generations):
 * the caret stays where it was, keys on their way when the drop happens land once, what was
 * typed across the drop can be undone, and an input method composition open in the block
 * survives it. Chromium, one file at a time (see docs/TESTING.md).
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	liveSessionOf,
	liveSpaceOf,
	runInLane,
} from "../../../../server/services/outline/live/registry";
import { OUTLINE_LIVE_TIMING } from "../../../../server/services/outline/live/session";
import {
	type Editor,
	errorsOf,
	flushed,
	type Harness,
	ime,
	openEditor,
	resetHarness,
	seedPage,
	serverOutline,
	serverText,
	settle,
	startHarness,
	stopHarness,
	until,
} from "./outline-live-harness.browser-fixture";

let h: Harness;
const saved = { ...OUTLINE_LIVE_TIMING };
beforeAll(async () => {
	h = await startHarness();
}, 60_000);
afterAll(async () => {
	Object.assign(OUTLINE_LIVE_TIMING, saved);
	await stopHarness(h);
});
afterEach(async () => {
	Object.assign(OUTLINE_LIVE_TIMING, saved);
	await resetHarness(h);
});

const caret = (e: Editor, id: string, offset = -1) =>
	e.call((f, x, o) => f.caret(x as never, o as never), id, offset);
const hold = (e: Editor, on: boolean) => e.call((f, x) => f.net().hold(x as never), on);
const viewText = (e: Editor, id: string) => e.call((f, x) => f.viewText(x as never), id);
const head = (e: Editor) => e.call((f) => f.selection()?.head ?? null);
const genOf = (e: Editor, id: string) => e.call((f, x) => f.client().genOf(x as never), id);

async function sweep(pageId: string): Promise<number> {
	const spaceId = liveSessionOf(pageId)?.spaceId as string;
	return await runInLane(spaceId, () => liveSpaceOf(spaceId)?.sweepDocs() ?? 0);
}

async function converged(pageId: string, ...editors: Editor[]): Promise<void> {
	await settle(...editors);
	const server = serverOutline(pageId);
	for (const e of editors) {
		expect(await e.call((f) => f.outline())).toBe(server);
		expect(await e.call((f) => f.viewOutline())).toBe(server);
	}
}

test("the focused block's document is dropped: caret, typing in flight, composition", async () => {
	OUTLINE_LIVE_TIMING.docIdleMs = 0;
	OUTLINE_LIVE_TIMING.sweepMs = 3_600_000;
	const { pageId, ids } = await seedPage(h, "回收", ["first block", "second"]);
	const [b0, b1] = ids as [string, string];
	const a = await openEditor(h, h.owner, pageId);
	const b = await openEditor(h, h.writer, pageId);
	await settle(a, b);

	// 1: caret in the block, idle, document dropped: caret stays, next key lands at it.
	await caret(a, b0, 5);
	await a.page.keyboard.type("XY");
	await settle(a, b);
	await flushed(pageId);
	expect(await sweep(pageId)).toBe(1);
	await until(a, (f, id) => f.client().genOf(id as never) > 0, [b0]);
	await settle(a, b);
	expect(await head(a)).toEqual({ blockId: b0, offset: 7 });
	await a.page.keyboard.type("Z");
	await converged(pageId, a, b);
	expect(serverText(pageId, b0)).toBe("firstXYZ block");

	// 2: keys on their way when the drop happens, and keys typed right after it.
	await flushed(pageId);
	await hold(a, true);
	await a.page.keyboard.type("12");
	expect(await sweep(pageId)).toBe(1);
	await hold(a, false);
	await a.page.keyboard.type("3");
	await until(a, (f) => f.client().pending.length === 0, []);
	await converged(pageId, a, b);
	expect(serverText(pageId, b0)).toBe("firstXYZ123 block");
	expect(await head(a)).toEqual({ blockId: b0, offset: 11 });

	// 3: undo right after: what was typed across the drop is a step again and goes; nothing
	// breaks, and every end agrees.
	await a.page.keyboard.down("Control");
	await a.page.keyboard.press("z");
	await a.page.keyboard.up("Control");
	await converged(pageId, a, b);
	expect(serverText(pageId, b0)).not.toBe("firstXYZ123 block");
	expect((serverText(pageId, b0) as string).startsWith("firstXYZ")).toBe(true);

	// 4: a composition open in the block while its document is dropped.
	await flushed(pageId);
	const gen = await genOf(a, b0);
	const input = ime(a);
	await caret(a, b0, 5);
	await input.set("n");
	await input.set("ni");
	await input.set("nihao");
	const sText = serverText(pageId, b0) as string;
	const dropped = await sweep(pageId);
	if (dropped > 0)
		await until(a, (f, id, g) => f.client().genOf(id as never) > (g as number), [b0, gen]);
	await settle(a, b);
	// The other person types in the block meanwhile.
	await caret(b, b0, 0);
	await b.page.keyboard.type("Q");
	await settle(b);
	await input.commit("你好");
	await until(b, (f, id) => (f.viewText(id as never) ?? "").includes("你好"), [b0]);
	await converged(pageId, a, b);
	expect(serverText(pageId, b0)).toBe(`Q${sText.slice(0, 5)}你好${sText.slice(5)}`);
	expect(errorsOf(a)).toEqual([]);
	expect(errorsOf(b)).toEqual([]);
	void b1;
	void viewText;
}, 120_000);
