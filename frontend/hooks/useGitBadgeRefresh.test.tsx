import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

// Query's browser timer policy is decided at module load. Install the DOM before
// importing the real QueryClient/hooks so these tests exercise actual listeners.
const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = globalKeys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: false,
});

type ConnectionCallback = (connected: boolean, isReconnect: boolean) => void;
const connectionCallbacks: ConnectionCallback[] = [];
mock.module("./useNarrator", () => ({ useNarrator: () => ({ data: undefined }) }));
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: () => ({}),
		removeListener: () => {},
		onConnectionChange: (cb: ConnectionCallback) => {
			connectionCallbacks.push(cb);
			return () => {
				const index = connectionCallbacks.indexOf(cb);
				if (index >= 0) connectionCallbacks.splice(index, 1);
			};
		},
	},
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { useGitBadgeRefresh } = await import("./useGit");

let root: Root | undefined;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;

function Probe() {
	useGitBadgeRefresh();
	return null;
}
async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount() {
	root = createRoot(container);
	root.render(
		<QueryClientProvider client={client}>
			<Probe />
		</QueryClientProvider>,
	);
	await flush();
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(async () => {
	root?.unmount();
	root = undefined;
	client.clear();
	// React schedules passive unmount work; drain it before restoring spies.
	await flush();
	container.remove();
	connectionCallbacks.length = 0;
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

const GIT_KEYS = [["gitStatus"], ["chapterGitStatus"]];

describe("useGitBadgeRefresh", () => {
	test("invalidates the badge queries when the window regains focus", async () => {
		const invalidate = spyOn(client, "invalidateQueries");
		await mount();
		expect(invalidate).not.toHaveBeenCalled();
		window.dispatchEvent(new window.Event("focus"));
		await flush();
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toEqual(GIT_KEYS);
	});

	test("throttles the focus/visibilitychange pair of a single return gesture", async () => {
		const invalidate = spyOn(client, "invalidateQueries");
		await mount();
		window.dispatchEvent(new window.Event("focus"));
		document.dispatchEvent(new window.Event("visibilitychange"));
		window.dispatchEvent(new window.Event("focus"));
		await flush();
		expect(invalidate).toHaveBeenCalledTimes(2); // one refresh = two prefixes
	});

	test("invalidates on WS reconnect, not on the first connect or on disconnect", async () => {
		const invalidate = spyOn(client, "invalidateQueries");
		await mount();
		expect(connectionCallbacks.length).toBe(1);
		connectionCallbacks[0]?.(true, false);
		connectionCallbacks[0]?.(false, false);
		await flush();
		expect(invalidate).not.toHaveBeenCalled();
		connectionCallbacks[0]?.(true, true);
		await flush();
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toEqual(GIT_KEYS);
	});

	test("stops listening after unmount", async () => {
		const invalidate = spyOn(client, "invalidateQueries");
		await mount();
		root?.unmount();
		root = undefined;
		await flush();
		expect(connectionCallbacks.length).toBe(0);
		window.dispatchEvent(new window.Event("focus"));
		await flush();
		expect(invalidate).not.toHaveBeenCalled();
	});
});
