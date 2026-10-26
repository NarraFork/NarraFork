// 附加：键位与块外框（§6.7）。Enter 拆块、块首 Backspace 合并、Delete、Tab / Shift-Tab、Alt+↑↓、
// Shift-Enter 硬换行、`[[…]]` 输入成提及、`# ` 变标题；复选框、折叠用原生 DOM 的 node view。
// 另外：远端修改时用「源码偏移 ↔ 编辑器位置」保住本地光标。
import { Item, open } from "./lib.mjs";

export async function run() {
	const it = new Item(0, "键位、块外框、光标映射（附加）");
	const t = await open();
	const kb = t.page.keyboard;
	const out = () => t.serverOutline("P1");
	try {
		// Enter：块中间拆块，后半段进新块
		await t.focus("A", "P1b9", 2);
		await kb.press("Enter");
		await t.idle();
		it.check("Enter 块中间拆块", (await out()).endsWith("- 最后\n- 一块"), await out());
		// 块首 Backspace：合并回去
		await kb.press("Backspace");
		await t.idle();
		it.check("块首 Backspace 合并", (await out()).endsWith("- 最后一块"), await out());
		it.eq("合并后光标在接缝处", (await t.selection("A"))?.head, { blockId: "P1b9", offset: 2 });
		// 块首 Enter：前面插空块，原块 id 不变
		await t.focus("A", "P1b9", 0);
		await kb.press("Enter");
		await t.idle();
		it.check(
			"块首 Enter 在前面插空块、原块 id 留给文字",
			(await out()).endsWith("- \n- 最后一块"),
			await out(),
		);
		await kb.press("Backspace");
		await t.idle();
		it.check(
			"前一块是空的：Backspace 删掉空块，保住有内容的块的 id",
			(await out()).endsWith("- ![[P1/P1b3]]\n- 最后一块") &&
				!(await t.ev(() => window.proto.server.store.get("P1b9").deleted)),
			await out(),
		);
		it.eq("光标仍在原块开头", (await t.selection("A"))?.head, { blockId: "P1b9", offset: 0 });
		// 有子块的块合并：子块跟过去
		await t.focus("A", "P1b3", 0);
		await kb.press("Backspace"); // P1b3 并入 P1b2 的最后一个子孙（P1b2_2）
		await t.idle();
		it.check(
			"合并进上一块的最后一个子孙",
			(await out()).includes("~~删除~~ 和 [链接](https://example.com)第三块：拼接视图里也会出现"),
			await out(),
		);
		await kb.press("Control+z");
		await t.idle();
		// Delete：块尾把下一块并进来
		await t.focus("A", "P1b2_1", (await t.serverText("P1b2_1")).length);
		await kb.press("Delete");
		await t.idle();
		it.check(
			"块尾 Delete 合并下一块",
			(await out()).includes("- 每个块节点带块 id**粗体**"),
			await out(),
		);
		await kb.press("Control+z");
		await t.idle();
		// Tab / Shift-Tab / Alt+↑↓
		await t.focus("A", "P1b3", 1);
		await kb.press("Tab");
		await t.idle();
		it.check(
			"Tab 缩进到上一块下面（成为最后一个子块）",
			(await out()).includes(
				"  - **粗体**、*斜体*、`代码`、~~删除~~ 和 [链接](https://example.com)\n  - 第三块",
			),
			await out(),
		);
		await kb.press("Alt+ArrowUp");
		await t.idle();
		it.check(
			"Alt+↑ 和上一个兄弟换位置",
			(await out()).includes("  - 第三块：拼接视图里也会出现\n  - **粗体**"),
			await out(),
		);
		await kb.press("Alt+ArrowDown");
		await kb.press("Shift+Tab");
		await t.idle();
		it.check(
			"Alt+↓、Shift-Tab 回到原位",
			(await out()).includes("](https://example.com)\n- 第三块：拼接视图里也会出现\n- ```ts"),
			await out(),
		);
		it.eq("结构操作后光标还在原块原处", (await t.selection("A"))?.head, {
			blockId: "P1b3",
			offset: 1,
		});
		// 多个兄弟一起缩进
		await t.focus("A", "P1b2_1", 1, 1, "P1b2_2");
		await kb.press("Shift+Tab");
		await t.idle();
		it.check(
			"选中多个兄弟一起减少缩进",
			(await out()).includes(
				"- 块模型是真相，编辑器文档只是投影。参见 [[P2/P2b1|任务一]]\n- 每个块节点带块 id\n- **粗体**",
			),
			await out(),
		);
		await kb.press("Control+z");
		await t.idle();
		// Shift-Enter：块内硬换行
		await t.focus("A", "P1b9", 2);
		await kb.press("Shift+Enter");
		await t.idle();
		it.eq("Shift-Enter 块内换行", await t.serverText("P1b9"), "最后\n一块");
		await kb.press("Backspace");
		await t.idle();
		// `[[…]]` 输入成提及；`## ` 变标题
		await t.focus("A", "P1b9", 4);
		await kb.type(" 见[[P2/P2b1]]");
		await t.idle();
		it.eq("输入 ]] 时变成提及节点", await t.serverText("P1b9"), "最后一块 见[[P2/P2b1]]");
		it.check(
			"提及显示为目标块的文字",
			(
				await t.ev(() =>
					[...document.querySelectorAll('.ob-mention[data-ref="P2/P2b1"]')].map(
						(e) => e.textContent,
					),
				)
			).includes("写编辑器原型 @alice"),
		);
		await kb.press("Enter");
		await kb.type("## 新标题");
		await t.idle();
		it.check("行首 `## ` 变成二级标题", (await out()).endsWith("- ## 新标题"), await out());
		// 复选框（任务属性画在外框上）：Mod-Enter 变任务，点击切换状态
		await kb.press("Control+Enter");
		await t.idle();
		it.check("Mod-Enter 变成任务", (await out()).endsWith("- [ ] ## 新标题"), await out());
		const newId = (await t.selection("A")).head.blockId;
		await t.page.click(`[data-label="A"] .ob-block[data-id="${newId}"] > .ob-gutter .ob-check`);
		await t.idle();
		it.check("点击复选框：待办 → 进行中", (await out()).endsWith("- [/] ## 新标题"), await out());
		it.check("Bob 那边的复选框同步", (await t.viewOutline("B")).endsWith("- [/] ## 新标题"));
		// 折叠：只影响本视图。PR1 起项目符号用来聚焦（§6.10），折叠改由项目符号左边的折叠箭头负责
		await t.page.click('[data-label="A"] .ob-block[data-id="P1b2"] > .ob-gutter .ob-arrow');
		const hidden = await t.ev(() => {
			const el = document.querySelector('[data-label="A"] .ob-block[data-id="P1b2_1"]');
			return el ? el.offsetParent === null : null;
		});
		it.check("点击折叠箭头折叠子块", hidden === true, hidden);
		it.check(
			"折叠是本视图状态（Bob 不受影响）",
			await t.ev(
				() =>
					document.querySelector('[data-label="B"] .ob-block[data-id="P1b2_1"]')?.offsetParent !==
					null,
			),
		);

		// 远端修改时保住光标：对方在光标前插入带标记 / 提及的内容、把段落改成标题
		await t.focus("A", "P1b3", 5); // 「第三块：拼|接视图…」
		await t.insertVia("B", "P1b3", 0, "前缀");
		await t.idle();
		it.eq("对方在光标前插字：光标跟着字走", (await t.selection("A"))?.head, {
			blockId: "P1b3",
			offset: 7,
		});
		await t.ev(() => {
			const p = window.proto;
			const r = p.agentRead("cur", "P1");
			const b = r.blocks.find((x) => x.id === "P1b3");
			p.agentWrite("cur", "P1", [
				{ t: "text", id: "P1b3", content: `## **粗** [[P2/P2b1]] ${b.content}` },
			]);
		});
		await t.idle();
		const before = await t.ev(() => window.proto.textBeforeCursor("A"));
		it.eq(
			"远端把段落改成标题并在前面加粗体和提及：光标仍在「拼」之后",
			before,
			"粗 @ 前缀第三块：拼",
		);
		it.eq(
			"块已变成标题",
			await t.ev(() => window.proto.views.A.pm.state.selection.$head.parent.type.name),
			"heading",
		);
		await kb.type("！");
		await t.idle();
		it.check(
			"接着打字落在原处",
			(await t.serverText("P1b3")).includes("第三块：拼！接视图"),
			await t.serverText("P1b3"),
		);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
