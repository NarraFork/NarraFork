/** Real React lifecycles with queued frames; geometry alone is stubbed (linkedom has no layout). */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import narratorLocale from "../../../locales/en/narrator.json";
import {
	AutoFollowScroll,
	type ContentRowTarget,
	type ContentViewport,
	type ContentViewportLayout,
	useContentViewport,
} from "./AutoFollowScroll";

let root: Root;
let container: HTMLDivElement;
let testI18n: i18n;
let clock = 0;
let reduced = false;
let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;
let positions: WeakMap<object, number>;
let writes: number[];
const geometryKeys = [
	"clientHeight",
	"clientWidth",
	"offsetWidth",
	"scrollHeight",
	"scrollWidth",
	"scrollTop",
	"scrollLeft",
] as const;
type GeometryReads = Record<(typeof geometryKeys)[number], number>;
let geometryReads: GeometryReads;
let leftPositions: WeakMap<object, number>;
function resetGeometryReads() {
	geometryReads = Object.fromEntries(geometryKeys.map((key) => [key, 0])) as GeometryReads;
}
function countGeometryRead(node: HTMLElement, key: (typeof geometryKeys)[number]) {
	if (node.hasAttribute("data-content-scrollport")) geometryReads[key]++;
}
/** Setter clamping uses fixture data directly, never its own instrumented getters. */
function fixtureScrollHeight(node: HTMLElement) {
	return Number(node.querySelector("[data-lines]")?.getAttribute("data-lines") ?? 0) * 20;
}
let restore: Map<string, PropertyDescriptor | undefined>;
/**
 * linkedom shares ONE `HTMLElement.prototype` across every `parseHTML` window, so
 * the geometry stubs below are process-global. Without restoring them, later test
 * FILES inherit this file's fake layout — and the ones that assert "no geometry is
 * read" then fail on a stub they never installed. Which files break depends purely
 * on enumeration order, so the damage is invisible until a rename shuffles it.
 */
let protoRestore: Map<string, PropertyDescriptor | undefined>;
/** The exact prototype the stubs were installed on (globals are restored first). */
let stubbedProto: object;
let nowSpy: ReturnType<typeof spyOn>;
let observers: Observer[];
class Observer {
	active = true;
	constructor(readonly callback: ResizeObserverCallback) {
		observers.push(this);
	}
	observe() {}
	unobserve() {}
	disconnect() {
		this.active = false;
	}
}

beforeEach(async () => {
	clock = 1000;
	reduced = false;
	nextFrame = 0;
	frames = new Map();
	positions = new WeakMap();
	leftPositions = new WeakMap();
	resetGeometryReads();
	writes = [];
	observers = [];
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: query.includes("prefers-reduced-motion") && reduced,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		MouseEvent: window.Event,
		matchMedia,
		ResizeObserver: Observer,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			const id = ++nextFrame;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
		getComputedStyle: () => ({}),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	restore = new Map();
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor && !descriptor.configurable) continue;
		restore.set(key, descriptor);
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const geometryProto = window.HTMLElement.prototype;
	stubbedProto = geometryProto;
	protoRestore = new Map(
		geometryKeys.map((key) => [key, Object.getOwnPropertyDescriptor(geometryProto, key)]),
	);
	Object.defineProperties(geometryProto, {
		clientHeight: {
			configurable: true,
			get() {
				countGeometryRead(this, "clientHeight");
				return 200;
			},
		},
		clientWidth: {
			configurable: true,
			get() {
				countGeometryRead(this, "clientWidth");
				return 400;
			},
		},
		offsetWidth: {
			configurable: true,
			get() {
				countGeometryRead(this, "offsetWidth");
				return 400;
			},
		},
		scrollHeight: {
			configurable: true,
			get() {
				countGeometryRead(this, "scrollHeight");
				return fixtureScrollHeight(this);
			},
		},
		scrollWidth: {
			configurable: true,
			get() {
				countGeometryRead(this, "scrollWidth");
				return 0;
			},
		},
		scrollLeft: {
			configurable: true,
			get() {
				countGeometryRead(this, "scrollLeft");
				return leftPositions.get(this) ?? 0;
			},
			set(value: number) {
				leftPositions.set(this, value);
			},
		},
		scrollTop: {
			configurable: true,
			get() {
				countGeometryRead(this, "scrollTop");
				return positions.get(this) ?? 0;
			},
			set(value: number) {
				const el = this as HTMLElement;
				const height = Object.getOwnPropertyDescriptor(el, "clientHeight")?.value ?? 200;
				const next = Math.max(0, Math.min(value, fixtureScrollHeight(el) - height));
				positions.set(this, next);
				writes.push(next);
			},
		},
	});
	nowSpy = spyOn(performance, "now").mockImplementation(() => clock);
	testI18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "narrator",
		resources: { en: { narrator: narratorLocale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	nowSpy.mockRestore();
	for (const [key, descriptor] of restore) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	// The prototype is shared process-wide (see protoRestore): hand it back exactly
	// as found so the next test file measures its own DOM, not this file's stubs.
	for (const [key, descriptor] of protoRestore) {
		if (descriptor) Object.defineProperty(stubbedProto, key, descriptor);
		else Reflect.deleteProperty(stubbedProto, key);
	}
});

function Target({ value }: { value: ContentRowTarget | null }) {
	const ctx = useContentViewport();
	useLayoutEffect(() => {
		ctx?.setRowTarget(value);
		ctx?.notifyLayout();
	}, [ctx, value]);
	return null;
}
function ReaderProbe({ onViewport }: { onViewport: (value: ContentViewport) => void }) {
	const value = useContentViewport();
	useLayoutEffect(() => {
		if (value) onViewport(value);
	}, [value, onViewport]);
	return null;
}
function Extent({ size }: { size: ContentViewportLayout }) {
	const ctx = useContentViewport();
	const publish = ctx?.setContentSize;
	useLayoutEffect(() => {
		publish?.(size);
	}, [publish, size]);
	return null;
}
async function render(opts: {
	lines?: number;
	live?: boolean;
	bodyId?: string;
	strict?: boolean;
	target?: ContentRowTarget | null;
	revision?: string;
	content?: string;
	layout?: ContentViewportLayout;
	onReaderProgress?: (node: HTMLElement) => void;
	onViewport?: (value: ContentViewport) => void;
}) {
	const content = (
		<MantineProvider>
			<I18nextProvider i18n={testI18n}>
				<AutoFollowScroll
					bodyId={opts.bodyId ?? "body"}
					live={opts.live ?? true}
					revision={opts.revision ?? String(opts.lines ?? 30)}
					followTarget={"target" in opts ? "row" : "end"}
					layout={opts.layout}
					viewportStyle={{ height: 200 }}
					onReaderProgress={opts.onReaderProgress}
				>
					<div data-lines={opts.lines ?? 30}>
						{opts.content ?? "Output"}
						<input data-input="true" />
					</div>
					{opts.layout && <Extent size={{ width: 400, height: (opts.lines ?? 30) * 20 }} />}
					{"target" in opts && <Target value={opts.target ?? null} />}
					{opts.onViewport && <ReaderProbe onViewport={opts.onViewport} />}
				</AutoFollowScroll>
			</I18nextProvider>
		</MantineProvider>
	);
	await act(async () => root.render(opts.strict ? <StrictMode>{content}</StrictMode> : content));
}
function viewport() {
	const node = container.querySelector<HTMLElement>("[data-content-scrollport]");
	if (!node) throw new Error("Content scrollport is missing");
	return node;
}
async function event(
	type: string,
	fields: Record<string, unknown> = {},
	node: HTMLElement = viewport(),
) {
	await act(async () => {
		const value = new Event(type, { bubbles: true });
		for (const [key, entry] of Object.entries(fields))
			Object.defineProperty(value, key, { value: entry });
		node.dispatchEvent(value);
	});
}
async function userScroll(top: number) {
	positions.set(viewport(), top);
	await event("scroll");
}
async function frame() {
	await act(async () => {
		clock += 16.7;
		const node = viewport();
		const before = node?.scrollTop;
		const pending = [...frames.values()];
		frames.clear();
		for (const callback of pending) callback(clock);
		if (node && node.scrollTop !== before) node.dispatchEvent(new Event("scroll"));
	});
}
async function settle() {
	for (let i = 0; frames.size && i < 90; i++) await frame();
}
function resumeButton() {
	return container.querySelector<HTMLButtonElement>("button[aria-label]");
}

describe("unique cold first mounts", () => {
	// Recorded against the unmodified cold-mount-baseline/AutoFollowScroll.tsx before optimizing.
	// Budgets cap snapshots, not required reads: fewer reads are an improvement.
	// Each snapshot reads six getters in DOM mode, two in modeled mode; writes read actualTop.
	const scenarios: {
		name: string;
		live: boolean;
		target?: ContentRowTarget | null;
		layout?: ContentViewportLayout;
		strict?: boolean;
		baselineSnapshots: number;
		maxSnapshots: number;
	}[] = [
		{ name: "historical end", live: false, baselineSnapshots: 12, maxSnapshots: 3 },
		{
			name: "historical row",
			live: false,
			target: { top: 240, bottom: 260 },
			baselineSnapshots: 12,
			maxSnapshots: 3,
		},
		{
			name: "historical missing row",
			live: false,
			target: null,
			baselineSnapshots: 12,
			maxSnapshots: 3,
		},
		{ name: "live end", live: true, baselineSnapshots: 15, maxSnapshots: 8 },
		{
			name: "live row",
			live: true,
			target: { top: 240, bottom: 260 },
			baselineSnapshots: 15,
			maxSnapshots: 8,
		},
		{
			name: "historical modeled",
			live: false,
			layout: { width: 400, height: 200 },
			baselineSnapshots: 12,
			maxSnapshots: 3,
		},
		{
			name: "live modeled",
			live: true,
			layout: { width: 400, height: 200 },
			baselineSnapshots: 15,
			maxSnapshots: 8,
		},
		{
			name: "historical StrictMode",
			live: false,
			strict: true,
			baselineSnapshots: 21,
			maxSnapshots: 6,
		},
	];
	for (const scenario of scenarios) {
		test(scenario.name, async () => {
			for (let sample = 0; sample < 3; sample++) {
				await act(async () => root.render(null));
				resetGeometryReads();
				writes = [];
				await render({
					...scenario,
					lines: 50 + sample,
					bodyId: `cold-${scenario.name}-${sample}`,
					revision: `revision-${scenario.name}-${sample}`,
					content: `Unique content for ${scenario.name}, instance ${sample}`,
				});
				const reads = { ...geometryReads };
				const modeled = !!scenario.layout;
				const readBudgets: GeometryReads = {
					clientHeight: modeled ? 0 : scenario.maxSnapshots,
					clientWidth: modeled ? 0 : scenario.maxSnapshots,
					offsetWidth: 0,
					scrollHeight: modeled ? 0 : scenario.maxSnapshots,
					scrollWidth: modeled ? 0 : scenario.maxSnapshots,
					scrollTop: scenario.maxSnapshots + (scenario.live ? 2 : 0),
					scrollLeft: scenario.maxSnapshots,
				};
				const baselineTotal =
					scenario.baselineSnapshots * (modeled ? 2 : 6) + (scenario.live ? 4 : 0);
				for (const key of geometryKeys) {
					const budget = readBudgets[key];
					if (budget === 0) {
						expect(reads[key]).toBe(0);
					} else {
						expect(reads[key]).toBeGreaterThanOrEqual(0);
						expect(reads[key]).toBeLessThanOrEqual(budget);
					}
				}
				expect(Object.values(reads).reduce((sum, count) => sum + count, 0)).toBeLessThan(
					baselineTotal,
				);
				expect(viewport().dataset.following).toBe(String(scenario.live));
				expect(writes.length).toBe(scenario.live ? 1 : 0);
			}
		});
	}
});

describe("content lifecycle", () => {
	test("a live body starts at its tail; a historical body stays at its head", async () => {
		await render({ lines: 50 });
		expect(viewport().scrollTop).toBe(800);
		await render({ lines: 50, live: false, bodyId: "history" });
		await settle();
		expect(viewport().scrollTop).toBe(0);
	});
	test("StrictMode replay cannot pin a historical body", async () => {
		await render({ lines: 50, live: false, strict: true });
		await settle();
		expect(viewport().scrollTop).toBe(0);
		expect(writes).toHaveLength(0);
	});
	test("historical notifications skip geometry but an explicit snapshot stays fresh", async () => {
		let reader: ContentViewport | undefined;
		await render({
			live: false,
			onViewport: (value) => {
				reader = value;
			},
		});
		resetGeometryReads();
		await act(async () => reader?.notifyLayout());
		expect(Object.values(geometryReads).every((count) => count === 0)).toBe(true);
		viewport().querySelector("[data-lines]")?.setAttribute("data-lines", "80");
		expect(reader?.getSnapshot().scrollHeight).toBe(1600);
		expect(geometryReads.scrollHeight).toBe(1);
		expect(writes).toHaveLength(0);
	});
	test("a historical body upgrades to live without replacing callbacks or native listeners", async () => {
		let reader: ContentViewport | undefined;
		const onViewport = (value: ContentViewport) => {
			reader = value;
		};
		await render({ live: false, lines: 50, onViewport });
		const node = viewport();
		const initial = reader;
		const nativeObserver = observers[0];
		await render({ live: true, lines: 60, onViewport });
		expect(viewport()).toBe(node);
		expect(node.scrollTop).toBe(1000);
		expect(reader?.isFollowing()).toBe(true);
		await render({ live: false, lines: 70, onViewport });
		await settle();
		expect(node.scrollTop).toBe(1200);
		expect(reader?.getSnapshot).toBe(initial?.getSnapshot);
		expect(reader?.notifyLayout).toBe(initial?.notifyLayout);
		expect(reader?.scrollTo).toBe(initial?.scrollTo);
		expect(reader?.subscribeViewport).toBe(initial?.subscribeViewport);
		expect(observers).toHaveLength(1);
		expect(nativeObserver?.active).toBe(true);
		resetGeometryReads();
		await act(async () => reader?.notifyLayout());
		expect(Object.values(geometryReads).every((count) => count === 0)).toBe(true);
	});
	test("final follow survives an unknown viewport height and reads the later commit", async () => {
		await render({ lines: 50, layout: { width: 400, height: 0 } });
		const node = viewport();
		expect(node.scrollTop).toBe(0);
		expect(writes).toHaveLength(0);
		await render({ lines: 60, live: false, layout: { width: 400, height: 0 } });
		expect(writes).toHaveLength(0);
		await render({ lines: 70, live: false, layout: { width: 400, height: 200 } });
		await settle();
		expect(viewport()).toBe(node);
		expect(node.scrollTop).toBe(1200);
		await render({ lines: 80, live: false, layout: { width: 400, height: 200 } });
		expect(node.scrollTop).toBe(1200);
	});
	test("StrictMode live replay releases listeners, observers, subscriptions and frames", async () => {
		let reader: ContentViewport | undefined;
		await render({
			strict: true,
			lines: 50,
			onViewport: (value) => {
				reader = value;
			},
		});
		expect(viewport().scrollTop).toBe(800);
		expect(observers.filter((observer) => observer.active)).toHaveLength(1);
		const node = viewport();
		const snapshots: number[] = [];
		const unsubscribe = reader?.subscribeViewport((snapshot) => snapshots.push(snapshot.scrollTop));
		await render({ strict: true, lines: 60 });
		expect(frames.size).toBeGreaterThan(0);
		await act(async () => root.render(null));
		const count = snapshots.length;
		expect(frames.size).toBe(0);
		expect(observers.every((observer) => !observer.active)).toBe(true);
		await event("scroll", {}, node);
		await event("wheel", { deltaY: -100 }, node);
		await act(async () => reader?.notifyLayout());
		expect(frames.size).toBe(0);
		expect(snapshots).toHaveLength(count);
		unsubscribe?.();
	});
	test("growth has intermediate frames and lands exactly", async () => {
		await render({ lines: 30 });
		await settle();
		await render({ lines: 40 });
		expect(viewport().scrollTop).toBe(400);
		await frame();
		expect(viewport().scrollTop).toBeGreaterThan(400);
		expect(viewport().scrollTop).toBeLessThan(600);
		await settle();
		expect(viewport().scrollTop).toBe(600);
		expect(frames.size).toBe(0);
	});
	test("final content lands without replacing the viewport; later historical hydration does not follow", async () => {
		await render({ lines: 30 });
		const node = viewport();
		await render({ lines: 40, live: false });
		await settle();
		expect(viewport()).toBe(node);
		expect(node.scrollTop).toBe(600);
		await render({ lines: 60, live: false });
		await settle();
		expect(node.scrollTop).toBe(600);
	});
	test("reduced motion snaps instead of scheduling a chase", async () => {
		reduced = true;
		await render({ lines: 30 });
		await settle();
		await render({ lines: 40 });
		expect(viewport().scrollTop).toBe(600);
	});
	test("an async body resize follows only while live", async () => {
		await render({ lines: 30 });
		await settle();
		await act(async () => {
			viewport().querySelector("[data-lines]")?.setAttribute("data-lines", "40");
			for (const observer of observers)
				if (observer.active) observer.callback([], observer as unknown as ResizeObserver);
		});
		await settle();
		expect(viewport().scrollTop).toBe(600);
	});
	test("native cap clamping is not an upward reader gesture", async () => {
		await render({ lines: 50 });
		await render({ lines: 50, live: false });
		await settle();
		Object.defineProperty(viewport(), "clientHeight", { configurable: true, value: 300 });
		positions.set(viewport(), 700);
		await event("scroll"); // Browser may emit this before the resize observer.
		expect(viewport().dataset.following).toBe("true");
		expect(viewport().scrollTop).toBe(700);
	});
	test("an async highlight reflow observed before its scroll echo cannot pause following", async () => {
		let reads = 0;
		await render({
			lines: 50,
			onReaderProgress: () => {
				reads++;
			},
		});
		await settle();
		await act(async () => {
			viewport().querySelector("[data-lines]")?.setAttribute("data-lines", "45");
			positions.set(viewport(), 700);
			for (const observer of observers)
				if (observer.active) observer.callback([], observer as unknown as ResizeObserver);
		});
		await event("scroll");
		expect(viewport().dataset.following).toBe("true");
		expect(reads).toBe(0);
	});
	test("late settled viewport resize preserves its goal, but static source hydration does not follow", async () => {
		await render({ lines: 50 });
		await render({ lines: 50, live: false });
		await settle();
		Object.defineProperty(viewport(), "clientHeight", { configurable: true, value: 100 });
		await act(async () => {
			for (const observer of observers)
				if (observer.active) observer.callback([], observer as unknown as ResizeObserver);
		});
		await settle();
		expect(viewport().scrollTop).toBe(900);
		await render({ lines: 80, live: false });
		await act(async () => {
			for (const observer of observers)
				if (observer.active) observer.callback([], observer as unknown as ResizeObserver);
		});
		await settle();
		expect(viewport().scrollTop).toBe(900);
	});
	test("unmount cancels queued work and releases observers", async () => {
		await render({ lines: 30 });
		await render({ lines: 40 });
		await act(async () => root.render(null));
		expect(frames.size).toBe(0);
		expect(observers.every((observer) => !observer.active)).toBe(true);
	});
});

describe("reader intent wins over programmatic scrolling", () => {
	test("upward wheel cancels a chase inside its first 100ms", async () => {
		await render({ lines: 30 });
		await render({ lines: 40 });
		await event("wheel", { deltaY: -100 });
		await userScroll(300);
		await render({ lines: 50 });
		await settle();
		expect(viewport().scrollTop).toBe(300);
		expect(viewport().dataset.following).toBe("false");
		expect(resumeButton()).not.toBeNull();
	});
	test("keyboard PageUp pauses, editable inputs do not", async () => {
		await render({ lines: 30 });
		const input = viewport().querySelector("input");
		if (!input) throw new Error("Editable fixture input is missing");
		await event("keydown", { key: "PageUp" }, input);
		expect(viewport().dataset.following).toBe("true");
		await event("keydown", { key: "PageUp" });
		await userScroll(200);
		await render({ lines: 40 });
		await settle();
		expect(viewport().scrollTop).toBe(200);
	});
	test("touch move towards earlier content pauses immediately", async () => {
		await render({ lines: 30 });
		await event("touchstart", { touches: [{ clientY: 100 }] });
		await event("touchmove", { touches: [{ clientY: 180 }] });
		await userScroll(200);
		await render({ lines: 40 });
		await settle();
		expect(viewport().scrollTop).toBe(200);
	});
	test("resume follows the latest target and completion preserves a paused reader", async () => {
		await render({ lines: 30 });
		await event("wheel", { deltaY: -100 });
		await userScroll(200);
		await render({ lines: 40, live: false });
		await settle();
		expect(viewport().scrollTop).toBe(200);
		const button = resumeButton();
		if (!button) throw new Error("Resume control is missing");
		await event("click", {}, button);
		await settle();
		expect(viewport().scrollTop).toBe(600);
	});
	test("downward user reading can fetch history, but growth of that history does not seize the viewport", async () => {
		let reads = 0;
		const onReaderProgress = () => {
			reads++;
		};
		await render({ lines: 30, live: false, onReaderProgress });
		await event("wheel", { deltaY: 150 });
		await userScroll(150);
		expect(reads).toBe(1);
		await render({ lines: 60, live: false, onReaderProgress });
		await settle();
		expect(viewport().scrollTop).toBe(150);
	});
	test("a clamped programmatic write records its actual top before an upward echo", async () => {
		let reader: ContentViewport | undefined;
		let progress = 0;
		await render({
			lines: 50,
			onViewport: (value) => {
				reader = value;
			},
			onReaderProgress: () => {
				progress++;
			},
		});
		await event("scroll"); // Consume the initial follow echo.
		const node = viewport();
		Object.defineProperty(node, "scrollTop", {
			configurable: true,
			get: () => positions.get(node) ?? 0,
			set: (value: number) => {
				positions.set(node, Math.min(value, 120));
			},
		});
		await act(async () => reader?.scrollTo(500));
		expect(node.scrollTop).toBe(120);
		await event("scroll"); // Layout is unchanged and the actual top moved upwards.
		expect(reader?.isFollowing()).toBe(true);
		expect(progress).toBe(0);
	});
	test("programmatic scroll echoes never request historical content", async () => {
		let reads = 0;
		const onReaderProgress = () => {
			reads++;
		};
		await render({ lines: 30, onReaderProgress });
		await event("scroll");
		await render({ lines: 40, onReaderProgress });
		await settle();
		expect(reads).toBe(0);
	});
	test("consumed inner wheels do not detach the outer list; modifier gestures still bubble", async () => {
		await render({ lines: 30 });
		let bubbled = 0;
		container.addEventListener("wheel", () => {
			bubbled++;
		});
		await event("wheel", { deltaY: -100, altKey: true });
		expect(bubbled).toBe(1);
		expect(viewport().dataset.following).toBe("true");
		await event("wheel", { deltaY: -100 });
		expect(bubbled).toBe(1);
	});
});

describe("changed-row targets are not the whole diff bottom", () => {
	test("follows a row preceding a long old-side suffix", async () => {
		await render({ lines: 100, target: { top: 240, bottom: 260 } });
		await settle();
		expect(viewport().scrollTop).toBe(76);
		expect(viewport().scrollTop).toBeLessThan(1800);
	});
	test("a target already visible does not disturb the reader", async () => {
		await render({ lines: 100, target: { top: 30, bottom: 50 } });
		await settle();
		await render({ lines: 100, target: { top: 35, bottom: 55 } });
		await settle();
		expect(viewport().scrollTop).toBe(0);
		expect(writes).toHaveLength(0);
	});
	test("a missing row never falls back to the document tail", async () => {
		await render({ lines: 100, target: null });
		await settle();
		expect(viewport().scrollTop).toBe(0);
		expect(writes).toHaveLength(0);
	});
	test("a settled pending resume waits for its own row instead of following the tail", async () => {
		reduced = true;
		let reader: ContentViewport | undefined;
		const onViewport = (value: ContentViewport) => {
			reader = value;
		};
		await render({ lines: 100, target: { top: 240, bottom: 260 }, onViewport });
		await act(async () => {
			reader?.pauseFollowing();
			reader?.scrollTo(0);
		});
		await render({ lines: 100, live: false, target: null, onViewport });
		const button = resumeButton();
		if (!button) throw new Error("Resume control is missing");
		const before = writes.length;
		await event("click", {}, button);
		expect(writes).toHaveLength(before);
		expect(viewport().scrollTop).toBe(0);
		await render({ lines: 100, live: false, target: { top: 900, bottom: 920 }, onViewport });
		await settle();
		expect(viewport().scrollTop).toBe(736);
		expect(reader?.isFollowing()).toBe(true);
	});
	test("the final follow waits for a missing row, then ignores later settled targets", async () => {
		reduced = true;
		await render({ lines: 100, target: { top: 240, bottom: 260 } });
		await render({ lines: 100, live: false, target: null });
		expect(viewport().scrollTop).toBe(76);
		await render({ lines: 100, live: false, target: { top: 900, bottom: 920 } });
		await settle();
		expect(viewport().scrollTop).toBe(736);
		await render({ lines: 120, live: false, target: { top: 1700, bottom: 1720 } });
		await settle();
		expect(viewport().scrollTop).toBe(736);
	});
	test("a changed row above the viewport approaches upwards smoothly", async () => {
		await render({ lines: 100, target: { top: 700, bottom: 720 } });
		await settle();
		const before = viewport().scrollTop;
		await render({ lines: 100, target: { top: 400, bottom: 420 } });
		expect(viewport().scrollTop).toBe(before);
		await frame();
		expect(viewport().scrollTop).toBeLessThan(before);
		expect(viewport().scrollTop).toBeGreaterThan(384);
		await settle();
		expect(viewport().scrollTop).toBeLessThanOrEqual(400);
		expect(viewport().dataset.following).toBe("true");
	});
});

describe("document selection and source navigation", () => {
	test("explicit reader pause survives new text and final settlement", async () => {
		let reader: ContentViewport | undefined;
		const onViewport = (value: ContentViewport) => {
			reader = value;
		};
		await render({ lines: 100, onViewport });
		await settle();
		expect(reader?.isFollowing()).toBe(true);
		await act(async () => {
			reader?.pauseFollowing();
			reader?.scrollTo(60);
		});
		await render({ lines: 200, onViewport });
		await settle();
		expect(reader?.isFollowing()).toBe(false);
		expect(viewport().scrollTop).toBe(60);
		await render({ lines: 200, live: false, revision: "sealed", onViewport });
		await settle();
		expect(viewport().scrollTop).toBe(60);
		expect(reader?.isFollowing()).toBe(false);
	});
});
