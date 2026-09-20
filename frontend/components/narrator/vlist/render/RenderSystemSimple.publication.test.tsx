import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { VLIST_REGISTRY } from "../registry";
import type { UseVListContentViewResult } from "../useVListContentView";
import type { VListRenderLabels } from "../useVListLabels";
import type { VListContentViewModalProps } from "../VListContentViewModal";
import type { RowToggles } from "../vlist-exact-row-state";
import type { VListItem } from "../vlist-pipeline";

// Keep the real adapter, measurement, ExactRow dispatch and list-owned state.
// Only replace the fullscreen shell and preference transport, not modal ownership.
mock.module("@frontend/hooks/useUserPreferences", () => ({
	useUserPreferences: () => ({ data: {} }),
}));
mock.module("../VListContentViewModal", () => ({
	VListContentViewModal: ({
		target,
		onClose,
		wordWrap,
		showSource,
		onToggleWrap,
		onToggleSource,
	}: VListContentViewModalProps) => (
		<div role="dialog" data-wrap={wordWrap} data-source={showSource}>
			<h2>{target.title}</h2>
			<pre>{target.text}</pre>
			<button type="button" onClick={onToggleWrap}>
				wrap
			</button>
			<button type="button" onClick={onToggleSource}>
				source
			</button>
			<button type="button" onClick={onClose}>
				close
			</button>
		</div>
	),
}));
const realI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
	...realI18next,
	useTranslation: () => ({
		t: (key: string) =>
			({
				publicationResultOpen: "结果快照 · 点击查看",
				publicationResultTitle: "结果快照",
				publicationResultTruncated: "此快照仅保存了预览，并非完整结果。",
			})[key] ?? key,
	}),
}));
const { ExactRow } = await import("../ExactRow");
const { useVListContentView } = await import("../useVListContentView");
const { VListContentViewModal } = await import("../VListContentViewModal");
const requestFullPayload = mock(() => {});
let contentView: UseVListContentViewResult;
const noop = () => {};
const toggles: RowToggles = {
	onToggle: noop,
	onToggleItems: noop,
	onToggleEarlier: noop,
	onToggleRow: noop,
	onToggleTranslation: noop,
	onTogglePrompt: noop,
	onToggleFileChanges: noop,
};
const labels = { reasoning: { reasoning: "Reasoning", thinking: "Thinking" } } as VListRenderLabels;

function ListHost({ item, rowMounted }: { item: VListItem; rowMounted: boolean }) {
	contentView = useVListContentView({ requestFullPayload });
	return (
		<>
			{rowMounted && (
				<ExactRow
					item={item}
					top={0}
					height={item.measured.height}
					hitHeight={item.measured.height}
					contentWidth={320}
					itemId={item.spec.key}
					sourceIds={["publication-result:run"]}
					interactionSig=""
					toggles={toggles}
					renderLabels={labels}
					narratorId="owner"
					viewControls={contentView.controls}
				/>
			)}
			{contentView.openTarget && (
				<VListContentViewModal
					target={contentView.openTarget}
					wordWrap={contentView.openWrapped}
					showSource={contentView.openSourceShown}
					onToggleWrap={() =>
						contentView.openTarget && contentView.controls.toggleWrap(contentView.openTarget)
					}
					onToggleSource={() =>
						contentView.openTarget && contentView.controls.toggleSource(contentView.openTarget)
					}
					onClose={contentView.close}
				/>
			)}
		</>
	);
}

const originals = new Map<string, PropertyDescriptor | undefined>();
let event: (name: string, key?: string) => Event;
beforeAll(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(values)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	event = (name, key) => {
		const e = new window.Event(name, { bubbles: true, cancelable: true });
		if (key) Object.defineProperty(e, "key", { value: key });
		return e as unknown as Event;
	};
});
afterAll(() => {
	mock.restore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test.each([
	"click",
	"Enter",
	" ",
])("snapshot opens with %s and survives virtual-row eviction", async (action) => {
	requestFullPayload.mockClear();
	const spec = adaptSegment(
		{
			kind: "message",
			msg: {
				id: "publication-result:run",
				role: "disp",
				contentJson: [
					{
						type: "text",
						text: "unique snapshot body",
						publicationResult: {
							logicalRunId: "run",
							truncated: true,
							originalBytes: 99000,
							sourceResultRef: "message:answer",
						},
					},
				],
			},
		},
		{ lod: 1 },
	)[0];
	if (!spec) throw new Error("Missing snapshot spec");
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 320, 1);
	const item = { spec, measured };
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => {
			root.render(<ListHost item={item} rowMounted />);
		});
		const button = host.querySelector("button");
		if (!button) throw new Error("Missing snapshot button");
		expect(button.textContent).toBe("结果快照 · 点击查看");
		expect(host.textContent).not.toContain("unique snapshot body");
		expect(host.querySelector("[role=dialog]")).toBeNull();
		expect(button.style.height).toBe(`${measured.height}px`);
		await act(async () => {
			button.dispatchEvent(event(action === "click" ? "click" : "keydown", action));
		});
		const dialog = host.querySelector("[role=dialog]");
		expect(dialog?.textContent).toContain("unique snapshot body");
		expect(dialog?.textContent).toContain("此快照仅保存了预览，并非完整结果。");
		expect(button.style.height).toBe(`${measured.height}px`);
		expect(contentView.openTarget?.owner.specKey).toBe(spec.key);
		expect(requestFullPayload).not.toHaveBeenCalled();

		// Simulate virtualization removing the row, while its list host stays mounted.
		await act(async () => {
			root.render(<ListHost item={item} rowMounted={false} />);
		});
		expect(host.querySelector("[data-nf-row-key]")).toBeNull();
		expect(button.isConnected).toBe(false);
		expect(host.querySelector("[role=dialog]")).toBe(dialog);
		expect(dialog?.textContent).toContain("unique snapshot body");
		for (const label of ["wrap", "source"]) {
			await act(async () => {
				Array.from(dialog?.querySelectorAll("button") ?? [])
					.find((b) => b.textContent === label)
					?.dispatchEvent(event("click"));
			});
		}
		expect(dialog?.getAttribute("data-wrap")).toBe("false");
		expect(dialog?.getAttribute("data-source")).toBe("true");
		await act(async () => {
			dialog?.querySelector("button:last-child")?.dispatchEvent(event("click"));
		});
		expect(host.querySelector("[role=dialog]")).toBeNull();
		expect(contentView.openTarget).toBeNull();
		expect(host.textContent).not.toContain("unique snapshot body");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
