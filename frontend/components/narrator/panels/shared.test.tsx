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
] as const;

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
async function captureDrag(opts: { toolKind?: string; surfaceId?: string } = {}) {
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
			opts.toolKind ? { toolKind: opts.toolKind } : undefined,
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

describe("usePanelHeaderDrag", () => {
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
