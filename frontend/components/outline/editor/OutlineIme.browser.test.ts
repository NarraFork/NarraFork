/**
 * Chinese input in the live outline editor (P0 acceptance item 1 of design §6.9), in Chromium,
 * with another person and agents writing the same page over the real live session. The input
 * method is the DevTools protocol's (`Input.imeSetComposition` / `Input.insertText`, keys with
 * keyCode 229), as the prototype's acceptance run used.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { outlineStore } from "../../../../server/services/outline/store";
import { writeOutline } from "../../../../server/services/outline/write";
import {
	type Editor,
	errorsOf,
	eventually,
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

beforeAll(async () => {
	h = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(h);
});

afterEach(async () => {
	await resetHarness(h);
});

const LINES = [
	"大纲编辑器",
	"块模型是真相",
	"  每个块节点带块 id",
	"  **粗体**",
	"第三块：拼接视图里也会出现",
	"最后一块",
];

async function setup(): Promise<{ pageId: string; ids: string[]; a: Editor; b: Editor }> {
	const { pageId, ids } = await seedPage(h, "输入法", LINES);
	const a = await openEditor(h, h.owner, pageId);
	const b = await openEditor(h, h.writer, pageId);
	return { pageId, ids, a, b };
}

const viewText = (e: Editor, id: string) => e.call((f, x) => f.viewText(x as never), id);
const head = (e: Editor) => e.call((f) => f.selection()?.head ?? null);

async function converged(pageId: string, ...editors: Editor[]): Promise<void> {
	await settle(...editors);
	const server = serverOutline(pageId);
	for (const e of editors) {
		expect(await e.call((f) => f.outline())).toBe(server);
		expect(await e.call((f) => f.viewOutline())).toBe(server);
	}
}

test("composing mid-block, Enter, Backspace and arrows while composing", async () => {
	const { pageId, ids, a, b } = await setup();
	const [, b1, , , b4, b5] = ids as [string, string, string, string, string, string];
	const input = ime(a);
	const orig = "第三块：拼接视图里也会出现";

	// 1a: the pinyin stays local; the committed text reaches everyone, the cursor after it.
	await a.call((f, id) => f.caret(id as never, 3), b4);
	await input.set("n");
	await input.set("ni");
	await input.set("nihao");
	await settle(a, b);
	expect(await viewText(a, b4)).toBe("第三块nihao：拼接视图里也会出现");
	expect(serverText(pageId, b4)).toBe(orig);
	expect(await viewText(b, b4)).toBe(orig);
	await input.commit("你好");
	const want = "第三块你好：拼接视图里也会出现";
	await until(b, (f, id, w) => f.viewText(id as never) === w, [b4, want]);
	expect(await viewText(a, b4)).toBe(want);
	expect(serverText(pageId, b4)).toBe(want);
	expect(await head(a)).toEqual({ blockId: b4, offset: 5 });

	// 1b: Enter inside the input method (229) does not split; a real Enter afterwards does.
	const before = await a.call((f) => f.blockCount());
	await input.set("zhong");
	await input.key("Enter");
	await input.commit("zhong");
	await settle(a, b);
	expect(await a.call((f) => f.blockCount())).toBe(before);
	expect(serverText(pageId, b4)).toBe("第三块你好zhong：拼接视图里也会出现");
	await a.page.keyboard.press("Enter");
	await settle(a, b);
	expect(serverOutline(pageId)).toContain("- 第三块你好zhong\n- ：拼接视图里也会出现\n- 最后一块");

	// 1c: Backspace inside the input method at a block's start only edits the pinyin.
	await a.call((f, id) => f.caret(id as never, 0), b5);
	await input.set("a");
	await input.set("ab");
	await input.key("Backspace");
	await input.set("a");
	await input.key("Backspace");
	await input.set("");
	await input.set("a");
	await input.commit("啊");
	await settle(a, b);
	expect(serverText(pageId, b5)).toBe("啊最后一块");
	expect(serverOutline(pageId)).toContain("- ：拼接视图里也会出现\n- 啊最后一块");

	// 1d: arrows inside the input method (picking a candidate) keep the cursor in its block.
	await a.call((f, id) => f.caret(id as never, 3), b1);
	await input.set("shu");
	await input.key("ArrowDown");
	await input.key("ArrowDown");
	await input.key("ArrowUp");
	await input.key("ArrowLeft");
	await input.set("shu");
	await input.commit("树");
	await settle(a, b);
	expect(serverText(pageId, b1)).toBe("块模型树是真相");
	expect(await head(a)).toEqual({ blockId: b1, offset: 4 });

	await converged(pageId, a, b);
	expect(errorsOf(a)).toEqual([]);
	expect(errorsOf(b)).toEqual([]);
}, 60_000);

test("someone else edits the composing block and other blocks; presence on it", async () => {
	const { pageId, ids, a, b } = await setup();
	const [b0, , , , , b5] = ids as [string, string, string, string, string, string];
	const input = ime(a);

	// 1e: their edits before and after the cursor wait until the composition ends; the block's
	// DOM is not replaced meanwhile; then everything merges and the cursor stays put.
	await a.call((f, id) => f.caret(id as never, 3), b5); // 最后一|块 → 最后一 is 3
	const skipsBefore = (await a.call((f) => f.stats())).frozenSkips;
	await input.set("x");
	await input.set("xin");
	expect(await a.call((f, id) => f.markDom(id as never), b5)).toBe(true);
	await b.call((f, id) => f.insertAt(id as never, 0, "【前】"), b5);
	await b.call((f, id) => f.insertAt(id as never, 7, "【后】"), b5);
	await until(a, (f, id) => f.text(id as never) === "【前】最后一块【后】", [b5]);
	await settle(b);
	expect((await a.call((f) => f.stats())).frozenSkips).toBeGreaterThan(skipsBefore);
	expect(await viewText(a, b5)).toBe("最后一xin块");
	expect(await a.call((f, id) => f.sameDom(id as never), b5)).toBe(true);
	await input.set("xinxi");
	await input.commit("信息");
	const merged = "【前】最后一信息块【后】";
	await until(b, (f, id, w) => f.viewText(id as never) === w, [b5, merged]);
	expect(await viewText(a, b5)).toBe(merged);
	expect(serverText(pageId, b5)).toBe(merged);
	expect(await head(a)).toEqual({ blockId: b5, offset: 8 });
	await a.page.keyboard.type("！");
	await settle(a, b);
	expect(serverText(pageId, b5)).toBe("【前】最后一信息！块【后】");

	// 1f: their edit of another block shows at once, and the composition goes on.
	await a.call((f, id) => f.caret(id as never, 0), b5);
	await input.set("ce");
	await b.call((f, id) => f.insertAt(id as never, 2, "（Bob）"), b0);
	await until(a, (f, id) => f.viewText(id as never) === "大纲（Bob）编辑器", [b0]);
	expect(await a.call((f) => f.composing())).toBe(true);
	await input.commit("测");
	await settle(a, b);
	expect(serverText(pageId, b5)?.slice(0, 2)).toBe("测【");

	// 1j: their cursor enters the composing block; after the commit their caret is drawn there.
	await a.call((f, id) => f.caret(id as never, 2), b5);
	await input.set("zai");
	await b.call((f, id) => f.caret(id as never, 1), b5);
	await until(a, (f, id) => f.peerMarked(id as never), [b5]);
	await input.set("zaichang");
	await input.commit("在场");
	await settle(a, b);
	await b.call((f, id) => f.caret(id as never, 2), b5);
	await until(a, (f, id) => f.peerCaretIn(id as never), [b5]);
	expect(serverText(pageId, b5)?.slice(0, 4)).toBe("测【在场");

	await converged(pageId, a, b);
	expect(errorsOf(a)).toEqual([]);
	expect(errorsOf(b)).toEqual([]);
}, 60_000);

test("an agent writes the composing block; someone moves it while composing", async () => {
	const { pageId, ids, a, b } = await setup();
	const [, b1, b2, b3, b4] = ids as [string, string, string, string, string];
	const input = ime(a);

	// 1g: the agent read the block before the composition started: its write is accepted (no
	// one changed the block since), and the composed text merges with it.
	await flushed(pageId);
	const read = await outlineStore.getBlock(b4);
	await a.call((f, id) => f.caret(id as never, 2), b4);
	await input.set("he");
	await writeOutline({
		spaceId: h.space.id,
		ops: [
			{
				op: "update",
				block: { id: b4 },
				content: `${read?.content}（agent）`,
				baseVersionSeq: read?.versionSeq,
			},
		],
		actor: { kind: "agent", id: "narrator-ime" },
		responsibleUserId: h.owner,
	});
	await until(a, (f, id) => f.text(id as never).endsWith("（agent）"), [b4]);
	expect(await viewText(a, b4)).toBe("第三he块：拼接视图里也会出现");
	await input.commit("和");
	const want = "第三和块：拼接视图里也会出现（agent）";
	await until(b, (f, id, w) => f.viewText(id as never) === w, [b4, want]);
	expect(await viewText(a, b4)).toBe(want);
	expect(serverText(pageId, b4)).toBe(want);

	// 1h: someone moves the composing block; the move waits, then the block is in its new
	// place with the composed text, and the cursor is still in it.
	await a.call((f, id) => f.caret(id as never, 2), b2);
	await input.set("kuai");
	expect(await b.call((f, id) => f.cmd("moveDown", id as never), b2)).toBe(true);
	await eventually(
		() => serverOutline(pageId).indexOf("**粗体**") < serverOutline(pageId).indexOf("每个"),
		"moved on the server",
	);
	await settle(b);
	expect(await a.call((f) => f.composing())).toBe(true);
	await input.commit("块");
	await settle(a, b);
	expect(await b.call((f, id) => f.kids(id as never), b1)).toEqual([b3, b2]);
	expect(serverText(pageId, b2)).toBe("每个块块节点带块 id");
	expect((await head(a))?.blockId).toBe(b2);

	await converged(pageId, a, b);
	expect(errorsOf(a)).toEqual([]);
	expect(errorsOf(b)).toEqual([]);
}, 60_000);
