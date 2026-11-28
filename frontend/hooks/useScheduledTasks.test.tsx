import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ScheduledTaskTarget, SchedulePreview } from "@frontend/lib/api/scheduled-tasks";
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
const targetCalls: Array<{ q?: string; cursor?: string | null; signal: AbortSignal }> = [];
let targetRows: ScheduledTaskTarget[] = [];
let targetFailure = false;
let targetStalled = false;
const associationCalls: Array<{ narratorId: string; cursor?: string | null }> = [];
let changed: ((event: { type: string }) => void) | undefined;
let connected: ((value: boolean) => void) | undefined;
let subscribers = 0;
let unsubscribers = 0;
mock.module("../lib/api/scheduled-tasks", () => ({
	scheduledTasksApi: {
		listScheduledTaskTargets: async (
			input: { q?: string; cursor?: string | null },
			signal: AbortSignal,
		) => {
			targetCalls.push({ ...input, signal });
			if (targetFailure) throw new Error("Target access lost");
			if (targetStalled) return new Promise<never>(() => {});
			return { items: targetRows, nextCursor: input.cursor ? null : "next-target" };
		},
		listScheduledTaskAssociations: async (
			narratorId: string,
			input: { cursor?: string | null },
		) => {
			associationCalls.push({ narratorId, ...input });
			return { tasks: [], nextCursor: input.cursor ? null : "next-association" };
		},
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
		addListener: (_filter: unknown, callback: (event: { type: string }) => void) => {
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
const {
	useSchedulePreview,
	useScheduledTasks,
	useScheduledTaskTargets,
	useScheduledTaskAssociations,
} = await import("./useScheduledTasks");
let latestTargets: ReturnType<typeof useScheduledTaskTargets>;
let latestAssociations: ReturnType<typeof useScheduledTaskAssociations>;
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
	targetCalls.length = 0;
	associationCalls.length = 0;
	targetRows = [];
	targetFailure = false;
	targetStalled = false;
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

function Targets({ search, narratorId = "narrator_1" }: { search: string; narratorId?: string }) {
	latestTargets = useScheduledTaskTargets(search);
	latestAssociations = useScheduledTaskAssociations(narratorId);
	return (
		<span>
			{latestTargets.isSuccess
				? latestTargets.data.pages
						.flatMap((page) => page.items)
						.map((item) => item.title)
						.join(",")
				: ""}
		</span>
	);
}
async function renderTargets(search: string, narratorId = "narrator_1") {
	root ??= createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<Targets search={search} narratorId={narratorId} />
			</QueryClientProvider>,
		),
	);
}

describe("schedule query synchronization", () => {
	test("target search cancels obsolete requests and both projections paginate by cursor", async () => {
		targetStalled = true;
		await renderTargets("first");
		expect(targetCalls).toHaveLength(1);
		await renderTargets("second");
		expect(targetCalls[0].signal.aborted).toBe(true);
		expect(targetCalls).toHaveLength(1);
		targetStalled = false;
		await settle(300);
		expect(targetCalls.at(-1)?.q).toBe("second");
		await act(async () => {
			await latestTargets.fetchNextPage();
			await latestAssociations.fetchNextPage();
		});
		expect(targetCalls.at(-1)?.cursor).toBe("next-target");
		expect(associationCalls.at(-1)).toMatchObject({
			narratorId: "narrator_1",
			cursor: "next-association",
		});
		await renderTargets("second", "narrator_2");
		expect(associationCalls.at(-1)).toMatchObject({ narratorId: "narrator_2", cursor: null });
	});
	test("access changes clear private target labels immediately, including during a failed reload", async () => {
		targetRows = [
			{
				id: "private_1",
				title: "Private session title",
				cwd: null,
				projectId: null,
				model: null,
				status: "idle",
			},
		];
		await renderTargets("");
		await settle();
		expect(container.textContent).toBe("Private session title");
		targetStalled = true;
		await act(async () => changed?.({ type: "narrator_access_changed" }));
		await settle();
		expect(container.textContent).toBe("");
		expect(latestTargets.data).toBeUndefined();
		targetStalled = false;
		targetFailure = true;
		await act(async () => {
			void latestTargets.refetch({ cancelRefetch: true });
		});
		await act(async () => changed?.({ type: "project_access_changed" }));
		await settle();
		expect(latestTargets.isError).toBe(true);
		expect(container.textContent).toBe("");
	});
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
			changed?.({ type: "scheduled_tasks_changed" });
			changed?.({ type: "scheduled_tasks_changed" });
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
