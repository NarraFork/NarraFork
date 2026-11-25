import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";

mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
const { useNamedNarratorSuggestions } = await import("./useNamedNarratorSuggestions");
const { setToken } = await import("../lib/api/client");

test("remote builds never fetch suggestions or revive cached normal-build rows", async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = new Map<string, string>();
	const fetch = mock(async () => Response.json({ items: [], nextCursor: null }));
	const originals = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		fetch,
		IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		},
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	setToken("remote-session");
	const client = new QueryClient();
	for (const q of ["", null])
		client.setQueryData(["named-narrator-suggestions", 1, q], {
			items: [{ id: "old", handle: "cached-normal-build", title: null, status: "idle" }],
			nextCursor: null,
		});
	const root = createRoot(document.createElement("div"));
	function Probe() {
		const result = useNamedNarratorSuggestions("", true);
		expect(result.data).toBeUndefined();
		return null;
	}
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Probe />
				</QueryClientProvider>,
			),
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 220));
		});
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
		client.clear();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
