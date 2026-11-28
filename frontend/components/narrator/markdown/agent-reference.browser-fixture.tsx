import "@mantine/core/styles.css";
import "dockview-react/dist/styles/dockview.css";
import "../../dockview/theme.css";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { ensureTypographyCssVars } from "@frontend/lib/typography-css-vars";
import { MantineProvider } from "@mantine/core";
import { agentReferenceMetrics } from "@shared/pretext-layout/agent-reference-flow";
import { DEFAULT_TYPOGRAPHY, setTypography } from "@shared/pretext-layout/typography";
import {
	type AnyRouter,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useParams,
} from "@tanstack/react-router";
import { type DockviewApi, DockviewReact, type IDockviewPanelProps } from "dockview-react";
import { createInstance } from "i18next";
import { useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { dockPanelId, subagentDockPanelId } from "../dock/dock-panel-types";
import { NarratorDockProvider, useNarratorDockContext } from "../dock/NarratorDockContext";
import { useSubagentSessionOpener } from "../interaction/use-subagent-session-opener";
import { measureMarkdown } from "../vlist/measure/measure-markdown";
import { RenderMarkdown } from "../vlist/render/RenderMarkdown";
import { AgentReferenceOpenerContext } from "./AgentReferenceLink";
import { MarkdownContent } from "./MarkdownContent";

// Test-only manager transport: exercise the real reference store without a backend or socket.
const listeners = new Map<number, (event: Record<string, unknown>) => void>();
const subscriptions: Array<{ ids: string[]; kind: string }> = [];
let nextHandle = 0;
narratorWSManager.addListener = (_options, callback) => {
	const _id = ++nextHandle;
	listeners.set(_id, callback);
	return { _id };
};
narratorWSManager.removeListener = (handle) => {
	listeners.delete(handle._id);
};
narratorWSManager.subscribe = (ids, options) => {
	subscriptions.push({ ids: [...ids], kind: options?.kind ?? "panel" });
	return { _id: ++nextHandle, _narratorIds: ids, _kind: options?.kind ?? "panel" };
};
narratorWSManager.unsubscribe = () => {};
narratorWSManager.onConnectionChange = () => () => {};

const i18n = createInstance();
await i18n.init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	defaultNS: "narrator",
	resources: { "zh-CN": { narrator: zhNarrator, common: zhCommon } },
	react: { useSuspense: false },
});
ensureTypographyCssVars();

const style = document.createElement("style");
style.textContent = `
	html, body, #root { margin: 0; height: 100%; background: var(--mantine-color-body); }
	body { overflow: hidden; }
	.fixture-main { height: 100%; overflow: auto; padding: 24px; box-sizing: border-box; }
	.fixture-main > h1 { font-size: 18px; margin: 0 0 24px; }
	.fixture-cases { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
	.fixture-column { max-width: 100%; }
	.fixture-column > h2 { font-size: 14px; margin: 0 0 16px; color: var(--mantine-color-dimmed); }
	.fixture-sample { margin-bottom: 24px; }
	.fixture-subagent { padding: 24px; line-height: 1.8; }
	.fixture-subagent h2 { font-size: 18px; margin-top: 0; }
`;
document.head.append(style);

export const CHILD_ID = "Child_A";
export const LONG_TITLE =
	"核验 子代理引用 与 布局 across wrapped lines 检查状态切换和桌面右侧面板打开保证极长任务标题完整可访问";
export const AFTER_TEXT = "后续。";
const longReference =
	"[核验 **子代理引用** 与 `布局` across wrapped lines 检查状态切换和桌面右侧面板打开保证极长任务标题完整可访问](nf-agent://open?id=Child_A)";
const cases = [
	{ kind: "long", text: `前文请查看 ${longReference}，后文保持位置。`, references: 1 },
	{ kind: "alignment", text: "对齐 [对齐](nf-agent://open?id=Child_A) 对齐", references: 1 },
	{
		kind: "adjacent",
		text: "[核验引用布局](nf-agent://open?id=Child_A)[补充浏览器测试](nf-agent://open?id=Child_A) 完毕。",
		references: 2,
	},
	{
		kind: "rich",
		text: "**普通正文粗体** 与 `outsideCode` 不受影响。[同步验收结论](nf-agent://open?id=Child_A)",
		references: 1,
	},
	{ kind: "list", text: `- 上级任务\n  - ${longReference}，列表后文。`, references: 1 },
	{ kind: "table", text: `| 任务 |\n| --- |\n| ${longReference} |`, references: 1 },
	{ kind: "heading", text: `### ${longReference}`, references: 1 },
	{ kind: "control-paragraph", text: "正文。", references: 0 },
	{ kind: "control-list", text: "- 上级任务\n  - 列表正文。", references: 0 },
	{
		kind: "public",
		text: "公开分享 [只读子代理引用](nf-agent://open?id=Public_Only)，不应订阅。",
		references: 1,
	},
] as const;
let options = {
	width: 270,
	streaming: false,
	dock: false,
	gallery: false,
	scheme: "dark" as "dark" | "light",
	fontScalePercent: 100,
	lineHeightScalePercent: 100,
	letterSpacingPercent: 0,
};
let dockApi: DockviewApi | undefined;
const opened: string[] = [];

function Sample({
	renderer,
	kind,
	text,
	references,
}: {
	renderer: "flow" | "prepared";
	kind: string;
	text: string;
	references: number;
}) {
	const galleryText: Record<string, string> = {
		long: "请查看 [核验子代理引用布局与桌面面板打开，并补充深浅主题和移动端浏览器回归测试](nf-agent://open?id=Child_A)，继续跟进执行进展。",
		adjacent:
			"[核验引用布局](nf-agent://open?id=Child_A)[补充浏览器测试](nf-agent://open?id=Child_A) 已完成。",
		rich: "已完成 **布局与交互核验**，请查看 [同步验收结论](nf-agent://open?id=Child_A)。",
	};
	const content = options.gallery ? (galleryText[kind] ?? text) : `${text}\n\n${AFTER_TEXT}`;
	const measured = renderer === "prepared" ? measureMarkdown(content, options.width) : null;
	return (
		<div
			className="fixture-sample nf-type-scope"
			data-case={`${renderer}-${kind}`}
			data-reference-count={references}
			data-measured-height={measured?.height}
			style={{
				position: "relative",
				width: options.width,
				height: measured?.height,
			}}
		>
			{measured ? (
				<RenderMarkdown measured={measured} animateStreaming={options.streaming} />
			) : (
				<MarkdownContent text={content} streaming={options.streaming} />
			)}
		</div>
	);
}

function Cases({ open }: { open: (id: string) => void }) {
	return (
		<main className="fixture-main">
			<h1>{options.gallery ? "任务协作进展" : "子代理引用浏览器验收"}</h1>
			<div className="fixture-cases">
				{(["flow", "prepared"] as const).map((renderer) => (
					<section className="fixture-column" key={renderer}>
						<h2>{renderer === "flow" ? "普通 Markdown" : "预排版 Markdown"}</h2>
						{cases
							.filter(
								(sample) => !options.gallery || ["long", "adjacent", "rich"].includes(sample.kind),
							)
							.map((sample) => (
								<AgentReferenceOpenerContext.Provider
									key={sample.kind}
									value={sample.kind === "public" ? null : open}
								>
									<Sample renderer={renderer} {...sample} />
								</AgentReferenceOpenerContext.Provider>
							))}
					</section>
				))}
			</div>
		</main>
	);
}

function ChatPanel() {
	const dock = useNarratorDockContext();
	const sessionOpen = useSubagentSessionOpener(dock?.openSubagentPanel);
	const open = useCallback(
		(id: string) => {
			opened.push(id);
			sessionOpen(id);
		},
		[sessionOpen],
	);
	return <Cases open={open} />;
}

function SubagentPanel({ params, api }: IDockviewPanelProps<{ subagentNarratorId: string }>) {
	useEffect(() => api.setTitle("核验引用布局"), [api]);
	return (
		<div className="fixture-subagent" data-child-panel={params.subagentNarratorId}>
			<h2>核验引用布局</h2>
			<p>已完成深浅主题、状态切换与移动端打开方式的核验。</p>
			<p>长任务标题保留全文，行内引用使用单个胶囊，便于继续查看执行进展。</p>
		</div>
	);
}

function Dock() {
	const dock = useNarratorDockContext();
	if (!dock) throw new Error("缺少真实 Dock provider");
	return (
		<DockviewReact
			className="dockview-theme-narrafork"
			components={{ chat: ChatPanel, subagent: SubagentPanel }}
			defaultRenderer="always"
			onReady={({ api }) => {
				dockApi = api;
				dock.apiRef.current = api;
				api.addPanel({
					id: dockPanelId("chat"),
					component: "chat",
					title: "主会话",
					params: { panelType: "chat" },
				});
			}}
		/>
	);
}

function RouteTarget() {
	const { narratorId } = useParams({ strict: false });
	return <div data-route-target={narratorId}>已路由至子代理会话</div>;
}

function Scene() {
	return (
		<>
			{options.dock ? (
				<NarratorDockProvider narratorId="Primary">
					<Dock />
				</NarratorDockProvider>
			) : (
				<ChatPanel />
			)}
			<Outlet />
		</>
	);
}

const root = createRoot(document.getElementById("root") as HTMLElement);
let router: AnyRouter;

export async function render(next: Partial<typeof options> = {}) {
	options = { ...options, ...next };
	flushSync(() => root.render(null));
	setTypography({
		...DEFAULT_TYPOGRAPHY,
		fontScalePercent: options.fontScalePercent,
		lineHeightScalePercent: options.lineHeightScalePercent,
		letterSpacingPercent: options.letterSpacingPercent,
	});
	dockApi = undefined;
	opened.length = 0;
	subscriptions.length = 0;
	const rootRoute = createRootRoute({ component: Scene });
	const childRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/narrators/$narratorId",
		component: RouteTarget,
	});
	router = createRouter({
		routeTree: rootRoute.addChildren([childRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	flushSync(() =>
		root.render(
			<MantineProvider forceColorScheme={options.scheme}>
				<I18nextProvider i18n={i18n}>
					<RouterProvider router={router} />
				</I18nextProvider>
			</MantineProvider>,
		),
	);
}

export function status(status: string, substatus: string[] = [], snapshot = false) {
	const data = { narratorId: CHILD_ID, status, substatus };
	flushSync(() => {
		for (const callback of listeners.values()) {
			callback(
				snapshot
					? { type: "list_state_snapshot", items: [data] }
					: { type: "status_change", ...data },
			);
		}
	});
}

export function denied() {
	flushSync(() => {
		for (const callback of listeners.values())
			callback({ type: "subscribe_denied", narratorId: CHILD_ID });
	});
}

const rect = (element: Element | null) => {
	if (!element) return null;
	const { x, y, width, height } = element.getBoundingClientRect();
	return { x, y, width, height };
};

export function snapshot() {
	return {
		ready: !!document.querySelector('[data-case="prepared-long"] [data-agent-reference]'),
		opened: [...opened],
		pathname: router.state.location.pathname,
		subscriptions: [...subscriptions],
		listeners: listeners.size,
		metrics: agentReferenceMetrics(),
		longTitle: LONG_TITLE,
		afterText: AFTER_TEXT,
		panels: dockApi?.panels.map((panel) => ({
			id: panel.id,
			group: panel.group.id,
			active: panel.api.isActive,
			params: panel.params,
		})),
		chat: rect(document.querySelector(".fixture-main")),
		child: rect(document.querySelector(`[data-child-panel="${CHILD_ID}"]`)),
		childPanelId: subagentDockPanelId(CHILD_ID),
	};
}

await render();
