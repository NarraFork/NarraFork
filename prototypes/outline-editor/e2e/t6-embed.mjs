// 验收 6：嵌入。在嵌入里编辑时源页实时变化；同一个块在一页里出现两次。
import { Item, open } from "./lib.mjs";

const SRC = "被嵌入的块：在 P1 里也能就地编辑";
const THIRD = "第三块：拼接视图里也会出现";

export async function run() {
	const it = new Item(6, "嵌入");
	const t = await open();
	const kb = t.page.keyboard;
	try {
		const subs = await t.ev(() => window.proto.embedViews("A"));
		it.check(
			"6 Alice 的 P1 里有两个嵌入子视图（P2b3、P1b3）",
			subs.includes("P2b3") && subs.includes("P1b3"),
			subs,
		);

		// 6a 在嵌入里编辑：源页（P2）实时变化，Bob 看 P2 的编辑器同步更新
		await t.focus("A>embed:P2b3", "P2b3", 5);
		await kb.type("【嵌入里改】");
		await t.idle();
		const want = "被嵌入的块【嵌入里改】：在 P1 里也能就地编辑";
		it.eq("6a 服务端 P2 的块变了", await t.serverText("P2b3"), want);
		it.eq("6a Bob 的 P2 编辑器实时变化", await t.viewText("B2", "P2b3"), want);
		it.eq("6a Bob 的 P1 里的同一个嵌入也变了", await t.viewText("B>embed:P2b3", "P2b3"), want);
		it.eq("6a 选区留在嵌入里（不跨越嵌入边界）", (await t.selection("A>embed:P2b3"))?.head, {
			blockId: "P2b3",
			offset: 11,
		});

		// 6b Bob 在 P2 里改，Alice 的嵌入实时变化（光标不在那里也照样更新）
		await t.focus("B2", "P2b3", 0);
		await kb.type("B:");
		await t.idle();
		it.eq("6b 源页的修改实时出现在嵌入里", await t.viewText("A>embed:P2b3", "P2b3"), `B:${want}`);

		// 6c 同一个块在一页里出现两次：P1b3 原位 + 嵌入 ![[P1/P1b3]]；改一处，另一处同步（同一客户端，不经服务端）
		await t.focus("A", "P1b3", 3);
		await t.hold("A", true);
		await kb.type("一");
		const both = [await t.viewText("A", "P1b3"), await t.viewText("A>embed:P1b3", "P1b3")];
		it.eq("6c 原位改，同页的嵌入立即同步（网络暂停时也同步）", both, [
			`第三块一：拼接视图里也会出现`,
			`第三块一：拼接视图里也会出现`,
		]);
		await t.hold("A", false);
		await t.focus("A>embed:P1b3", "P1b3", 4);
		await kb.type("二");
		await t.idle();
		const want3 = "第三块一二：拼接视图里也会出现";
		it.eq("6c 在嵌入里改，原位同步", await t.viewText("A", "P1b3"), want3);
		it.eq("6c 拼接视图里的同一个块也同步", await t.viewText("AS", "P1b3"), want3);
		it.eq(
			"6c Bob 的两处都同步",
			[await t.viewText("B", "P1b3"), await t.viewText("B>embed:P1b3", "P1b3")],
			[want3, want3],
		);

		// 6d 两个人分别在原位和嵌入里同时改同一个块
		await t.hold("A", true);
		await t.hold("B", true);
		await t.focus("A>embed:P1b3", "P1b3", 0);
		await kb.type("甲");
		await t.focus("B", "P1b3", 10);
		await kb.type("乙");
		await t.hold("A", false);
		await t.hold("B", false);
		await t.idle();
		const s3 = await t.serverText("P1b3");
		it.check("6d 两人的修改都在", s3.includes("甲") && s3.includes("乙"), s3);
		it.eq(
			"6d 四处一致（Alice 原位 / 嵌入、Bob 原位 / 嵌入）",
			[
				await t.viewText("A", "P1b3"),
				await t.viewText("A>embed:P1b3", "P1b3"),
				await t.viewText("B", "P1b3"),
				await t.viewText("B>embed:P1b3", "P1b3"),
			],
			[s3, s3, s3, s3],
		);

		// 6e 在嵌入的根上回车：新块成为根的第一个子块（留在嵌入里），写进源页
		await t.focus("A>embed:P2b3", "P2b3", (await t.serverText("P2b3")).length);
		await kb.press("Enter");
		await kb.type("嵌入里新建");
		await t.idle();
		const p2 = await t.serverOutline("P2");
		it.check(
			"6e 新块是被嵌入块的第一个子块",
			p2.includes(`- B:${want}\n  - 嵌入里新建\n  - 它的子块`),
			p2,
		);
		it.check(
			"6e Bob 的 P2 编辑器里出现",
			(await t.viewOutline("B2")).includes("  - 嵌入里新建\n  - 它的子块"),
			await t.viewOutline("B2"),
		);

		// 6f 撤销也记在同一个栈里
		await kb.press("Control+z");
		await kb.press("Control+z");
		await t.idle();
		it.check(
			"6f 在嵌入里撤销：新块撤掉",
			!(await t.serverOutline("P2")).includes("嵌入里新建"),
			await t.serverOutline("P2"),
		);

		// 6g 循环嵌入：块的子块里嵌入它自己 → 不无限展开
		await t.ev(() => {
			const p = window.proto;
			const r = p.agentRead("ag", "P1");
			p.agentWrite("ag", "P1", [{ t: "insert", parentId: "P1b3", content: "![[P1/P1b3]]" }]);
			return r.outline.length;
		});
		await t.idle();
		const cyc = await t.ev(() => document.querySelectorAll(".ob-embed-body").length);
		const txt = await t.ev(() => document.body.innerText.includes("循环嵌入"));
		it.check("6g 循环嵌入显示占位、不无限展开", txt && cyc < 40, { embeds: cyc, txt });
		it.eq("6g 编辑器与服务端一致", await t.viewOutline("B"), await t.viewOutline("A"));
		it.check("页面没有报错", t.errors.length === 0, t.errors);
		it.note(`嵌入子视图总数（含循环占位）：${cyc}`);
		void THIRD;
		void SRC;
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
