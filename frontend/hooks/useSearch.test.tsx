import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import type { SearchSortMode } from "../lib/search-utils";
import { useSearch } from "./useSearch";

let root: Root;
let client: QueryClient;
let searchSpy: ReturnType<typeof spyOn<typeof api, "search">>;
let result: ReturnType<typeof useSearch>;
const originals = new Map<string, PropertyDescriptor | undefined>();
const entities = "chapters,messages,narrators,knowledge";

function Probe({ query, sort }: { query: string; sort?: SearchSortMode }) {
	result = useSearch(query, entities, sort);
	return null;
}

async function render(query: string, sort?: SearchSortMode) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Probe query={query} sort={sort} />
			</QueryClientProvider>,
		);
	});
}

beforeEach(() => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	searchSpy = spyOn(api, "search").mockResolvedValue({ results: [] });
	root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
		// Drain queued React Query notifications before restoring the DOM globals.
		await Bun.sleep(0);
	});
	client.clear();
	searchSpy.mockRestore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

for (const query of ["中", "中文", "a", "ab"]) {
	test(`automatically searches trimmed short query ${query}`, async () => {
		await render(`  ${query}  `);
		expect(searchSpy).toHaveBeenCalledWith(query, entities, "relevance", expect.any(AbortSignal));
		expect(result.isShortQuery).toBe(true);
	});
}

test("ignores whitespace-only input and debounces short terms for 300ms", async () => {
	await render("  ");
	expect(searchSpy).not.toHaveBeenCalled();
	await render("中");
	await render("中文");
	expect(searchSpy).not.toHaveBeenCalled();
	await act(async () => {
		await Bun.sleep(350);
	});
	expect(searchSpy).toHaveBeenCalledTimes(1);
	expect(searchSpy).toHaveBeenCalledWith("中文", entities, "relevance", expect.any(AbortSignal));
});

test("forwards sorting and separates cached candidates by sort", async () => {
	await render("query", "relevance");
	await render("query", "time");
	expect(searchSpy).toHaveBeenCalledWith("query", entities, "time", expect.any(AbortSignal));
	for (const sort of ["title", "type"] as const) {
		await render("query", sort);
		expect(searchSpy).toHaveBeenLastCalledWith(
			"query",
			entities,
			"relevance",
			expect.any(AbortSignal),
		);
	}
	const keys = client
		.getQueryCache()
		.getAll()
		.map((query) => query.queryKey);
	expect(keys).toEqual(
		["relevance", "time", "title", "type"].map((sort) => ["search", "query", entities, sort]),
	);
	await render("query", "time");
	expect(searchSpy).toHaveBeenCalledTimes(4);
});

test("changing sort aborts the previous pending search request", async () => {
	const signals: AbortSignal[] = [];
	searchSpy.mockImplementation(async (_query, _entities, _sort, signal) => {
		if (signal) signals.push(signal);
		return new Promise(() => {});
	});
	await render("PR", "time");
	expect(signals).toHaveLength(1);
	expect(signals[0].aborted).toBe(false);
	await render("PR", "relevance");
	expect(signals).toHaveLength(2);
	expect(signals[0].aborted).toBe(true);
	expect(signals[1].aborted).toBe(false);
});
