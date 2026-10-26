// PR1 验收 3：导图里编辑（Tab、Enter、Shift-Tab、方向键、Alt+方向键、空格、Mod-Enter、拖动）
// 和在大纲里做同样的操作得到同一棵块树（逐步比对块树快照）；撤销重做跨视图连续；一人在导图里改、另一人同时改同一块。
import { Item, open } from "./lib.mjs";
import { surface, tree } from "./t9-lib.mjs";

/** 在导图里拖动：从节点中心按下，移到目标节点的某个位置（frac：沿顺序轴的比例，0.5 = 中间） */
async function drag(t, m, id, target, frac) {
	const a = await m.nodeRect(id);
	const b = await m.nodeRect(target);
	if (!a || !b) throw new Error(`节点不在 DOM 里：${id} / ${target}`);
	const mouse = t.page.mouse;
	await mouse.move(a.x + a.w / 2, a.y + a.h / 2);
	await mouse.down();
	await mouse.move(a.x + a.w / 2 + 10, a.y + a.h / 2 + 10, { steps: 3 });
	await mouse.move(b.x + b.w / 2, b.y + b.h * frac, { steps: 8 });
	await mouse.up();
}

/** 同一套语义步骤：kind = "map" 在导图里做，"outline" 在大纲里做；返回每一步之后的块树 */
async function runScenario(it, kind) {
	const t = await open();
	const snaps = [];
	const kb = t.page.keyboard;
	const m = surface(t, "A");
	const snap = async (label) => {
		await t.idle();
		snaps.push({ label, tree: await tree(t) });
	};
	const end = async (id) => (await t.serverText(id)).length;
	try {
		if (kind === "map") {
			await m.setView("map");
			await m.settle();
			// 1 Tab：在 P1b3 下加子块并编辑
			await m.select("P1b3");
			await kb.press("Tab");
			await kb.type("子一");
			await kb.press("Escape");
			await snap("Tab 加子块");
			it.eq("map Esc 回到节点选择", await m.focusWhere(), "map-stage");
			// 2 选中节点按 Enter 加下一个同级并进入编辑；Shift+Enter 块内换行；F2 进入编辑
			await kb.press("Enter");
			it.eq("map 选中节点按 Enter 加同级并进入编辑", await m.focusWhere(), "map-editor");
			await kb.type("子二");
			await kb.press("Shift+Enter");
			await kb.type("换行");
			await kb.press("Escape");
			await snap("Enter 加同级");
			await kb.press("F2");
			it.eq("map F2 进入编辑", await m.focusWhere(), "map-editor");
			await kb.press("Escape");
			// 3 Shift-Tab 提升一级
			await kb.press("Shift+Tab");
			await snap("Shift-Tab 提升");
			// 4 方向键（向右布局：↑↓ 同级，→ 第一个子块，← 父块）
			const sel = async () => (await m.map()).selected;
			const child1 = (await m.mapTree()).find((x) => x.parent === "P1b3")?.id;
			await kb.press("ArrowUp");
			it.eq("map ↑ 上一个同级", await sel(), "P1b3");
			await kb.press("ArrowRight");
			it.eq("map → 第一个子块", await sel(), child1);
			await kb.press("ArrowLeft");
			it.eq("map ← 父块", await sel(), "P1b3");
			await kb.press("ArrowDown");
			const sib = await sel();
			await kb.press("ArrowUp");
			it.check("map ↓ 下一个同级（Shift-Tab 提出来的子二）", sib && sib !== "P1b3", sib);
			// 向下布局：方向键对调
			await m.setLayout("down");
			await m.settle();
			await kb.press("ArrowDown");
			it.eq("map 向下布局 ↓ 第一个子块", await sel(), child1);
			await kb.press("ArrowUp");
			it.eq("map 向下布局 ↑ 父块", await sel(), "P1b3");
			await kb.press("ArrowRight");
			it.eq("map 向下布局 → 下一个同级", await sel(), sib);
			await kb.press("ArrowLeft");
			await m.setLayout("right");
			await m.settle();
			// 5 Alt+↓ 和下一个同级换位置
			await kb.press("Alt+ArrowDown");
			await snap("Alt+↓ 下移");
			// 6 空格折叠（视图状态，不改块树）
			await m.select("P1b2");
			await kb.press(" ");
			await snap("空格折叠");
			it.check("map 空格折叠进了视图状态", (await m.state()).collapsed.includes("P1b2"));
			// 7 Mod-Enter 变任务
			await m.select("P1b9");
			await kb.press("Control+Enter");
			await snap("Mod-Enter 任务");
			// 8 拖到节点上：挂到它下面；9 拖到同级之间：排序
			await t.ev(() => window.proto.mapFit("A"));
			await drag(t, m, "P1b9", "P1b5", 0.5);
			await snap("拖到节点上");
			await t.ev(() => window.proto.mapFit("A"));
			await drag(t, m, "P1b1", "P1b5", 0.92);
			await snap("拖到同级之间");
			it.eq("map 拖动后选中被拖的块", await sel(), "P1b1");
			// 两个客户端、大纲投影、服务端一致
			const server = await t.serverOutline("P1");
			it.eq(
				"map 场景：Alice 的大纲投影 = Bob 的大纲",
				await t.viewOutline("A"),
				await t.viewOutline("B"),
			);
			it.eq("map 场景：Bob = 服务端", await t.clientOutline("B", "P1"), server);
			it.eq("map 场景：Alice 客户端 = 服务端", await t.clientOutline("A", "P1"), server);
		} else {
			// 同样的语义，用大纲的键位
			await t.focus("A", "P1b3", await end("P1b3"));
			await kb.press("Enter");
			await kb.press("Tab");
			await kb.type("子一");
			await snap("Tab 加子块");
			await kb.press("Enter");
			await kb.type("子二");
			await kb.press("Shift+Enter");
			await kb.type("换行");
			await snap("Enter 加同级");
			await kb.press("Shift+Tab");
			await snap("Shift-Tab 提升");
			await t.focus("A", "P1b3", 0);
			await kb.press("Alt+ArrowDown");
			await snap("Alt+↓ 下移");
			await t.page.click('[data-label="A"] .ob-block[data-id="P1b2"] > .ob-gutter .ob-arrow');
			await snap("空格折叠");
			it.check("outline 折叠进了视图状态", (await m.state()).collapsed.includes("P1b2"));
			await t.focus("A", "P1b9", 0);
			await kb.press("Control+Enter");
			await snap("Mod-Enter 任务");
			for (let i = 0; i < 3; i++) await kb.press("Alt+ArrowUp");
			await kb.press("Tab");
			await snap("拖到节点上");
			await t.focus("A", "P1b1", 0);
			for (let i = 0; i < 5; i++) await kb.press("Alt+ArrowDown");
			await snap("拖到同级之间");
		}
		it.check(`${kind} 场景页面没有报错`, t.errors.length === 0, t.errors);
	} finally {
		await t.close();
	}
	return snaps;
}

async function undoAcrossViews(it) {
	const t = await open();
	const kb = t.page.keyboard;
	const m = surface(t, "A");
	try {
		const S = [await tree(t)];
		const step = async () => {
			await t.idle();
			S.push(await tree(t));
		};
		// s1 大纲里打字
		await t.focus("A", "P1b9", (await t.serverText("P1b9")).length);
		await kb.type("甲");
		await step();
		// s2 导图：Tab 加子块；s3 在节点里打字
		await m.setView("map");
		await m.settle();
		await m.select("P1b3");
		await kb.press("Tab");
		await step();
		await kb.type("乙");
		await kb.press("Escape");
		await step();
		// s4 导图：Alt+↓
		await m.select("P1b3");
		await kb.press("Alt+ArrowDown");
		await step();
		// s5、s6 大纲：Enter、打字
		await m.setView("outline");
		await m.settle();
		await t.focus("A", "P1b1", (await t.serverText("P1b1")).length);
		await kb.press("Enter");
		await step();
		await kb.type("丙");
		await step();
		// s7 导图：Mod-Enter
		await m.setView("map");
		await m.settle();
		await m.select("P1b1");
		await kb.press("Control+Enter");
		await step();
		it.eq("撤销：记录了 8 个状态", S.length, 8);
		const distinct = new Set(S.map((x) => JSON.stringify(x))).size;
		it.eq("撤销：每一步都改了块树", distinct, 8);
		// 在导图里撤销 3 步，切到大纲再撤销 4 步
		for (let i = 7; i >= 5; i--) {
			await kb.press("Control+z");
			await t.idle();
			it.eq(`撤销（导图）回到第 ${i - 1} 步`, await tree(t), S[i - 1]);
		}
		await m.setView("outline");
		await m.settle();
		for (let i = 4; i >= 1; i--) {
			await kb.press("Control+z");
			await t.idle();
			it.eq(`撤销（大纲）回到第 ${i - 1} 步`, await tree(t), S[i - 1]);
		}
		// 重做：大纲里 3 步，导图里 4 步
		for (let i = 1; i <= 3; i++) {
			await kb.press("Control+Shift+z");
			await t.idle();
			it.eq(`重做（大纲）到第 ${i} 步`, await tree(t), S[i]);
		}
		await m.setView("map");
		await m.settle();
		for (let i = 4; i <= 7; i++) {
			await kb.press("Control+Shift+z");
			await t.idle();
			it.eq(`重做（导图）到第 ${i} 步`, await tree(t), S[i]);
		}
		it.eq("撤销重做后 Bob = 服务端", await t.clientOutline("B", "P1"), await t.serverOutline("P1"));
		it.check("撤销场景页面没有报错", t.errors.length === 0, t.errors);
	} finally {
		await t.close();
	}
}

async function concurrent(it) {
	const t = await open();
	const kb = t.page.keyboard;
	const m = surface(t, "A");
	try {
		await m.setView("map");
		await m.settle();
		// Alice 在导图节点里打字，Bob 同时在大纲里改同一块（前面插字、把它下移）
		await m.select("P1b3");
		await kb.press("F2");
		await kb.type("甲甲");
		await t.insertVia("B", "P1b3", 0, "乙乙");
		await kb.type("丙");
		await t.cmd("B", "moveDown", "P1b3");
		await kb.type("丁");
		await t.idle();
		const want = "乙乙第三块：拼接视图里也会出现甲甲丙丁";
		it.eq("并发：服务端", await t.serverText("P1b3"), want);
		it.eq("并发：Bob 的大纲", await t.viewText("B", "P1b3"), want);
		it.eq(
			"并发：Alice 的节点编辑器",
			await t.ev(() => window.proto.surfaces.A.map.editing?.view.pm.state.doc.textContent),
			want,
		);
		it.check(
			"并发：Bob 下移了这一块，Alice 还在编辑它",
			(await t.serverOutline("P1")).includes("引用：远端修改按块重新解析\n- 乙乙第三块") ||
				(await t.serverOutline("P1")).includes("```\n- 乙乙第三块"),
			await t.serverOutline("P1"),
		);
		it.eq("并发：Alice 仍在编辑 P1b3", (await m.map()).editing, "P1b3");
		// Alice Tab 加子块的同时 Bob 缩进这一块
		await kb.press("Escape");
		await t.hold("A", true);
		await kb.press("Tab");
		await kb.type("新子块");
		await kb.press("Escape");
		await t.cmd("B", "indent", "P1b3");
		await t.hold("A", false);
		await t.idle();
		const server = await t.serverOutline("P1");
		it.eq("并发：Alice = 服务端", await t.clientOutline("A", "P1"), server);
		it.eq("并发：Bob = 服务端", await t.clientOutline("B", "P1"), server);
		it.check("并发：新子块在 P1b3 下面", /- 乙乙第三块[^\n]*\n\s+- 新子块/.test(server), server);
		// 导图里正在编辑的块被 Bob 删掉：编辑器退出，不报错
		await m.select("P1b9");
		await kb.press("F2");
		await kb.type("x");
		await t.ev(() => window.proto.deleteBlock("B", "P1b9"));
		await t.idle();
		await m.flush();
		it.eq("并发：被删的块退出编辑", (await m.map()).editing, null);
		it.check("并发：页面没有报错", t.errors.length === 0, t.errors);
	} finally {
		await t.close();
	}
}

export async function run() {
	const it = new Item("9.3", "导图编辑：和大纲同一套事务、撤销跨视图、并发");
	try {
		const a = await runScenario(it, "map");
		const b = await runScenario(it, "outline");
		it.eq("步骤数一致", a.length, b.length);
		for (let i = 0; i < Math.min(a.length, b.length); i++)
			it.eq(`第 ${i + 1} 步「${a[i].label}」块树一致`, a[i].tree, b[i].tree);
		it.metrics.steps = a.map((x) => x.label);
		// 最后的块树（只留文字前 8 个字，便于肉眼核对）
		const brief = (nodes) =>
			nodes.map(([text, task, kids]) => [String(text).slice(0, 8), task, brief(kids)]);
		it.metrics.finalTree = brief(a[a.length - 1].tree);
		await undoAcrossViews(it);
		await concurrent(it);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	}
	return it;
}
