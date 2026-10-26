// 验收 8：拼接视图。来自三页的块混排在一起，就地编辑。
import { Item, open } from "./lib.mjs";

export async function run() {
	const it = new Item(8, "拼接视图");
	const t = await open();
	const kb = t.page.keyboard;
	try {
		const roots = await t.ev(() => window.proto.views.AS.surface.roots);
		it.eq("8 拼接视图的根来自三页", roots, ["P1b3", "P2b1", "P3b1"]);

		// 8a 在三个根里分别打字：各自的页变，别人看那一页的编辑器同步
		for (const [id, off] of [
			["P1b3", 3],
			["P2b1", 4],
			["P3b1", 2],
		]) {
			await t.focus("AS", id, off);
			await kb.type("※");
		}
		await t.idle();
		it.eq("8a P1 的块（服务端）", await t.serverText("P1b3"), "第三块※：拼接视图里也会出现");
		it.eq("8a P2 的块（服务端，任务块）", await t.serverText("P2b1"), "写编辑器※原型 @alice");
		it.eq("8a P3 的块（服务端）", await t.serverText("P3b1"), "10※ 月 26 日：确认 D23");
		it.eq("8a Bob 的 P1 编辑器", await t.viewText("B", "P1b3"), "第三块※：拼接视图里也会出现");
		it.eq("8a Bob 的 P2 编辑器", await t.viewText("B2", "P2b1"), "写编辑器※原型 @alice");
		it.eq(
			"8a 拼接视图里的任务属性保留",
			await t.ev(() => window.proto.server.store.get("P2b1").task),
			" ",
		);

		// 8b 根块（没有子块）末尾回车：新块是它在本页的下一个兄弟，出现在拼接视图里紧跟其后
		await t.focus("AS", "P1b3", 14);
		await kb.press("Enter");
		await kb.type("拼接里新建（P1）");
		await t.idle();
		const p1 = await t.serverOutline("P1");
		it.check(
			"8b 新块写进 P1，紧跟 P1b3",
			p1.includes("- 第三块※：拼接视图里也会出现\n- 拼接里新建（P1）\n- ```ts"),
			p1,
		);
		const roots2 = await t.ev(() => window.proto.views.AS.surface.roots);
		it.eq(
			"8b 拼接视图里新块排在 P1b3 后面",
			roots2.length === 4 && roots2[0] === "P1b3" && roots2[2] === "P2b1",
			true,
		);
		it.check(
			"8b Bob 的 P1 编辑器里出现",
			(await t.viewOutline("B")).includes("- 拼接里新建（P1）"),
			await t.viewOutline("B"),
		);

		// 8c 有子块的根末尾回车：新块是第一个子块（P3）
		await t.focus("AS", "P3b1", (await t.serverText("P3b1")).length);
		await kb.press("Enter");
		await kb.type("会议补充");
		await t.idle();
		it.check(
			"8c 新块成为 P3b1 的第一个子块",
			(await t.serverOutline("P3")).includes(
				"- 10※ 月 26 日：确认 D23\n  - 会议补充\n  - 表格用 GFM",
			),
			await t.serverOutline("P3"),
		);

		// 8d 根之间不能缩进（会跨页移动）：Tab 不生效
		const before = [await t.serverOutline("P1"), await t.serverOutline("P2")];
		await t.focus("AS", "P2b1", 0);
		await kb.press("Tab");
		await t.idle();
		it.eq(
			"8d 根上按 Tab 不跨页移动",
			[await t.serverOutline("P1"), await t.serverOutline("P2")],
			before,
		);

		// 8e 根的子块减少缩进：成为本页里根的兄弟，并作为新的根出现在拼接视图
		await t.focus("AS", "P2b1_1", 1);
		await kb.press("Shift+Tab");
		await t.idle();
		it.check(
			"8e P2 里子块变成根的兄弟",
			(await t.serverOutline("P2")).startsWith("- [ ] 写编辑器※原型 @alice\n- 先做块模型和投影"),
			await t.serverOutline("P2"),
		);
		it.check(
			"8e 拼接视图里成为新的根",
			(await t.ev(() => window.proto.views.AS.surface.roots)).includes("P2b1_1"),
		);
		it.eq(
			"8e Bob 的 P2 编辑器同步",
			await t.viewOutline("B2"),
			await t.ev(() => window.proto.serverOutline("P2")).then((s) => s.replace("- [ ] ", "- [ ] ")),
		);

		// 8f 别人（agent）改 P3 的块：拼接视图实时变化
		await t.ev(() => {
			const p = window.proto;
			const r = p.agentRead("ag", "P3");
			const b = r.blocks.find((x) => x.id === "P3b1");
			p.agentWrite("ag", "P3", [{ t: "text", id: "P3b1", content: `${b.content}（agent）` }]);
		});
		await t.idle();
		it.eq(
			"8f 拼接视图里 P3 的块实时变化",
			await t.viewText("AS", "P3b1"),
			"10※ 月 26 日：确认 D23（agent）",
		);

		// 8g 跨页的跨块剪切：ProseMirror 默认会把两端合并（把 P3 的子块挂到 P2 的块下），块不能跨页移动，
		//    原型在本地拒绝（不丢数据、不往返）；P1 需要按页拆开删除（见 RESULTS）
		const beforeCut = [await t.serverOutline("P2"), await t.serverOutline("P3")];
		await t.focus("AS", "P2b1", 2, 2, "P3b1");
		await kb.press("Control+x");
		await t.idle();
		it.eq(
			"8g 跨页剪切被拒绝，数据不变",
			[await t.serverOutline("P2"), await t.serverOutline("P3")],
			beforeCut,
		);
		it.check(
			"8g 本地拒绝（没有往返、没有重新同步）",
			(await t.ev(() => window.proto.views.AS.stats.crossPageRefused)) === 1 &&
				(await t.ev(() => window.proto.clients.A.stats.resyncs)) === 0,
		);
		it.eq(
			"8g 拼接视图仍与服务端一致",
			await t.viewText("AS", "P3b1"),
			"10※ 月 26 日：确认 D23（agent）",
		);
		// 同一页内的跨块剪切 + 撤销
		await t.focus("AS", "P2b1", 2, 2, "P2b1_1");
		await kb.press("Control+x");
		await t.idle();
		const p2cut = await t.serverOutline("P2");
		it.check("8g 同页跨块剪切生效", p2cut.startsWith("- [ ] 写编块模型和投影"), p2cut);
		await kb.press("Control+z");
		await t.idle();
		it.check(
			"8g 撤销恢复",
			(await t.serverOutline("P2")).startsWith("- [ ] 写编辑器※原型 @alice\n- 先做块模型和投影"),
			await t.serverOutline("P2"),
		);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
