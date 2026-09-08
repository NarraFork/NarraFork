/** Real React lifecycles with queued frames; geometry alone is stubbed (linkedom has no layout). */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import narratorLocale from "../../locales/en/narrator.json";
import { AutoFollowScroll, type ContentRowTarget, useContentViewport } from "./AutoFollowScroll";

let root: Root;
let container: HTMLDivElement;
let testI18n: i18n;
let clock = 0;
let reduced = false;
let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;
let positions: WeakMap<object, number>;
let writes: number[];
let restore: Map<string, PropertyDescriptor | undefined>;
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
	Object.defineProperties(window.HTMLElement.prototype, {
		clientHeight: { configurable: true, get: () => 200 },
		clientWidth: { configurable: true, get: () => 400 },
		offsetWidth: { configurable: true, get: () => 400 },
		scrollHeight: {
			configurable: true,
			get() {
				return (
					Number(
						(this as HTMLElement).querySelector("[data-lines]")?.getAttribute("data-lines") ?? 0,
					) * 20
				);
			},
		},
		scrollTop: {
			configurable: true,
			get() {
				return positions.get(this) ?? 0;
			},
			set(value: number) {
				const el = this as HTMLElement;
				const next = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight));
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
});

function Target({ value }: { value: ContentRowTarget | null }) {
	const ctx = useContentViewport();
	useLayoutEffect(() => {
		ctx?.setRowTarget(value);
		ctx?.notifyLayout();
	}, [ctx, value]);
	return null;
}
async function render(opts: {
	lines?: number;
	live?: boolean;
	bodyId?: string;
	strict?: boolean;
	target?: ContentRowTarget | null;
	revision?: string;
	onReaderProgress?: (node: HTMLElement) => void;
}) {
	const content = (
		<MantineProvider>
			<I18nextProvider i18n={testI18n}>
				<AutoFollowScroll
					bodyId={opts.bodyId ?? "body"}
					live={opts.live ?? true}
					revision={opts.revision ?? String(opts.lines ?? 30)}
					followTarget={"target" in opts ? "row" : "end"}
					viewportStyle={{ height: 200 }}
					onReaderProgress={opts.onReaderProgress}
				>
					<div data-lines={opts.lines ?? 30}>
						Output
						<input data-input="true" />
					</div>
					{"target" in opts && <Target value={opts.target ?? null} />}
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
