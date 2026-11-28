import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { chatKeys } from "../../hooks/useChat";
import { api } from "../../lib/api";
import type { ChatRoomSummary } from "../../lib/api/chat";
import { ApiError, getAuthSnapshot, setToken } from "../../lib/api/client";
import type { TreeMessage } from "../../lib/api/types";
import { NarratorPanelVisibilityProvider } from "../narrator/narrator-panel-visibility";
import {
	clearPretextDocumentCache,
	peekCachedPretextDocument,
	writeCachedPretextDocument,
} from "../narrator/vlist/pretext-document-cache";
import type { PretextDocumentInput } from "../narrator/vlist/pretext-document-loader";

const privateDocument: PretextDocumentInput = {
	messages: [{ id: "private-message", seq: 1 } as TreeMessage],
	messageVersion: 1,
	oldestLoadedSeq: 1,
	hasPrev: false,
};
let publishOnUnmount = false;
let publishedOnUnmount = 0;
let nextViewIdentity = 0;
const liveViews = new Set<number>();
mock.module("./ChatRoomView", () => ({
	ChatRoomView: (props: { roomId?: string; suspended?: boolean }) => {
		const [identity] = useState(() => ++nextViewIdentity);
		useEffect(() => {
			liveViews.add(identity);
			return () => {
				liveViews.delete(identity);
				if (publishOnUnmount && props.roomId) {
					publishedOnUnmount++;
					writeCachedPretextDocument({ narratorId: props.roomId, input: privateDocument });
				}
			};
		}, [identity, props.roomId]);
		return (
			<div
				data-room={props.roomId ?? "pending"}
				data-suspended={String(props.suspended)}
				data-view-identity={identity}
			>
				<input aria-label="local chat draft" defaultValue="" />
			</div>
		);
	},
}));
const { NarratorUserChatPanel } = await import("./NarratorUserChatPanel");
let root: Root;
let qc: QueryClient;
let container: HTMLElement;
let previous: Map<string, PropertyDescriptor | undefined>;
let resolver: ReturnType<typeof spyOn<typeof api, "getNarratorChatRoom">>;
const calls: {
	signal?: AbortSignal;
	finish: (room: ChatRoomSummary) => void;
	fail: (error: Error) => void;
}[] = [];

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const storage = new Map<string, string>();
	const globals = {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
			},
			removeItem: (key: string) => {
				storage.delete(key);
			},
		},
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		getComputedStyle: window.getComputedStyle,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	Object.assign(globalThis, globals);
	setToken("token-a");
	clearPretextDocumentCache();
	publishOnUnmount = false;
	publishedOnUnmount = 0;
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	calls.length = 0;
	nextViewIdentity = 0;
	liveViews.clear();
	resolver = spyOn(api, "getNarratorChatRoom").mockImplementation(
		(_id, signal) => new Promise((finish, fail) => calls.push({ signal, finish, fail })),
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	clearPretextDocumentCache();
	qc.clear();
	await flush();
	container.remove();
	resolver.mockRestore();
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function render(first: boolean, second?: boolean) {
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<QueryClientProvider client={qc}>
					<NarratorPanelVisibilityProvider value={first}>
						<NarratorUserChatPanel narratorId="n" />
					</NarratorPanelVisibilityProvider>
					{second !== undefined ? (
						<NarratorPanelVisibilityProvider value={second}>
							<NarratorUserChatPanel narratorId="n" />
						</NarratorPanelVisibilityProvider>
					) : null}
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
function cacheRoom(updatedAt = Date.now() - 31_000) {
	const room = { id: "cached-room" } as ChatRoomSummary;
	const key = [...chatKeys.narratorRoom("n"), getAuthSnapshot().generation];
	qc.setQueryData(key, room, { updatedAt });
	return { key, room };
}
function cachePrivateContent(roomId: string) {
	writeCachedPretextDocument({ narratorId: roomId, input: privateDocument });
	writeCachedPretextDocument({ narratorId: "other-room", input: privateDocument });
	const baseKey = chatKeys.messages(roomId);
	const scopedKey = [...baseKey, "window-a"];
	const otherKey = [...chatKeys.messages("other-room"), "window-b"];
	const mirror = { pages: [{ messages: [{ id: "private-message" }] }] };
	qc.setQueryData(baseKey, mirror);
	qc.setQueryData(scopedKey, mirror);
	qc.setQueryData(otherKey, mirror);
	return { baseKey, scopedKey, otherKey, mirror };
}
async function fail(index: number, status: number) {
	await act(async () => {
		// resolveNarratorRoom hides denied canRead behind the same wire 404 as a missing narrator.
		const notFound = {
			error: "Narrator not found: n",
			code: "NOT_FOUND",
			messageCode: "RESOURCE_NOT_FOUND",
			messageParams: { entity: "Narrator", id: "n" },
		};
		calls[index]?.fail(
			status === 404
				? new ApiError(notFound.error, status, notFound)
				: new ApiError(`resolver ${status}`, status),
		);
	});
	await flush();
}

test("never-visible chat does not resolve; hiding aborts and a late resolver cannot remount the room", async () => {
	await render(false);
	expect(calls).toHaveLength(0);
	await render(true);
	expect(calls).toHaveLength(1);
	await render(false);
	expect(calls[0]?.signal?.aborted).toBe(true);
	await act(async () => {
		calls[0]?.finish({ id: "late-room" } as ChatRoomSummary);
	});
	expect(container.querySelector("[data-room]")?.getAttribute("data-room")).toBe("pending");
	await render(true);
	expect(calls).toHaveLength(2);
});

test("one hidden reader cannot abort another visible reader's shared resolver", async () => {
	await render(true, true);
	expect(calls).toHaveLength(1);
	await render(false, true);
	expect(calls[0]?.signal?.aborted).toBe(false);
	await render(false, false);
	expect(calls[0]?.signal?.aborted).toBe(true);
});

test("a stale cached room survives resolver 503 and retry with the same view identity and local state", async () => {
	const { key, room } = cacheRoom();
	const content = cachePrivateContent(room.id);
	await render(true);
	expect(calls).toHaveLength(1);
	const view = container.querySelector('[data-room="cached-room"]');
	const input = view?.querySelector("input") as HTMLInputElement;
	input.value = "unsent draft / reply / uploads";
	const identity = view?.getAttribute("data-view-identity");
	expect(liveViews.size).toBe(1);
	await fail(0, 503);
	expect(qc.getQueryData(key)).toBe(room);
	expect(peekCachedPretextDocument(room.id)).toBe(privateDocument);
	expect(qc.getQueryData(content.baseKey)).toBe(content.mirror);
	expect(qc.getQueryData(content.scopedKey)).toBe(content.mirror);
	expect(container.querySelector('[data-room="cached-room"]')).toBe(view);
	expect(container.querySelector('[role="status"]')?.textContent).toContain("resolver 503");
	expect(input.value).toBe("unsent draft / reply / uploads");
	expect(liveViews.size).toBe(1);
	await act(async () => {
		container.querySelector<HTMLButtonElement>('[role="status"] button')?.click();
	});
	expect(calls).toHaveLength(2);
	expect(container.querySelector('[data-room="cached-room"]')).toBe(view);
	await act(async () => {
		calls[1]?.finish({ ...room });
	});
	await flush();
	expect(container.querySelector('[role="status"]')).toBeNull();
	expect(
		container.querySelector('[data-room="cached-room"]')?.getAttribute("data-view-identity"),
	).toBe(identity);
	expect(container.querySelector("input")).toBe(input);
	expect(input.value).toBe("unsent draft / reply / uploads");
});

test.each([
	401, 403, 404,
])("resolver %i unmounts private content and a later 503 cannot resurrect it", async (status) => {
	const { room } = cacheRoom();
	const content = cachePrivateContent(room.id);
	publishOnUnmount = true;
	await render(true);
	expect(peekCachedPretextDocument(room.id)).toBe(privateDocument);
	const identity = container.querySelector("[data-room]")?.getAttribute("data-view-identity");
	expect(liveViews.size).toBe(1);
	await fail(0, status);
	expect(publishedOnUnmount).toBe(1);
	expect(peekCachedPretextDocument(room.id)).toBeNull();
	expect(qc.getQueriesData({ queryKey: chatKeys.messages(room.id) })).toEqual([]);
	expect(peekCachedPretextDocument("other-room")).toBe(privateDocument);
	expect(qc.getQueryData(content.otherKey)).toBe(content.mirror);
	expect(container.querySelector('[data-room="cached-room"]')).toBeNull();
	expect(liveViews.size).toBe(0);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		status === 404 ? "Narrator not found: n" : `resolver ${status}`,
	);
	await act(async () => {
		container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
	});
	await fail(1, 503);
	expect(peekCachedPretextDocument(room.id)).toBeNull();
	expect(qc.getQueriesData({ queryKey: chatKeys.messages(room.id) })).toEqual([]);
	expect(container.querySelector('[data-room="cached-room"]')).toBeNull();
	expect(liveViews.size).toBe(0);
	await act(async () => {
		container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
	});
	await act(async () => {
		calls[2]?.finish({ ...room });
	});
	await flush();
	expect(liveViews.size).toBe(1);
	expect(
		container.querySelector('[data-room="cached-room"]')?.getAttribute("data-view-identity"),
	).not.toBe(identity);
});

test("returning to the same token cannot reuse an older generation's cached room", async () => {
	const { key } = cacheRoom(Date.now());
	const initialGeneration = getAuthSnapshot().generation;
	await render(true);
	expect(calls).toHaveLength(0);
	expect(container.querySelector('[data-room="cached-room"]')).not.toBeNull();
	await act(async () => {
		setToken("token-b");
		setToken("token-a");
	});
	expect(getAuthSnapshot().generation).toBeGreaterThan(initialGeneration);
	expect(key).toEqual(["chat", "narrator-room", "n", initialGeneration]);
	expect(calls).toHaveLength(1);
	expect(container.querySelector('[data-room="cached-room"]')).toBeNull();
	await fail(0, 503);
	expect(container.querySelector('[data-room="cached-room"]')).toBeNull();
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("resolver 503");
});
