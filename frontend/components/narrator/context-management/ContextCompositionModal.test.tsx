import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	type ContextComposition,
	emptyContextComposition,
	groupContextSegments,
} from "@shared/context-composition";
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
	Modal: ({ opened, children }: { opened: boolean; children: ReactNode }) =>
		opened ? children : null,
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
const { ContextCompositionView, ContextCompositionModal } = await import(
	"./ContextCompositionModal"
);
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
async function render(value = data, onLoadMore?: () => void) {
	await act(() => root.render(createElement(ContextCompositionView, { data: value, onLoadMore })));
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
	expect(container.textContent).toContain("400 contextComposition.characters");
	await act(() => {
		(container.querySelector('[data-mode="sequence"]') as HTMLElement).click();
	});
	expect(bar().querySelectorAll("button").length).toBe(3);
	expect(bar().querySelector("button")?.getAttribute("style")).toContain("width:25%");
	await act(() => {
		(bar().querySelector("button") as HTMLElement).click();
	});
	expect(container.querySelector('[role="status"]')?.textContent).toContain(
		"100 contextComposition.characters · 25.0%",
	);
});
test("旧数据0不会产生虚假区块或说明段落", async () => {
	await render(emptyContextComposition());
	expect(bar().querySelectorAll("button").length).toBe(0);
	expect(container.textContent).toContain("0 contextComposition.characters");
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
	expect(container.textContent).toContain("contextComposition.categories.assistant · 200");
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
	expect(container.textContent).toContain("contextComposition.categories.toolDefinition · 80");
	expect(bar().querySelector("button")?.getAttribute("aria-label")).toContain("80.0%");
});
test("跨世代分页不会混合展示旧新缓存", async () => {
	query = { ...query, data: { pages: [data, { ...data, generation: "new" }] } };
	await act(() =>
		root.render(
			createElement(ContextCompositionModal, {
				opened: true,
				onClose: () => {},
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
			createElement(ContextCompositionModal, {
				opened: true,
				onClose: () => {},
				narratorId: "test",
			}),
		),
	);
	expect(container.textContent).toContain("contextComposition.error");
	expect(container.textContent).toContain("contextComposition.retry");
	expect(container.querySelectorAll("p").length).toBe(0);
});

test("缓存换代后保留用户选择的顺序模式", async () => {
	const props = { opened: true, onClose: () => {}, narratorId: "test" };
	await act(() => root.render(createElement(ContextCompositionModal, props)));
	await act(() => {
		(container.querySelector('[data-mode="sequence"]') as HTMLElement).click();
	});
	expect(bar().querySelectorAll("button").length).toBe(3);
	query = { ...query, data: { pages: [data, { ...data, generation: "new" }] } };
	await act(() => root.render(createElement(ContextCompositionModal, props)));
	query = { ...query, data: { pages: [{ ...data, generation: "new" }] } };
	await act(() => root.render(createElement(ContextCompositionModal, props)));
	expect(bar().querySelectorAll("button").length).toBe(3);
});
