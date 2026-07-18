import { describe, expect, test } from "bun:test";
import { coerceMessageReplacementAliases } from "../hooks/useNarratorWS";
import {
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
		expect(coerceMessageReplacementAliases({ type: "messages_deleted" })).toBeUndefined();
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
	lastMessageIds: Map<string, string>;
	messageVersions: Map<string, number>;
	pendingMessageReconciles: Set<string>;
	stagedCatchUpStates: Map<string, StagedCatchUpRecordInternals>;
};

function catchUpInternals(manager: NarratorWSManager): CatchUpManagerInternals {
	return manager as unknown as CatchUpManagerInternals;
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

describe("structural catch-up state", () => {
	test("stages cursor and version until the manifest commits atomically", () => {
		const manager = new NarratorWSManager();
		const internals = catchUpInternals(manager);
		manager.updateCatchUpCursor("n1", { parentLastMessageId: "old-message" });
		manager.updateMessageVersion("n1", 4);

		manager.stageCatchUpState("n1", {
			cursor: { parentLastMessageId: "new-message" },
			lastMessageId: "new-message",
			messageVersion: 5,
		});

		expect(internals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("old-message");
		expect(internals.messageVersions.get("n1")).toBe(4);
		expect(internals.pendingMessageReconciles.has("n1")).toBe(true);

		manager.commitMessageReconcile("n1", 6);
		expect(internals.catchUpCursors.get("n1")?.parentLastMessageId).toBe("new-message");
		expect(internals.lastMessageIds.get("n1")).toBe("new-message");
		expect(internals.messageVersions.get("n1")).toBe(6);
		expect(internals.pendingMessageReconciles.has("n1")).toBe(false);
		expect(internals.stagedCatchUpStates.has("n1")).toBe(false);
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
		expect(catchUpInternals(manager).messageVersions.get("n1")).toBe(4);
	});

	test("does not let pending realtime version bumps outrun the manifest", () => {
		const manager = new NarratorWSManager();
		manager.updateMessageVersion("n1", 7);
		manager.markMessageReconcilePending("n1");
		manager.bumpMessageVersion("n1");
		expect(manager.getMessageVersion("n1")).toBe(7);
		manager.clearMessageReconcilePending("n1");
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
