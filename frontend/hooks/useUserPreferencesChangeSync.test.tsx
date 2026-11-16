import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = globalKeys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const listeners: Array<{ opts: { types: string[] }; cb: () => void }> = [];
const connections: Array<(connected: boolean, isReconnect: boolean) => void> = [];
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: (opts: { types: string[] }, cb: () => void) => {
			const handle = { opts, cb };
			listeners.push(handle);
			return handle;
		},
		removeListener: (handle: (typeof listeners)[number]) => {
			listeners.splice(listeners.indexOf(handle), 1);
		},
		onConnectionChange: (cb: (typeof connections)[number]) => {
			connections.push(cb);
			return () => connections.splice(connections.indexOf(cb), 1);
		},
	},
}));
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { useUserPreferencesChangeSync } = await import("./useUserPreferencesChangeSync");

let root: Root | undefined;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
function Probe() {
	useUserPreferencesChangeSync();
	return null;
}
async function mount() {
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		);
	});
}
beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	client.clear();
	container.remove();
	listeners.length = 0;
	connections.length = 0;
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("invalidates only preferences on the account's data-free WS hint", async () => {
	const invalidate = spyOn(client, "invalidateQueries");
	await mount();
	expect(listeners.map(({ opts }) => opts)).toEqual([{ types: ["user_preferences_changed"] }]);
	expect(invalidate).not.toHaveBeenCalled();
	listeners[0]?.cb();
	expect(invalidate).toHaveBeenCalledWith({ queryKey: ["user-preferences"] });
});

test("recovers missed changes on reconnect and removes both listeners on unmount", async () => {
	const invalidate = spyOn(client, "invalidateQueries");
	await mount();
	connections[0]?.(true, false);
	connections[0]?.(false, true);
	expect(invalidate).not.toHaveBeenCalled();
	connections[0]?.(true, true);
	expect(invalidate).toHaveBeenCalledTimes(1);
	await act(async () => root?.unmount());
	root = undefined;
	expect(listeners).toHaveLength(0);
	expect(connections).toHaveLength(0);
});
