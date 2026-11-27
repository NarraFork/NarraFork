/**
 * Chromium acceptance of team mode (the team page's coordinator column) through the real
 * segmentation → adapter → team transform → registry measurement → renderElement pipeline, with
 * the chip and divider wording built by the team page's own provider rules from the real
 * locales. Only ExactRow's query/WS host is replaced: the chip's fold uses its production spec
 * key and the measured open state, exactly like the shell's `onToggle`.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	capturePretextLayoutAnchor,
	type PretextLayoutAnchor,
	restorePretextLayoutAnchor,
} from "@shared/pretext-layout";
import { setTypography } from "@shared/pretext-layout/typography";
import type { TeamActivityEvent } from "@shared/project-teams";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import zhChat from "../../../locales/zh-CN/chat.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import zhProjects from "../../../locales/zh-CN/projects.json";
import { chipLabels, conversationEvents } from "../../teams/team-conversation";
import type { NarratorMsg } from "../narrator-panel-types";
import { getCategory, getCategoryColor, getSummary } from "../tool-call/tool-display";
import {
	type BuiltPretextDocumentLayout,
	buildPretextDocumentLayout,
} from "./pretext-document-layout";
import { measureElement } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { renderLabelsForKind, useVListLabels } from "./useVListLabels";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	defaultNS: "narrator",
	ns: ["narrator", "chat", "common", "projects"],
	resources: {
		"zh-CN": { narrator: zhNarrator, chat: zhChat, common: zhCommon, projects: zhProjects },
	},
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});
const tProjects = i18n.getFixedT("zh-CN", "projects") as unknown as (
	key: string,
	values?: Record<string, unknown>,
) => string;

const BASE = Date.parse("2026-11-27T02:00:00.000Z");
const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString();

function text(id: string, seq: number, minute: number, body: string, role = "assistant") {
	return rowWithElements(
		{
			id,
			narratorId: "coordinator",
			seq,
			role,
			contentText: body,
			toolCalls: [],
			parentToolUseId: null,
			createdAt: at(minute),
		},
		[{ type: "text", text: body }],
	) as unknown as NarratorMsg;
}

function team(
	id: string,
	seq: number,
	minute: number,
	input: Record<string, unknown>,
	status = "success",
) {
	const call = {
		toolUseId: `use-${id}`,
		toolName: "Team",
		status,
		inputJson: input,
		outputJson: status === "fail" ? { error: "TEAM_WORK_ITEM_NOT_FOUND" } : { ok: true },
	};
	return rowWithElements(
		{
			id,
			narratorId: "coordinator",
			seq,
			role: "assistant",
			contentText: "",
			toolCalls: [call],
			parentToolUseId: null,
			createdAt: at(minute),
		},
		[{ type: "tool_use", id: call.toolUseId, name: "Team", input }],
	) as unknown as NarratorMsg;
}

const TITLES = [
	"结账页改用新支付 SDK",
	"订单金额统一两位小数",
	"修复导出 CSV 时区错误",
	"登录接口加限流",
];

function messages(): NarratorMsg[] {
	let seq = 0;
	return [
		text("u1", seq++, 0, "这周发 v2.8，每项单独分支，合并前过评审。", "user"),
		text("a1", seq++, 1, "拆成 4 项，支付相关先开工。"),
		...TITLES.map((title, index) => team(`c${index}`, seq++, 2, { action: "work.create", title })),
		team("k1", seq++, 3, { action: "checkin", minutes: 30 }),
		text("u2", seq++, 20, "导出统一按用户时区格式化。", "user"),
		team("r1", seq++, 21, { action: "work.ready", item: "missing" }, "fail"),
		team("r2", seq++, 21, { action: "work.ready", item: "w3" }),
		team("p1", seq++, 22, { action: "cleanup", item: "w9" }),
		text("a2", seq++, 23, "已经是这样，这一项在等你验收。"),
	];
}

const activity = (
	id: string,
	kind: string,
	minute: number,
	detail: Record<string, unknown>,
	title: string,
): TeamActivityEvent => ({
	id,
	kind,
	workItemId: id,
	workItemTitle: title,
	actorKind: "agent",
	actorId: null,
	actorName: null,
	detail,
	detailOmitted: false,
	createdAt: at(minute),
});

const EVENTS = [
	activity("e1", "work.review", 10, { verdict: "clear" }, TITLES[2] as string),
	activity("e2", "work.merged", 10, { detectedBy: "pull_request", pr: 42 }, TITLES[0] as string),
	activity("e3", "work.returned", 30, {}, TITLES[1] as string),
];

export interface FixtureOptions {
	width: number;
	fontScale?: number;
	/** Put the document in a scroll viewport of this height (the shell's anchored rebuild). */
	viewport?: number;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: Root | null = null;
let currentLayout: BuiltPretextDocumentLayout | null = null;
let currentOptions: FixtureOptions;

function Scene({ options }: { options: FixtureOptions }) {
	const { adapterLabels, renderLabels } = useVListLabels();
	const [expanded, setExpanded] = useState(new Map<string, boolean>());
	const scroller = useRef<HTMLDivElement | null>(null);
	const pendingAnchor = useRef<PretextLayoutAnchor | null>(null);
	const msgs = messages();
	const layout = buildPretextDocumentLayout(msgs, {
		layoutRevision: "team-browser",
		documentRevision: 1,
		lod: 4,
		widthBucket: options.width,
		contentWidth: options.width,
		viewportHeight: 720,
		gap: 4,
		segmentGap: 12,
		measure: measureElement,
		labels: adapterLabels,
		labelsRevision: "zh-CN",
		recentMessageIds: new Set(msgs.map((msg) => msg.id)),
		isExpanded: (key) => expanded.get(key),
		resolveHasPendingPermission: (toolUseId) => toolUseId === "use-p1",
		resolveToolCategory: getCategory,
		resolveToolColor: (name, input) => getCategoryColor(getCategory(name, input)),
		resolveToolSummary: (raw) => {
			const tc = raw as { toolName: string; inputJson?: unknown; status?: string };
			return getSummary(tc.toolName, tc.inputJson, { _toolStatus: tc.status }, adapterLabels);
		},
		teamConversation: {
			events: conversationEvents(EVENTS, tProjects, BASE),
			chipLabels: chipLabels(tProjects),
			revision: "fixture",
			hasPrev: false,
		},
	});
	currentLayout = layout;
	// The shell's anchored rebuild: the fold captures the viewport's anchor before the toggle and
	// restores it against the new layout before paint (`capture/restorePretextLayoutAnchor`).
	useLayoutEffect(() => {
		const anchor = pendingAnchor.current;
		const node = scroller.current;
		if (!anchor || !node) return;
		pendingAnchor.current = null;
		node.scrollTop = restorePretextLayoutAnchor(anchor, layout.index, node.clientHeight);
	});
	return (
		<div
			id="shot"
			ref={scroller}
			className="nf-type-scope"
			style={{
				width: options.width,
				background: "var(--mantine-color-body)",
				...(options.viewport ? { height: options.viewport, overflowY: "auto" } : {}),
			}}
		>
			<div
				id="document"
				style={{ position: "relative", width: options.width, height: layout.index.totalHeight }}
			>
				{layout.items.map((item, index) => {
					const { spec, measured } = item;
					const extra = resolveRenderExtra(spec) as Record<string, unknown>;
					extra.labels = renderLabelsForKind(spec.kind, renderLabels);
					extra.narratorId = "team-fixture";
					extra.onToggle = () => {
						const node = scroller.current;
						if (node && options.viewport)
							pendingAnchor.current = capturePretextLayoutAnchor(
								layout.index,
								node.scrollTop,
								node.clientHeight,
								false,
							);
						setExpanded((old) => {
							const open = measured as { effectiveOpened?: boolean; expanded?: boolean };
							return new Map(old).set(spec.key, !(open.effectiveOpened ?? open.expanded ?? false));
						});
					};
					return (
						<div
							key={spec.key}
							data-row=""
							data-kind={spec.kind}
							data-key={spec.key}
							style={{
								position: "absolute",
								top: layout.index.itemStart(index),
								width: options.width,
								height: measured.height,
							}}
						>
							{renderElement(spec.kind, measured, extra)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export async function settle(): Promise<void> {
	await document.fonts.ready;
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export async function render(options: FixtureOptions): Promise<void> {
	currentOptions = options;
	ensureTypographyCssVars();
	setTypography({ fontScalePercent: options.fontScale ?? 100, lineHeightScalePercent: 100 });
	root?.unmount();
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme="dark">
					<Scene options={options} />
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	await settle();
}

/** Click the chip whose text contains `label` (a real DOM click on the real button). */
export async function clickChip(label: string): Promise<boolean> {
	const button = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=team-chip]")].find(
		(node) => node.textContent?.includes(label),
	);
	button?.click();
	await settle();
	return !!button;
}

/** Measured vs painted boxes of every row, and what each team row says. */
export function report() {
	const layout = currentLayout;
	if (!layout) throw new Error("fixture has not rendered");
	return {
		width: currentOptions.width,
		manifestHeight: layout.index.totalHeight,
		documentHeight: document.getElementById("document")?.getBoundingClientRect().height ?? 0,
		pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		rows: layout.items.map((item) => {
			const host = [...document.querySelectorAll<HTMLElement>("[data-row]")].find(
				(node) => node.dataset.key === item.spec.key,
			);
			if (!host) throw new Error(`missing painted row ${item.spec.key}`);
			const inner = host.firstElementChild as HTMLElement | null;
			const rect = inner?.getBoundingClientRect();
			const textNode = host.querySelector<HTMLElement>("[data-truncate]");
			return {
				kind: item.spec.kind,
				key: item.spec.key,
				measured: item.measured.height,
				painted: rect?.height ?? 0,
				width: inner?.clientWidth ?? 0,
				scrollWidth: inner?.scrollWidth ?? 0,
				text: host.textContent ?? "",
				expanded:
					host.querySelector("[data-testid=team-chip]")?.getAttribute("data-expanded") ?? null,
				error: !!host.querySelector("[data-testid=team-chip-error]"),
				// One line: the text box is no taller than its line, whatever it says.
				textHeight: textNode?.getBoundingClientRect().height ?? 0,
				textLineHeight: textNode ? Number.parseFloat(getComputedStyle(textNode).lineHeight) : 0,
			};
		}),
	};
}

/** Scroll the viewport so the row `key` starts `offset` px above the viewport top. */
export async function scrollRowAbove(key: string, offset: number): Promise<number> {
	const layout = currentLayout;
	const node = document.getElementById("shot");
	if (!layout || !node) throw new Error("fixture has not rendered");
	const index = layout.items.findIndex((item) => item.spec.key === key);
	node.scrollTop = layout.index.itemStart(index) + offset;
	await settle();
	return node.scrollTop;
}

/** On-screen top of a painted row relative to the viewport, or null when not mounted. */
export function rowScreenTop(key: string): number | null {
	const node = document.getElementById("shot");
	const row = [...document.querySelectorAll<HTMLElement>("[data-row]")].find(
		(candidate) => candidate.dataset.key === key,
	);
	if (!node || !row) return null;
	return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
}
