import { describe, expect, test } from "bun:test";
import { NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION } from "@shared/recent-tabs";
import { coerceMessageReplacementAliases } from "../hooks/useNarratorWS";
import {
	chunkNarratorIds,
	limitNarratorSubscriptionIds,
	matchesListenerFilter,
	NarratorWSManager,
	shouldDeliverToListener,
} from "./narrator-ws-manager";

describe("COW replacement aliases", () => {
	test("forwards every old/new identity alias from WS frames", () => {
		expect(
			coerceMessageReplacementAliases({
				oldMessageId: "old",
				replacedMessageId: "old",
				messageId: "new",
				newMessageId: "new",
				replacementMessageId: "new",
			}),
		).toEqual({
			oldMessageId: "old",
			replacedMessageId: "old",
			messageId: "new",
			newMessageId: "new",
			replacementMessageId: "new",
		});
	});
});

describe("narrator subscription batching", () => {
	test("preflights the unique connection limit without recording phantom subscriptions", () => {
		const narratorIds = Array.from(
			{ length: NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION + 5 },
			(_, index) => `limited-${index}`,
		);
		expect(limitNarratorSubscriptionIds(new Set(), narratorIds)).toEqual({
			accepted: narratorIds.slice(0, NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION),
			dropped: narratorIds.slice(NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION),
		});

		const manager = new NarratorWSManager();
		const handle = manager.subscribe(narratorIds, { kind: "list" });
		const internals = manager as unknown as {
			narratorRefCounts: Map<string, Set<number>>;
			subscriptions: Map<number, { narratorIds: string[] }>;
		};
		expect(handle._narratorIds).toHaveLength(NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION);
		expect(internals.narratorRefCounts.size).toBe(NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION);
		expect(internals.subscriptions.get(handle._id)?.narratorIds).toHaveLength(
			NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
		);
		expect(
			internals.narratorRefCounts.has(
				`limited-${NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION + 4}`,
			),
		).toBeFalse();

		const replacements = Array.from({ length: 20 }, (_, index) => `replacement-${index}`);
		manager.updateSubscription(handle, [
			...narratorIds.slice(0, NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION - 10),
			...replacements,
		]);
		expect(handle._narratorIds).toHaveLength(NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION);
		expect(internals.narratorRefCounts.size).toBe(NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION);
		expect(handle._narratorIds).toContain("replacement-9");
		expect(handle._narratorIds).not.toContain("replacement-10");
	});

	test("chunks subscribe and unsubscribe frames at 100 narrator IDs", () => {
		const narratorIds = Array.from({ length: 205 }, (_, index) => `narrator-${index}`);
		expect(chunkNarratorIds(narratorIds).map((batch) => batch.length)).toEqual([100, 100, 5]);

		const manager = new NarratorWSManager();
		const handle = manager.subscribe(narratorIds, { kind: "list" });
		const sent: Array<{ type: string; narratorIds?: string[] }> = [];
		const internals = manager as unknown as {
			ws: { readyState: number; send: (payload: string) => void };
			_sendSubscribe: (subscription: typeof handle, ids: string[]) => void;
		};
		internals.ws = {
			readyState: WebSocket.OPEN,
			send: (payload) => sent.push(JSON.parse(payload)),
		};

		internals._sendSubscribe(handle, narratorIds);
		expect(sent.map((message) => message.narratorIds?.length)).toEqual([100, 100, 5]);
		expect(sent.every((message) => message.type === "subscribe")).toBeTrue();

		sent.length = 0;
		manager.unsubscribe(handle);
		expect(sent.map((message) => message.narratorIds?.length)).toEqual([100, 100, 5]);
		expect(sent.every((message) => message.type === "unsubscribe")).toBeTrue();
	});
});

describe("matchesListenerFilter", () => {
	test("matches a narrator-scoped listener by narratorId", () => {
		expect(matchesListenerFilter({ narratorIds: ["n1"] }, "status_change", "n1")).toBe(true);
		expect(matchesListenerFilter({ narratorIds: ["n1"] }, "status_change", "n2")).toBe(false);
	});

	test("wildcard listeners match any narrator", () => {
		expect(matchesListenerFilter({ narratorIds: "*" }, "status_change", "n9")).toBe(true);
	});

	test("type filters gate delivery", () => {
		expect(
			matchesListenerFilter({ narratorIds: ["n1"], types: ["status_change"] }, "message", "n1"),
		).toBe(false);
		expect(
			matchesListenerFilter(
				{ narratorIds: ["n1"], types: ["status_change"] },
				"status_change",
				"n1",
			),
		).toBe(true);
	});

	test("exclude type filters gate delivery without affecting other events", () => {
		expect(
			matchesListenerFilter(
				{ narratorIds: ["n1"], excludeTypes: ["tool_use_chunk"] },
				"tool_use_chunk",
				"n1",
			),
		).toBe(false);
		expect(
			matchesListenerFilter(
				{ narratorIds: ["n1"], excludeTypes: ["tool_use_chunk"] },
				"status_change",
				"n1",
			),
		).toBe(true);
	});
});

describe("shouldDeliverToListener", () => {
	const listListener = { narratorIds: ["n1"], subscriptionId: 1 };
	const messagesListener = { narratorIds: ["n1"], subscriptionId: 2 };

	test("realtime frames (no requestId) reach every matching listener", () => {
		expect(shouldDeliverToListener(listListener, "status_change", "n1", undefined, undefined)).toBe(
			true,
		);
		expect(
			shouldDeliverToListener(messagesListener, "status_change", "n1", undefined, undefined),
		).toBe(true);
	});

	test("request-scoped frames only reach the requesting subscription", () => {
		// A streaming_snapshot requested by the messages subscription (handle 2).
		expect(shouldDeliverToListener(messagesListener, "streaming_snapshot", "n1", "req-2", 2)).toBe(
			true,
		);
		// The sibling list subscription (handle 1) must NOT receive it.
		expect(shouldDeliverToListener(listListener, "streaming_snapshot", "n1", "req-2", 2)).toBe(
			false,
		);
	});

	test("subscription-scoped frames with an unknown target are dropped", () => {
		expect(
			shouldDeliverToListener(messagesListener, "catch_up", "n1", "req-stale", undefined),
		).toBe(false);
	});

	test("business requestId frames are realtime frames when no subscriptionRequestId is present", () => {
		expect(
			shouldDeliverToListener(messagesListener, "permission_resolved", "n1", undefined, undefined),
		).toBe(true);
	});

	test("request-scoped delivery still applies the type/narrator filter", () => {
		// Correct subscription, but the narrator does not match.
		expect(
			shouldDeliverToListener(
				{ narratorIds: ["other"], subscriptionId: 2 },
				"streaming_snapshot",
				"n1",
				"req-2",
				2,
			),
		).toBe(false);
	});

	test("exclude types also apply to request-scoped frames", () => {
		expect(
			shouldDeliverToListener(
				{ narratorIds: ["n1"], subscriptionId: 2, excludeTypes: ["streaming_snapshot"] },
				"streaming_snapshot",
				"n1",
				"req-2",
				2,
			),
		).toBe(false);
		expect(
			shouldDeliverToListener(
				{ narratorIds: ["n1"], subscriptionId: 2, excludeTypes: ["catch_up"] },
				"streaming_snapshot",
				"n1",
				"req-2",
				2,
			),
		).toBe(true);
	});
});

type StagedCoordinateInternals = {
	cursor?: {
		parentLastMessageId?: string;
		childAnchors?: Array<{
			parentToolUseId: string;
			narratorId?: string;
			lastMessageId?: string;
		}>;
	};
	messageVersion?: number;
	realtimeEpoch: number;
};

type StagedCatchUpRecordInternals = {
	versioned?: StagedCoordinateInternals;
	realtime?: StagedCoordinateInternals;
};

type CatchUpManagerInternals = {
	catchUpCursors: Map<string, StagedCoordinateInternals["cursor"]>;
	legacyCatchUpCursors: Set<string>;
	messageVersions: Map<string, number>;
	authoritativeMessageVersions: Map<string, number>;
	narratorRefCounts: Map<string, Set<number>>;
	pendingMessageReconciles: Set<string>;
	stagedCatchUpStates: Map<string, StagedCatchUpRecordInternals>;
};

function catchUpInternals(manager: NarratorWSManager): CatchUpManagerInternals {
	return manager as unknown as CatchUpManagerInternals;
}

function dispatch(manager: NarratorWSManager, data: Record<string, unknown>): void {
	(
		manager as unknown as {
			_dispatchImmediate: (frame: Record<string, unknown>) => void;
		}
	)._dispatchImmediate(data);
}

function registerRequest(
	manager: NarratorWSManager,
	handle: ReturnType<NarratorWSManager["subscribe"]>,
) {
	return (
		manager as unknown as {
			_registerRequest: (subscription: typeof handle) => string | undefined;
		}
	)._registerRequest(handle);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("message version tracking", () => {
	test("bumps one raw persisted frame once before two-listener fan-out", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 4);
		const observed: number[] = [];
		manager.addListener({ narratorIds: ["n1"] }, () => {
			observed.push(manager.getMessageVersion("n1") ?? -1);
		});
		manager.addListener({ narratorIds: ["n1"] }, () => {
			observed.push(manager.getMessageVersion("n1") ?? -1);
		});

		dispatch(manager, { type: "message", narratorId: "n1", message: { id: "m5" } });

		expect(observed).toEqual([5, 5]);
		expect(manager.getMessageVersion("n1")).toBe(5);
	});

	test("authoritative updates can correct an optimistic version downward", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 8);
		manager.bumpMessageVersion("n1");
		manager.bumpMessageVersion("n1");
		expect(manager.getMessageVersion("n1")).toBe(10);

		manager.updateMessageVersion("n1", 9);
		expect(manager.getMessageVersion("n1")).toBe(9);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(9);
	});

	test("ignores an authoritative response older than the accepted server baseline", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 8);
		manager.updateMessageVersion("n1", 11);
		manager.updateMessageVersion("n1", 9);

		expect(manager.getMessageVersion("n1")).toBe(11);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(11);
	});

	test("does not let a late sync_ok erase a persisted frame received after its request", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 5);
		const handle = manager.subscribe(["n1"], { kind: "messages" });
		const requestId = registerRequest(manager, handle);
		expect(requestId).toBeString();

		dispatch(manager, { type: "message", narratorId: "n1", message: { id: "m6" } });
		manager.updateMessageVersion("n1", 5, { requestId });

		expect(manager.getMessageVersion("n1")).toBe(6);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(5);
	});

	test("accepts a truly newer authoritative response even after the request crossed a frame", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 5);
		const handle = manager.subscribe(["n1"], { kind: "messages" });
		const requestId = registerRequest(manager, handle);

		dispatch(manager, { type: "message", narratorId: "n1", message: { id: "m6" } });
		manager.updateMessageVersion("n1", 7, { requestId });

		expect(manager.getMessageVersion("n1")).toBe(7);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(7);
	});

	test("compact success consumes an authoritative version without double counting", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 10);

		dispatch(manager, { type: "message", narratorId: "n1", message: { id: "compact" } });
		dispatch(manager, {
			type: "message_updated",
			narratorId: "n1",
			message: { id: "compact" },
		});
		dispatch(manager, { type: "compact_done", narratorId: "n1", messageVersion: 12 });

		expect(manager.getMessageVersion("n1")).toBe(12);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(12);
	});

	test("compact cancellation corrects hidden finalize and delete persistence steps", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 20);

		dispatch(manager, { type: "message", narratorId: "n1", message: { id: "compact" } });
		// finalizeCompactingMessage(status=failed) advances the server version without
		// a separate frame on the ordinary cancellation path.
		dispatch(manager, {
			type: "messages_deleted",
			narratorId: "n1",
			deletedMessageIds: ["compact"],
		});
		dispatch(manager, { type: "compact_done", narratorId: "n1", messageVersion: 23 });

		expect(manager.getMessageVersion("n1")).toBe(23);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(23);
	});

	test("compact authoritative correction preserves a newer racing persisted frame", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 30);
		dispatch(manager, { type: "message", narratorId: "n1", message: { id: "compact" } });
		dispatch(manager, {
			type: "message_updated",
			narratorId: "n1",
			message: { id: "compact" },
		});
		dispatch(manager, { type: "user_message", narratorId: "n1", message: { id: "m33" } });

		dispatch(manager, { type: "compact_done", narratorId: "n1", messageVersion: 32 });

		expect(manager.getMessageVersion("n1")).toBe(33);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(32);
	});

	test("last-reference cleanup removes optimistic and authoritative versions together", () => {
		const manager = new NarratorWSManager();
		const first = manager.subscribe(["n1"], { kind: "messages" });
		const second = manager.subscribe(["n1"], { kind: "panel" });
		manager.updateMessageVersion("n1", 6);
		manager.bumpMessageVersion("n1");

		manager.unsubscribe(first);
		expect(manager.getMessageVersion("n1")).toBe(7);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(6);

		manager.unsubscribe(second);
		expect(manager.getMessageVersion("n1")).toBeUndefined();
		expect(catchUpInternals(manager).authoritativeMessageVersions.has("n1")).toBe(false);
		expect(catchUpInternals(manager).narratorRefCounts.has("n1")).toBe(false);
	});
});

describe("structural catch-up state", () => {
	test("seeds subscribe and sync_check with only the canonical catch-up cursor", () => {
		const manager = new NarratorWSManager();
		const cursor = {
			parentLastMessageId: "parent-4",
			childAnchors: [
				{
					parentToolUseId: "tool-child",
					narratorId: "subagent-1",
					lastMessageId: "child-4",
				},
			],
		};
		const handle = manager.subscribe(["n1"], { kind: "messages", catchUpCursor: cursor });
		const sent: Array<Record<string, unknown>> = [];
		const internals = manager as unknown as {
			ws: { readyState: number; send: (payload: string) => void };
			_sendSubscribe: (subscription: typeof handle, narratorIds: string[]) => void;
		};
		internals.ws = {
			readyState: WebSocket.OPEN,
			send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>),
		};

		internals._sendSubscribe(handle, ["n1"]);
		manager.checkSync("n1");

		expect(sent).toHaveLength(2);
		for (const message of sent) {
			expect(message.catchUpCursor).toEqual(cursor);
			expect(message).not.toHaveProperty("lastMessageId");
		}
	});

	test("late seed is used by the reconnect subscribe frame without replacing live state", async () => {
		const manager = new NarratorWSManager();
		manager.subscribe(["n1"], { kind: "messages" });
		const initial = {
			parentLastMessageId: "parent-initial",
			childAnchors: [{ parentToolUseId: "tool-1", lastMessageId: "child-initial" }],
		};
		expect(manager.seedCatchUpCursor("n1", initial)).toBe(true);
		manager.updateCatchUpCursor("n1", {
			parentLastMessageId: "parent-live",
			childAnchors: [{ parentToolUseId: "tool-1", lastMessageId: "child-live" }],
		});
		expect(manager.seedCatchUpCursor("n1", { parentLastMessageId: "parent-stale" })).toBe(false);

		const sent: Array<Record<string, unknown>> = [];
		const internals = manager as unknown as {
			ws: { readyState: number; send: (payload: string) => void };
			_restoreSubscriptions: () => void;
		};
		internals.ws = {
			readyState: WebSocket.OPEN,
			send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>),
		};
		internals._restoreSubscriptions();
		await Promise.resolve();

		expect(sent).toHaveLength(1);
		expect(sent[0].catchUpCursor).toEqual({
			parentLastMessageId: "parent-live",
			childAnchors: [{ parentToolUseId: "tool-1", lastMessageId: "child-live" }],
		});
	});

	test("stages cursor and version until the manifest commits atomically", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		manager.updateCatchUpCursor("n1", { parentLastMessageId: "old-message" });
		manager.updateMessageVersion("n1", 4);

		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "new-message" },
			messageVersion: 5,
		});

		expect(internals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("old-message");
		expect(internals.messageVersions.get("n1")).toBe(4);
		expect(internals.pendingMessageReconciles.has("n1")).toBe(true);

		manager.commitMessageReconcile("n1", 6);
		expect(internals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("new-message");
		expect(internals.messageVersions.get("n1")).toBe(6);
		expect(internals.pendingMessageReconciles.has("n1")).toBe(false);
		expect(internals.stagedCatchUpStates.has("n1")).toBe(false);
	});

	test("atomically commits a snapshot version with its fallback cursor", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		const token = manager.markMessageReconcilePending("n1");
		const fallback = {
			parentLastMessageId: "snapshot-parent",
			childAnchors: [
				{
					parentToolUseId: "snapshot-tool",
					narratorId: "snapshot-child-narrator",
					lastMessageId: "snapshot-child",
				},
			],
		};

		expect(manager.commitMessageReconcile("n1", 7, token, fallback)).toBe(true);
		expect(internals.messageVersions.get("n1")).toBe(7);
		expect(internals.authoritativeMessageVersions.get("n1")).toBe(7);
		expect(internals.catchUpCursors.get("n1")).toEqual(fallback);
	});

	test("replaces a previous lifecycle cursor with the new REST snapshot before reconnect", async () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		const previousCursor = {
			parentLastMessageId: "previous-parent",
			childAnchors: [
				{
					parentToolUseId: "previous-tool",
					narratorId: "previous-child-narrator",
					lastMessageId: "previous-child",
				},
			],
		};
		const previousHandle = manager.subscribe(["n1"], {
			kind: "messages",
			catchUpCursor: previousCursor,
		});
		manager.updateMessageVersion("n1", 4);
		manager.unsubscribe(previousHandle);

		expect(manager.getMessageVersion("n1")).toBeUndefined();
		expect(internals.legacyCatchUpCursors.has("n1")).toBe(true);
		expect(internals.catchUpCursors.get("n1")).toEqual(previousCursor);

		const nextHandle = manager.subscribe(["n1"], { kind: "messages" });
		const snapshotCursor = {
			parentLastMessageId: "snapshot-parent",
			childAnchors: [
				{
					parentToolUseId: "snapshot-tool",
					narratorId: "snapshot-child-narrator",
					lastMessageId: "snapshot-child",
				},
			],
		};
		const token = manager.markMessageReconcilePending("n1");
		expect(manager.commitMessageReconcile("n1", 9, token, snapshotCursor)).toBe(true);
		expect(internals.legacyCatchUpCursors.has("n1")).toBe(false);
		expect(internals.catchUpCursors.get("n1")).toEqual(snapshotCursor);

		const sent: Array<Record<string, unknown>> = [];
		const privateManager = manager as unknown as {
			ws: { readyState: number; send: (payload: string) => void };
			_restoreSubscriptions: () => void;
		};
		privateManager.ws = {
			readyState: WebSocket.OPEN,
			send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>),
		};
		privateManager._restoreSubscriptions();
		await Promise.resolve();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			type: "subscribe",
			narratorIds: ["n1"],
			version: 9,
			catchUpCursor: snapshotCursor,
		});
		manager.unsubscribe(nextHandle);
	});

	test("a current-lifecycle staged cursor still wins over the snapshot fallback", () => {
		const manager = new NarratorWSManager();
		const previousHandle = manager.subscribe(["n1"], {
			kind: "messages",
			catchUpCursor: { parentLastMessageId: "previous-parent" },
		});
		manager.unsubscribe(previousHandle);
		manager.subscribe(["n1"], { kind: "messages" });
		const token = manager.markMessageReconcilePending("n1");
		const stagedCursor = {
			parentLastMessageId: "live-parent",
			childAnchors: [
				{
					parentToolUseId: "live-tool",
					narratorId: "live-child-narrator",
					lastMessageId: "live-child",
				},
			],
		};
		manager.stageCatchUpState("n1", {
			cursor: stagedCursor,
			messageVersion: 8,
		});

		expect(
			manager.commitMessageReconcile("n1", 8, token, {
				parentLastMessageId: "snapshot-parent",
				childAnchors: [{ parentToolUseId: "snapshot-tool", lastMessageId: "snapshot-child" }],
			}),
		).toBe(true);
		expect(catchUpInternals(manager).catchUpCursors.get("n1")).toEqual(stagedCursor);
	});

	test("staged and canonical cursors take priority over a snapshot fallback", () => {
		const canonicalManager = new NarratorWSManager();
		const canonicalInternals = catchUpInternals(canonicalManager);
		const canonical = { parentLastMessageId: "canonical" };
		canonicalManager.seedCatchUpCursor("n1", canonical);
		const canonicalToken = canonicalManager.markMessageReconcilePending("n1");
		expect(
			canonicalManager.commitMessageReconcile("n1", 3, canonicalToken, {
				parentLastMessageId: "fallback",
			}),
		).toBe(true);
		expect(canonicalInternals.catchUpCursors.get("n1")).toEqual(canonical);

		const stagedManager = new NarratorWSManager();
		const stagedInternals = catchUpInternals(stagedManager);
		stagedManager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "staged" },
			messageVersion: 4,
		});
		expect(stagedManager.seedCatchUpCursor("n1", { parentLastMessageId: "late-seed" })).toBe(false);
		const stagedToken = stagedManager.getMessageReconcileToken("n1");
		expect(
			stagedManager.commitMessageReconcile("n1", 4, stagedToken, {
				parentLastMessageId: "fallback",
			}),
		).toBe(true);
		expect(stagedInternals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("staged");
	});

	test("keeps cursor and messageVersion from one snapshot coordinate", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		manager.noteRealtimeEvent("n1");
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "m12" },
			messageVersion: 12,
			realtimeEpoch: 1,
		});
		manager.noteRealtimeEvent("n1");
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "m13" },
			realtimeEpoch: 2,
		});

		const staged = internals.stagedCatchUpStates.get("n1");
		expect(staged?.versioned?.messageVersion).toBe(12);
		expect(staged?.versioned?.cursor?.parentLastMessageId).toBe("m12");
		expect(staged?.realtime?.realtimeEpoch).toBe(2);
		expect(staged?.realtime?.cursor?.parentLastMessageId).toBe("m13");
	});

	test("does not commit an unversioned realtime cursor over a versioned cursor", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		manager.updateCatchUpCursor("n1", { parentLastMessageId: "m11" });
		manager.updateMessageVersion("n1", 11);
		manager.noteRealtimeEvent("n1");
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "m12" },
			messageVersion: 12,
			realtimeEpoch: 1,
		});
		const token = manager.getMessageReconcileToken("n1");
		manager.noteRealtimeEvent("n1");
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "m13" },
			realtimeEpoch: 2,
		});

		expect(manager.commitMessageReconcile("n1", 12, token)).toBe(false);
		expect(internals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("m11");
		expect(manager.isMessageReconcilePending("n1")).toBe(true);

		const nextToken = manager.markMessageReconcilePending("n1", { restart: true });
		expect(manager.commitMessageReconcile("n1", 13, nextToken)).toBe(true);
		expect(internals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("m13");
		expect(internals.messageVersions.get("n1")).toBe(13);
	});

	test("pairs a staged realtime cursor with a later authoritative version-only snapshot", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		manager.updateMessageVersion("n1", 11);
		manager.noteRealtimeEvent("n1");
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "m12" },
			realtimeEpoch: 1,
		});
		manager.updateMessageVersion("n1", 12);

		const nextToken = manager.markMessageReconcilePending("n1", { restart: true });
		expect(manager.commitMessageReconcile("n1", 12, nextToken)).toBe(true);
		expect(internals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("m12");
		expect(internals.messageVersions.get("n1")).toBe(12);
	});

	test("version-only sync_ok preserves a staged subagent child anchor", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		const cursor = {
			parentLastMessageId: "parent-v4",
			childAnchors: [
				{
					parentToolUseId: "tool-child",
					narratorId: "subagent-1",
					lastMessageId: "child-v4",
				},
			],
		};
		manager.stageCatchUpState("n1", { cursor, messageVersion: 4 });
		const token = manager.getMessageReconcileToken("n1");

		// A newer sync_ok has no cursor of its own. It must not erase the
		// versioned coordinate that will be committed after the manifest reload.
		manager.updateMessageVersion("n1", 5);
		expect(internals.stagedCatchUpStates.get("n1")?.versioned).toMatchObject({
			messageVersion: 5,
			cursor,
		});
		expect(manager.commitMessageReconcile("n1", 5, token)).toBe(true);
		expect(internals.catchUpCursors.get("n1")).toEqual(cursor);
		expect(internals.messageVersions.get("n1")).toBe(5);
	});

	test("version-only sync_ok updates a committed version without dropping child anchors", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		const cursor = {
			parentLastMessageId: "parent-v4",
			childAnchors: [
				{
					parentToolUseId: "tool-child",
					narratorId: "subagent-1",
					lastMessageId: "child-v4",
				},
			],
		};
		manager.updateCatchUpCoordinate("n1", { cursor, messageVersion: 4 });
		manager.updateMessageVersion("n1", 5);
		expect(internals.catchUpCursors.get("n1")).toEqual(cursor);
		expect(internals.messageVersions.get("n1")).toBe(5);
	});

	test("reconcile commit cannot clear a usable committed child anchor", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		const cursor = {
			parentLastMessageId: "parent-v4",
			childAnchors: [
				{
					parentToolUseId: "tool-child",
					narratorId: "subagent-1",
					lastMessageId: "child-v4",
				},
			],
		};
		manager.updateCatchUpCoordinate("n1", { cursor, messageVersion: 4 });
		const token = manager.markMessageReconcilePending("n1");
		manager.updateMessageVersion("n1", 5);

		expect(manager.commitMessageReconcile("n1", 5, token)).toBe(true);
		expect(internals.catchUpCursors.get("n1")).toEqual(cursor);
		expect(internals.messageVersions.get("n1")).toBe(5);
	});

	test("keeps the newest staged coordinates and clears them on full reload", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		manager.updateMessageVersion("n1", 1);
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "first" },
			messageVersion: 2,
		});
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "second" },
			messageVersion: 3,
		});

		expect(internals.stagedCatchUpStates.get("n1")?.versioned?.cursor?.parentLastMessageId).toBe(
			"second",
		);
		expect(internals.stagedCatchUpStates.get("n1")?.versioned?.messageVersion).toBe(3);

		manager.clearCatchUpState("n1");
		expect(internals.pendingMessageReconciles.has("n1")).toBe(false);
		expect(internals.stagedCatchUpStates.has("n1")).toBe(false);
		expect(internals.catchUpCursors.has("n1")).toBe(false);
		expect(internals.messageVersions.has("n1")).toBe(false);
		expect(internals.authoritativeMessageVersions.has("n1")).toBe(false);
	});

	test("advances the realtime epoch before listener fan-out", () => {
		const manager = new NarratorWSManager();
		let observedEpoch = 0;
		manager.addListener({ narratorIds: ["n1"] }, () => {
			observedEpoch = manager.getRealtimeEpoch("n1");
		});
		(
			manager as unknown as { _dispatchImmediate: (data: Record<string, unknown>) => void }
		)._dispatchImmediate({
			type: "message",
			narratorId: "n1",
		});
		expect(observedEpoch).toBe(1);
	});

	test("keeps a reconcile token valid across pure tool-state events", () => {
		const manager = new NarratorWSManager();
		manager.markMessageReconcilePending("n1");
		const token = manager.getMessageReconcileToken("n1");
		const dispatch = (type: string) =>
			(
				manager as unknown as {
					_dispatchImmediate: (data: Record<string, unknown>) => void;
				}
			)._dispatchImmediate({ type, narratorId: "n1" });

		dispatch("tool_started");
		dispatch("permission_request");
		dispatch("tool_completed");

		expect(manager.getRealtimeEpoch("n1")).toBe(3);
		expect(manager.isMessageReconcileTokenCurrent("n1", token)).toBe(true);
	});

	test("invalidates a deferred manifest commit when a structural event advances", async () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 4);
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "new-message" },
			messageVersion: 5,
		});
		const token = manager.getMessageReconcileToken("n1");
		const response = deferred<number>();
		const commit = response.promise.then((version) =>
			manager.commitMessageReconcile("n1", version, token),
		);

		(
			manager as unknown as {
				_dispatchImmediate: (data: Record<string, unknown>) => void;
			}
		)._dispatchImmediate({ type: "message", narratorId: "n1" });
		response.resolve(5);
		expect(await commit).toBe(false);
		expect(manager.isMessageReconcilePending("n1")).toBe(true);
		expect(catchUpInternals(manager).messageVersions.get("n1")).toBe(5);
	});

	test("reconcile commits an authoritative version over a higher optimistic current", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 7);
		const token = manager.markMessageReconcilePending("n1");
		manager.bumpMessageVersion("n1");
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "m7" },
			messageVersion: 7,
		});

		expect(manager.getMessageVersion("n1")).toBe(8);
		expect(manager.commitMessageReconcile("n1", 7, token)).toBe(true);
		expect(manager.getMessageVersion("n1")).toBe(7);
		expect(catchUpInternals(manager).authoritativeMessageVersions.get("n1")).toBe(7);
		expect(manager.isMessageReconcilePending("n1")).toBe(false);
	});

	test("rejects a staged version newer than the range manifest", () => {
		const manager = new NarratorWSManager();
		manager.stageCatchUpState("n1", { messageVersion: 9 });
		const token = manager.getMessageReconcileToken("n1");
		expect(manager.canCommitMessageReconcile("n1", 8, token)).toBe(false);
		expect(manager.commitMessageReconcile("n1", 8, token)).toBe(false);
		expect(manager.isMessageReconcilePending("n1")).toBe(true);
	});

	test("unmount/full-reload cleanup releases the pending sync gate", () => {
		const manager = new NarratorWSManager();
		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "staged" },
			messageVersion: 4,
		});
		expect(manager.isMessageReconcilePending("n1")).toBe(true);
		manager.clearMessageReconcilePending("n1");
		expect(manager.isMessageReconcilePending("n1")).toBe(false);
		expect(catchUpInternals(manager).stagedCatchUpStates.has("n1")).toBe(false);
	});
});

/**
 * TEMPORARY: injection point for the mock-stream harness
 * (components/narrator/mock/, see its README-REMOVAL.md). Delete this block with
 * `dispatchLocalFrame` itself.
 */
describe("dispatchLocalFrame (synthetic frames)", () => {
	test("delivers to matching listeners using the same filter as real frames", () => {
		const manager = new NarratorWSManager();
		const matched: string[] = [];
		const wrongNarrator: string[] = [];
		const wrongType: string[] = [];
		manager.addListener({ narratorIds: ["n1"] }, (frame) => {
			matched.push(frame.type as string);
		});
		manager.addListener({ narratorIds: ["n2"] }, (frame) => {
			wrongNarrator.push(frame.type as string);
		});
		manager.addListener({ narratorIds: ["n1"], types: ["message"] }, (frame) => {
			wrongType.push(frame.type as string);
		});

		manager.dispatchLocalFrame({ type: "stream_event", narratorId: "n1", event: {} });

		expect(matched).toEqual(["stream_event"]);
		expect(wrongNarrator).toEqual([]);
		expect(wrongType).toEqual([]);
	});

	test("leaves sync bookkeeping untouched so no catch_up/full_reload is provoked", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 7);
		const before = {
			version: manager.getMessageVersion("n1"),
			realtimeEpoch: manager.getRealtimeEpoch("n1"),
			structuralEpoch: manager.getStructuralEpoch("n1"),
		};

		// Frame types that WOULD bump every counter on the real path.
		manager.dispatchLocalFrame({ type: "message", narratorId: "n1", message: { id: "mock" } });
		manager.dispatchLocalFrame({ type: "tool_completed", narratorId: "n1", toolUseId: "t1" });

		expect(manager.getMessageVersion("n1")).toBe(before.version);
		expect(manager.getRealtimeEpoch("n1")).toBe(before.realtimeEpoch);
		expect(manager.getStructuralEpoch("n1")).toBe(before.structuralEpoch);
	});

	test("never routes to a request-scoped listener awaiting a snapshot", () => {
		const manager = new NarratorWSManager();
		const handle = manager.subscribe(["n1"], { kind: "messages" });
		const received: string[] = [];
		// A snapshot/catch-up consumer binds itself to its subscription id; a
		// synthetic frame carries no requestId, so it is delivered by the normal
		// type/narrator filter rather than being scoped to one request.
		manager.addListener({ narratorIds: ["n1"], subscriptionId: handle._id }, (frame) => {
			received.push(frame.type as string);
		});

		manager.dispatchLocalFrame({ type: "tool_output", narratorId: "n1", toolUseId: "t1" });

		expect(received).toEqual(["tool_output"]);
	});

	test("a listener throwing does not stop the remaining fan-out", () => {
		const manager = new NarratorWSManager();
		const reached: string[] = [];
		manager.addListener({ narratorIds: ["n1"] }, () => {
			throw new Error("listener boom");
		});
		manager.addListener({ narratorIds: ["n1"] }, (frame) => {
			reached.push(frame.type as string);
		});

		expect(() =>
			manager.dispatchLocalFrame({ type: "streaming_reset", narratorId: "n1" }),
		).not.toThrow();
		expect(reached).toEqual(["streaming_reset"]);
	});
});

// ---------------------------------------------------------------------------
// Reconnect resilience + listener-failure recovery
// ---------------------------------------------------------------------------

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: MockWebSocket[] = [];
	readonly url: string;
	readyState = MockWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	readonly sent: string[] = [];
	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}
	send(payload: string): void {
		this.sent.push(payload);
	}
	close(code = 1000): void {
		if (this.readyState === MockWebSocket.CLOSED) return;
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code });
	}
}

interface ManagerReconnectInternals {
	reconnectAttempts: number;
	reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	_scheduleReconnect: () => void;
}

function reconnectInternals(manager: NarratorWSManager): ManagerReconnectInternals {
	return manager as unknown as ManagerReconnectInternals;
}

interface GlobalPatch {
	key: string;
	had: boolean;
	previous: unknown;
}

function patchGlobal(key: string, value: unknown): GlobalPatch {
	const g = globalThis as Record<string, unknown>;
	const patch = { key, had: Object.hasOwn(g, key), previous: g[key] };
	g[key] = value;
	return patch;
}

function restoreGlobal(patch: GlobalPatch): void {
	const g = globalThis as Record<string, unknown>;
	if (patch.had) g[patch.key] = patch.previous;
	else delete g[patch.key];
}

/** Swap in the minimal browser surface the manager's connect path touches. */
function withMockBrowserGlobals(fn: () => void): void {
	const patches = [
		patchGlobal("WebSocket", MockWebSocket),
		patchGlobal("window", {
			addEventListener: () => {},
			removeEventListener: () => {},
			location: {
				protocol: "http:",
				hostname: "localhost",
				host: "localhost:3000",
				port: "3000",
			},
		}),
		patchGlobal("document", {
			addEventListener: () => {},
			removeEventListener: () => {},
			visibilityState: "visible",
		}),
		patchGlobal("localStorage", {
			getItem: (key: string) => (key === "narrafork_token" ? "test-token" : null),
			setItem: () => {},
			removeItem: () => {},
		}),
	];
	MockWebSocket.instances = [];
	try {
		fn();
	} finally {
		for (const patch of patches.reverse()) restoreGlobal(patch);
		MockWebSocket.instances = [];
	}
}

function withSilencedWarn(fn: () => void): void {
	const original = console.warn;
	console.warn = () => {};
	try {
		fn();
	} finally {
		console.warn = original;
	}
}

describe("reconnect resilience", () => {
	test("reconnects after a graceful server shutdown (1001) instead of never retrying", () => {
		withMockBrowserGlobals(() => {
			const manager = new NarratorWSManager();
			try {
				manager.connect();
				const ws = MockWebSocket.instances.at(-1);
				expect(ws).toBeDefined();
				if (!ws) return;
				ws.readyState = MockWebSocket.OPEN;
				ws.onopen?.();
				expect(manager.connected).toBe(true);

				// The server closed every connection gracefully (restart / auto-update).
				// Previously this returned early and the client only recovered when a
				// visibility or network event happened to fire — a foreground tab waiting
				// for output simply went stale forever.
				ws.readyState = MockWebSocket.CLOSED;
				ws.onclose?.({ code: 1001 });

				expect(manager.connected).toBe(false);
				const internals = reconnectInternals(manager);
				expect(internals.reconnectTimer).toBeDefined();
				// A graceful shutdown starts a FRESH backoff cycle: a restart is usually
				// back within seconds, so the first probe fires after the 1s base delay.
				expect(internals.reconnectAttempts).toBe(1);
			} finally {
				manager.disconnect();
			}
		});
	});

	test("an abnormal close keeps the existing backoff position", () => {
		withMockBrowserGlobals(() => {
			const manager = new NarratorWSManager();
			try {
				manager.connect();
				const ws = MockWebSocket.instances.at(-1);
				if (!ws) return;
				ws.readyState = MockWebSocket.OPEN;
				ws.onopen?.();
				const internals = reconnectInternals(manager);
				internals.reconnectAttempts = 5;

				ws.readyState = MockWebSocket.CLOSED;
				ws.onclose?.({ code: 1006 });

				expect(internals.reconnectTimer).toBeDefined();
				expect(internals.reconnectAttempts).toBe(6);
			} finally {
				manager.disconnect();
			}
		});
	});

	test("keeps a capped reconnect timer running past the old give-up limit", () => {
		withMockBrowserGlobals(() => {
			const manager = new NarratorWSManager();
			try {
				const internals = reconnectInternals(manager);
				// Beyond the removed MAX_RECONNECT_ATTEMPTS=50 give-up: the client must
				// keep probing (delay saturated at the 30s cap) so a long server outage
				// still recovers unattended instead of stranding the message stream.
				internals.reconnectAttempts = 500;
				internals._scheduleReconnect();
				expect(internals.reconnectTimer).toBeDefined();
				expect(internals.reconnectAttempts).toBe(501);
			} finally {
				manager.disconnect();
			}
		});
	});
});

describe("listener failure recovery", () => {
	test("a listener failure on a persisted-history frame resets committed sync anchors", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 7);
		manager.updateCatchUpCursor("n1", { parentLastMessageId: "m7" });
		manager.addListener({ narratorIds: ["n1"] }, () => {
			throw new Error("listener boom");
		});

		// The frame bumps the optimistic version BEFORE the fan-out runs, so a failed
		// consume would otherwise leave version==server while content is missing: the
		// next sync_check compares equal and the server never replays the lost frame.
		withSilencedWarn(() => {
			dispatch(manager, { type: "message", narratorId: "n1", message: { id: "m8" } });
		});

		// Dropping every committed anchor makes the next sync_check report version 0
		// with no cursor, which the server answers with a full reload.
		expect(manager.getMessageVersion("n1")).toBeUndefined();
		const internals = catchUpInternals(manager);
		expect(internals.catchUpCursors.has("n1")).toBe(false);
		expect(internals.authoritativeMessageVersions.has("n1")).toBe(false);
	});

	test("a listener failure on a non-history frame keeps the committed anchors", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 7);
		manager.updateCatchUpCursor("n1", { parentLastMessageId: "m7" });
		manager.addListener({ narratorIds: ["n1"] }, () => {
			throw new Error("listener boom");
		});

		withSilencedWarn(() => {
			dispatch(manager, { type: "status_change", narratorId: "n1", status: "working" });
		});

		expect(manager.getMessageVersion("n1")).toBe(7);
		expect(catchUpInternals(manager).catchUpCursors.has("n1")).toBe(true);
	});

	test("a throwing listener does not prevent delivery to the remaining listeners", () => {
		const manager = new NarratorWSManager();
		const reached: string[] = [];
		manager.addListener({ narratorIds: ["n1"] }, () => {
			throw new Error("listener boom");
		});
		manager.addListener({ narratorIds: ["n1"] }, (frame) => {
			reached.push(frame.type as string);
		});

		withSilencedWarn(() => {
			dispatch(manager, { type: "message", narratorId: "n1", message: { id: "m9" } });
		});

		expect(reached).toEqual(["message"]);
	});
});
