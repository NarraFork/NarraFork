import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createSharedContext } from "./shared-context";

/**
 * Regression coverage for "useImageViewer must be used within ImageViewerProvider"
 * in the workspace / virtual-list surfaces.
 *
 * Bug it guards: `createContext()` mints a new object per module evaluation, and
 * React pairs providers with consumers by that object's identity. Under Vite Fast
 * Refresh (and with a duplicated production chunk) the provider module can be
 * evaluated twice — the app shell keeps the first context while a lazily-mounted
 * subtree imports the second, so the consumer reads the default value and throws
 * even though the provider is right there in the tree.
 *
 * The first test reproduces that split with two plain `createContext()` calls, so
 * the failure mode stays documented; the rest assert that the shared registry
 * hands both module copies the SAME context object and that a consumer therefore
 * resolves the value across the split.
 */

const GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"Event",
	"HTMLElement",
	"Element",
	"Node",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreGlobals: (() => void) | undefined;

function installDom() {
	const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	for (const key of GLOBAL_KEYS) {
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}

	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	restoreGlobals = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key as string);
		}
	};
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	restoreGlobals?.();
	restoreGlobals = undefined;
});

/** Render `<Provider value>` around a consumer that reads `Consumed`. */
async function renderAcross(
	ProviderCtx: React.Context<string | null>,
	ConsumerCtx: React.Context<string | null>,
) {
	function Consumer() {
		const value = useContext(ConsumerCtx);
		return <span>{value ?? "MISSING"}</span>;
	}

	await act(async () => {
		root?.render(
			<ProviderCtx.Provider value="resolved">
				<Consumer />
			</ProviderCtx.Provider>,
		);
	});
	return container?.textContent ?? "";
}

describe("createSharedContext", () => {
	test("plain createContext splits provider from consumer across module copies", async () => {
		// Two evaluations of the same module produce two distinct context objects.
		const firstEvaluation = createContext<string | null>(null);
		const secondEvaluation = createContext<string | null>(null);

		expect(firstEvaluation).not.toBe(secondEvaluation);
		// The provider writes to one, the consumer reads the other → default value.
		expect(await renderAcross(firstEvaluation, secondEvaluation)).toBe("MISSING");
	});

	test("the same key resolves to one context object", () => {
		const first = createSharedContext<string | null>("test/duplicate-evaluation", null);
		const second = createSharedContext<string | null>("test/duplicate-evaluation", null);

		expect(second).toBe(first);
	});

	test("a consumer resolves the value across duplicated module evaluations", async () => {
		// Simulates the shell holding the first evaluation's context while a lazily
		// mounted subtree imports the second.
		const shellContext = createSharedContext<string | null>("test/shared-across-copies", null);
		const lazyChunkContext = createSharedContext<string | null>("test/shared-across-copies", null);

		expect(await renderAcross(shellContext, lazyChunkContext)).toBe("resolved");
	});

	test("different keys stay independent", () => {
		const viewer = createSharedContext<string | null>("test/viewer", null);
		const dialog = createSharedContext<string | null>("test/dialog", null);

		expect(viewer).not.toBe(dialog);
	});

	test("the first registration owns the default value", () => {
		const first = createSharedContext<string>("test/default-value", "first");
		// A later caller gets the already-registered context, not a new one seeded
		// with its own default — that identity is the entire point.
		const second = createSharedContext<string>("test/default-value", "second");

		expect(second).toBe(first);
	});
});
