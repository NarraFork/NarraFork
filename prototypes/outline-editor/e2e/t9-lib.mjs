// PR1（导图与聚焦）验收脚本的公共工具。
import { sleep } from "./lib.mjs";

export const pct = (a, p) => {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
};
export const summary = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: pct(a, 100) });

/** 编辑面的若干便捷操作 */
export function surface(t, k = "A") {
	const ev = (f, ...a) => t.page.evaluate(f, ...a);
	return {
		setView: (kind) => ev(([k, v]) => window.proto.setView(k, v), [k, kind]),
		setLayout: (dir) => ev(([k, d]) => window.proto.setLayout(k, d), [k, dir]),
		focusBlock: (id) => ev(([k, id]) => window.proto.focusBlock(k, id), [k, id]),
		state: () => ev((k) => window.proto.viewState(k), k),
		map: () => ev((k) => window.proto.mapState(k), k),
		mapTree: () => ev((k) => window.proto.mapTree(k), k),
		select: (id) => ev(([k, id]) => window.proto.mapSelect(k, id), [k, id]),
		edit: (id, caret) => ev(([k, id, c]) => window.proto.mapEdit(k, id, c), [k, id, caret]),
		flush: () => ev((k) => window.proto.mapFlush(k), k),
		log: () => ev((k) => window.proto.transitionLog(k), k),
		anchorScreen: (id) => ev(([k, id]) => window.proto.anchorScreen(k, id), [k, id]),
		nodeRect: (id) => ev(([k, id]) => window.proto.nodeRect(k, id), [k, id]),
		/** 等动画结束 */
		settle: async () => {
			for (let i = 0; i < 200; i++) {
				if (!(await ev((k) => window.proto.animating(k), k))) return;
				await sleep(20);
			}
			throw new Error("动画没有结束");
		},
		/** 编辑区里的焦点在哪：map-stage / map-editor / outline / 其他 */
		focusWhere: () =>
			ev((k) => {
				const s = window.proto.surfaces[k];
				const a = document.activeElement;
				if (a === s.map.stage) return "map-stage";
				if (s.map.editing && s.map.editing.view.pm.dom === a) return "map-editor";
				if (s.outline.pm.dom === a) return "outline";
				return a?.className ?? String(a);
			}, k),
	};
}

/** 服务端的块树（不带 id：两次独立运行里新块的 id 不同） */
export const tree = (t, pageId = "P1") => t.page.evaluate((p) => window.proto.blockTree(p), pageId);
