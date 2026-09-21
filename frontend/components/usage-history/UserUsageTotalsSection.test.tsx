import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import locale from "@frontend/locales/en/common.json";
import type { UserUsageTotals } from "@frontend/types/usage-history";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { UserUsageIdFilter } from "./UserUsageIdFilter";
import { UserUsageTotalsSection } from "./UserUsageTotalsSection";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const testI18n = i18next.createInstance();
let totalsSpy: ReturnType<typeof spyOn<typeof usageHistoryApi, "getUserTotals">>;

const record: UserUsageTotals = {
	userId: "alice-id",
	username: "Alice",
	requestCount: 3,
	inputTokens: 100,
	outputTokens: 20,
	cachedInputTokens: 60,
	cacheCreationTokens: 15,
	reasoningTokens: 5,
	costUsd: 0.25,
	unpricedRequestCount: 2,
	firstUsedAt: "2026-09-01T00:00:00Z",
	lastUsedAt: "2026-09-02T00:00:00Z",
};

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
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
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	await testI18n.use(initReactI18next).init({
		lng: "en",
		defaultNS: "common",
		resources: { en: { common: locale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	totalsSpy = spyOn(usageHistoryApi, "getUserTotals").mockImplementation(async (options) => ({
		records: options?.cursor ? [{ ...record, userId: "deleted-id", username: null }] : [record],
		hasMore: !options?.cursor,
		nextCursor: options?.cursor ? null : "alice-id",
		limit: 50,
	}));
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	totalsSpy.mockRestore();
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originalGlobals.clear();
});

async function renderSection(content: ReactNode = <UserUsageTotalsSection />) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={testI18n}>
				<QueryClientProvider client={client}>
					<MantineProvider env="test">{content}</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

function button(label: string): HTMLButtonElement {
	const result = [...container.querySelectorAll("button")].find(
		(node) => node.textContent === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

async function clickButton(label: string) {
	await act(async () => button(label).click());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

describe("user ID filter", () => {
	test("does not query while typing and applies a trimmed deleted ID on Enter", async () => {
		const changes: (string | undefined)[] = [];
		await renderSection(
			<UserUsageIdFilter isMobile={false} onChange={(value) => changes.push(value)} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		input.value = "  deleted-user-id  ";
		await act(async () => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(changes).toEqual([]);
		const enter = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(enter, "key", { value: "Enter" });
		await act(async () => {
			input.dispatchEvent(enter);
		});
		expect(changes).toEqual(["deleted-user-id"]);
	});

	test("applies blur, clears to all users and follows external selection without duplicate queries", async () => {
		const changes: (string | undefined)[] = [];
		const onChange = (value: string | undefined) => changes.push(value);
		await renderSection(
			<UserUsageIdFilter value="alice-id" isMobile={false} onChange={onChange} />,
		);
		let input = container.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("alice-id");
		input.value = "deleted-id";
		await act(async () => {
			input.dispatchEvent(new Event("focusout", { bubbles: true }));
		});
		expect(changes).toEqual(["deleted-id"]);
		await renderSection(
			<UserUsageIdFilter value="deleted-id" isMobile={false} onChange={onChange} />,
		);
		input = container.querySelector("input") as HTMLInputElement;
		await act(async () => {
			input.dispatchEvent(new Event("focusout", { bubbles: true }));
		});
		expect(changes).toEqual(["deleted-id"]);
		input.value = "   ";
		await act(async () => {
			input.dispatchEvent(new Event("focusout", { bubbles: true }));
		});
		expect(changes).toEqual(["deleted-id", undefined]);
		await renderSection(
			<UserUsageIdFilter value="__unattributed__" isMobile={false} onChange={onChange} />,
		);
		expect(container.querySelector("input")?.value).toBe("__unattributed__");
	});
});

describe("durable user totals", () => {
	test("shows independent lifetime semantics, raw categories and unpriced counts without a token sum", async () => {
		await renderSection();
		expect(container.textContent).toContain(locale.usageUserTotalsDescription);
		expect(container.textContent).toContain(locale.usageUserTotalsCostNote);
		const cells = [...container.querySelectorAll("tbody td")].map((cell) => cell.textContent);
		expect(cells).toEqual(["Alicealice-id", "3", "100", "20", "60", "15", "5", "$0.250000", "2"]);
		expect(container.querySelectorAll("thead th")).toHaveLength(9);
		expect(totalsSpy.mock.calls[0]?.[0]?.limit).toBe(50);
		expect(Object.keys(totalsSpy.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
			"cursor",
			"limit",
			"signal",
		]);
	});

	test("pages forward and backward by user ID and preserves deleted-user identity", async () => {
		await renderSection();
		expect(button("Previous").disabled).toBe(true);
		await clickButton("Next");
		expect(container.textContent).toContain("deleted-id");
		expect(container.textContent).toContain("Page 2");
		expect(totalsSpy.mock.calls.some(([options]) => options?.cursor === "alice-id")).toBe(true);
		expect(button("Next").disabled).toBe(true);
		await clickButton("Previous");
		expect(container.textContent).toContain("Alice");
		expect(container.textContent).toContain("Page 1");
	});

	test("distinguishes load errors from empty totals and offers refresh", async () => {
		totalsSpy.mockRejectedValue(new Error("unavailable"));
		await renderSection();
		expect(container.textContent).toContain(locale.usageUserTotalsLoadFailed);
		expect(container.textContent).not.toContain(locale.usageUserTotalsEmpty);
		expect(button("Next").disabled).toBe(true);
		totalsSpy.mockResolvedValue({ records: [], hasMore: false, nextCursor: null, limit: 50 });
		await clickButton("Refresh");
		expect(container.textContent).toContain(locale.usageUserTotalsEmpty);
	});
});
