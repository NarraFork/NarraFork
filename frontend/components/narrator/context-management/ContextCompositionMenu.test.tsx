import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	type ContextComposition,
	emptyContextComposition,
	groupContextSegments,
} from "@shared/context-composition";
import type { ContextUsageSnapshot } from "@shared/context-usage";
import { parseHTML } from "linkedom";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@frontend/lib/api/context-composition", () => ({
	getContextComposition: () => Promise.resolve(null),
}));
let query: Record<string, unknown>;
let resets = 0;
const client = {
	resetQueries: () => {
		resets++;
		return Promise.resolve();
	},
};
mock.module("@tanstack/react-query", () => ({
	useInfiniteQuery: () => query,
	useQueryClient: () => client,
}));
function element({
	children,
	component,
	...props
}: {
	children?: ReactNode;
	component?: string;
	[key: string]: unknown;
}) {
	return createElement(component ?? "div", props, children);
}
mock.module("@mantine/core", () => ({
	Box: element,
	Group: element,
	Stack: element,
	Text: element,
	Loader: element,
	Button: (props: Record<string, unknown>) => element({ ...props, component: "button" }),
	Menu: Object.assign(element, { Target: element, Dropdown: element, Divider: element }),
	Tooltip: ({ children }: { children: ReactNode }) => children,
	SegmentedControl: ({
		data,
		onChange,
	}: {
		data: Array<{ value: string; label: string }>;
		onChange: (value: string) => void;
	}) =>
		createElement(
			"div",
			null,
			data.map((item) =>
				createElement(
					"button",
					{
						type: "button",
						key: item.value,
						"data-mode": item.value,
						onClick: () => onChange(item.value),
					},
					item.label,
				),
			),
		),
}));
const { ContextCompositionView, ContextCompositionPanel, contextTokenShare, formatContextTokens } =
	await import("./ContextCompositionMenu");
let root: Root;
let container: HTMLElement;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const segments = [
	{ category: "user" as const, chars: 100 },
	{ category: "assistant" as const, chars: 200 },
	{ category: "user" as const, chars: 100 },
];
const data: ContextComposition = {
	generation: "g",
	segments,
	totals: groupContextSegments(segments),
	totalChars: 400,
	nextCursor: null,
	pending: false,
};
function snapshot(tokens = 160_000, totalChars = 400, generation = "g"): ContextUsageSnapshot {
	return {
		requestId: "request",
		startedAt: "2026-01-01",
		source: "upstream",
		percentage: (tokens / 1_000_000) * 100,
		contextWindow: 1_000_000,
		occupiedTokens: tokens,
		inputCharacters: { totalChars, systemChars: 0, toolsChars: 0 },
		composition: {
			generation,
			revision: "1",
			pageCount: 1,
			totalChars: data.totalChars,
			totals: data.totals,
		},
	};
}
beforeEach(() => {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = window.document.getElementById("root") as unknown as HTMLElement;
	root = createRoot(container);
	query = {
		data: { pages: [data] },
		isFetching: false,
		isError: false,
		refetch: () => {},
		fetchNextPage: () => {},
	};
	resets = 0;
});
afterEach(async () => {
	await act(() => root.unmount());
	for (const [key, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
});
async function render(
	value = data,
	onLoadMore?: () => void,
	usage = snapshot(160_000, value.totalChars),
) {
	await act(() =>
		root.render(
			createElement(ContextCompositionView, {
				data: { ...value, usage },
				snapshot: usage,
				onLoadMore,
			}),
		),
	);
}
function bar() {
	const node = container.querySelector('[data-testid="context-composition-bar"]');
	if (!node) throw new Error("Missing character bar");
	return node;
}

test("比例只按字符数，分类合并且顺序保留", async () => {
	await render();
	expect(bar().querySelectorAll("button").length).toBe(2);
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:50%");
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"~160K",
	);
	expect(container.textContent).not.toContain("contextComposition.characters");
	expect(container.textContent?.match(/~/g)?.length).toBe(1);
	await act(() => {
		(container.querySelector('[data-mode="sequence"]') as HTMLElement).click();
	});
	expect(bar().querySelectorAll("button").length).toBe(3);
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:25%");
	await act(() => {
		(bar().querySelector("button") as HTMLElement).click();
	});
	expect(container.querySelector('[role="status"]')?.textContent).toContain("40K · 25.0%");
});
test("旧数据0不会产生虚假区块或说明段落", async () => {
	await render(emptyContextComposition());
	expect(bar().querySelectorAll("button").length).toBe(0);
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"~160K",
	);
	expect(container.textContent).not.toContain("contextComposition.characters");
	for (const word of [
		"estimated",
		"estimateHint",
		"incomplete",
		"coverage",
		"remaining",
		"threshold",
		"tokens",
		"unknownWindow",
	])
		expect(container.textContent).not.toContain(word);
	expect(container.querySelector('[data-testid="context-composition-threshold"]')).toBeNull();
	expect(container.querySelector('[data-testid="context-composition-free"]')).toBeNull();
});
test("分页不改变完整分类汇总和百分比分母", async () => {
	let loads = 0;
	await render({ ...data, segments: [segments[0]], nextCursor: "g:1" }, () => {
		loads++;
	});
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:50%");
	await act(() => {
		(container.querySelector('[data-mode="sequence"]') as HTMLElement).click();
	});
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:25%");
	const more = container.querySelector('[data-testid="context-composition-more"]') as HTMLElement;
	expect(more.getAttribute("style")).toContain("width:75%");
	await act(() => more.click());
	expect(loads).toBe(1);
	expect(container.textContent).toContain("contextComposition.categories.assistant · 80K");
});
test("校准后的分页仅补齐已知分类，未知输入不成为加载更多区块", async () => {
	let loads = 0;
	const usage = snapshot(160_000, 4_000);
	const onLoadMore = () => loads++;
	await render({ ...data, segments: [segments[0]], nextCursor: "g:1" }, onLoadMore, usage);
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("8K · 5.0%");
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:5%");
	await act(() => {
		(container.querySelector('[data-mode="sequence"]') as HTMLElement).click();
	});
	expect(bar().querySelectorAll("button").length).toBe(2);
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("4K · 2.5%");
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:2.5%");
	const more = container.querySelector('[data-testid="context-composition-more"]') as HTMLElement;
	expect(more.getAttribute("style")).toContain("width:7.5%");
	await act(() => more.click());
	expect(loads).toBe(1);
	expect(container.textContent).toContain("contextComposition.categories.assistant · 8K · 5.0%");
	await render(data, onLoadMore, usage);
	expect(bar().querySelectorAll("button").length).toBe(3);
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:2.5%");
	expect(container.querySelector('[data-testid="context-composition-more"]')).toBeNull();
	expect(container.textContent).not.toContain("contextComposition.loadMore");
});
test("已知系统和工具只占完整输入的一部分，剩余背景留空不增加说明", async () => {
	const values = [
		{ category: "system" as const, chars: 80 },
		{ category: "toolDefinition" as const, chars: 20 },
	];
	const partial = {
		...data,
		totalChars: 100,
		segments: values,
		totals: groupContextSegments(values),
	};
	const usage: ContextUsageSnapshot = {
		...snapshot(),
		inputCharacters: { totalChars: 400, systemChars: 80, toolsChars: 20 },
		composition: {
			generation: "g",
			revision: "1",
			pageCount: 1,
			totalChars: partial.totalChars,
			totals: partial.totals,
		},
	};
	await render(partial, undefined, usage);
	const buttons = bar().querySelectorAll("button");
	expect(buttons.length).toBe(2);
	expect(buttons[0]?.getAttribute("aria-label")).toContain("system · 32K · 20.0%");
	expect(buttons[0]?.getAttribute("style")).toContain("width:20%");
	expect(buttons[1]?.getAttribute("aria-label")).toContain("toolDefinition · 8K · 5.0%");
	expect(buttons[1]?.getAttribute("style")).toContain("width:5%");
	expect(bar().getAttribute("style")).toContain("background:var(--mantine-color-default-hover)");
	expect(container.textContent).toContain("contextComposition.categories.system · 32K · 20.0%");
	expect(container.textContent).toContain(
		"contextComposition.categories.toolDefinition · 8K · 5.0%",
	);
	await act(() => {
		(buttons[0] as HTMLElement).click();
	});
	expect(container.querySelector('[role="status"]')?.textContent).toContain("32K · 20.0%");
	await act(() => {
		(container.querySelector('[data-mode="sequence"]') as HTMLElement).click();
	});
	expect(bar().querySelectorAll("button").length).toBe(2);
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:20%");
	expect(container.querySelector('[data-testid="context-composition-more"]')).toBeNull();
	expect(container.textContent?.match(/~/g)?.length).toBe(1);
	for (const word of [
		"loadMore",
		"characters",
		"incomplete",
		"coverage",
		"remaining",
		"estimateHint",
	])
		expect(container.textContent).not.toContain(word);
});
test("工具定义作为独立分类", async () => {
	const values = [
		{ category: "toolDefinition" as const, chars: 80 },
		{ category: "user" as const, chars: 20 },
	];
	await render({
		...data,
		totalChars: 100,
		segments: values,
		totals: groupContextSegments(values),
	});
	expect(container.textContent).toContain("contextComposition.categories.toolDefinition · 128K");
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("80.0%");
});
test("跨世代分页不会混合展示旧新缓存", async () => {
	query = { ...query, data: { pages: [data, { ...data, generation: "new" }] } };
	await act(() =>
		root.render(
			createElement(ContextCompositionPanel, {
				opened: true,
				narratorId: "test",
			}),
		),
	);
	expect(resets).toBe(1);
	expect(container.querySelector('[data-testid="context-composition-bar"]')).toBeNull();
});
test("加载失败只显示简短状态与重试", async () => {
	query = { isFetching: false, isError: true, refetch: () => {} };
	await act(() =>
		root.render(
			createElement(ContextCompositionPanel, {
				opened: true,
				narratorId: "test",
			}),
		),
	);
	expect(container.textContent).toContain("contextComposition.error");
	expect(container.textContent).toContain("contextComposition.retry");
	expect(container.querySelectorAll("p").length).toBe(0);
});

test("缓存换代后保留用户选择的顺序模式", async () => {
	const props = { opened: true, narratorId: "test" };
	await act(() => root.render(createElement(ContextCompositionPanel, props)));
	await act(() => {
		(container.querySelector('[data-mode="sequence"]') as HTMLElement).click();
	});
	expect(bar().querySelectorAll("button").length).toBe(3);
	query = { ...query, data: { pages: [data, { ...data, generation: "new" }] } };
	await act(() => root.render(createElement(ContextCompositionPanel, props)));
	query = { ...query, data: { pages: [{ ...data, generation: "new" }] } };
	await act(() => root.render(createElement(ContextCompositionPanel, props)));
	expect(bar().querySelectorAll("button").length).toBe(3);
});

test("完整字符分母校准，不将少量已缓存字符inflate为整桶", async () => {
	const usage = snapshot(926_000, 4_000);
	await act(() =>
		root.render(
			createElement(ContextCompositionView, { data: { ...data, usage }, snapshot: usage }),
		),
	);
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("46.3K · 5.0%");
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:5%");
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"~926K",
	);
	expect(container.textContent?.match(/~/g)?.length).toBe(1);
	const calibrated = {
		...usage,
		occupiedTokens: 510_800,
		percentage: 51.08,
		source: "usage" as const,
	};
	await act(() =>
		root.render(
			createElement(ContextCompositionView, { data: { ...data, usage }, snapshot: calibrated }),
		),
	);
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("25.5K · 5.0%");
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:5%");
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"~510.8K",
	);
});

test("刷新旧响应和跨世代不能校准新请求，估计有值不显示横杠", async () => {
	const old = snapshot();
	for (const live of [
		{ ...snapshot(926_000, 4_000), requestId: "new" },
		snapshot(926_000, 4_000, "new-generation"),
		{ ...snapshot(926_000, 4_000), inputCharacters: null },
		snapshot(926_000, 0),
	]) {
		await act(() =>
			root.render(
				createElement(ContextCompositionView, { data: { ...data, usage: old }, snapshot: live }),
			),
		);
		expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain(" · — · 50.0%");
		expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:50%");
		expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
			"~926K",
		);
	}
	const estimated = { ...snapshot(926_000), source: "estimate" as const };
	await act(() =>
		root.render(
			createElement(ContextCompositionView, {
				data: { ...data, usage: estimated },
				snapshot: estimated,
			}),
		),
	);
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"~926K",
	);
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("463K · 50.0%");
});

test("live有full chars但API尚无匹配usage时，不为旧条图跨请求校准", async () => {
	await act(() =>
		root.render(
			createElement(ContextCompositionView, { data, snapshot: snapshot(926_000, 4_000) }),
		),
	);
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain(" · — · 50.0%");
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"~926K",
	);
});

test("遗留缺完整字符分母不使用缓存总数回退", async () => {
	await act(() =>
		root.render(createElement(ContextCompositionView, { data, totalTokens: 160_000 })),
	);
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain(" · — · 50.0%");
});

test("用当前上游总量乘字符占比，并统一显示K/M/B", () => {
	expect(contextTokenShare(100, 400, 425_814)).toBe(106453.5);
	expect(formatContextTokens(contextTokenShare(100, 400, 425_814))).toBe("106.5K");
	expect(formatContextTokens(1_600_000)).toBe("1.6M");
	expect(formatContextTokens(2_500_000_000)).toBe("2.5B");
	expect(formatContextTokens(12)).toBe("12");
	expect(formatContextTokens(0)).toBe("0");
	expect(contextTokenShare(0, 0, 1_000)).toBe(0);
});
test("没有上游token时只显示横杠，不回退显示字符数", async () => {
	await act(() => root.render(createElement(ContextCompositionView, { data, totalTokens: null })));
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"—",
	);
	expect(container.textContent).not.toContain("contextComposition.characters");
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain(" · — · 50.0%");
	for (const invalid of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		expect(formatContextTokens(invalid)).toBe("—");
		expect(contextTokenShare(100, 400, invalid)).toBeNull();
	}
});
test("占用和完整字符分母动态更新时，已选分类同步更新且只显示一个波浪号", async () => {
	await render(data, undefined, snapshot(160_000, 4_000));
	await act(() => {
		(bar().querySelector("button") as HTMLElement).click();
	});
	expect(container.querySelector('[role="status"]')?.textContent).toContain("8K · 5.0%");
	await act(() =>
		root.render(
			createElement(ContextCompositionView, {
				data: { ...data, usage: snapshot(160_000, 4_000) },
				snapshot: snapshot(2_000_000, 4_000),
			}),
		),
	);
	expect(container.querySelector('[role="status"]')?.textContent).toContain("100K · 5.0%");
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:5%");
	await act(() =>
		root.render(
			createElement(ContextCompositionView, {
				data: { ...data, usage: snapshot(160_000, 4_000) },
				snapshot: snapshot(2_000_000, 8_000),
			}),
		),
	);
	expect(container.querySelector('[role="status"]')?.textContent).toContain("50K · 2.5%");
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("50K · 2.5%");
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:2.5%");
	expect(container.textContent).toContain("contextComposition.categories.assistant · 50K · 2.5%");
	expect(container.querySelector('[data-testid="context-composition-total"]')?.textContent).toBe(
		"~2M",
	);
	expect(container.textContent?.match(/~/g)?.length).toBe(1);
	for (const word of [
		"contextComposition.characters",
		"估算",
		"近似",
		"不准确",
		"estimated",
		"approximate",
	])
		expect(container.textContent).not.toContain(word);
});
