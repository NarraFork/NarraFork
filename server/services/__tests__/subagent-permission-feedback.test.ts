/**
 * Approval/denial feedback text typed against a SUBAGENT's permission request.
 *
 * The user can write feedback into the InlinePermission form rendered inside the
 * parent's SubagentCard, so the text has to arrive somewhere the subagent's model
 * actually reads. It previously did not: the delivery mechanism was
 * `pendingFeedback` + `_feedbackSoftStop` on the `activeNarrators` entry, and a
 * subagent has no such entry (it registers only in `activeSubagentSettings`), so
 * the branch ran, found `undefined`, and dropped the text without a warning.
 *
 * These tests therefore assert the TEXT's final position — the buffered queue the
 * subagent loop drains, the prompt that drain returns, and the persisted user row
 * every provider's `buildHistory` replays — rather than that some function was
 * called.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls, users } from "../../db/schema";
import type { PermissionResult } from "../../lib/agent";
import type { DbMessage, ProviderAdapter } from "../../lib/agent/provider";
import { registerExternalProviderResolver } from "../../lib/agent/provider";

const { db, sqlite } = getTestDb();

/**
 * Minimal provider adapter, registered through the real
 * `registerExternalProviderResolver` seam rather than a `mock.module`.
 *
 * It exists so `buildHistory` can run without a configured upstream, and it
 * projects each row to `{ role, text }` — which makes the drain assertion an
 * assertion about the MODEL-FACING history, not merely about a queue.
 */
const stubAdapter = {
	formatTools: () => [],
	buildHistory: async (dbMessages: DbMessage[]) => ({
		history: dbMessages.map((message) => ({
			role: message.role,
			text: (message.contentJson as Array<{ type: string; text?: string }> | null)
				?.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n"),
		})),
		trailingToolResults: [],
	}),
	injectSystemPrompt: () => {},
	chat: async function* () {},
	formatToolResult: () => ({}),
} as unknown as ProviderAdapter;

const TEST_PROVIDER = "subagentfeedbackstub";
const TEST_MODEL = `${TEST_PROVIDER}:stub`;
const unregisterStubProvider = registerExternalProviderResolver((requestedProvider) =>
	requestedProvider === TEST_PROVIDER ? stubAdapter : null,
);

const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
const realNarratorServiceModule = { ...(await import("../narrator-service")) };

mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWsModule,
	broadcastToNarrator: () => {},
}));
mock.module("../narrator-service", () => ({
	...realNarratorServiceModule,
	narratorService: {
		...realNarratorServiceModule.narratorService,
		updateStatus: async () => {},
	},
}));

const { resolvePermission } = await import("../narrator-permission");
const {
	activeNarrators,
	pendingFeedback,
	pendingPermissions,
	registerActiveSubagent,
	unregisterActiveSubagent,
} = await import("../narrator-session-state");
const {
	clearSubagentBufferedMessages,
	consumeNextBufferedSubagentMessage,
	getSubagentBufferedMessages,
	shouldStopSubagentForBufferedMessage,
} = await import("../subagent-executor");

afterAll(() => {
	unregisterStubProvider();
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.restore();
});

const PARENT_ID = "feedback-parent-narrator";
const SUBAGENT_ID = "feedback-subagent-narrator";
const SPAWNING_TOOL_USE_ID = "feedback-spawn-agent-tool";
const REQUEST_ID = "feedback-request";
const TOOL_USE_ID = "feedback-write-tool";
const APPROVER_ID = "feedback-approver-user";

function now(): string {
	return "2026-07-17T00:00:00.000Z";
}

/**
 * Seed the two narrator rows and the pending tool-call row a permission decision
 * writes back to. The subagent row carries a real `subagent:general` variant and
 * parent link so nothing under test has to be told what kind of narrator it is.
 */
async function seedSubagent(): Promise<void> {
	// `createdBy` is a real FK: the approver has to exist for the feedback row to
	// persist, and attribution to the approver is part of what is under test.
	await db.insert(users).values({
		id: APPROVER_ID,
		username: "feedback-approver",
		passwordHash: "x",
		createdAt: now(),
	});
	await db.insert(narrators).values({
		id: PARENT_ID,
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(narrators).values({
		id: SUBAGENT_ID,
		variant: "subagent:general",
		parentNarratorId: PARENT_ID,
		model: TEST_MODEL,
		cwd: ".",
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(narratorMessages).values({
		id: "feedback-assistant-message",
		narratorId: SUBAGENT_ID,
		role: "assistant",
		contentJson: [],
		parentToolUseId: SPAWNING_TOOL_USE_ID,
		createdAt: now(),
	});
	await db.insert(narratorToolCalls).values({
		id: REQUEST_ID,
		narratorId: SUBAGENT_ID,
		messageId: "feedback-assistant-message",
		toolUseId: TOOL_USE_ID,
		toolName: "Write",
		inputJson: { file_path: "src/thing.ts", content: "x" },
		status: "pending",
		createdAt: now(),
	});
}

/**
 * Register a pending permission exactly as `handlePermission` does for a subagent:
 * owned by the subagent, broadcast to the parent, and carrying the locale the
 * subagent run was started with.
 *
 * Built directly rather than through `handlePermission` so the assertions are about
 * the resolution path that had the bug, not about the permission policy that
 * decides whether to ask in the first place.
 */
function registerPendingSubagentPermission(options?: {
	toolName?: string;
	locale?: "en" | "zh-CN";
	planSubmittedFromFile?: boolean;
}): Promise<PermissionResult> {
	return new Promise<PermissionResult>((resolve) => {
		pendingPermissions.set(REQUEST_ID, {
			resolve,
			cleanup: () => pendingPermissions.delete(REQUEST_ID),
			input: { file_path: "src/thing.ts", content: "x" },
			narratorId: SUBAGENT_ID,
			toolName: options?.toolName ?? "Write",
			toolUseId: TOOL_USE_ID,
			broadcastTargetId: PARENT_ID,
			parentToolUseId: SPAWNING_TOOL_USE_ID,
			cwd: ".",
			locale: options?.locale ?? "en",
			signal: new AbortController().signal,
			planSubmittedFromFile: options?.planSubmittedFromFile,
		});
	});
}

beforeEach(async () => {
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of ["narrator_tool_calls", "narrator_messages", "narrator_message_refs"]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run(`DELETE FROM "narrators"`);
	sqlite.run(`DELETE FROM "users"`);
	sqlite.run("PRAGMA foreign_keys = ON");
	pendingPermissions.clear();
	pendingFeedback.clear();
	activeNarrators.delete(SUBAGENT_ID);
	clearSubagentBufferedMessages(SUBAGENT_ID);
	unregisterActiveSubagent(SUBAGENT_ID);
	await seedSubagent();
});

afterEach(() => {
	pendingPermissions.clear();
	pendingFeedback.clear();
	clearSubagentBufferedMessages(SUBAGENT_ID);
	unregisterActiveSubagent(SUBAGENT_ID);
	activeNarrators.delete(SUBAGENT_ID);
});

describe("approval feedback for a subagent permission request", () => {
	test("the typed text is queued for the subagent and arms its next safe stop", async () => {
		// A running subagent registers here and nowhere else — this is precisely what
		// made the `activeNarrators` lookup resolve to undefined.
		registerActiveSubagent(SUBAGENT_ID, TEST_MODEL, null);
		const permission = registerPendingSubagentPermission();

		expect(
			await resolvePermission(REQUEST_ID, "allow", {
				feedbackText: "  可以，但注意 X  ",
				userId: APPROVER_ID,
			}),
		).toBe(true);
		expect(await permission).toMatchObject({ behavior: "allow" });

		// The text is in the queue the subagent loop drains, trimmed, attributed to
		// the approver.
		expect(getSubagentBufferedMessages(SUBAGENT_ID)).toMatchObject([
			{ text: "可以，但注意 X", createdBy: APPROVER_ID },
		]);
		// And the loop is asked to stop at its next post-tool boundary so the text is
		// taken up promptly instead of at the end of an arbitrarily long run. This is
		// the pair `shouldStop` reads; without the queue entry it returns false.
		expect(shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);

		// The primary-narrator mechanism is NOT also used: a double delivery would
		// replay the same feedback into whichever primary loop later owns this id.
		expect(pendingFeedback.has(SUBAGENT_ID)).toBe(false);
	});

	test("the queued text becomes the subagent's next prompt and a persisted user row", async () => {
		registerActiveSubagent(SUBAGENT_ID, TEST_MODEL, null);
		const permission = registerPendingSubagentPermission();
		await resolvePermission(REQUEST_ID, "allow", {
			feedbackText: "记得同时更新迁移",
			userId: APPROVER_ID,
		});
		await permission;

		// Drain through the real consumer the subagent loop uses after a soft stop.
		// `prompt` is sent as the current turn and the persisted row is what every
		// provider's buildHistory replays — i.e. two positions the model reads.
		const consumed = await consumeNextBufferedSubagentMessage({
			narratorId: SUBAGENT_ID,
			parentNarratorId: PARENT_ID,
			toolUseId: SPAWNING_TOOL_USE_ID,
			model: TEST_MODEL,
			provider: TEST_PROVIDER,
			cwd: ".",
		});
		expect(consumed?.prompt).toBe("记得同时更新迁移");
		// And it is present in the rebuilt model history, not just in the prompt: a
		// drain that returned the text but rebuilt a history without it would still
		// lose the feedback on any later pass.
		expect(consumed?.history).toEqual(
			expect.arrayContaining([{ role: "user", text: "记得同时更新迁移" }]),
		);

		const rows = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, SUBAGENT_ID),
		});
		const userRow = rows.find((row) => row.role === "user");
		expect(userRow?.contentText).toBe("记得同时更新迁移");
		expect(userRow?.createdBy).toBe(APPROVER_ID);
		// Filed under the spawning Agent tool call, the convention every subagent row
		// follows, so the parent's tool card and the subagent's own page both find it.
		expect(userRow?.parentToolUseId).toBe(SPAWNING_TOOL_USE_ID);
	});

	test("a primary narrator still uses pendingFeedback and its own soft-stop flag", async () => {
		// No registerActiveSubagent: this id is an ordinary narrator with a live loop.
		const active = { alive: true, narratorId: SUBAGENT_ID } as never as {
			alive: boolean;
			_feedbackSoftStop?: boolean;
		};
		activeNarrators.set(SUBAGENT_ID, active as never);
		const permission = registerPendingSubagentPermission();

		await resolvePermission(REQUEST_ID, "allow", {
			feedbackText: "go ahead",
			userId: APPROVER_ID,
		});
		await permission;

		expect(pendingFeedback.get(SUBAGENT_ID)).toMatchObject({
			feedbackText: "go ahead",
			userId: APPROVER_ID,
		});
		expect(active._feedbackSoftStop).toBe(true);
		// The subagent queue must stay empty: routing a primary narrator's feedback
		// there would strand it (nothing drains that queue for a primary loop).
		expect(getSubagentBufferedMessages(SUBAGENT_ID)).toEqual([]);
	});

	test("an empty or whitespace-only feedback text delivers nothing at all", async () => {
		registerActiveSubagent(SUBAGENT_ID, TEST_MODEL, null);
		const permission = registerPendingSubagentPermission();

		await resolvePermission(REQUEST_ID, "allow", { feedbackText: "   ", userId: APPROVER_ID });
		await permission;

		expect(getSubagentBufferedMessages(SUBAGENT_ID)).toEqual([]);
		expect(shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(false);
		expect(pendingFeedback.has(SUBAGENT_ID)).toBe(false);
	});
});

describe("denial feedback is worded in the locale the request was raised with", () => {
	/**
	 * The locale used to come from `activeNarrators`, which is empty for a subagent,
	 * so this silently degraded to English. Nothing errors when it happens: a Chinese
	 * user simply receives English instructions.
	 *
	 * ExitPlanMode is the tool whose denial text is localized at all, so it is the
	 * only place the regression is observable — and while subagents have no plan mode
	 * today, the locale lookup itself is the shared defect, so the assertion is
	 * written against `pending.locale` being honoured rather than against plan mode.
	 */
	test("a zh-CN request gets the Chinese plan-denial message, with the feedback inlined", async () => {
		const permission = registerPendingSubagentPermission({
			toolName: "ExitPlanMode",
			locale: "zh-CN",
		});

		expect(await resolvePermission(REQUEST_ID, "deny", { feedbackText: "先补充回滚方案" })).toBe(
			true,
		);
		const result = await permission;
		expect(result.behavior).toBe("deny");
		if (result.behavior !== "deny") throw new Error("expected a denial");
		expect(result.message).toContain("[计划模式]");
		expect(result.message).toContain("用户拒绝了你的计划");
		expect(result.message).toContain("先补充回滚方案");
		// Guard against the regression re-appearing as a partial translation.
		expect(result.message).not.toContain("The user rejected your plan");
	});

	test("an en request is unchanged", async () => {
		const permission = registerPendingSubagentPermission({
			toolName: "ExitPlanMode",
			locale: "en",
		});

		await resolvePermission(REQUEST_ID, "deny", { feedbackText: "add a rollback plan" });
		const result = await permission;
		if (result.behavior !== "deny") throw new Error("expected a denial");
		expect(result.message).toContain("The user rejected your plan");
		expect(result.message).toContain("add a rollback plan");
	});

	test("a file-submitted plan keeps its own wording in zh-CN", async () => {
		const permission = registerPendingSubagentPermission({
			toolName: "ExitPlanMode",
			locale: "zh-CN",
			planSubmittedFromFile: true,
		});

		await resolvePermission(REQUEST_ID, "deny", { feedbackText: "计划文件缺少验证步骤" });
		const result = await permission;
		if (result.behavior !== "deny") throw new Error("expected a denial");
		expect(result.message).toContain("用户拒绝了你通过计划文件提交的计划");
		expect(result.message).toContain("计划文件缺少验证步骤");
	});
});
