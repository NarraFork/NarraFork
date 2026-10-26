import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import locale from "@frontend/locales/en/common.json";
import type {
	UsageHistoryRecord,
	UsageHistoryStats,
	UsageHistoryTimeSeriesResponse,
} from "@frontend/types/usage-history";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { buildUsageChartPath, UsageHistoryChart } from "./UsageHistoryChart";
import { UsageHistoryTable } from "./UsageHistoryTable";
import { UsageStatsSummary } from "./UsageStatsSummary";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let originalScrollIntoView: PropertyDescriptor | undefined;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const testI18n = i18next.createInstance();

function record(overrides: Partial<UsageHistoryRecord> = {}): UsageHistoryRecord {
	return {
		id: "openai-request",
		narratorId: null,
		kind: "narrator",
		provider: "openai",
		credentialId: null,
		credentialName: null,
		model: "fixture-model",
		inputTokens: 200,
		outputTokens: 30,
		cachedInputTokens: 800,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
		reasoningTokens: 0,
		ttftMs: null,
		durationMs: null,
		costUsd: null,
		contextPercent: null,
		meterUsage: null,
		meterUnit: null,
		createdAt: "2026-07-17T12:00:00.000Z",
		...overrides,
	};
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	originalScrollIntoView = Object.getOwnPropertyDescriptor(
		window.HTMLElement.prototype,
		"scrollIntoView",
	);
	Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value() {},
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
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		MutationObserver: window.MutationObserver,
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent: () => false,
		}),
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
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	if (originalScrollIntoView)
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
	else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originalGlobals.clear();
});

async function render(content: ReactNode) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={testI18n}>
				<QueryClientProvider client={client}>
					<MantineProvider env="test">{content}</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
	});
}

function tokenTexts(): string[] {
	const cell = container.querySelector("tbody tr")?.querySelectorAll("td")[7];
	if (!cell) throw new Error("Missing tokens cell");
	return [...cell.querySelectorAll("p")].map((node) => node.textContent ?? "");
}

describe("UsageHistoryTable normalized token accounting", () => {
	test("shows OpenAI ordinary input without subtracting its cache read again", async () => {
		await render(<UsageHistoryTable records={[record()]} />);
		expect(tokenTexts()).toEqual(["200", "30", "800"]);
		expect(tokenTexts().some((value) => value.startsWith("-"))).toBe(false);
	});

	test("keeps a fully cached OpenAI request at zero ordinary input", async () => {
		await render(<UsageHistoryTable records={[record({ inputTokens: 0 })]} />);
		expect(tokenTexts()).toEqual(["0", "30", "800"]);
	});

	test("sorts both directions by ordinary input + output + cache read + cache write", async () => {
		const records = [
			record({
				id: "plain",
				model: "plain",
				inputTokens: 100,
				outputTokens: 100,
				cachedInputTokens: 0,
			}),
			record({
				id: "read",
				model: "read",
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 300,
			}),
			record({
				id: "write",
				model: "write",
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				cacheCreationInputTokens: 400,
			}),
			record({
				id: "output",
				model: "output",
				inputTokens: 0,
				outputTokens: 500,
				cachedInputTokens: 0,
			}),
		];
		await render(<UsageHistoryTable records={records} />);
		const models = () =>
			[...container.querySelectorAll("tbody tr")].map(
				(row) => row.querySelectorAll("td")[6]?.textContent,
			);
		const header = [...container.querySelectorAll("th")].find(
			(node) => node.textContent === locale.usageHistoryTableTokens,
		);
		if (!header) throw new Error("Missing sortable tokens header");
		expect(models()).toEqual(["plain", "read", "write", "output"]);
		await act(async () => header.click());
		expect(models()).toEqual(["output", "write", "read", "plain"]);
		await act(async () => header.click());
		expect(models()).toEqual(["plain", "read", "write", "output"]);
		// Sorting must not mutate the query cache's original records array.
		expect(records.map((item) => item.id)).toEqual(["plain", "read", "write", "output"]);
	});
});

const stats: UsageHistoryStats = {
	cacheHitRate: 0.5,
	cacheHitRateReadTokens: 800,
	cacheHitRateInputTokens: 1600,
	totalRequests: 2,
	totalInputTokens: 200,
	totalOutputTokens: 900,
	totalCacheReadTokens: 800,
	totalCacheCreationTokens: 600,
	totalCacheCreation5mTokens: 600,
	totalCacheCreation1hTokens: 0,
	totalReasoningTokens: 300,
	totalTokens: 2500,
	totalCost: 0,
	averageDurationMs: 0,
	averageTtftMs: 0,
};

describe("UsageHistoryChart cache hit rate", () => {
	function chartData(rates: Array<number | null>): UsageHistoryTimeSeriesResponse {
		const start = "2026-07-17T00:00:00.000Z";
		return {
			granularity: "day",
			bucketCount: rates.length,
			maxBuckets: 366,
			truncated: false,
			requestedStartDate: start,
			requestedEndDate: start,
			effectiveStartDate: start,
			effectiveEndDate: start,
			generatedAt: start,
			points: rates.map((rate, index) => ({
				...stats,
				timestamp: `2026-07-${17 + index}T00:00:00.000Z`,
				requestCount: 2,
				cacheHitRate: rate,
				errorCount: 0,
				meterUsage: 0,
				meterUnit: null,
			})),
		};
	}

	async function selectCacheRate(compare = false) {
		const inputs = container.querySelectorAll<HTMLInputElement>("input[role=combobox]");
		const input = inputs[compare ? 1 : 0];
		await act(async () => input.click());
		const listId = input.getAttribute("aria-controls");
		const option = (listId ? document.getElementById(listId) : null)?.querySelector<HTMLElement>(
			'[role="option"][value="cacheHitRate"]',
		);
		if (!option) throw new Error("Missing cache hit rate option");
		await act(async () => option.click());
	}

	test("breaks the chart path at missing buckets instead of drawing zero", () => {
		expect(
			buildUsageChartPath(
				[null, 50, 60, null, 100, null],
				(i) => i,
				(value) => value,
			),
		).toBe("M 1 50 L 2 60 M 4 100");
		expect(
			buildUsageChartPath(
				[null, null],
				(i) => i,
				(value) => value,
			),
		).toBe("");
		expect(
			buildUsageChartPath(
				[0, 0],
				(i) => i,
				(value) => value,
			),
		).toBe("M 0 0 L 1 0");
	});

	test("shows no data for a selected rate with requests but no eligible samples", async () => {
		await render(
			<UsageHistoryChart
				data={chartData([null, null])}
				granularity="day"
				onGranularityChange={() => {}}
			/>,
		);
		await selectCacheRate();
		expect(container.textContent).toContain(locale.usageHistoryCacheHitRateEmpty);
		expect(container.querySelector("svg[role=img]")).toBeNull();
	});

	test("draws isolated rate samples as dots and formats the axis as percentages", async () => {
		await render(
			<UsageHistoryChart
				data={chartData([null, 0.8, null])}
				granularity="day"
				onGranularityChange={() => {}}
			/>,
		);
		await selectCacheRate();
		const chart = container.querySelector("svg[role=img]");
		expect(chart?.textContent).toContain("80%");
		expect(chart?.querySelectorAll("circle")).toHaveLength(1);
		expect(chart?.querySelector("path")?.getAttribute("d")).not.toContain("L");
		expect(chart?.innerHTML).not.toContain("NaN");
	});

	test("leaves an empty comparison rate undrawn without hiding the primary metric", async () => {
		await render(
			<UsageHistoryChart
				data={chartData([null, null])}
				granularity="day"
				onGranularityChange={() => {}}
			/>,
		);
		await selectCacheRate(true);
		const chart = container.querySelector("svg[role=img]");
		expect(chart).not.toBeNull();
		expect(chart?.querySelectorAll("path")).toHaveLength(1);
		expect(container.textContent).toContain(locale.usageHistoryCacheHitRateEmpty);
	});

	test("hovering a missing bucket shows no data and no zero-valued marker", async () => {
		await render(
			<UsageHistoryChart
				data={chartData([0.5, null, 0.8])}
				granularity="day"
				onGranularityChange={() => {}}
			/>,
		);
		await selectCacheRate();
		const chart = container.querySelector("svg[role=img]");
		if (!chart) throw new Error("Missing chart");
		Object.defineProperties(chart, {
			getScreenCTM: { value: () => ({ inverse: () => ({}) }) },
			createSVGPoint: {
				value: () => ({
					x: 0,
					y: 0,
					matrixTransform() {
						return { x: this.x, y: this.y };
					},
				}),
			},
		});
		const event = new Event("pointermove", { bubbles: true });
		Object.defineProperties(event, { clientX: { value: 400 }, clientY: { value: 50 } });
		await act(async () => chart.dispatchEvent(event));
		expect(container.textContent).toContain(locale.usageHistoryCacheHitRateEmpty);
		expect(chart.querySelectorAll("circle")).toHaveLength(2);
	});
});

describe("UsageStatsSummary cache hit rate", () => {
	function hitRateTexts(): string[] {
		const label = [...container.querySelectorAll("p")].find(
			(node) => node.textContent === locale.usageHistoryStatCacheHitRate,
		);
		const card = label?.parentElement?.parentElement;
		if (!card) throw new Error("Missing cache hit rate summary");
		return [...card.querySelectorAll("p")].map((node) => node.textContent ?? "");
	}

	test("retains read / (ordinary input + read + write), excluding output and reasoning", async () => {
		await render(<UsageStatsSummary stats={stats} />);
		expect(hitRateTexts()).toEqual([locale.usageHistoryStatCacheHitRate, "50%", "50.00%"]);
	});

	test("shows 100% for fully cached input", async () => {
		await render(
			<UsageStatsSummary
				stats={{
					...stats,
					cacheHitRate: 1,
					cacheHitRateInputTokens: 800,
					totalInputTokens: 0,
					totalCacheCreationTokens: 0,
				}}
			/>,
		);
		expect(hitRateTexts()).toEqual([locale.usageHistoryStatCacheHitRate, "100%", "100.00%"]);
	});

	test("uses the dedicated rate even when ordinary input totals include excluded requests", async () => {
		await render(<UsageStatsSummary stats={{ ...stats, totalInputTokens: 999999 }} />);
		expect(hitRateTexts()).toEqual([locale.usageHistoryStatCacheHitRate, "50%", "50.00%"]);
	});

	test("shows no data when requests have no cache reads, despite positive input/write tokens", async () => {
		await render(
			<UsageStatsSummary
				stats={{
					...stats,
					cacheHitRate: null,
					cacheHitRateReadTokens: 0,
					cacheHitRateInputTokens: 0,
					totalInputTokens: 10000,
					totalCacheCreationTokens: 5000,
					totalCacheReadTokens: 0,
				}}
			/>,
		);
		expect(hitRateTexts()).toEqual([
			locale.usageHistoryStatCacheHitRate,
			locale.usageHistoryCacheHitRateEmpty,
		]);
	});
});
