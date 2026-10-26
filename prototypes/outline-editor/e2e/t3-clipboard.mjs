// 验收 3：跨块剪贴。真实按键 Ctrl+C / Ctrl+X / Ctrl+V，读写系统剪贴板（已授予权限）。
import { Item, open, sleep } from "./lib.mjs";

const readClip = (t) => t.page.evaluate(() => navigator.clipboard.readText());
const writeClip = (t, s) => t.page.evaluate((x) => navigator.clipboard.writeText(x), s);

export async function run() {
	const it = new Item(3, "跨块剪贴");
	const t = await open();
	try {
		// 3a 跨块选中后复制：剪贴板里是 markdown 大纲
		await t.focus("A", "P1b2", 3, 3, "P1b3");
		await t.page.keyboard.press("Control+c");
		await sleep(30);
		const clip = await readClip(t);
		const want = [
			"- 是真相，编辑器文档只是投影。参见 [[P2/P2b1|任务一]]",
			"  - 每个块节点带块 id",
			"  - **粗体**、*斜体*、`代码`、~~删除~~ 和 [链接](https://example.com)",
			"- 第三块",
		].join("\n");
		it.eq("3a 复制出来是 markdown 大纲", clip, want);

		// 3b 块内复制：只有行内 markdown
		await t.focus("A", "P1b2_2", 0, 6);
		await t.page.keyboard.press("Control+c");
		await sleep(30);
		it.eq("3b 块内复制是行内 markdown", await readClip(t), "**粗体**、*斜体*、");

		// 3c 跨块剪切：中间的块删掉，两端合并；所有人都看到
		await t.focus("A", "P1b2", 3, 3, "P1b3");
		await t.page.keyboard.press("Control+x");
		await sleep(30);
		await t.idle();
		const cut = await readClip(t);
		it.eq("3c 剪切内容同复制", cut, want);
		const outA = await t.serverOutline("P1");
		it.check(
			"3c 服务端：两端合并成一块",
			outA.includes("- 块模型：拼接视图里也会出现\n- ```ts"),
			outA,
		);
		it.check("3c 服务端：中间的块已删除", !outA.includes("每个块节点带块 id"), outA);
		it.eq("3c Bob 编辑器与服务端一致", await t.viewOutline("B"), await t.viewOutline("A"));

		// 3d 把剪切的内容粘贴回去（Ctrl+V）：拆成多个块，结构不变（新块是新 id）
		await t.focus("A", "P1b9", 4);
		await t.page.keyboard.press("Control+v");
		await sleep(30);
		await t.idle();
		const outB = await t.serverOutline("P1");
		it.check("3d 粘贴的大纲拆成多个块、层级保留", outB.endsWith(`- 最后一块\n${want}`), outB);
		it.eq("3d Bob 编辑器与服务端一致", await t.viewOutline("B"), await t.viewOutline("A"));
		it.eq("3d 光标在最后一个粘贴块的末尾", (await t.selection("A"))?.head.offset, 3);

		// 3e 从外部粘贴多行 markdown（任务、嵌套、代码、标题、表格、多段）到空块
		await t.page.keyboard.press("Enter");
		await t.idle();
		const ext = [
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
		].join("\n");
		await writeClip(t, ext);
		await t.page.keyboard.press("Control+v");
		await sleep(30);
		await t.idle();
		const outC = await t.serverOutline("P1");
		const tail = outC.slice(outC.indexOf("- ## 外部粘贴"));
		it.eq(
			"3e 外部 markdown 拆成块（多段拆成子块）",
			tail,
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
		it.eq("3e Bob 编辑器与服务端一致", await t.viewOutline("B"), await t.viewOutline("A"));

		// 3f 单行 markdown 粘贴到块中间：留在这个块里，标记被解析
		await t.focus("A", "P1b1", 2);
		await writeClip(t, "**粗**和[[P2/P2b1]]");
		await t.page.keyboard.press("Control+v");
		await sleep(30);
		await t.idle();
		it.eq("3f 单行粘贴留在块内", await t.serverText("P1b1"), "# 大纲**粗**和[[P2/P2b1]]编辑器");

		// 3g 粘贴到块中间（多行）：当前块在光标处拆开，粘贴的块插在中间
		await t.focus("A", "P1b9", 2);
		await writeClip(t, "- 插入一\n- 插入二");
		await t.page.keyboard.press("Control+v");
		await sleep(30);
		await t.idle();
		const outD = await t.serverOutline("P1");
		it.check(
			"3g 块中间粘贴多行：拆开当前块",
			outD.includes("- 最后\n- 插入一\n- 插入二\n- 一块"),
			outD,
		);

		// 3h 剪切后撤销：剪掉的块原样恢复（同一个 id）
		await t.focus("A", "P2b3", 0, 3, "P2b3_1");
		// P2b3 在 Alice 的 P1 页里是嵌入，这里用拼接视图里的块：P3b1 和它的子块
		await t.focus("AS", "P3b1", 3, 2, "P3b1_1");
		await t.page.keyboard.press("Control+x");
		await sleep(30);
		await t.idle();
		const p3cut = await t.serverOutline("P3");
		await t.page.keyboard.press("Control+z");
		await sleep(30);
		await t.idle();
		const p3back = await t.serverOutline("P3");
		it.check("3h 剪切生效", p3cut !== p3back, p3cut);
		it.eq(
			"3h 撤销剪切后恢复原样",
			p3back,
			["- 10 月 26 日：确认 D23", "  - 表格用 GFM", "- 下次：看原型数据"].join("\n"),
		);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
