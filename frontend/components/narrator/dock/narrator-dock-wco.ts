import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
import { WCO_ATTRIBUTE, type WcoControlsSide } from "../../../lib/wco";
import { WCO_BELOW_CONTROLS_ATTRIBUTE } from "../../../lib/wco-titlebar";

const INSET_PROPERTY = "--nf-dock-wco-inset";
const EDGE_EPSILON_PX = 1;
const measurements = new WeakMap<Window, { side: WcoControlsSide; bottom: number }>();

interface OverlayGeometry {
	visible: boolean;
	getTitlebarAreaRect(): { x: number; y: number; height: number };
	addEventListener?(type: string, listener: () => void): void;
	removeEventListener?(type: string, listener: () => void): void;
}

/** 只给主会话右侧碰到窗口按钮行的工具组留出顶部空间。 */
export function bindNarratorDockWco(api: DockviewApi, primaryPanelId: string): { dispose(): void } {
	const document = api.getPanel(primaryPanelId)?.group.element.ownerDocument;
	const window = document?.defaultView;
	if (!document || !window) return { dispose() {} };

	const html = document.documentElement;
	const overlay = (window.navigator as Navigator & { windowControlsOverlay?: OverlayGeometry })
		.windowControlsOverlay;
	const mode = window.matchMedia("(display-mode: window-controls-overlay)");
	const desktop = window.matchMedia("(min-width: 48em)");
	const fullscreen = window.matchMedia("(display-mode: fullscreen)");
	const groups = new Map<HTMLElement, DockviewGroupPanel>();
	const contents = new Set<HTMLElement>();
	const previous = measurements.get(window);
	let lastSide: WcoControlsSide | null = previous?.side ?? null;
	let titlebarBottom = previous?.bottom ?? 40;
	let frame: number | null = null;
	let disposed = false;

	const update = () => {
		const visible = overlay?.visible === true;
		if (visible) {
			try {
				const rect = overlay.getTitlebarAreaRect();
				// 切换标签期间几何可能暂时为零，跨会话重挂载也沿用有效测量。
				if (Number.isFinite(rect.height) && rect.height > 0) {
					lastSide = rect.x > 0 ? "left" : "right";
					titlebarBottom = Math.max(0, rect.y || 0) + rect.height;
					measurements.set(window, { side: lastSide, bottom: titlebarBottom });
				}
			} catch {
				lastSide ??= "right";
			}
		}
		const side = lastSide ?? html.getAttribute(WCO_ATTRIBUTE) ?? "right";
		const enabled =
			desktop.matches &&
			!fullscreen.matches &&
			!document.fullscreenElement &&
			side === "right" &&
			(visible || mode.matches || html.getAttribute(WCO_ATTRIBUTE) === "right");
		const primary = api.getPanel(primaryPanelId)?.group;
		const primaryRect = primary?.element.getBoundingClientRect();
		const insets = new Map<DockviewGroupPanel, number>();
		if (enabled && primaryRect) {
			for (const group of api.groups) {
				if (group === primary || group.api.location.type !== "grid") continue;
				const rect = group.element.getBoundingClientRect();
				if (
					rect.width > 0 &&
					rect.left >= primaryRect.right - EDGE_EPSILON_PX &&
					rect.top < titlebarBottom + 1 &&
					rect.bottom > titlebarBottom
				) {
					// 以视口坐标计算，不能假定组的 top 为零。
					insets.set(group, titlebarBottom + 1 - rect.top);
				}
			}
		}

		const changed = new Set<DockviewGroupPanel>();
		for (const [element, group] of groups) {
			if (insets.has(group)) continue;
			element.removeAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE);
			element.style.removeProperty(INSET_PROPERTY);
			groups.delete(element);
			if (api.groups.includes(group)) changed.add(group);
		}
		const nextContents = new Set<HTMLElement>();
		for (const [group, inset] of insets) {
			const element = group.element;
			const value = `${inset}px`;
			if (element.style.getPropertyValue(INSET_PROPERTY) !== value || !groups.has(element)) {
				element.style.setProperty(INSET_PROPERTY, value);
				element.setAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE, "");
				groups.set(element, group);
				changed.add(group);
			}
			// always-rendered 内容不在 group 内，须独立排除标题栏横向避让。
			for (const panel of group.panels) {
				const content = panel.view.content.element.closest<HTMLElement>(".dv-render-overlay");
				if (!content) continue;
				nextContents.add(content);
				if (!contents.has(content)) content.setAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE, "");
			}
		}
		for (const content of contents) {
			if (!nextContents.has(content)) content.removeAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE);
		}
		contents.clear();
		for (const content of nextContents) contents.add(content);
		// Dockview 根据内容锚点重定位独立 overlay，只重新布局受影响的工具组。
		for (const group of changed) group.layout(group.api.width, group.api.height);
	};

	const schedule = () => {
		if (disposed || frame !== null) return;
		frame = window.requestAnimationFrame(() => {
			frame = null;
			update();
		});
	};
	const subscriptions = [api.onDidLayoutChange(schedule), api.onDidActivePanelChange(schedule)];
	const mutations = new window.MutationObserver(schedule);
	mutations.observe(html, { attributes: true, attributeFilter: [WCO_ATTRIBUTE] });
	overlay?.addEventListener?.("geometrychange", schedule);
	for (const media of [mode, desktop, fullscreen]) media.addEventListener("change", schedule);
	window.addEventListener("resize", schedule);
	document.addEventListener("fullscreenchange", schedule);
	update();

	return {
		dispose() {
			disposed = true;
			if (frame !== null) window.cancelAnimationFrame(frame);
			for (const subscription of subscriptions) subscription.dispose();
			mutations.disconnect();
			overlay?.removeEventListener?.("geometrychange", schedule);
			for (const media of [mode, desktop, fullscreen])
				media.removeEventListener("change", schedule);
			window.removeEventListener("resize", schedule);
			document.removeEventListener("fullscreenchange", schedule);
			for (const element of groups.keys()) {
				element.removeAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE);
				element.style.removeProperty(INSET_PROPERTY);
			}
			for (const content of contents) content.removeAttribute(WCO_BELOW_CONTROLS_ATTRIBUTE);
			groups.clear();
			contents.clear();
		},
	};
}
