import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	createDiffDocument,
	type DiffDocument,
	diffDocumentLineNoWidth,
	getDiffRowAnchor,
	projectDiffDocument,
} from "@shared/pretext-layout/diff-core";
import { layoutDiffRows } from "@shared/pretext-layout/diff-layout";
import { createSourceText, trimSourceText } from "@shared/pretext-layout/source-text";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { parseHTML } from "linkedom";
import { useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AutoFollowScroll, useContentViewport } from "./AutoFollowScroll";
import { DiffContent } from "./DiffContent";
import { topLevelStreamingChunkToToolFields } from "./narrator-message-helpers";

const {
	applyStreamingToolChunk,
	applyStreamingToolCompleted,
	applyStreamingToolExecuting,
	applyStreamingToolStarted,
	createStreamingToolStore,
} = await import("./vlist/streaming-tool-chunks");

const { installCanvasStub } = await import("./vlist/measure/test-canvas-stub");
installCanvasStub();
const controllers = new Map<string, NonNullable<ReturnType<typeof useContentViewport>>>();
let root: Root;
let container: HTMLDivElement;
let clock = 0;
let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;
let echoedTop: WeakMap<HTMLElement, number>;
let restoreGeometry: () => void;
let viewportWidth: number;
let canvasWidth: number;
let resizeCallbacks: Set<() => void>;
let forbidMeasurements = false;
function checkMeasurement(node: HTMLElement, operation: string) {
	if (forbidMeasurements && node.closest("[data-content-layout-root]")) {
		throw new Error(`DOM geometry read in modeled Diff: ${operation}`);
	}
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function Probe({ id }: { id: string }) {
	const value = useContentViewport();
	useLayoutEffect(() => {
		if (value) controllers.set(id, value);
		return () => {
			controllers.delete(id);
		};
	}, [id, value]);
	return null;
}

function Fixture({
	doc,
	live = true,
	pair = false,
	wrap = false,
	contentWidth = 320,
	contentPadding = 0,
	viewportPadding = 0,
	layoutWidth = 320,
	layoutHeight = 200,
	modeled = true,
}: {
	doc: DiffDocument;
	live?: boolean;
	pair?: boolean;
	wrap?: boolean;
	contentWidth?: number;
	contentPadding?: number;
	viewportPadding?: number;
	layoutWidth?: number;
	layoutHeight?: number;
	modeled?: boolean;
}) {
	return (
		<MantineProvider>
			<div style={{ display: "flex" }}>
				{(pair ? ["inline", "full"] : ["inline"]).map((id) => (
					<AutoFollowScroll
						key={id}
						bodyId={id}
						live={live}
						revision={doc.revision}
						followTarget="row"
						layout={modeled ? { width: layoutWidth, height: layoutHeight } : undefined}
						contentPadding={{
							x: contentPadding + viewportPadding,
							y: contentPadding + viewportPadding,
						}}
						viewportStyle={{ height: layoutHeight }}
					>
						<DiffContent document={doc} wordWrap={wrap} contentWidth={contentWidth} />
						<Probe id={id} />
					</AutoFollowScroll>
				))}
			</div>
		</MantineProvider>
	);
}

function scroller(id = "inline"): HTMLElement {
	const node = controllers.get(id)?.viewportRef.current;
	if (!node) throw new Error(`no viewport: ${id}`);
	return node;
}

function canvas(id = "inline"): HTMLDivElement {
	const value = scroller(id).querySelector<HTMLDivElement>("[data-diff-content]");
	if (!value) throw new Error("no diff canvas");
	return value;
}

function focusVisible(id = "inline"): boolean {
	const node = scroller(id);
	const focus = node.querySelector<HTMLElement>("[data-diff-focus]");
	if (!focus) return false;
	const snapshot = controllers.get(id)?.getSnapshot();
	if (!snapshot) return false;
	let top = snapshot.contentOrigin;
	for (const sibling of canvas(id).children) {
		if (sibling === focus) break;
		top += Number.parseFloat((sibling as HTMLElement).style.height) || 0;
	}
	const height = Number.parseFloat(focus.style.height) || 0;
	return top < snapshot.scrollTop + snapshot.viewportHeight && top + height > snapshot.scrollTop;
}

async function settle(count = 90) {
	for (let i = 0; i < count; i++) {
		await tick();
		const pending = [...frames.values()];
		frames.clear();
		clock += 16;
		for (const callback of pending) callback(clock);
		// Browser scroll events are queued after programmatic writes, never fired
		// recursively from scrollTop's setter. A clock tick keeps the same order.
		for (const value of controllers.values()) {
			const node = value.viewportRef.current;
			if (node && (echoedTop.get(node) ?? 0) !== node.scrollTop) {
				echoedTop.set(node, node.scrollTop);
				node.dispatchEvent(new Event("scroll"));
			}
		}
		if (pending.length === 0 && frames.size === 0 && i > 4) break;
	}
	await tick();
}

async function pauseAt(row: number, id = "inline") {
	const node = scroller(id);
	const event = new Event("wheel", { bubbles: true });
	Object.defineProperties(event, {
		deltaY: { value: -40 },
		ctrlKey: { value: false },
		altKey: { value: false },
	});
	node.dispatchEvent(event);
	await tick();
	node.scrollTop = row * 15;
	node.dispatchEvent(new Event("scroll"));
	await settle();
	expect(controllers.get(id)?.following).toBe(false);
}

beforeEach(() => {
	forbidMeasurements = false;
	controllers.clear();
	frames = new Map();
	echoedTop = new WeakMap();
	clock = performance.now();
	nextFrame = 0;
	viewportWidth = 320;
	canvasWidth = 320;
	resizeCallbacks = new Set();
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const top = new WeakMap<object, number>();
	const proto = window.HTMLElement.prototype;
	const geometry = [
		"clientHeight",
		"clientWidth",
		"clientTop",
		"offsetWidth",
		"offsetHeight",
		"scrollWidth",
		"scrollTop",
		"scrollHeight",
		"getBoundingClientRect",
	];
	const descriptors = geometry.map(
		(key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
	);
	restoreGeometry = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(proto, key, descriptor);
			else Reflect.deleteProperty(proto, key);
		}
	};
	Object.defineProperties(proto, {
		clientHeight: {
			configurable: true,
			get() {
				checkMeasurement(this, "clientHeight");
				return 200;
			},
		},
		offsetWidth: {
			configurable: true,
			get() {
				checkMeasurement(this, "offsetWidth");
				return viewportWidth;
			},
		},
		offsetHeight: {
			configurable: true,
			get() {
				checkMeasurement(this, "offsetHeight");
				return 200;
			},
		},
		scrollWidth: {
			configurable: true,
			get() {
				checkMeasurement(this, "scrollWidth");
				return viewportWidth;
			},
		},
		clientWidth: {
			configurable: true,
			get() {
				checkMeasurement(this, "clientWidth");
				return (this as HTMLElement).hasAttribute("data-diff-content")
					? canvasWidth
					: viewportWidth;
			},
		},
		clientTop: {
			configurable: true,
			get() {
				checkMeasurement(this, "clientTop");
				return 0;
			},
		},
		scrollTop: {
			configurable: true,
			get() {
				return top.get(this) ?? 0;
			},
			set(value: number) {
				top.set(this, Math.max(0, value));
			},
		},
		scrollHeight: {
			configurable: true,
			get() {
				checkMeasurement(this, "scrollHeight");
				const body = (this as HTMLElement).querySelector<HTMLElement>("[data-diff-content]");
				return body
					? Array.from(body.children).reduce(
							(sum, child) => sum + (Number.parseFloat((child as HTMLElement).style.height) || 0),
							0,
						)
					: 0;
			},
		},
	});
	proto.getBoundingClientRect = function () {
		checkMeasurement(this, "getBoundingClientRect");
		const parent = this.closest("[data-diff-scroll-container]");
		const y = this.hasAttribute("data-diff-content") ? -(parent?.scrollTop ?? 0) : 0;
		const width = this.hasAttribute("data-diff-content") ? canvasWidth : viewportWidth;
		return {
			top: y,
			bottom: y + 200,
			left: 0,
			right: width,
			width,
			height: 200,
			x: 0,
			y,
			toJSON() {},
		};
	};
	class Observer {
		constructor(private callback: () => void) {}
		observe(node: HTMLElement) {
			checkMeasurement(node, "ResizeObserver.observe");
			resizeCallbacks.add(this.callback);
		}
		unobserve() {}
		disconnect() {
			resizeCallbacks.delete(this.callback);
		}
	}
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	};
	const cancelAnimationFrame = (id: number) => frames.delete(id);
	const getComputedStyle = (node: HTMLElement) => {
		checkMeasurement(node, "getComputedStyle");
		return {
			paddingLeft: node.style.paddingLeft || node.style.padding || "0",
			paddingRight: node.style.paddingRight || node.style.padding || "0",
			paddingTop: "0",
			paddingBottom: "0",
			overflowY: "auto",
			overflowX: "auto",
		};
	};
	Object.assign(window, {
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		ResizeObserver: Observer,
		getComputedStyle,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		Event: window.Event,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		ResizeObserver: Observer,
		getComputedStyle,
		IS_REACT_ACT_ENVIRONMENT: false,
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	root.unmount();
	container.remove();
	restoreGeometry();
});
const text = (count: number) => Array.from({ length: count }, (_, i) => `l${i}`).join("\n");

function visualText() {
	return [...canvas().querySelectorAll("[data-diff-visual-line]")].map((line) => line.textContent);
}

function expectedVisualText(doc: DiffDocument, width: number) {
	const { lines } = projectDiffDocument(doc, { startRow: 0 });
	const layout = layoutDiffRows(lines, {
		contentWidth: width,
		wordWrap: true,
		lineNoWidth: diffDocumentLineNoWidth(doc, "~"),
	});
	return layout.rows.flatMap((row) =>
		row.visualLines.map((line) => row.content.slice(line.start, line.end)),
	);
}

describe("DiffContent declared geometry", () => {
	test.each([
		{ contentPadding: 6, viewportPadding: 0 },
		{ contentPadding: 0, viewportPadding: 6 },
	])("uses the same declared inset for paint and wrapping %j", async (padding) => {
		const doc = createDiffDocument({ oldText: "", newText: "x".repeat(130) });
		root.render(<Fixture doc={doc} live={false} wrap {...padding} />);
		await settle();
		expect(visualText()).toEqual(expectedVisualText(doc, 308));
		expect(visualText()).not.toEqual(expectedVisualText(doc, 320));
		root.render(<Fixture doc={doc} live={false} wrap layoutWidth={280} {...padding} />);
		await settle();
		expect(visualText()).toEqual(expectedVisualText(doc, 268));
		root.render(<Fixture doc={doc} live={false} wrap layoutWidth={265} {...padding} />);
		await settle();
		expect(visualText()).toEqual(expectedVisualText(doc, 253));
		expect(resizeCallbacks.size).toBe(0);
		const beforeScroll = visualText();
		for (let i = 0; i < 8; i++) scroller().dispatchEvent(new Event("scroll"));
		await settle();
		expect(visualText()).toEqual(beforeScroll);
		expect(frames.size).toBe(0);
	});

	test.each([
		0, 900,
	])("DOM width %i and an obsolete width hint cannot override the layout", async (width) => {
		const doc = createDiffDocument({ oldText: "", newText: "x".repeat(130) });
		viewportWidth = width;
		canvasWidth = width;
		root.render(
			<Fixture
				doc={doc}
				live={false}
				wrap
				layoutWidth={220}
				contentWidth={999}
				contentPadding={6}
			/>,
		);
		await settle();
		expect(visualText()).toEqual(expectedVisualText(doc, 208));
		root.render(
			<Fixture
				doc={doc}
				live={false}
				wrap
				layoutWidth={260}
				contentWidth={999}
				contentPadding={6}
			/>,
		);
		await settle();
		expect(visualText()).toEqual(expectedVisualText(doc, 248));
		expect(scroller().dataset.contentGeometry).toBe("layout");
	});

	test("unwrapped intrinsic content cannot resize its viewport model", async () => {
		const doc = createDiffDocument({ oldText: "", newText: "x" });
		canvasWidth = 900;
		root.render(<Fixture doc={doc} live={false} contentPadding={6} />);
		await settle();
		expect(Number.parseFloat(canvas().style.minWidth)).toBe(308);
		root.render(<Fixture doc={doc} live={false} layoutWidth={280} contentPadding={6} />);
		await settle();
		expect(Number.parseFloat(canvas().style.minWidth)).toBe(268);
		expect(frames.size).toBe(0);
	});

	test("CSS-owned entries explicitly retain their native sizing boundary", async () => {
		const doc = createDiffDocument({ oldText: "", newText: "x".repeat(130) });
		root.render(<Fixture doc={doc} live={false} wrap modeled={false} contentPadding={6} />);
		await settle();
		expect(scroller().dataset.contentGeometry).toBe("dom");
		expect(resizeCallbacks.size).toBeGreaterThan(0);
		expect(visualText()).toEqual(expectedVisualText(doc, 308));
		viewportWidth = 280;
		for (const resize of resizeCallbacks) resize();
		await settle();
		expect(visualText()).toEqual(expectedVisualText(doc, 268));
	});

	test("mount, growth, resize, pause and completion need no DOM geometry anywhere in the modeled host", async () => {
		forbidMeasurements = true;
		const doc = createDiffDocument({ oldText: "", newText: text(800) });
		root.render(<Fixture doc={doc} pair wrap />);
		await settle();
		expect(controllers.get("inline")?.getSnapshot().source).toBe("layout");
		expect(resizeCallbacks.size).toBe(0);
		await pauseAt(200, "full");
		const next = createDiffDocument({ oldText: "", newText: text(1_800) });
		root.render(<Fixture doc={next} pair wrap layoutWidth={280} layoutHeight={160} />);
		await settle();
		expect(controllers.get("full")?.following).toBe(false);
		expect(controllers.get("inline")?.following).toBe(true);
		expect(focusVisible()).toBe(true);
		root.render(<Fixture doc={next} pair wrap live={false} layoutWidth={280} layoutHeight={160} />);
		await settle();
		expect(controllers.get("full")?.following).toBe(false);
		expect(frames.size).toBe(0);
	});
});

describe("DiffContent permanent viewport", () => {
	test("normal Edit chunks have no warnings and use file lines as soon as matching locates them", async () => {
		const store = createStreamingToolStore();
		const input = { file_path: "/a.ts", old_string: "keep\nold\n}", new_string: "keep\nnew\n}" };
		const renderChunk = async () => {
			const chunk = store.get("edit");
			if (!chunk) throw new Error("missing Edit chunk");
			const fields = topLevelStreamingChunkToToolFields(chunk);
			const detail = classifyToolDetail({
				toolUseId: "edit",
				toolName: "Edit",
				category: "file",
				inputJson: fields.inputJson,
				metadata: fields._metadata,
				status: chunk._status ?? "streaming",
				isStreaming: !chunk._started,
			});
			const body = detail?.sections.find((part) => part.key === "input.edit")?.body;
			if (body?.kind !== "capped" || !body.diffDocument) throw new Error("missing Edit diff");
			root.render(<Fixture doc={body.diffDocument} live={body.live} />);
			await settle();
			expect(canvas().querySelector("[data-diff-range-warning]")).toBeNull();
		};
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 30,
			extractedFields: { file_path: input.file_path },
			streamingField: { name: "old_string", delta: "keep\n", startsField: true },
		});
		await renderChunk();
		const node = scroller();
		const body = canvas();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 60,
			extractedFields: { old_string: input.old_string },
			metadata: { startLine: 445 },
			streamingField: { name: "new_string", delta: "keep\n", startsField: true },
		});
		await renderChunk();
		expect(canvas().querySelector("[data-diff-gutter]")?.textContent).toMatch(/445\s+445/);
		expect(canvas().querySelector("[data-diff-gutter]")?.textContent).not.toContain("~");
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 70,
			streamingField: { name: "new_string", delta: "new\n}" },
		});
		await renderChunk();
		expect(canvas().textContent).not.toContain("~");
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 80,
			extractedFields: { new_string: input.new_string },
		});
		await renderChunk();
		applyStreamingToolStarted(store, { toolUseId: "edit", toolName: "Edit", input });
		await renderChunk();
		applyStreamingToolExecuting(store, { toolUseId: "edit" });
		await renderChunk();
		applyStreamingToolCompleted(store, {
			toolUseId: "edit",
			status: "success",
			metadata: { startLine: 445 },
		});
		await renderChunk();
		expect(scroller()).toBe(node);
		expect(canvas()).toBe(body);
		expect(canvas().textContent).not.toContain("~");
	});

	test("a bounded live window does not cover streaming code with a partial-source banner", async () => {
		const full = createSourceText(text(4_000), { epoch: "stream", streaming: true });
		const window = trimSourceText(full, 16_000);
		const doc = createDiffDocument({
			oldText: window.text,
			newText: window.text,
			oldRange: window.range,
			newRange: window.range,
			startLine: 445,
		});
		expect(doc.truncated).toBe(true);
		root.render(<Fixture doc={doc} />);
		await settle();
		expect(canvas().querySelector("[data-diff-range-warning]")).toBeNull();
		root.render(<Fixture doc={doc} live={false} />);
		await settle();
		expect(canvas().querySelector("[data-diff-range-warning='preview']")).not.toBeNull();
	});

	test("an unknown new-side origin does not mark known old file lines as provisional", async () => {
		const unknown = createSourceText("keep", { epoch: "reconnect", originKnown: false });
		root.render(
			<Fixture
				live={false}
				doc={createDiffDocument({
					oldText: "keep",
					newText: unknown.text,
					newRange: unknown.range,
					startLine: 446,
				})}
			/>,
		);
		await settle();
		expect(canvas().querySelector("[data-diff-gutter]")?.textContent).toMatch(/446\s+~1/);
		expect(canvas().textContent).not.toContain("~446");
	});

	test("source transitions do not leave a version warning on an automatic follower", async () => {
		const build = (epoch: string) => {
			const source = createSourceText(text(200), { epoch, complete: true });
			return createDiffDocument({
				oldText: source.text,
				newText: source.text,
				oldRange: source.range,
				newRange: source.range,
			});
		};
		root.render(<Fixture doc={build("first")} />);
		await settle();
		root.render(<Fixture doc={build("verified")} />);
		await settle();
		expect(controllers.get("inline")?.following).toBe(true);
		expect(canvas().querySelector("[data-diff-range-warning]")).toBeNull();
	});

	test("a paused reader's real version warning clears when its new anchor is valid", async () => {
		const build = (epoch: string, count: number) => {
			const source = createSourceText(text(count), { epoch, complete: true });
			return createDiffDocument({
				oldText: source.text,
				newText: source.text,
				oldRange: source.range,
				newRange: source.range,
			});
		};
		root.render(<Fixture doc={build("first", 800)} />);
		await settle();
		await pauseAt(200);
		root.render(<Fixture doc={build("replacement", 500)} />);
		await settle();
		expect(canvas().querySelector("[data-diff-range-warning='epoch']")).not.toBeNull();
		root.render(<Fixture doc={build("replacement", 501)} />);
		await settle();
		expect(controllers.get("inline")?.following).toBe(false);
		expect(canvas().querySelector("[data-diff-range-warning]")).toBeNull();
	});

	test("follows a new-side change before a long removed suffix, not the bottom", async () => {
		const doc = createDiffDocument({ oldText: text(2_000), newText: text(80), focusSide: "new" });
		root.render(<Fixture doc={doc} />);
		await settle();
		expect({
			visible: focusVisible(),
			top: scroller().scrollTop,
			height: scroller().scrollHeight,
			start: canvas().dataset.diffProjectionStart,
			focus: canvas().querySelector("[data-diff-focus]")?.textContent,
			first: canvas().querySelector("[data-diff-row]")?.textContent,
		}).toMatchObject({ visible: true });
		expect(scroller().scrollTop).toBeLessThan(scroller().scrollHeight / 2);
		expect(canvas().querySelectorAll("[data-diff-row]").length).toBeLessThan(60);
		expect(Number(canvas().dataset.diffProjectionCount)).toBeLessThanOrEqual(500);
	});

	test("matching, replacing and settled keep one Diff DOM and its last focus", async () => {
		const old = text(800);
		const matching = createDiffDocument({ oldText: old, newText: old, focusSide: "old" });
		root.render(<Fixture doc={matching} />);
		await settle();
		const node = scroller();
		const body = canvas();
		const replacing = createDiffDocument({ oldText: old, newText: text(550), focusSide: "new" });
		root.render(<Fixture doc={replacing} />);
		await settle();
		expect(scroller()).toBe(node);
		expect(canvas()).toBe(body);
		expect({
			visible: focusVisible(),
			top: scroller().scrollTop,
			height: scroller().scrollHeight,
			start: canvas().dataset.diffProjectionStart,
			focus: canvas().querySelector("[data-diff-focus]")?.textContent,
			first: canvas().querySelector("[data-diff-row]")?.textContent,
		}).toMatchObject({ visible: true });
		const lastTop = node.scrollTop;
		root.render(<Fixture doc={replacing} live={false} />);
		await settle();
		expect(scroller()).toBe(node);
		expect(canvas()).toBe(body);
		expect(node.scrollTop).toBeCloseTo(lastTop, 0);
		expect({
			visible: focusVisible(),
			top: scroller().scrollTop,
			height: scroller().scrollHeight,
			start: canvas().dataset.diffProjectionStart,
			focus: canvas().querySelector("[data-diff-focus]")?.textContent,
			first: canvas().querySelector("[data-diff-row]")?.textContent,
		}).toMatchObject({ visible: true });
	});

	test("a growing single row follows its latest soft wrap", async () => {
		root.render(
			<Fixture
				doc={createDiffDocument({ oldText: "old", newText: "a".repeat(80), focusSide: "new" })}
				wrap
			/>,
		);
		await settle();
		const before = scroller().scrollTop;
		root.render(
			<Fixture
				doc={createDiffDocument({ oldText: "old", newText: "a".repeat(2_000), focusSide: "new" })}
				wrap
			/>,
		);
		await settle();
		expect(scroller().scrollTop).toBeGreaterThan(before + 100);
		expect({
			visible: focusVisible(),
			top: scroller().scrollTop,
			height: scroller().scrollHeight,
			start: canvas().dataset.diffProjectionStart,
			focus: canvas().querySelector("[data-diff-focus]")?.textContent,
			first: canvas().querySelector("[data-diff-row]")?.textContent,
		}).toMatchObject({ visible: true });
		expect(canvas().querySelectorAll("[data-diff-visual-line]").length).toBeLessThan(60);
	});

	test("paused updates stay dynamic and do not share a follower's projection", async () => {
		const initial = createDiffDocument({ oldText: "", newText: text(1_500), focusSide: "new" });
		root.render(<Fixture doc={initial} pair />);
		await settle();
		await pauseAt(200, "full");
		const pausedTop = scroller("full").scrollTop;
		const next = createDiffDocument({ oldText: "", newText: text(1_900), focusSide: "new" });
		root.render(<Fixture doc={next} pair />);
		await settle();
		expect(controllers.get("full")?.following).toBe(false);
		expect(scroller("full").scrollTop).toBeCloseTo(pausedTop, 0);
		expect(Number(canvas("full").dataset.diffProjectionStart)).toBeLessThan(500);
		expect(Number(canvas().dataset.diffProjectionStart)).toBeGreaterThan(1_000);
		expect(canvas("full").dataset.diffDocumentRevision).toBe(next.revision);
		expect(canvas("full").querySelector("[data-diff-range-warning]")).toBeNull();
		expect({
			visible: focusVisible(),
			top: scroller().scrollTop,
			height: scroller().scrollHeight,
			start: canvas().dataset.diffProjectionStart,
			focus: canvas().querySelector("[data-diff-focus]")?.textContent,
			first: canvas().querySelector("[data-diff-row]")?.textContent,
		}).toMatchObject({ visible: true });
	});

	test("actual source eviction clamps a paused reader, while epoch replacement resets it", async () => {
		const source = createSourceText(text(2_000), { epoch: "stream" });
		const build = (value: typeof source) =>
			createDiffDocument({
				oldText: value.text,
				newText: value.text,
				oldRange: value.range,
				newRange: value.range,
				focusSide: "new",
			});
		root.render(<Fixture doc={build(source)} />);
		await settle();
		await pauseAt(200);
		const trimmed = trimSourceText(source, 2_000);
		root.render(<Fixture doc={build(trimmed)} />);
		await settle();
		expect(controllers.get("inline")?.following).toBe(false);
		expect(scroller().scrollTop).toBe(0);
		expect(canvas().querySelector("[data-diff-range-warning='range']")).not.toBeNull();
		const replaced = createSourceText(text(500), { epoch: "reconnect" });
		root.render(<Fixture doc={build(replaced)} />);
		await settle();
		expect(controllers.get("inline")?.following).toBe(false);
		expect(scroller().scrollTop).toBe(0);
		expect(canvas().querySelector("[data-diff-range-warning='epoch']")).not.toBeNull();
	});

	test("an added row becoming context stays the followed source row", async () => {
		const old = text(900);
		root.render(
			<Fixture
				doc={createDiffDocument({
					oldText: old,
					newText: `${text(899)}\nreplacement`,
					focusSide: "new",
				})}
			/>,
		);
		await settle();
		const node = scroller();
		expect(canvas().querySelector("[data-diff-focus]")?.getAttribute("data-diff-row")).toBe(
			"added",
		);
		root.render(
			<Fixture doc={createDiffDocument({ oldText: old, newText: old, focusSide: "new" })} />,
		);
		await settle();
		expect(scroller()).toBe(node);
		expect(canvas().querySelector("[data-diff-focus]")?.getAttribute("data-diff-row")).toBe(
			"context",
		);
		expect(focusVisible()).toBe(true);
	});

	test("a new focus still inside the viewport does not move it", async () => {
		const base = createDiffDocument({ oldText: text(2_000), newText: text(2_000) });
		root.render(
			<Fixture doc={{ ...base, focus: getDiffRowAnchor(base, 80), revision: "focus80" }} />,
		);
		await settle();
		const before = scroller().scrollTop;
		root.render(
			<Fixture doc={{ ...base, focus: getDiffRowAnchor(base, 81), revision: "focus81" }} />,
		);
		await settle();
		expect(scroller().scrollTop).toBe(before);
		expect(focusVisible()).toBe(true);
	});

	test("a nearby offscreen focus is reached over queued animation frames", async () => {
		const base = createDiffDocument({ oldText: text(2_000), newText: text(2_000) });
		root.render(
			<Fixture doc={{ ...base, focus: getDiffRowAnchor(base, 80), revision: "smooth80" }} />,
		);
		await settle();
		const before = scroller().scrollTop;
		root.render(
			<Fixture doc={{ ...base, focus: getDiffRowAnchor(base, 100), revision: "smooth100" }} />,
		);
		const positions = new Set<number>();
		for (let i = 0; i < 4; i++) {
			await settle(1);
			positions.add(scroller().scrollTop);
		}
		expect(positions.size).toBeGreaterThan(1);
		expect(scroller().scrollTop).toBeGreaterThan(before);
		await settle();
		expect(focusVisible()).toBe(true);
		expect(frames.size).toBe(0);
	});

	test("a middle change moves upward and completion does not repick the bottom", async () => {
		const base = createDiffDocument({
			oldText: text(1_200),
			newText: text(1_200),
			focusSide: "new",
		});
		root.render(<Fixture doc={base} />);
		await settle();
		const before = scroller().scrollTop;
		const middle: DiffDocument = {
			...base,
			focus: getDiffRowAnchor(base, 750),
			revision: "middle",
		};
		root.render(<Fixture doc={middle} />);
		await settle();
		expect(scroller().scrollTop).toBeLessThan(before - 200);
		expect(canvas().querySelector("[data-diff-focus]")?.getAttribute("data-diff-source-line")).toBe(
			"750",
		);
		const settledTop = scroller().scrollTop;
		root.render(<Fixture doc={{ ...base, revision: "metadata-only-complete" }} live={false} />);
		await settle();
		expect(scroller().scrollTop).toBeCloseTo(settledTop, 0);
		expect(canvas().querySelector("[data-diff-focus]")?.getAttribute("data-diff-source-line")).toBe(
			"750",
		);
	});

	test("pure deletion uses the old side and empty output keeps the same paused host", async () => {
		root.render(
			<Fixture doc={createDiffDocument({ oldText: text(800), newText: "", focusSide: "new" })} />,
		);
		await settle();
		const node = scroller();
		expect(canvas().querySelector("[data-diff-focus]")?.getAttribute("data-diff-row")).toBe(
			"removed",
		);
		expect(focusVisible()).toBe(true);
		await pauseAt(200);
		root.render(<Fixture doc={createDiffDocument({ oldText: "", newText: "" })} live={false} />);
		await settle();
		expect(scroller()).toBe(node);
		expect(node.scrollTop).toBe(0);
		expect(controllers.get("inline")?.following).toBe(false);
		expect(canvas().querySelectorAll("[data-diff-row]")).toHaveLength(0);
	});

	test("resuming a paused projection selects current focus instead of its local end", async () => {
		root.render(
			<Fixture doc={createDiffDocument({ oldText: "", newText: text(1_600), focusSide: "new" })} />,
		);
		await settle();
		await pauseAt(200);
		expect(Number(canvas().dataset.diffProjectionStart)).toBeLessThan(500);
		const button = container.querySelector<HTMLButtonElement>("button[aria-label]");
		expect(button).not.toBeNull();
		button?.click();
		await settle();
		expect(controllers.get("inline")?.following).toBe(true);
		expect(focusVisible()).toBe(true);
		expect(Number(canvas().dataset.diffProjectionStart)).toBeGreaterThan(1_000);
	});

	test("a retained partial first line clamps its source column without resuming", async () => {
		const first = "abcdefghijklmnopqrstuvwxyz".repeat(80);
		const source = createSourceText(`${first}\n${text(400)}`, { epoch: "partial" });
		const build = (value: typeof source) =>
			createDiffDocument({
				oldText: value.text,
				newText: value.text,
				oldRange: value.range,
				newRange: value.range,
				focusSide: "new",
			});
		root.render(<Fixture doc={build(source)} wrap />);
		await settle();
		await pauseAt(6);
		const before = scroller().scrollTop;
		const trimmed = trimSourceText(source, source.text.length - 100);
		root.render(<Fixture doc={build(trimmed)} wrap />);
		await settle();
		expect(scroller().scrollTop).toBeLessThan(before);
		expect(controllers.get("inline")?.following).toBe(false);
		expect(canvas().querySelector("[data-diff-range-warning='range']")).toBeNull();
	});

	test("static history stays at its head and unmount releases follow frames", async () => {
		root.render(
			<Fixture doc={createDiffDocument({ oldText: "", newText: text(2_000) })} live={false} />,
		);
		await settle();
		expect(scroller().scrollTop).toBe(0);
		expect(Number(canvas().dataset.diffProjectionStart)).toBe(0);
		root.render(null);
		await tick();
		expect(frames.size).toBe(0);
		expect(controllers.size).toBe(0);
	});
});
