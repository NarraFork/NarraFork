/**
 * Chromium acceptance through the real message segmentation → activity grouping → adapter →
 * registry measurement → renderElement pipeline. Only the query/WS/ExactRow host is replaced:
 * its fold callbacks and nested-card slot use production spec keys, row keys and measured cards.
 * No auxiliary DOM or CSS-based fake expansion is constructed here.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { COMMUNICATION_PREVIEW_MAX_CHARS } from "@shared/communication-tool";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { InjectionTarget } from "@shared/pretext-layout/injection-target";
import { setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { OutlineOpenerProvider } from "../../../lib/outline-opener";
import zhChat from "../../../locales/zh-CN/chat.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { ImageViewerProvider } from "../../common/ImageViewerProvider";
import type { NarratorMsg } from "../narrator-panel-types";
import { getCategory, getCategoryColor, getSummary } from "../tool-call/tool-display";
import type { MeasuredCollapsibleTrace, MeasuredTraceRow } from "./measure/measure-tool-run";
import type { RenderLod } from "./prepared-block";
import {
	type BuiltPretextDocumentLayout,
	buildPretextDocumentLayout,
} from "./pretext-document-layout";
import { measureElement } from "./registry";
import type { ContentTargetResolver } from "./render/RenderToolCall";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { renderLabelsForKind, useVListLabels } from "./useVListLabels";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	defaultNS: "narrator",
	ns: ["narrator", "chat", "common"],
	resources: { "zh-CN": { narrator: zhNarrator, chat: zhChat, common: zhCommon } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

export const LOG_LINES = 80;
export const FIRST_LOG = "BACKGROUND_LOG_001";
export const LAST_LOG = "BACKGROUND_LOG_080";
export const KNOWLEDGE_TITLE = "知识条目：低 LOD 布局验收";
const LOG = Array.from(
	{ length: LOG_LINES },
	(_, index) =>
		`BACKGROUND_LOG_${String(index + 1).padStart(3, "0")} ${"build output with a long unchanged diagnostic path /workspace/frontend/components/ ".repeat(2)}`,
).join("\n");

function message(id: string, blocks: unknown[], role = "system"): NarratorMsg {
	return rowWithElements(
		{
			id,
			narratorId: "auxiliary-fixture",
			seq: 1,
			role,
			origin: role === "system" ? "system" : "assistant",
			parentToolUseId: null,
			contentText: null,
			toolCalls: [],
			createdAt: "2026-11-03T09:10:00.000Z",
		},
		blocks as never,
	) as unknown as NarratorMsg;
}

function background(id = "background"): NarratorMsg {
	return message(id, [
		{
			type: "system_injection",
			source: "bg_bash",
			modelText: `Background build finished successfully\n${LOG}`,
			body: {
				kind: "tasksDone",
				flavor: "bash",
				items: [
					{
						id: "build-task",
						alias: "frontend-build",
						title: "Build frontend",
						status: "completed",
						preview: LOG,
					},
				],
			},
		},
	]);
}

function knowledge(): NarratorMsg {
	return message("knowledge", [
		{
			type: "system_injection",
			source: "knowledge_base_hint",
			modelText: "KnowledgeRead personalEntryId=knowledge-exact-target",
			body: {
				kind: "knowledge",
				hits: [
					{
						entryId: "knowledge-exact-target",
						scope: "personal",
						title: KNOWLEDGE_TITLE,
						summary: "真实知识摘要应保持可读，并打开指定个人知识条目。",
					},
				],
			},
		},
	]);
}

function send(id: string, showToUser?: boolean): NarratorMsg {
	const inputJson = {
		id: "recipient-agent",
		message: id,
		...(showToUser === undefined ? {} : { show_to_user: showToUser }),
	};
	const tc = {
		toolUseId: `send-${id}`,
		toolName: "Send",
		inputJson,
		status: "completed",
		outputJson: {
			_text: "Delivered",
			_metadata: {
				targetCount: 1,
				targets: [
					{
						id: "recipient-agent",
						title: "收件代理",
						deliveryMessageId: `delivery-${id}`,
						status: "completed",
					},
				],
			},
		},
	};
	return {
		...message(
			id,
			[{ type: "tool_use", id: tc.toolUseId, name: "Send", input: inputJson, ...tc }],
			"assistant",
		),
		toolCalls: [tc],
	} as NarratorMsg;
}

function inbound(id: string, showToUser?: boolean): NarratorMsg {
	return message(id, [
		{
			type: "system_injection",
			source: "subagent_message",
			modelText: `Delivered message: ${id}`,
			body: {
				kind: "messages",
				items: [
					{
						fromId: "sender-agent",
						fromType: "agent",
						fromTitle: "检查代理",
						text: id,
						...(showToUser === undefined ? {} : { showToUser }),
					},
				],
			},
		},
	]);
}

export interface FixtureOptions {
	scene?: "background" | "knowledge" | "send" | "inbound" | "grouped";
	width: number;
	lod: RenderLod;
	/** Account preference: undefined in the fixture means the new/default behavior. */
	compactAuxiliaryContent?: boolean;
	recent?: boolean;
	knowledgeOpener?: boolean;
}

function messagesFor(scene: FixtureOptions["scene"]): NarratorMsg[] {
	switch (scene) {
		case "knowledge":
			return [knowledge()];
		case "send":
			return [
				send("internal-explicit-false", false),
				send("internal-default"),
				send("reader-intended-true", true),
			];
		case "inbound":
			return [
				inbound("received-explicit-false", false),
				inbound("received-default"),
				inbound("received-intended-true", true),
			];
		case "grouped":
			return [background(), send("internal-between-auxiliaries", false), knowledge()];
		default:
			return [background()];
	}
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: Root | null = null;
let currentLayout: BuiltPretextDocumentLayout | null = null;
let currentOptions: FixtureOptions;
let openedTargets: InjectionTarget[] = [];
let interactions: Array<{ kind: "card" | "row"; specKey: string; rowKey?: string }> = [];

function Scene({ options }: { options: FixtureOptions }) {
	const { adapterLabels, renderLabels } = useVListLabels();
	const [expanded, setExpanded] = useState(new Map<string, boolean>());
	const [rows, setRows] = useState(new Set<string>());
	const messages = messagesFor(options.scene);
	const layout = buildPretextDocumentLayout(messages, {
		compactAuxiliaryContent: options.compactAuxiliaryContent ?? true,
		layoutRevision: "auxiliary-browser",
		documentRevision: 1,
		lod: options.lod,
		widthBucket: options.width,
		contentWidth: options.width,
		viewportHeight: 720,
		gap: 4,
		measure: measureElement,
		labels: adapterLabels,
		labelsRevision: "zh-CN",
		recentMessageIds: new Set(options.recent === false ? [] : messages.map((msg) => msg.id)),
		isExpanded: (key) => expanded.get(key),
		isLodUserOverride: (key) => expanded.get(key) === true,
		isRowExpanded: (traceKey, rowKey) => rows.has(`${traceKey}/${rowKey}`),
		resolveToolCategory: getCategory,
		resolveToolColor: (name, input) => getCategoryColor(getCategory(name, input)),
		resolveToolSummary: (raw) => {
			const tc = raw as {
				toolName: string;
				inputJson?: unknown;
				outputJson?: { _metadata?: Record<string, unknown> };
				status?: string;
			};
			return getSummary(
				tc.toolName,
				tc.inputJson,
				{ ...tc.outputJson?._metadata, _toolStatus: tc.status },
				adapterLabels,
			);
		},
	});
	currentLayout = layout;
	const resolveTargetOpener: ContentTargetResolver = (target) =>
		options.knowledgeOpener && target.kind === "knowledge"
			? () => {
					openedTargets.push(target);
				}
			: undefined;
	const toggleRow = (specKey: string, rowKey: string) => {
		interactions.push({ kind: "row", specKey, rowKey });
		setRows((old) => {
			const next = new Set(old);
			const key = `${specKey}/${rowKey}`;
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	return (
		<div id="shot" style={{ width: options.width, background: "var(--mantine-color-body)" }}>
			<div
				id="document"
				style={{ position: "relative", width: options.width, height: layout.index.totalHeight }}
			>
				{layout.items.map((item, index) => {
					const { spec, measured } = item;
					const extra = resolveRenderExtra(spec) as Record<string, unknown>;
					extra.labels = renderLabelsForKind(spec.kind, renderLabels);
					extra.narratorId = "auxiliary-fixture";
					extra.resolveTargetOpener = resolveTargetOpener;
					extra.onToggle = () => {
						interactions.push({ kind: "card", specKey: spec.key });
						setExpanded((old) =>
							new Map(old).set(
								spec.key,
								!(measured as { effectiveOpened?: boolean }).effectiveOpened,
							),
						);
					};
					extra.onToggleRow = (_index: number, rowKey: string) => toggleRow(spec.key, rowKey);
					extra.rowCard = (row: MeasuredTraceRow) =>
						row.cardMeasured
							? renderElement(row.cardKind, row.cardMeasured, {
									labels: renderLabels.toolCall,
									narratorId: "auxiliary-fixture",
									resolveTargetOpener,
									onToggle: () => toggleRow(spec.key, row.key),
								})
							: null;
					return (
						<div
							key={spec.key}
							data-card=""
							data-kind={spec.kind}
							data-key={spec.key}
							data-measured={measured.height}
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

/** Scroll the real capped-body viewport and confirm a log marker is actually painted in it. */
export async function readLog(marker: string, edge: "start" | "end") {
	const scrollport = [...document.querySelectorAll<HTMLElement>("[data-content-scrollport]")].find(
		(node) => node.textContent?.includes(marker),
	);
	if (!scrollport) return { visible: false, scrollHeight: 0, height: 0 };
	scrollport.scrollTop = edge === "start" ? 0 : scrollport.scrollHeight;
	await settle();
	const walker = document.createTreeWalker(scrollport, NodeFilter.SHOW_TEXT);
	let text: Node | null = walker.nextNode();
	while (text && !(text.textContent ?? "").includes(marker)) text = walker.nextNode();
	if (!text)
		return {
			visible: false,
			scrollHeight: scrollport.scrollHeight,
			height: scrollport.clientHeight,
		};
	const start = (text.textContent ?? "").indexOf(marker);
	const range = document.createRange();
	range.setStart(text, start);
	range.setEnd(text, start + marker.length);
	const painted = range.getBoundingClientRect();
	const clip = scrollport.getBoundingClientRect();
	return {
		visible:
			painted.bottom > clip.top &&
			painted.top < clip.bottom &&
			painted.right > clip.left &&
			painted.left < clip.right,
		scrollHeight: scrollport.scrollHeight,
		height: scrollport.clientHeight,
	};
}

export async function render(options: FixtureOptions): Promise<void> {
	currentOptions = options;
	currentLayout = null;
	openedTargets = [];
	interactions = [];
	setTypography({ fontScalePercent: 100, lineHeightScalePercent: 100 });
	root?.unmount();
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme="dark">
					<ImageViewerProvider>
						<OutlineOpenerProvider value={{ open: () => true }}>
							<Scene options={options} />
						</OutlineOpenerProvider>
					</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	await settle();
}

/** Both data-budget evidence and actual browser boxes; never measured with a geometry stub. */
export function report() {
	const layout = currentLayout;
	if (!layout) throw new Error("fixture has not rendered");
	return {
		lod: currentOptions.lod,
		previewBudget: COMMUNICATION_PREVIEW_MAX_CHARS,
		manifestHeight: layout.index.totalHeight,
		documentHeight: document.getElementById("document")?.getBoundingClientRect().height ?? 0,
		pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		units: layout.renderUnits.map((unit) => unit.kind),
		openedTargets,
		interactions,
		cards: layout.items.map((item) => {
			const host = [...document.querySelectorAll<HTMLElement>("[data-card]")].find(
				(node) => node.dataset.key === item.spec.key,
			);
			if (!host) throw new Error(`missing painted item ${item.spec.key}`);
			const paper = host.firstElementChild as HTMLElement | null;
			const rect = paper?.getBoundingClientRect();
			const trace =
				item.spec.kind === "activity-trace" ? (item.measured as MeasuredCollapsibleTrace) : null;
			const data = item.spec.data as {
				detail?: { sections?: Array<{ body?: { text?: string; textTruncated?: boolean } }> };
				items?: Array<{ contentRole?: string }>;
			};
			const bodies =
				data.detail?.sections
					?.map((section) => section.body)
					.filter((body) => typeof body?.text === "string") ?? [];
			return {
				kind: item.spec.kind,
				key: item.spec.key,
				// The cross-level pairing identity the LOD morph resolves nodes by.
				unitId: item.spec.unitId ?? null,
				measured: item.measured.height,
				painted: rect?.height ?? 0,
				width: paper?.clientWidth ?? 0,
				scrollWidth: paper?.scrollWidth ?? 0,
				text: host.textContent ?? "",
				buttons: [...host.querySelectorAll<HTMLButtonElement>("button[aria-label]")].map((button) =>
					button.getAttribute("aria-label"),
				),
				detailChars: bodies.reduce((sum, body) => sum + (body?.text?.length ?? 0), 0),
				detailTruncated: bodies.some((body) => body?.textTruncated),
				effectiveOpened: (item.measured as { effectiveOpened?: boolean }).effectiveOpened ?? false,
				traceRows:
					trace?.rows.map((row) => {
						const node = [...host.querySelectorAll<HTMLElement>("[data-nf-trace-row]")].find(
							(candidate) => candidate.dataset.nfTraceRow === row.key,
						);
						const box = node?.getBoundingClientRect();
						return {
							key: row.key,
							// Read from the PAINTED attribute: that is what the morph queries.
							unitId: node?.getAttribute("data-nf-unit") ?? null,
							cardKind: row.cardKind,
							expanded: row.expanded,
							measured: row.blockHeight,
							painted: box?.height ?? 0,
							cardHeight: row.cardMeasured?.height ?? 0,
							text: node?.textContent ?? "",
						};
					}) ?? [],
				traceTail:
					trace && rect
						? rect.bottom -
							Math.max(
								rect.top,
								...[...host.querySelectorAll<HTMLElement>("[data-nf-trace-row]")].map(
									(node) => node.getBoundingClientRect().bottom,
								),
							)
						: null,
			};
		}),
	};
}
