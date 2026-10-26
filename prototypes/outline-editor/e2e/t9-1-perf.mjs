// PR1 验收 1：性能（2000 块，无头 Chromium，数字是相对值）。
// - 导图布局 p95 ≤ 16 ms；首次画出 ≤ 200 ms；
// - 切换动画期间帧时间 p95 ≤ 20 ms，超过 50 ms 的长帧不超过 1 帧（每次切换）；
// - 切换前后视口锚点块在屏幕上的位置偏差 ≤ 2 px。
// 另外记录：节点里按键到画完（和大纲比）、pretext 测量的冷 / 热耗时和预测误差、Worker 预先测量的耗时、5000 块的布局。
import { Item, open, sleep } from "./lib.mjs";
import { summary, surface } from "./t9-lib.mjs";

const VIEWPORT = { viewport: { width: 1280, height: 900 } };

/**
 * 在页面里：做一件事，返回从调用到导图画出来的时间。切换分两帧做（第二帧才显示导图、起动画），
 * 所以等到第二步做完（切换日志多了一条）之后的那一帧画完才算。
 */
const toPaint = (t, src) =>
	t.ev(async (src) => {
		const frame = () =>
			new Promise((r) =>
				requestAnimationFrame(() => {
					const ch = new MessageChannel();
					ch.port1.onmessage = () => r();
					ch.port2.postMessage(0);
				}),
			);
		const s = window.proto.surfaces.A;
		const n0 = s.log.length;
		const t0 = performance.now();
		new Function("p", src)(window.proto);
		const sync = performance.now() - t0;
		for (let i = 0; i < 100 && s.log.length === n0; i++) await frame();
		const shown = performance.now() - t0;
		await frame();
		return {
			sync: +sync.toFixed(1),
			shown: +shown.toFixed(1),
			painted: +(performance.now() - t0).toFixed(1),
		};
	}, src);

async function middle(t) {
	await t.focus("A", "P1b1000", 3);
	await t.ev(() =>
		document.querySelector(".ProseMirror-focused")?.scrollIntoView({ block: "center" }),
	);
	await sleep(200);
}

/** 不预先测量：第一次切到导图要当场测 2000 块 */
async function cold(it) {
	const t = await open("?mode=perf&n=2000&premeasure=0", VIEWPORT);
	try {
		await middle(t);
		const r = await toPaint(t, `p.setView("A", "map")`);
		const st = await t.ev(() => window.proto.mapStats("A"));
		it.metrics.coldNoPremeasure = {
			firstPaintMs: r.painted,
			syncMs: r.sync,
			measureMs: +st.measure.ms.toFixed(1),
			measured: st.measure.misses,
			firstLayoutMs: +st.layouts[0].toFixed(1),
		};
	} finally {
		await t.close();
	}
}

async function scale5000(it) {
	const t = await open("?mode=perf&n=5000", VIEWPORT);
	try {
		await t.ev(async () => {
			await new Promise((r) => setTimeout(r, 50));
			await window.proto.prewarmDone("A");
		});
		await middle(t);
		const r = await toPaint(t, `p.setView("A", "map")`);
		await surface(t).settle();
		const lay = await t.ev(() => {
			const m = window.proto.surfaces.A.map;
			const out = [];
			for (let i = 0; i < 20; i++) {
				const t0 = performance.now();
				m.relayout();
				out.push(performance.now() - t0);
			}
			return out;
		});
		it.metrics.n5000 = { firstPaintMs: r.painted, relayoutMs: summary(lay) };
	} finally {
		await t.close();
	}
}

export async function run() {
	const it = new Item("9.1", "导图性能（2000 块）");
	try {
		await cold(it);
		const t = await open("?mode=perf&n=2000", VIEWPORT);
		const m = surface(t, "A");
		try {
			it.metrics.premeasure = await t.ev(async () => {
				await new Promise((r) => setTimeout(r, 50));
				return window.proto.prewarmDone("A");
			});
			await middle(t);
			// 帧记录器：整个过程一直跑 rAF，记下每帧回调的时刻
			await t.ev(() => {
				window.__frames = [];
				window.__rec = true;
				const loop = () => {
					window.__frames.push(performance.now());
					if (window.__rec) requestAnimationFrame(loop);
				};
				requestAnimationFrame(loop);
			});
			const first = await toPaint(t, `p.setView("A", "map")`);
			it.metrics.firstPaint = first;
			it.check("首次画出 ≤ 200 ms（Worker 已预先测量）", first.painted <= 200, first);
			await m.settle();
			// 切换序列：大纲 ↔ 导图、向右 ↔ 向下
			const seq = [
				["toOutline", `p.setView("A", "outline")`],
				["toMap", `p.setView("A", "map")`],
				["down", `p.setLayout("A", "down")`],
				["right", `p.setLayout("A", "right")`],
				["toOutline", `p.setView("A", "outline")`],
				["toMap", `p.setView("A", "map")`],
				["down", `p.setLayout("A", "down")`],
				["toOutline", `p.setView("A", "outline")`],
				["toMap(down)", `p.setView("A", "map")`],
				["right", `p.setLayout("A", "right")`],
				["toOutline", `p.setView("A", "outline")`],
				["toMap", `p.setView("A", "map")`],
			];
			const windows = [{ kind: "toMap(first)", at: null }];
			for (const [kind, src] of seq) {
				await sleep(150);
				await t.ev((src) => new Function("p", src)(window.proto), src);
				windows.push({ kind });
				await m.settle();
			}
			await sleep(100);
			const log = await m.log();
			const frames = await t.ev(() => {
				window.__rec = false;
				return window.__frames;
			});
			// 每次切换：从开始到动画结束（再多一帧）之间的帧间隔
			const all = [];
			const rest = [];
			const setup = [];
			const per = [];
			const drift = [];
			for (const e of log) {
				const end = (e.doneAt ?? e.at) + 20;
				const ds = [];
				for (let i = 1; i < frames.length; i++) {
					if (frames[i] < e.at) continue;
					if (frames[i - 1] > end) break;
					ds.push(frames[i] - frames[i - 1]);
				}
				all.push(...ds);
				// 拆开看：每次切换的头两帧（算布局、建 DOM、解锁 / 显示）和之后的动画帧
				setup.push(...ds.slice(0, 2));
				rest.push(...ds.slice(2));
				per.push({
					kind: e.kind,
					setupMs: +e.setupMs.toFixed(1),
					frames: ds.length,
					maxFrame: +Math.max(...ds).toFixed(1),
					over50: ds.filter((d) => d > 50).length,
					head: ds.slice(0, 4).map((d) => +d.toFixed(1)),
					parts: e.parts,
				});
			}
			// 锚点偏差：每次切换结束后按 DOM 读锚点块的位置（只能在当时读，所以重放一遍序列）
			for (const [kind, src] of seq) {
				await sleep(100);
				await t.ev((src) => new Function("p", src)(window.proto), src);
				await m.settle();
				const last = (await m.log()).at(-1);
				const a = last.anchor;
				if (!a) continue;
				const p = await m.anchorScreen(a.blockId);
				if (!p) continue;
				const dx = Math.abs(p.x - a.x);
				const dy = Math.abs(p.y - a.y);
				drift.push({ kind, block: a.blockId, dx: +dx.toFixed(2), dy: +dy.toFixed(2) });
			}
			it.metrics.frames = {
				all: summary(all),
				firstTwoPerSwitch: summary(setup),
				animationOnly: summary(rest),
				over50: all.filter((d) => d > 50).length,
				per,
			};
			it.check("切换动画期间帧时间 p95 ≤ 20 ms", summary(all).p95 <= 20, summary(all));
			it.check(
				"每次切换超过 50 ms 的帧不超过 1 帧",
				per.every((x) => x.over50 <= 1),
				per.filter((x) => x.over50 > 1),
			);
			it.metrics.anchorDrift = drift;
			const worst = Math.max(
				...drift.map((d) => (d.kind === "toOutline" ? d.dy : Math.max(d.dx, d.dy))),
			);
			it.check("锚点块位置偏差 ≤ 2 px（回大纲看纵向）", worst <= 2, { worst, drift });
			it.metrics.anchorDriftToOutlineDxMax = Math.max(
				0,
				...drift.filter((d) => d.kind === "toOutline").map((d) => d.dx),
			);

			// 布局耗时：导图里编辑（节点里打字、Tab 加子块、空格折叠 / 展开），每次存储变化都重新布局
			await m.setView("map");
			await m.settle();
			const before = (await t.ev(() => window.proto.mapStats("A"))).layouts.length;
			const ids = await t.ev(() => window.proto.mapTree("A").map((x) => x.id));
			const target = ids[Math.floor(ids.length / 2)];
			await m.select(target);
			// 节点里按键到画完（和 t7 的大纲同一种量法）
			await t.ev(() => {
				const w = window;
				w.__lat = [];
				const ch = new MessageChannel();
				let pending = [];
				ch.port1.onmessage = () => {
					const now = performance.now();
					for (const p of pending) p.afterPaint = now - p.t0;
					pending = [];
				};
				document.addEventListener(
					"keydown",
					() => {
						const rec = { t0: performance.now() };
						w.__lat.push(rec);
						requestAnimationFrame(() => {
							pending.push(rec);
							ch.port2.postMessage(0);
						});
					},
					true,
				);
			});
			await t.page.keyboard.press("Enter");
			// 只有不经输入法的字符有 keydown（中文用 insertText，量不到），所以用英文字母量延迟
			await t.page.keyboard.type("abcdefghijklmnopqrstuvwxyz0123456789".repeat(2), { delay: 30 });
			await sleep(100);
			const typing = await t.ev(() => {
				const r = window.__lat
					.slice(1)
					.map((x) => x.afterPaint)
					.filter((x) => x != null);
				window.__lat = [];
				return r;
			});
			it.metrics.nodeTypingAfterPaint = summary(typing);
			await t.page.keyboard.press("Escape");
			for (let i = 0; i < 5; i++) {
				await t.page.keyboard.press("Tab");
				await t.page.keyboard.type(`子${i}`);
				await t.page.keyboard.press("Escape");
				await t.page.keyboard.press("ArrowLeft");
				await sleep(30);
			}
			const withKids = await t.ev(() => {
				const m = window.proto.surfaces.A.map;
				return m.order.filter((id) => m.info.get(id)?.hasKids).slice(10, 20);
			});
			for (const id of withKids) {
				await m.select(id);
				await t.page.keyboard.press(" ");
				await sleep(20);
				await t.page.keyboard.press(" ");
				await sleep(20);
			}
			const st = await t.ev(() => window.proto.mapStats("A"));
			const lay = st.layouts.slice(before);
			const tree = st.treeMs.slice(before);
			const meas = st.measureMs.slice(before);
			it.metrics.layout = {
				all: summary(lay),
				treeOnly: summary(tree),
				measureOnly: summary(meas),
				firstLayoutMs: +st.layouts[0].toFixed(1),
				renders: summary(st.renders.slice(-lay.length)),
			};
			it.check("导图布局 p95 ≤ 16 ms", summary(lay).p95 <= 16, it.metrics.layout);
			it.metrics.accuracy = await t.ev(() => window.proto.nodeAccuracy("A"));
			it.check(
				"pretext 预测的节点高度和 DOM 一致（误差 ≤ 1 px）",
				it.metrics.accuracy.overH === 0,
				it.metrics.accuracy,
			);
			it.check("页面没有报错", t.errors.length === 0, t.errors);
		} finally {
			await t.close();
		}
		await scale5000(it);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	}
	return it;
}
