import "@mantine/core/styles.css";
import "../frontend/components/narrator/vlist/vlist-markdown.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import { RenderLodCtx } from "../frontend/components/narrator/lod/RenderLodCtx";
import { topLevelStreamingChunkToToolFields } from "../frontend/components/narrator/narrator-message-helpers";
import { getCategory } from "../frontend/components/narrator/tool-call/tool-display";
import type { MeasuredToolCall } from "../frontend/components/narrator/vlist/measure/measure-tool-call";
import { measureElement } from "../frontend/components/narrator/vlist/registry";
import {
	renderElement,
	resolveRenderExtra,
} from "../frontend/components/narrator/vlist/render-registry";
import {
	applyStreamingToolChunk,
	applyStreamingToolStarted,
	createStreamingToolStore,
} from "../frontend/components/narrator/vlist/streaming-tool-chunks";
import type { VListViewControls } from "../frontend/components/narrator/vlist/VListContentViewHost";
import { VListViewBody } from "../frontend/components/narrator/vlist/vlist-content-view-body";
import {
	resolveToolDetailViewTargets,
	type VListViewTarget,
} from "../frontend/components/narrator/vlist/vlist-content-view-target";
import { loadShiki } from "../frontend/lib/shiki-loader";
import common from "../frontend/locales/en/common.json";
import narrator from "../frontend/locales/en/narrator.json";
import { adaptSegment } from "../shared/pretext-layout/segment-adapter";
import { percentile, type WriteStreamCase, writeStreamText } from "./smoke-write-stream-data";

i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { common, narrator } },
	interpolation: { escapeValue: false },
});

interface DocumentRef {
	id: string;
	epoch: string;
	revision: number;
	length: number;
	complete: boolean;
	originKnown: boolean;
	preview?: string;
	source?: { narratorId: string; toolUseId: string; field: string };
}
interface DocumentWireBridge {
	receiveWriteDocument(
		update: { ref: DocumentRef; offset: number },
		text?: string,
		reader?: (
			ref: DocumentRef,
			offset: number,
			limit: number,
		) => Promise<{ ref: DocumentRef; offset: number; text: string }>,
	): DocumentRef;
	documentWriteInput(narratorId: string, toolUseId: string, input: unknown): unknown;
}
interface DocumentStore {
	register(
		ref: DocumentRef,
		reader: (
			ref: DocumentRef,
			offset: number,
			limit: number,
		) => Promise<{ ref: DocumentRef; offset: number; text: string }>,
	): void;
	readAll(id: string): Promise<string>;
	getSnapshot(id: string): DocumentRef | undefined;
}
export interface WriteStreamSnapshot {
	received: number;
	expected: number;
	done: boolean;
	mainHighlightCalls: number;
	longTasks: number;
	longTaskTotal: number;
	longTaskMax: number;
	heartbeatP95: number;
	heartbeatMax: number;
	frameP95: number;
	maxNodes: number;
	nodes: number;
	coloredSpans: number;
	bodyRows: number;
	bodyChars: number;
	bodyColors: number;
	highlightReady: boolean;
	bodyAlerts: string[];
	legacyPreviewLength: number;
	documentLength: number;
	elapsed: number;
	inputEvents: number;
	fullscreen: boolean;
	errors: string[];
}
export interface WriteStreamAudit {
	start(test: WriteStreamCase): void;
	snapshot(): WriteStreamSnapshot;
	fullTextMatches(): Promise<boolean>;
	clipboardMatches(): Promise<boolean>;
	clipboardDiagnostic(): Promise<unknown>;
	finish(): void;
	showFullscreen(): void;
	setWrap(wrap: boolean): void;
	scrollTo(top: number): void;
	viewport(): { scrollTop: number; scrollHeight: number; clientHeight: number };
}
declare global {
	interface Window {
		__writeStreamAudit: WriteStreamAudit;
	}
}

const host = document.getElementById("root");
if (!host) throw new Error("missing root");
const root = createRoot(host);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const errors: string[] = [];
window.addEventListener("error", (event) => {
	if (errors.length < 20) errors.push(String(event.message));
});
window.addEventListener("unhandledrejection", (event) => {
	if (errors.length < 20) errors.push(String(event.reason));
});

let docs: DocumentStore | undefined;
let bridge: DocumentWireBridge | undefined;
const config = await fetch("./fixture-info").then((response) => response.json());
if (config.storeEntry) {
	const moduleUrl = config.storeEntry as string;
	docs = (await import(/* @vite-ignore */ moduleUrl)).textDocumentStore;
	if (config.bridgeEntry) {
		const bridgeUrl = config.bridgeEntry as string;
		bridge = await import(/* @vite-ignore */ bridgeUrl);
	}
}
const shiki = await loadShiki();
if (shiki)
	await shiki.codeToTokens("export const warmup = 1", {
		lang: "typescript",
		theme: "github-dark-default",
	});
let clipboardError = "";
if (navigator.clipboard?.write) {
	const nativeWrite = navigator.clipboard.write.bind(navigator.clipboard);
	navigator.clipboard.write = (items) =>
		nativeWrite(items).catch((error) => {
			clipboardError = String(error).slice(0, 500);
			throw error;
		});
}
let mainHighlightCalls = 0;
if (shiki) {
	const native = shiki.codeToTokens.bind(shiki);
	shiki.codeToTokens = (...args) => {
		mainHighlightCalls++;
		return native(...args);
	};
}

let test: WriteStreamCase = { chars: 1_000 };
let text = "";
let received = 0;
let done = false;
let session = 0;
let callId = "";
let docId = "";
let stream = createStreamingToolStore();
let target: VListViewTarget | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let startedAt = performance.now();
let fullscreen = false;
let wordWrap = true;
let maxNodes = 0;
let inputEvents = 0;
const longTasks: number[] = [];
const heartbeats: number[] = [];
const frames: number[] = [];
try {
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries())
			if (entry.startTime >= startedAt && longTasks.length < 2_000) longTasks.push(entry.duration);
	}).observe({ type: "longtask", buffered: true });
} catch {
	/* The runner records whether Chromium supports longtask entries. */
}
let previousHeartbeat = performance.now();
setInterval(() => {
	const now = performance.now();
	if (!done && heartbeats.length < 10_000)
		heartbeats.push(Math.max(0, now - previousHeartbeat - 25));
	previousHeartbeat = now;
	maxNodes = Math.max(maxNodes, document.querySelectorAll("#card span").length);
}, 25);
let previousFrame = performance.now();
function observeFrames(now: number) {
	if (!done && frames.length < 10_000) frames.push(now - previousFrame);
	previousFrame = now;
	requestAnimationFrame(observeFrames);
}
requestAnimationFrame(observeFrames);

function ref(): DocumentRef {
	return {
		id: docId,
		epoch: `epoch-${session}`,
		revision: received,
		length: received,
		complete: done,
		originKnown: true,
		source: { narratorId: "fixture-narrator", toolUseId: callId, field: "content" },
	};
}
const controls: VListViewControls = {
	isWrapped: () => wordWrap,
	isSourceShown: () => false,
	toggleWrap: () => {
		wordWrap = !wordWrap;
		render();
	},
	toggleSource: () => {},
	openFullscreen: () => {
		fullscreen = true;
		render();
	},
	requestFullPayload: () => {},
};
function render() {
	const chunk = stream.get(callId);
	if (!chunk) return;
	const width = 640;
	const specs = adaptSegment(
		{
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: {
						toolUseId: callId,
						toolName: "Write",
						...topLevelStreamingChunkToToolFields(chunk),
					},
				},
			],
		},
		{
			lod: 5,
			isExpanded: () => true,
			isPromptOpen: () => true,
			viewportHeight: innerHeight,
			resolveToolCategory: getCategory,
		},
	);
	const spec = specs[0];
	if (!spec || spec.kind !== "tool-call") throw new Error(`wrong adapter branch ${spec?.kind}`);
	const measured = measureElement(spec.kind, spec.data, width, 5, spec.opts);
	const targets = resolveToolDetailViewTargets(spec.key, measured as MeasuredToolCall);
	target = targets.find((candidate) => candidate.slot === "input.content") ?? targets.at(-1);
	const card = renderElement(spec.kind, measured, {
		...resolveRenderExtra(spec),
		narratorId: "fixture-narrator",
		viewTargets: targets,
		viewControls: controls,
	});
	flushSync(() =>
		root.render(
			<MantineProvider forceColorScheme={test.theme ?? "dark"}>
				<QueryClientProvider client={client}>
					<RenderLodCtx value={{ lod: 5, interactive: true }}>
						<div key={session} style={{ margin: 24 }}>
							<input
								id="response-probe"
								aria-label="Response probe"
								onInput={() => inputEvents++}
							/>
							<button
								type="button"
								id="open-fullscreen"
								onClick={() => {
									fullscreen = true;
									render();
								}}
							>
								Full document
							</button>
							<div id="card" style={{ width }}>
								{card}
							</div>
							{fullscreen && target ? (
								<div
									id="full"
									style={{ width, height: 320, display: "flex", flexDirection: "column" }}
								>
									<VListViewBody
										target={target}
										wordWrap={wordWrap}
										showSource={false}
										text={target.text}
										layout={{ width, height: 320 }}
									/>
								</div>
							) : null}
						</div>
					</RenderLodCtx>
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
}
function next() {
	const offset = received;
	const end = Math.min(text.length, offset + (test.chunkChars ?? 512));
	received = end;
	let descriptor = ref();
	const reader = async (_ref: DocumentRef, start: number, limit: number) => ({
		ref: ref(),
		offset: start,
		text: text.slice(start, Math.min(received, start + limit)),
	});
	if (bridge) {
		descriptor = bridge.receiveWriteDocument(
			{ ref: descriptor, offset },
			text.slice(offset, end),
			reader,
		);
	} else if (docs) {
		docs.register(descriptor, reader);
	}

	applyStreamingToolChunk(stream, {
		toolUseId: callId,
		toolName: "Write",
		inputCharsTotal: received + 64,
		extractedFilePath: "/fixture/example.ts",
		extractedFields: { file_path: "/fixture/example.ts" },
		streamingField: { name: "content", delta: text.slice(offset, end), startsField: offset === 0 },
		...(docs ? { inputDocument: { ref: descriptor, offset } } : {}),
	});
	render();
	if (received < text.length) timer = setTimeout(next, test.intervalMs ?? 50);
	else done = true;
}
function viewport(): HTMLElement {
	const node = document.querySelector<HTMLElement>("#card [data-content-scrollport]");
	if (!node) throw new Error("missing scroll viewport");
	return node;
}
window.__writeStreamAudit = {
	start(options) {
		if (timer) clearTimeout(timer);
		test = options;
		text = writeStreamText(options);
		received = 0;
		done = false;
		session++;
		callId = `fixture-write-${session}`;
		docId = `fixture-document-${session}`;
		stream = createStreamingToolStore();
		fullscreen = false;
		wordWrap = true;
		mainHighlightCalls = 0;
		maxNodes = 0;
		inputEvents = 0;
		longTasks.length = 0;
		heartbeats.length = 0;
		frames.length = 0;
		errors.length = 0;
		startedAt = performance.now();
		previousFrame = startedAt;
		previousHeartbeat = startedAt;
		next();
	},
	snapshot() {
		const body = document.querySelector<HTMLElement>("#card [data-document-code-body]");
		const rows = body?.querySelectorAll<HTMLElement>("[data-document-visual-row]");
		const bodySpans = Array.from(
			body?.querySelectorAll<HTMLElement>("[data-document-visual-row] span") ?? [],
		);
		return {
			received,
			expected: text.length,
			done,
			mainHighlightCalls,
			longTasks: longTasks.length,
			longTaskTotal: longTasks.reduce((sum, value) => sum + value, 0),
			longTaskMax: Math.max(0, ...longTasks),
			heartbeatP95: percentile(heartbeats, 0.95),
			heartbeatMax: Math.max(0, ...heartbeats),
			frameP95: percentile(frames, 0.95),
			maxNodes,
			nodes: document.querySelectorAll("#card span").length,
			coloredSpans: document.querySelectorAll('#card span[style*="color"]').length,
			bodyRows: rows?.length ?? 0,
			bodyChars: bodySpans.reduce((total, span) => total + (span.textContent?.length ?? 0), 0),
			bodyColors: new Set(bodySpans.map((span) => span.style.color).filter(Boolean)).size,
			highlightReady: !!body && body.getAttribute("aria-busy") === "false",
			bodyAlerts: Array.from(body?.querySelectorAll('[role="alert"]') ?? []).map(
				(alert) => alert.textContent ?? "",
			),
			legacyPreviewLength: stream.get(callId)?.streamingFieldValue?.length ?? 0,
			documentLength: docs?.getSnapshot(docId)?.length ?? 0,
			elapsed: performance.now() - startedAt,
			inputEvents,
			fullscreen,
			errors: [...errors],
		};
	},
	async fullTextMatches() {
		if (docs) return (await docs.readAll(docId)) === text.slice(0, received);
		return (stream.get(callId)?.streamingFieldValue ?? "") === text.slice(0, received);
	},
	async clipboardMatches() {
		return (await navigator.clipboard.readText()) === text.slice(0, received);
	},
	async clipboardDiagnostic() {
		return {
			error: clipboardError,
			focused: document.hasFocus(),
			activation: navigator.userActivation?.isActive,
			fullText: await this.fullTextMatches().catch((error) => String(error)),
			permission: await navigator.permissions
				.query({ name: "clipboard-write" as PermissionName })
				.then((result) => result.state)
				.catch((error) => String(error)),
		};
	},
	finish() {
		if (timer) clearTimeout(timer);
		done = true;
		applyStreamingToolStarted(stream, {
			toolUseId: callId,
			toolName: "Write",
			input: (bridge?.documentWriteInput("fixture-narrator", callId, {
				file_path: "/fixture/example.ts",
				content: text.slice(0, received),
			}) ?? { file_path: "/fixture/example.ts", content: text.slice(0, received) }) as Record<
				string,
				unknown
			>,
		});
		render();
	},
	showFullscreen() {
		fullscreen = true;
		render();
	},
	setWrap(value) {
		wordWrap = value;
		render();
	},
	scrollTo(top) {
		viewport().scrollTop = top;
	},
	viewport() {
		const node = viewport();
		return {
			scrollTop: node.scrollTop,
			scrollHeight: node.scrollHeight,
			clientHeight: node.clientHeight,
		};
	},
};
window.__writeStreamAudit.start({ chars: 1_000, chunkChars: 1_000, intervalMs: 1 });
