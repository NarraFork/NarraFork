import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	defaultScheduler,
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { chatKeys } from "../../hooks/useChat";
import { type ChatMessage, chatApi } from "../../lib/api/chat";

mock.module("../../hooks/useAuth", () => ({ useCurrentUser: () => ({ data: null }) }));
mock.module("../../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		allocateId: () => "handle",
		joinChatRoom() {},
		leaveChatRoom() {},
		addListener: () => "listener",
		removeListener() {},
		onConnectionChange: () => () => {},
	},
}));
mock.module("./ChatMessageList", () => ({
	ChatMessageList: ({
		onToggleSelect,
	}: {
		onToggleSelect: (id: string, opts: { shiftKey: boolean }) => void;
	}) => (
		<button type="button" onClick={() => onToggleSelect("message", { shiftKey: false })}>
			Select message
		</button>
	),
}));
const { ChatRoomView } = await import("./ChatRoomView");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { chat: {} } }, react: { useSuspense: false } });
let root: Root;
let qc: QueryClient;
let container: HTMLElement;
let previous: Map<string, PropertyDescriptor | undefined>;
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
let listMessages: ReturnType<typeof spyOn<typeof chatApi, "listChatMessages">>;
const forward = mock((_text: string) => {});

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		getComputedStyle: window.getComputedStyle,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	Object.assign(globalThis, globals);
	notifyManager.setScheduler((callback) => callback());
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	errors = spyOn(console, "error").mockImplementation(() => {});
	listMessages = spyOn(chatApi, "listChatMessages").mockRejectedValue(
		new Error("vlist owns fetching"),
	);
	forward.mockClear();
});
afterEach(() => {
	act(() => root.unmount());
	qc.clear();
	container.remove();
	errors.mockRestore();
	listMessages.mockRestore();
	notifyManager.setScheduler(defaultScheduler);
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function render(roomId: string | undefined) {
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={i18n}>
					<QueryClientProvider client={qc}>
						<ChatRoomView
							roomId={roomId}
							onForwardToNarrator={forward}
							renderComposer={() => <div />}
						/>
					</QueryClientProvider>
				</I18nextProvider>
			</MantineProvider>,
		),
	);
}
function missingQueryFunctions() {
	return errors.mock.calls.filter((args) => String(args[0]).includes("No queryFn"));
}
test("empty room cache subscribes silently without fetching, even after invalidation", async () => {
	await render("room");
	await act(async () => {
		await qc.invalidateQueries({ queryKey: chatKeys.messages("room") });
	});
	expect(missingQueryFunctions()).toEqual([]);
	expect(listMessages).not.toHaveBeenCalled();
	expect(qc.getQueryData(chatKeys.messages("room"))).toBeUndefined();
});
test("absent room stays passive and silent", async () => {
	await render(undefined);
	expect(missingQueryFunctions()).toEqual([]);
	expect(listMessages).not.toHaveBeenCalled();
});
test("cache writes update selection actions without a competing fetch", async () => {
	await render("room");
	const message = {
		id: "message",
		seq: 1,
		contentText: "Cached text",
		sender: { username: "Alice" },
		attachments: [],
	} as unknown as ChatMessage;
	await act(async () => {
		qc.setQueryData(chatKeys.messages("room"), {
			pages: [{ messages: [message] }],
			pageParams: [undefined],
		});
	});
	await act(async () => {
		container.querySelector("button")?.click();
	});
	const send = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("sendToNarrator"),
	);
	expect(send).toBeDefined();
	await act(async () => {
		send?.click();
	});
	expect(forward).toHaveBeenCalledTimes(1);
	expect(forward.mock.calls[0]?.[0]).toContain("Cached text");
	expect(missingQueryFunctions()).toEqual([]);
	expect(listMessages).not.toHaveBeenCalled();
});
