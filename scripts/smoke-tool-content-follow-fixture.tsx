// Real adapter, registry, measurement, browser layout and scroll host; only data is fixed.
import "@mantine/core/styles.css";
import "../frontend/components/narrator/vlist/vlist-markdown.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import { ContentViewer } from "../frontend/components/narrator/content/ContentViewer";
import { RenderLodCtx } from "../frontend/components/narrator/lod/RenderLodCtx";
import { topLevelStreamingChunkToToolFields } from "../frontend/components/narrator/narrator-message-helpers";
import { getCategory } from "../frontend/components/narrator/tool-call/tool-display";
import type { MeasuredSubagent } from "../frontend/components/narrator/vlist/measure/measure-subagent";
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
	resolveSubagentViewTargets,
	resolveToolDetailViewTargets,
	type VListViewTarget,
} from "../frontend/components/narrator/vlist/vlist-content-view-target";
import commonLocale from "../frontend/locales/en/common.json";
import narratorLocale from "../frontend/locales/en/narrator.json";
import { type AdapterToolItem, adaptSegment } from "../shared/pretext-layout/segment-adapter";
import type { SourceTextRange } from "../shared/pretext-layout/source-text";

export interface FollowCase {
	kind:
		| "write"
		| "edit"
		| "bash"
		| "command"
		| "terminal"
		| "agent"
		| "send"
		| "plan"
		| "generic"
		| "read"
		| "transfer";
	lines: number;
	live?: boolean;
	path?: boolean;
	replacing?: boolean;
	oldLines?: number;
	oldText?: string;
	newText?: string;
	surface?: "inline" | "viewer" | "content" | "pair";
	language?: string;
	short?: boolean;
	truncated?: boolean;
	theme?: "dark" | "light";
}

export interface FollowSnapshot {
	kind: string;
	renderKind: string;
	surface: string;
	source: string;
	format: string;
	bodyId: string;
	viewportNode: number;
	canvasNode: number | null;
	geometrySource: string;
	live: boolean;
	following: boolean;
	scrollTop: number;
	scrollLeft: number;
	scrollHeight: number;
	clientHeight: number;
	clientWidth: number;
	distance: number;
	rowsPainted: number;
	visualLinesPainted: number;
	projectionStart: number;
	projectionCount: number;
	focus: { side: string; epoch: string; line: number; column: number; offset: number } | null;
	focusVisible: boolean | null;
	focusType: string | null;
	focusText: string;
	firstVisibleLine: number | null;
	firstVisibleType: string | null;
	focusRenderedLine: number | null;
	firstVisibleText: string;
	tailInDOM: boolean;
	canvasRevision: string | null;
	sourceRange: SourceTextRange | null;
	retainedChars: number;
	sourceFirstLine: string;
	sourceLastLine: string;
	warning: string | null;
	fetches: number;
	lines: number;
	maxRowsPainted: number;
	coloredSpans: number;
}

export interface FollowAudit {
	render(opts: FollowCase, remount?: boolean): void;
	snapshot(surface?: string): FollowSnapshot;
	frames(count: number): Promise<void>;
	point(surface?: string): { x: number; y: number };
	scrollbarPoint(axis: "x" | "y", surface?: string): { x: number; y: number } | null;
	traceGrowth(lines: number): Promise<FollowSnapshot[]>;
	start(interval?: number, count?: number): void;
	active(): boolean;
	stop(): void;
	resumePoint(surface?: string): { x: number; y: number } | null;
	beginStream(field: string, value: string, pair?: boolean): void;
	append(field: string, delta: string): void;
	toggleSource(): void;
	toggleWrap(): void;
	geometryAudit(): {
		reads: { operation: string; node: string; stack: string }[];
		modeledSnapshots: number;
		nativeSnapshots: number;
	};
	unmount(): void;
}

declare global {
	interface Window {
		__toolContentFollow: FollowAudit;
	}
}
// Observe real browser layout calls without replacing their returned measurements.
// Only the oracle may measure modeled roots; application reads remain visible in the report.
let oracleDepth = 0;
let modeledSnapshots = 0;
let nativeSnapshots = 0;
const geometryReads: { operation: string; node: string; stack: string }[] = [];
function geometryOracle<T>(read: () => T): T {
	oracleDepth++;
	try {
		return read();
	} finally {
		oracleDepth--;
	}
}
function recordGeometry(node: Element, operation: string) {
	if (oracleDepth || !node.closest("[data-content-layout-root]") || geometryReads.length >= 60)
		return;
	geometryReads.push({
		operation,
		node: `${node.tagName}.${node.className}`,
		stack: new Error().stack?.slice(0, 700) ?? "",
	});
}
for (const prototype of [Element.prototype, HTMLElement.prototype]) {
	for (const key of [
		"clientWidth",
		"clientHeight",
		"clientTop",
		"clientLeft",
		"offsetWidth",
		"offsetHeight",
		"scrollWidth",
		"scrollHeight",
	]) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
		if (!descriptor?.get || !descriptor.configurable) continue;
		const read = descriptor.get;
		Object.defineProperty(prototype, key, {
			...descriptor,
			get(this: Element) {
				recordGeometry(this, key);
				return read.call(this);
			},
		});
	}
}
for (const key of ["getBoundingClientRect", "getClientRects"] as const) {
	const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, key);
	if (!descriptor?.value) continue;
	const read = descriptor.value;
	Object.defineProperty(Element.prototype, key, {
		...descriptor,
		value(this: Element) {
			recordGeometry(this, key);
			return read.call(this);
		},
	});
}
const nativeComputedStyle = window.getComputedStyle;
window.getComputedStyle = (node, pseudo) => {
	recordGeometry(node, "getComputedStyle");
	return nativeComputedStyle.call(window, node, pseudo);
};
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class extends NativeResizeObserver {
	observe(node: Element, options?: ResizeObserverOptions) {
		recordGeometry(node, "ResizeObserver.observe");
		super.observe(node, options);
	}
};

const mount = document.getElementById("root");
if (!mount) throw new Error("Missing fixture root");
const root = createRoot(mount);
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
queryClient.setQueryData(["user-preferences"], {});
let current: FollowCase = { kind: "write", lines: 35 };
let session = 0;
let callId = "audit-call-0";
let showSource = false;
let wordWrap = true;
let fetches = 0;
let lastTarget: VListViewTarget | undefined;
let renderKind = "";
let timer: ReturnType<typeof setInterval> | null = null;
let pending = 0;
let stream = createStreamingToolStore();
let streamActive = false;
const argumentTexts = new Map<string, string>();
let received = 0;
let maxRows = 0;
// Observe actual paint commits, including transient frames between runner samples.
const paintObserver = new MutationObserver(() => {
	for (const body of document.querySelectorAll("[data-diff-content]")) {
		maxRows = Math.max(maxRows, body.querySelectorAll("[data-diff-row]").length);
	}
});
paintObserver.observe(mount, { childList: true, subtree: true });
const nodeIds = new WeakMap<Element, number>();
let nextNode = 0;
function nodeId(node: Element | null): number | null {
	if (!node) return null;
	let id = nodeIds.get(node);
	if (id == null) {
		id = ++nextNode;
		nodeIds.set(node, id);
	}
	return id;
}

function textFor(opts: FollowCase, count = opts.lines): string {
	return Array.from({ length: count }, (_, index) =>
		opts.short
			? `r${index}`
			: opts.language
				? `const audit_line_${String(index + 1).padStart(4, "0")} = ${index};`
				: `audit_line_${String(index + 1).padStart(4, "0")}`,
	).join("\n");
}

function sourceFor(kind: FollowCase["kind"]): string {
	if (kind === "edit") return "input.edit";
	if (kind === "write") return "input.content";
	if (kind === "command") return "input.command";
	if (kind === "agent") return "input.prompt";
	if (kind === "send") return "input.message";
	if (kind === "plan") return "input.plan";
	return "output.main";
}

const controls: VListViewControls = {
	isWrapped: () => wordWrap,
	isSourceShown: () => showSource,
	toggleWrap() {
		wordWrap = !wordWrap;
		render(current);
	},
	toggleSource() {
		showSource = !showSource;
		render(current);
	},
	openFullscreen() {
		render({ ...current, surface: "pair" });
	},
	requestFullPayload() {
		if (!current.truncated || fetches > 0) return;
		fetches++;
		setTimeout(() => render({ ...current, lines: 160, truncated: false }), 80);
	},
};

function appendArgument(toolName: string, field: string, text: string) {
	const before = argumentTexts.get(field) ?? "";
	if (before === text && stream.has(callId)) return;
	if (!text.startsWith(before))
		throw new Error(`Non-append fixture field ${field}; use an explicit reconnect scenario`);
	received += text.length - before.length;
	applyStreamingToolChunk(stream, {
		toolUseId: callId,
		toolName,
		inputCharsTotal: received,
		extractedFields: Object.fromEntries([...argumentTexts].filter(([key]) => key !== field)),
		streamingField: { name: field, delta: text.slice(before.length) },
	});
	argumentTexts.set(field, text);
}

function tool(opts: FollowCase): AdapterToolItem {
	const live = opts.live !== false;
	const text = opts.newText ?? textFor(opts);
	const name = {
		write: "Write",
		edit: "Edit",
		bash: "Bash",
		command: "Bash",
		terminal: "Terminal",
		agent: "Agent",
		send: "Send",
		plan: "ExitPlanMode",
		generic: "CustomTool",
		read: "Read",
		transfer: "TransferFile",
	}[opts.kind];
	if (streamActive) {
		const chunk = stream.get(callId);
		if (!chunk) throw new Error("No streaming input");
		return {
			blockIndex: 0,
			isSubagent: false,
			tc: {
				toolName: "Edit",
				toolUseId: callId,
				status: live ? "running" : "success",
				...topLevelStreamingChunkToToolFields(chunk),
			},
		};
	}
	const path = opts.path === false ? undefined : `/fixture/example.${opts.language ? "ts" : "txt"}`;
	const input: Record<string, unknown> = path ? { file_path: path } : {};
	let output: unknown;
	let metadata: Record<string, unknown> | undefined;
	if (["write", "edit", "command", "agent", "send", "plan"].includes(opts.kind)) {
		const field = {
			write: "content",
			edit: opts.replacing ? "new_string" : "old_string",
			command: "command",
			agent: "prompt",
			send: "message",
			plan: "plan",
		}[opts.kind as "write" | "edit" | "command" | "agent" | "send" | "plan"];
		const oldText =
			opts.oldText ?? (opts.oldLines != null ? textFor(opts, opts.oldLines) : "old value");
		if (opts.kind === "agent" || opts.kind === "send")
			Object.assign(input, { description: "Real adapter prompt", subagent_type: "general" });
		if (live) {
			if (opts.kind === "edit" && opts.replacing) appendArgument(name, "old_string", oldText);
			appendArgument(name, field, text);
		} else {
			Object.assign(
				input,
				opts.kind === "edit"
					? { old_string: opts.replacing ? oldText : text, new_string: text }
					: { [field]: text },
			);
			applyStreamingToolStarted(stream, { toolUseId: callId, toolName: name, input });
		}
		const chunk = stream.get(callId);
		if (!chunk) throw new Error("Missing real argument accumulator");
		const fields = topLevelStreamingChunkToToolFields(chunk);
		return {
			blockIndex: 0,
			isSubagent: opts.kind === "agent" || opts.kind === "send",
			tc: {
				...fields,
				toolUseId: callId,
				toolName: name,
				status: live ? "running" : "success",
				inputJson: { ...input, ...(fields.inputJson as Record<string, unknown>) },
			},
		};
	} else {
		if (opts.kind === "bash") input.command = "fixture command (never executed)";
		if (opts.kind === "terminal")
			Object.assign(input, { action: "read", terminal_id: "fixture-terminal" });
		if (opts.kind === "transfer")
			Object.assign(input, {
				direction: "upload",
				remotePath: "/fixture/remote",
				localPath: "/fixture/local",
			});
		if (live && ["bash", "transfer", "generic"].includes(opts.kind))
			metadata = { _streamingOutput: text };
		else
			output = {
				_text: opts.truncated ? { _truncated: true, preview: text, fullLength: 20_000 } : text,
			};
	}
	return {
		blockIndex: 0,
		isSubagent: opts.kind === "agent" || opts.kind === "send",
		tc: {
			toolUseId: callId,
			toolName: name,
			status: live ? "running" : "success",
			inputJson: input,
			outputJson: output,
			_metadata: metadata,
		},
	};
}

function render(opts: FollowCase, remount = false) {
	if (remount) {
		stop();
		session++;
		callId = `audit-call-${session}`;
		fetches = 0;
		maxRows = 0;
		streamActive = false;
		stream = createStreamingToolStore();
		argumentTexts.clear();
		received = 0;
		showSource = false;
		wordWrap = true;
	}
	current = opts;
	const pair = opts.surface === "pair";
	const width = Math.max(240, Math.min(700, (innerWidth - (pair ? 72 : 48)) / (pair ? 2 : 1)));
	const item = tool(opts);
	const specs = adaptSegment(
		{ kind: "tool-run", items: [item], sourceMessages: [] },
		{
			lod: 5,
			isExpanded: () => true,
			isPromptOpen: () => true,
			viewportHeight: innerHeight,
			resolveToolCategory: getCategory,
		},
	);
	const spec = specs[0];
	if (!spec || !["tool-call", "subagent-card", "communication-bubble"].includes(spec.kind))
		throw new Error(`Wrong adapter branch: ${spec?.kind}`);
	renderKind = spec.kind;
	const measured = measureElement(spec.kind, spec.data, width, 5, spec.opts);
	const targets =
		spec.kind === "communication-bubble"
			? []
			: spec.kind === "subagent-card"
				? resolveSubagentViewTargets(spec.key, measured as MeasuredSubagent)
				: resolveToolDetailViewTargets(spec.key, measured as MeasuredToolCall);
	lastTarget = targets.find((target) => target.slot === sourceFor(opts.kind)) ?? targets.at(-1);
	if (!lastTarget && spec.kind !== "communication-bubble")
		throw new Error(
			`No canonical body for ${opts.kind}: ${targets.map((target) => target.slot).join(",")}`,
		);
	const target = lastTarget;
	const paint = renderElement(spec.kind, measured, {
		...resolveRenderExtra(spec),
		viewTargets: targets,
		viewControls: controls,
	});
	const full = target ? (
		<VListViewBody
			target={target}
			wordWrap={wordWrap}
			showSource={showSource}
			text={target.text}
			layout={target.kind === "diff" ? { width, height: 200 } : undefined}
		/>
	) : null;
	flushSync(() =>
		root.render(
			<MantineProvider forceColorScheme={opts.theme ?? "dark"}>
				<QueryClientProvider client={queryClient}>
					<RenderLodCtx value={{ lod: 5, interactive: true }}>
						<div
							key={session}
							id="case"
							data-render-kind={renderKind}
							style={{ display: "flex", gap: 24, margin: 24 }}
						>
							<section data-audit-surface="inline" style={{ width, minWidth: 0 }}>
								<h3 style={{ margin: "0 0 12px", fontSize: 15 }}>
									{opts.kind}: {opts.surface ?? "inline"}
								</h3>
								{opts.surface === "content" && target ? (
									<ContentViewer
										bodyId={target.id}
										content={target.text}
										live={target.model?.live}
										revision={target.model?.revision}
										diffDocument={target.model?.diffDocument}
										layout={target.kind === "diff" ? { width, height: 200 } : undefined}
										contentType={
											target.kind === "markdown" || target.kind === "diff" ? target.kind : "code"
										}
										language={opts.language ?? target.codeLang}
										style={{ maxHeight: 200 }}
									/>
								) : opts.surface === "viewer" ? (
									<div style={{ height: 200, display: "flex", flexDirection: "column" }}>
										{full}
									</div>
								) : (
									paint
								)}
							</section>
							{pair ? (
								<section data-audit-surface="full" style={{ width, minWidth: 0 }}>
									<h3 style={{ margin: "0 0 12px", fontSize: 15 }}>Independent full view</h3>
									<div style={{ height: 200, display: "flex", flexDirection: "column" }}>
										{full}
									</div>
								</section>
							) : null}
						</div>
					</RenderLodCtx>
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
}

function viewport(surface = "inline"): HTMLElement {
	const scope = document.querySelector(`[data-audit-surface="${surface}"]`);
	const boxes = Array.from(scope?.querySelectorAll<HTMLElement>("[data-content-scrollport]") ?? []);
	const selected =
		boxes.find((node) => node.dataset.contentScrollport === lastTarget?.id) ??
		boxes.at(-1) ??
		scope?.querySelector<HTMLElement>("[data-vlist-communication-body]");
	if (!selected) throw new Error(`No viewport: ${current.kind}/${surface}`);
	return selected;
}

function snapshot(surface = "inline"): FollowSnapshot {
	return geometryOracle(() => snapshotWithGeometry(surface));
}
function snapshotWithGeometry(surface: string): FollowSnapshot {
	const node = viewport(surface);
	if (node.dataset.contentGeometry === "layout") modeledSnapshots++;
	else nativeSnapshots++;
	const target = lastTarget;
	const model = target?.model;
	const doc = model?.diffDocument;
	const body = node.querySelector<HTMLElement>("[data-diff-content]");
	const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-diff-row]"));
	const bounds = node.getBoundingClientRect();
	const contentTop = bounds.top + node.clientTop;
	const contentBottom = contentTop + node.clientHeight;
	const focused = body?.querySelector<HTMLElement>("[data-diff-focus]");
	const focusedBounds = focused?.getBoundingClientRect();
	const firstVisible = rows.find((row) => row.getBoundingClientRect().bottom > contentTop + 1);
	const source = doc ? (doc.focus?.side === "old" ? doc.oldSource : doc.newSource) : null;
	const tail =
		current.newText?.split(/\r\n?|\n/).at(-1) ??
		(current.short
			? `r${current.lines - 1}`
			: `audit_line_${String(current.lines).padStart(4, "0")}`);
	maxRows = Math.max(maxRows, rows.length);
	return {
		kind: current.kind,
		renderKind,
		surface,
		source: model?.source ?? "",
		format: model?.format ?? target?.kind ?? "",
		bodyId: target?.id ?? callId,
		viewportNode: nodeId(node) ?? 0,
		canvasNode: nodeId(body ?? null),
		geometrySource: node.dataset.contentGeometry ?? "unknown",
		live: model?.live ?? false,
		following: node.dataset.following === "true",
		scrollTop: node.scrollTop,
		scrollLeft: node.scrollLeft,
		scrollHeight: node.scrollHeight,
		clientHeight: node.clientHeight,
		clientWidth: node.clientWidth,
		distance: node.scrollHeight - node.clientHeight - node.scrollTop,
		rowsPainted: rows.length,
		visualLinesPainted: node.querySelectorAll("[data-diff-visual-line]").length,
		projectionStart: Number(body?.dataset.diffProjectionStart ?? 0),
		projectionCount: Number(body?.dataset.diffProjectionCount ?? 0),
		focus: doc?.focus ?? null,
		focusVisible: doc
			? !!focusedBounds &&
				Number(focused?.dataset.diffSourceLine) === doc.focus?.line &&
				focusedBounds.bottom <= contentBottom + 1 &&
				(focusedBounds.height > node.clientHeight
					? focusedBounds.bottom > contentTop
					: focusedBounds.top >= contentTop - 1)
			: null,
		focusType: focused?.dataset.diffRow ?? null,
		focusRenderedLine:
			focused?.dataset.diffSourceLine == null ? null : Number(focused.dataset.diffSourceLine),
		firstVisibleType: firstVisible?.dataset.diffRow ?? null,
		focusText: focused?.textContent?.slice(-120) ?? "",
		firstVisibleLine:
			firstVisible?.dataset.diffSourceLine == null
				? null
				: Number(firstVisible.dataset.diffSourceLine),
		firstVisibleText: firstVisible?.textContent?.slice(0, 160) ?? "",
		tailInDOM: node.textContent?.includes(tail) ?? false,
		canvasRevision: body?.dataset.diffDocumentRevision ?? null,
		sourceRange: source?.range ?? model?.range ?? null,
		retainedChars: source?.text.length ?? target?.text.length ?? 0,
		sourceFirstLine: source?.text.split("\n", 1)[0] ?? "",
		sourceLastLine: source?.text.split("\n").at(-1) ?? "",
		warning:
			body?.querySelector("[data-diff-range-warning]")?.getAttribute("data-diff-range-warning") ??
			null,
		fetches,
		lines: current.lines,
		maxRowsPainted: maxRows,
		coloredSpans: Array.from(node.querySelectorAll<HTMLElement>("span[style]")).filter((span) =>
			/^#[\da-f]+$|^rgb\(/i.test(span.style.color),
		).length,
	};
}

async function frames(count: number) {
	for (let i = 0; i < Math.min(180, count); i++)
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
function stop() {
	if (timer) clearInterval(timer);
	timer = null;
	pending = 0;
}
const api: FollowAudit = {
	render,
	snapshot,
	frames,
	point(surface) {
		return geometryOracle(() => {
			const bounds = viewport(surface).getBoundingClientRect();
			return {
				x: bounds.left + Math.min(100, bounds.width / 2),
				y: bounds.top + Math.min(100, bounds.height / 2),
			};
		});
	},
	scrollbarPoint(axis, surface) {
		return geometryOracle(() => {
			const thumb = viewport(surface)
				.closest("[data-content-layout-root]")
				?.querySelector(`[data-content-scrollbar-thumb="${axis}"]`);
			if (!thumb) return null;
			const bounds = thumb.getBoundingClientRect();
			return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
		});
	},
	async traceGrowth(lines) {
		const records = [snapshot()];
		render({ ...current, lines });
		records.push(snapshot());
		for (let i = 0; i < 28; i++) {
			await frames(1);
			records.push(snapshot());
		}
		return records;
	},
	start(interval = 30, count = 30) {
		stop();
		pending = Math.min(100, count);
		timer = setInterval(
			() => {
				render({ ...current, lines: current.lines + 1 });
				if (--pending <= 0) stop();
			},
			Math.max(20, interval),
		);
	},
	active: () => timer !== null,
	stop,
	resumePoint(surface) {
		const scope = document.querySelector(`[data-audit-surface="${surface ?? "inline"}"]`);
		const button = Array.from(
			scope?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [],
		).find(
			(button) =>
				button.getAttribute("aria-label") === narratorLocale.followLatestChange ||
				button.getAttribute("aria-label") === narratorLocale.resumeContentFollow,
		);
		if (!button) return null;
		return geometryOracle(() => {
			const bounds = button.getBoundingClientRect();
			return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
		});
	},
	geometryAudit: () => ({ reads: geometryReads, modeledSnapshots, nativeSnapshots }),
	beginStream(field, value, pair = false) {
		render({ kind: "edit", lines: 0, short: true, surface: pair ? "pair" : "inline" }, true);
		streamActive = true;
		received = value.length;
		applyStreamingToolChunk(stream, {
			toolUseId: callId,
			toolName: "Edit",
			inputCharsTotal: received,
			streamingField: { name: field, delta: value },
		});
		render(current);
	},
	append(field, delta) {
		if (!streamActive) throw new Error("Call beginStream first");
		received += delta.length;
		applyStreamingToolChunk(stream, {
			toolUseId: callId,
			toolName: "Edit",
			inputCharsTotal: received,
			streamingField: { name: field, delta },
		});
		render(current);
	},
	toggleSource() {
		showSource = !showSource;
		render(current);
	},
	toggleWrap() {
		wordWrap = !wordWrap;
		render(current);
	},
	unmount() {
		stop();
		paintObserver.disconnect();
		flushSync(() => root.render(null));
	},
};
await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "narrator",
	resources: { en: { narrator: narratorLocale, common: commonLocale } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});
window.__toolContentFollow = api;
render(current, true);
