import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { FileReference, FileReferenceSnapshot, FileTarget } from "@shared/file-reference";
import { fileReferenceLabel } from "@shared/file-reference-display";
import { type AdapterMessage, adaptSegments } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileReferenceScopeProvider } from "../../FileReferenceScope";
import { buildStreamingMsg, type StreamingBlock } from "../../message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import {
	applyStreamingDelta,
	applyStreamingSnapshotBlocks,
} from "../../streaming/streaming-delta-fold";
import { TEXT_FILE_HEIGHT } from "../measure/measure-media";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { buildCacheKey, extractDataRevision } from "../measure-cache";
import { measureElement, measureElementCached } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { VListViewBody } from "../vlist-content-view-body";
import { resolveRowViewTargets } from "../vlist-content-view-target";
import { buildSelectionIndex } from "../vlist-selection";

const reference: FileReference = {
	id: "ref-1",
	deviceId: "DeviceA",
	path: "/repo/src/a.ts",
	label: "src/a.ts",
	selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 5, endColumn: 1 },
};
const snapshot: FileReferenceSnapshot = {
	type: "file_reference",
	reference,
	snapshotText: "HIDDEN_SNAPSHOT_BODY".repeat(6000),
	snapshotHash: "hash",
	capturedAt: "2026-09-07T00:00:00Z",
};
const globals = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"getComputedStyle",
	"matchMedia",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
let previous: Map<string, PropertyDescriptor | undefined>;
let dispose: () => void;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	dispose = installCanvasStub();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		getComputedStyle: window.getComputedStyle,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	dispose();
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function specs(message: AdapterMessage) {
	return adaptSegments([{ kind: "message", msg: message }], { lod: 4 });
}

async function renderMessage(message: AdapterMessage, opened: FileTarget[]) {
	const items = specs(message);
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<FileReferenceScopeProvider
					value={{
						context: { deviceId: "CURRENT_DEFAULT", cwd: "/wrong" },
						openFile: (target) => opened.push(target),
					}}
				>
					{items.map((spec) => (
						<div key={spec.key}>
							{renderElement(
								spec.kind,
								measureElement(spec.kind, spec.data, 700, 4, spec.opts),
								resolveRenderExtra(spec),
							)}
						</div>
					))}
				</FileReferenceScopeProvider>
			</MantineProvider>,
		),
	);
}

function click(element: Element) {
	const event = new window.Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "button", { value: 0 });
	act(() => element.dispatchEvent(event));
}

describe("captured message file references", () => {
	test("history and stream/reconnect preserve device scopes instead of the current default", async () => {
		const blocks: StreamingBlock[] = [];
		const context = { deviceId: "CapturedDevice", cwd: "/repo" };
		applyStreamingDelta(
			blocks,
			{
				type: "content_block_delta",
				outputIndex: 0,
				fileReferenceContext: context,
				delta: { type: "text_delta", text: "[file](src/a.ts#L2)" },
			},
			false,
		);
		applyStreamingDelta(
			blocks,
			{
				type: "content_block_delta",
				outputIndex: 0,
				fileReferenceContext: { deviceId: "ChangedDevice", cwd: "/other" },
				delta: { type: "text_delta", text: "." },
			},
			false,
		);
		expect(blocks[0]).toMatchObject({ fileReferenceContext: context });
		const reconnected: StreamingBlock[] = [];
		applyStreamingSnapshotBlocks(reconnected, JSON.parse(JSON.stringify(blocks)));
		const streamed = buildStreamingMsg({
			narratorId: "n",
			streamingBlocks: reconnected,
		}) as NarratorMsg;
		for (const message of [
			streamed,
			{
				...streamed,
				id: "reloaded",
				contentJson: JSON.parse(JSON.stringify(streamed.contentJson)),
			},
		]) {
			const opened: FileTarget[] = [];
			await renderMessage(message as unknown as AdapterMessage, opened);
			const link = container.querySelector("a[href]");
			expect(link).not.toBeNull();
			if (link) click(link);
			expect(opened).toEqual([
				{
					deviceId: "CapturedDevice",
					path: "/repo/src/a.ts",
					selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
				},
			]);
			const spec = specs(message as unknown as AdapterMessage)[0];
			expect(resolveRowViewTargets(spec)[0]?.fileReferenceContext).toEqual(context);
		}
	});

	test("reused provider indices keep separate text identities and devices before handoff", async () => {
		for (const outputIndex of [undefined, 0]) {
			const blocks: StreamingBlock[] = [];
			for (const deviceId of ["A", "B"]) {
				applyStreamingDelta(
					blocks,
					{
						type: "content_block_delta",
						outputIndex,
						fileReferenceContext: { deviceId, cwd: "/repo" },
						delta: { type: "text_delta", id: `lane-${deviceId}`, text: "[same](src/a.ts)" },
					},
					false,
				);
			}
			expect(blocks).toHaveLength(2);
			const restored: StreamingBlock[] = [];
			applyStreamingSnapshotBlocks(restored, JSON.parse(JSON.stringify(blocks)));
			expect(restored).toHaveLength(2);
			const opened: FileTarget[] = [];
			const message = buildStreamingMsg({
				narratorId: "n",
				streamingBlocks: restored,
			}) as unknown as AdapterMessage;
			await renderMessage(message, opened);
			for (const link of Array.from(container.querySelectorAll("a[href]"))) click(link);
			expect(opened.map((target) => target.deviceId)).toEqual(["A", "B"]);
		}
	});

	test("unknown historic context disables inference but explicit nf-file remains usable", async () => {
		const opened: FileTarget[] = [];
		await renderMessage(
			{
				id: "unknown",
				role: "assistant",
				contentJson: [
					{
						type: "text",
						text: "[old](src/a.ts) [explicit](nf-file://open?device=ExplicitDevice&path=%2Frepo%2Fa.ts#L3)",
					},
				],
			},
			opened,
		);
		const links = Array.from(container.querySelectorAll("a[href]"));
		expect(links).toHaveLength(1);
		for (const link of links) click(link);
		expect(opened[0]).toMatchObject({ deviceId: "ExplicitDevice", path: "/repo/a.ts" });
	});

	test("fullscreen markdown inherits the selected block, not the live narrator scope", async () => {
		for (const fileReferenceContext of [{ deviceId: "HistoryDevice", cwd: "/repo" }, undefined]) {
			const spec = specs({
				id: "full",
				role: "assistant",
				contentJson: [{ type: "text", text: "[same](src/a.ts)", fileReferenceContext }],
			})[0];
			const target = resolveRowViewTargets(spec)[0];
			if (!target) throw new Error("Expected fullscreen markdown target");
			const opened: FileTarget[] = [];
			await act(async () =>
				root.render(
					<MantineProvider env="test">
						<FileReferenceScopeProvider
							value={{
								context: { deviceId: "CURRENT", cwd: "/wrong" },
								openFile: (value) => opened.push(value),
							}}
						>
							<VListViewBody target={target} text={target.text} wordWrap showSource={false} />
						</FileReferenceScopeProvider>
					</MantineProvider>,
				),
			);
			const links = Array.from(container.querySelectorAll("a[href]"));
			expect(links).toHaveLength(fileReferenceContext ? 1 : 0);
			for (const link of links) click(link);
			expect(opened).toEqual(
				fileReferenceContext ? [{ deviceId: "HistoryDevice", path: "/repo/src/a.ts" }] : [],
			);
		}
	});

	test("user references are visible, clickable fixed rows with no snapshot body", async () => {
		const message: AdapterMessage = {
			id: "user",
			role: "user",
			contentJson: [{ ...snapshot }, { type: "text", text: "please review" }],
		};
		const opened: FileTarget[] = [];
		await renderMessage(message, opened);
		const row = container.querySelector('[role="button"]');
		expect(row?.textContent).toContain("/repo/src/a.ts:2-4");
		expect(row?.textContent).toContain("DeviceA");
		if (row) click(row);
		expect(opened).toEqual([reference]);
		const spec = specs(message)[0];
		expect(JSON.stringify(spec)).not.toContain("HIDDEN_SNAPSHOT_BODY");
		expect(container.textContent).not.toContain("HIDDEN_SNAPSHOT_BODY");
		const measured = measureElement(spec.kind, spec.data, 700, 4);
		expect(measured.blocks[0]).toMatchObject({
			kind: "fixed",
			tag: "user-file-reference",
			height: TEXT_FILE_HEIGHT,
		});
		expect(Number.parseFloat((row as HTMLElement).style.height)).toBe(TEXT_FILE_HEIGHT);
		const summarySpec = specs({
			...message,
			contentJson: [
				{ type: "file_reference", reference },
				{ type: "text", text: "please review" },
			],
		})[0];
		expect(measureElement(summarySpec.kind, summarySpec.data, 700, 4)).toEqual(measured);
		const copy = buildSelectionIndex([
			{ ...message, seq: 1, contentText: "please review" } as NarratorMsg,
		]).entries[0]?.copyText;
		expect(copy).toBe("please review");
		const refOnly = buildSelectionIndex([
			{ ...message, seq: 1, contentText: "", contentJson: [snapshot] } as unknown as NarratorMsg,
		]).entries[0]?.copyText;
		expect(refOnly).toBe(fileReferenceLabel(reference));
	});

	test("slash-command and reference-only bubbles retain attachment rows", async () => {
		const message: AdapterMessage = {
			id: "command-ref",
			role: "user",
			commandText: "/review",
			contentJson: [{ ...snapshot }, { type: "text", text: "expanded command" }],
		};
		const opened: FileTarget[] = [];
		await renderMessage(message, opened);
		const row = container.querySelector('[role="button"]');
		expect(row?.textContent).toContain("/repo/src/a.ts:2-4");
		if (row) click(row);
		expect(opened).toEqual([reference]);
		const spec = specs(message)[0];
		const plain = specs({
			...message,
			contentJson: [{ type: "text", text: "expanded command" }],
		})[0];
		const measured = measureElement(spec.kind, spec.data, 700, 4, spec.opts);
		const withoutReference = measureElement(plain.kind, plain.data, 700, 4, plain.opts);
		expect(measured.height - withoutReference.height).toBe(TEXT_FILE_HEIGHT + 4);
		expect(measured.frame.blocks[0]?.height).toBe(TEXT_FILE_HEIGHT);
		expect(container.textContent).not.toContain("HIDDEN_SNAPSHOT_BODY");
		await renderMessage({ id: "only-ref", role: "user", contentJson: [{ ...snapshot }] }, []);
		expect(container.querySelector('[role="button"]')?.textContent).toContain("/repo/src/a.ts:2-4");
	});

	test("same file on another device cannot reuse a stale clickable cache payload", () => {
		const data = (deviceId: string) => ({
			role: "user",
			text: "",
			attachments: [{ type: "file_reference", reference: { ...reference, deviceId } }],
		});
		expect(extractDataRevision(data("A"))).not.toBe(extractDataRevision(data("B")));
		const a = measureElementCached(
			"message-bubble",
			data("A"),
			700,
			4,
			undefined,
			"same-reference",
		);
		const b = measureElementCached(
			"message-bubble",
			data("B"),
			700,
			4,
			undefined,
			"same-reference",
		);
		expect(a).not.toBe(b);
		expect(a.height).toBe(b.height);
		expect(
			buildCacheKey("k", "markdown", 700, 4, {
				fileReferenceContext: { deviceId: "A", cwd: "/repo" },
			}),
		).not.toBe(
			buildCacheKey("k", "markdown", 700, 4, {
				fileReferenceContext: { deviceId: "B", cwd: "/repo" },
			}),
		);
	});
});
