// PR1 验收 7：prefers-reduced-motion 开着时直接切换，没有动画（视图切换、方向切换、聚焦和退出）。
// 对照组：不开时同样的操作确实有动画。
import { Item, open, sleep } from "./lib.mjs";
import { surface } from "./t9-lib.mjs";

/** 在页面里同步执行一个操作，紧接着（同一个任务里）读动画数和视图的可见状态 */
const act = (t, src) =>
	t.ev((src) => {
		const p = window.proto;
		new Function("p", src)(p);
		const s = p.surfaces.A;
		const stage = getComputedStyle(s.map.stage).visibility;
		const outline = getComputedStyle(s.scroller).opacity;
		const last = s.log[s.log.length - 1];
		return {
			anims: document.getAnimations().length,
			animating: s.animating,
			view: s.state.view,
			focus: s.state.focus,
			layout: s.state.layout,
			stageVisible: stage === "visible",
			outlineOpacity: outline,
			lastAnimated: last?.animated ?? null,
			lastDone: last?.doneAt !== undefined,
			mapRoot: s.map.active ? s.map.rootId : null,
		};
	}, src);

const steps = [
	["切到导图", `p.setView("A", "map")`, { view: "map", stageVisible: true, outlineOpacity: "0" }],
	["向下展开", `p.setLayout("A", "down")`, { layout: "down" }],
	["导图里聚焦", `p.focusBlock("A", "P1b2")`, { focus: "P1b2", mapRoot: "P1b2" }],
	["导图里退出聚焦", `p.focusUp("A")`, { focus: null, mapRoot: "P1" }],
	["向右展开", `p.setLayout("A", "right")`, { layout: "right" }],
	[
		"切回大纲",
		`p.setView("A", "outline")`,
		{ view: "outline", stageVisible: false, outlineOpacity: "1" },
	],
	["大纲里聚焦", `p.focusBlock("A", "P1b2")`, { focus: "P1b2" }],
	["大纲里退出聚焦", `p.focusUp("A")`, { focus: null }],
];

export async function run() {
	const it = new Item("9.7", "reduced motion：直接切换");
	try {
		const t = await open();
		try {
			await t.page.emulateMedia({ reducedMotion: "reduce" });
			it.check(
				"已开 reduced motion",
				await t.ev(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
			);
			for (const [name, src, want] of steps) {
				const r = await act(t, src);
				it.eq(
					`${name}：同一个任务里没有动画`,
					{ anims: r.anims, animating: r.animating, lastAnimated: r.lastAnimated },
					{ anims: 0, animating: false, lastAnimated: 0 },
				);
				it.check(
					`${name}：同一个任务里已经切换完`,
					r.lastDone && Object.entries(want).every(([k, v]) => r[k] === v),
					r,
				);
			}
			// 键盘触发的聚焦也一样
			await t.focus("A", "P1b2", 1);
			await t.page.keyboard.press("Alt+ArrowRight");
			const k = await t.ev(() => ({
				anims: document.getAnimations().length,
				focus: window.proto.surfaces.A.state.focus,
			}));
			it.eq("Alt+→：没有动画、已聚焦", k, { anims: 0, focus: "P1b2" });
			it.check("reduced motion 页面没有报错", t.errors.length === 0, t.errors);
		} finally {
			await t.close();
		}
		// 对照：不开 reduced motion 时有动画
		const c = await open();
		try {
			await c.page.emulateMedia({ reducedMotion: "no-preference" });
			// 有动画时切换分两帧做（第二帧起动画），所以等一帧再数
			const r = await act(c, `p.setView("A", "map")`);
			await sleep(60);
			const n1 = await c.ev(() => document.getAnimations().length);
			it.check("对照：不开时切到导图有动画", r.animating && n1 > 0, { r, n1 });
			const surf = surface(c, "A");
			await surf.settle();
			const r2 = await act(c, `p.focusBlock("A", "P1b2")`);
			it.check("对照：不开时聚焦有动画", r2.anims > 0, r2);
		} finally {
			await c.close();
		}
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	}
	return it;
}
