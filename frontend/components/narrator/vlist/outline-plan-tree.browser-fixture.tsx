/**
 * Browser fixture for an outline plan's ExitPlanMode card (`outline-plan-tree.browser.test.ts`,
 * plan readability): the plan from the owner's screenshot (the goal and the acceptance in one
 * root paragraph, long bullets four levels deep) and the same plan laid out as the rules now
 * ask, through the real segment → adapter → measure → render chain with the shell's labels,
 * and the reader's folds held in the list's own interaction state (`applyVListPlanTreeAction`),
 * so a click re-adapts and re-measures the card exactly as the session list does. With
 * `approval`, the plan waits for a decision: the card hosts the real approval form
 * (`OutlinePlanApproval`, mounted by the vlist's permission bridge), its height first predicted
 * and then reported by the form.
 *
 * `scene: "before"` is the same plan as the card drew it before (a plan-file style markdown
 * body, everything expanded): only for the before/after screenshots.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { type OutlineItem, serializeMarkdownOutline } from "@shared/outline";
import { setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { useLayoutEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { OutlineOpenerProvider } from "../../../lib/outline-opener";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import enChat from "../../../locales/en/chat.json";
import enCommon from "../../../locales/en/common.json";
import enNarrator from "../../../locales/en/narrator.json";
import enOutline from "../../../locales/en/outline.json";
import zhChat from "../../../locales/zh-CN/chat.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import zhOutline from "../../../locales/zh-CN/outline.json";
import type { PendingPermission } from "../../../types/narrator";
import { ImageViewerProvider } from "../../common/ImageViewerProvider";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { getCategory, getCategoryColor, getSummary } from "../tool-call/tool-display";
import { toolCardInnerWidth } from "./measure/measure-tool-call";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";
import {
	applyVListPlanTreeAction,
	createVListInteractionState,
	resolvePlanTreeViewRow,
} from "./vlist-interaction-state";
import { buildPermissionNode } from "./vlist-permission-bridge";
import { predictInlinePermission } from "./vlist-permission-prediction";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	defaultNS: "narrator",
	ns: ["narrator", "chat", "common", "outline"],
	resources: {
		"zh-CN": { narrator: zhNarrator, chat: zhChat, common: zhCommon, outline: zhOutline },
		en: { narrator: enNarrator, chat: enChat, common: enCommon, outline: enOutline },
	},
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

export function ready(): boolean {
	return true;
}

// ── The plans ──

const item = (content: string, children: OutlineItem[] = [], task = false): OutlineItem => ({
	content,
	task: task ? { status: "todo", assignee: null } : null,
	props: {},
	children,
});
const step = (content: string, children: OutlineItem[] = []) => item(content, children, true);

/** The plan of the owner's screenshot: the goal and the acceptance in the root, long bullets. */
const LEGACY: OutlineItem = step(
	[
		"历史读取10秒改告警",
		"目标：把模型历史链路、工具结果回放和会话恢复里“读取历史超过 10 秒就拒绝”的固定时间限制全部改成告警，读取照常完成；慢的时候在日志和界面上提示，用户能看到原因，不再看到莫名其妙的失败。",
		"验收：1）人为注入 15 秒延迟的慢读取照常返回，不再报 HISTORY_READ_TIMEOUT；2）日志里有一条 warn，带会话 id、链路名和耗时；3）界面提示在读取完成后消失；4）现有历史读取测试全部通过，新增的告警测试覆盖三条链路。",
	].join("\n"),
	[
		item("已确定的边界与取舍", [
			item(
				"只改“超时即拒绝”的行为，不改读取本身：分页、游标和每页上限都保持不变，避免同时改两件事时无法判断回归来自哪里。",
			),
			item(
				"告警阈值沿用 10 秒，但做成常量放在 history-limits.ts 里，后面要调只改一处；不做成用户设置，因为没有人需要按会话调它。",
			),
			item(
				"不在主线程上做任何新的同步等待：告警通过已有的慢操作日志通道发出，界面提示走现有的会话状态事件，不新增 WebSocket 消息类型。",
			),
			item(
				"压缩恢复链路这次不动：它的超时是保护磁盘的，不是保护用户体验的，和这次的问题无关，单独评估后再决定要不要放宽。",
			),
			item(
				"旧客户端看不到新提示也没关系：它们收到的仍然是照常完成的读取结果，只是少一条提示，不会出错。",
			),
			item(
				"测试只在受影响的三个目录里跑，不跑全量；慢读取用注入延迟模拟，不依赖真实的慢磁盘，保证 CI 上结果稳定。",
			),
		]),
		step("阶段1：历史读取10秒改告警——先去掉模型历史链路里的固定时间拒绝，再处理工具结果回放", [
			step("清除模型历史链路的固定时间拒绝", [
				item(
					"history-build.ts 里 readHistoryPage 的 10 秒 Promise.race 去掉，改成读取完成后比较耗时，超过阈值时调用 logSlowOperation，并把耗时带进返回值。",
				),
				item(
					"loop.ts 里捕获 HISTORY_READ_TIMEOUT 的分支一起删掉，这个错误码不再产生；保留错误码定义一个版本，避免旧日志解析报错。",
				),
				item(
					"调用方 buildModelHistory 不需要改签名：耗时是可选字段，旧调用方忽略即可，新调用方用它决定要不要发界面提示。",
				),
			]),
			step("工具结果回放改为告警", [
				item("replayToolResults 同样去掉 race，耗时超过阈值时只告警，结果照常回放。"),
				item("回放的告警带工具调用 id，方便在日志里对上是哪一次调用读得慢。"),
			]),
			step("会话恢复路径同样改成告警", [
				item("restoreSession 读历史的超时拒绝改成告警，恢复流程不中断。"),
			]),
		]),
		step("阶段2：界面提示", [
			step("读取慢时在会话头部显示提示", [
				item("复用现有的会话状态事件，加一个 slowHistory 字段，读取完成后清掉。"),
			]),
			step("提示文案进 en / zh-CN 两套语言文件"),
		]),
		step("阶段3：测试与回归", [
			step("三条链路各加一个注入延迟的测试"),
			step("跑受影响目录的现有测试，确认没有回归"),
		]),
		item("开放问题", [item("告警是否需要按会话限频？目前倾向不限，因为慢读取本身就很少。")]),
	],
);

/** The same plan as the rules now ask: a title root, every block one short point, in levels. */
const STRUCTURED: OutlineItem = step("历史读取10秒改告警", [
	item("目标", [
		item("读历史超过 10 秒只告警，读取照常完成"),
		item("慢的时候在日志和界面上提示原因"),
	]),
	item("验收", [
		item("注入 15 秒延迟的读取照常返回，不再报 HISTORY_READ_TIMEOUT"),
		item("日志里有 warn，带会话 id、链路名和耗时"),
		item("界面提示在读取完成后消失"),
		item("新增告警测试覆盖三条链路"),
	]),
	item("边界与取舍", [
		item("只改超时即拒绝，不改分页和游标"),
		item("阈值 10 秒做成常量，放在 history-limits.ts"),
		item("不在主线程上新增同步等待"),
		item("压缩恢复链路这次不动"),
	]),
	step("阶段1：去掉固定时间拒绝", [
		step("清除模型历史链路的固定时间拒绝", [
			item("history-build.ts：去掉 10 秒 Promise.race"),
			item("超过阈值调用 logSlowOperation"),
			item("loop.ts：删掉 HISTORY_READ_TIMEOUT 分支"),
		]),
		step("工具结果回放改为告警", [item("告警带工具调用 id")]),
		step("会话恢复路径改为告警"),
	]),
	step("阶段2：界面提示", [
		step("读取慢时在会话头部显示提示", [item("会话状态事件加 slowHistory 字段")]),
		step("提示文案进 en / zh-CN"),
	]),
	step("阶段3：测试与回归", [step("三条链路各加注入延迟的测试"), step("跑受影响目录的现有测试")]),
]);

export const PLANS = {
	legacy: serializeMarkdownOutline([LEGACY]),
	structured: serializeMarkdownOutline([STRUCTURED]),
};

export interface FixtureOptions {
	/** `legacy` / `structured`: the card as it is now; `before`: the old markdown body. */
	scene: "legacy" | "structured" | "before";
	lang?: "zh-CN" | "en";
	width: number;
	scheme: "light" | "dark";
	/** The plan waits for a decision: the card hosts the approval form. */
	approval?: boolean;
	viewportHeight?: number;
	fontScalePercent?: number;
	lineHeightScalePercent?: number;
}

const TOOL_USE = "toolu_plan_readability";

function planInput(scene: FixtureOptions["scene"]) {
	const plan = scene === "structured" ? PLANS.structured : PLANS.legacy;
	if (scene === "before") return { plan };
	return {
		mode: "outline",
		plan,
		_planRoot: {
			blockId: "root-block",
			spaceId: "space",
			pageId: "page",
			address: "MTBXwl1Y/u90Ia1yR",
			title: "历史读取10秒改告警",
			round: 1,
		},
		_planSeq: 12,
		_planBaseSeq: 0,
		_planDiff: { counts: { added: 31, removed: 0, text: 0, task: 0, moved: 0 } },
	};
}

function messages(options: FixtureOptions): NarratorMsg[] {
	const input = planInput(options.scene);
	const status = options.approval ? "pending" : "completed";
	const outputJson = options.approval ? null : { _text: "User has approved your plan." };
	return [
		rowWithElements(
			{
				id: "a-plan",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentText: null,
				toolCalls: [
					{ toolUseId: TOOL_USE, toolName: "ExitPlanMode", inputJson: input, outputJson, status },
				],
				createdAt: "2026-11-07T09:10:00.000Z",
			},
			[
				{
					type: "tool_use",
					id: TOOL_USE,
					name: "ExitPlanMode",
					input,
					inputJson: input,
					outputJson,
					status,
				},
			],
		) as unknown as NarratorMsg,
	];
}

function permissionOf(options: FixtureOptions): PendingPermission {
	return {
		id: "plan-request",
		toolName: "ExitPlanMode",
		toolUseId: TOOL_USE,
		ownerNarratorId: "n1",
		inputJson: planInput(options.scene),
	} as unknown as PendingPermission;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
queryClient.setQueryData(["settings"], { outline: { enabled: true } });
let root: Root | null = null;
/** Commits of the scene (a click is answered once this moves and the frame is painted). */
let commits = 0;

function Scene({ options }: { options: FixtureOptions }) {
	const { adapterLabels, renderLabels } = useVListLabels();
	const [interaction, setInteraction] = useState(() => createVListInteractionState(5));
	const [formHeight, setFormHeight] = useState<number | undefined>(undefined);
	const permission = options.approval ? permissionOf(options) : null;
	const prediction = useMemo(() => {
		if (!permission) return undefined;
		return predictInlinePermission(permission as never, {
			innerWidth: toolCardInnerWidth(options.width, false),
			canDecide: true,
			planButtonLabels: [
				i18n.t("outlinePlan.draft"),
				i18n.t("outlinePlan.lock"),
				i18n.t("outlinePlan.return"),
			],
			planFeedbackPlaceholder: i18n.t("outlinePlan.feedbackPlaceholder"),
		});
	}, [permission, options.width]);
	const ctx: AdapterContext = {
		lod: 5,
		labels: adapterLabels,
		viewportHeight: options.viewportHeight ?? 900,
		resolveToolCategory: getCategory,
		resolveToolColor: (n: string, i?: unknown) => getCategoryColor(getCategory(n, i)),
		resolveToolSummary: (tc) => {
			const call = tc as { toolName: string; inputJson?: unknown; outputJson?: unknown };
			const meta = (call.outputJson as { _metadata?: Record<string, unknown> } | undefined)
				?._metadata;
			return getSummary(call.toolName, call.inputJson, meta, adapterLabels);
		},
		planTreeView: (key) => resolvePlanTreeViewRow(interaction, key),
		...(permission
			? {
					resolveHasPendingPermission: (id?: string) => id === TOOL_USE,
					resolvePermissionFormPrediction: (id?: string) =>
						id === TOOL_USE ? prediction : undefined,
					resolvePermissionFormHeight: (id?: string) => (id === TOOL_USE ? formHeight : undefined),
				}
			: {}),
	};
	const specs = adaptSegments(
		segmentMessages(messages(options)) as unknown as AdapterSegment[],
		ctx,
	);
	useLayoutEffect(() => {
		commits++;
	});
	return (
		<div
			id="shot"
			style={{
				width: options.width,
				boxSizing: "content-box",
				padding: 16,
				background: "var(--mantine-color-body)",
			}}
		>
			{specs.map((spec) => {
				const entry = VLIST_REGISTRY[spec.kind];
				if (!entry) return <div key={spec.key}>?? {spec.kind}</div>;
				const measured = entry.measure(spec.data as never, options.width, 5, spec.opts as never);
				const extra = resolveRenderExtra(spec) as Record<string, unknown>;
				extra.narratorId = "n1";
				extra.onToggle = () => {};
				extra.onTogglePrompt = () => {};
				extra.onPlanTree = (action: never) =>
					setInteraction((prev) => applyVListPlanTreeAction(prev, spec.key, action));
				if (spec.kind === "tool-call") {
					extra.labels = renderLabels.toolCall;
					if (permission) {
						extra.permissionSlot = buildPermissionNode(permission, {});
						extra.onPermissionFormHeight = (height: number) => setFormHeight(height);
					}
				}
				return (
					<div
						key={spec.key}
						data-card=""
						data-kind={spec.kind}
						data-measured={measured.height}
						style={{ position: "relative", height: measured.height, width: options.width }}
					>
						{renderElement(spec.kind, measured, extra as never)}
					</div>
				);
			})}
		</div>
	);
}

/** Render a scene; resolves once it is committed and painted. */
export async function render(options: FixtureOptions): Promise<void> {
	ensureTypographyCssVars();
	await i18n.changeLanguage(options.lang ?? "zh-CN");
	setTypography({
		fontScalePercent: options.fontScalePercent ?? 100,
		lineHeightScalePercent: options.lineHeightScalePercent ?? 100,
	});
	const host = document.getElementById("root") as HTMLElement;
	root?.unmount();
	root = createRoot(host);
	const before = commits;
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme={options.scheme}>
					<ImageViewerProvider>
						<OutlineOpenerProvider value={{ open: () => true }}>
							<Scene options={options} />
						</OutlineOpenerProvider>
					</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	await settled(before);
}

/** Wait for a commit after `before`, then for its frame to be painted. */
async function settled(before: number): Promise<void> {
	while (commits === before) await new Promise((resolve) => requestAnimationFrame(resolve));
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** Commits so far (the test waits for it to move after a click). */
export function commitCount(): number {
	return commits;
}

/** Click the element `selector` matches (inside the plan's card); resolves once re-rendered. */
export async function click(selector: string): Promise<boolean> {
	const el = document.querySelector<HTMLElement>(`[data-card] ${selector}`);
	if (!el) return false;
	const before = commits;
	el.click();
	await settled(before);
	return true;
}

/** Wait until the card's measured height has stopped moving (a reported form height). */
export async function steady(): Promise<void> {
	let last = "";
	for (let frame = 0; frame < 30; frame++) {
		const now = [...document.querySelectorAll<HTMLElement>("[data-card]")]
			.map(
				(card) =>
					`${card.dataset.measured}:${card.firstElementChild?.getBoundingClientRect().height}`,
			)
			.join("|");
		if (now === last) return;
		last = now;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}
}

export interface PlanRowReport {
	key: string;
	depth: number;
	/** "1" open, "0" folded, undefined: no children. */
	open?: string;
	badge: string | null;
	ellipsis: boolean;
	text: string;
	/** The row's painted height and what its lines take. */
	height: number;
	lines: number;
}

export interface CardReport {
	measured: number;
	painted: number;
	/** How far anything reaches past the card's content box (px). */
	spill: number;
	toolbar: string | null;
	allLabel: string | null;
	rows: PlanRowReport[];
	box: { height: number; scrollHeight: number; clientHeight: number } | null;
	approval: boolean;
	overflowX: boolean;
	/** A plan row whose text paints past its own box (px). */
	rowSpill: number;
	/** How far the toolbar line's words reach into the rows' box below it (px). */
	toolbarOverlap: number;
	markdownBlocks: number;
}

export function report(): CardReport {
	const card = document.querySelector<HTMLElement>("[data-card][data-kind=tool-call]");
	if (!card) throw new Error("no plan card");
	const paper = card.firstElementChild as HTMLElement;
	const box = paper.getBoundingClientRect();
	const style = getComputedStyle(paper);
	const top =
		box.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
	const bottom =
		box.bottom -
		Number.parseFloat(style.borderBottomWidth) -
		Number.parseFloat(style.paddingBottom);
	let spill = 0;
	for (const child of paper.querySelectorAll<HTMLElement>("*")) {
		const r = child.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		let visibleTop = r.top;
		let visibleBottom = r.bottom;
		for (let up = child.parentElement; up && up !== paper; up = up.parentElement) {
			if (getComputedStyle(up).overflowY === "visible") continue;
			const clip = up.getBoundingClientRect();
			visibleTop = Math.max(visibleTop, clip.top);
			visibleBottom = Math.min(visibleBottom, clip.bottom);
		}
		if (visibleBottom <= visibleTop) continue;
		spill = Math.max(spill, top - visibleTop, visibleBottom - bottom);
	}
	let rowSpill = 0;
	const rows = [...card.querySelectorAll<HTMLElement>("[data-plan-row]")].map((row) => {
		const rect = row.getBoundingClientRect();
		const text = row.querySelector<HTMLElement>("[data-plan-text]");
		for (const frag of row.querySelectorAll<HTMLElement>("[data-plan-text] *")) {
			const r = frag.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			rowSpill = Math.max(rowSpill, r.bottom - rect.bottom, rect.top - r.top);
		}
		return {
			key: row.dataset.planRow ?? "",
			depth: Number(row.dataset.planDepth),
			open: row.dataset.planOpen,
			badge: row.querySelector("[data-plan-badge]")?.textContent ?? null,
			ellipsis: !!row.querySelector("[data-plan-ellipsis]"),
			text: text?.textContent ?? "",
			height: Math.round(rect.height * 10) / 10,
			lines: text ? text.children.length : 0,
		};
	});
	const planBox = card.querySelector<HTMLElement>("[data-plan-box]");
	let toolbarOverlap = 0;
	const boxTop = planBox?.getBoundingClientRect().top;
	for (const word of card.querySelectorAll<HTMLElement>("[data-plan-summary], [data-plan-all]")) {
		if (boxTop === undefined) break;
		toolbarOverlap = Math.max(toolbarOverlap, word.getBoundingClientRect().bottom - boxTop);
	}
	return {
		measured: Number(card.dataset.measured),
		painted: Math.round(paper.getBoundingClientRect().height * 10) / 10,
		spill: Math.round(spill * 10) / 10,
		toolbar: card.querySelector("[data-plan-summary]")?.textContent ?? null,
		allLabel: card.querySelector("[data-plan-all]")?.textContent ?? null,
		rows,
		box: planBox
			? {
					height: Math.round(planBox.getBoundingClientRect().height * 10) / 10,
					scrollHeight: planBox.scrollHeight,
					clientHeight: planBox.clientHeight,
				}
			: null,
		approval: !!card.querySelector("[data-testid=outline-plan-approval]"),
		overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
		rowSpill: Math.round(rowSpill * 10) / 10,
		toolbarOverlap: Math.round(toolbarOverlap * 10) / 10,
		markdownBlocks: card.querySelectorAll("[data-tool-markdown]").length,
	};
}
