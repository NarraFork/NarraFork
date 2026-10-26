// 验收 1：中文输入法（CDP 的 Input.imeSetComposition / Input.insertText 模拟组合输入）。
import { Item, open, sleep } from "./lib.mjs";

const ORIG3 = "第三块：拼接视图里也会出现";

export async function run() {
	const it = new Item(1, "中文输入法");
	const t = await open();
	const { ime, ev } = t;
	try {
		// 1a 块中间组合：组合期间不外发拼音；提交后三方一致，光标在提交文字之后
		await t.focus("A", "P1b3", 3);
		await ime.set("n");
		await ime.set("ni");
		await ime.set("nihao");
		await t.idle();
		it.eq(
			"1a 组合中编辑器显示拼音",
			await t.viewText("A", "P1b3"),
			"第三块nihao：拼接视图里也会出现",
		);
		it.eq("1a 组合中拼音不写进 Y.Text / 服务端", await t.serverText("P1b3"), ORIG3);
		it.eq("1a 组合中对方看不到拼音", await t.viewText("B", "P1b3"), ORIG3);
		await ime.commit("你好");
		await sleep(30);
		await t.idle();
		const want1 = "第三块你好：拼接视图里也会出现";
		it.eq("1a 提交后 Alice 编辑器", await t.viewText("A", "P1b3"), want1);
		it.eq("1a 提交后服务端", await t.serverText("P1b3"), want1);
		it.eq("1a 提交后 Bob 编辑器", await t.viewText("B", "P1b3"), want1);
		it.eq("1a 光标在提交文字之后", await t.selection("A"), {
			anchor: { blockId: "P1b3", offset: 5 },
			head: { blockId: "P1b3", offset: 5 },
		});

		// 1b 组合中按 Enter（keyCode 229，输入法上屏字母）：不拆块；之后真 Enter 在光标处拆块
		const blocksBefore = (await ev(() => window.proto.blockIds("A"))).length;
		await ime.set("zhong");
		await ime.key("Enter");
		await ime.commit("zhong");
		await sleep(30);
		await t.idle();
		const blocksAfter = (await ev(() => window.proto.blockIds("A"))).length;
		it.eq("1b 组合中 Enter 不拆块", blocksAfter, blocksBefore);
		it.eq(
			"1b 上屏的字母在光标处",
			await t.serverText("P1b3"),
			"第三块你好zhong：拼接视图里也会出现",
		);
		await t.page.keyboard.press("Enter");
		await t.idle();
		const out = await t.serverOutline("P1");
		it.check(
			"1b 组合结束后真 Enter 在光标处拆块",
			out.includes("- 第三块你好zhong\n- ：拼接视图里也会出现"),
			out,
		);

		// 1c 块首组合时按 Backspace（229）：只删拼音，不合并到上一块
		await t.focus("A", "P1b9", 0);
		await ime.set("a");
		await ime.set("ab");
		await ime.key("Backspace");
		await ime.set("a");
		await ime.key("Backspace");
		await ime.set("");
		await ime.set("a");
		await ime.commit("啊");
		await sleep(30);
		await t.idle();
		it.eq("1c 块首组合 Backspace 不合并", await t.serverText("P1b9"), "啊最后一块");
		it.check(
			"1c 上一块不受影响",
			(await t.serverOutline("P1")).includes("- ![[P1/P1b3]]\n- 啊最后一块"),
			await t.serverOutline("P1"),
		);

		// 1d 组合中按方向键（229，输入法里选候选）：光标不跑到别的块
		await t.focus("A", "P1b2", 3);
		await ime.set("shu");
		await ime.key("ArrowDown");
		await ime.key("ArrowDown");
		await ime.key("ArrowUp");
		await ime.key("ArrowLeft");
		await ime.set("shu");
		await ime.commit("树");
		await sleep(30);
		await t.idle();
		it.eq("1d 方向键选候选后提交在原位置", (await t.serverText("P1b2")).slice(0, 5), "块模型树是");
		it.eq("1d 光标仍在原块", (await t.selection("A"))?.head, { blockId: "P1b2", offset: 4 });

		// 1e 组合期间另一个人改同一块（光标前和光标后各一处）：推迟应用，提交后合并，光标不乱
		await t.focus("A", "P1b9", 3); // 「啊最后|一块」
		const deferredBefore = (await ev(() => window.proto.stats())).A.frozenSkips;
		await ime.set("x");
		await ime.set("xin");
		// 打标记：组合中块的 DOM 节点是否被替换
		await ev(() => {
			const el = window.proto.views.A.pm.dom.querySelector('[data-id="P1b9"]');
			el.__mark = 1;
		});
		await t.insertVia("B", "P1b9", 0, "【前】");
		await t.insertVia("B", "P1b9", 8, "【后】"); // Bob 那边是「【前】啊最后一块」，偏移 8 在末尾
		await t.idle();
		const stats = (await ev(() => window.proto.stats())).A;
		it.check(
			"1e 远端修改推迟应用（组合中的块保持本地状态）",
			stats.frozenSkips > deferredBefore,
			stats,
		);
		it.eq("1e 组合中 Alice 编辑器仍是组合文字", await t.viewText("A", "P1b9"), "啊最后xin一块");
		it.eq(
			"1e 组合中 Alice 的 Y.Text 已有远端修改",
			await t.text("A", "P1b9"),
			"【前】啊最后一块【后】",
		);
		const sameNode = await ev(
			() => window.proto.views.A.pm.dom.querySelector('[data-id="P1b9"]').__mark === 1,
		);
		it.check("1e 组合中块的 DOM 节点没被替换", sameNode);
		await ime.set("xinxi");
		await ime.commit("信息");
		await sleep(30);
		await t.idle();
		const want5 = "【前】啊最后信息一块【后】";
		it.eq("1e 提交后 Alice 编辑器", await t.viewText("A", "P1b9"), want5);
		it.eq("1e 提交后服务端", await t.serverText("P1b9"), want5);
		it.eq("1e 提交后 Bob 编辑器", await t.viewText("B", "P1b9"), want5);
		it.eq("1e 光标在「信息」之后", (await t.selection("A"))?.head, { blockId: "P1b9", offset: 8 });
		await t.page.keyboard.type("！");
		await t.idle();
		it.eq("1e 接着打字落在光标处", await t.serverText("P1b9"), "【前】啊最后信息！一块【后】");

		// 1f 组合期间别人改另一个块：立即显示，不推迟
		await t.focus("A", "P1b9", 0);
		await ime.set("ce");
		await t.insertVia("B", "P1b1", 2, "（Bob）");
		await t.idle();
		it.eq("1f 组合中别的块的远端修改立即显示", await t.viewText("A", "P1b1"), "大纲（Bob）编辑器");
		it.check("1f 组合没有被打断", await ev(() => window.proto.views.A.pm.composing));
		await ime.commit("测");
		await sleep(30);
		await t.idle();
		it.eq("1f 提交正常", (await t.serverText("P1b9")).slice(0, 2), "测【");

		// 1g 组合期间 agent 写同一块（三方合并，不重叠）
		await t.focus("A", "P1b3", 2);
		const read = await ev(() => window.proto.agentRead("ag", "P1"));
		const cur3 = read.blocks.find((b) => b.id === "P1b3").content;
		await ime.set("he");
		const res = await ev(
			([c]) =>
				window.proto.agentWrite("ag", "P1", [{ t: "text", id: "P1b3", content: `${c}（agent）` }]),
			[cur3],
		);
		await t.idle();
		it.eq("1g agent 写入被接受", res.applied.length, 1);
		it.eq("1g 组合中 Alice 编辑器未被重绘", await t.viewText("A", "P1b3"), `第三he块你好zhong`);
		await ime.commit("和");
		await sleep(30);
		await t.idle();
		const want7 = "第三和块你好zhong（agent）";
		it.eq("1g 提交后三方一致（服务端）", await t.serverText("P1b3"), want7);
		it.eq("1g 提交后三方一致（Bob）", await t.viewText("B", "P1b3"), want7);
		it.eq("1g 提交后三方一致（Alice）", await t.viewText("A", "P1b3"), want7);

		// 1h 组合期间别人移动正在组合的块：结构修改也推迟，提交后块在新位置、文字完整
		await t.focus("A", "P1b2_1", 2);
		await ime.set("kuai");
		await t.cmd("B", "moveDown", "P1b2_1");
		await t.idle();
		it.check("1h 组合没有被打断", await ev(() => window.proto.views.A.pm.composing));
		await ime.commit("块");
		await sleep(30);
		await t.idle();
		const o8 = await t.serverOutline("P1");
		it.check(
			"1h 服务端：块已移动且包含提交的文字",
			o8.includes("  - **粗体**") &&
				o8.indexOf("每个块") > o8.indexOf("**粗体**") &&
				o8.includes("每个块块节点带块 id"),
			o8,
		);
		it.eq(
			"1h Alice 编辑器与服务端一致",
			await t.viewOutline("A"),
			await t.clientOutline("A", "P1").then(() => t.viewOutline("B")),
		);
		it.eq("1h 光标还在这个块", (await t.selection("A"))?.head.blockId, "P1b2_1");

		// 1j 组合期间对方的光标进入同一块（在场信息的装饰画在组合中的块上）
		await t.focus("A", "P1b9", 2);
		await ime.set("zai");
		await ev(() => window.proto.clients.B.sendPresence("P1", "P1b9", 1));
		await t.idle();
		const peer = await ev(
			() => !!window.proto.views.A.pm.dom.querySelector('.ob-block[data-id="P1b9"] .ob-peer-caret'),
		);
		const blockMarked = await ev(
			() => !!window.proto.views.A.pm.dom.querySelector('.ob-block.ob-peer[data-id="P1b9"]'),
		);
		await ime.set("zaichang");
		await ime.commit("在场");
		await sleep(30);
		await t.idle();
		await ev(() => window.proto.clients.B.sendPresence("P1", "P1b9", 2));
		await t.idle();
		const peerAfter = await ev(
			() => !!window.proto.views.A.pm.dom.querySelector('.ob-block[data-id="P1b9"] .ob-peer-caret'),
		);
		it.note(
			`1j 组合中对方光标进入同一块：块外框标记=${blockMarked}，块内光标装饰=${peer}（组合中 ProseMirror 不在组合节点里画装饰），提交后装饰=${peerAfter}`,
		);
		it.check("1j 提交后对方光标装饰出现", peerAfter);
		it.eq("1j 组合不受在场信息影响", (await t.serverText("P1b9")).slice(0, 4), "测【在场");

		// 1i（记录行为）组合期间按真正的 Enter（keyCode 13，不经输入法）：浏览器把它当提交
		await t.focus("A", "P1b9", 1);
		const n0 = (await ev(() => window.proto.blockIds("A"))).length;
		await ime.set("ri");
		await t.page.keyboard.press("Enter");
		await sleep(30);
		await t.idle();
		const n1 = (await ev(() => window.proto.blockIds("A"))).length;
		it.note(
			`1i 组合中直接发 keyCode 13 的 Enter（非真实输入法行为）：块数 ${n0} → ${n1}，块文字「${await t.serverText("P1b9")}」，composing=${await ev(() => window.proto.views.A.pm.composing)}`,
		);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
