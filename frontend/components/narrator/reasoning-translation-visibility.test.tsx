import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	REASONING_VISIBILITY_MAX_SOURCE_CHARS,
	type ReasoningTranslationSource,
	reasoningTranslationSource,
} from "@shared/pretext-layout/reasoning-translation-sources";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NarratorPanelVisibilityProvider } from "./narrator-panel-visibility";
import {
	hasVisibleReasoningClientRect,
	intersectReasoningVisibilityRects,
	REASONING_VISIBILITY_ANIMATION_FRAMES,
	REASONING_VISIBILITY_MAX_FRAGMENTS,
	REASONING_VISIBILITY_MAX_MATCH_CALLS,
	REASONING_VISIBILITY_MAX_TEXT_NODES,
	ReasoningTranslationText,
	ReasoningTranslationVisibilityController,
	ReasoningTranslationVisibilityProvider,
} from "./reasoning-translation-visibility";
import { measureReasoning } from "./vlist/measure/measure-reasoning";
import { measureReasoningStepsTrace } from "./vlist/measure/measure-tool-run";
import { installCanvasStub } from "./vlist/measure/test-canvas-stub";
import { RenderReasoning } from "./vlist/render/RenderReasoning";
import { RenderToolRun } from "./vlist/render/RenderToolRun";

const disposeCanvas = installCanvasStub();
afterAll(disposeCanvas);

let root: Root;
let host: HTMLElement;
let frames: Record<string, unknown>[];
let pending: Map<number, FrameRequestCallback>;
let frameTime: number;
let restorePrototype: () => void;
let originalSocket: unknown;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const internal = narratorWSManager as unknown as { ws: unknown; _restoreSubscriptions(): void };

function source(id = "element", text = "visible source"): ReasoningTranslationSource {
	return {
		text,
		ranges: [
			{
				start: 0,
				end: text.length,
				target: { ownerNarratorId: "owner", messageId: "message", blockId: "block", elementId: id },
			},
		],
	};
}
function repeatedSource(value = "想想🙂e\u0301"): ReasoningTranslationSource {
	const first = source("first", value);
	const second = source("second", value);
	return {
		text: value + value,
		ranges: [
			...first.ranges,
			...second.ranges.map((range) => ({
				...range,
				start: range.start + value.length,
				end: range.end + value.length,
			})),
		],
	};
}
function budgetFragments() {
	const late = source("late-fragment", "visible target");
	const earlier = Array.from({ length: REASONING_VISIBILITY_MAX_MATCH_CALLS }, (_, index) => {
		const id = `unmatched-${index}`;
		return (
			<ReasoningTranslationText key={id} source={source(id, "original source")}>
				{`different rendered text ${index}`}
			</ReasoningTranslationText>
		);
	});
	return {
		late,
		body: (
			<>
				{earlier}
				<ReasoningTranslationText source={late}>{late.text}</ReasoningTranslationText>
			</>
		),
	};
}
function graphemes(value: string) {
	return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
		({ segment, index }) => (
			<span key={index} data-grapheme={index}>
				{segment}
			</span>
		),
	);
}
async function animation(element: Element | null, type: string, name = "reasoning-reveal") {
	if (!element) throw new Error("Missing animated visibility fixture");
	await act(async () => {
		const event = new Event(type, { bubbles: true });
		Object.defineProperty(event, "animationName", { value: name });
		element.dispatchEvent(event);
	});
}
function runningAnimation(element: Element | null) {
	if (!element) throw new Error("Missing running animation fixture");
	const mustKeepRunning = () => {
		throw new Error("Visibility discovery must preserve the text timeline");
	};
	Object.defineProperty(element, "getAnimations", {
		configurable: true,
		value: () => [
			{
				id: "existing-reveal",
				animationName: "reasoning-reveal",
				playState: "running",
				effect: { target: element },
				cancel: mustKeepRunning,
				finish: mustKeepRunning,
				pause: mustKeepRunning,
			},
		],
	});
}
function replaceProperty(target: object, key: PropertyKey, value: unknown): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, writable: true, value });
	return () => {
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	};
}
function translations() {
	return frames.filter((frame) => frame.type === "reasoning_translation_visibility");
}
async function flush() {
	await act(async () => {
		frameTime += 16;
		for (const [id, callback] of [...pending]) {
			pending.delete(id);
			callback(frameTime);
		}
		await Promise.resolve();
	});
}
async function render(node: ReactNode) {
	await act(async () => root.render(node));
	await flush();
}
function panel(children: ReactNode, visible = true) {
	return (
		<NarratorPanelVisibilityProvider value={visible}>
			<ReasoningTranslationVisibilityProvider narratorId="viewer">
				{children}
			</ReasoningTranslationVisibilityProvider>
		</NarratorPanelVisibilityProvider>
	);
}
function text(y: number, projection: ReasoningTranslationSource | null = source()) {
	return (
		<p data-y={y}>
			<ReasoningTranslationText source={projection ?? undefined}>
				{projection?.text ?? "visible source"}
			</ReasoningTranslationText>
		</p>
	);
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body><div id='host'></div></body></html>");
	frames = [];
	pending = new Map();
	frameTime = 0;
	let nextFrame = 0;
	const computedStyle = (element: Element) => {
		const style = (element as HTMLElement).style;
		return {
			getPropertyValue: () => "",
			display: style.display || "block",
			visibility: style.visibility || "visible",
			opacity: style.opacity || "1",
			overflow: style.overflow || "visible",
			overflowX: style.overflowX || style.overflow || "visible",
			overflowY: style.overflowY || style.overflow || "visible",
			clipPath: style.clipPath || "none",
			contentVisibility: "visible",
		};
	};
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: computedStyle,
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			pending.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => pending.delete(id),
		IntersectionObserver: undefined,
		ResizeObserver: undefined,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	window.getComputedStyle = computedStyle as unknown as typeof window.getComputedStyle;
	const prototype = window.HTMLElement.prototype;
	const rectDescriptor = Object.getOwnPropertyDescriptor(prototype, "getBoundingClientRect");
	Object.defineProperty(prototype, "getBoundingClientRect", {
		configurable: true,
		value(this: HTMLElement) {
			const top = Number(this.getAttribute("data-y") ?? 0);
			const height = Number(this.getAttribute("data-height") ?? 600);
			return { left: 0, right: 800, top, bottom: top + height, width: 800, height };
		},
	});
	restorePrototype = () => {
		if (rectDescriptor) Object.defineProperty(prototype, "getBoundingClientRect", rectDescriptor);
		else Reflect.deleteProperty(prototype, "getBoundingClientRect");
	};
	Object.defineProperty(document, "createRange", {
		configurable: true,
		value: () => {
			let node: Node;
			let start = 0;
			let end = 0;
			return {
				setStart(value: Node, offset: number) {
					node = value;
					start = offset;
				},
				setEnd(_value: Node, offset: number) {
					end = offset;
				},
				getClientRects() {
					const top = Number(node.parentElement?.closest("[data-y]")?.getAttribute("data-y") ?? 0);
					return [{ left: start * 5, right: end * 5, top, bottom: top + 12 }];
				},
			};
		},
	});
	const container = document.getElementById("host");
	if (!container) throw new Error("Missing visibility test container");
	host = container;
	root = createRoot(host);
	originalSocket = internal.ws;
	internal.ws = {
		readyState: WebSocket.OPEN,
		send: (payload: string) => frames.push(JSON.parse(payload)),
	};
});
afterEach(async () => {
	await act(async () => root.unmount());
	internal.ws = originalSocket;
	restorePrototype();
	for (const [key, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	descriptors.clear();
});

describe("visible reasoning demand", () => {
	test("the reasoning renderer registers only its expanded body, not its collapsed preview", async () => {
		const projection = source();
		const paint = (expanded: boolean) =>
			panel(
				<MantineProvider>
					<RenderReasoning
						measured={measureReasoning({ text: projection.text }, 400, 4, { expanded })}
						translationSource={projection}
					/>
				</MantineProvider>,
			);
		await render(paint(false));
		expect(translations()).toEqual([]);
		await render(paint(true));
		expect(translations()).toHaveLength(1);
		await render(paint(false));
		expect(translations().at(-1)?.targets).toEqual([]);
	});

	test("structured titles request their own source while another source's body stays folded", async () => {
		const title = source("title", "visible title");
		const body = source("body", "hidden body");
		const paint = (expanded: boolean) =>
			panel(
				<MantineProvider>
					<RenderToolRun
						measured={measureReasoningStepsTrace(
							[{ title: title.text, body: body.text, key: "seg0" }],
							400,
							{ expandedIndices: expanded ? [0] : [] },
						)}
						translationSources={new Map([["seg0", { title, body }]])}
					/>
				</MantineProvider>,
			);
		await render(paint(false));
		expect(translations()[0]?.targets).toEqual(title.ranges.map((range) => range.target));
		await render(paint(true));
		expect(translations().at(-1)?.targets).toHaveLength(2);
	});

	test("one merged body activates only the original element whose text is visible", async () => {
		const first = source("first", "first");
		const second = source("second", "second");
		const merged: ReasoningTranslationSource = {
			text: "first\n\nsecond",
			ranges: [
				...first.ranges,
				...second.ranges.map((range) => ({ ...range, start: range.start + 7, end: range.end + 7 })),
			],
		};
		await render(
			panel(
				<ReasoningTranslationText source={merged}>
					<span data-y={20}>first</span>
					<span data-y={900}>second</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()[0]?.targets).toEqual(first.ranges.map((range) => range.target));
	});

	test("an active persisted element reports only its own visible original, never the run anchor", async () => {
		const elements = [
			{ type: "reasoning", id: "first", text: "completed original" },
			{ type: "reasoning", id: "tail", text: "active original", translatedText: "过期译文" },
		];
		const persisted = rowWithElements(
			{
				id: "message",
				narratorId: "owner",
				liveContentProjection: true,
				liveBlockIndex: 1,
				reasoningTranslationActivity: { elementId: "tail", revision: 3, completedRanges: [] },
			},
			elements,
		);
		const projection = reasoningTranslationSource(
			{
				...persisted,
				blocks: (persisted.blocks ?? []).map((block) => ({ ...block, named: true })),
			},
			elements.map((block, index) => ({ block, index })),
		);
		expect(projection?.text).toBe("completed original\n\nactive original");
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span data-y={20} data-source="first">
						completed original
					</span>
					<span data-y={900} data-source="tail">
						active original
					</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations().at(-1)?.targets).toEqual([
			expect.objectContaining({ elementId: "first" }),
		]);
		host.querySelector('[data-source="first"]')?.setAttribute("data-y", "900");
		host.querySelector('[data-source="tail"]')?.setAttribute("data-y", "20");
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations().at(-1)?.targets).toEqual([
			expect.objectContaining({ elementId: "tail" }),
		]);
		expect(translations().at(-1)?.groups).toEqual([
			expect.objectContaining({
				anchor: expect.objectContaining({ elementId: "first" }),
				targetIndexes: [0],
			}),
		]);
		host.querySelector('[data-source="tail"]')?.setAttribute("data-y", "900");
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations().at(-1)?.targets).toEqual([]);
	});

	test("a visible cached prefix cannot activate an untranslated off-screen tail", async () => {
		const projection = source("tail", "译文 tail");
		projection.ranges[0] = {
			...projection.ranges[0],
			start: 3,
			end: 7,
			target: source("tail").ranges[0].target,
		};
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span data-y={20}>译文</span>
					<span data-y={900}>tail</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()).toEqual([]);
		host.querySelector('[data-y="900"]')?.setAttribute("data-y", "20");
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations()).toHaveLength(1);
	});

	test("mounted overscan text waits for actual viewport intersection, then revokes off-screen", async () => {
		await render(panel(text(900)));
		expect(translations()).toEqual([]);
		host.querySelector("p")?.setAttribute("data-y", "20");
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations()).toHaveLength(1);
		expect(translations()[0]?.targets).toEqual(source().ranges.map((range) => range.target));
		host.querySelector("p")?.setAttribute("data-y", "900");
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations().at(-1)?.targets).toEqual([]);
	});

	test("hidden panel and background document issue no demand", async () => {
		await render(panel(text(20), false));
		expect(translations()).toEqual([]);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await render(panel(text(20), true));
		expect(translations()).toEqual([]);
	});

	test("backgrounding and unmount release the holder independently", async () => {
		await render(panel(text(20)));
		expect(translations()).toHaveLength(1);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(translations().at(-1)?.targets).toEqual([]);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await flush();
		expect((translations().at(-1)?.targets as unknown[]).length).toBe(1);
		await render(null);
		expect(translations().at(-1)?.targets).toEqual([]);
	});

	test("a visible header cannot activate collapsed or ancestor-clipped body text", async () => {
		await render(
			panel(
				<>
					<p data-y={20}>reasoning header</p>
					<div style={{ overflow: "hidden" }} data-y={0} data-height={40}>
						{text(100)}
					</div>
				</>,
			),
		);
		expect(translations()).toEqual([]);
		await render(panel(<p data-y={20}>collapsed reasoning header</p>));
		expect(translations()).toEqual([]);
	});

	test("separate visible holders do not cancel each other", async () => {
		await render(
			<>
				{panel(text(20))}
				{panel(text(40))}
			</>,
		);
		expect(translations()).toHaveLength(2);
		const ids = translations().map((frame) => frame.visibilityId);
		expect(new Set(ids).size).toBe(2);
		await render(
			<>
				{panel(text(20), false)}
				{panel(text(40))}
			</>,
		);
		expect(translations()).toHaveLength(3);
		expect(translations().at(-1)).toMatchObject({ visibilityId: ids[0], targets: [] });
	});

	test("reconnect re-checks actual text geometry instead of restoring stale demand", async () => {
		await render(panel(text(20)));
		frames.length = 0;
		host.querySelector("p")?.setAttribute("data-y", "900");
		internal._restoreSubscriptions();
		expect(translations()).toEqual([]);
		host.querySelector("p")?.setAttribute("data-y", "20");
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations()).toHaveLength(1);
	});

	test("streaming handoff and source identity reuse replace only the current target", async () => {
		await render(panel(text(20, null)));
		// No untranslated persisted identity has been supplied by the adapter yet.
		expect(translations()).toEqual([]);
		await render(panel(text(20, source("persisted"))));
		expect(translations()).toHaveLength(1);
		await render(panel(text(20, source("persisted", "visible source appended"))));
		expect(translations()).toHaveLength(1);
		await render(panel(text(20, source("replacement"))));
		expect(translations().at(-1)?.targets).toEqual(
			source("replacement").ranges.map((range) => range.target),
		);
	});

	test("generic chat/share renderers have no model-demand host", async () => {
		await render(text(20));
		expect(translations()).toEqual([]);
	});

	test("IntersectionObserver has zero overscan margin and cannot bypass clipped text ranges", async () => {
		let options: IntersectionObserverInit | undefined;
		Object.defineProperty(globalThis, "IntersectionObserver", {
			configurable: true,
			value: class {
				constructor(_callback: IntersectionObserverCallback, value: IntersectionObserverInit) {
					options = value;
				}
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		});
		await render(panel(text(900)));
		expect(options?.rootMargin).toBe("0px");
		expect(translations()).toEqual([]);
	});

	test("grapheme-split repeated sources keep their exact target and UTF-16 node offsets", async () => {
		const projection = repeatedSource();
		const half = projection.text.slice(0, projection.text.length / 2);
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span data-y={900}>{graphemes(half)}</span>
					<span data-y={20} data-part="second">
						{graphemes(half)}
					</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations().at(-1)?.targets).toEqual([projection.ranges[1].target]);
		// Measure the emoji's two UTF-16 units inside its own Text, not its wrapper.
		const unicode = source("unicode", "🙂");
		await render(
			panel(
				<ReasoningTranslationText source={unicode}>
					{graphemes(unicode.text)}
				</ReasoningTranslationText>,
			),
		);
		const createRange = document.createRange.bind(document);
		const measured: { text: string | null; start: number; end: number }[] = [];
		const restoreRange = replaceProperty(document, "createRange", () => {
			const range = createRange();
			const setStart = range.setStart.bind(range);
			const setEnd = range.setEnd.bind(range);
			let entry: (typeof measured)[number];
			range.setStart = (node, offset) => {
				entry = { text: node.textContent, start: offset, end: -1 };
				setStart(node, offset);
			};
			range.setEnd = (node, offset) => {
				entry.end = offset;
				measured.push(entry);
				setEnd(node, offset);
			};
			return range;
		});
		try {
			document.dispatchEvent(new Event("scroll"));
			await flush();
			expect(measured).toEqual([{ text: "🙂", start: 0, end: 2 }]);
			expect(translations().at(-1)?.targets).toEqual([unicode.ranges[0].target]);
		} finally {
			restoreRange();
		}
	});

	test("paragraph context disambiguates repeated graphemes across original sources", async () => {
		const projection = repeatedSource("aba");
		projection.text = "aba\n\naba";
		projection.ranges[1] = { ...projection.ranges[1], start: 5, end: 8 };
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<p data-y={900}>{graphemes("aba")}</p>
					<p data-y={20}>{graphemes("aba")}</p>
				</ReasoningTranslationText>,
			),
		);
		expect(translations().at(-1)?.targets).toEqual([projection.ranges[1].target]);
	});

	test("separate registered containers cannot borrow repeated text to disambiguate each other", async () => {
		const projection = repeatedSource("aba");
		await render(
			panel(
				<>
					<ReasoningTranslationText source={projection}>
						{graphemes("aba")}
					</ReasoningTranslationText>
					<ReasoningTranslationText source={projection}>
						{graphemes("aba")}
					</ReasoningTranslationText>
				</>,
			),
		);
		expect(translations()).toEqual([]);
		expect(pending.size).toBe(0);
	});

	test("one matched source cannot prove another source behind its own opacity or clip", async () => {
		const projection = { ...repeatedSource("aab"), text: "aabaac" };
		const paint = (opacity: number, y: number) =>
			panel(
				<ReasoningTranslationText source={projection}>
					<span data-y={20}>{graphemes("aab")}</span>
					<span style={{ overflow: "hidden" }} data-y={0} data-height={40}>
						<span style={{ opacity }} data-y={y}>
							{graphemes("aac")}
						</span>
					</span>
				</ReasoningTranslationText>,
			);
		await render(paint(0, 20));
		expect(translations().at(-1)?.targets).toEqual([projection.ranges[0].target]);
		await render(paint(1, 100));
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations().at(-1)?.targets).toEqual([projection.ranges[0].target]);
		await render(paint(1, 20));
		document.dispatchEvent(new Event("scroll"));
		await flush();
		expect(translations().at(-1)?.targets).toEqual(projection.ranges.map((range) => range.target));
	});

	test.each([
		"opacity",
		"display",
		"visibility",
		"clip",
	])("a %s-hidden prefix cannot assign another target's repeated character", async (hidden) => {
		const projection = { ...repeatedSource("abc"), text: "abcc" };
		projection.ranges[1] = { ...projection.ranges[1], start: 3, end: 4 };
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span
						style={{ overflow: hidden === "clip" ? "hidden" : "visible" }}
						data-y={0}
						data-height={40}
					>
						<span
							style={{
								opacity: hidden === "opacity" ? 0 : 1,
								display: hidden === "display" ? "none" : "inline",
								visibility: hidden === "visibility" ? "hidden" : "visible",
							}}
							data-y={hidden === "clip" ? 100 : 20}
						>
							ab
						</span>
					</span>
					<span data-y={20}>c</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()).toEqual([]);
	});

	test("a hidden middle cannot bridge an unowned prefix into an ambiguous target", async () => {
		const projection = { ...repeatedSource("abc"), text: "abcc" };
		projection.ranges[0] = { ...projection.ranges[0], start: 2, end: 3 };
		projection.ranges[1] = { ...projection.ranges[1], start: 3, end: 4 };
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span>a</span>
					<span style={{ opacity: 0 }}>b</span>
					<span>c</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()).toEqual([]);
	});

	test("an opacity-restored bridge invalidates attribution before its animation finishes", async () => {
		const projection = { ...repeatedSource("abc"), text: "abcc" };
		projection.ranges[1] = { ...projection.ranges[1], start: 3, end: 4 };
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span style={{ opacity: 0 }} data-animated>
						abc
					</span>
					<span>c</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()).toEqual([]);
		const animated = host.querySelector<HTMLElement>("[data-animated]");
		await animation(animated, "animationstart");
		if (!animated) throw new Error("Missing hidden source bridge");
		animated.style.opacity = "0.2";
		await flush();
		expect(translations().at(-1)?.targets).toEqual(projection.ranges.map((range) => range.target));
		expect(pending.size).toBe(0);
	});

	test("a visible container is not evidence when its exact Text ranges have no rectangles", async () => {
		const restoreRange = replaceProperty(document, "createRange", () => ({
			setStart() {},
			setEnd() {},
			getClientRects: () => [],
		}));
		const restoreRects: (() => void)[] = [];
		try {
			await render(panel(text(20)));
			for (const element of host.querySelectorAll("*")) {
				restoreRects.push(
					replaceProperty(element, "getBoundingClientRect", () => {
						throw new Error("A visible parent cannot prove visible reasoning text");
					}),
				);
			}
			document.dispatchEvent(new Event("scroll"));
			await flush();
			expect(translations()).toEqual([]);
		} finally {
			for (const restore of restoreRects) restore();
			restoreRange();
		}
	});

	test("buttons, scripts, styles, aria-hidden and copy helpers never become source evidence", async () => {
		await render(
			panel(
				<ReasoningTranslationText source={source()}>
					<button type="button">visible source</button>
					<script type="application/json">visible source</script>
					<style>{"visible source"}</style>
					<span aria-hidden="true">visible source</span>
					<span data-vlist-copy-ignore>visible source</span>
					<span>unrelated painted text</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()).toEqual([]);
	});

	test("animation rechecks reuse text matching until the actual source DOM changes", async () => {
		const createTreeWalker = document.createTreeWalker.bind(document);
		let scans = 0;
		document.createTreeWalker = (...args) => {
			scans++;
			return createTreeWalker(...args);
		};
		await render(
			panel(
				<ReasoningTranslationText source={source()}>
					<span style={{ opacity: 0 }} data-animated>
						{graphemes("visible source")}
					</span>
				</ReasoningTranslationText>,
			),
		);
		expect(scans).toBe(1);
		await animation(host.querySelector("[data-animated]"), "animationstart");
		for (let frame = 0; frame < 4; frame++) await flush();
		expect(scans).toBe(1);
		await act(async () => {
			const animated = host.querySelector("[data-animated]");
			if (!animated) throw new Error("Missing animated source");
			animated.textContent = "unrelated replacement";
		});
		await flush();
		expect(scans).toBe(2);
		expect(translations()).toEqual([]);
	});

	test("continuous grapheme mutations keep one total source-matching budget per read", async () => {
		const visible = Array.from({ length: REASONING_VISIBILITY_MAX_MATCH_CALLS * 4 }, (_, index) =>
			String.fromCodePoint(0x4e00 + index),
		).join("");
		const raw = [...visible].map((character) => `**${character}**`).join("");
		const projection = source("bounded-matching", raw);
		let sourceReads = 0;
		Object.defineProperty(projection, "text", {
			get() {
				sourceReads++;
				return raw;
			},
		});
		await act(async () =>
			root.render(
				panel(
					<ReasoningTranslationText source={projection}>
						<span data-mutating>{graphemes(visible)}</span>
					</ReasoningTranslationText>,
				),
			),
		);
		// Each helper call reads source.text; initial normalization and registration
		// account for two more reads. This fails a per-grapheme source rescan.
		expect(sourceReads).toBeLessThanOrEqual(REASONING_VISIBILITY_MAX_MATCH_CALLS + 2);
		for (let iteration = 0; iteration < 8; iteration++) {
			const before = sourceReads;
			await act(async () => {
				host.querySelector("[data-mutating]")?.append(document.createTextNode(visible[0]));
			});
			expect(sourceReads - before).toBeLessThanOrEqual(REASONING_VISIBILITY_MAX_MATCH_CALLS);
			const beforeFrame = sourceReads;
			await flush();
			expect(sourceReads - beforeFrame).toBeLessThanOrEqual(REASONING_VISIBILITY_MAX_MATCH_CALLS);
		}
		expect(translations().at(-1)?.targets).toEqual(projection.ranges.map((range) => range.target));
		expect(pending.size).toBe(0);
	});

	test("static fragments beyond one matching budget progress without mutation or scroll", async () => {
		const fixture = budgetFragments();
		await act(async () => root.render(panel(fixture.body)));
		expect(translations()).toEqual([]);
		expect(pending.size).toBe(1);
		await flush();
		expect(translations().at(-1)?.targets).toEqual(
			fixture.late.ranges.map((range) => range.target),
		);
		expect(pending.size).toBe(0);
		const sent = translations().length;
		await flush();
		expect(translations()).toHaveLength(sent);
		expect(pending.size).toBe(0);
	});

	test("a static long fallback resumes its exact cursor after the short-text cache fills", async () => {
		const prefix = Array.from({ length: REASONING_VISIBILITY_MAX_MATCH_CALLS * 6 }, (_, index) =>
			String.fromCodePoint(0x4e00 + index),
		).join("");
		const raw = `${[...prefix].map((character) => `**${character}**`).join("")}**tail**`;
		const projection = source("static-late", raw);
		const start = raw.indexOf("tail");
		projection.ranges[0] = { ...projection.ranges[0], start, end: start + 4 };
		let sourceReads = 0;
		Object.defineProperty(projection, "text", {
			get() {
				sourceReads++;
				return raw;
			},
		});
		await act(async () =>
			root.render(
				panel(
					<ReasoningTranslationText source={projection}>
						<span>{graphemes(prefix)}</span>
						<span>tail</span>
					</ReasoningTranslationText>,
				),
			),
		);
		expect(translations()).toEqual([]);
		expect(pending.size).toBe(1);
		expect(sourceReads).toBeLessThanOrEqual(REASONING_VISIBILITY_MAX_MATCH_CALLS + 2);
		const maximumFrames = Math.ceil((prefix.length + 2) / REASONING_VISIBILITY_MAX_MATCH_CALLS) + 1;
		for (let frame = 0; frame < maximumFrames && pending.size; frame++) {
			const before = sourceReads;
			await flush();
			expect(sourceReads - before).toBeLessThanOrEqual(REASONING_VISIBILITY_MAX_MATCH_CALLS);
		}
		expect(translations().at(-1)?.targets).toEqual(projection.ranges.map((range) => range.target));
		expect(pending.size).toBe(0);
		const reads = sourceReads;
		await flush();
		expect(sourceReads).toBe(reads);
	});

	test("continuation and scroll hints share one allowance within the same browser frame", async () => {
		const prefix = Array.from({ length: REASONING_VISIBILITY_MAX_MATCH_CALLS * 3 }, (_, index) =>
			String.fromCodePoint(0x4e00 + index),
		).join("");
		const raw = `${[...prefix].map((character) => `**${character}**`).join("")}**tail**`;
		const projection = source("shared-frame", raw);
		const start = raw.indexOf("tail");
		projection.ranges[0] = { ...projection.ranges[0], start, end: start + 4 };
		let sourceReads = 0;
		Object.defineProperty(projection, "text", {
			get() {
				sourceReads++;
				return raw;
			},
		});
		await act(async () =>
			root.render(
				panel(
					<ReasoningTranslationText source={projection}>
						<span>{graphemes(prefix)}</span>
						<span>tail</span>
					</ReasoningTranslationText>,
				),
			),
		);
		document.dispatchEvent(new Event("scroll"));
		expect(pending.size).toBe(2);
		const before = sourceReads;
		frameTime += 16;
		const sameFrame = frameTime;
		for (const [id, callback] of [...pending]) {
			pending.delete(id);
			// Separate checkpoints force separate visibility reads in one frame.
			await act(async () => callback(sameFrame));
		}
		expect(sourceReads - before).toBeLessThanOrEqual(REASONING_VISIBILITY_MAX_MATCH_CALLS);
		for (let frame = 0; frame < 5 && pending.size; frame++) await flush();
		expect(translations().at(-1)?.targets).toEqual(projection.ranges.map((range) => range.target));
		expect(pending.size).toBe(0);
	});

	test("backgrounding cancels finite matching work and foregrounding resumes it", async () => {
		const fixture = budgetFragments();
		await act(async () => root.render(panel(fixture.body)));
		expect(pending.size).toBe(1);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(pending.size).toBe(0);
		await flush();
		expect(translations()).toEqual([]);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await flush();
		expect(translations().at(-1)?.targets).toEqual(
			fixture.late.ranges.map((range) => range.target),
		);
		expect(pending.size).toBe(0);
	});

	test("foregrounding revalidates text changed while its matching cursor was paused", async () => {
		const fixture = budgetFragments();
		await act(async () => root.render(panel(fixture.body)));
		expect(pending.size).toBe(1);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(pending.size).toBe(0);
		const text = host.lastElementChild?.firstChild;
		if (!text) throw new Error("Missing paused source text");
		await act(async () => {
			text.nodeValue = "changed source";
		});
		await flush();
		expect(translations()).toEqual([]);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await flush();
		expect(text.nodeValue).toBe("changed source");
		expect(translations()).toEqual([]);
		expect(pending.size).toBe(0);
		await act(async () => {
			text.nodeValue = fixture.late.text;
		});
		await flush();
		expect(translations().at(-1)?.targets).toEqual(
			fixture.late.ranges.map((range) => range.target),
		);
		expect(pending.size).toBe(0);
	});

	test("deactivation, fragment removal and unmount cancel unfinished matching frames", async () => {
		const fixture = budgetFragments();
		await act(async () => root.render(panel(fixture.body)));
		expect(pending.size).toBe(1);
		await render(panel(fixture.body, false));
		expect(pending.size).toBe(0);
		expect(translations()).toEqual([]);
		await act(async () => root.render(panel(fixture.body)));
		expect(pending.size).toBe(1);
		await render(panel(<p>heading</p>));
		expect(pending.size).toBe(0);
		await act(async () => root.render(panel(fixture.body)));
		expect(pending.size).toBe(1);
		await act(async () => root.render(null));
		expect(pending.size).toBe(0);
		await flush();
		expect(translations()).toEqual([]);
	});

	test("a budget-limited late target recovers when its active text becomes visible again", async () => {
		const prefix = Array.from({ length: REASONING_VISIBILITY_MAX_MATCH_CALLS * 2 }, (_, index) =>
			String.fromCodePoint(0x4e00 + index),
		).join("");
		const raw = `${[...prefix].map((character) => `**${character}**`).join("")}**tail**`;
		const projection = source("late", raw);
		const start = raw.indexOf("tail");
		projection.ranges[0] = { ...projection.ranges[0], start, end: start + 4 };
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span>{graphemes(prefix)}</span>
					<span data-animated>tail</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()).toEqual([]);
		const animated = host.querySelector<HTMLElement>("[data-animated]");
		if (!animated) throw new Error("Missing budget-limited target");
		animated.style.opacity = "0";
		await animation(animated, "animationstart");
		expect(translations()).toEqual([]);
		animated.style.opacity = "0.2";
		await flush();
		expect(translations().at(-1)?.targets).toEqual(projection.ranges.map((range) => range.target));
		expect(pending.size).toBe(0);
	});

	test("text and exclusion-attribute mutations invalidate only the registered matching cache", async () => {
		await render(
			panel(
				<ReasoningTranslationText source={source()}>
					<span aria-hidden="true" data-mutable>
						visible source
					</span>
				</ReasoningTranslationText>,
			),
		);
		expect(translations()).toEqual([]);
		await act(async () => {
			host.querySelector("[data-mutable]")?.removeAttribute("aria-hidden");
		});
		await flush();
		expect(translations().at(-1)?.targets).toEqual(source().ranges.map((range) => range.target));
		await act(async () => {
			const node = host.querySelector("[data-mutable]")?.firstChild;
			if (!node) throw new Error("Missing mutable source text");
			node.nodeValue = "different painted text";
		});
		await flush();
		expect(translations().at(-1)?.targets).toEqual([]);
		expect(pending.size).toBe(0);
	});

	test("opacity becomes visible and reports demand before its text animation ends", async () => {
		await render(
			panel(
				<ReasoningTranslationText source={source()}>
					<span style={{ opacity: 0, animation: "reasoning-reveal 3s both" }} data-animated>
						{graphemes("visible source")}
					</span>
				</ReasoningTranslationText>,
			),
		);
		const animated = host.querySelector<HTMLElement>("[data-animated]");
		await animation(animated, "animationstart");
		expect(translations()).toEqual([]);
		expect(pending.size).toBe(1);
		if (!animated) throw new Error("Missing animated source");
		animated.style.opacity = "0.2";
		await flush();
		expect(translations().at(-1)?.targets).toEqual(source().ranges.map((range) => range.target));
		expect(animated.style.animation).toBe("reasoning-reveal 3s both");
		expect(pending.size).toBe(0);
	});

	test("a newly persisted source discovers its already-running opacity animation", async () => {
		const paint = (projection: ReasoningTranslationSource | null) =>
			panel(
				<div style={{ opacity: 0 }} data-animated>
					{text(20, projection)}
				</div>,
			);
		await render(paint(null));
		const animated = host.querySelector<HTMLElement>("[data-animated]");
		runningAnimation(animated);
		await render(paint(source("persisted")));
		expect(translations()).toEqual([]);
		expect(pending.size).toBe(1);
		if (!animated) throw new Error("Missing persisted animation");
		animated.style.opacity = "0.2";
		await flush();
		expect(translations().at(-1)?.targets).toEqual(
			source("persisted").ranges.map((range) => range.target),
		);
		expect(pending.size).toBe(0);
	});

	test("foregrounding rediscovers active text without retaining a background polling loop", async () => {
		await render(
			panel(
				<div style={{ opacity: 0 }} data-animated>
					{text(20)}
				</div>,
			),
		);
		const animated = host.querySelector<HTMLElement>("[data-animated]");
		runningAnimation(animated);
		await animation(animated, "animationstart");
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(pending.size).toBe(0);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(pending.size).toBe(1);
		if (!animated) throw new Error("Missing foreground animation");
		animated.style.opacity = "0.2";
		await flush();
		expect(translations().at(-1)?.targets).toEqual(source().ranges.map((range) => range.target));
		expect(pending.size).toBe(0);
	});

	test("confirming one target keeps the active animation watch for another target", async () => {
		const projection = { ...repeatedSource("aab"), text: "aabaac" };
		await render(
			panel(
				<ReasoningTranslationText source={projection}>
					<span>{graphemes("aab")}</span>
					<span style={{ opacity: 0 }} data-animated>
						{graphemes("aac")}
					</span>
				</ReasoningTranslationText>,
			),
		);
		const animated = host.querySelector<HTMLElement>("[data-animated]");
		await animation(animated, "animationstart");
		await flush();
		expect(translations().at(-1)?.targets).toEqual([projection.ranges[0].target]);
		expect(pending.size).toBe(1);
		if (!animated) throw new Error("Missing animated source");
		animated.style.opacity = "0.1";
		await flush();
		expect(translations().at(-1)?.targets).toEqual(projection.ranges.map((range) => range.target));
		expect(pending.size).toBe(0);
	});

	test.each([
		"animationend",
		"animationcancel",
	])("%s stops only the temporary demand watch", async (type) => {
		await render(
			panel(
				<div style={{ opacity: 0, animation: "reasoning-reveal 3s both" }} data-animated>
					{text(20)}
				</div>,
			),
		);
		const animated = host.querySelector<HTMLElement>("[data-animated]");
		await animation(animated, "animationstart");
		expect(pending.size).toBe(1);
		await animation(animated, type);
		expect(pending.size).toBe(0);
		expect(translations()).toEqual([]);
		expect(animated?.style.animation).toBe("reasoning-reveal 3s both");
	});

	test("an animation with no visible result has a finite recheck window", async () => {
		await render(
			panel(
				<div style={{ opacity: 0 }} data-animated>
					{text(20)}
				</div>,
			),
		);
		await animation(host.querySelector("[data-animated]"), "animationstart");
		for (let frame = 0; frame < REASONING_VISIBILITY_ANIMATION_FRAMES; frame++) await flush();
		expect(pending.size).toBe(0);
		expect(translations()).toEqual([]);
		await flush();
		expect(pending.size).toBe(0);
	});

	test("unanimated, unrelated and copy-helper animations do not start recheck loops", async () => {
		await render(
			panel(
				<>
					<p data-unrelated>unregistered heading</p>
					<ReasoningTranslationText source={source()}>
						<span style={{ opacity: 0 }}>visible source</span>
						<span data-vlist-copy-ignore data-copy>
							visible source
						</span>
					</ReasoningTranslationText>
				</>,
			),
		);
		expect(pending.size).toBe(0);
		await animation(host.querySelector("[data-unrelated]"), "animationstart");
		await animation(host.querySelector("[data-copy]"), "animationstart");
		expect(pending.size).toBe(0);
		expect(translations()).toEqual([]);
	});

	test("backgrounding cancels animation rechecks without waiting for another frame", async () => {
		await render(
			panel(
				<div style={{ opacity: 0 }} data-animated>
					{text(20)}
				</div>,
			),
		);
		await animation(host.querySelector("[data-animated]"), "animationstart");
		document.dispatchEvent(new Event("scroll"));
		expect(pending.size).toBe(2);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(pending.size).toBe(0);
		await animation(host.querySelector("[data-animated]"), "animationstart");
		expect(pending.size).toBe(0);
		expect(translations()).toEqual([]);
	});

	test("panel deactivation and unmount remove animation listeners and pending frames", async () => {
		const active = new Map<string, Set<EventListenerOrEventListenerObject>>();
		const add = document.addEventListener.bind(document);
		const remove = document.removeEventListener.bind(document);
		Object.defineProperty(document, "addEventListener", {
			configurable: true,
			value(
				type: string,
				listener: EventListenerOrEventListenerObject,
				options?: AddEventListenerOptions | boolean,
			) {
				if (type.startsWith("animation")) {
					let listeners = active.get(type);
					if (!listeners) {
						listeners = new Set();
						active.set(type, listeners);
					}
					listeners.add(listener);
				}
				add(type, listener, options);
			},
		});
		Object.defineProperty(document, "removeEventListener", {
			configurable: true,
			value(
				type: string,
				listener: EventListenerOrEventListenerObject,
				options?: EventListenerOptions | boolean,
			) {
				active.get(type)?.delete(listener);
				remove(type, listener, options);
			},
		});
		const paint = (visible: boolean) =>
			panel(
				<div style={{ opacity: 0 }} data-animated>
					{text(20)}
				</div>,
				visible,
			);
		await render(paint(true));
		expect([...active.values()].map((listeners) => listeners.size)).toEqual([1, 1, 1]);
		await animation(host.querySelector("[data-animated]"), "animationstart");
		expect(pending.size).toBe(1);
		await render(paint(false));
		expect(pending.size).toBe(0);
		expect([...active.values()].every((listeners) => listeners.size === 0)).toBe(true);
		await render(paint(true));
		await animation(host.querySelector("[data-animated]"), "animationstart");
		await render(null);
		expect(pending.size).toBe(0);
		expect([...active.values()].every((listeners) => listeners.size === 0)).toBe(true);
	});

	test("detached registered text cannot keep an animation recheck alive", async () => {
		await render(
			panel(
				<div style={{ opacity: 0 }} data-animated>
					{text(20)}
				</div>,
			),
		);
		await animation(host.querySelector("[data-animated]"), "animationstart");
		const paragraph = host.querySelector("p");
		const parent = paragraph?.parentElement;
		if (!paragraph || !parent) throw new Error("Missing detachable source");
		paragraph.remove();
		await flush();
		expect(pending.size).toBe(0);
		expect(translations()).toEqual([]);
		parent.append(paragraph);
	});

	test("removing registered text releases its frame and observers while the panel stays mounted", async () => {
		const intersection = new Set<Element>();
		const resize = new Set<Element>();
		for (const [name, observed] of [
			["IntersectionObserver", intersection],
			["ResizeObserver", resize],
		] as const) {
			Object.defineProperty(globalThis, name, {
				configurable: true,
				value: class {
					observe(node: Element) {
						observed.add(node);
					}
					unobserve(node: Element) {
						observed.delete(node);
					}
					disconnect() {
						observed.clear();
					}
				},
			});
		}
		const paint = (mounted: boolean) =>
			panel(
				mounted ? (
					<div style={{ opacity: 0 }} data-animated>
						{text(20)}
					</div>
				) : (
					<p>heading</p>
				),
			);
		await render(paint(true));
		await animation(host.querySelector("[data-animated]"), "animationstart");
		expect(pending.size).toBe(1);
		expect(intersection.size).toBe(1);
		expect(resize.size).toBe(1);
		await render(paint(false));
		expect(pending.size).toBe(0);
		expect(intersection.size).toBe(0);
		expect(resize.size).toBe(0);
		expect(translations()).toEqual([]);
	});

	test("text-node, character and fragment scan budgets exclude later visible content", () => {
		const controller = new ReasoningTranslationVisibilityController("viewer", "bounded-scan");
		const container = document.createElement("p");
		host.append(container);
		const projection = source("bounded", "needle");
		for (let index = 0; index < REASONING_VISIBILITY_MAX_TEXT_NODES; index++)
			container.append(document.createTextNode("x"));
		const beyondBudget = document.createTextNode(projection.text);
		Object.defineProperty(beyondBudget, "textContent", {
			configurable: true,
			get() {
				throw new Error("Text beyond the scan budget must not be inspected");
			},
		});
		container.append(beyondBudget);
		let unregister = controller.register(container, projection);
		controller.setVisible(true);
		try {
			expect(controller.readTargets()).toEqual([]);
			unregister();
			container.textContent = "x".repeat(REASONING_VISIBILITY_MAX_SOURCE_CHARS) + projection.text;
			unregister = controller.register(container, projection);
			expect(controller.readTargets()).toEqual([]);
			unregister();
			container.replaceChildren();
			for (let index = 0; index <= REASONING_VISIBILITY_MAX_FRAGMENTS; index++) {
				const fragment = document.createElement("span");
				fragment.setAttribute(
					"data-y",
					index === REASONING_VISIBILITY_MAX_FRAGMENTS ? "20" : "900",
				);
				fragment.textContent = projection.text;
				container.append(fragment);
				controller.register(fragment, projection);
			}
			expect(controller.readTargets()).toEqual([]);
		} finally {
			controller.dispose();
			container.remove();
		}
	});

	test("wrapped text visible only after line 64 is located within a bounded rect-read budget", () => {
		let reads = 0;
		const rects = new Proxy(
			Array.from({ length: 1000 }, (_, index) => ({
				left: 0,
				right: 100,
				top: (index - 900) * 12,
				bottom: (index - 900) * 12 + 10,
			})),
			{
				get(target, property, receiver) {
					if (typeof property === "string" && /^\d+$/.test(property)) reads++;
					return Reflect.get(target, property, receiver);
				},
			},
		);
		expect(hasVisibleReasoningClientRect(rects, { left: 0, top: 0, right: 800, bottom: 600 })).toBe(
			true,
		);
		expect(reads).toBeLessThan(100);
	});

	test("invalid and zero-area geometry cannot establish visibility", () => {
		expect(
			intersectReasoningVisibilityRects(
				{ left: 0, top: 0, right: 10, bottom: 10 },
				{ left: 10, top: 0, right: 20, bottom: 10 },
			),
		).toBeNull();
		expect(
			intersectReasoningVisibilityRects(
				{ left: 0, top: 0, right: 10, bottom: 10 },
				{ left: Number.NaN, top: 0, right: 20, bottom: 10 },
			),
		).toBeNull();
	});
});
