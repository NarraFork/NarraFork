import { describe, expect, test } from "bun:test";
import type { DockviewApi } from "dockview-react";
import { parseHTML } from "linkedom";
import { WCO_BELOW_CONTROLS_ATTRIBUTE } from "../../../lib/wco-titlebar";
import { bindNarratorDockWco } from "./narrator-dock-wco";

function realm(top = 0) {
	const { document, window: domWindow } = parseHTML("<html><body></body></html>");
	const frames = new Map<number, FrameRequestCallback>();
	let sequence = 0;
	const events = () => {
		const listeners = new Set<() => void>();
		return {
			addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
			removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
			emit: () => {
				for (const listener of listeners) listener();
			},
		};
	};
	const mode = { matches: false, ...events() };
	const desktop = { matches: true, ...events() };
	const fullscreen = { matches: false, ...events() };
	const geometry = { x: 0, y: 0, height: 32 };
	const overlay = { visible: true, getTitlebarAreaRect: () => geometry, ...events() };
	const window = {
		navigator: { windowControlsOverlay: overlay },
		matchMedia: (query: string) =>
			query.includes("48em") ? desktop : query.includes("fullscreen") ? fullscreen : mode,
		MutationObserver: domWindow.MutationObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++sequence, callback);
			return sequence;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		...events(),
	};
	Object.defineProperty(document, "defaultView", { value: window });
	const layout = events();
	const active = events();
	const group = (left: number, right: number, groupTop = top) => {
		const element = document.createElement("div");
		element.innerHTML = '<div class="dv-tabs-and-actions-container"></div>';
		document.body.appendChild(element);
		const rect = { top: groupTop, left, right, width: right - left, bottom: 800 };
		element.getBoundingClientRect = () => rect as DOMRect;
		const content = document.createElement("div");
		content.className = "dv-render-overlay";
		const panelElement = document.createElement("div");
		content.appendChild(panelElement);
		document.body.appendChild(content);
		let layouts = 0;
		const result = {
			element,
			panels: [{ view: { content: { element: panelElement } } }],
			api: { location: { type: "grid" }, width: right - left, height: 800 - groupTop },
			layout: () => layouts++,
		};
		return { result, element, content, rect, layoutCount: () => layouts };
	};
	const primary = group(100, 900);
	const right = group(900, 1400);
	const lower = group(900, 1400, 400);
	const left = group(0, 100);
	const groupList = [primary, right, lower, left].map(({ result }) => result);
	const api = {
		getPanel: () => ({ group: primary.result }),
		groups: groupList,
		onDidLayoutChange: (listener: () => void) => {
			layout.addEventListener("layout", listener);
			return { dispose: () => layout.removeEventListener("layout", listener) };
		},
		onDidActivePanelChange: (listener: () => void) => {
			active.addEventListener("active", listener);
			return { dispose: () => active.removeEventListener("active", listener) };
		},
	} as unknown as DockviewApi;
	const flush = () => {
		let remaining = 10;
		while (frames.size > 0 && remaining-- > 0) {
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback(0);
		}
		expect(frames.size).toBe(0);
	};
	const binding = bindNarratorDockWco(api, "primary");
	return {
		api,
		binding,
		document,
		primary,
		right,
		lower,
		left,
		mode,
		desktop,
		fullscreen,
		overlay,
		geometry,
		layout,
		active,
		frames,
		flush,
	};
}

const inset = (element: HTMLElement) => element.style.getPropertyValue("--nf-dock-wco-inset");

describe("右侧工具组 WCO 向下避让", () => {
	test("仅修改右侧顶部组及其独立内容层，中间、左侧和下方组不变", () => {
		const r = realm();
		try {
			expect(inset(r.right.element)).toBe("33px");
			expect(r.right.content.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(true);
			for (const group of [r.primary, r.left, r.lower]) {
				expect(inset(group.element)).toBeUndefined();
				expect(group.element.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
				expect(group.content.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
				expect(group.layoutCount()).toBe(0);
			}
		} finally {
			r.binding.dispose();
		}
	});

	test("补偿负坐标；缩放只重排受影响的工具组", () => {
		const r = realm(-32);
		try {
			for (const height of [32, 40, 48, 36]) {
				r.geometry.height = height;
				r.overlay.emit();
				r.flush();
				expect(inset(r.right.element)).toBe(`${height + 33}px`);
				expect(r.primary.layoutCount()).toBe(0);
			}
			r.layout.emit();
			r.active.emit();
			r.overlay.emit();
			expect(r.frames.size).toBe(1);
			const previous = r.right.layoutCount();
			r.flush();
			expect(r.right.layoutCount()).toBe(previous);
		} finally {
			r.binding.dispose();
		}
	});

	test("WCO 模式中的零几何过渡和会话重挂载保留有效高度", () => {
		const r = realm(-32);
		r.mode.matches = true;
		r.geometry.height = 0;
		r.overlay.visible = false;
		r.overlay.emit();
		r.flush();
		expect(inset(r.right.element)).toBe("65px");
		r.binding.dispose();
		const next = bindNarratorDockWco(r.api, "primary");
		try {
			expect(inset(r.right.element)).toBe("65px");
		} finally {
			next.dispose();
		}
	});

	test("退出 WCO、窄窗口、全屏和左侧按钮都撤销局部避让", () => {
		const r = realm();
		try {
			const cases = [
				() => {
					r.overlay.visible = false;
				},
				() => {
					r.desktop.matches = false;
				},
				() => {
					r.fullscreen.matches = true;
				},
				() => {
					r.geometry.x = 78;
				},
			];
			for (const change of cases) {
				r.overlay.visible = true;
				r.desktop.matches = true;
				r.fullscreen.matches = false;
				r.geometry.x = 0;
				r.overlay.emit();
				r.flush();
				expect(inset(r.right.element)).toBe("33px");
				change();
				r.overlay.emit();
				r.flush();
				expect(r.right.element.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
				expect(r.right.content.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
			}
		} finally {
			r.binding.dispose();
		}
	});

	test("拖成浮动组或移到下方会恢复原布局", () => {
		const r = realm();
		try {
			r.right.result.api.location.type = "floating";
			r.layout.emit();
			r.flush();
			expect(r.right.element.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
			r.right.result.api.location.type = "grid";
			r.right.rect.top = 200;
			r.layout.emit();
			r.flush();
			expect(r.right.element.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
		} finally {
			r.binding.dispose();
		}
	});

	test("释放监听、取消排队帧并清除所有局部标记", () => {
		const r = realm();
		r.layout.emit();
		expect(r.frames.size).toBe(1);
		r.binding.dispose();
		expect(r.frames.size).toBe(0);
		for (const group of [r.primary, r.right, r.lower, r.left]) {
			expect(group.element.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
			expect(group.content.hasAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE)).toBe(false);
		}
		r.overlay.emit();
		r.layout.emit();
		r.active.emit();
		expect(r.frames.size).toBe(0);
	});
});

describe("局部避让样式", () => {
	test("只给被标记的工具组留出顶部空间，并保留页签的滚动留白", async () => {
		const css = await Bun.file(new URL("../../../styles/wco.css", import.meta.url)).text();
		const rule = (selector: string) => css.match(new RegExp(`${selector} \\{[^}]*\\}`))?.[0] ?? "";
		// 溢出菜单的 scrollIntoView() 会滚动父页面，没有这行会把中间标题顶出窗口。
		expect(
			rule(
				":root \\.dv-groupview\\[data-nf-wco-below-controls\\] \\.dv-tabs-container > \\.dv-tab",
			),
		).toContain("scroll-margin-top: var(--nf-dock-wco-inset)");
		expect(rule(":root \\.dv-groupview\\[data-nf-wco-below-controls\\]")).toContain(
			"padding-top: var(--nf-dock-wco-inset)",
		);
		// 未标记的主会话组绝不能落到这条规则里。
		expect(css).toMatch(/data-nf-wco-below-controls/);
		expect(css).not.toMatch(/dv-groupview \{[^}]*padding-top: var\(--nf-dock-wco-inset\)/);
	});
});
