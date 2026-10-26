// PR1 验收 2：状态带过去。聚焦、折叠、选中（块选择的一组）、光标所在的块（和块内偏移），来回切换 20 次都不变。
import { Item, open } from "./lib.mjs";
import { surface } from "./t9-lib.mjs";

const keep = (s) => ({
	focus: s.focus,
	collapsed: s.collapsed,
	caret: s.caret,
	blocks: s.blocks,
	layout: s.layout,
});

export async function run() {
	const it = new Item("9.2", "状态带过去（来回切换 20 次）");
	const t = await open();
	const kb = t.page.keyboard;
	const m = surface(t, "A");
	const click = (k) => t.page.click(`[data-surface="A"] .sf-bar button[data-k="${k}"]`);
	/** 20 次来回：前 10 次等动画结束，后 10 次不等（动画中途就切回去）；via = "api" | "button" */
	const trips = async (label, S, via, inMap) => {
		const bad = [];
		const drift = [];
		const driftX = [];
		/** 切换之后锚点块（切换前离视口中心最近的块）在屏幕上的位置偏差：导图方向看 x、y，回大纲看 y（大纲不能横向滚） */
		const measure = async (toMap) => {
			const a = (await m.state()).anchor;
			if (!a) return;
			const p = await m.anchorScreen(a.blockId);
			if (!p) return;
			const dx = Math.abs(p.x - a.x);
			const dy = Math.abs(p.y - a.y);
			drift.push(toMap ? Math.max(dx, dy) : dy);
			if (!toMap) driftX.push(dx);
		};
		for (let i = 0; i < 20; i++) {
			const wait = i < 10;
			if (via === "button") await click("map");
			else await m.setView("map");
			if (wait) {
				await m.settle();
				await measure(true);
			}
			const ms = await m.map();
			if (inMap && !(await inMap(ms))) bad.push({ i, phase: "map", ms });
			if (via === "button") await click("outline");
			else await m.setView("outline");
			if (wait) {
				await m.settle();
				await measure(false);
			}
			const now = keep(await m.state());
			if (JSON.stringify(now) !== JSON.stringify(S)) bad.push({ i, phase: "outline", now });
		}
		await m.settle();
		it.eq(`${label}：20 次来回后状态不变`, keep(await m.state()), S);
		it.check(`${label}：每一次都不变`, bad.length === 0, bad.slice(0, 3));
		const mx = Math.max(0, ...drift);
		it.check(`${label}：锚点块位置偏差 ≤ 2 px（等动画结束的 10 次来回）`, mx <= 2, {
			max: mx,
			n: drift.length,
		});
		it.metrics[label] = {
			anchorDriftMaxPx: +mx.toFixed(2),
			backToOutlineDxMaxPx: +Math.max(0, ...driftX).toFixed(2),
			samples: drift.length,
		};
	};
	try {
		// 状态一：Tab 造出有子块的 P1b3 并折叠；聚焦 P1b2；光标在 P1b2_2 里选中 3–6
		await t.focus("A", "P1b4", 0);
		await kb.press("Tab");
		await t.idle();
		await t.page.click('[data-label="A"] .ob-block[data-id="P1b3"] > .ob-gutter .ob-arrow');
		await t.page.click('[data-label="A"] .ob-block[data-id="P1b2"] > .ob-gutter .ob-bullet');
		await m.settle();
		await t.focus("A", "P1b2_2", 3, 6);
		const S1 = keep(await m.state());
		it.eq("状态一", S1, {
			focus: "P1b2",
			collapsed: ["P1b3"],
			caret: { blockId: "P1b2_2", anchor: 3, head: 6 },
			blocks: [],
			layout: "right",
		});
		await trips(
			"状态一（聚焦 + 折叠 + 选区）",
			S1,
			"api",
			async (ms) => ms.root === "P1b2" && ms.selected === "P1b2_2",
		);
		it.eq("状态一：大纲里的选区还在", await t.selection("A"), {
			anchor: { blockId: "P1b2_2", offset: 3 },
			head: { blockId: "P1b2_2", offset: 6 },
		});

		// 状态二：整页、向下布局、块选择模式（Esc）选中 P1b3（折叠着）
		await m.focusBlock(null);
		await m.settle();
		await click("down");
		await t.focus("A", "P1b3", 2);
		await kb.press("Escape");
		const S2 = keep(await m.state());
		it.eq("状态二：块选择", S2.blocks, ["P1b3"]);
		it.eq("状态二：方向", S2.layout, "down");
		await trips("状态二（块选择 + 向下布局，用工具栏按钮切）", S2, "button", async (ms) => {
			const cls = await t.ev(() => window.proto.surfaces.A.map.el("P1b3")?.className ?? "");
			return ms.root === "P1" && ms.selected === "P1b3" && cls.includes("msel");
		});
		it.check(
			"状态二：大纲里块选择的高亮还在",
			await t.ev(() =>
				document
					.querySelector('[data-label="A"] .ob-block[data-id="P1b3"]')
					?.classList.contains("ob-bsel"),
			),
		);

		// 状态三：在导图里改的状态带回大纲：空格折叠 P1b2、Shift 点选 P1b9、选中 P1b6，向右布局
		await kb.press("Escape");
		await m.setView("map");
		await m.settle();
		await click("right");
		await m.settle();
		await m.select("P1b2");
		await kb.press(" ");
		await t.ev(() => window.proto.mapFit("A"));
		await m.select("P1b6");
		const r9 = await m.nodeRect("P1b9");
		await kb.down("Shift");
		await t.page.mouse.click(r9.x + r9.w / 2, r9.y + r9.h / 2);
		await kb.up("Shift");
		await m.setView("outline");
		await m.settle();
		const S3 = keep(await m.state());
		it.eq("状态三：导图里的折叠带到大纲", S3.collapsed.sort(), ["P1b2", "P1b3"]);
		it.eq("状态三：导图里的块选择带到大纲", S3.blocks, ["P1b9"]);
		it.eq("状态三：导图里选中的块成了大纲的光标块", S3.caret?.blockId, "P1b6");
		it.eq("状态三：大纲光标在 P1b6", (await t.selection("A"))?.head.blockId, "P1b6");
		await trips("状态三（导图里改的折叠 / 选中）", S3, "api", async (ms) => ms.selected === "P1b6");
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
