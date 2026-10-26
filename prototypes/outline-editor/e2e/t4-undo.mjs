// 验收 4：撤销。一个用户一个栈，一个大纲事务一步；和别人的并发修改交错时只撤销自己的。
import { Item, open, sleep } from "./lib.mjs";

const region = async (t) => {
	const o = await t.serverOutline("P1");
	return o.slice(o.indexOf("- ![[P1/P1b3]]"));
};

export async function run() {
	const it = new Item(4, "撤销");
	const t = await open();
	const kb = t.page.keyboard;
	try {
		// 4a 输入 → 拆块 → 缩进 → 输入，四步依次撤销、重做
		const S = [await region(t)];
		await t.focus("A", "P1b9", 4);
		await kb.type("一二");
		await t.idle();
		S.push(await region(t));
		await kb.press("Enter");
		await t.idle();
		S.push(await region(t));
		await kb.press("Tab");
		await t.idle();
		S.push(await region(t));
		await kb.type("三四");
		await t.idle();
		S.push(await region(t));
		it.eq("4a 四步之后", S[4], "- ![[P1/P1b3]]\n- 最后一块一二\n  - 三四");
		const sels = [];
		for (let i = 3; i >= 0; i--) {
			await kb.press("Control+z");
			await t.idle();
			it.eq(`4a 撤销到第 ${i} 步`, await region(t), S[i]);
			sels.push((await t.selection("A"))?.head);
		}
		it.eq(
			"4a 撤销后光标回到每一步之前的位置",
			sels.map((s) => s?.offset),
			[0, 0, 6, 4],
		);
		for (let i = 1; i <= 4; i++) {
			await kb.press("Control+Shift+z");
			await t.idle();
			it.eq(`4a 重做到第 ${i} 步`, await region(t), S[i]);
		}
		it.eq("4a Bob 看到的和服务端一致", await t.viewOutline("B"), await t.viewOutline("A"));

		// 4b 和别人的并发修改交错：只撤销自己的
		await t.focus("A", "P1b3", 13); // 末尾
		await kb.type("AAA");
		await t.idle();
		await t.focus("B", "P1b3", 0);
		await kb.type("BBB");
		await t.idle();
		await t.focus("A", "P1b3", 19); // Alice：BBB第三块…AAA 的末尾
		await kb.press("Enter");
		await kb.type("DDD");
		await t.idle();
		await t.focus("B", "P1b3", 3);
		await kb.type("CCC");
		await t.idle();
		const mixed = await t.serverOutline("P1");
		it.check(
			"4b 交错编辑后",
			mixed.includes("- BBBCCC第三块：拼接视图里也会出现AAA\n- DDD"),
			mixed,
		);
		// Alice 撤销三步：DDD、拆块、AAA
		for (let i = 0; i < 3; i++) {
			await t.ev(() => window.proto.undo("A"));
			await t.idle();
		}
		const afterA = await t.serverOutline("P1");
		it.check(
			"4b Alice 撤销三步：只去掉自己的 AAA、拆块、DDD",
			afterA.includes("- BBBCCC第三块：拼接视图里也会出现\n- ```ts"),
			afterA,
		);
		// Bob 撤销两步：CCC、BBB
		for (let i = 0; i < 2; i++) {
			await t.ev(() => window.proto.undo("B"));
			await t.idle();
		}
		it.eq("4b Bob 撤销两步后回到原文", await t.serverText("P1b3"), "第三块：拼接视图里也会出现");
		// Alice 重做三步：AAA、拆块、DDD 回来，Bob 撤掉的不回来
		for (let i = 0; i < 3; i++) {
			await t.ev(() => window.proto.redo("A"));
			await t.idle();
		}
		const redoA = await t.serverOutline("P1");
		it.check("4b Alice 重做三步", redoA.includes("- 第三块：拼接视图里也会出现AAA\n- DDD"), redoA);
		it.eq("4b 两个编辑器一致", await t.viewOutline("B"), await t.viewOutline("A"));

		// 4c 网络延迟下（对方的修改还在路上时撤销）
		await t.ev(() => {
			window.proto.net.latency = 80;
		});
		await t.focus("A", "P1b1", 5);
		await kb.type("XY");
		await t.focus("B", "P1b1", 0);
		await kb.type("Z");
		await t.focus("A", "P1b1", 7);
		await kb.press("Control+z");
		await sleep(400);
		await t.idle();
		await t.ev(() => {
			window.proto.net.latency = 0;
		});
		it.eq("4c 延迟 80ms 下撤销只撤自己的", await t.serverText("P1b1"), "# Z大纲编辑器");
		it.eq(
			"4c 三方一致",
			[await t.viewText("A", "P1b1"), await t.viewText("B", "P1b1")],
			["Z大纲编辑器", "Z大纲编辑器"],
		);

		// 4d 经嵌入编辑别的页，也记在同一个栈里
		await t.page.evaluate(() => window.proto.focus("A>embed:P2b3", "P2b3", 0));
		await kb.type("嵌");
		await t.idle();
		it.eq("4d 嵌入里输入", await t.serverText("P2b3"), "嵌被嵌入的块：在 P1 里也能就地编辑");
		await t.focus("A", "P1b9", 0);
		await kb.type("页");
		await t.idle();
		await t.ev(() => window.proto.undo("A"));
		await t.ev(() => window.proto.undo("A"));
		await t.idle();
		it.eq(
			"4d 同一个栈：两步撤销跨两页",
			[await t.serverText("P1b9"), await t.serverText("P2b3")],
			["最后一块一二", "被嵌入的块：在 P1 里也能就地编辑"],
		);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
