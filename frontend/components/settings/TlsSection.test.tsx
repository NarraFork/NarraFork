/**
 * TlsSection.test.tsx — the SAN editor must survive status refetches.
 *
 * The regression this pins: the editor re-initialized from the TLS status query on
 * EVERY data arrival. React Query refetches on window focus (the app's staleTime is
 * 5s), so tabbing away to copy a hostname and coming back silently discarded every
 * SAN entry the user had typed but not issued yet — the exact stale-snapshot clobber
 * the server-side SAN sidecar exists to prevent. Initialization now happens once per
 * mount; later snapshots never touch the editor.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
// Both module mocks MUST spread the real modules: bun's mock.module is process-global
// for modules loaded afterwards, and other test files' graphs import named exports
// (`QueryClient`, `clearTokenOnSessionFailure`, …) from these same modules — a bare
// factory would erase them and fail those files at link time.
const realApiModule = { ...(await import("../../lib/api")) };
const realReactQueryModule = { ...(await import("@tanstack/react-query")) };

/** Controllable query result: swapping `.current` simulates a refetch landing. */
const queryState: { current: { data: unknown } } = { current: { data: undefined } };

// i18n returns raw keys so assertions are translation-stable. Note the mock `t`
// ignores interpolation params, so auto-SANs never reach the rendered text — the
// assertions below target the custom-SAN pills, which are real text. `returnObjects`
// must yield an array because the trust-guide modal maps over the step list.
mock.module("react-i18next", () => ({
	...realReactI18nextModule,
	useTranslation: () => ({
		t: (key: string, opts?: { returnObjects?: boolean }) =>
			opts?.returnObjects ? [`${key}-step`] : key,
		i18n: { language: "en" },
	}),
}));
mock.module("@tanstack/react-query", () => ({
	...realReactQueryModule,
	useQuery: () => queryState.current,
	useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
mock.module("../../lib/api", () => ({
	...realApiModule,
	api: {
		...realApiModule.api,
		getTlsStatus: async () => queryState.current.data,
		generateTlsWithCa: async () => {
			throw new Error("not exercised by this test");
		},
		regenerateTlsCa: async () => {
			throw new Error("not exercised by this test");
		},
		downloadTlsCa: async () => {
			throw new Error("not exercised by this test");
		},
	},
}));

const { TlsSection } = await import("./TlsSection");

let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

function setupDom() {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	// linkedom computes no layout and provides no getComputedStyle, but Mantine's
	// Modal/Popover plumbing calls it. Any-property "" stub, the established
	// pattern from useSwipeMenu.scroll-parent.test.ts.
	const computedStyleStub = () =>
		new Proxy(
			{},
			{
				get: (_target, prop) => (prop === "getPropertyValue" ? () => "" : ""),
			},
		);
	if (typeof g.getComputedStyle !== "function") {
		g.getComputedStyle = computedStyleStub;
		// `window.getComputedStyle` is a separate lookup from the bare global, and
		// `win` is type-checked against the DOM lib — go through the untyped view.
		(win as unknown as Record<string, unknown>).getComputedStyle = computedStyleStub;
	}
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
		g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as Timer);
	}
	return win.document;
}

function renderSection(): HTMLElement {
	const doc = setupDom();
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(
			<MantineProvider>
				<TlsSection onCertIssued={() => {}} />
			</MantineProvider>,
		);
	});
	return currentContainer;
}

/** Re-render with the current query snapshot, flushing effects. */
function rerender() {
	const root = currentRoot;
	if (!root) throw new Error("expected a mounted section");
	act(() => {
		root.render(
			<MantineProvider>
				<TlsSection onCertIssued={() => {}} />
			</MantineProvider>,
		);
	});
}

afterEach(() => {
	if (currentRoot) {
		const root = currentRoot;
		act(() => root.unmount());
		currentRoot = null;
	}
	currentContainer?.remove();
	currentContainer = null;
	queryState.current = { data: undefined };
});

afterAll(() => {
	mock.restore();
});

function tlsStatus(customSans: string[]) {
	return {
		caExists: true,
		caExpiresAt: "2046-01-01T00:00:00.000Z",
		certExists: true,
		certExpiresAt: "2036-01-01T00:00:00.000Z",
		legacySelfSigned: false,
		certSans: [],
		customSans,
		autoSans: ["localhost", "127.0.0.1"],
	};
}

describe("TlsSection — SAN editor initialization", () => {
	test("initializes from the first status snapshot, then ignores refetches", () => {
		// Mount while the query is still loading: no stored SANs to show yet.
		queryState.current = { data: undefined };
		const container = renderSection();
		expect(container.textContent ?? "").not.toContain("nas.local");

		// The first snapshot initializes the editor.
		queryState.current = { data: tlsStatus(["nas.local"]) };
		rerender();
		expect(container.textContent ?? "").toContain("nas.local");

		// A later refetch — e.g. window focus after the user typed new entries, or
		// another admin having issued in the meantime — must NOT reset the editor:
		// the user may have unsubmitted input riding on the current state.
		queryState.current = { data: tlsStatus(["nas.local", "other.home.arpa"]) };
		rerender();
		const text = container.textContent ?? "";
		expect(text).toContain("nas.local");
		expect(text).not.toContain("other.home.arpa");
	});
});
