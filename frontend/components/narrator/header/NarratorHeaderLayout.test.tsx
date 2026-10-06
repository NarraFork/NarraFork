import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Root } from "react-dom/client";
import type { PanelHeaderControls } from "../panels/panel-header-controls";
import type { HeaderAfterTitleInput } from "./header-title-width";
import { resolveHeaderLayoutAfterTitle } from "./header-title-width";
import type { NarratorHeaderLayoutSnapshot } from "./NarratorHeaderLayout";

type Input = Omit<HeaderAfterTitleInput, "rowWidth">;
const DEFAULT_INPUT: Input = {
	titleFullWidth: 120,
	surfacedToolCount: 12,
	showBack: true,
	showTitleActions: true,
	showClose: true,
};
const DOM_KEYS = [
	"window",
	"document",
	"navigator",
	"ResizeObserver",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

class TestResizeObserver {
	static instances: TestResizeObserver[] = [];
	active = true;
	target: Element | null = null;
	constructor(private callback: ResizeObserverCallback) {
		TestResizeObserver.instances.push(this);
	}
	observe(target: Element) {
		this.target = target;
	}
	disconnect() {
		this.active = false;
	}
	fire() {
		// Intentionally allow stale deliveries: the component must ignore callbacks
		// already queued before disconnect, not rely on our mock to suppress them.
		this.callback([], this as unknown as ResizeObserver);
	}
}

const roots: Root[] = [];
let restore: () => void;
let flush: (run: () => void) => void;

beforeEach(async () => {
	const { parseHTML } = await import("linkedom");
	const previous = DOM_KEYS.map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	const { window } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		ResizeObserver: TestResizeObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	for (const key of DOM_KEYS) {
		Object.defineProperty(globalThis, key, {
			value: values[key],
			configurable: true,
			writable: true,
		});
	}
	TestResizeObserver.instances = [];
	flush = (await import("react-dom")).flushSync;
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
});

afterEach(async () => {
	for (const root of roots.splice(0)) flush(() => root.unmount());
	await new Promise((resolve) => setTimeout(resolve, 0));
	restore();
});

async function mount(
	initial: Input = DEFAULT_INPUT,
	strict = false,
	initialControls: PanelHeaderControls | null = null,
) {
	const { createElement, StrictMode } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { NarratorHeaderLayout } = await import("./NarratorHeaderLayout");
	const { PanelHeaderControlsProvider } = await import("../panels/panel-header-controls");
	let controls = initialControls;
	const counts = { panel: 0, body: 0, header: 0 };
	let input = initial;
	let last: NarratorHeaderLayoutSnapshot | null = null;
	function Body() {
		counts.body++;
		return createElement("div", null, "message body / composer / closed overlays");
	}
	function Panel() {
		counts.panel++;
		return createElement(
			"section",
			null,
			createElement(NarratorHeaderLayout, {
				...input,
				children(layout: NarratorHeaderLayoutSnapshot) {
					counts.header++;
					last = layout;
					return createElement("span", null, String(layout.visibleToolCount));
				},
			}),
			createElement(Body),
		);
	}
	const root = createRoot(document.getElementById("root") as HTMLElement);
	roots.push(root);
	const render = () =>
		flush(() =>
			root.render(
				createElement(
					PanelHeaderControlsProvider,
					{ value: controls },
					strict ? createElement(StrictMode, null, createElement(Panel)) : createElement(Panel),
				),
			),
		);
	render();
	const row = document.querySelector<HTMLElement>("[data-narrator-header-layout]");
	if (!row) throw new Error("Header did not mount");
	let width = 0;
	// An own-element stub: no shared HTMLElement prototype or geometry contamination.
	row.getBoundingClientRect = () => ({ width }) as DOMRect;
	return {
		root,
		row,
		counts,
		layout: () => last,
		resize(next: number) {
			width = next;
			flush(() => {
				for (const observer of TestResizeObserver.instances.filter((x) => x.active))
					observer.fire();
			});
		},
		setWidth(next: number) {
			width = next;
		},
		update(next: Input) {
			input = next;
			render();
		},
		updateControls(next: PanelHeaderControls | null) {
			controls = next;
			render();
		},
	};
}

function expected(
	width: number,
	input: Omit<HeaderAfterTitleInput, "rowWidth"> = DEFAULT_INPUT,
): NarratorHeaderLayoutSnapshot {
	const { titleWidth, visibleToolCount, unmeasured } = resolveHeaderLayoutAfterTitle({
		...input,
		rowWidth: width,
	});
	return { titleWidth, visibleToolCount, unmeasured };
}

describe("NarratorHeaderLayout resize isolation", () => {
	it("starts optimistically, then measures the mounted row without a parent readiness render", async () => {
		const harness = await mount();
		expect(harness.layout()).toEqual(expected(0));
		harness.resize(600);
		expect(harness.layout()).toEqual(expected(600));
		expect(harness.counts.panel).toBe(1);
		expect(harness.counts.body).toBe(1);
	});

	it("measures a positive-width first mount without waiting for an observer event", async () => {
		const createElement = document.createElement;
		// Stub only elements created by this document, before React's layout effect.
		// No shared HTMLElement prototype is modified or left behind.
		document.createElement = ((tag: string, options?: ElementCreationOptions) => {
			const element = createElement.call(document, tag, options);
			if (tag === "div") element.getBoundingClientRect = () => ({ width: 1200 }) as DOMRect;
			return element;
		}) as typeof document.createElement;
		try {
			const harness = await mount();
			expect(harness.layout()).toEqual(expected(1200));
			expect(harness.layout()?.unmeasured).toBe(false);
			expect(harness.counts.panel).toBe(1);
			expect(harness.counts.body).toBe(1);
		} finally {
			document.createElement = createElement;
		}
	});
	it("does not schedule renders for pixel/slack changes that paint the same header", async () => {
		const harness = await mount();
		harness.resize(1200);
		const baseline = { ...harness.counts };
		for (let width = 1199; width >= 1000; width -= 0.5) harness.resize(width);
		expect(harness.counts).toEqual(baseline);
		expect(harness.layout()).toEqual(expected(1000));
	});

	it("updates capacity live while keeping the panel and its body out of resize renders", async () => {
		const harness = await mount();
		harness.resize(1200);
		const before = { ...harness.counts };
		for (let width = 1199; width >= 450; width--) {
			harness.resize(width);
			expect(harness.layout()).toEqual(expected(width));
		}
		expect(harness.counts.panel).toBe(before.panel);
		expect(harness.counts.body).toBe(before.body);
		expect(harness.counts.header - before.header).toBeLessThanOrEqual(12);
		expect(harness.counts.header).toBeGreaterThan(before.header);
	});

	it("keeps a pathological long title responsive without invalidating unrelated content", async () => {
		const input = { ...DEFAULT_INPUT, titleFullWidth: 720 };
		const harness = await mount(input);
		harness.resize(750);
		const before = { ...harness.counts };
		for (const width of [748, 742, 700, 650]) {
			harness.resize(width);
			expect(harness.layout()).toEqual(expected(width, input));
		}
		expect(harness.counts.header).toBeGreaterThan(before.header);
		expect(harness.counts.panel).toBe(before.panel);
		expect(harness.counts.body).toBe(before.body);
	});

	it("preserves the last valid width through zero-width and hidden notifications", async () => {
		const harness = await mount();
		harness.resize(500);
		const before = { ...harness.counts };
		for (const width of [0, -1, 0]) harness.resize(width);
		expect(harness.layout()).toEqual(expected(500));
		expect(harness.counts).toEqual(before);
		harness.resize(800);
		expect(harness.layout()).toEqual(expected(800));
	});

	it("recomputes when title, tool count and chrome props change without a size event", async () => {
		const harness = await mount();
		harness.resize(600);
		for (const input of [
			{ ...DEFAULT_INPUT, titleFullWidth: 400 },
			{ ...DEFAULT_INPUT, surfacedToolCount: 25 },
			{ ...DEFAULT_INPUT, showBack: false, showTitleActions: false, showClose: false },
		]) {
			harness.update(input);
			expect(harness.layout()).toEqual(expected(600, input));
		}
	});

	it("budgets host pin from context and recomputes when it appears or disappears", async () => {
		const harness = await mount();
		harness.resize(600);
		const plain = harness.layout();
		harness.updateControls({ pinAction: "pin" });
		expect(harness.layout()).toEqual(expected(600, { ...DEFAULT_INPUT, showPin: true }));
		expect(harness.layout()?.titleWidth).toBe(DEFAULT_INPUT.titleFullWidth);
		expect(harness.layout()?.visibleToolCount).toBeLessThan(plain?.visibleToolCount ?? 0);
		harness.updateControls(null);
		expect(harness.layout()).toEqual(plain);
	});

	it("does not reserve a pin when close is absent and keeps pinned narrow chrome inside the row", async () => {
		const harness = await mount(DEFAULT_INPUT, false, { pinAction: "pin" });
		harness.resize(350);
		expect(harness.layout()).toEqual(expected(350, { ...DEFAULT_INPUT, showPin: true }));
		expect(harness.layout()?.visibleToolCount).toBe(0);
		expect(harness.layout()?.titleWidth).toBe(DEFAULT_INPUT.titleFullWidth);
		const withoutClose = { ...DEFAULT_INPUT, showClose: false };
		harness.update(withoutClose);
		expect(harness.layout()).toEqual(expected(350, withoutClose));
	});

	it("updates unknown-width options without inventing a no-room shortfall", async () => {
		const harness = await mount();
		const input = { ...DEFAULT_INPUT, titleFullWidth: 400, surfacedToolCount: 25 };
		harness.update(input);
		expect(harness.layout()).toEqual(expected(0, input));
		expect(harness.layout()?.unmeasured).toBe(true);
	});

	it("ignores a stale observer after config changes and disconnects on unmount", async () => {
		const harness = await mount();
		harness.resize(600);
		const observer = TestResizeObserver.instances.at(-1);
		if (!observer) throw new Error("No observer");
		const input = { ...DEFAULT_INPUT, titleFullWidth: 400 };
		harness.update(input);
		harness.setWidth(900);
		const before = { ...harness.counts };
		flush(() => observer.fire());
		expect(harness.layout()).toEqual(expected(600, input));
		expect(harness.counts).toEqual(before);
		flush(() => harness.root.unmount());
		expect(TestResizeObserver.instances.every((x) => !x.active)).toBe(true);
	});

	it("falls back to window resize and removes that listener on unmount", async () => {
		Object.defineProperty(globalThis, "ResizeObserver", { value: undefined, configurable: true });
		const harness = await mount();
		harness.setWidth(600);
		flush(() => window.dispatchEvent(new window.Event("resize")));
		expect(harness.layout()).toEqual(expected(600));
		flush(() => harness.root.unmount());
		harness.row.getBoundingClientRect = () => {
			throw new Error("Unmounted header must not be read");
		};
		expect(() => window.dispatchEvent(new window.Event("resize"))).not.toThrow();
	});

	it("leaves one active observer after StrictMode setup/cleanup replay", async () => {
		const harness = await mount(DEFAULT_INPUT, true);
		harness.resize(600);
		expect(harness.layout()).toEqual(expected(600));
		expect(TestResizeObserver.instances.filter((x) => x.active)).toHaveLength(1);
	});
});
