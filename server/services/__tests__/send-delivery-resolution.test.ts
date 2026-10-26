import { describe, expect, mock, test } from "bun:test";
import {
	attachSendTargetDetails,
	broadcastSendDeliveryResolved,
	loadSendTargetDetails,
} from "../send-delivery-resolution";

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
