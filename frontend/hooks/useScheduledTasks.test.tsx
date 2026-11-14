import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SchedulePreview } from "@frontend/lib/api/scheduled-tasks";
import type { TaskSchedule } from "@shared/scheduled-task-schedule";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const previews: Array<{
	input: { schedule: TaskSchedule };
	signal: AbortSignal;
	resolve: (value: SchedulePreview) => void;
}> = [];
let listCalls = 0;
let changed: (() => void) | undefined;
let connected: ((value: boolean) => void) | undefined;
let subscribers = 0;
let unsubscribers = 0;
mock.module("../lib/api/scheduled-tasks", () => ({
	scheduledTasksApi: {
		previewScheduledTask: (input: { schedule: TaskSchedule }, signal: AbortSignal) =>
			new Promise<SchedulePreview>((resolve) => previews.push({ input, signal, resolve })),
		listScheduledTasks: async () => {
			listCalls++;
			return [];
		},
	},
}));
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: (_filter: unknown, callback: () => void) => {
			changed = callback;
			subscribers++;
			return "subscription";
		},
		removeListener: () => {
			unsubscribers++;
		},
		onConnectionChange: (callback: (value: boolean) => void) => {
			connected = callback;
			return () => {};
		},
	},
}));
const { useSchedulePreview, useScheduledTasks } = await import("./useScheduledTasks");
let root: Root | null = null;
let container: HTMLElement;
let client: QueryClient;
let latest: ReturnType<typeof useSchedulePreview> | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
beforeEach(() => {
	previews.length = 0;
	listCalls = 0;
	changed = undefined;
	connected = undefined;
	subscribers = 0;
	unsubscribers = 0;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	install("window", window);
	install("document", window.document);
	install("navigator", window.navigator);
	install("HTMLElement", window.HTMLElement);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = window.document.createElement("div") as unknown as HTMLElement;
	window.document.body.appendChild(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	client.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => mock.restore());
async function settle(ms = 15) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}
function Preview({ day }: { day: string }) {
	latest = useSchedulePreview({ kind: "at", times: [day] }, "UTC");
	return <span>{latest.data?.occurrences.join(",")}</span>;
}
async function renderPreview(day: string) {
	root ??= createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<Preview day={day} />
			</QueryClientProvider>,
		),
	);
}
function Lists() {
	useScheduledTasks();
	useScheduledTasks({ lifecycle: "all" });
	return null;
}

describe("schedule query synchronization", () => {
	test("preview immediately aborts obsolete requests and only fetches the stable input", async () => {
		await renderPreview("2027-01-01T09:00");
		expect(previews).toHaveLength(1);
		await renderPreview("2027-01-02T09:00");
		expect(previews[0].signal.aborted).toBe(true);
		expect(previews).toHaveLength(1);
		await renderPreview("2027-01-03T09:00");
		expect(latest?.debouncing).toBe(true);
		await settle(400);
		expect(previews).toHaveLength(2);
		expect(previews[1].input.schedule).toEqual({ kind: "at", times: ["2027-01-03T09:00"] });
		const response: SchedulePreview = {
			occurrences: ["2027-01-03T09:00:00Z"],
			finite: true,
			total: 1,
			remaining: 1,
			endsAt: "2027-01-03T09:00:00Z",
			exhausted: false,
		};
		await act(async () => {
			previews[1].resolve(response);
			previews[0].resolve({ ...response, occurrences: ["obsolete"] });
		});
		await settle();
		expect(container.textContent).toBe("2027-01-03T09:00:00Z");
	});
	test("multiple consumers share one subscription; changes and reconnect invalidate lists", async () => {
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<QueryClientProvider client={client}>
					<Lists />
				</QueryClientProvider>,
			),
		);
		await settle();
		expect(subscribers).toBe(1);
		expect(listCalls).toBe(2);
		await act(async () => {
			changed?.();
			changed?.();
		});
		await settle();
		expect(listCalls).toBe(4);
		await act(async () => connected?.(true));
		await settle();
		expect(listCalls).toBe(6);
		await act(async () => root?.unmount());
		root = null;
		expect(unsubscribers).toBe(1);
	});
});
