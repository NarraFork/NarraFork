import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { chatKeys } from "../../hooks/useChat";
import type { ChatMessage, ChatMessagePage } from "../../lib/api/chat";
import { chatApi } from "../../lib/api/chat";
import { ApiError } from "../../lib/api/client";
import type { TreeMessage } from "../../lib/api/types";
import type { VListDataSource } from "../narrator/vlist/vlist-data-source";

let source: VListDataSource | undefined;
let enableNarratorErrorActions: boolean | undefined;
let listener: ((event: Record<string, unknown>) => void) | undefined;
let automaticAck = true;
let ackTail = 90;
let ackRequestId: string | undefined;
let suspendedProp: boolean | undefined;
const joins = mock(() => {});
const leaves = mock(() => {});
const download = mock(async () => true);
mock.module("./chat-attachment-download", () => ({ downloadChatAttachment: download }));
mock.module("../../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		allocateId: () => "handle",
		joinChatRoom(roomId: string, _handle: number, requestId?: string) {
			joins();
			ackRequestId = requestId;
			if (automaticAck)
				queueMicrotask(() =>
					listener?.({ type: "chat:subscribed", roomId, requestId, tailSeq: ackTail }),
				);
		},
		leaveChatRoom() {
			leaves();
		},
		addListener: (_filter: unknown, callback: typeof listener) => {
			listener = callback;
			return "listener";
		},
		removeListener() {
			listener = undefined;
		},
		onConnectionChange: () => () => {},
	},
}));
mock.module("../narrator/vlist/PretextExactMessageList", () => ({
	PretextExactMessageList: (props: {
		dataSource: VListDataSource;
		suspended?: boolean;
		enableNarratorErrorActions?: boolean;
	}) => {
		source = props.dataSource;
		suspendedProp = props.suspended;
		enableNarratorErrorActions = props.enableNarratorErrorActions;
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
async function renderHost(currentUserId: string, suspended = false) {
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<QueryClientProvider client={qc}>
					<ChatMessageList roomId="room" currentUserId={currentUserId} suspended={suspended} />
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
	automaticAck = true;
	ackTail = 90;
	joins.mockClear();
	leaves.mockClear();
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
	test("hidden transport leaves the room, retains source, and waits for the current epoch ACK before REST", async () => {
		const retained = source;
		await renderHost("alice", true);
		expect(suspendedProp).toBe(true);
		expect(source).toBe(retained);
		expect(leaves).toHaveBeenCalledTimes(1);
		expect(listener).toBeUndefined();
		automaticAck = false;
		const fetch = mock(async () => ({
			messages: [message("m", 1)],
			hasMore: false,
			nextBeforeSeq: null,
		}));
		chatApi.listChatMessages = fetch;
		await renderHost("alice", false);
		const controller = new AbortController();
		const pending = source?.fetchPage?.("room", { limit: 40, signal: controller.signal });
		await Promise.resolve();
		expect(fetch).not.toHaveBeenCalled();
		listener?.({ type: "chat:subscribed", roomId: "room", requestId: "retired", tailSeq: 90 });
		await Promise.resolve();
		expect(fetch).not.toHaveBeenCalled();
		listener?.({ type: "chat:subscribed", roomId: "room", requestId: ackRequestId, tailSeq: 90 });
		await pending;
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(joins).toHaveBeenCalledTimes(2);
	});

	test("historical restore uses its original fixed upper boundary and preserves live deletion barriers", async () => {
		chatApi.listChatMessages = async () => ({
			messages: [message("tail", 90)],
			hasMore: true,
			nextBeforeSeq: 90,
		});
		await source?.fetchPage?.("room", { limit: 40 });
		const restoredRows = [message("old", 20), message("end", 30)];
		const calls: unknown[] = [];
		chatApi.listChatMessages = async (_room, params) => {
			calls.push(params);
			listener?.({ type: "chat:message_deleted", roomId: "room", messageId: "old" });
			return {
				messages: restoredRows,
				hasMore: false,
				nextBeforeSeq: null,
				hasNext: false,
				nextAfterSeq: 30,
			};
		};
		const outcome: {
			value?: import("../narrator/vlist/pretext-document-loader").PretextDocumentInput;
		} = {};
		await act(async () => {
			outcome.value = await source?.refreshWindow?.({
				narratorId: "room",
				signal: new AbortController().signal,
				window: {
					messages: restoredRows.map(
						(row) =>
							({
								...row,
								role: "user",
								narratorId: "room",
								toolCalls: [],
								blocks: [],
							}) as unknown as TreeMessage,
					),
					messageVersion: 0,
					oldestLoadedSeq: 20,
					hasPrev: true,
				},
			});
		});
		const restored = outcome.value;
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ afterSeq: 19, beforeSeq: 31, limit: 100 });
		expect(restored?.messages.map((row) => row.seq)).toEqual([20, 30]);
		expect(restored?.messages[0]?.contentText).toBe("");
		expect(restored?.messages[0]?.deletedLabel).toBeDefined();
	});

	test("recovery buffers live structure, completes hidden deletes, and applies last-await tombstones before one commit", async () => {
		const rows = [
			message("hidden-delete", 20),
			message("late-delete", 25),
			message("live-delete", 30),
		];
		chatApi.listChatMessages = async () => ({ messages: rows, hasMore: true, nextBeforeSeq: 20 });
		const initial = await source?.fetchPage?.("room", { limit: 40 });
		const upserts = mock(() => {});
		const stop = source?.subscribeMessages?.({ onMessage: upserts });
		let complete: ((page: ChatMessagePage) => void) | undefined;
		chatApi.listChatMessages = () =>
			new Promise((resolve) => {
				complete = resolve;
			});
		const controller = new AbortController();
		const pending = source?.refreshWindow?.({
			narratorId: "room",
			signal: controller.signal,
			window: {
				messages: initial?.messages ?? [],
				messageVersion: 0,
				oldestLoadedSeq: 20,
				hasPrev: true,
			},
		});
		await Promise.resolve();
		await Promise.resolve();
		await act(async () => {
			listener?.({ type: "chat:message_deleted", roomId: "room", messageId: "live-delete" });
			listener?.({ type: "chat:message", roomId: "room", message: message("new-tail", 91) });
		});
		expect(upserts).not.toHaveBeenCalled();
		expect(controller.signal.aborted).toBe(false);
		let restored: Awaited<typeof pending>;
		await act(async () => {
			complete?.({
				messages: rows.map((row) =>
					row.id === "hidden-delete" ? { ...row, contentText: "", deletedAt: "while-hidden" } : row,
				),
				hasMore: false,
				nextBeforeSeq: null,
				hasNext: false,
			});
			restored = await pending;
			// This event lands after REST resolution, in the shell's async layout preparation gap.
			listener?.({ type: "chat:message_deleted", roomId: "room", messageId: "late-delete" });
		});
		if (!restored) throw new Error("No restored window");
		const finalized = source?.finalizeRefreshWindow?.(restored) ?? restored;
		expect(finalized.messages.map((row) => [row.seq, !!row.deletedLabel])).toEqual([
			[20, true],
			[25, true],
			[30, true],
		]);
		expect(upserts).not.toHaveBeenCalled();
		await act(async () => {
			source?.onWindowChange?.(finalized);
		});
		expect(controller.signal.aborted).toBe(false);
		expect(upserts).not.toHaveBeenCalled(); // historical window never follows seq91 to the tail
		const cache = qc.getQueryData<{ pages: ChatMessagePage[] }>(chatKeys.messages("room"));
		expect(cache?.pages[0]?.messages.every((row) => row.deletedAt)).toBe(true);
		stop?.();
	});

	test("late deletion in the recovered tail survives an old geometry mirror trimming candidate DTO rows", async () => {
		await renderHost("alice", true);
		ackTail = 100;
		await renderHost("alice", false);
		const oldRows = Array.from({ length: 40 }, (_, index) => message(`m${61 + index}`, 61 + index));
		chatApi.listChatMessages = async () => ({
			messages: oldRows,
			hasMore: true,
			nextBeforeSeq: 61,
		});
		const initial = await source?.fetchPage?.("room", { limit: 40 });
		const oldWindow = {
			messages: initial?.messages ?? [],
			messageVersion: 0,
			oldestLoadedSeq: 61,
			hasPrev: true,
		};
		source?.onWindowChange?.(oldWindow);
		const upserts = mock(() => {});
		const stop = source?.subscribeMessages?.({ onMessage: upserts });
		await renderHost("alice", true);
		ackTail = 110;
		await renderHost("alice", false);
		chatApi.listChatMessages = async () => ({
			messages: Array.from({ length: 50 }, (_, index) => message(`m${61 + index}`, 61 + index)),
			hasMore: false,
			nextBeforeSeq: null,
			hasNext: false,
		});
		const result: { value?: Awaited<ReturnType<NonNullable<VListDataSource["refreshWindow"]>>> } =
			{};
		await act(async () => {
			result.value = await source?.refreshWindow?.({
				narratorId: "room",
				window: oldWindow,
				signal: new AbortController().signal,
			});
		});
		if (!result.value) throw new Error("No recovered input");
		// Pure geometry can still publish its OLD committed window during prepareKatex.
		source?.onWindowChange?.(oldWindow);
		expect(
			qc
				.getQueryData<{ pages: ChatMessagePage[] }>(chatKeys.messages("room"))
				?.pages[0]?.messages.some((row) => row.seq === 105),
		).toBe(false);
		listener?.({ type: "chat:message_deleted", roomId: "room", messageId: "m105" });
		const finalized = source?.finalizeRefreshWindow?.(result.value) ?? result.value;
		expect(finalized.messages).toHaveLength(50);
		expect(finalized.messages.find((row) => row.seq === 105)?.deletedLabel).toBeDefined();
		expect(finalized.messages.find((row) => row.seq === 105)?.contentText).toBe("");
		expect(upserts).not.toHaveBeenCalled();
		await act(async () => {
			source?.onWindowChange?.(finalized);
		});
		expect(
			qc
				.getQueryData<{ pages: ChatMessagePage[] }>(chatKeys.messages("room"))
				?.pages[0]?.messages.find((row) => row.seq === 105)?.deletedAt,
		).toBeTruthy();
		stop?.();
	});

	test.each([
		"page",
		"recovery",
	])("room-page privacy 404 is authorization loss, not a retained temporary error (%s)", async (mode) => {
		chatApi.listChatMessages = async () => ({
			messages: [message("private", 1)],
			hasMore: false,
			nextBeforeSeq: null,
		});
		const page = await source?.fetchPage?.("room", { limit: 40 });
		const window = {
			messages: page?.messages ?? [],
			messageVersion: 0,
			oldestLoadedSeq: 1,
			hasPrev: false,
		};
		source?.onWindowChange?.(window);
		chatApi.listChatMessages = async () => {
			throw new ApiError("Chat room not found", 404, { code: "NOT_FOUND" });
		};
		const denied =
			mode === "page"
				? source?.fetchPage?.("room", { limit: 40 })
				: source?.refreshWindow?.({
						narratorId: "room",
						window,
						signal: new AbortController().signal,
					});
		await expect(denied).rejects.toMatchObject({ status: 403, data: { sourceStatus: 404 } });
		expect(qc.getQueryData<{ pages: ChatMessagePage[] }>(chatKeys.messages("room"))?.pages).toEqual(
			[],
		);
	});

	test("late previous-principal REST cannot write the new room window", async () => {
		let finish: ((page: ChatMessagePage) => void) | undefined;
		chatApi.listChatMessages = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const oldSource = source;
		const pending = oldSource?.fetchPage?.("room", { limit: 40 });
		await Promise.resolve();
		await renderHost("bob");
		finish?.({ messages: [message("private", 1)], hasMore: false, nextBeforeSeq: null });
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(qc.getQueryData(chatKeys.messages("room"))).toBeUndefined();
	});

	test("disables narrator-only error actions for the room identity", () => {
		expect(enableNarratorErrorActions).toBe(false);
	});

	test("same-room rerender shares deletion barriers with a pending fetch", async () => {
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
		await renderHost("alice");
		const sourceB = source;
		expect(sourceB).toBe(sourceA);
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
		expect(messageBody(upserts[0])).toEqual([{ type: "text", text: "" }]);
		expect(upserts[1]?.replyQuote?.state).toBe("deleted");
		completePage?.({ messages: [old], hasMore: false, nextBeforeSeq: null });
		const late = await pendingA;
		expect(late.messages[0]?.deletedLabel).toBeDefined();
		expect(late.messages[0]?.contentText).toBe("");
		expect(messageBody(late.messages[0])).toEqual([{ type: "text", text: "" }]);
		sourceB?.onWindowChange?.({
			messages: late.messages,
			messageVersion: 0,
			oldestLoadedSeq: 1,
			hasPrev: false,
		});
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
		expect(messageBody(upserts[0])).toEqual([{ type: "text", text: "" }]);
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
