import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const refetch = mock(() => Promise.resolve());
let overviewState: Record<string, unknown>;
const oldPage = {
	items: [{ type: "session", id: "old-result" }],
	total: 1,
	totalIsLowerBound: false,
	nextCursor: null,
};
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@mantine/core", () => ({
	Alert: box,
	Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
		<button type="button" onClick={onClick}>
			{children}
		</button>
	),
	Group: box,
	Loader: () => <div data-loader />,
	Mark: box,
	Pagination: box,
	SegmentedControl: box,
	Stack: box,
	Text: box,
	Title: box,
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: { component: ComponentType }) => ({
		options,
		useSearch: () => ({ q: "second" }),
		useNavigate: () => mock(),
	}),
}));
mock.module("../../frontend/components/search/EntityResultCard", () => ({
	EntityResultCard: ({ result }: { result: { id: string } }) => (
		<div data-result={result.id}>{result.id}</div>
	),
}));
mock.module("../../frontend/components/search/SessionResultCard", () => ({
	SessionResultCard: ({ result }: { result: { id: string } }) => (
		<div data-result={result.id}>{result.id}</div>
	),
}));
mock.module("../../frontend/components/search/SearchFilterBar", () => ({ SearchFilterBar: box }));
mock.module("../../frontend/hooks/useSearch", () => ({
	SEARCH_PAGE_LIMIT: 20,
	SEARCH_SECTION_ORDER: ["sessions", "knowledge"],
	useSearchOverview: () => overviewState,
	useSearchSection: () => ({}),
}));

const { Route } = await import("../../frontend/routes/search");
const Page = Route.options.component as ComponentType;
let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	refetch.mockClear();
	overviewState = {
		data: { sections: { sessions: oldPage } },
		isError: true,
		isLoading: false,
		isPlaceholderData: true,
		isRefetching: false,
		refetch,
	};
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});

test("a failed new overview query hides stale placeholder rows and offers retry", async () => {
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("operationFailed");
	expect(container.querySelector('[data-result="old-result"]')).toBeNull();

	const retry = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent === "retry",
	);
	await act(async () => retry?.dispatchEvent(new window.Event("click", { bubbles: true })));
	expect(refetch).toHaveBeenCalledTimes(1);

	overviewState = { ...overviewState, isError: false };
	await act(async () => root.render(<Page />));
	expect(container.querySelector('[data-result="old-result"]')).not.toBeNull();
	expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
});
