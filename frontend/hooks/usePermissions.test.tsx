import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";

const keys = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	localStorage: { getItem: () => null },
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../lib/api");
const { usePermissions } = await import("./usePermissions");
let root: Root;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;

function Probe({ id }: { id: string }) {
	usePermissions(id);
	return null;
}
async function render(ids: string[]) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				{ids.map((id) => (
					<Probe key={id} id={id} />
				))}
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
function pendingFetch() {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			(...[_input, options]: Parameters<typeof globalThis.fetch>) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = options?.signal;
					const abort = () => reject(signal?.reason);
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				}),
			{ preconnect: () => {} },
		),
	);
}
beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	container.remove();
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("unmount cancels the React Query signal all the way through the real API fetch", async () => {
	const fetch = pendingFetch();
	const read = spyOn(api, "getPendingPermissions");
	await render(["n1"]);
	expect(read).toHaveBeenCalledTimes(1);
	expect(fetch).toHaveBeenCalledTimes(1);
	const signal = read.mock.calls[0]?.[1];
	expect(signal).toBeInstanceOf(AbortSignal);
	expect(fetch.mock.calls[0]?.[0]).toBe("/api/narrators/n1/permissions");
	expect(fetch.mock.calls[0]?.[1]?.signal).toBe(signal);
	expect(signal?.aborted).toBe(false);
	await render([]);
	expect(signal?.aborted).toBe(true);
});

test("leaving one narrator preserves an independent narrator permission request", async () => {
	const fetch = pendingFetch();
	await render(["n1", "n2"]);
	expect(fetch).toHaveBeenCalledTimes(2);
	const first = fetch.mock.calls[0]?.[1]?.signal;
	const second = fetch.mock.calls[1]?.[1]?.signal;
	expect(first).toBeInstanceOf(AbortSignal);
	expect(second).toBeInstanceOf(AbortSignal);
	expect(first).not.toBe(second);
	await render(["n2"]);
	expect(first?.aborted).toBe(true);
	expect(second?.aborted).toBe(false);
	expect(fetch).toHaveBeenCalledTimes(2);
});

test("enabled permission reads preserve results and an empty narrator remains disabled", async () => {
	const permissions = [{ id: "permission", toolName: "Bash", inputJson: { command: "pwd" } }];
	const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(permissions));
	await render([""]);
	expect(fetch).not.toHaveBeenCalled();
	await render(["n1"]);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(client.getQueryData(["permissions", "n1"])).toEqual(permissions);
});
