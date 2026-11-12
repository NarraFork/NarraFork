import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: false,
});
const subscriptions = new Set<unknown>();
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: (filter: unknown) => {
			subscriptions.add(filter);
			return filter;
		},
		removeListener: (filter: unknown) => subscriptions.delete(filter),
	},
}));
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../lib/api");
const { useChatUnread } = await import("./useChat");
const { useSpecTasks } = await import("./useSpec");
const { useNarratorCurrentTask } = await import("./useTaskBoard");
const { useNugQuota } = await import("../components/narrator/model/use-nug-quota");
const providers = [{ id: "provider", prefix: "nug" }];
let root: Root;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
function Harness({ enabled }: { enabled?: boolean }) {
	useChatUnread(enabled);
	useSpecTasks("real-narrator", enabled);
	useNarratorCurrentTask("real-narrator", enabled);
	useNugQuota("nug:model", providers, enabled);
	return null;
}
async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
function render(enabled?: boolean) {
	root.render(
		<QueryClientProvider client={client}>
			<Harness enabled={enabled} />
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	spyOn(api, "getChatUnread").mockImplementation(() => new Promise<never>(() => {}));
	spyOn(api, "readSpecTasks").mockImplementation(() => new Promise<never>(() => {}));
	spyOn(api, "getNarratorCurrentTask").mockImplementation(() => new Promise<never>(() => {}));
	spyOn(api, "nugGetQuotas").mockImplementation(() => new Promise<never>(() => {}));
});
afterEach(async () => {
	root.unmount();
	client.clear();
	await flush();
	container.remove();
	mock.restore();
	subscriptions.clear();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
test("optional enabled defers companion GETs but never unbinds the real Spec WS subscription", async () => {
	render(false);
	await flush();
	expect(api.getChatUnread).not.toHaveBeenCalled();
	expect(api.readSpecTasks).not.toHaveBeenCalled();
	expect(api.getNarratorCurrentTask).not.toHaveBeenCalled();
	expect(api.nugGetQuotas).not.toHaveBeenCalled();
	expect([...subscriptions]).toContainEqual({
		narratorIds: ["real-narrator"],
		types: ["spec_changed"],
	});
	// The status bar's current task (the task source, outline P2 PR 5) subscribes at once too.
	expect([...subscriptions]).toContainEqual({
		narratorIds: ["real-narrator"],
		types: ["outline_tasks_changed", "spec_changed"],
	});
	const before = [...subscriptions];
	render(true);
	await flush();
	expect(api.getChatUnread).toHaveBeenCalledTimes(1);
	expect(api.readSpecTasks).toHaveBeenCalledTimes(1);
	expect(api.getNarratorCurrentTask).toHaveBeenCalledTimes(1);
	expect(api.nugGetQuotas).toHaveBeenCalledTimes(1);
	expect([...subscriptions]).toEqual(before);
});
test("existing callers retain immediate GETs when enabled is omitted", async () => {
	render();
	await flush();
	expect(api.getChatUnread).toHaveBeenCalledTimes(1);
	expect(api.readSpecTasks).toHaveBeenCalledTimes(1);
	expect(api.nugGetQuotas).toHaveBeenCalledTimes(1);
});
