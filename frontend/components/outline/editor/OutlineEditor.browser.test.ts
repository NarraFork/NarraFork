/**
 * The live outline editor in Chromium, two and three people at once (P0 acceptance items 3, 4
 * and 5 of design §6.9, plus presence, block selection, HTML paste, read-only viewers, several
 * editors in one tab and narrow widths). Behaviour only: no timing is asserted here
 * (`OutlinePerf.browser.test.ts` measures).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { OutlineConflictError } from "../../../../server/services/outline/errors";
import { liveSessionOf } from "../../../../server/services/outline/live/registry";
import { outlineStore } from "../../../../server/services/outline/store";
import { writeOutline } from "../../../../server/services/outline/write";
import {
	dbOutline,
	dbText,
	type Editor,
	errorsOf,
	flushed,
	type Harness,
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

async function both(pageId: string): Promise<[Editor, Editor]> {
	return [await openEditor(h, h.owner, pageId), await openEditor(h, h.writer, pageId)];
}

const caret = (e: Editor, id: string, offset = -1) =>
	e.call((f, x, o) => f.caret(x as never, o as never), id, offset);
const select = (e: Editor, a: string, ao: number, b: string, bo: number) =>
	e.call((f, ...x) => f.select(...(x as [never, never, never, never])), a, ao, b, bo);
const head = (e: Editor) => e.call((f) => f.selection()?.head ?? null);
const hold = (e: Editor, on: boolean) => e.call((f, x) => f.net().hold(x as never), on);
const readClip = (e: Editor) => e.page.evaluate(() => navigator.clipboard.readText());
const writeClip = (e: Editor, text: string) =>
	e.page.evaluate((x) => navigator.clipboard.writeText(x), text);
/** Press a key with modifiers ("Control+Shift+z"). */
async function press(e: Editor, keys: string): Promise<void> {
	const parts = keys.split("+");
	const key = parts.pop() as string;
	for (const m of parts) await e.page.keyboard.down(m as never);
	await e.page.keyboard.press(key as never);
	for (const m of parts.reverse()) await e.page.keyboard.up(m as never);
}

/** Every editor, its client and the server show the same page. */
async function converged(pageId: string, ...editors: Editor[]): Promise<string> {
	await settle(...editors);
	const server = serverOutline(pageId);
	for (const e of editors) {
		expect({ who: e.userId, client: await e.call((f) => f.outline()) }).toEqual({
			who: e.userId,
			client: server,
		});
		expect({ who: e.userId, view: await e.call((f) => f.viewOutline()) }).toEqual({
			who: e.userId,
			view: server,
		});
	}
	return server;
}

function noErrors(...editors: Editor[]): void {
	for (const e of editors) expect(errorsOf(e)).toEqual([]);
}

test("typing reaches the other editor and the page, committed as the typist", async () => {
	const { pageId, ids } = await seedPage(h, "Smoke", ["first", "second"]);
	const [a, b] = await both(pageId);
	await caret(a, ids[0] as string);
	await a.page.keyboard.type(" typed");
	await until(b, (f) => f.outline().includes("first typed"));
	expect(await b.call((f) => f.outline())).toBe("- first typed\n- second");
	await flushed(pageId);
	expect(await dbText(ids[0] as string)).toBe("first typed");
	const block = await outlineStore.getBlock(ids[0] as string);
	expect(block?.authorId).toBe(h.owner);
	await converged(pageId, a, b);
	noErrors(a, b);
}, 30_000);

test("clipboard: copy, cut and paste across blocks, markdown and HTML from outside", async () => {
	const { pageId, ids } = await seedPage(h, "剪贴", [
		"块模型是真相",
		"  每个块节点带块 id",
		"  **粗体**和*斜体*",
		"第三块：拼接视图",
		"最后一块",
	]);
	const [b0, b1, b2, b3, b4] = ids as [string, string, string, string, string];
	const [a, b] = await both(pageId);
	const copied = ["- 是真相", "  - 每个块节点带块 id", "  - **粗体**和*斜体*", "- 第三块"].join(
		"\n",
	);

	// 3a: a selection across blocks copies as a markdown outline.
	await select(a, b0, 3, b3, 3);
	await press(a, "Control+c");
	expect(await readClip(a)).toBe(copied);

	// 3b: inside one block it copies inline markdown.
	await select(a, b2, 0, b2, 3);
	await press(a, "Control+c");
	expect(await readClip(a)).toBe("**粗体**和");

	// 3c: cutting across blocks joins the two ends and deletes what was between, for everyone.
	await select(a, b0, 3, b3, 3);
	await press(a, "Control+x");
	expect(await readClip(a)).toBe(copied);
	await settle(a, b);
	expect(serverOutline(pageId)).toBe("- 块模型：拼接视图\n- 最后一块");
	await converged(pageId, a, b);

	// 3h: undoing the cut brings the same blocks back (same ids); redo cuts again.
	await press(a, "Control+z");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe(
		"- 块模型是真相\n  - 每个块节点带块 id\n  - **粗体**和*斜体*\n- 第三块：拼接视图\n- 最后一块",
	);
	expect(await b.call((f, x) => f.kids(x as never), b0)).toEqual([b1, b2]);
	await press(a, "Control+Shift+z");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe("- 块模型：拼接视图\n- 最后一块");

	// 3d: pasting the outline back splits it into blocks, keeping the levels.
	await caret(a, b4);
	await press(a, "Control+v");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe(`- 块模型：拼接视图\n- 最后一块\n${copied}`);
	expect((await head(a))?.offset).toBe(3);
	await converged(pageId, a, b);

	// 3e: multi-line markdown from outside, into an empty block.
	await press(a, "Enter");
	await writeClip(
		a,
		[
			"## 外部粘贴",
			"",
			"- [ ] 任务甲",
			"  - 子项 **粗**",
			"- [x] 已完成",
			"- 普通项",
			"",
			"  第二段落",
			"",
			"```js",
			"let a = 1;",
			"```",
			"",
			"| k | v |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"结尾段落",
		].join("\n"),
	);
	await press(a, "Control+v");
	await settle(a, b);
	const out = serverOutline(pageId);
	expect(out.slice(out.indexOf("- ## 外部粘贴"))).toBe(
		[
			"- ## 外部粘贴",
			"- [ ] 任务甲",
			"  - 子项 **粗**",
			"- [x] 已完成",
			"- 普通项",
			"  - 第二段落",
			"- ```js",
			"  let a = 1;",
			"  ```",
			"- | k | v |",
			"  | --- | --- |",
			"  | 1 | 2 |",
			"- 结尾段落",
		].join("\n"),
	);

	// 3f: a single line of markdown stays in the block, its marks parsed.
	await caret(a, b0, 2);
	await writeClip(a, "**粗**和`码`");
	await press(a, "Control+v");
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("块模**粗**和`码`型：拼接视图");

	// 3g: several lines pasted mid-block split the block around them.
	await caret(a, b4, 2);
	await writeClip(a, "- 插入一\n- 插入二");
	await press(a, "Control+v");
	await settle(a, b);
	expect(serverOutline(pageId)).toContain("- 最后\n- 插入一\n- 插入二\n- 一块");

	// HTML from another app (a web page, a word processor) becomes blocks.
	await caret(a, b4);
	const pasted = await a.call(
		(f, html, plain) => f.pasteHtml(html as never, plain as never),
		'<meta charset="utf-8"><ul><li>甲<ul><li>乙 <b>粗</b></li></ul></li><li>丙</li></ul><h2>标题</h2><p>段落 <a href="https://example.com">链接</a></p>',
		"甲\n乙 粗\n丙\n标题\n段落 链接",
	);
	expect(pasted).toBe(true);
	await settle(a, b);
	expect(serverOutline(pageId)).toContain(
		"- 最后\n- 甲\n  - 乙 **粗**\n- 丙\n- ## 标题\n- 段落 [链接](https://example.com)",
	);

	await converged(pageId, a, b);
	await flushed(pageId);
	expect(await dbOutline(pageId)).toBe(serverOutline(pageId));
	noErrors(a, b);
}, 60_000);

test("undo: one step per action, only one's own, also while others' edits are on their way", async () => {
	const { pageId, ids } = await seedPage(h, "撤销", ["第一块", "第二块"]);
	const [b0, b1] = ids as [string, string];
	const [a, b] = await both(pageId);

	// 4a: typing, split, indent, typing; undone and redone step by step.
	const states = [serverOutline(pageId)];
	const heads: unknown[] = [];
	await caret(a, b1);
	await a.page.keyboard.type("一二");
	await settle(a, b);
	states.push(serverOutline(pageId));
	await press(a, "Enter");
	await settle(a, b);
	states.push(serverOutline(pageId));
	await press(a, "Tab");
	await settle(a, b);
	states.push(serverOutline(pageId));
	await a.page.keyboard.type("三四");
	await settle(a, b);
	states.push(serverOutline(pageId));
	expect(states[4]).toBe("- 第一块\n- 第二块一二\n  - 三四");
	for (let i = 3; i >= 0; i--) {
		await press(a, "Control+z");
		await settle(a, b);
		expect(serverOutline(pageId)).toBe(states[i] as string);
		heads.push((await head(a))?.offset);
	}
	// The cursor goes back to where it was before each step.
	expect(heads).toEqual([0, 0, 5, 3]);
	for (let i = 1; i <= 4; i++) {
		await press(a, "Control+Shift+z");
		await settle(a, b);
		expect(serverOutline(pageId)).toBe(states[i] as string);
	}
	await converged(pageId, a, b);

	// 4b: interleaved with someone else's edits, each undoes only their own.
	await caret(a, b0);
	await a.page.keyboard.type("AAA");
	await settle(a, b);
	await caret(b, b0, 0);
	await b.page.keyboard.type("BBB");
	await settle(a, b);
	await caret(a, b0);
	await press(a, "Enter");
	await a.page.keyboard.type("DDD");
	await settle(a, b);
	await caret(b, b0, 3);
	await b.page.keyboard.type("CCC");
	await settle(a, b);
	expect(serverOutline(pageId)).toStartWith("- BBBCCC第一块AAA\n- DDD\n- 第二块一二");
	for (let i = 0; i < 3; i++) {
		await a.call((f) => f.undo());
		await settle(a, b);
	}
	expect(serverOutline(pageId)).toStartWith("- BBBCCC第一块\n- 第二块一二");
	for (let i = 0; i < 2; i++) {
		await b.call((f) => f.undo());
		await settle(a, b);
	}
	expect(serverText(pageId, b0)).toBe("第一块");
	for (let i = 0; i < 3; i++) {
		await a.call((f) => f.redo());
		await settle(a, b);
	}
	expect(serverOutline(pageId)).toStartWith("- 第一块AAA\n- DDD\n- 第二块一二");
	await converged(pageId, a, b);

	// 4c: undo while the other person's keystroke is still on its way.
	await hold(b, true);
	await caret(b, b0, 0);
	await b.page.keyboard.type("Z");
	await caret(a, b0);
	await a.page.keyboard.type("XY");
	await settle(a);
	await press(a, "Control+z");
	await settle(a);
	await hold(b, false);
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("Z第一块AAA");
	await converged(pageId, a, b);
	noErrors(a, b);
}, 60_000);

test("two people in one block, a block moved and indented while someone types in it", async () => {
	const { pageId, ids } = await seedPage(h, "并发", ["块一", "块二", "最后一块"]);
	const [b0, b1, b2] = ids as [string, string, string];
	const [a, b] = await both(pageId);

	// 5a: both offline, typing at the same place and at different places; then both connect.
	await hold(a, true);
	await hold(b, true);
	await caret(a, b2, 0);
	await a.page.keyboard.type("甲");
	await caret(b, b2, 0);
	await b.page.keyboard.type("乙");
	await caret(b, b2, 5);
	await b.page.keyboard.type("丙");
	await caret(a, b2, 3);
	await a.page.keyboard.type("丁");
	await hold(a, false);
	await hold(b, false);
	await settle(a, b);
	const text = serverText(pageId, b2) ?? "";
	for (const c of ["甲", "乙", "丙", "丁"]) expect(text.split(c).length).toBe(2);
	expect(text.replace(/[甲乙丙丁]/g, "")).toBe("最后一块");
	await converged(pageId, a, b);

	// 5b: one moves the block (Alt+↑) while the other types in it.
	await caret(b, b1, 1);
	await b.page.keyboard.type("x");
	await settle(a, b);
	await hold(a, true);
	await hold(b, true);
	await caret(a, b1, 0);
	await press(a, "Alt+ArrowUp");
	await caret(b, b1, 2);
	await b.page.keyboard.type("yz");
	await hold(a, false);
	await hold(b, false);
	await settle(a, b);
	expect(await b.call((f) => f.kids(f.client().pageId as never))).toEqual([b1, b0, b2]);
	expect(serverText(pageId, b1)).toBe("块xyz二");
	expect(await head(b)).toEqual({ blockId: b1, offset: 4 });
	await b.page.keyboard.type("!");
	await settle(a, b);
	expect(serverText(pageId, b1)).toBe("块xyz!二");
	await converged(pageId, a, b);

	// 5c: one indents the block (Tab) while the other types in it.
	await caret(b, b2, 2);
	await hold(a, true);
	await caret(a, b2, 0);
	await press(a, "Tab");
	await caret(b, b2, 2);
	await b.page.keyboard.type("嗯");
	await hold(a, false);
	await settle(a, b);
	expect(await a.call((f, x) => f.kids(x as never), b0)).toEqual([b2]);
	expect((await head(b))?.blockId).toBe(b2);
	await converged(pageId, a, b);
	noErrors(a, b);
}, 60_000);

test("moves that would make a cycle: the later is refused and its editor resyncs", async () => {
	const { pageId, ids } = await seedPage(h, "成环", ["甲", "乙", "丙"]);
	const [b0, b1] = ids as [string, string];
	const [a, b] = await both(pageId);
	await hold(a, true);
	await hold(b, true);
	await a.call((f, x, y) => f.moveInto(x as never, y as never), b0, b1);
	await b.call((f, x, y) => f.moveInto(x as never, y as never), b1, b0);
	await hold(a, false);
	await settle(a);
	await hold(b, false);
	await settle(a, b);
	expect((await b.call((f) => f.client().stats)).rejects).toBeGreaterThanOrEqual(1);
	expect(serverOutline(pageId)).toBe("- 乙\n  - 甲\n- 丙");
	// The refused editor keeps working: its next edit lands.
	await caret(b, b0);
	await b.page.keyboard.type("!");
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("甲!");
	await converged(pageId, a, b);
	noErrors(a, b);
}, 30_000);

test("agents write while people type: merged live, or refused when they read too long ago", async () => {
	const { pageId, ids } = await seedPage(h, "代理", ["人工", "引用：远端修改", "表格 拆块"]);
	const [b0, b1, b2] = ids as [string, string, string];
	const [a, b] = await both(pageId);
	await flushed(pageId);
	const read = new Map(
		await Promise.all(ids.map(async (id) => [id, await outlineStore.getBlock(id)] as const)),
	);

	// People type after the agent read; their edits are still in the live session.
	await caret(a, b0, 0);
	await a.page.keyboard.type("人");
	await caret(b, b1, 3);
	await b.page.keyboard.type("（B）");
	await caret(a, b0, 1);
	await settle(a, b);

	// Changing a block someone changed since the agent's read is refused, nothing written.
	await expect(
		writeOutline({
			spaceId: h.space.id,
			ops: [
				{
					op: "update",
					block: { id: b1 },
					content: "引用：其他人的修改",
					baseVersionSeq: read.get(b1)?.versionSeq,
				},
			],
			actor: { kind: "agent", id: "narrator-agent" },
			responsibleUserId: h.owner,
		}),
	).rejects.toBeInstanceOf(OutlineConflictError);
	expect(await dbText(b1)).toBe("引用：（B）远端修改");

	// A block no one touched, and new blocks: written, and live in both editors at once; the
	// cursor of the person typing elsewhere stays where it was.
	await writeOutline({
		spaceId: h.space.id,
		ops: [
			{
				op: "update",
				block: { id: b2 },
				content: "表格 拆成两块",
				baseVersionSeq: read.get(b2)?.versionSeq,
			},
			{ op: "insert", tempId: "s", parent: { id: pageId }, content: "总结" },
			{ op: "insert", parent: { tempId: "s" }, content: "要点一" },
			{ op: "insert", parent: { tempId: "s" }, content: "要点二" },
		],
		actor: { kind: "agent", id: "narrator-agent" },
		responsibleUserId: h.owner,
	});
	await until(b, (f) => f.viewOutline().includes("- 总结\n  - 要点一\n  - 要点二"));
	await until(a, (f, x) => f.viewText(x as never) === "表格 拆成两块", [b2]);
	expect(await head(a)).toEqual({ blockId: b0, offset: 1 });
	await a.page.keyboard.type("工");
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("人工人工");
	await converged(pageId, a, b);
	await flushed(pageId);
	expect(await dbOutline(pageId)).toBe(serverOutline(pageId));
	noErrors(a, b);
}, 30_000);

test("the block someone is in is deleted: they are told who, and can restore it", async () => {
	const { pageId, ids } = await seedPage(h, "删除", ["要删的块", "  它的子块", "别的块"]);
	const [b0, b1] = ids as [string, string];
	const [a, b] = await both(pageId);
	await caret(a, b0, 2);
	await a.page.keyboard.type("Q");
	await settle(a, b);
	await b.call((f, x) => f.deleteVia(x as never), b0);
	await until(a, (f) => (f.deletedNotice() ?? "").includes("bob deleted the block you were in"));
	expect(serverOutline(pageId)).toBe("- 别的块");
	expect(await a.call((f) => f.clickButton("Restore"))).toBe(true);
	await settle(a, b);
	expect(serverOutline(pageId)).toBe("- 要删Q的块\n  - 它的子块\n- 别的块");
	expect(await b.call((f, x) => f.kids(x as never), b0)).toEqual([b1]);
	expect(await a.call((f) => f.deletedNotice())).toBeNull();
	await converged(pageId, a, b);
	noErrors(a, b);
}, 30_000);

test("presence: who is here, their cursor in the text, their block selection", async () => {
	const { pageId, ids } = await seedPage(h, "在场", ["第一块", "第二块", "第三块"]);
	const [b0, b1, b2] = ids as [string, string, string];
	const [a, b] = await both(pageId);
	const c = await openEditor(h, h.reader, pageId, { canWrite: false });
	await until(a, (f) => f.peers().length === 2);
	expect((await a.call((f) => f.peers())).sort((x, y) => x.name.localeCompare(y.name))).toEqual([
		{ name: "bob", editing: true },
		{ name: "carol", editing: false },
	]);
	await caret(b, b1, 2);
	await until(a, (f, x) => f.peerCaretIn(x as never) && f.peerMarked(x as never), [b1]);
	await until(c, (f, x) => f.peerCaretIn(x as never), [b1]);
	// A block selection shows as the blocks marked, for the others.
	await caret(b, b0, 1);
	await press(b, "Escape");
	await press(b, "Shift+ArrowDown");
	expect(await b.call((f) => f.blockSelection())).toEqual([b0, b1]);
	await until(a, () => document.querySelectorAll(".ob-peer-bsel").length === 2);
	expect(
		await a.call(() =>
			[...document.querySelectorAll(".ob-peer-bsel")].map((e) => e.getAttribute("data-id")),
		),
	).toEqual([b0, b1]);
	// Someone leaving disappears.
	await c.page.close();
	await until(a, (f) => f.peers().length === 1);
	expect(serverText(pageId, b2)).toBe("第三块");
	noErrors(a, b);
}, 30_000);

test("block selection: Esc, Shift+arrows, Tab, copy and delete whole blocks", async () => {
	const { pageId, ids } = await seedPage(h, "块选择", ["一", "二", "三", "四"]);
	const [b0, b1, b2, b3] = ids as [string, string, string, string];
	const [a, b] = await both(pageId);
	await caret(a, b1, 0);
	await press(a, "Escape");
	expect(await a.call((f) => f.blockSelection())).toEqual([b1]);
	await press(a, "Shift+ArrowDown");
	expect(await a.call((f) => f.blockSelection())).toEqual([b1, b2]);
	await press(a, "Control+c");
	expect(await readClip(a)).toBe("- 二\n- 三");
	await press(a, "Tab");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe("- 一\n  - 二\n  - 三\n- 四");
	expect(await a.call((f) => f.blockSelection())).toEqual([b1, b2]);
	await press(a, "Shift+Tab");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe("- 一\n- 二\n- 三\n- 四");
	await press(a, "Backspace");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe("- 一\n- 四");
	// Typing leaves block selection; nothing selected is replaced.
	await caret(a, b3, 0);
	await press(a, "Escape");
	await a.page.keyboard.type("!");
	await settle(a, b);
	expect(await a.call((f) => f.blockSelection())).toEqual([]);
	expect(serverText(pageId, b3)).toBe("四!");
	// The deletion is one step to undo.
	await a.call((f) => f.undo());
	await a.call((f) => f.undo());
	await settle(a, b);
	expect(serverOutline(pageId)).toBe("- 一\n- 二\n- 三\n- 四");
	expect(await b.call((f, x) => f.kids(x as never), pageId)).toEqual([b0, b1, b2, b3]);
	await converged(pageId, a, b);
	noErrors(a, b);
}, 30_000);

test("a reader watches live and cannot edit; a writer whose access goes becomes a reader", async () => {
	const { pageId, ids } = await seedPage(h, "只读", ["可以看"]);
	const [b0] = ids as [string];
	const a = await openEditor(h, h.owner, pageId);
	const c = await openEditor(h, h.reader, pageId, { canWrite: false });
	expect(await c.call((f) => f.editable())).toBe(false);
	await caret(a, b0);
	await a.page.keyboard.type("，也会变");
	await until(c, (f, x) => f.viewText(x as never) === "可以看，也会变", [b0]);
	// Keys do nothing in the reader's editor.
	await caret(c, b0);
	await c.page.keyboard.type("X");
	await press(c, "Enter");
	await settle(a);
	expect(serverOutline(pageId)).toBe("- 可以看，也会变");
	// Joining in edit mode without write access is a read-only session too.
	const c2 = await openEditor(h, h.reader, pageId, { canWrite: true });
	expect(await c2.call((f) => f.client().canWrite)).toBe(false);
	expect(await c2.call((f) => f.editable())).toBe(false);
	noErrors(a, c, c2);
}, 30_000);

test("several editors of one page in one tab share one session; a composer keeps its keys", async () => {
	const { pageId, ids } = await seedPage(h, "两个面板", ["一", "二"]);
	const [b0, b1] = ids as [string, string];
	const a = await openEditor(h, h.owner, pageId);
	await a.call(
		(f, p, k) => f.openSecond({ pageId: p as never, spaceKey: k as never, canWrite: true }),
		pageId,
		h.space.key,
	);
	await until(a, (f) => {
		try {
			return f.secondView() !== null;
		} catch {
			return false;
		}
	});
	expect(await a.call((f) => f.secondClient() === f.client())).toBe(true);
	expect(liveSessionOf(pageId)?.participants.size).toBe(1);
	// Typing in one shows in the other at once (same document).
	await caret(a, b0);
	await a.page.keyboard.type("甲");
	expect(
		await a.call((f, x) => {
			const v = f.secondView();
			return v.pm.dom.querySelector(`[data-id="${x}"]`)?.textContent;
		}, b0),
	).toContain("一甲");
	// The composer next to the editors keeps its keys: the editors' keys are their own.
	await a.page.focus("#composer");
	await a.page.keyboard.type("hello");
	for (const key of ["Enter", "Escape", "Alt+ArrowUp", "Control+Enter", "Control+b"])
		await press(a, key);
	await settle(a);
	expect(serverOutline(pageId)).toBe("- 一甲\n- 二");
	expect(await a.page.$eval("#composer", (el) => (el as HTMLTextAreaElement).value)).toBe(
		"hello\n",
	);
	expect(await a.page.evaluate(() => document.activeElement?.id)).toBe("composer");
	// Ctrl+Z there is the composer's own undo, not the outline's.
	await press(a, "Control+z");
	await settle(a);
	expect(serverOutline(pageId)).toBe("- 一甲\n- 二");
	// Each surface keeps its own folding and selection.
	await caret(a, b1);
	expect(await a.call((f) => f.secondView().captureSel()?.head.blockId ?? null)).not.toBe(b1);
	noErrors(a);
}, 30_000);

test("narrow widths (a phone, a dock panel): no sideways scrolling", async () => {
	const long = "很长的一段没有空格的文字".repeat(12);
	const { pageId, ids } = await seedPage(h, "窄屏", [
		long,
		"  第二层",
		"    第三层",
		"      第四层",
		"        第五层 https://example.com/a/very/long/path/that/does/not/break/anywhere/at/all",
		"```\nconst x = 'a long line of code that must scroll inside its block, not the page';\n```",
	]);
	const a = await openEditor(h, h.owner, pageId, { width: 360 });
	expect(await a.call((f) => f.overflowsX())).toBe(false);
	await caret(a, ids[0] as string);
	await a.page.keyboard.type("末尾");
	await settle(a);
	expect(await a.call((f) => f.overflowsX())).toBe(false);
	noErrors(a);
}, 30_000);

test("random concurrent editing by two people and an agent converges", async () => {
	const { pageId } = await seedPage(h, "压力", ["一", "二", "  三", "四", "五"]);
	const [a, b] = await both(pageId);
	let seed = 20261027;
	const r = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const names = ["moveUp", "moveDown", "indent", "outdent", "split", "join", "task"];
	for (let i = 0; i < 160; i++) {
		const who = r() < 0.5 ? a : b;
		if (r() < 0.08) await hold(who, !(await who.call((f) => f.net().held)));
		const x = r();
		if (x < 0.92) {
			await who.call(
				(f, x1, x2, x3, names0) => {
					const c = f.client();
					const ids = [...c.visible.blocks.values()]
						.filter((bk) => c.visible.inPage(bk.id) && bk.id !== c.pageId)
						.map((bk) => bk.id);
					if (!ids.length) return;
					const id = ids[Math.floor((x1 as number) * ids.length)] as string;
					const text = f.viewText(id as never) ?? "";
					if ((x2 as number) < 0.5) {
						const off = Math.floor((x3 as number) * (text.length + 1));
						f.insertAt(
							id as never,
							off,
							String.fromCharCode(0x4e00 + Math.floor((x3 as number) * 500)),
						);
					} else if ((x2 as number) < 0.9) {
						const list = names0 as string[];
						const n = list[Math.floor((x3 as number) * list.length)] as never;
						f.cmd(
							n,
							id as never,
							n === "split" ? Math.floor((x3 as number) * (text.length + 1)) : 0,
						);
					} else if ((x3 as number) < 0.6) f.undo();
					else f.redo();
				},
				r(),
				r(),
				r(),
				names,
			);
		} else {
			const s = liveSessionOf(pageId);
			const live = s ? s.mirror.subtree(pageId).filter((id) => id !== pageId) : [];
			const id = live[Math.floor(r() * live.length)];
			if (id) {
				await writeOutline({
					spaceId: h.space.id,
					ops: [{ op: "update", block: { id }, content: `${s?.textOf(id) ?? ""}·` }],
					actor: { kind: "agent", id: "narrator-stress" },
					responsibleUserId: h.owner,
				}).catch(() => {});
			}
		}
		if (i % 20 === 19) {
			// The network comes back now and then.
			await hold(a, false);
			await hold(b, false);
			await settle(a, b);
		}
	}
	await hold(a, false);
	await hold(b, false);
	await converged(pageId, a, b);
	await flushed(pageId);
	expect(await dbOutline(pageId)).toBe(serverOutline(pageId));
	noErrors(a, b);
}, 90_000);
