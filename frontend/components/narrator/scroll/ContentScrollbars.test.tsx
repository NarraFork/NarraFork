import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ContentViewportSnapshot } from "./AutoFollowScroll";
import {
	type ContentScrollbarAxis,
	ContentScrollbars,
	contentScrollbarGeometry,
} from "./ContentScrollbars";

const initial: ContentViewportSnapshot = {
	scrollTop: 100,
	scrollLeft: 20,
	viewportWidth: 300,
	viewportHeight: 200,
	contentWidth: 600,
	contentOrigin: 2,
	scrollWidth: 600,
	scrollHeight: 1_000,
	source: "layout",
};
let root: Root;
let host: HTMLDivElement;
let restore: () => void;
let captures: number[];
let releases: number[];
let reads: string[];

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	captures = [];
	releases = [];
	reads = [];
	const proto = window.HTMLElement.prototype;
	const keys = [
		"clientWidth",
		"clientHeight",
		"clientTop",
		"clientLeft",
		"offsetTop",
		"offsetLeft",
		"offsetWidth",
		"offsetHeight",
		"scrollWidth",
		"scrollHeight",
		"getBoundingClientRect",
		"setPointerCapture",
		"releasePointerCapture",
	];
	const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
	const forbidden = (name: string): never => {
		reads.push(name);
		throw new Error(`Forbidden geometry read: ${name}`);
	};
	for (const key of keys.slice(0, 10))
		Object.defineProperty(proto, key, { configurable: true, get: () => forbidden(key) });
	proto.getBoundingClientRect = () => forbidden("getBoundingClientRect");
	proto.setPointerCapture = (id) => {
		captures.push(id);
	};
	proto.releasePointerCapture = (id) => {
		releases.push(id);
	};
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		getComputedStyle: () => forbidden("getComputedStyle"),
		ResizeObserver: class {
			constructor() {
				forbidden("ResizeObserver");
			}
		},
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	const originalGlobals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	Object.assign(globalThis, globals);
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	restore = () => {
		for (const [key, descriptor] of old) {
			if (descriptor) Object.defineProperty(proto, key, descriptor);
			else Reflect.deleteProperty(proto, key);
		}
		for (const [key, descriptor] of originalGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
});

afterEach(async () => {
	root.unmount();
	// React may have queued a passive cleanup that still consults window.event.
	await new Promise((resolve) => setTimeout(resolve, 0));
	host.remove();
	restore();
});

function mount(snapshot = initial) {
	let value = { ...snapshot };
	const listeners = new Set<(snapshot: ContentViewportSnapshot) => void>();
	const commands: { axis: ContentScrollbarAxis; value: number }[] = [];
	const order: string[] = [];
	let parentRenders = 0;
	let parentPointers = 0;
	let parentKeys = 0;
	const publish = (patch: Partial<ContentViewportSnapshot>) => {
		value = { ...value, ...patch };
		flushSync(() => {
			for (const listener of listeners) listener(value);
		});
	};
	const props = {
		getSnapshot: () => value,
		subscribe: (listener: (snapshot: ContentViewportSnapshot) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		onStart: () => {
			order.push("start");
		},
		onScroll: (axis: ContentScrollbarAxis, next: number) => {
			order.push(axis);
			commands.push({ axis, value: next });
			publish(axis === "x" ? { scrollLeft: next } : { scrollTop: next });
		},
		controlsId: "controlled-content",
	};
	function Parent() {
		parentRenders++;
		// This container only observes propagation; it is not a scrolling/geometry stub.
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: the fixture observes bubbling, not a user-facing control
			<div
				onPointerDown={() => {
					parentPointers++;
				}}
				onPointerMove={() => {
					parentPointers++;
				}}
				onPointerUp={() => {
					parentPointers++;
				}}
				onKeyDown={() => {
					parentKeys++;
				}}
			>
				<div id="controlled-content" />
				<ContentScrollbars {...props} />
			</div>
		);
	}
	flushSync(() => root.render(<Parent />));
	return {
		listeners,
		commands,
		order,
		publish,
		snapshot: () => value,
		parentRenders: () => parentRenders,
		parentPointers: () => parentPointers,
		parentKeys: () => parentKeys,
	};
}

function bar(axis: ContentScrollbarAxis) {
	const element = host.querySelector<HTMLDivElement>(`[data-content-scrollbar="${axis}"]`);
	if (!element) throw new Error(`No ${axis} scrollbar`);
	return element;
}
function thumb(axis: ContentScrollbarAxis) {
	const element = host.querySelector<HTMLDivElement>(`[data-content-scrollbar-thumb="${axis}"]`);
	if (!element) throw new Error(`No ${axis} thumb`);
	return element;
}
function send(node: Element, type: string, fields: Record<string, unknown> = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	for (const [key, value] of Object.entries({
		button: 0,
		pointerId: 7,
		isPrimary: true,
		pageX: 100,
		pageY: 100,
		offsetX: 0,
		offsetY: 0,
		altKey: false,
		ctrlKey: false,
		shiftKey: false,
		metaKey: false,
		...fields,
	}))
		Object.defineProperty(event, key, { value, configurable: true });
	flushSync(() => node.dispatchEvent(event));
	return event;
}

describe("ContentScrollbars model geometry", () => {
	test("proportional thumbs share an 8px corner and use the supplied offsets", () => {
		const geometry = contentScrollbarGeometry(initial);
		expect(geometry.y?.trackLength).toBe(192);
		expect(geometry.y?.crossOffset).toBe(292);
		expect(geometry.x?.crossOffset).toBe(192);
		expect(geometry.y?.thumbLength).toBeCloseTo(38.4);
		expect(geometry.y?.thumbPosition).toBeCloseTo(19.2);
		expect(geometry.x?.trackLength).toBe(292);
		expect(geometry.x?.thumbLength).toBe(146);
		expect(geometry.x?.thumbPosition).toBeCloseTo((20 / 300) * 146);
	});

	test("only overflowing axes appear; zero and non-finite inputs stay bounded", () => {
		expect(contentScrollbarGeometry({ ...initial, scrollWidth: 300, scrollHeight: 200 })).toEqual({
			x: null,
			y: null,
		});
		expect(contentScrollbarGeometry({ ...initial, viewportWidth: 0 })).toEqual({
			x: null,
			y: null,
		});
		expect(contentScrollbarGeometry({ ...initial, viewportHeight: Number.NaN })).toEqual({
			x: null,
			y: null,
		});
		const vertical = contentScrollbarGeometry({
			...initial,
			scrollWidth: 300,
			scrollTop: Number.POSITIVE_INFINITY,
		});
		expect(vertical.x).toBeNull();
		expect(vertical.y?.trackLength).toBe(200);
		expect(vertical.y?.value).toBe(0);
		const tiny = contentScrollbarGeometry({
			...initial,
			viewportHeight: 10,
			scrollHeight: 100_000,
		});
		expect(tiny.y?.thumbTravel).toBeGreaterThan(0);
		expect(tiny.y?.thumbLength).toBeLessThanOrEqual(tiny.y?.trackLength ?? 0);
	});
});

describe("ContentScrollbars interactions without DOM measurement", () => {
	test("subscribes locally, exposes ARIA and renders narrow overlay thumbs", () => {
		const state = mount();
		expect(state.listeners.size).toBe(1);
		expect(bar("y").getAttribute("role")).toBe("scrollbar");
		expect(bar("y").getAttribute("aria-controls")).toBe("controlled-content");
		expect(bar("y").getAttribute("aria-valuemax")).toBe("800");
		expect(bar("y").getAttribute("aria-valuenow")).toBe("100");
		expect(bar("y").style.position).toBe("absolute");
		expect(bar("y").style.width).toBe("8px");
		// The containing sticky layer has zero height: never position the horizontal rail with bottom:0.
		expect(bar("x").style.top).toBe("192px");
		expect(bar("y").style.left).toBe("292px");
		expect(thumb("y").firstElementChild?.getAttribute("style")).toContain("width:3px");
		expect(thumb("x").firstElementChild?.getAttribute("style")).toContain("height:2px");
		expect(thumb("y").firstElementChild?.getAttribute("style")).toContain(
			"var(--mantine-color-dimmed)",
		);
		state.publish({ scrollTop: 400 });
		expect(bar("y").getAttribute("aria-valuenow")).toBe("400");
		expect(Number.parseFloat(thumb("y").style.top)).toBeCloseTo(76.8);
		expect(state.parentRenders()).toBe(1);
		expect(reads).toEqual([]);
	});

	test("vertical pointer capture drag pauses first and clamps to the latest range", () => {
		const state = mount();
		const down = send(thumb("y"), "pointerdown", { pageY: 1_000 });
		expect(down.defaultPrevented).toBe(true);
		expect(captures).toEqual([7]);
		expect(state.order).toEqual(["start"]);
		send(thumb("y"), "pointermove", { pageY: 1_076.8 });
		expect(state.commands.at(-1)?.value).toBeCloseTo(500);
		expect(state.commands.at(-1)?.axis).toBe("y");
		state.publish({ scrollHeight: 500 });
		send(thumb("y"), "pointermove", { pageY: 2_000 });
		expect(state.commands.at(-1)?.value).toBe(300);
		send(thumb("y"), "pointerup", { pageY: 2_000 });
		const count = state.commands.length;
		send(thumb("y"), "pointermove", { pageY: 3_000 });
		expect(state.commands).toHaveLength(count);
		expect(releases).toEqual([7]);
		expect(state.parentPointers()).toBe(0);
		expect(reads).toEqual([]);
	});

	test("horizontal dragging uses pointer coordinates rather than element geometry", () => {
		const state = mount();
		send(thumb("x"), "pointerdown", { pageX: 200 });
		send(thumb("x"), "pointermove", { pageX: 273 });
		expect(state.commands.at(-1)?.axis).toBe("x");
		expect(state.commands.at(-1)?.value).toBeCloseTo(170);
		send(thumb("x"), "pointermove", { pageX: -1_000 });
		expect(state.commands.at(-1)?.value).toBe(0);
		send(thumb("x"), "pointercancel");
		expect(releases).toEqual([7]);
		expect(reads).toEqual([]);
	});

	test("track clicks use event-local offsets and permit continued capture dragging", () => {
		const state = mount();
		send(bar("x"), "pointerdown", { offsetX: 219 });
		expect(state.order.slice(0, 2)).toEqual(["start", "x"]);
		expect(state.commands.at(-1)).toEqual({ axis: "x", value: 300 });
		send(bar("x"), "pointerup");
		send(bar("y"), "pointerdown", { offsetY: 100 });
		expect(state.commands.at(-1)?.value).toBeCloseTo(((100 - 19.2) / 153.6) * 800);
		send(bar("y"), "pointermove", { pageY: -2_000 });
		expect(state.commands.at(-1)?.value).toBe(0);
		send(bar("y"), "pointerup");
		expect(state.parentPointers()).toBe(0);
		expect(reads).toEqual([]);
	});

	test("keyboard arrow/page/home/end scroll both axes and stop outer navigation", () => {
		const state = mount();
		for (const [key, value] of [
			["ArrowDown", 140],
			["PageDown", 340],
			["PageUp", 140],
			["ArrowUp", 100],
			["End", 800],
			["Home", 0],
		] as const) {
			const event = send(bar("y"), "keydown", { key });
			expect(state.commands.at(-1)).toEqual({ axis: "y", value });
			expect(event.defaultPrevented).toBe(true);
		}
		for (const [key, value] of [
			["ArrowRight", 60],
			["ArrowLeft", 20],
			["PageDown", 300],
			["PageUp", 0],
			["End", 300],
			["Home", 0],
		] as const) {
			send(bar("x"), "keydown", { key });
			expect(state.commands.at(-1)).toEqual({ axis: "x", value });
		}
		expect(state.parentKeys()).toBe(0);
		expect(reads).toEqual([]);
	});

	test("modifier gestures and secondary pointers are never hijacked", () => {
		const state = mount();
		for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
			const pointer = send(thumb("y"), "pointerdown", { [modifier]: true });
			const key = send(bar("y"), "keydown", { key: "End", [modifier]: true });
			expect(pointer.defaultPrevented).toBe(false);
			expect(key.defaultPrevented).toBe(false);
		}
		send(thumb("y"), "pointerdown", { isPrimary: false, pointerId: 8 });
		expect(state.parentPointers()).toBe(5);
		expect(state.parentKeys()).toBe(4);
		expect(state.commands).toEqual([]);
		expect(state.order).toEqual([]);
		expect(captures).toEqual([]);
		expect(bar("y").style.touchAction).toBe("pinch-zoom");
	});

	test("a modifier introduced during drag releases capture without swallowing it", () => {
		const state = mount();
		send(thumb("y"), "pointerdown");
		const move = send(thumb("y"), "pointermove", { ctrlKey: true, pageY: 500 });
		expect(move.defaultPrevented).toBe(false);
		expect(state.parentPointers()).toBe(1);
		expect(releases).toEqual([7]);
		expect(state.commands).toEqual([]);
	});

	test("lost capture and disappearing axes stop dragging; unmount unsubscribes", () => {
		const state = mount();
		send(thumb("y"), "pointerdown");
		send(thumb("y"), "lostpointercapture");
		send(thumb("y"), "pointermove", { pageY: 500 });
		expect(state.commands).toEqual([]);
		send(thumb("x"), "pointerdown", { pointerId: 9 });
		state.publish({ scrollWidth: 300 });
		expect(host.querySelector('[data-content-scrollbar="x"]')).toBeNull();
		expect(releases).toContain(9);
		flushSync(() => root.render(null));
		expect(state.listeners.size).toBe(0);
		expect(reads).toEqual([]);
	});

	test("source imports the viewport only as a type and never masks native scrollbars", () => {
		const source = readFileSync(new URL("./ContentScrollbars.tsx", import.meta.url), "utf8");
		expect(source).toContain('import type { ContentViewportSnapshot } from "./AutoFollowScroll"');
		expect(source).not.toMatch(
			/getBoundingClientRect|getComputedStyle|ResizeObserver|\.client(?:Width|Height|Top|Left)|\.offset(?:Width|Height|Top|Left)/,
		);
		expect(source).not.toContain("scrollbarWidth");
		expect(source).not.toContain("::-webkit-scrollbar");
	});
});
