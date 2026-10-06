import { describe, expect, mock, test } from "bun:test";
import { beginAgentReplyWaitRun } from "../agent-reply-waiter";
import {
	attachActiveSendDeliveryTargets,
	attachSendTargetDetails,
	broadcastSendDeliveryResolved,
	loadSendTargetDetails,
	SEND_DELIVERY_TARGETS_FIELD,
} from "../send-delivery-resolution";

function message(owner = "owner", toolUseId = "send-tool") {
	return {
		narratorId: owner,
		toolCalls: [{ id: "row", narratorId: owner, toolUseId }],
		contentJson: [
			{
				type: "tool_use",
				id: toolUseId,
				name: "Send",
				tcId: "row",
				status: "running",
				outputJson: null,
			},
		],
		children: [],
	};
}

describe("Send display hydration", () => {
	test("bound child receipts also reach the parent with the original subtree placement", async () => {
		const realDb = { ...(await import("../../db")) };
		const realWs = { ...(await import("../../websocket/narrator-ws")) };
		const { getTestDb } = await import("../../../tests/setup");
		const { narrators, narratorMessages, narratorToolCalls } = await import("../../db/schema");
		const { db, sqlite } = getTestDb();
		const frames: Array<{ target: string; frame: unknown }> = [];
		mock.module("../../db", () => ({ ...realDb, db, sqlite }));
		mock.module("../../websocket/narrator-ws", () => ({
			...realWs,
			broadcastToNarrator: (target: string, frame: unknown) => {
				frames.push({ target, frame });
			},
		}));
		try {
			const now = "2026-09-09T00:00:00.000Z";
			await db.insert(narrators).values([
				{ id: "parent", variant: "primary", createdAt: now, updatedAt: now },
				{
					id: "child",
					variant: "subagent:general",
					parentNarratorId: "parent",
					createdAt: now,
					updatedAt: now,
				},
			]);
			await db.insert(narratorMessages).values({
				id: "source-message",
				narratorId: "child",
				parentToolUseId: "origin-agent",
				role: "assistant",
				contentJson: [],
				createdAt: now,
			});
			await db.insert(narratorToolCalls).values({
				id: "source-call",
				narratorId: "child",
				messageId: "source-message",
				toolUseId: "send-child",
				toolName: "Send",
				executionAttempt: 2,
				status: "success",
				createdAt: now,
			});
			const targets = [{ id: "recipient", deliveryMessageId: "receipt", injectionConsumedAt: now }];
			await broadcastSendDeliveryResolved("child", "send-child", targets, {
				toolCallId: "source-call",
				attempt: 2,
			});
			expect(frames.map((entry) => entry.target)).toEqual(["child", "parent"]);
			expect(frames[1].frame).toMatchObject({
				narratorId: "parent",
				parentToolUseId: "origin-agent",
				targets,
			});
			frames.length = 0;
			await broadcastSendDeliveryResolved("child", "send-child", targets, {
				toolCallId: "source-call",
				attempt: 1,
			});
			expect(frames.map((entry) => entry.target)).toEqual(["child"]);
		} finally {
			mock.module("../../db", () => realDb);
			mock.module("../../websocket/narrator-ws", () => realWs);
			sqlite.close();
		}
	});
	test("finished and running rows batch names and receipts without touching tool output", async () => {
		const finished = {
			narratorId: "owner",
			contentJson: [
				{
					type: "tool_use",
					name: "Send",
					id: "finished",
					status: "success",
					outputJson: {
						_metadata: { targets: [{ id: "child", deliveryMessageId: "receipt", title: "old" }] },
					},
				},
			],
		};
		const running = {
			narratorId: "owner",
			contentJson: [
				{
					type: "tool_use",
					name: "Send",
					id: "live",
					status: "running",
					outputJson: null,
					_sendDeliveryTargets: [{ id: "child", deliveryMessageId: "receipt" }],
				},
			],
		};
		let calls = 0;
		const result = await attachSendTargetDetails([finished, running], async (targets) => {
			calls++;
			expect(targets).toEqual([{ id: "child", deliveryMessageId: "receipt" }]);
			return [
				{
					id: "child",
					deliveryMessageId: "receipt",
					title: "Current name",
					injectionConsumedAt: "2026-09-09T00:00:00.000Z",
				},
			];
		});
		expect(calls).toBe(1);
		expect(result[0].contentJson[0].outputJson).toBe(finished.contentJson[0].outputJson);
		expect(result[1].contentJson[0].outputJson).toBeNull();
		expect(result[0].contentJson[0]._sendDeliveryTargets).toEqual(
			result[1].contentJson[0]._sendDeliveryTargets,
		);
		expect(result[0].contentJson[0]._sendDeliveryTargets[0].title).toBe("Current name");
	});

	test("real migrated refs distinguish persistence from consumption and isolate narrator ownership", async () => {
		const { getTestDb } = await import("../../../tests/setup");
		const { narrators, narratorMessages, narratorMessageRefs } = await import("../../db/schema");
		const { db, sqlite } = getTestDb();
		try {
			const now = new Date("2026-09-09T00:00:00.000Z");
			await db.insert(narrators).values([
				{
					id: "child",
					title: "Current name",
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
				},
				{ id: "other", title: "Other", createdAt: now.toISOString(), updatedAt: now.toISOString() },
			]);
			await db.insert(narratorMessages).values([
				{
					id: "stored",
					narratorId: "child",
					role: "user",
					contentJson: [],
					createdAt: now.toISOString(),
				},
				{
					id: "consumed",
					narratorId: "child",
					role: "user",
					contentJson: [],
					createdAt: now.toISOString(),
				},
			]);
			await db.insert(narratorMessageRefs).values([
				{ id: "ref-stored", narratorId: "child", messageId: "stored", seq: 1 },
				{
					id: "ref-consumed",
					narratorId: "child",
					messageId: "consumed",
					seq: 2,
					injectionConsumedAt: now,
				},
			]);
			const result = await loadSendTargetDetails(
				[
					{ id: "child", deliveryMessageId: "stored" },
					{ id: "child", deliveryMessageId: "consumed" },
					{ id: "other", deliveryMessageId: "consumed" },
					{ id: "child" },
				],
				db,
			);
			expect(result[0].injectionConsumedAt).toBeUndefined();
			expect(result[1].injectionConsumedAt).toBe(now.toISOString());
			expect(result[2].injectionConsumedAt).toBeUndefined();
			expect(result[3]).toEqual({ id: "child", title: "Current name" });
		} finally {
			sqlite.close();
		}
	});
});

describe("running Send delivery receipts", () => {
	test("old failed no-output attempts never receive a newer attempt's receipt", () => {
		const old = message();
		old.contentJson[0].status = "fail";
		const live = message();
		let calls = 0;
		const result = attachActiveSendDeliveryTargets([old, live], () => {
			calls++;
			return [{ id: "child", deliveryMessageId: "new-receipt" }];
		});
		expect(result[0]).toBe(old);
		expect(result[0].contentJson[0]._sendDeliveryTargets).toBeUndefined();
		expect(result[1].contentJson[0]._sendDeliveryTargets).toHaveLength(1);
		expect(calls).toBe(1);
	});

	test("binds receipt lookup and cache to the concrete tool row and execution attempt", () => {
		const first = message();
		const second = message();
		Object.assign(first.toolCalls[0], { executionAttempt: 1 });
		Object.assign(second.toolCalls[0], { executionAttempt: 2 });
		const seen: unknown[] = [];
		const result = attachActiveSendDeliveryTargets([first, second], (_owner, _tool, binding) => {
			seen.push(binding);
			return binding?.attempt === 2 ? [{ id: "child", deliveryMessageId: "new-receipt" }] : [];
		});
		expect(seen).toEqual([
			{ toolCallId: "row", attempt: 1 },
			{ toolCallId: "row", attempt: 2 },
		]);
		expect(result[0]).toBe(first);
		expect(result[1].contentJson[0]._sendDeliveryTargets).toHaveLength(1);
	});
	test("default lookup reads scoped active checkpoints and drops completed runs", () => {
		const run = beginAgentReplyWaitRun({ requesterId: "active-owner", toolUseId: "active-send" });
		try {
			run.markStable({
				prefixTargets: [{ id: "target", status: "queued", deliveryMessageId: "reserved" }],
			});
			const tree = [
				message("active-owner", "active-send"),
				message("wrong-owner", "active-send"),
				message("active-owner", "wrong-tool"),
			];
			const result = attachActiveSendDeliveryTargets(tree);
			expect(result[0].contentJson[0]._sendDeliveryTargets).toEqual([
				{ id: "target", deliveryMessageId: "reserved" },
			]);
			expect(result[1]).toBe(tree[1]);
			expect(result[2]).toBe(tree[2]);
			run.complete();
			expect(attachActiveSendDeliveryTargets(tree)).toBe(tree);
		} finally {
			run.complete();
		}
	});
	test("reserved ids are transported independently without pretending the delivery persisted", () => {
		const original = message();
		const tree = attachActiveSendDeliveryTargets([original], () => [
			{ id: "child", deliveryMessageId: "not-yet-persisted" },
		]);
		expect(tree[0].contentJson[0][SEND_DELIVERY_TARGETS_FIELD]).toEqual([
			{ id: "child", deliveryMessageId: "not-yet-persisted" },
		]);
		expect(tree[0].contentJson[0].status).toBe("running");
		expect(tree[0].contentJson[0].outputJson).toBeNull();
		expect(tree[0].contentJson[0]._metadata).toBeUndefined();
		expect(original.contentJson[0]).not.toHaveProperty(SEND_DELIVERY_TARGETS_FIELD);
	});

	test("queries the original tool owner and exact tool, not the viewing/forked narrator", () => {
		const original = message("source");
		original.narratorId = "fork-view";
		const calls: string[][] = [];
		const tree = attachActiveSendDeliveryTargets(
			[original, message("sibling", "send-tool")],
			(owner, toolUseId) => {
				calls.push([owner, toolUseId]);
				return owner === "source" ? [{ id: "child", deliveryMessageId: "receipt" }] : [];
			},
		);
		expect(calls).toEqual([
			["source", "send-tool"],
			["sibling", "send-tool"],
		]);
		expect(tree[0].contentJson[0]._sendDeliveryTargets).toHaveLength(1);
		expect(tree[1].contentJson[0]._sendDeliveryTargets).toBeUndefined();
	});

	test("does not scan finished tools or unrelated tools, and preserves unaffected tree identity", () => {
		const finished = message();
		const unrelated = message();
		unrelated.contentJson[0].name = "Await";
		const tree = [
			{
				...finished,
				contentJson: [{ ...finished.contentJson[0], outputJson: { _metadata: { targets: [] } } }],
			},
			unrelated,
		];
		let calls = 0;
		expect(
			attachActiveSendDeliveryTargets(tree, () => {
				calls++;
				return [];
			}),
		).toBe(tree);
		expect(calls).toBe(0);
	});

	test("nested and repeated rows share one lookup per owner/tool and exclude missing receipt ids", () => {
		const row = message();
		const tree = [row, { narratorId: "parent", children: [row] }];
		let calls = 0;
		const result = attachActiveSendDeliveryTargets(tree, () => {
			calls++;
			return [{ id: "unknown" }, { id: "child", deliveryMessageId: "reserved" }];
		});
		expect(calls).toBe(1);
		expect(result[1].children[0].contentJson[0]._sendDeliveryTargets).toEqual([
			{ id: "child", deliveryMessageId: "reserved" },
		]);
	});

	test("missing owner and failed lookup never break message loading", () => {
		const tree = [message()];
		expect(
			attachActiveSendDeliveryTargets(tree, () => {
				throw new Error("lookup failed");
			}),
		).toBe(tree);
		let calls = 0;
		attachActiveSendDeliveryTargets([{ contentJson: message().contentJson }], () => {
			calls++;
			return [];
		});
		expect(calls).toBe(0);
	});
});
