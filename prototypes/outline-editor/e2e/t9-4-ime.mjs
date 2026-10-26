// PR1 验收 4：导图节点里的中文输入法（CDP 模拟，沿用 P0 第 1 项的做法）：组合期间收到远端修改，不丢字。
import { Item, open, sleep } from "./lib.mjs";
import { surface } from "./t9-lib.mjs";

const ORIG3 = "第三块：拼接视图里也会出现";

export async function run() {
	const it = new Item("9.4", "导图节点里的输入法");
	const t = await open();
	const { ime, ev } = t;
	const m = surface(t, "A");
	const editorText = () =>
		ev(() => window.proto.surfaces.A.map.editing?.view.pm.state.doc.textContent ?? null);
	const editorSel = () =>
		ev(() => {
			const v = window.proto.surfaces.A.map.editing?.view;
			if (!v) return null;
			const s = v.captureSel();
			return s ? s.head : null;
		});
	const composing = () => ev(() => window.proto.surfaces.A.map.editing?.view.pm.composing ?? null);
	try {
		await m.setView("map");
		await m.settle();

		// 4a 节点里组合：拼音不外发；提交后三方一致，光标在提交文字之后
		await m.edit("P1b3", 3);
		await ime.set("n");
		await ime.set("ni");
		await ime.set("nihao");
		await t.idle();
		it.eq("4a 组合中节点编辑器显示拼音", await editorText(), "第三块nihao：拼接视图里也会出现");
		it.eq("4a 组合中拼音不进服务端", await t.serverText("P1b3"), ORIG3);
		it.eq("4a 组合中 Bob 看不到拼音", await t.viewText("B", "P1b3"), ORIG3);
		await ime.commit("你好");
		await sleep(30);
		await t.idle();
		const want1 = "第三块你好：拼接视图里也会出现";
		it.eq("4a 提交后节点编辑器", await editorText(), want1);
		it.eq("4a 提交后服务端", await t.serverText("P1b3"), want1);
		it.eq("4a 提交后 Bob", await t.viewText("B", "P1b3"), want1);
		it.eq("4a 光标在提交文字之后", await editorSel(), { blockId: "P1b3", offset: 5 });

		// 4b 组合期间 Bob 改同一块（光标前、后各一处）：推迟应用、编辑器 DOM 不被替换，提交后合并、不丢字
		await ime.set("x");
		await ime.set("xin");
		await ev(() => {
			const el = window.proto.surfaces.A.map.editing.view.pm.dom.querySelector('[data-id="P1b3"]');
			el.__mark = 1;
		});
		await t.insertVia("B", "P1b3", 0, "【前】");
		await t.insertVia("B", "P1b3", 3 + want1.length, "【后】");
		await t.idle();
		it.eq("4b 组合中编辑器保持本地内容", await editorText(), "第三块你好xin：拼接视图里也会出现");
		it.eq(
			"4b 组合中 Alice 的 Y.Text 已有 Bob 的修改",
			await t.text("A", "P1b3"),
			`【前】${want1}【后】`,
		);
		it.check(
			"4b 组合中块的 DOM 没被替换",
			await ev(
				() =>
					window.proto.surfaces.A.map.editing.view.pm.dom.querySelector('[data-id="P1b3"]')
						.__mark === 1,
			),
		);
		it.eq("4b 组合没被打断", await composing(), true);
		await ime.commit("信息");
		await sleep(30);
		await t.idle();
		const want2 = "【前】第三块你好信息：拼接视图里也会出现【后】";
		it.eq("4b 提交后服务端（不丢字）", await t.serverText("P1b3"), want2);
		it.eq("4b 提交后节点编辑器", await editorText(), want2);
		it.eq("4b 提交后 Bob", await t.viewText("B", "P1b3"), want2);
		it.eq("4b 光标在「信息」之后", await editorSel(), { blockId: "P1b3", offset: 10 });
		await t.page.keyboard.type("！");
		await t.idle();
		it.eq(
			"4b 接着打字落在光标处",
			await t.serverText("P1b3"),
			"【前】第三块你好信息！：拼接视图里也会出现【后】",
		);

		// 4c 组合期间 Bob 改别的块：导图里那个节点立即更新（重新布局），组合不中断
		await ime.set("zhong");
		await t.insertVia("B", "P1b9", 0, "【B改】");
		await t.idle();
		await m.flush();
		it.check(
			"4c 别的节点立即显示 Bob 的修改",
			(await ev(() => window.proto.surfaces.A.map.el("P1b9")?.textContent ?? "")).includes(
				"【B改】",
			),
		);
		it.eq("4c 组合没被打断", await composing(), true);
		// 4d 组合期间 Bob 在前面加了一块（导图重新布局，正在编辑的节点挪位置）
		const before = await m.nodeRect("P1b3");
		await t.cmd("B", "split", "P1b2", 0);
		await t.idle();
		await m.flush();
		const after = await m.nodeRect("P1b3");
		it.check("4d 正在编辑的节点随布局挪了位置", before && after && after.y !== before.y, {
			before,
			after,
		});
		it.eq("4d 组合没被打断", await composing(), true);
		await ime.commit("中");
		await sleep(30);
		await t.idle();
		it.eq(
			"4d 提交后服务端",
			await t.serverText("P1b3"),
			"【前】第三块你好信息！中：拼接视图里也会出现【后】",
		);

		// 4e 组合中按 Enter / 方向键（keyCode 229）：不拆块、不跳块；提交后真 Enter 拆块，编辑跟到新块
		const blocksBefore = (await ev(() => window.proto.server.store.children("P1"))).length;
		await ime.set("hao");
		await ime.key("Enter");
		await ime.key("ArrowDown");
		await ime.commit("好");
		await sleep(30);
		await t.idle();
		it.eq(
			"4e 组合中 Enter 不拆块",
			(await ev(() => window.proto.server.store.children("P1"))).length,
			blocksBefore,
		);
		it.eq("4e 仍在编辑 P1b3", (await m.map()).editing, "P1b3");
		await t.page.keyboard.press("Enter");
		await t.idle();
		await sleep(20);
		const st = await m.map();
		it.check("4e 真 Enter 拆块，编辑跟到新块", st.editing && st.editing !== "P1b3", st);
		await t.page.keyboard.press("Escape");

		// 4f 组合期间 agent 三方合并写同一块：被接受，提交后一致
		await m.edit("P1b9", 0);
		await ime.set("a");
		await ime.set("ag");
		await ev(() => {
			const p = window.proto;
			const r = p.agentRead("ime", "P1");
			const b = r.blocks.find((x) => x.id === "P1b9");
			return p.agentWrite("ime", "P1", [
				{ t: "text", id: "P1b9", content: `${b.content}（agent）` },
			]);
		});
		await t.idle();
		it.eq("4f 组合没被打断", await composing(), true);
		await ime.commit("啊");
		await sleep(30);
		await t.idle();
		it.eq("4f 提交后服务端", await t.serverText("P1b9"), "啊【B改】最后一块（agent）");
		it.eq("4f 提交后节点编辑器", await editorText(), "啊【B改】最后一块（agent）");
		await t.page.keyboard.press("Escape");

		// 4g 反过来：Bob 在自己的导图节点里组合，Alice 在大纲里改同一块
		await m.setView("outline");
		await m.settle();
		const b = surface(t, "B");
		await b.setView("map");
		await b.settle();
		await b.edit("P1b5", 2);
		await ime.set("bo");
		await ime.set("bob");
		await t.insertVia("A", "P1b5", 0, "[A]");
		await t.idle();
		await ime.commit("鲍勃");
		await sleep(30);
		await t.idle();
		const w5 = await t.serverText("P1b5");
		it.check(
			"4g Bob 在导图里组合、Alice 同时改：两边的字都在",
			w5.includes("[A]") && w5.includes("鲍勃"),
			w5,
		);
		it.eq("4g Alice 的大纲 = 服务端", await t.viewText("A", "P1b5"), await t.viewText("B", "P1b5"));
		it.eq(
			"4g 收敛（A / B / 服务端）",
			await t.clientOutline("A", "P1"),
			await t.serverOutline("P1"),
		);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
