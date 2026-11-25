import { afterEach, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";

mock.module("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
mock.module("../../../hooks/usePlatform", () => ({ useProviderRuntimeCapability: () => ({}) }));
const loadOverview = mock(() => new Promise<never>(() => {}));
mock.module("../../../lib/api", () => ({ api: { codexQuotaOverview: loadOverview } }));
mock.module("../../../lib/narrator-ws-manager", () => ({
	narratorWSManager: { addListener: () => ({}), removeListener: () => {} },
}));
const { CodexQuotaIndicator } = await import("./CodexQuotaIndicator");
const saved = new Map<string, PropertyDescriptor | undefined>();
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
	loadOverview.mockClear();
});

test("Codex dedicated forecast entry does not fetch private detail before opening", async () => {
	const { window } = parseHTML("<html><body></body></html>");
	window.matchMedia = (() => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	})) as unknown as typeof window.matchMedia;
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	cleanup = async () => {
		await act(async () => root.unmount());
		client.clear();
		container.remove();
	};
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<MantineProvider>
					<CodexQuotaIndicator enabled isAdmin={false} detailsOnly />
				</MantineProvider>
			</QueryClientProvider>,
		);
	});
	expect(loadOverview).not.toHaveBeenCalled();
	expect(container.querySelector("svg.tabler-icon-chart-line")).not.toBeNull();
	await act(async () =>
		container.querySelector("button")?.dispatchEvent(new window.Event("click", { bubbles: true })),
	);
	expect(loadOverview).toHaveBeenCalledTimes(1);
});
