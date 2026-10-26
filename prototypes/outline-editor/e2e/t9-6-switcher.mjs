// PR1 验收 6：快速切换。1 万块（5 页 × 2000 块）里按标题、别名、正文都能命中；从按键（Enter）到聚焦完成（画出来）≤ 150 ms。
// 最近访问的排在前面；大纲和导图里都能用。
import { Item, open } from "./lib.mjs";
import { summary, surface } from "./t9-lib.mjs";

export async function run() {
	const it = new Item("9.6", "快速切换（1 万块）");
	const t = await open("?mode=perf&n=2000&pages=5", { viewport: { width: 1280, height: 900 } });
	const kb = t.page.keyboard;
	const m = surface(t, "A");
	const lat = [];
	const queryMs = [];
	try {
		await t.ev(() => {
			window.__qsT = null;
			document.addEventListener(
				"keydown",
				(e) => {
					if (e.key === "Enter" && window.proto.switcher.isOpen) window.__qsT = performance.now();
				},
				true,
			);
		});
		const idOf = (text) =>
			t.ev((text) => {
				const s = window.proto.server;
				for (const b of s.store.blocks.values())
					if (!b.deleted && s.textOf(b.id).includes(text)) return b.id;
				return null;
			}, text);
		/** Mod-K → 输入 → Enter；返回从 Enter 按下到聚焦画完的时间 */
		const jump = async (name, q, want, via) => {
			await kb.press("Control+k");
			it.check(`${name}：Mod-K 打开切换器`, await t.ev(() => window.proto.switcher.isOpen));
			await kb.type(q, { delay: 15 });
			queryMs.push(await t.ev(() => window.proto.switcher.stats.queryMs));
			const top = await t.ev(() => {
				const r = window.proto.switcher.results[0];
				return r ? { id: r.e.id, via: r.via } : null;
			});
			it.eq(`${name}：第一条命中（${via}）`, top, { id: want, via });
			await kb.press("Enter");
			const ms = await t.ev(async (want) => {
				const s = window.proto.surfaces.A;
				for (let i = 0; i < 500 && s.state.focus !== want; i++)
					await new Promise((r) => setTimeout(r, 1));
				await new Promise((r) => requestAnimationFrame(() => r()));
				await new Promise((r) => {
					const ch = new MessageChannel();
					ch.port1.onmessage = () => r();
					ch.port2.postMessage(0);
				});
				return performance.now() - window.__qsT;
			}, want);
			lat.push(ms);
			it.eq(`${name}：聚焦过去了`, (await m.state()).focus, want);
			it.check(`${name}：按键到聚焦完成 ≤ 150 ms`, ms <= 150, +ms.toFixed(1));
			await m.settle();
			return ms;
		};
		it.metrics.index = await t.ev(() => {
			const sw = window.proto.switcher;
			sw.open(window.proto.surfaces.A);
			sw.close();
			return { entries: sw.stats.entries, buildMs: +sw.stats.buildMs.toFixed(1) };
		});
		it.check("索引覆盖 1 万块", it.metrics.index.entries >= 10000, it.metrics.index);
		await t.focus("A", "P1b1", 0);

		// 大纲视图
		const tTitle = await idOf("小节 P4-1250");
		await jump("标题（别的页）", "小节 P4-1250", tTitle, "标题");
		it.eq(
			"跨页聚焦：大纲以目标为根",
			await t.ev(() => window.proto.surfaces.A.outline.pm.dom.dataset.focus),
			tTitle,
		);
		await kb.type("！");
		await t.idle();
		it.check(
			"跨页聚焦后就地编辑",
			(await t.serverText(tTitle)).endsWith("！"),
			await t.serverText(tTitle),
		);
		await jump("别名", "别名P3-42", await idOf("别名P3-42"), "别名");
		await jump("正文（第二行才有的词）", "tokP2-48x", await idOf("tokP2-48x"), "正文");
		await jump("标题（当前页）", "小节 600", await idOf("小节 600"), "标题");
		await jump("正文（当前页）", "tok89x", await idOf("tok89x"), "正文");

		// 最近访问排前面：空查询第一条是刚去过的；多条命中时最近访问的排第一
		await kb.press("Control+k");
		const recentTop = await t.ev(() =>
			window.proto.switcher.results.map((r) => r.e.id).slice(0, 3),
		);
		it.eq("空查询：最近访问的在最前", recentTop[0], await idOf("tok89x"));
		await kb.press("Escape");
		const visited = await idOf("小节 P5-1500");
		await m.focusBlock(visited);
		await m.settle();
		await kb.press("Control+k");
		await kb.type("小节 P5-1");
		const top = await t.ev(() => window.proto.switcher.results[0]?.e.id);
		const many = await t.ev(() => window.proto.switcher.results.length);
		it.check("多条命中时最近访问的排第一", top === visited && many > 5, { top, visited, many });
		await kb.press("Escape");

		// 导图视图里切换：以目标为根重新布局
		await m.focusBlock(null);
		await m.settle();
		await m.setView("map");
		await m.settle();
		const tMap = await idOf("小节 P2-700");
		await jump("导图里：标题", "小节 P2-700", tMap, "标题");
		it.eq("导图以目标为根", (await m.map()).root, tMap);
		it.eq("导图选中目标", (await m.map()).selected, tMap);
		await jump("导图里：别名（当前页）", "别名79", await idOf("别名79"), "别名");

		it.metrics.keyToFocusMs = summary(lat);
		it.metrics.queryMs = summary(queryMs);
		it.check("页面没有报错", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}
	return it;
}
