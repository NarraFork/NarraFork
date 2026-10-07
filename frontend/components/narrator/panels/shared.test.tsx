/**
 * usePanelHeaderDrag — what a panel header drag puts on the wire.
 *
 * Every panel this hook runs in is a real dockview panel, including inside a
 * detached canvas node (which hosts its own surface). So there is exactly one
 * shape, and two fields in it are load-bearing in ways that fail SILENTLY:
 *
 *  - `panelId` is what makes `useDockviewDnd` treat the drop as moving THIS panel
 *    (`dropExistingPanel`) rather than creating something new. Lose it and the drag
 *    stops being recognised as an in-surface move.
 *  - `surfaceId` is what disambiguates it. Panel ids are global (`ndock-terminal`),
 *    so a surface receiving a drop without one would look the id up in its OWN api
 *    and rearrange an unrelated same-kind panel — a mis-move with no error.
 *
 * Detached nodes are dragged by their own grip bar, never through a panel header,
 * so there is deliberately no "detached" variant of this drag any more.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const DOM_KEYS = [
	"window",
	"document",
	"navigator",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
	"MutationObserver",
] as const;

class TestMutationObserver {
	static instances: TestMutationObserver[] = [];
	target: Node | null = null;
	disconnected = false;
	constructor(readonly callback: MutationCallback) {
		TestMutationObserver.instances.push(this);
	}
	observe(target: Node, options: MutationObserverInit) {
		expect(options).toEqual({ attributes: true, attributeFilter: ["style"] });
		this.target = target;
	}
	disconnect() {
		this.disconnected = true;
	}
	notify() {
		if (!this.disconnected) this.callback([], this as unknown as MutationObserver);
	}
}

/**
 * Minimal DOM for react-dom to render into. Same shape as the other DOM harnesses
 * in this repo (see useResizableNav.test.tsx): without `requestAnimationFrame` and
 * `IS_REACT_ACT_ENVIRONMENT`, react-dom's scheduler throws after the test body.
 */
async function installDom(): Promise<() => void> {
	const { parseHTML } = await import("linkedom");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		requestAnimationFrame: (cb: FrameRequestCallback) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (h: number) => clearTimeout(h),
		IS_REACT_ACT_ENVIRONMENT: false,
		MutationObserver: TestMutationObserver,
	};
	for (const key of DOM_KEYS) {
		Object.defineProperty(globalThis, key, { value: values[key], configurable: true });
	}
	return () => {
		for (const key of DOM_KEYS) {
			const d = previous.get(key);
			if (d) Object.defineProperty(globalThis, key, d);
			else Reflect.deleteProperty(globalThis as object, key);
		}
	};
}

/**
 * Render a component that calls `usePanelHeaderDrag`, fire the returned handler,
 * and report the drag state the singleton ended up holding.
 *
 * The handler is invoked directly rather than through a real pointer event: the
 * singleton arms a PENDING drag on pointerdown and only promotes it to a live drag
 * past a 5px threshold, so the state under test is read after a
 * threshold-crossing pointermove.
 */
async function captureDrag(
	opts: {
		toolKind?: string;
		surfaceId?: string;
		resourceId?: string;
		largeFileConfirmed?: boolean;
	} = {},
) {
	const React = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { flushSync } = await import("react-dom");
	const { usePanelHeaderDrag } = await import("./shared");
	const { getPanelDrag } = await import("../../../lib/panel-drag");

	let handler: ((e: React.PointerEvent) => void) | null = null;
	function Probe() {
		// Only the fields the hook reads.
		const props = {
			api: { id: "ndock-terminal", title: "Terminal", group: { id: "group-1" } },
			// biome-ignore lint/suspicious/noExplicitAny: minimal api stub for the hook
		} as any;
		handler = usePanelHeaderDrag(
			props,
			"__terminal__",
			"tool",
			opts.toolKind
				? {
						toolKind: opts.toolKind,
						resourceId: opts.resourceId,
						largeFileConfirmed: opts.largeFileConfirmed,
					}
				: undefined,
		);
		return null;
	}

	const host = document.getElementById("root");
	if (!host) throw new Error("test host missing");
	const root = createRoot(host);
	flushSync(() => {
		root.render(React.createElement(Probe));
	});
	if (!handler) throw new Error("hook did not return a handler");

	// Arm the drag, then cross the 5px threshold so it becomes the live state.
	(handler as (e: unknown) => void)({ clientX: 100, clientY: 100 });
	document.dispatchEvent(
		Object.assign(new window.Event("pointermove", { bubbles: true }), {
			clientX: 140,
			clientY: 140,
		}),
	);
	const state = getPanelDrag();
	// Release so the singleton does not leak a live drag into the next test.
	document.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
	flushSync(() => root.unmount());
	return state ? { ...state } : null;
}

/**
 * The DOM is installed for the whole file, not per test: react-dom queues a
 * scheduler callback that reads `window` AFTER the test body returns, so tearing
 * the DOM down between tests surfaces as an unhandled ReferenceError rather than
 * a failure. `afterAll` also drains the queue before restoring.
 */
let restoreDom: (() => void) | undefined;

beforeAll(async () => {
	restoreDom = await installDom();
});

afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 10));
	restoreDom?.();
});

async function mountGeometryProbe(style?: string) {
	const React = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { flushSync } = await import("react-dom");
	const { usePanelGeometryReady } = await import("./shared");
	const container = document.createElement("div");
	if (style !== undefined) {
		container.className = "dv-render-overlay";
		container.setAttribute("style", style);
	}
	document.body.appendChild(container);
	const root = createRoot(container);
	let mounts = 0;
	let unmounts = 0;
	let initialWidth = "";
	const onAttach = () => {};
	function Content() {
		React.useLayoutEffect(() => {
			mounts++;
			initialWidth = container.style.width;
			return () => {
				unmounts++;
			};
		}, []);
		return <span>content</span>;
	}
	function Probe() {
		const { ref, geometryReady } = usePanelGeometryReady(onAttach);
		return <div ref={ref}>{geometryReady && <Content />}</div>;
	}
	const observerStart = TestMutationObserver.instances.length;
	flushSync(() => root.render(<Probe />));
	return {
		container,
		get mounts() {
			return mounts;
		},
		get unmounts() {
			return unmounts;
		},
		get initialWidth() {
			return initialWidth;
		},
		get observers() {
			return TestMutationObserver.instances.slice(observerStart);
		},
		update(style: string) {
			flushSync(() => {
				container.setAttribute("style", style);
				for (const observer of this.observers) observer.notify();
			});
		},
		dispose() {
			flushSync(() => root.unmount());
			container.remove();
		},
	};
}

describe("usePanelGeometryReady", () => {
	it("waits for the visible positioned overlay, then keeps content mounted", async () => {
		const probe = await mountGeometryProbe("visibility: hidden");
		try {
			expect(probe.mounts).toBe(0);
			probe.update("visibility: hidden; width: 520px; height: 700px");
			expect(probe.mounts).toBe(0);
			probe.update("width: 520px; height: 0px");
			expect(probe.mounts).toBe(0);
			probe.update("width: 520px; height: 700px");
			expect(probe.mounts).toBe(1);
			expect(probe.initialWidth).toBe("520px");
			expect(probe.observers.every((observer) => observer.disconnected)).toBe(true);
			probe.update("visibility: hidden; width: 800px; height: 700px");
			probe.update("width: 420px; height: 700px");
			expect(probe.mounts).toBe(1);
			expect(probe.unmounts).toBe(0);
		} finally {
			probe.dispose();
		}
	});

	it("mounts immediately in an already positioned overlay", async () => {
		const probe = await mountGeometryProbe("width: 520px; height: 700px");
		try {
			expect(probe.mounts).toBe(1);
			expect(probe.observers).toHaveLength(0);
		} finally {
			probe.dispose();
		}
	});

	it("does not delay hosts without an overlay", async () => {
		const probe = await mountGeometryProbe();
		try {
			expect(probe.mounts).toBe(1);
			expect(probe.observers).toHaveLength(0);
		} finally {
			probe.dispose();
		}
	});

	it("disconnects a pending observer when the host unmounts", async () => {
		const probe = await mountGeometryProbe("visibility: hidden");
		expect(probe.mounts).toBe(0);
		expect(probe.observers).toHaveLength(1);
		probe.dispose();
		expect(probe.observers[0]?.disconnected).toBe(true);
	});
});

describe("usePanelHeaderDrag", () => {
	it("preserves panel consent through a header tear-out and detached persistence", async () => {
		const { makePanelEntry, parseDetachedNodes, serializeDetachedNodes } = await import(
			"../../graph/dock/detached-panels"
		);
		for (const largeFileConfirmed of [true, false, undefined]) {
			const state = await captureDrag({
				toolKind: "file",
				resourceId: "/large.ts",
				largeFileConfirmed,
			});
			if (!state) throw new Error("drag state missing");
			expect(state.resourceId).toBe("/large.ts");
			const entry = makePanelEntry("file", state.resourceId, state);
			const raw = serializeDetachedNodes([
				{ id: "detached", x: 0, y: 0, w: 480, h: 360, pendingPanels: [entry] },
			]);
			const restored = parseDetachedNodes(raw)[0].pendingPanels?.[0];
			expect(restored?.panelId).toBe("file:/large.ts");
			if (largeFileConfirmed) expect(restored?.largeFileConfirmed).toBe(true);
			else expect(restored).not.toHaveProperty("largeFileConfirmed");
		}
	});

	it("carries panelId so the surface treats the drop as moving THIS panel", async () => {
		const state = await captureDrag({ toolKind: "terminal" });
		expect(state?.panelId).toBe("ndock-terminal");
		expect(state?.sourceGroupId).toBe("group-1");
		expect(state?.id).toBe("__terminal__");
	});

	it("forwards the panel kind, so a consumer can rebuild it elsewhere", async () => {
		// The canvas uses this to tear the panel out into its own node without parsing
		// `panelId`'s `ndock-<kind>` shape, which is an implementation detail.
		const state = await captureDrag({ toolKind: "terminal" });
		expect(state?.toolKind).toBe("terminal");
	});

	it("omits toolKind when the panel opted out of being detachable", async () => {
		const state = await captureDrag();
		expect(state?.toolKind).toBeUndefined();
		// Still a normal in-surface drag: opting out of detaching must not break
		// rearranging.
		expect(state?.panelId).toBe("ndock-terminal");
	});

	it("classifies the subject explicitly, so narrator-only consumers ignore it", async () => {
		// The narrator page's create-workspace drop zone acts only on real narrators; a
		// tool panel arriving there would otherwise create a leaf pointing at a
		// non-existent narrator.
		const state = await captureDrag({ toolKind: "terminal" });
		expect(state?.subjectKind).toBe("tool");
	});
});

describe("usePanelCompact retained hidden surfaces", () => {
	it("keeps the last visible breakpoint through zero-width parking and resumes normally", async () => {
		const React = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { flushSync } = await import("react-dom");
		const { usePanelCompact } = await import("./shared");
		const previous = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
		let callback: ResizeObserverCallback | undefined;
		let disconnected = false;
		class Observer {
			constructor(cb: ResizeObserverCallback) {
				callback = cb;
			}
			observe() {}
			disconnect() {
				disconnected = true;
			}
		}
		Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
		const element = document.body.appendChild(document.createElement("div"));
		const root = createRoot(element);
		let compact = true;
		function Probe() {
			const state = usePanelCompact();
			compact = state.compact;
			return React.createElement("div", { ref: state.ref });
		}
		const resize = (width: number) =>
			flushSync(() =>
				callback?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver),
			);
		try {
			flushSync(() => root.render(React.createElement(Probe)));
			expect(compact).toBe(true);
			resize(0);
			expect(compact).toBe(true);
			resize(900);
			expect(compact).toBe(false);
			resize(0);
			expect(compact).toBe(false);
			resize(639);
			expect(compact).toBe(true);
			resize(640);
			expect(compact).toBe(false);
		} finally {
			flushSync(() => root.unmount());
			expect(disconnected).toBe(true);
			element.remove();
			if (previous) Object.defineProperty(globalThis, "ResizeObserver", previous);
			else Reflect.deleteProperty(globalThis, "ResizeObserver");
		}
	});
});
