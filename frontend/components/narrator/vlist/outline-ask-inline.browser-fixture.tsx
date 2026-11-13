import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/outline.json";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { ExactRow, type ExactRowProps } from "./ExactRow";
import { VLIST_REGISTRY } from "./registry";
import { type AdapterSegment, adaptSegments } from "./segment-adapter";
import { useOutlineAskSlots } from "./vlist-outline-ask-bridge";
import { buildToolMetaIndex } from "./vlist-tool-meta";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { outline: en } },
	interpolation: { escapeValue: false },
});
const client = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const inputJson = {
	questions: [
		{ question: "First question?", items: [{ question: "Child question?" }] },
		{ question: "Second question?" },
	],
};
const outputJson = {
	_text: "Asked three questions",
	_metadata: { blockIds: ["first", "child", "second"], groupBlockId: "shared-task" },
};
const message = rowWithElements(
	{
		id: "message",
		narratorId: "n",
		role: "assistant",
		toolCalls: [{ toolUseId: "ask", toolName: "Ask", inputJson, outputJson, status: "success" }],
	},
	[
		{
			type: "tool_use",
			id: "ask",
			name: "Ask",
			input: inputJson,
			inputJson,
			outputJson,
			status: "success",
		},
	],
) as unknown as NarratorMsg;
const tools = buildToolMetaIndex([message]);
const segments = segmentMessages([message]) as unknown as AdapterSegment[];
const noop = () => {};

function Fixture({ enabled, width }: { enabled: boolean; width: number }) {
	const [opened, setOpened] = useState<boolean | undefined>();
	const [visible, setVisible] = useState(true);
	const [override, setOverride] = useState<number>();
	const report = useCallback(
		(height: number) =>
			setOverride((old) => (old !== undefined && Math.abs(old - height) <= 1 ? old : height)),
		[],
	);
	const items = useMemo(
		() =>
			adaptSegments(segments, {
				lod: 3,
				resolveToolCategory: () => "outline",
				isExpanded: () => opened,
			})
				.filter((spec) => spec.kind === "tool-call")
				.map((spec) => ({
					spec,
					measured: VLIST_REGISTRY[spec.kind].measure(spec.data, width, 3, spec.opts),
				})),
		[opened, width],
	);
	const slots = useOutlineAskSlots({ renderItems: items, tools, enabled });
	const item = items[0];
	if (!item) throw new Error("Ask card missing");
	const slot = slots.get(item.spec.key);
	const height = slot ? (override ?? item.measured.height) : item.measured.height;
	const onToggle = () => setOpened((previous) => previous === false);
	const props: ExactRowProps = {
		item,
		top: 0,
		height,
		hitHeight: height,
		contentWidth: width,
		itemId: "ask-row",
		sourceIds: ["message"],
		narratorId: "n",
		interactionSig: "outline-ask-fixture",
		toggles: {
			onToggle,
			onToggleItems: noop,
			onToggleEarlier: noop,
			onToggleRow: noop,
			onToggleTranslation: noop,
			onTogglePrompt: noop,
			onToggleFileChanges: noop,
			onPlanTree: noop,
		},
		renderLabels: {} as ExactRowProps["renderLabels"],
		outlineAskSlot: slot,
		onUnknownHeight: slot ? report : undefined,
	};
	return (
		<>
			<button type="button" id="fold" onClick={onToggle}>
				Fold
			</button>
			<button type="button" id="mount" onClick={() => setVisible((value) => !value)}>
				Mount
			</button>
			<div
				id="canvas"
				style={{ position: "relative", width, height: height + 40 }}
				data-height={height}
			>
				{visible && <ExactRow {...props} />}
				<div id="following" style={{ position: "absolute", top: height + 8 }}>
					Following row
				</div>
			</div>
		</>
	);
}
const root = createRoot(document.getElementById("root") as HTMLElement);
export function mount(enabled = true, width = 360) {
	root.render(
		<QueryClientProvider client={client}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<Fixture key={`${enabled}-${width}`} enabled={enabled} width={width} />
				</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
}
