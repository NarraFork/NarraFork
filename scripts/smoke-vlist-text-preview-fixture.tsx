import "@mantine/core/styles.css";
import "../frontend/components/narrator/vlist/vlist-markdown.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import { RenderLodCtx } from "../frontend/components/narrator/lod/RenderLodCtx";
import { measureElement } from "../frontend/components/narrator/vlist/registry";
import {
	renderElement,
	resolveRenderExtra,
} from "../frontend/components/narrator/vlist/render-registry";
import {
	createVListInteractionState,
	isVListTextExpanded,
	toggleVListTextExpanded,
} from "../frontend/components/narrator/vlist/vlist-interaction-state";
import type { RenderLod } from "../shared/pretext-layout/prepared-block";
import {
	type AdapterContext,
	type AdapterSegment,
	adaptSegment,
} from "../shared/pretext-layout/segment-adapter";

export type PreviewSmokeKind = "incoming" | "bash" | "agent" | "send" | "reasoning";
export interface PreviewSmokeOptions {
	kind: PreviewSmokeKind;
	width: number;
	live: boolean;
	lod: RenderLod;
	theme: "dark" | "light";
	short?: boolean;
	/** Unclipped Markdown with more raw-source rows than rendered visual lines. */
	sourceSoftBreaks?: boolean;
}
export interface PreviewSmokeSnapshot {
	text: string;
	lines: number;
	viewportHeights: number[];
	buttonPositions: string[];
	expanded: boolean[];
	rowHeight: number;
	paintedBottom: number;
}
export interface PreviewSmokeApi {
	set(options: PreviewSmokeOptions): void;
	append(): void;
	snapshot(): PreviewSmokeSnapshot;
}
declare global {
	interface Window {
		__textPreviewSmoke: PreviewSmokeApi;
	}
}

await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { translation: {} } },
	interpolation: { escapeValue: false },
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let renderOptions: (options: PreviewSmokeOptions) => void;
let appendText: () => void;
const SOURCE = `HEAD_最初内容\n\n${"中文 lengthy paragraph **bold** and `code` with meaningful text。\n\n".repeat(600)}TAIL_完整末尾`;

function segment(options: PreviewSmokeOptions, source: string): AdapterSegment {
	const block =
		options.kind === "reasoning"
			? { type: "reasoning", text: source }
			: options.kind === "incoming"
				? {
						type: "system_injection",
						source: "team_message",
						body: {
							kind: "messages",
							items: [{ fromId: "sender", fromTitle: "Sender", text: source }],
						},
					}
				: {
						type: "system_injection",
						source: options.kind === "bash" ? "bg_bash" : "bg_agent",
						body: {
							kind: "tasksDone",
							flavor: options.kind === "bash" ? "bash" : "agent",
							items: [{ id: "background", alias: "job", status: "success", preview: source }],
						},
					};
	const msg = {
		id: options.live ? "__streaming__" : "history",
		role: options.kind === "reasoning" ? "assistant" : "sys",
		contentJson: [block],
		seq: 1,
	};
	if (options.kind === "send") {
		return {
			kind: "tool-run",
			items: [
				{
					tc: {
						toolUseId: "send-call",
						toolName: "Send",
						status: "success",
						inputJson: { id: "recipient", message: source },
						outputJson: { _text: "sent" },
					},
					msg: { ...msg, contentJson: [] },
					blockIndex: 0,
				},
			],
			sourceMessages: [],
		} as AdapterSegment;
	}
	return { kind: "message", msg } as AdapterSegment;
}
function Probe() {
	const [options, setOptions] = useState<PreviewSmokeOptions>({
		kind: "incoming",
		width: 350,
		live: false,
		lod: 1,
		theme: "dark",
	});
	const [source, setSource] = useState(SOURCE);
	const [interaction, setInteraction] = useState(() => createVListInteractionState(1));
	renderOptions = (next) =>
		flushSync(() => {
			setOptions(next);
			setSource(
				next.sourceSoftBreaks
					? `${"word\n".repeat(20)}LAST`
					: next.short
						? "Short content stays unchanged."
						: SOURCE,
			);
			setInteraction(createVListInteractionState(next.lod));
		});
	appendText = () => flushSync(() => setSource((text) => `${text}\nLATEST_刚刚到达`));
	const context: AdapterContext = {
		lod: options.lod,
		isExpanded: () => true,
		isTextExpanded: (key, bodyKey) => isVListTextExpanded(interaction, key, bodyKey),
		resolveToolCategory: () => "send",
	};
	const specs = adaptSegment(segment(options, source), context);
	return (
		<MantineProvider forceColorScheme={options.theme}>
			<QueryClientProvider client={queryClient}>
				<RenderLodCtx.Provider value={{ lod: options.lod, interactive: false }}>
					<div
						id="smoke-list"
						style={{
							width: options.width,
							margin: "20px auto",
							color: "var(--mantine-color-text)",
							background: "var(--mantine-color-body)",
						}}
					>
						{specs.map((spec) => {
							const measured = measureElement(
								spec.kind,
								spec.data,
								options.width,
								options.lod,
								spec.opts,
							);
							return (
								<div
									key={spec.key}
									data-smoke-row
									style={{ height: measured.height, position: "relative" }}
								>
									{renderElement(spec.kind, measured, {
										...resolveRenderExtra(spec),
										showSource: options.sourceSoftBreaks,
										sourceText: options.sourceSoftBreaks ? source : undefined,
										textPreviewLabels: { expand: "展开内容", collapse: "收起内容" },
										onToggleTextExpanded: (bodyKey?: string) =>
											setInteraction((state) => toggleVListTextExpanded(state, spec.key, bodyKey)),
									})}
								</div>
							);
						})}
					</div>
				</RenderLodCtx.Provider>
			</QueryClientProvider>
		</MantineProvider>
	);
}

const rootNode = document.getElementById("root");
if (!rootNode) throw new Error("Smoke root is missing");
createRoot(rootNode).render(<Probe />);
window.__textPreviewSmoke = {
	set(options) {
		renderOptions(options);
	},
	append() {
		appendText();
	},
	snapshot() {
		const list = document.getElementById("smoke-list");
		if (!list) throw new Error("Smoke list is missing");
		const rows = [...list.querySelectorAll<HTMLElement>("[data-smoke-row]")];
		const bodies = [...list.querySelectorAll<HTMLElement>("[data-vlist-text-preview-body]")];
		const buttons = [
			...list.querySelectorAll<HTMLButtonElement>("[data-vlist-text-preview-toggle]"),
		];
		const lines = [
			...list.querySelectorAll<HTMLElement>("[data-vlist-line], [data-vlist-code-line]"),
		];
		return {
			text: list.textContent ?? "",
			lines: lines.length,
			viewportHeights: bodies.map((node) => node.getBoundingClientRect().height),
			buttonPositions: buttons.map((node, index) =>
				node.getBoundingClientRect().top < (bodies[index]?.getBoundingClientRect().top ?? 0)
					? "top"
					: "bottom",
			),
			expanded: buttons.map((node) => node.getAttribute("aria-expanded") === "true"),
			rowHeight: rows.reduce((height, node) => height + node.getBoundingClientRect().height, 0),
			paintedBottom: Math.max(
				0,
				...lines.map(
					(node) =>
						node.getBoundingClientRect().bottom - (rows[0]?.getBoundingClientRect().top ?? 0),
				),
			),
		};
	},
};
