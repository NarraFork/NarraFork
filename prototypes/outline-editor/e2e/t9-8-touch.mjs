// PR1 验收 8：触屏（Playwright 的触摸模拟 + CDP 触摸事件）：单指拖动平移、双指捏合缩放、点选、双击编辑、长按拖动节点。
// 真机（iOS / Android）留到 P1 真机测试。
import { Item, open, sleep } from "./lib.mjs";
import { surface } from "./t9-lib.mjs";

export async function run() {
	const it = new Item("9.8", "触屏：拖动、捏合、双击编辑");
	const t = await open("", { viewport: { width: 900, height: 1000 }, touch: true });
	const m = surface(t, "A");
	const touch = (type, pts) =>
		t.cdp.send("Input.dispatchTouchEvent", {
			type,
			touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
		});
	const tap = async (x, y) => {
		await touch("touchStart", [[x, y]]);
		await touch("touchEnd", []);
	};
	const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
	try {
		await m.setView("map");
		await m.settle();
		const frame = await t.ev(() => {
			const r = window.proto.surfaces.A.frame.getBoundingClientRect();
			return { x: r.left, y: r.top, w: r.width, h: r.height };
		});
		// 找一块空白：舞台右下角附近（导图在左边）
		const bg = [frame.x + frame.w - 30, frame.y + frame.h - 30];
		const hit = await t.ev(([x, y]) => document.elementFromPoint(x, y)?.className, bg);
		it.check("空白处是舞台", String(hit).includes("mm-stage"), hit);

		// 单指拖动：平移
		const m0 = await m.map();
		await touch("touchStart", [bg]);
		for (let i = 1; i <= 6; i++) await touch("touchMove", [[bg[0] - i * 20, bg[1] - i * 10]]);
		await touch("touchEnd", []);
		await sleep(30);
		const m1 = await m.map();
		it.check(
			"单指拖动：平移了 (-120, -60)",
			Math.abs(m1.tx - m0.tx + 120) < 2 &&
				Math.abs(m1.ty - m0.ty + 60) < 2 &&
				m1.scale === m0.scale,
			{ m0, m1 },
		);

		// 双指捏合：放大约 2 倍，两指中点下面的内容不动
		const cx = frame.x + frame.w / 2;
		const cy = frame.y + frame.h / 2;
		const before = await m.map();
		await touch("touchStart", [[cx - 40, cy]]);
		await touch("touchStart", [
			[cx - 40, cy],
			[cx + 40, cy],
		]);
		for (let i = 1; i <= 8; i++)
			await touch("touchMove", [
				[cx - 40 - i * 5, cy],
				[cx + 40 + i * 5, cy],
			]);
		await touch("touchEnd", []);
		await sleep(30);
		const after = await m.map();
		const k = after.scale / before.scale;
		it.check("双指捏合：放大约 2 倍", Math.abs(k - 2) < 0.05, {
			before: before.scale,
			after: after.scale,
		});
		// 中点（舞台坐标）对应的世界坐标前后一样
		const sx = cx - frame.x;
		const sy = cy - frame.y;
		const w0 = [(sx - before.tx) / before.scale, (sy - before.ty) / before.scale];
		const w1 = [(sx - after.tx) / after.scale, (sy - after.ty) / after.scale];
		it.check("双指捏合：中点不动", Math.abs(w0[0] - w1[0]) < 1 && Math.abs(w0[1] - w1[1]) < 1, {
			w0,
			w1,
		});
		// 缩小回来
		await touch("touchStart", [
			[cx - 80, cy],
			[cx + 80, cy],
		]);
		for (let i = 1; i <= 8; i++)
			await touch("touchMove", [
				[cx - 80 + i * 5, cy],
				[cx + 80 - i * 5, cy],
			]);
		await touch("touchEnd", []);
		await t.ev(() => window.proto.mapFit("A"));

		// 点选
		const r3 = await m.nodeRect("P1b3");
		await tap(...center(r3));
		await sleep(30);
		it.eq("点选节点", (await m.map()).selected, "P1b3");
		it.eq("单击不进入编辑", (await m.map()).editing, null);
		// 双击编辑
		await sleep(400);
		await tap(...center(r3));
		await sleep(80);
		await tap(...center(r3));
		await sleep(30);
		it.eq("双击进入编辑", (await m.map()).editing, "P1b3");
		await t.page.keyboard.type("（触屏）");
		await t.idle();
		it.check(
			"双击后能打字",
			(await t.serverText("P1b3")).endsWith("（触屏）"),
			await t.serverText("P1b3"),
		);
		// 点空白退出编辑
		await tap(...bg);
		await sleep(30);
		it.eq("点空白退出编辑", (await m.map()).editing, null);

		// 长按拖动：把 P1b9 挂到 P1b5 下面
		await t.ev(() => window.proto.mapFit("A"));
		const r9 = await m.nodeRect("P1b9");
		const r5 = await m.nodeRect("P1b5");
		const p9 = center(r9);
		await touch("touchStart", [p9]);
		await sleep(600);
		const dragging = await t.ev(() =>
			window.proto.surfaces.A.map.el("P1b9")?.classList.contains("dragging"),
		);
		it.check("长按进入拖动", dragging, dragging);
		const p5 = center(r5);
		for (let i = 1; i <= 8; i++)
			await touch("touchMove", [
				[p9[0] + ((p5[0] - p9[0]) * i) / 8, p9[1] + ((p5[1] - p9[1]) * i) / 8],
			]);
		await touch("touchEnd", []);
		await t.idle();
		const out = await t.serverOutline("P1");
		it.check(
			"长按拖动：P1b9 挂到 P1b5 下面",
			out.includes("> 引用：远端修改按块重新解析\n  - 最后一块"),
			out,
		);
		it.eq("长按拖动：Bob 一致", await t.clientOutline("B", "P1"), out);
		// 单指在节点上划（没有长按）：平移，不拖动
		await t.ev(() => window.proto.mapFit("A"));
		const before2 = await m.map();
		const r2 = await m.nodeRect("P1b2");
		const p2 = center(r2);
		await touch("touchStart", [p2]);
		for (let i = 1; i <= 5; i++) await touch("touchMove", [[p2[0] + i * 12, p2[1]]]);
		await touch("touchEnd", []);
		await t.idle();
		const after2 = await m.map();
		it.check("在节点上直接划：平移", Math.abs(after2.tx - before2.tx - 60) < 2, {
			before2,
			after2,
		});
		it.eq("在节点上直接划：块树不变", await t.serverOutline("P1"), out);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
