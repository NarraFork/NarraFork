// PR1 验收 5：聚焦。Alt+→ / Alt+←、面包屑、浏览器前进后退都对；导图里一样（以聚焦的块为根重新布局）；
// 动画期间连续操作（聚焦、切换视图、切换方向、打字、结构键）不错乱。另外：Mod-↑ / Mod-↓、Alt+1…9。
import { Item, open, sleep } from "./lib.mjs";
import { surface } from "./t9-lib.mjs";

export async function run() {
	const it = new Item("9.5", "聚焦");
	const t = await open();
	const kb = t.page.keyboard;
	const m = surface(t, "A");
	const st = () => m.state();
	const hash = () => t.ev(() => location.hash);
	const outlineRoot = () =>
		t.ev(() => {
			const dom = window.proto.surfaces.A.outline.pm.dom;
			return {
				focus: dom.dataset.focus ?? null,
				first: dom.querySelector(".ob-block")?.dataset.id,
			};
		});
	const crumbs = () =>
		t.ev(() =>
			[...document.querySelectorAll('[data-surface="A"] .sf-crumbs button')].map(
				(b) => b.textContent,
			),
		);
	const back = async () => {
		await t.page.goBack();
		await sleep(30);
		await m.settle();
	};
	const fwd = async () => {
		await t.page.goForward();
		await sleep(30);
		await m.settle();
	};
	try {
		// 大纲：Alt+→ 聚焦光标所在的块
		await t.focus("A", "P1b2", 2);
		await kb.press("Alt+ArrowRight");
		await m.settle();
		it.eq("Alt+→ 聚焦当前块", (await st()).focus, "P1b2");
		it.eq("大纲以它为根", await outlineRoot(), { focus: "P1b2", first: "P1b2" });
		it.eq("地址栏记录聚焦", await hash(), "#/outline/P1/P1b2");
		it.eq("面包屑", await crumbs(), ["设计文档", "块模型是真相，编辑器文档只是投影。参见 任务一"]);
		it.eq("光标还在原块", (await t.selection("A"))?.head.blockId, "P1b2");
		// 再进一层
		await t.focus("A", "P1b2_1", 0);
		await kb.press("Alt+ArrowRight");
		await m.settle();
		it.eq("再聚焦一层", (await st()).focus, "P1b2_1");
		it.eq("面包屑三级", (await crumbs()).length, 3);
		// Alt+← 退一层
		await kb.press("Alt+ArrowLeft");
		await m.settle();
		it.eq("Alt+← 退到上一层", (await st()).focus, "P1b2");
		// 面包屑跳到页根
		await t.page.click('[data-surface="A"] .sf-crumbs button[data-crumb=""]');
		await m.settle();
		it.eq("点面包屑回到整页", (await st()).focus, null);
		it.eq("整页时大纲没有聚焦根", (await outlineRoot()).focus, null);
		it.eq("整页时地址栏", await hash(), "#/outline/P1");
		// 浏览器后退 / 前进走聚焦历史：null → P1b2 → P1b2_1 → P1b2 → null
		await back();
		it.eq("后退 1：P1b2", (await st()).focus, "P1b2");
		await back();
		it.eq("后退 2：P1b2_1", (await st()).focus, "P1b2_1");
		it.eq("后退后大纲根同步", (await outlineRoot()).focus, "P1b2_1");
		await back();
		it.eq("后退 3：P1b2", (await st()).focus, "P1b2");
		await back();
		it.eq("后退 4：整页", (await st()).focus, null);
		await fwd();
		it.eq("前进 1：P1b2", (await st()).focus, "P1b2");
		await fwd();
		it.eq("前进 2：P1b2_1", (await st()).focus, "P1b2_1");
		it.eq("前进后地址栏", await hash(), "#/outline/P1/P1b2_1");
		// 点项目符号聚焦
		await m.focusBlock(null);
		await m.settle();
		await t.page.click('[data-label="A"] .ob-block[data-id="P1b3"] > .ob-gutter .ob-bullet');
		await m.settle();
		it.eq("点项目符号聚焦", (await st()).focus, "P1b3");
		await m.focusBlock(null);
		await m.settle();

		// 导图里：聚焦就是以这个块为根重新布局
		await m.setView("map");
		await m.settle();
		await m.select("P1b2");
		await kb.press("Alt+ArrowRight");
		await m.settle();
		it.eq("导图 Alt+→ 聚焦", (await st()).focus, "P1b2");
		it.eq("导图以聚焦的块为根", (await m.map()).root, "P1b2");
		it.eq(
			"导图只剩聚焦的子树",
			(await m.mapTree()).map((x) => x.id),
			["P1b2", "P1b2_1", "P1b2_2"],
		);
		it.eq("导图聚焦后地址栏", await hash(), "#/outline/P1/P1b2");
		await kb.press("Alt+ArrowLeft");
		await m.settle();
		it.eq("导图 Alt+← 退回整页", (await m.map()).root, "P1");
		// 点节点的项目符号
		await m.select("P1b3");
		const r = await t.ev(() => {
			const el = window.proto.surfaces.A.map.el("P1b3").querySelector(".ob-bullet");
			const b = el.getBoundingClientRect();
			return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
		});
		await t.page.mouse.click(r.x, r.y);
		await m.settle();
		it.eq("导图点项目符号聚焦", (await m.map()).root, "P1b3");
		await back();
		it.eq("导图里后退", (await m.map()).root, "P1");
		await fwd();
		it.eq("导图里前进", (await m.map()).root, "P1b3");
		await m.focusBlock(null);
		await m.settle();
		// 向下布局：Alt+↓ 聚焦、Alt+↑ 退出（方向键对调）
		await m.setLayout("down");
		await m.settle();
		await m.select("P1b2");
		await kb.press("Alt+ArrowDown");
		await m.settle();
		it.eq("向下布局 Alt+↓ 聚焦", (await m.map()).root, "P1b2");
		await kb.press("Alt+ArrowUp");
		await m.settle();
		it.eq("向下布局 Alt+↑ 退出", (await m.map()).root, "P1");
		await m.setLayout("right");
		await m.settle();

		// Mod-↑ / Mod-↓ 全部折叠 / 展开；Alt+1…9 展开到第 N 层（导图里）
		await m.select("P1b3");
		await kb.press("Tab");
		await kb.type("孙辈的父");
		await kb.press("Tab");
		await kb.type("孙辈");
		await kb.press("Escape");
		await t.idle();
		await kb.press("Control+ArrowUp");
		await m.flush();
		const collapsedAll = (await st()).collapsed;
		it.check(
			"Mod-↑ 折叠了所有有子块的块",
			collapsedAll.includes("P1b2") && collapsedAll.includes("P1b3") && collapsedAll.length === 3,
			collapsedAll,
		);
		it.eq(
			"全部折叠后导图只剩顶层",
			(await m.mapTree()).filter((x) => x.parent === "P1").length,
			(await m.mapTree()).length - 1,
		);
		await kb.press("Control+ArrowDown");
		await m.flush();
		it.eq("Mod-↓ 全部展开", (await st()).collapsed, []);
		await kb.press("Alt+2");
		await m.flush();
		const lv2 = await st();
		it.eq("Alt+2 展开到第 2 层：只折叠第 2 层的「孙辈的父」", lv2.collapsed.length, 1);
		it.check(
			"Alt+2 第 1 层都展开",
			!lv2.collapsed.includes("P1b2") && !lv2.collapsed.includes("P1b3"),
			lv2.collapsed,
		);
		await kb.press("Alt+1");
		await m.flush();
		it.check(
			"Alt+1 第 1 层也折叠",
			(await st()).collapsed.includes("P1b3"),
			(await st()).collapsed,
		);
		await kb.press("Control+ArrowDown");
		// 大纲里也一样（同一个折叠集合）
		await m.setView("outline");
		await m.settle();
		await t.focus("A", "P1b9", 0);
		await kb.press("Control+ArrowUp");
		await t.idle();
		const hidden = await t.ev(() => {
			const el = document.querySelector('[data-label="A"] .ob-block[data-id="P1b2_1"]');
			return el ? el.offsetParent === null : null;
		});
		it.check("大纲 Mod-↑ 折叠（子块不可见）", hidden === true, hidden);
		await kb.press("Control+ArrowDown");
		await t.idle();

		// 动画期间连续操作：聚焦、打字、切视图、退出聚焦、换方向、切回、再打字、结构键，中间不等动画
		const t0 = await t.serverText("P1b2");
		await t.focus("A", "P1b2", t0.length);
		await kb.press("Alt+ArrowRight");
		await kb.type("壹");
		await t.page.click('[data-surface="A"] .sf-bar button[data-k="map"]');
		await kb.press("Alt+ArrowLeft");
		await t.page.click('[data-surface="A"] .sf-bar button[data-k="down"]');
		await kb.press("ArrowRight");
		await kb.press("Alt+ArrowDown");
		await t.page.click('[data-surface="A"] .sf-bar button[data-k="outline"]');
		await kb.type("贰");
		await kb.press("Alt+ArrowRight");
		await kb.press("Alt+ArrowLeft");
		await t.page.click('[data-surface="A"] .sf-bar button[data-k="right"]');
		await m.settle();
		await t.idle();
		const fin = await st();
		it.eq("连续操作后：视图", fin.view, "outline");
		it.eq("连续操作后：聚焦", fin.focus, null);
		it.eq("连续操作后：方向", fin.layout, "right");
		it.eq("连续操作后：大纲根和状态一致", (await outlineRoot()).focus, null);
		const server = await t.serverOutline("P1");
		it.eq("连续操作后：「壹」只出现一次", server.split("壹").length - 1, 1);
		it.eq("连续操作后：「贰」只出现一次", server.split("贰").length - 1, 1);
		it.check(
			"连续操作后：「壹」落在 P1b2 末尾",
			(await t.serverText("P1b2")).endsWith("壹"),
			await t.serverText("P1b2"),
		);
		it.check(
			"连续操作后：「贰」落在 P1b3 末尾",
			(await t.serverText("P1b3")).endsWith("贰"),
			await t.serverText("P1b3"),
		);
		it.eq("连续操作后：Alice = Bob = 服务端", await t.clientOutline("B", "P1"), server);
		it.eq("连续操作后：没有残留动画", await t.ev(() => document.getAnimations().length), 0);
		it.eq("连续操作后：导图不显示", (await m.map()).active, false);
		it.eq("连续操作后：焦点在大纲", await m.focusWhere(), "outline");
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
