// 验收 7：性能。展开 2000 个块的页：输入延迟（按键到渲染）、滚动、内存。
// 无头 Chromium（无 GPU，帧率 60Hz 节拍），数字是相对值；桌面 Chrome 真机要另测。
import { Item, open, sleep } from "./lib.mjs";

const pct = (a, p) => {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
};
const summary = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: pct(a, 100) });

async function heap(t) {
	await t.cdp.send("HeapProfiler.enable");
	for (let i = 0; i < 3; i++) await t.cdp.send("HeapProfiler.collectGarbage");
	const h = await t.cdp.send("Runtime.getHeapUsage");
	await t.cdp.send("Performance.enable");
	const m = await t.cdp.send("Performance.getMetrics");
	const get = (k) => m.metrics.find((x) => x.name === k)?.value;
	return {
		heapMB: +(h.usedSize / 1048576).toFixed(2),
		nodes: get("Nodes"),
		layoutObjects: get("LayoutObjects"),
	};
}

/** 在页面里装测量：每个 keydown 记录到下一帧（rAF）和这一帧画完（rAF 后的 MessageChannel）的时间。 */
async function instrument(t) {
	await t.ev(() => {
		const w = window;
		w.__lat = [];
		w.__disp = [];
		const v = w.proto.views.A;
		const orig = v.dispatch.bind(v);
		v.dispatch = (tr) => {
			const a = performance.now();
			orig(tr);
			w.__disp.push(performance.now() - a);
		};
		v.pm.setProps({ dispatchTransaction: (tr) => v.dispatch(tr) });
		const ch = new MessageChannel();
		let pending = [];
		ch.port1.onmessage = () => {
			const now = performance.now();
			for (const p of pending) p.afterPaint = now - p.t0;
			pending = [];
		};
		v.pm.dom.addEventListener(
			"keydown",
			() => {
				const rec = { t0: performance.now() };
				w.__lat.push(rec);
				requestAnimationFrame(() => {
					rec.toFrame = performance.now() - rec.t0;
					pending.push(rec);
					ch.port2.postMessage(0);
				});
			},
			true,
		);
		w.__slow = [];
		try {
			new PerformanceObserver((list) => {
				for (const e of list.getEntries())
					if (e.name.startsWith("key") || e.name === "beforeinput" || e.name === "input")
						w.__slow.push({ name: e.name, d: e.duration });
			}).observe({ type: "event", buffered: true, durationThreshold: 16 });
		} catch {}
	});
}

async function takeLat(t) {
	await sleep(100);
	return t.ev(() => {
		const r = {
			toFrame: window.__lat.map((x) => x.toFrame).filter((x) => x != null),
			afterPaint: window.__lat.map((x) => x.afterPaint).filter((x) => x != null),
			dispatch: window.__disp.slice(),
			slow: window.__slow.slice(),
		};
		window.__lat = [];
		window.__disp = [];
		window.__slow = [];
		return r;
	});
}

async function scenario(n, opts = { full: true }) {
	const t = await open(`?mode=perf&n=${n}`, { viewport: { width: 1280, height: 900 } });
	const m = {};
	try {
		m.initialRenderMs = +(await t.ev(() => window.initialRenderMs)).toFixed(1);
		m.blocks = (await t.ev(() => window.proto.blockIds("A"))).length;
		m.memory = await heap(t);
		if (!opts.full) return m;
		await instrument(t);
		const ids = await t.ev(() => window.proto.blockIds("A"));
		const mid = ids[Math.floor(ids.length / 2)];
		const len = (await t.viewText("A", mid)).length;
		await t.focus("A", mid, len);
		await t.page.evaluate(() =>
			document.querySelector(".ProseMirror-focused")?.scrollIntoView({ block: "center" }),
		);
		await sleep(200);
		await takeLat(t);
		// 打字：中文和英文混合，每键间隔 30ms
		await t.page.keyboard.type(
			"abc大纲编辑器defghijklmnopq块模型是真相rstuvwxyz0123456789".repeat(2),
			{ delay: 30 },
		);
		const typing = await takeLat(t);
		m.typing = {
			toFrame: summary(typing.toFrame),
			afterPaint: summary(typing.afterPaint),
			dispatch: summary(typing.dispatch),
			// Event Timing API（按 8ms 取整，含等下一帧的时间；只收 ≥16ms 的条目）
			eventTimingMax: typing.slow.length ? Math.max(...typing.slow.map((x) => x.d)) : 0,
			eventTimingOver50: typing.slow.filter((x) => x.d > 50).length,
		};
		// Enter（结构操作：全量 reconcile）
		for (let i = 0; i < 20; i++) {
			await t.page.keyboard.press("Enter");
			await sleep(40);
		}
		const enter = await takeLat(t);
		m.enter = { afterPaint: summary(enter.afterPaint), dispatch: summary(enter.dispatch) };
		// Tab / Shift-Tab
		for (let i = 0; i < 10; i++) {
			await t.page.keyboard.press("Tab");
			await sleep(40);
			await t.page.keyboard.press("Shift+Tab");
			await sleep(40);
		}
		const tab = await takeLat(t);
		m.tab = { afterPaint: summary(tab.afterPaint), dispatch: summary(tab.dispatch) };
		// Backspace 合并（块首）
		for (let i = 0; i < 10; i++) {
			await t.page.keyboard.press("Backspace");
			await sleep(40);
		}
		const bs = await takeLat(t);
		m.backspaceMerge = { afterPaint: summary(bs.afterPaint), dispatch: summary(bs.dispatch) };
		// 远端修改：agent 写别的块 → 本地重新投影的耗时，以及「服务端写入 → DOM 里出现」
		const remote = await t.ev(async () => {
			const p = window.proto;
			const v = p.views.A;
			const r = p.agentRead("perf", "P1");
			const out = [];
			const s0 = { syncs: v.stats.syncs, ms: v.stats.syncMs };
			for (let i = 0; i < 30; i++) {
				const b = r.blocks[(i * 67) % r.blocks.length];
				const mark = `R${i}R`;
				const t0 = performance.now();
				p.agentWrite("perf", "P1", [{ t: "text", id: b.id, content: `${b.content}${mark}` }]);
				await new Promise((res) => {
					const check = () => {
						if (v.pm.dom.textContent.includes(mark)) res(0);
						else setTimeout(check, 0);
					};
					check();
				});
				out.push(performance.now() - t0);
				r.blocks[(i * 67) % r.blocks.length] = { ...b, content: `${b.content}${mark}` };
			}
			return {
				toDom: out,
				syncMs: (v.stats.syncMs - s0.ms) / Math.max(1, v.stats.syncs - s0.syncs),
			};
		});
		m.remote = { toDom: summary(remote.toDom), avgSyncMs: +remote.syncMs.toFixed(2) };
		// 在别人持续改动时打字
		await t.ev(() => {
			const p = window.proto;
			const r = p.agentRead("bg", "P1");
			let i = 0;
			window.__bg = setInterval(() => {
				const b = r.blocks[(i++ * 31) % r.blocks.length];
				p.agentWrite("bg", "P1", [{ t: "text", id: b.id, content: `${b.content}·` }]);
				b.content = `${b.content}·`;
			}, 50);
		});
		await takeLat(t);
		await t.page.keyboard.type("concurrent typing 同时有人在改别的块".repeat(2), { delay: 30 });
		const busy = await takeLat(t);
		await t.ev(() => clearInterval(window.__bg));
		m.typingWhileRemote20Hz = {
			afterPaint: summary(busy.afterPaint),
			dispatch: summary(busy.dispatch),
		};
		// 滚动：每帧滚 300px 到底，记录帧间隔
		const scroll = await t.ev(async () => {
			const el = document.scrollingElement;
			el.scrollTop = 0;
			await new Promise((r) => requestAnimationFrame(r));
			const deltas = [];
			let last = performance.now();
			const t0 = last;
			while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
				el.scrollTop += 300;
				await new Promise((r) => requestAnimationFrame(r));
				const now = performance.now();
				deltas.push(now - last);
				last = now;
			}
			const jump0 = performance.now();
			el.scrollTop = 0;
			await new Promise((r) => requestAnimationFrame(r));
			return { deltas, total: last - t0, height: el.scrollHeight, jump: performance.now() - jump0 };
		});
		m.scroll = {
			pageHeightPx: scroll.height,
			frames: scroll.deltas.length,
			frameMs: summary(scroll.deltas),
			framesOver50ms: scroll.deltas.filter((d) => d > 50).length,
			totalMs: +scroll.total.toFixed(0),
			jumpToTopMs: +scroll.jump.toFixed(1),
		};
		m.memoryAfter = await heap(t);
		// 首次编辑才建 Y.Text（设计）vs 会话开始就全建：耗时、编码大小、堆增量
		const before = await heap(t);
		m.eagerInit = await t.ev(() => window.proto.measureEagerInit("P1"));
		const after = await heap(t);
		m.eagerInit.heapDeltaMB = +(after.heapMB - before.heapMB).toFixed(2);
		await t.ev(() => {
			window.__eager = null;
		});
		m.errors = t.errors.length;
	} finally {
		await t.close();
	}
	return m;
}

export async function run() {
	const it = new Item(7, "性能（2000 块）");
	try {
		const base = await scenario(1, { full: false });
		const m2000 = await scenario(2000);
		const m500 = await scenario(500);
		const m5000 = await scenario(5000, { full: false });
		it.metrics = { baseline: base, n2000: m2000, n500: m500, n5000: m5000 };
		const per = ((m2000.memory.heapMB - base.memory.heapMB) * 1024) / 2000;
		it.metrics.heapKBPerBlock = +per.toFixed(2);
		it.check("7 2000 块全部展开", m2000.blocks === 2000, m2000.blocks);
		it.check("7 打字：按键到画完 p95 < 50ms", m2000.typing.afterPaint.p95 < 50, m2000.typing);
		it.check("7 Enter（结构操作）：p95 < 100ms", m2000.enter.afterPaint.p95 < 100, m2000.enter);
		it.check(
			"7 别人每秒改 20 次时打字：p95 < 50ms",
			m2000.typingWhileRemote20Hz.afterPaint.p95 < 50,
			m2000.typingWhileRemote20Hz,
		);
		it.check(
			"7 滚动：超过 50ms 的帧不超过 2%",
			m2000.scroll.framesOver50ms <= Math.ceil(m2000.scroll.frames * 0.02),
			m2000.scroll,
		);
		it.check("7 页面没有报错", m2000.errors === 0);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	}
	return it;
}
