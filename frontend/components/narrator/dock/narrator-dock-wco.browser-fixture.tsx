import { AppShell, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { type DockviewApi, DockviewReact, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "../../dockview/theme.css";
import "../../../styles/wco.css";
import "../../../styles/safe-area.css";
import { createRoot } from "react-dom/client";
import { installWcoTracking } from "../../../lib/wco";
import { useWcoTitlebarRows } from "../../../lib/wco-titlebar";
import { bindNarratorDockWco } from "./narrator-dock-wco";

const nativeMatchMedia = window.matchMedia.bind(window);
let overlayMode = true;
let fullscreenMode = false;
const mediaQueries = new Map<string, MediaQueryList>();
window.matchMedia = (query: string) => {
	if (!query.includes("display-mode")) return nativeMatchMedia(query);
	let result = mediaQueries.get(query);
	if (!result) {
		result = Object.defineProperties(new EventTarget(), {
			media: { value: query },
			matches: { get: () => (query.includes("fullscreen") ? fullscreenMode : overlayMode) },
		}) as MediaQueryList;
		mediaQueries.set(query, result);
	}
	return result;
};
const geometry = { x: 0, y: 0, height: 32 };
const overlay = Object.assign(new EventTarget(), {
	visible: true,
	getTitlebarAreaRect: () => geometry,
});
Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay, configurable: true });
installWcoTracking();
document.documentElement.setAttribute("data-nf-authenticated-app-shell", "true");
document.documentElement.style.setProperty("--nf-wco-strip-height", "32px");
document.documentElement.style.setProperty("--nf-wco-inset-right", "140px");

const style = document.createElement("style");
style.textContent = `
	:root {
		--mantine-scale: 1; --mantine-spacing-md: 16px; --mantine-font-size-sm: 14px;
		--mantine-color-body: #242424; --mantine-color-default: #292929;
		--mantine-color-default-hover: #353535; --mantine-color-text: #dedede;
		--mantine-color-dimmed: #999; --mantine-color-default-border: #454545;
		--mantine-color-indigo-6: #748ffc; --mantine-radius-sm: 4px;
		--mantine-shadow-md: 0 4px 12px #0008;
		--nf-wco-strip-height: 32px; --nf-wco-inset-right: 140px;
	}
	html, body, #root { margin: 0; height: 100%; background: #242424; color: #dedede; }
	body { font: 14px sans-serif; overflow: hidden; }
	/* 页面根的负边距抵消 AppShell Main 的 md 内边距，与真实会话页一致。 */
	#fixture-page { position: relative; top: var(--fixture-page-top, 0px); margin: -16px;
		height: calc(100% + 32px - var(--fixture-page-top, 0px)); overflow: hidden; }
	.fixture-panel { height: 100%; display: flex; flex-direction: column; }
	.fixture-header { display: flex; align-items: center; gap: 8px; padding: 8px;
		height: var(--nf-panel-header-height); box-sizing: border-box; flex-shrink: 0;
		border-bottom: 1px solid #454545; }
	.fixture-body { flex: 1; min-height: 0; padding: 16px; box-sizing: border-box; }
	textarea { width: 100%; height: 100%; box-sizing: border-box; color: inherit;
		background: #202020; border: 1px solid #454545; resize: none; }
`;
document.head.appendChild(style);

let api: DockviewApi | undefined;
let binding: { dispose(): void } | undefined;
let avoid = true;

function Panel({ api: panelApi }: IDockviewPanelProps) {
	const chat = panelApi.id === "primary";
	return (
		<div className="fixture-panel" data-fixture-panel={panelApi.id}>
			<div
				className={`fixture-header${chat ? "" : " nf-panel-header"}`}
				data-narrator-header-layout={chat ? "default" : undefined}
			>
				<span>{chat ? "中间会话区（保持不变）" : "右侧工具面板"}</span>
				<button type="button">操作</button>
			</div>
			<div className="fixture-body">
				<textarea aria-label={panelApi.id} defaultValue={`${panelApi.id} 的内容与编辑状态`} />
			</div>
		</div>
	);
}

function Fixture() {
	const ref = useWcoTitlebarRows(true);
	return (
		<div id="fixture-page" ref={ref} data-nf-wco-titlebar>
			<DockviewReact
				className="dockview-theme-narrafork"
				theme={{
					name: "narrafork",
					className: "dockview-theme-narrafork",
					tabGroupIndicator: "none",
				}}
				components={{ panel: Panel }}
				defaultRenderer="always"
				onReady={({ api: readyApi }) => {
					api = readyApi;
					const chat = api.addPanel({ id: "primary", component: "panel", title: "会话" });
					chat.group.header.hidden = true;
					for (let i = 0; i < 8; i++) {
						api.addPanel({
							id: `tool-${i}`,
							component: "panel",
							title: `工具标签 ${i + 1}`,
							position:
								i === 0
									? { referencePanel: chat, direction: "right" }
									: { referencePanel: "tool-0", direction: "within" },
						});
					}
					api.getPanel("tool-0")?.group.api.setSize({ width: 360 });
					if (avoid) binding = bindNarratorDockWco(api, "primary");
				}}
			/>
		</div>
	);
}

export function configure(options: {
	height?: number;
	top?: number;
	x?: number;
	visible?: boolean;
	mode?: boolean;
	fullscreen?: boolean;
	ancestorOverflow?: number;
}) {
	if (options.height !== undefined) {
		geometry.height = options.height;
		document.documentElement.style.setProperty("--nf-wco-strip-height", `${options.height}px`);
	}
	// 页面根上移到标题栏条带：与工作区页把标题栏顶进拖动区是同一种坐标关系。
	if (options.top !== undefined)
		document.documentElement.style.setProperty("--fixture-page-top", `${options.top}px`);
	if (options.ancestorOverflow !== undefined)
		document.documentElement.style.setProperty(
			"--fixture-ancestor-overflow",
			`${options.ancestorOverflow}px`,
		);
	if (options.x !== undefined) geometry.x = options.x;
	if (options.visible !== undefined) overlay.visible = options.visible;
	if (options.mode !== undefined) overlayMode = options.mode;
	if (options.fullscreen !== undefined) fullscreenMode = options.fullscreen;
	for (const media of mediaQueries.values()) media.dispatchEvent(new Event("change"));
	overlay.dispatchEvent(new Event("geometrychange"));
	window.dispatchEvent(new Event("resize"));
}

export function setAvoidance(enabled: boolean) {
	avoid = enabled;
	binding?.dispose();
	binding = enabled && api ? bindNarratorDockWco(api, "primary") : undefined;
}

export function activate(id: string) {
	api?.getPanel(id)?.api.setActive();
}

export function moveTool(id: string, direction: "bottom" | "center") {
	const panel = api?.getPanel(id);
	const reference = api?.getPanel("tool-0");
	if (!panel || !reference) throw new Error("缺少工具面板");
	panel.api.moveTo({ group: reference.group, position: direction });
}

const rect = (element: Element | null | undefined) => {
	if (!element) return null;
	const { top, left, width, height, bottom, right } = element.getBoundingClientRect();
	return { top, left, width, height, bottom, right };
};

export function snapshot() {
	const panel = (id: string) => {
		const value = api?.getPanel(id);
		const element = value?.view.content.element;
		const tabs = value?.group.element.querySelector<HTMLElement>(".dv-tabs-and-actions-container");
		return {
			group: rect(value?.group.element),
			content: rect(element),
			header: rect(element?.querySelector(".fixture-header")),
			input: rect(element?.querySelector("textarea")),
			inputValue: element?.querySelector("textarea")?.value,
			inputScrollTop: element?.querySelector("textarea")?.scrollTop,
			tabs: rect(tabs),
			activeTab: rect(tabs?.querySelector(".dv-tab.dv-active-tab")),
			tabViewport: rect(tabs?.querySelector(".dv-scrollable")),
			paddingRight: tabs ? getComputedStyle(tabs).paddingRight : null,
			marked: value?.group.element.hasAttribute("data-nf-wco-below-controls"),
		};
	};
	const popup = document.querySelector(".dv-tabs-overflow-container");
	const popupRect = popup?.getBoundingClientRect();
	return {
		ready: Boolean(api),
		primary: panel("primary"),
		tool: panel("tool-0"),
		otherTool: panel("tool-7"),
		activeTool: api?.getPanel("tool-0")?.group.activePanel?.id,
		ancestorScroll: [
			document.documentElement,
			document.body,
			document.getElementById("root"),
			document.querySelector(".nf-app-shell-main"),
			document.getElementById("fixture-page"),
		].map((element) => ({ top: element?.scrollTop ?? 0, left: element?.scrollLeft ?? 0 })),
		popup: rect(popup),
		// 取弹层中心命中：靠左上角会落到分组标题等空白处，与遮挡无关。
		popupHit: popupRect
			? Boolean(
					popup?.contains(
						document.elementFromPoint(
							popupRect.x + popupRect.width / 2,
							popupRect.y + popupRect.height / 2,
						),
					),
				)
			: false,
		overflow: rect(document.querySelector(".dv-tabs-overflow-dropdown-root")),
	};
}

const root = document.getElementById("root");
if (!root) throw new Error("缺少夹具根节点");
createRoot(root).render(
	<MantineProvider defaultColorScheme="dark">
		<AppShell
			className="nf-app-shell"
			layout="alt"
			header={{ height: 0 }}
			navbar={{ width: 80, breakpoint: "sm" }}
			padding="md"
		>
			<AppShell.Navbar />
			<AppShell.Main className="nf-app-shell-main">
				<div className="nf-wco-top-gap" />
				<div className="nf-wco-main-strip" />
				<Fixture />
				<div aria-hidden style={{ height: "var(--fixture-ancestor-overflow, 0px)" }} />
			</AppShell.Main>
		</AppShell>
	</MantineProvider>,
);
