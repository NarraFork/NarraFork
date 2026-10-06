import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { chatKeys } from "../../hooks/useChat";
import type { ChatMessage, ChatMessagePage } from "../../lib/api/chat";
import { chatApi } from "../../lib/api/chat";
import type { TreeMessage } from "../../lib/api/types";
import type { VListDataSource } from "../narrator/vlist/vlist-data-source";

let source: VListDataSource | undefined;
let listener: ((event: Record<string, unknown>) => void) | undefined;
const download = mock(async () => true);
mock.module("./chat-attachment-download", () => ({ downloadChatAttachment: download }));
mock.module("../../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		allocateId: () => "handle",
		joinChatRoom() {},
		leaveChatRoom() {},
		addListener: (_filter: unknown, callback: typeof listener) => {
			listener = callback;
			return "listener";
		},
		removeListener() {},
		onConnectionChange: () => () => {},
	},
}));
mock.module("../narrator/vlist/PretextExactMessageList", () => ({
	PretextExactMessageList: (props: { dataSource: VListDataSource }) => {
		source = props.dataSource;
		return <div />;
	},
}));
const { ChatMessageList } = await import("./ChatMessageList");
const globalKeys = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"getComputedStyle",
	"matchMedia",
	"IS_REACT_ACT_ENVIRONMENT",
];
let previous: Map<string, PropertyDescriptor | undefined>;
let root: Root;
let container: HTMLElement;
let qc: QueryClient;
const originalList = chatApi.listChatMessages;
function message(id: string, seq: number): ChatMessage {
	return {
		id,
		seq,
		roomId: "room",
		kind: "text",
		contentText: `text ${id}`,
		createdAt: "2026-04-02T10:00:00Z",
		editedAt: null,
		deletedAt: null,
		replyToMessageId: null,
		replyToSeq: null,
		replyToSender: null,
		replyToPreview: null,
		attachments: [],
		sender: { id: "alice", username: "alice", avatarColor: null, avatarImageId: null },
	};
}
async function renderHost(currentUserId: string) {
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<QueryClientProvider client={qc}>
					<ChatMessageList roomId="room" currentUserId={currentUserId} />
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
}
beforeEach(async () => {
	previous = new Map(
		globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		getComputedStyle: window.getComputedStyle,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	source = undefined;
	download.mockClear();
	await renderHost("alice");
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	qc.clear();
	chatApi.listChatMessages = originalList;
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
describe("chat vlist host binding", () => {
	test("replacement source shares loaded rows and deletion barriers with a pending old-source fetch", async () => {
		const old = message("old", 1);
		old.attachments = [
			{
				id: "a",
				filename: "secret.txt",
				kind: "file",
				mediaType: "text/plain",
				sizeBytes: 10,
				width: null,
				height: null,
			},
		];
		const reply = { ...message("reply", 90), replyToMessageId: "old" };
		chatApi.listChatMessages = async (_room, opts) => ({
			messages: opts?.beforeSeq ? [old] : [reply],
			hasMore: !opts?.beforeSeq,
			nextBeforeSeq: opts?.beforeSeq ? null : 90,
		});
		const sourceA = source;
		if (!sourceA?.fetchPage) throw new Error("Missing initial source");
		await sourceA.fetchPage("room", { limit: 50 });
		await sourceA.fetchPage("room", { limit: 50, beforeSeq: 90 });
		let completePage: ((page: ChatMessagePage) => void) | undefined;
		chatApi.listChatMessages = () =>
			new Promise<ChatMessagePage>((resolve) => {
				completePage = resolve;
			});
		const pendingA = sourceA.fetchPage("room", { limit: 50, beforeSeq: 90 });
		await renderHost("bob");
		const sourceB = source;
		expect(sourceB).not.toBe(sourceA);
		// The historical row must survive in the room window, not just QueryClient.
		qc.removeQueries({ queryKey: chatKeys.messages("room") });
		const reload = mock(() => {});
		const upserts: TreeMessage[] = [];
		const stop = sourceB?.subscribeMessages?.({
			onMessage: (event) => {
				if (event.message) upserts.push(event.message as TreeMessage);
			},
			onFullReload: reload,
		});
		listener?.({ type: "chat:message_deleted", roomId: "room", messageId: "old" });
		expect(reload).not.toHaveBeenCalled();
		expect(upserts.map((row) => [row.id, row.seq])).toEqual([
			["old", 1],
			["reply", 90],
		]);
		expect(upserts[0]?.contentJson).toEqual([{ type: "text", text: "" }]);
		expect(upserts[1]?.replyQuote?.state).toBe("deleted");
		completePage?.({ messages: [old], hasMore: false, nextBeforeSeq: null });
		const late = await pendingA;
		expect(late.messages[0]?.deletedLabel).toBeDefined();
		expect(late.messages[0]?.contentText).toBe("");
		expect(late.messages[0]?.contentJson).toEqual([{ type: "text", text: "" }]);
		const cache = qc.getQueryData<{ pages: ChatMessagePage[] }>(chatKeys.messages("room"));
		expect(cache?.pages[0]?.messages[0]?.deletedAt).not.toBeNull();
		expect(cache?.pages[0]?.messages[0]?.attachments).toEqual([]);
		stop?.();
	});
	test("passes the host's authorized download action across the lazy boundary", async () => {
		expect(source?.onFetchAttachment).toBeDefined();
		source?.onFetchAttachment?.("/chat/attachments/a", "notes.txt");
		await Promise.resolve();
		expect(download).toHaveBeenCalledWith("/chat/attachments/a", "notes.txt");
	});
	test("deletes a loaded historical row even after cache eviction without reloading the tail", async () => {
		const old = message("old", 1);
		old.attachments = [
			{
				id: "a",
				filename: "secret.txt",
				kind: "file",
				mediaType: "text/plain",
				sizeBytes: 10,
				width: null,
				height: null,
			},
		];
		const reply = { ...message("reply", 90), replyToMessageId: "old" };
		chatApi.listChatMessages = async (_room, opts) => ({
			messages: opts?.beforeSeq ? [old] : [reply],
			hasMore: !opts?.beforeSeq,
			nextBeforeSeq: opts?.beforeSeq ? null : 90,
		});
		await source?.fetchPage?.("room", { limit: 50 });
		await source?.fetchPage?.("room", { limit: 50, beforeSeq: 90 });
		qc.setQueryData(chatKeys.messages("room"), {
			pages: [{ messages: [reply], hasMore: true, nextBeforeSeq: 90 }],
			pageParams: [undefined],
		});
		const upserts: TreeMessage[] = [];
		const reload = mock(() => {});
		const stop = source?.subscribeMessages?.({
			onMessage: (event) => {
				if (event.message) upserts.push(event.message as TreeMessage);
			},
			onFullReload: reload,
		});
		listener?.({ type: "chat:message_deleted", roomId: "room", messageId: "old" });
		expect(reload).not.toHaveBeenCalled();
		expect(upserts.map((row) => [row.id, row.seq])).toEqual([
			["old", 1],
			["reply", 90],
		]);
		expect(upserts[0]?.contentText).toBe("");
		expect(upserts[0]?.contentJson).toEqual([{ type: "text", text: "" }]);
		expect(upserts[1]?.replyQuote?.state).toBe("deleted");
		// A late REST response must not resurrect a deleted body or its attachments.
		const late = await source?.fetchPage?.("room", { limit: 50, beforeSeq: 90 });
		expect(late?.messages[0]?.contentText).toBe("");
		expect(late?.messages[0]?.deletedLabel).toBeDefined();
		stop?.();
	});
	test("works when useChat's cache delete callback ran first, preserving all page cursors", async () => {
		const old = message("old", 1);
		const tail = message("tail", 90);
		chatApi.listChatMessages = async (_room, opts) => ({
			messages: opts?.beforeSeq ? [old] : [tail],
			hasMore: !opts?.beforeSeq,
			nextBeforeSeq: opts?.beforeSeq ? null : 90,
		});
		await source?.fetchPage?.("room", { limit: 50 });
		await source?.fetchPage?.("room", { limit: 50, beforeSeq: 90 });
		// Equivalent to useChatRoomLive's earlier listener mutating the same cache.
		qc.setQueryData(chatKeys.messages("room"), {
			pages: [
				{ messages: [tail], hasMore: true, nextBeforeSeq: 90 },
				{
					messages: [{ ...old, contentText: "", attachments: [], deletedAt: "already-deleted" }],
					hasMore: false,
					nextBeforeSeq: null,
				},
			],
			pageParams: [undefined, 90],
		});
		const reload = mock(() => {});
		const upserts: TreeMessage[] = [];
		source?.subscribeMessages?.({
			onMessage: (event) => {
				if (event.message) upserts.push(event.message as TreeMessage);
			},
			onFullReload: reload,
		});
		listener?.({ type: "chat:message_deleted", roomId: "room", messageId: "old" });
		expect(reload).not.toHaveBeenCalled();
		expect(upserts[0]?.id).toBe("old");
		const cache = qc.getQueryData<{ pages: { messages: ChatMessage[] }[]; pageParams: unknown[] }>(
			chatKeys.messages("room"),
		);
		expect(cache?.pageParams).toEqual([undefined, 90]);
		expect(cache?.pages.map((page) => page.messages.map((row) => row.seq))).toEqual([[90], [1]]);
		expect(cache?.pages[1]?.messages[0]?.deletedAt).toBe("already-deleted");
	});
});
