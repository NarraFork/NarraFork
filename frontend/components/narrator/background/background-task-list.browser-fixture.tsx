import type { BackgroundTaskListPage } from "@shared/background-task-list";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { ListenerOptions, MessageCallback } from "../../../lib/narrator-ws-manager";
import {
	type BackgroundTaskListResult,
	backgroundTaskListQueryKey,
	useBackgroundTaskList,
} from "./useBackgroundTaskList";

// Only the WS transport is controlled. React, React Query, the hook and HTTP API
// client are production implementations, served on the test's ephemeral origin.
const listeners = new Map<number, { options: ListenerOptions; callback: MessageCallback }>();
const connections = new Set<(connected: boolean, isReconnect: boolean) => void>();
const subscriptions = new Set<number>();
let nextId = 0;
export const controlledWS = {
	subscribe() {
		const handle = { _id: ++nextId };
		subscriptions.add(handle._id);
		return handle;
	},
	unsubscribe(handle: { _id: number }) {
		subscriptions.delete(handle._id);
	},
	addListener(options: ListenerOptions, callback: MessageCallback) {
		const handle = { _id: ++nextId };
		listeners.set(handle._id, { options, callback });
		return handle;
	},
	removeListener(handle: { _id: number }) {
		listeners.delete(handle._id);
	},
	onConnectionChange(callback: (connected: boolean, isReconnect: boolean) => void) {
		connections.add(callback);
		return () => connections.delete(callback);
	},
};

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById("root") as HTMLElement);
let result: BackgroundTaskListResult;
let narratorId: string;
function Observer() {
	result = useBackgroundTaskList(narratorId, true);
	return <div data-loaded={!result.isLoading}>{result.tasks.length}</div>;
}

export function start(id: string) {
	narratorId = id;
	root.render(
		<QueryClientProvider client={queryClient}>
			<Observer />
		</QueryClientProvider>,
	);
}

export function emit(frame: Record<string, unknown>) {
	const data: Record<string, unknown> = { narratorId, ...frame };
	for (const { options, callback } of listeners.values()) {
		if (options.narratorIds !== "*" && !options.narratorIds?.includes(String(data.narratorId))) {
			continue;
		}
		if (options.types && !options.types.includes(String(data.type))) continue;
		callback(data);
	}
}

export function connection(connected: boolean, isReconnect = false) {
	for (const callback of connections) callback(connected, isReconnect);
}

export function snapshot() {
	const data = queryClient.getQueryData<InfiniteData<BackgroundTaskListPage>>(
		backgroundTaskListQueryKey(narratorId),
	);
	return {
		tasks: result?.tasks ?? [],
		activeCount: result?.activeCount,
		activeWorkCount: result?.activeWorkCount,
		activeServiceCount: result?.activeServiceCount,
		isLoading: result?.isLoading ?? true,
		isFetching: queryClient.isFetching(),
		pages: data?.pages.length ?? 0,
		version: data?.pages[0]?.version,
		listEpoch: data?.pages[0]?.listEpoch,
		listeners: [...listeners.values()].map(({ options }) => options.types),
		subscriptions: subscriptions.size,
		connections: connections.size,
	};
}

export function fetchNextPage() {
	result.fetchNextPage();
}
export function refresh() {
	result.refresh();
}
export function unmount() {
	root.unmount();
	queryClient.clear();
}
