import { afterAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { measureCommunicationBubble } from "../measure/measure-communication-bubble";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { renderElement, resolveRenderExtra } from "../render-registry";
import {
	RenderCommunicationBubble,
	type RenderCommunicationBubbleProps,
} from "./RenderCommunicationBubble";

const disposeCanvas = installCanvasStub();
afterAll(disposeCanvas);
const labels = {
	communicationBroadcast: "全体",
	communicationRecipientUnknown: "未知收件人",
	communicationRunning: "发送中",
	communicationSuccess: "已发送",
	communicationError: "发送失败",
	communicationCancelled: "已取消",
	communicationWaiting: "等待中",
	communicationViewFull: "查看全文",
	sendAwaitReply: "等待回复",
	sendNoAwaitReply: "不等待回复",
};
const data = {
	message: "**Hello**\n\n- first\n- second",
	recipients: [
		{ label: "Reviewer", id: "r1" },
		{ label: "Planner", id: "r2" },
	],
	status: "success",
	awaitReply: false,
	labels,
};
function render(props: Partial<RenderCommunicationBubbleProps> = {}) {
	const measured = props.measured ?? measureCommunicationBubble(data, 800);
	const markup = renderToStaticMarkup(
		<MantineProvider>
			<RenderCommunicationBubble measured={measured} data={data} {...props} />
		</MantineProvider>,
	);
	return parseHTML(`<html><body>${markup}</body></html>`).document;
}
function marker(node: ReactNode, key: string): ReactElement<Record<string, unknown>> | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = marker(child, key);
			if (found) return found;
		}
		return undefined;
	}
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (key in node.props) return node;
	return marker(node.props.children as ReactNode, key);
}

describe("outgoing communication bubble", () => {
	test("renders recipient chips above expanded markdown with a tinted left-aligned frame", () => {
		const document = render({ onOpenRecipient: () => {} });
		const row = document.querySelector("[data-vlist-communication-row]");
		const frame = document.querySelector("[data-vlist-communication-frame]");
		const measured = measureCommunicationBubble(data, 800);
		expect(row?.getAttribute("style")).toContain("justify-content:flex-start");
		expect(frame?.getAttribute("style")).toContain("border-radius:8px");
		expect(frame?.getAttribute("style")).toContain(
			"background:light-dark(var(--mantine-color-indigo-0), color-mix(in srgb, var(--mantine-color-indigo-8) 30%, var(--mantine-color-dark-6)))",
		);
		expect(frame?.getAttribute("style")).toContain(`height:${measured.height}px`);
		expect(document.querySelectorAll("[data-vlist-communication-recipient]").length).toBe(2);
		expect(document.querySelector("[data-vlist-communication-header]")?.textContent).toContain(
			"@Reviewer",
		);
		expect(document.querySelector("[data-vlist-communication-body]")?.textContent).toContain(
			"Hello",
		);
		expect(document.querySelector("[data-vlist-communication-body]")?.textContent).not.toContain(
			"**Hello**",
		);
		expect(document.querySelector("[data-vlist-communication-meta]")?.textContent).toBe(
			"不等待回复 · 已发送",
		);
		expect(
			document.querySelector("[data-vlist-communication-meta]")?.getAttribute("style"),
		).toContain("--mantine-color-dimmed");
		expect(document.querySelector("[data-vlist-communication-view-full]")).toBeNull();
		expect(document.body.textContent).not.toContain("Agent");
	});

	test("recipient click opens its target without taking over the context menu", () => {
		const opened: unknown[] = [];
		let stopped = false;
		const node = RenderCommunicationBubble({
			measured: measureCommunicationBubble(data, 800),
			data: {
				...data,
				recipients: [{ id: "r1", label: "Reviewer", deliveryMessageId: "receipt-1" }],
			},
			onOpenRecipient: (...args) => opened.push(args),
		});
		const chip = marker(node, "data-vlist-communication-recipient");
		expect(chip?.props["data-vlist-communication-recipient"]).toBe("r1");
		(chip?.props.onClick as (event: { stopPropagation: () => void }) => void)({
			stopPropagation: () => {
				stopped = true;
			},
		});
		expect(opened).toEqual([["r1", "receipt-1"]]);
		expect(stopped).toBe(true);
		expect(chip?.props.onContextMenu).toBeUndefined();
	});

	test("long message keeps errors visible and opens full text through the host", () => {
		const longData = {
			...data,
			message: "paragraph\n\n".repeat(4000),
			status: "error",
			error: "Recipient unavailable",
		};
		const measured = measureCommunicationBubble(longData, 800);
		let opened = false;
		const props = {
			measured,
			data: longData,
			onViewFull: () => {
				opened = true;
			},
		};
		const document = render(props);
		expect(
			document.querySelector("[data-vlist-communication-body]")?.getAttribute("style"),
		).toContain("height:480px");
		expect(document.querySelector("[data-vlist-communication-error]")?.textContent).toBe(
			"Recipient unavailable",
		);
		expect(document.querySelector("[data-vlist-communication-view-full]")?.textContent).toBe(
			"… · 查看全文",
		);
		expect(document.querySelector("[data-vlist-communication-truncated]")?.textContent).toBe(
			"… · ",
		);
		const action = marker(RenderCommunicationBubble(props), "data-vlist-communication-view-full");
		(action?.props.onClick as (event: { stopPropagation: () => void }) => void)({
			stopPropagation: () => {},
		});
		expect(opened).toBe(true);
	});

	test("broadcast, unknown recipients, await and cancelled states retain localized labels", () => {
		expect(
			render({ data: { ...data, broadcast: true, recipients: [], awaitReply: true } }).body
				.textContent,
		).toContain("@全体等待回复");
		expect(
			render({ data: { ...data, recipients: [], status: "cancelled" } }).body.textContent,
		).toContain("@未知收件人不等待回复 · 已取消");
	});

	test("real fail status renders failure, never sending, with or without extracted output text", () => {
		for (const error of [undefined, "Target is not available"]) {
			const failed = { ...data, status: "fail", error };
			const document = render({ data: failed, measured: measureCommunicationBubble(failed, 800) });
			expect(document.querySelector("[data-vlist-communication-meta]")?.textContent).toBe(
				"不等待回复 · 发送失败",
			);
			expect(document.querySelector("[data-vlist-communication-error]")?.textContent).toBe(
				error ?? "发送失败",
			);
			expect(document.querySelector("[data-vlist-communication-body]")?.textContent).toContain(
				"Hello",
			);
			expect(document.body.textContent).not.toContain("发送中");
		}
	});

	test("warnings never paint as failed and errors take priority over warnings", () => {
		const warningData = { ...data, warning: "Message queued while the agent is busy" };
		const document = render({
			measured: measureCommunicationBubble(warningData, 800),
			data: warningData,
		});
		expect(document.querySelector("[data-vlist-communication-error]")).toBeNull();
		expect(document.querySelector("[data-vlist-communication-warning]")?.textContent).toBe(
			warningData.warning,
		);
		expect(document.querySelector("[data-vlist-communication-meta]")?.textContent).toBe(
			"不等待回复 · 已发送",
		);
		const failed = { ...warningData, error: "Delivery failed" };
		const failedDoc = render({ measured: measureCommunicationBubble(failed, 800), data: failed });
		expect(failedDoc.querySelector("[data-vlist-communication-warning]")).toBeNull();
		expect(failedDoc.querySelector("[data-vlist-communication-error]")?.textContent).toBe(
			failed.error,
		);
	});

	test("awaited running messages wait, while timeouts and aborts never look successful", () => {
		const waiting = render({ data: { ...data, status: "running", awaitReply: true } });
		expect(waiting.querySelector("[data-vlist-communication-meta]")?.textContent).toBe(
			"等待回复 · 等待中",
		);
		for (const status of ["timeout", "aborted"]) {
			const document = render({ data: { ...data, status, awaitReply: true } });
			expect(document.querySelector("[data-vlist-communication-meta]")?.textContent).toBe(
				"等待回复 · 已取消",
			);
		}
	});

	test("narrow rows bound the header and preserve all individual recipient controls", () => {
		const narrow = {
			...data,
			recipients: Array.from({ length: 8 }, (_, i) => ({
				id: `target-${i}`,
				label: `Long recipient ${i}`,
			})),
		};
		const measured = measureCommunicationBubble(narrow, 180);
		const document = render({ data: narrow, measured, onOpenRecipient: () => {} });
		expect(measured.usedWidth).toBeLessThanOrEqual(Math.floor(180 * 0.86));
		expect(document.querySelectorAll("[data-vlist-communication-recipient]").length).toBe(8);
		const style = document
			.querySelector("[data-vlist-communication-recipients]")
			?.getAttribute("style");
		expect(style).toContain("overflow-x:auto");
		expect(style).toContain("height:20px");
		expect(style).toContain("scrollbar-width:none");
		const broadcast = render({ data: { ...narrow, broadcast: true } });
		expect(broadcast.querySelectorAll("[data-vlist-communication-recipient]").length).toBe(0);
		expect(broadcast.querySelector("[data-vlist-communication-recipients]")?.textContent).toBe(
			"@全体",
		);
	});

	test("registry passes live data and both host callbacks through unchanged", () => {
		const extra = resolveRenderExtra({ kind: "communication-bubble", data });
		const onViewFull = () => {};
		const onOpenRecipient = (_id: string) => {};
		expect(extra.data).toBe(data);
		const node = renderElement("communication-bubble", measureCommunicationBubble(data, 800), {
			...extra,
			onViewFull,
			onOpenRecipient,
		});
		expect(isValidElement(node)).toBe(true);
		if (!isValidElement<RenderCommunicationBubbleProps>(node)) throw new Error("missing bubble");
		expect(node.type).toBe(RenderCommunicationBubble);
		expect(node.props.data).toBe(data);
		expect(node.props.onOpenRecipient).toBe(onOpenRecipient);
		expect(node.props.onViewFull).toBe(onViewFull);
	});
});
