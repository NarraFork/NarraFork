import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	defaultScheduler,
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type SearchRequest } from "../lib/api";
import {
	SEARCH_OVERVIEW_LIMIT,
	SEARCH_PAGE_LIMIT,
	useSearchOverview,
	useSearchSection,
	useSessionHits,
} from "./useSearch";

let root: Root;
let client: QueryClient;
let sectionsSpy: ReturnType<typeof spyOn<typeof api, "searchSections">>;
let hitsSpy: ReturnType<typeof spyOn<typeof api, "searchSessionHits">>;
let overview: ReturnType<typeof useSearchOverview>;
let section: ReturnType<typeof useSearchSection>;
let hits: ReturnType<typeof useSessionHits>;
const originals = new Map<string, PropertyDescriptor | undefined>();
const notificationTimers = new Map<ReturnType<typeof setTimeout>, () => void>();

const emptyPage = { items: [], total: 0, totalIsLowerBound: false, nextCursor: null };

function Probe({
	request,
	expanded,
	page,
}: {
	request: SearchRequest;
	expanded: boolean;
	page: number;
}) {
	overview = useSearchOverview(request);
	section = useSearchSection(request, "sessions", page, true);
	hits = useSessionHits("n1", request, expanded);
	return null;
}

async function render(request: SearchRequest, expanded = false, page = 1) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Probe request={request} expanded={expanded} page={page} />
			</QueryClientProvider>,
		);
	});
}

/** Let resolved queries deliver their results, until `done` holds (or a short deadline). */
async function settle(done: () => boolean = () => false) {
	for (let i = 0; i < 20 && !done(); i++) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
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
	// Preserve real asynchronous delivery, but own its timers so teardown can drain
	// callbacks that still reference React before removing the window global.
	notifyManager.setScheduler((callback) => {
		const timer = setTimeout(() => {
			notificationTimers.delete(timer);
			callback();
		}, 0);
		notificationTimers.set(timer, callback);
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	sectionsSpy = spyOn(api, "searchSections").mockImplementation(async (request, sections) => ({
		sections: Object.fromEntries(
			sections.map((name) => [
				name,
				{
					...emptyPage,
					total: 45,
					nextCursor: request.cursor || request.page ? null : `${name}-page-2`,
				},
			]),
		),
	}));
	hitsSpy = spyOn(api, "searchSessionHits").mockResolvedValue({ hits: [], nextCursor: null });
	root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
	try {
		await act(async () => {
			root.unmount();
			await client.cancelQueries();
			client.clear();
			// One sleep(0) is not proof that all setTimeout notifications have run.
			while (notificationTimers.size) {
				for (const [timer, callback] of [...notificationTimers]) {
					clearTimeout(timer);
					notificationTimers.delete(timer);
					callback();
				}
				await Promise.resolve();
			}
		});
	} finally {
		for (const timer of notificationTimers.keys()) clearTimeout(timer);
		notificationTimers.clear();
		notifyManager.setScheduler(defaultScheduler);
		sectionsSpy.mockRestore();
		hitsSpy.mockRestore();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originals.clear();
	}
});

test("does not search for a blank query", async () => {
	await render({ q: "   " }, true);
	expect(sectionsSpy).not.toHaveBeenCalled();
	expect(hitsSpy).not.toHaveBeenCalled();
});

test("loads every section's first page for the overview, and one section's pages", async () => {
	await render({ q: "  kestrel  ", sort: "time" });
	await settle();
	expect(sectionsSpy).toHaveBeenCalledWith(
		{ q: "kestrel", sort: "time", limit: SEARCH_OVERVIEW_LIMIT },
		["sessions", "knowledge"],
		expect.any(AbortSignal),
	);
	expect(sectionsSpy).toHaveBeenCalledWith(
		{ q: "kestrel", sort: "time", page: 1, limit: SEARCH_PAGE_LIMIT },
		["sessions"],
		expect.any(AbortSignal),
	);
	expect(overview.data?.sections.sessions?.nextCursor).toBe("sessions-page-2");

	// Jumping to a page asks for it directly, keeping the shown page until it arrives.
	await render({ q: "kestrel", sort: "time" }, false, 3);
	expect(section.data?.total).toBe(45);
	await settle(() => section.isPlaceholderData === false);
	expect(sectionsSpy).toHaveBeenLastCalledWith(
		{ q: "kestrel", sort: "time", page: 3, limit: SEARCH_PAGE_LIMIT },
		["sessions"],
		expect.any(AbortSignal),
	);
	expect(section.isPlaceholderData).toBe(false);
});

test("caches each filter combination separately", async () => {
	await render({ q: "kestrel" });
	await render({ q: "kestrel", include: ["subagents"], projectId: "p1" });
	await settle();
	const keys = client
		.getQueryCache()
		.getAll()
		.filter((query) => query.queryKey[1] === "overview")
		.map((query) => query.queryKey[2]);
	expect(keys).toEqual(["q=kestrel", "q=kestrel&include=subagents&projectId=p1"]);
});

test("overview keeps the previous result while a new filter request is pending", async () => {
	await render({ q: "first" });
	await settle(() => overview.data !== undefined);
	const firstData = overview.data;
	expect(firstData).toBeDefined();

	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	sectionsSpy.mockImplementation(async (request, sectionNames) => {
		if (request.q === "second") await gate;
		return {
			sections: Object.fromEntries(
				sectionNames.map((name) => [
					name,
					{ ...emptyPage, total: request.q === "second" ? 99 : 45 },
				]),
			),
		};
	});

	await render({ q: "second" });
	expect(overview.data).toBe(firstData);
	expect(overview.isPlaceholderData).toBe(true);
	expect(overview.isLoading).toBe(false);

	release();
	await settle(() => overview.data?.sections.sessions?.total === 99);
	expect(overview.isPlaceholderData).toBe(false);
	expect(overview.data).not.toBe(firstData);
});

test("reads a session's further hits only once its card is expanded", async () => {
	await render({ q: "kestrel" });
	await settle();
	expect(hitsSpy).not.toHaveBeenCalled();
	await render({ q: "kestrel" }, true);
	await settle();
	expect(hitsSpy).toHaveBeenCalledWith(
		"n1",
		{ q: "kestrel", cursor: undefined, limit: 20 },
		expect.any(AbortSignal),
	);
	expect(hits.data?.pages).toEqual([{ hits: [], nextCursor: null }]);
});
