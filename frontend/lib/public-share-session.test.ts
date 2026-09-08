import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
	PublicDiscussionMessage,
	PublicDiscussionPage,
	PublicSharedMessage,
	PublicSharedMessagePage,
	PublicSharedSession,
	PublicShareEvent,
} from "@shared/public-narrator-share";
import { type PublicShareClient, PublicShareError } from "./public-share-api";
import { applyPublicDelta, mergePublicRows, PublicShareSession } from "./public-share-session";

const session: PublicSharedSession = {
	shareId: "link",
	title: "Shared title",
	status: "idle",
	messageVersion: 1,
	guestName: "Fixed guest",
};
function message(id: string, seq: number, text = id): PublicSharedMessage {
	return {
		id,
		seq,
		text,
		role: "assistant",
		createdAt: "2026-06-01T00:00:00Z",
		reasoning: "",
		tools: [],
		truncated: false,
		mediaOmitted: false,
	};
}
function messagePage(
	messages = [message("tail", 10)],
	hasMore = false,
	version = 1,
): PublicSharedMessagePage {
	return {
		messages,
		hasMore,
		messageVersion: version,
		nextBeforeSeq: hasMore ? Math.min(...messages.map((m) => m.seq)) : null,
	};
}
function discussionMessage(id: string, seq: number): PublicDiscussionMessage {
	return {
		id,
		seq,
		text: id,
		author: { name: "Fixed guest", isGuest: true, isSelf: true },
		createdAt: "2026-06-01T00:00:00Z",
		deletedAt: null,
		replyTo: null,
		hasAttachments: false,
	};
}
function discussionPage(
	messages = [discussionMessage("discussion", 10)],
	hasMore = false,
): PublicDiscussionPage {
	return {
		messages,
		hasMore,
		nextBeforeSeq: hasMore ? Math.min(...messages.map((m) => m.seq)) : null,
	};
}
const stores: PublicShareSession[] = [];
afterEach(() => {
	for (const store of stores) store.stop();
	stores.length = 0;
});
async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}
function harness(overrides: Partial<PublicShareClient> = {}) {
	let emit: (event: PublicShareEvent) => void = () => {
		throw new Error("SSE not connected");
	};
	let streamSignal: AbortSignal | null = null;
	const client: PublicShareClient = {
		session: mock(async () => session),
		messages: mock(async () => messagePage()),
		discussion: mock(async () => discussionPage()),
		tool: mock(async () => ({
			id: "tool",
			name: "Read",
			status: "done",
			input: "input",
			output: "output",
			truncated: false,
		})),
		post: mock(async () => discussionMessage("sent", 11)),
		events: mock((signal, onEvent) => {
			emit = onEvent;
			streamSignal = signal;
			return new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		}),
		...overrides,
	};
	const store = new PublicShareSession(client);
	stores.push(store);
	return {
		store,
		client,
		emit: (event: PublicShareEvent) => emit(event),
		get streamSignal() {
			return streamSignal;
		},
		async ready() {
			store.start();
			await flush();
			emit({ type: "snapshot", blocks: [], truncated: false });
			await flush();
		},
	};
}

describe("public live offset reducer", () => {
	test("duplicate and overlapping offsets append exactly once, including UTF-16", () => {
		const blocks = [{ id: "b", kind: "text" as const, text: "你好😀abc" }];
		const event = {
			type: "delta" as const,
			blockId: "b",
			kind: "text" as const,
			text: "abcde",
			offset: 4,
		};
		const next = applyPublicDelta(blocks, event);
		expect(next?.[0].text).toBe("你好😀abcde");
		expect(applyPublicDelta(next ?? [], event)).toBe(next);
		expect(blocks[0].text).toBe("你好😀abc");
	});
	test("offset gaps, conflicts and wrong block kinds require a fresh snapshot", () => {
		const event = {
			type: "delta" as const,
			blockId: "b",
			kind: "text" as const,
			text: "x",
			offset: 2,
		};
		expect(applyPublicDelta([], event)).toBeNull();
		expect(applyPublicDelta([{ id: "b", kind: "text", text: "abc" }], event)).toBeNull();
		expect(applyPublicDelta([{ id: "b", kind: "reasoning", text: "ab" }], event)).toBeNull();
		expect(applyPublicDelta([], { ...event, offset: 0 })?.[0].text).toBe("x");
	});
	test("live state has a hard budget", () => {
		expect(
			applyPublicDelta([], {
				type: "delta",
				blockId: "b",
				kind: "text",
				offset: 0,
				text: "x".repeat(256 * 1024 + 1),
			}),
		).toBeNull();
	});
	test("paged rows are sorted, deduplicated, and newer edits win", () => {
		expect(
			mergePublicRows([message("a", 2, "old")], [message("a", 2, "edited"), message("b", 1)]).map(
				(row) => row.text,
			),
		).toEqual(["b", "edited"]);
	});
});

describe("credential-local public share controller", () => {
	test("a delayed post cannot resurrect a message deleted before its response arrives", async () => {
		const pending = Promise.withResolvers<PublicDiscussionMessage>();
		const h = harness({ post: () => pending.promise });
		await h.ready();
		const posting = h.store.post("sent");
		const deleted = {
			...discussionMessage("sent", 11),
			text: "",
			deletedAt: "2026-06-01T00:01:00Z",
		};
		h.client.discussion = mock(async () => discussionPage([deleted]));
		h.emit({ type: "invalidate", scope: "discussion" });
		await Bun.sleep(230);
		expect(h.store.getSnapshot().discussion?.messages).toEqual([deleted]);
		pending.resolve(discussionMessage("sent", 11));
		expect(await posting).toBe(true);
		expect(h.store.getSnapshot().discussion?.messages).toEqual([deleted]);
		expect(h.store.getSnapshot().sending).toBe(false);
		await Bun.sleep(230);
		expect(h.client.discussion).toHaveBeenCalledTimes(2);
		expect(h.store.getSnapshot().discussion?.messages).toEqual([deleted]);
	});

	test("nothing is displayed or subscribed before root validation; pages wait for snapshot", async () => {
		const validation = Promise.withResolvers<PublicSharedSession>();
		const h = harness({ session: mock(() => validation.promise) });
		h.store.start();
		expect(h.store.getSnapshot().session).toBeNull();
		expect(h.client.events).not.toHaveBeenCalled();
		validation.resolve(session);
		await flush();
		expect(h.client.events).toHaveBeenCalledTimes(1);
		expect(h.client.messages).not.toHaveBeenCalled();
		h.emit({
			type: "snapshot",
			blocks: [{ id: "live", kind: "text", text: "stream" }],
			truncated: false,
		});
		await flush();
		expect(h.store.getSnapshot().messages?.messages[0].id).toBe("tail");
		expect(h.store.getSnapshot().live[0].text).toBe("stream");
	});

	test("first page racing persistence invalidation cannot restore duplicate live or stale history", async () => {
		const first = Promise.withResolvers<PublicSharedMessagePage>();
		let calls = 0;
		const h = harness({
			messages: async () =>
				++calls === 1 ? first.promise : messagePage([message("persisted", 11)]),
		});
		h.store.start();
		await flush();
		h.emit({
			type: "snapshot",
			blocks: [{ id: "old-live", kind: "text", text: "persisted text" }],
			truncated: false,
		});
		h.emit({ type: "snapshot", blocks: [], truncated: false });
		h.emit({ type: "invalidate", scope: "messages" });
		expect(h.store.getSnapshot().live).toEqual([]);
		first.resolve(messagePage([message("stale", 10)]));
		await flush();
		expect(h.store.getSnapshot().messages).toBeNull();
		// A new turn starts while the persistence refresh is still running.
		h.emit({ type: "delta", blockId: "new-live", kind: "text", text: "next turn", offset: 0 });
		await Bun.sleep(230);
		expect(h.store.getSnapshot().messages?.messages.map((row) => row.id)).toEqual(["persisted"]);
		expect(h.store.getSnapshot().live[0].text).toBe("next turn");
	});

	test("snapshot plus messages invalidation preserves the authoritative remaining live blocks", async () => {
		const h = harness();
		await h.ready();
		h.emit({
			type: "snapshot",
			blocks: [{ id: "remaining", kind: "text", text: "not persisted" }],
			truncated: true,
		});
		h.emit({ type: "invalidate", scope: "messages" });
		expect(h.store.getSnapshot().live).toEqual([
			{ id: "remaining", kind: "text", text: "not persisted" },
		]);
		expect(h.store.getSnapshot().liveTruncated).toBe(true);
		await Bun.sleep(230);
		expect(h.store.getSnapshot().live[0].text).toBe("not persisted");
		// Live-only replacement must not clear another participant's discussion/reply view.
		expect(h.client.discussion).toHaveBeenCalledTimes(1);
	});

	test("tool-only invalidation keeps live offsets continuous without unnecessary reconnect", async () => {
		const h = harness();
		await h.ready();
		h.emit({ type: "delta", blockId: "b", kind: "text", text: "before tool", offset: 0 });
		h.emit({ type: "invalidate", scope: "messages" });
		h.emit({ type: "delta", blockId: "b", kind: "text", text: " after tool", offset: 11 });
		expect(h.store.getSnapshot().live[0].text).toBe("before tool after tool");
		expect(h.store.getSnapshot().phase).toBe("live");
		expect(h.client.session).toHaveBeenCalledTimes(1);
	});

	test("session version refresh preserves the current live generation", async () => {
		let version = 1;
		const h = harness({ session: async () => ({ ...session, messageVersion: version }) });
		await h.ready();
		h.emit({ type: "delta", blockId: "b", kind: "reasoning", text: "thinking", offset: 0 });
		version = 2;
		h.emit({ type: "invalidate", scope: "session" });
		await flush();
		expect(h.store.getSnapshot().live[0].text).toBe("thinking");
		expect(h.store.getSnapshot().messages).toBeNull();
	});

	test("invalidation drops ALL previously loaded pages, not merely the last edited/deleted tail", async () => {
		let refreshed = false;
		const h = harness({
			messages: async (_signal, beforeSeq) =>
				beforeSeq
					? messagePage([message("older", 1)])
					: refreshed
						? messagePage([message("tail", 10, "edited")], false, 2)
						: messagePage([message("tail", 10)], true),
		});
		await h.ready();
		await h.store.loadEarlierMessages();
		expect(h.store.getSnapshot().messages?.messages.map((row) => row.id)).toEqual([
			"older",
			"tail",
		]);
		refreshed = true;
		h.emit({ type: "invalidate", scope: "messages" });
		expect(h.store.getSnapshot().messages).toBeNull();
		await Bun.sleep(230);
		expect(h.store.getSnapshot().messages?.messages.map((row) => row.text)).toEqual(["edited"]);
		expect(h.store.getSnapshot().session?.messageVersion).toBe(2);
	});

	test("late older-page response is fenced after edit/delete invalidation", async () => {
		const older = Promise.withResolvers<PublicSharedMessagePage>();
		const h = harness({
			messages: async (_signal, beforeSeq) =>
				beforeSeq ? older.promise : messagePage([message("tail", 10)], true),
		});
		await h.ready();
		const load = h.store.loadEarlierMessages();
		h.emit({ type: "invalidate", scope: "messages" });
		older.resolve(messagePage([message("deleted", 1)]));
		await load;
		expect(h.store.getSnapshot().messages).toBeNull();
	});

	test("pagination supplies cursor/version and refuses to mix different history versions", async () => {
		const queries: { beforeSeq?: number; version?: number }[] = [];
		const h = harness({
			messages: async (_signal, beforeSeq, version) => {
				queries.push({ beforeSeq, version });
				return beforeSeq
					? messagePage([message("older", 1)], false, 2)
					: messagePage([message("tail", 10)], true);
			},
		});
		await h.ready();
		await h.store.loadEarlierMessages();
		expect(queries).toEqual([
			{ beforeSeq: undefined, version: undefined },
			{ beforeSeq: 10, version: 1 },
		]);
		expect(h.store.getSnapshot().messages).toBeNull();
	});

	test("discussion deletions reset old loaded pages and invalidate in-flight pagination", async () => {
		const older = Promise.withResolvers<PublicDiscussionPage>();
		const h = harness({
			discussion: async (_signal, beforeSeq) =>
				beforeSeq ? older.promise : discussionPage([discussionMessage("tail", 10)], true),
		});
		await h.ready();
		const load = h.store.loadEarlierDiscussion();
		h.emit({ type: "invalidate", scope: "discussion" });
		older.resolve(discussionPage([discussionMessage("deleted", 1)]));
		await load;
		expect(h.store.getSnapshot().discussion).toBeNull();
	});

	test("revocation clears all content, aborts stream and fences late tool/post results", async () => {
		const detail = Promise.withResolvers<{
			id: string;
			name: string;
			status: string;
			input: string;
			output: string;
			truncated: boolean;
		}>();
		const sent = Promise.withResolvers<PublicDiscussionMessage>();
		const h = harness({ tool: () => detail.promise, post: () => sent.promise });
		await h.ready();
		const tool = h.store.tool("tool", new AbortController().signal);
		const post = h.store.post("draft");
		h.emit({ type: "revoked" });
		expect(h.streamSignal?.aborted).toBe(true);
		expect(h.store.getSnapshot()).toMatchObject({
			phase: "unavailable",
			session: null,
			messages: null,
			discussion: null,
			live: [],
			sending: false,
		});
		detail.resolve({
			id: "tool",
			name: "Read",
			status: "done",
			input: "sensitive",
			output: "sensitive",
			truncated: false,
		});
		sent.resolve(discussionMessage("late", 11));
		expect(await tool).toBeNull();
		expect(await post).toBe(false);
		h.store.reconnect();
		expect(h.store.getSnapshot().phase).toBe("unavailable");
	});

	test("tool expansion works without AbortSignal.any and detaches completed requests", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
		Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
		let linkedSignal: AbortSignal | undefined;
		try {
			const h = harness({
				tool: async (_id, signal) => {
					linkedSignal = signal;
					return {
						id: "tool",
						name: "Read",
						status: "success",
						input: "",
						output: "ok",
						truncated: false,
					};
				},
			});
			await h.ready();
			const caller = new AbortController();
			expect(await h.store.tool("tool", caller.signal)).toMatchObject({ output: "ok" });
			caller.abort();
			h.store.stop();
			expect(linkedSignal?.aborted).toBe(false);
		} finally {
			if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor);
			else Reflect.deleteProperty(AbortSignal, "any");
		}
	});

	test.each([
		"caller",
		"session",
	] as const)("pending tool expansion is cancelled by its %s", async (source) => {
		let linkedSignal: AbortSignal | undefined;
		const pending = Promise.withResolvers<Awaited<ReturnType<PublicShareClient["tool"]>>>();
		const h = harness({
			tool: async (_id, signal) => {
				linkedSignal = signal;
				return pending.promise;
			},
		});
		await h.ready();
		const caller = new AbortController();
		const detail = h.store.tool("tool", caller.signal);
		if (source === "caller") caller.abort();
		else h.store.reconnect();
		expect(linkedSignal?.aborted).toBe(true);
		pending.resolve({
			id: "tool",
			name: "Read",
			status: "success",
			input: "",
			output: "late",
			truncated: false,
		});
		expect(await detail).toBeNull();
	});

	test("HTTP invalidation during a tool expansion clears content, not just the tool", async () => {
		const h = harness({
			tool: async () => {
				throw new PublicShareError(403);
			},
		});
		await h.ready();
		await expect(h.store.tool("tool", new AbortController().signal)).rejects.toBeInstanceOf(
			PublicShareError,
		);
		expect(h.store.getSnapshot().session).toBeNull();
		expect(h.store.getSnapshot().phase).toBe("unavailable");
	});

	test("new credential starts empty, and stopped controllers cannot repopulate any data", async () => {
		const first = harness();
		await first.ready();
		const second = harness({
			session: async () => {
				throw new PublicShareError(404);
			},
		});
		expect(second.store.getSnapshot().messages).toBeNull();
		first.store.stop();
		first.emit({
			type: "snapshot",
			blocks: [{ id: "old", kind: "text", text: "old credential" }],
			truncated: false,
		});
		second.store.start();
		await flush();
		expect(first.store.getSnapshot().session).toBeNull();
		expect(second.store.getSnapshot()).toMatchObject({
			phase: "unavailable",
			session: null,
			messages: null,
		});
	});

	test.each([
		"resolve",
		"reject",
	] as const)("manual reconnect during a pending post clears sending and fences its late %s", async (outcome) => {
		const pending = Promise.withResolvers<PublicDiscussionMessage>();
		const next = Promise.withResolvers<PublicDiscussionMessage>();
		let posts = 0;
		let firstSignal: AbortSignal | undefined;
		const h = harness({
			post: async (_text, _reply, signal) => {
				if (++posts === 1) {
					firstSignal = signal;
					return pending.promise;
				}
				return next.promise;
			},
		});
		await h.ready();
		const oldPost = h.store.post("kept draft");
		expect(h.store.getSnapshot().sending).toBe(true);
		h.store.reconnect();
		expect(firstSignal?.aborted).toBe(true);
		expect(h.store.getSnapshot()).toMatchObject({ sending: false, sendError: true });
		await flush();
		h.emit({ type: "snapshot", blocks: [], truncated: false });
		await flush();
		expect(h.store.getSnapshot()).toMatchObject({ phase: "live", sending: false });

		const newPost = h.store.post("new message after checking discussion");
		expect(posts).toBe(2);
		if (outcome === "resolve") pending.resolve(discussionMessage("late-old-post", 11));
		else pending.reject(new DOMException("Aborted", "AbortError"));
		expect(await oldPost).toBe(false);
		// The old request must not clear the replacement request's loading state.
		expect(h.store.getSnapshot()).toMatchObject({ sending: true, sendError: false });
		expect(h.store.getSnapshot().discussion?.messages.map((message) => message.id)).not.toContain(
			"late-old-post",
		);
		next.resolve(discussionMessage("new-post", 12));
		expect(await newPost).toBe(true);
		expect(h.store.getSnapshot().sending).toBe(false);
	});

	test("offset gap aborts old stream and reconnect starts from root + fresh snapshot", async () => {
		const h = harness();
		await h.ready();
		h.emit({ type: "delta", blockId: "unknown", kind: "text", text: "gap", offset: 100 });
		expect(h.store.getSnapshot().phase).toBe("reconnecting");
		expect(h.streamSignal?.aborted).toBe(true);
		h.store.reconnect();
		await flush();
		h.emit({
			type: "snapshot",
			blocks: [{ id: "fresh", kind: "text", text: "fresh" }],
			truncated: false,
		});
		await flush();
		expect(h.client.session).toHaveBeenCalledTimes(2);
		expect(h.store.getSnapshot().live[0].text).toBe("fresh");
	});

	test("server reset drops stale pages before scheduling a fresh connection", async () => {
		const h = harness();
		await h.ready();
		h.emit({ type: "reset" });
		expect(h.store.getSnapshot()).toMatchObject({
			phase: "reconnecting",
			messages: null,
			discussion: null,
			live: [],
		});
	});

	test("reconnect validates access before displaying new data; denied access clears old data", async () => {
		let denied = false;
		const h = harness({
			session: async () => {
				if (denied) throw new PublicShareError(404);
				return session;
			},
		});
		await h.ready();
		denied = true;
		h.store.reconnect();
		await flush();
		expect(h.store.getSnapshot()).toMatchObject({
			phase: "unavailable",
			messages: null,
			discussion: null,
			session: null,
		});
	});
});
