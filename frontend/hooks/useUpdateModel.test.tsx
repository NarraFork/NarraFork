import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import type { NarratorDetail } from "../lib/api/narrators";
import { useUpdateModel } from "./useNarrator";

const key = ["narrators", "model-test"] as const;
const original: NarratorDetail = {
	id: "model-test",
	model: "auto:old",
	title: "Keep the rest of the detail",
	runtimeModel: { provider: "old-source", model: "old-source:old" },
	modelInheritance: { model: "old-source:old" },
};
const nextModel = "auto:new";
let client: QueryClient;
let container: HTMLDivElement;
let root: Root;
let mutation: ReturnType<typeof useUpdateModel>;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

function Probe() {
	const { data } = useQuery({
		queryKey: key,
		queryFn: ({ signal }) => api.getNarrator("model-test", signal),
		staleTime: Infinity,
	});
	mutation = useUpdateModel();
	return <output>{data?.model}</output>;
}

async function mount() {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		);
	});
	await act(flush);
}

// React Query batches observer notifications on the next task, not a network delay.
async function flush() {
	// A query completion can schedule another observer notification in the first task.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [name, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	client.setQueryData(key, original);
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	spyOn(notifications, "hide").mockImplementation(() => "hidden");
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
		await client.cancelQueries();
		client.clear();
		await flush();
	});
	mock.restore();
	container.remove();
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	descriptors.clear();
});

test("saved model is visible before a delayed detail refresh, without stale model snapshots", async () => {
	const save = Promise.withResolvers<{ ok: boolean }>();
	const refresh = Promise.withResolvers<NarratorDetail>();
	const update = spyOn(api, "updateNarratorModel").mockReturnValue(save.promise);
	const get = spyOn(api, "getNarrator").mockReturnValue(refresh.promise);
	const other = { ...original, id: "other" };
	client.setQueryData(["narrators", "other"], other);
	await mount();
	let pending!: Promise<unknown>;
	await act(async () => {
		pending = mutation.mutateAsync({ id: "model-test", model: nextModel });
		await flush();
	});
	expect(container.textContent).toBe(original.model);
	expect(get).not.toHaveBeenCalled();
	await act(async () => {
		save.resolve({ ok: true });
		await pending;
		await flush();
	});
	expect(update).toHaveBeenCalledWith("model-test", nextModel);
	expect(get).toHaveBeenCalledTimes(1);
	// The GET is still pending: the successful PATCH is enough to display the selection.
	expect(container.textContent).toBe(nextModel);
	expect(client.getQueryData(key)).toMatchObject({ model: nextModel, title: original.title });
	expect(client.getQueryData<NarratorDetail>(key)?.runtimeModel).toBeUndefined();
	expect(client.getQueryData<NarratorDetail>(key)?.modelInheritance).toBeUndefined();
	expect(client.getQueryData(["narrators", "other"])).toBe(other);
	expect(notifications.hide).toHaveBeenCalledWith("model-unavailable-model-test");
	const authoritative = {
		...original,
		model: nextModel,
		runtimeModel: undefined,
		modelInheritance: undefined,
		title: "Refreshed title",
	};
	await act(async () => {
		refresh.resolve(authoritative);
		await flush();
	});
	expect(client.getQueryData(key)).toEqual(authoritative);
});

test("failed save leaves the model and its derived detail unchanged", async () => {
	const failure = new Error("model selection rejected");
	spyOn(api, "updateNarratorModel").mockRejectedValue(failure);
	const get = spyOn(api, "getNarrator").mockResolvedValue(original);
	await mount();
	await act(async () => {
		await expect(mutation.mutateAsync({ id: "model-test", model: nextModel })).rejects.toBe(
			failure,
		);
		await flush();
	});
	expect(container.textContent).toBe(original.model);
	expect(client.getQueryData(key)).toBe(original);
	expect(get).not.toHaveBeenCalled();
	expect(notifications.hide).not.toHaveBeenCalled();
});
