/**
 * Approval/denial feedback text typed against a permission request.
 *
 * Every session — delegated (its run delivers to a tool call), ordinary, or held by
 * the user — takes the same path: the text is kept in `pendingFeedback`, the live
 * turn's `_feedbackSoftStop` is armed, and the run adopts it at its next safe
 * boundary as the approver's own `role: "user"` turn. These tests assert that final
 * position (the next pass's prompt and the persisted row), not which function ran.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { modelInputText } from "../../../tests/fixtures/model-input";
import {
	narratorMessages,
	narrators,
	narratorToolCalls,
	userPreferences,
	users,
} from "../../db/schema";
import type { PermissionResult } from "../../lib/agent";
import type { DbMessage, ProviderAdapter } from "../../lib/agent/provider";

// The snapshot worker shares the preload-isolated file-backed database.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");

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
	}),
	injectSystemPrompt: () => {},
	chat: async function* () {},
} as unknown as ProviderAdapter;

const TEST_PROVIDER = "subagentfeedbackstub";
const TEST_MODEL = `${TEST_PROVIDER}:stub`;
const unregisterStubProvider = registerExternalProviderResolver({
	resolve: (requestedProvider) => (requestedProvider === TEST_PROVIDER ? stubAdapter : null),
	listReadiness: () => [],
});

const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
const realNarratorServiceModule = { ...(await import("../narrator-service")) };

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

const { DISABLED_TOOLS_TRAIT_PREFIX, upsertEncodedTrait } = await import(
	"../../lib/narrator-custom-traits"
);
const { resetTraitLayerCaches } = await import("../trait-layer-service");
const { resolvePermission } = await import("../narrator-permission");
const { activeNarrators, pendingFeedback, pendingPermissions } = await import(
	"../narrator-session-state"
);
const { getExecutionOwner, setRunControl, setRunHold, tryClaimExecution } = await import(
	"../agent-runtime/ownership"
);
type ActiveNarrator = import("../narrator-session-state").ActiveNarrator;
type Subject = "delegated" | "ordinary" | "held";
/**
 * A live turn of the subject session; a delegated (or held) one also has the run the
 * run service mounts, with its registered destination.
 */
function liveTurn(subject: Subject): ActiveNarrator {
	if (subject !== "ordinary") {
		const owner = tryClaimExecution(SUBJECT_ID, "run");
		if (!owner) throw new Error("expected a free execution slot");
		setRunControl(owner, {
			startedAt: Date.now(),
			cancel: new AbortController(),
			timedOut: false,
			terminal: new Promise(() => {}),
			deliverTo: { narratorId: PARENT_ID, toolUseId: SPAWNING_TOOL_USE_ID },
		});
	}
	if (subject === "held") setRunHold(SUBJECT_ID, { released: false });
	const active = {
		narratorId: SUBJECT_ID,
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_guidanceAbortController: new AbortController(),
	} as unknown as ActiveNarrator;
	activeNarrators.set(SUBJECT_ID, active);
	return active;
}
function endLiveTurn(): void {
	getExecutionOwner(SUBJECT_ID)?.release();
	setRunHold(SUBJECT_ID, undefined);
	activeNarrators.delete(SUBJECT_ID);
}
const { getModelHistorySinceLastCompact } = (await import("../narrator-service")).narratorService;
const { listInboxRows } = await import("../agent-runtime/inbox");

afterAll(async () => {
	await closePrefixSnapshotStore();
	unregisterStubProvider();
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.restore();
});

const PARENT_ID = "feedback-parent-narrator";
const SUBJECT_ID = "feedback-subject-narrator";
const SPAWNING_TOOL_USE_ID = "feedback-spawn-agent-tool";
const REQUEST_ID = "feedback-request";
const TOOL_USE_ID = "feedback-write-tool";
const APPROVER_ID = "feedback-approver-user";
const STARTER_ID = "feedback-starting-user";

function now(): string {
	return "2026-07-17T00:00:00.000Z";
}

/**
 * Seed the narrator rows and the pending tool-call row a permission decision writes
 * back to. A delegated subject carries the run registration (`deliverTo`); an
 * ordinary one carries none. Nothing under test is told what kind it is.
 */
async function seedSubject(subject: Subject): Promise<void> {
	// `createdBy` is a real FK: the approver has to exist for the feedback row to
	// persist, and attribution to the approver is part of what is under test.
	await db.insert(users).values([
		{ id: APPROVER_ID, username: "feedback-approver", passwordHash: "x", createdAt: now() },
		{ id: STARTER_ID, username: "feedback-starter", passwordHash: "x", createdAt: now() },
	]);
	await db.insert(userPreferences).values({
		id: "feedback-approver-preferences",
		userId: APPROVER_ID,
		traits: upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, { version: 1, tools: ["Write"] }),
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(narrators).values({
		id: PARENT_ID,
		createdAt: now(),
		updatedAt: now(),
	});
	const delegated = subject !== "ordinary";
	await db.insert(narrators).values({
		id: SUBJECT_ID,
		...(delegated ? { variant: "subagent:general", parentNarratorId: PARENT_ID } : {}),
		model: TEST_MODEL,
		cwd: process.env.HOME,
		autoContinuationOverride: "off",
		...(delegated
			? {
					runtimeRegistrationJson: {
						version: 1,
						run: {
							logicalRunId: "feedback-run",
							deliverTo: { narratorId: PARENT_ID, toolUseId: SPAWNING_TOOL_USE_ID },
						},
					},
				}
			: {}),
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(narratorMessages).values({
		id: "feedback-assistant-message",
		narratorId: SUBJECT_ID,
		role: "assistant",
		contentJson: [],
		parentToolUseId: subject === "ordinary" ? null : SPAWNING_TOOL_USE_ID,
		createdAt: now(),
	});
	await db.insert(narratorToolCalls).values({
		id: REQUEST_ID,
		narratorId: SUBJECT_ID,
		messageId: "feedback-assistant-message",
		toolUseId: TOOL_USE_ID,
		toolName: "Write",
		inputJson: { file_path: "src/thing.ts", content: "x" },
		status: "pending",
		createdAt: now(),
	});
}

/**
 * Register a pending permission the way `handlePermission` does: owned by the
 * subject session and carrying the locale its run was started with.
 *
 * Built directly rather than through `handlePermission` so the assertions are about
 * the resolution path that had the bug, not about the permission policy that
 * decides whether to ask in the first place.
 */
function registerPendingPermission(options?: {
	toolName?: string;
	locale?: "en" | "zh-CN";
	planSubmittedFromFile?: boolean;
}): Promise<PermissionResult> {
	return new Promise<PermissionResult>((resolve) => {
		pendingPermissions.set(REQUEST_ID, {
			resolve,
			cleanup: () => pendingPermissions.delete(REQUEST_ID),
			input: { file_path: "src/thing.ts", content: "x" },
			narratorId: SUBJECT_ID,
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

function clearPersistedFeedbackFixture(): void {
	// Public cancellation intentionally retains delivery tombstones. Test teardown
	// must remove the durable mailbox before refs/messages and their actor FKs,
	// otherwise reusing the same narrator ID replays a previous test's feedback.
	sqlite.transaction(() => {
		for (const table of [
			"narrator_buffered_messages",
			"narrator_message_refs",
			"narrator_tool_calls",
			"narrator_messages",
		])
			sqlite.run(`DELETE FROM "${table}"`);
		sqlite.run('DELETE FROM "narrators" WHERE id = ?', [SUBJECT_ID]);
		sqlite.run('DELETE FROM "narrators" WHERE id = ?', [PARENT_ID]);
		sqlite.run('DELETE FROM "user_preferences" WHERE user_id = ?', [APPROVER_ID]);
		sqlite.run('DELETE FROM "users" WHERE id = ?', [APPROVER_ID]);
		sqlite.run('DELETE FROM "users" WHERE id = ?', [STARTER_ID]);
		resetTraitLayerCaches();
	})();
}

beforeEach(async () => {
	await closePrefixSnapshotStore();
	clearPersistedFeedbackFixture();
	pendingPermissions.clear();
	pendingFeedback.clear();
	endLiveTurn();
});

afterEach(async () => {
	await closePrefixSnapshotStore();
	pendingPermissions.clear();
	pendingFeedback.clear();
	endLiveTurn();
	clearPersistedFeedbackFixture();
});

const SUBJECTS: Subject[] = ["delegated", "ordinary", "held"];

describe("approval feedback takes one path for every session", () => {
	for (const subject of SUBJECTS) {
		test(`${subject}: the text is kept for the run and arms its next safe stop`, async () => {
			await seedSubject(subject);
			const active = liveTurn(subject);
			const permission = registerPendingPermission();

			expect(
				await resolvePermission(REQUEST_ID, "allow", {
					feedbackText: "  可以，但注意 X  ",
					userId: APPROVER_ID,
				}),
			).toBe(true);
			expect(await permission).toMatchObject({ behavior: "allow" });

			// Trimmed and attributed to the approver; the turn stops at the next boundary.
			expect(pendingFeedback.get(SUBJECT_ID)).toMatchObject({
				feedbackText: "可以，但注意 X",
				userId: APPROVER_ID,
			});
			expect(active._feedbackSoftStop).toBe(true);
			// Not also queued as a mailbox row: one delivery, one consumer.
			expect(await listInboxRows(SUBJECT_ID, ["user_input"])).toEqual([]);
		});

		test(`${subject}: the next pass is sent the approver's text as a persisted user turn`, async () => {
			await seedSubject(subject);
			if (subject === "held") setRunHold(SUBJECT_ID, { released: false });
			const executor = await import("../narrator-executor");
			const requests: string[] = [];
			const { spyOn } = await import("bun:test");
			const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
				requests.push(modelInputText(options));
				if (requests.length === 1) {
					expect(options.config.userId).toBe(STARTER_ID);
					expect(new Set(options.config.disabledTools).has("Write")).toBe(false);
					// The permission is decided while the pass's tool is in flight.
					const permission = registerPendingPermission();
					await resolvePermission(REQUEST_ID, "allow", {
						feedbackText: "记得同时更新迁移",
						userId: APPROVER_ID,
					});
					await permission;
					// The next safe boundary stops the pass for the feedback.
					expect(options.config.shouldYieldToInput?.()).toBe(true);
					return {
						finalText: "",
						hasError: false,
						shouldUpdateTitle: false,
						completedNaturally: false,
						hadToolUses: true,
					};
				}
				// S7: the next pass observes B's actual user-level restriction, not A's.
				expect(options.config.userId).toBe(APPROVER_ID);
				expect(new Set(options.config.disabledTools).has("Write")).toBe(true);
				expect(
					(await db.query.narrators.findFirst({ where: eq(narrators.id, SUBJECT_ID) }))
						?.runtimeRegistrationJson?.run?.principal,
				).toEqual({ userId: APPROVER_ID });
				// The user lets go of a held run, so the run ends instead of parking.
				if (subject === "held") setRunHold(SUBJECT_ID, { released: true });
				return { finalText: "ok", hasError: false, shouldUpdateTitle: false };
			});
			try {
				const { startNarratorRun } = await import("../agent-runtime/run");
				const handle = await startNarratorRun({
					narratorId: SUBJECT_ID,
					locale: "en",
					text: "start",
					principal: STARTER_ID,
					deliver: false,
				});
				expect(handle.started).toBe(true);
				expect(await handle.terminal).toMatchObject({ hasError: false });
			} finally {
				execute.mockRestore();
			}
			// Adopted at the next safe boundary of the same run, exactly once.
			expect(requests).toHaveLength(2);
			const feedback = `<sender kind="human" id="${APPROVER_ID}" name="feedback-approver" />\n记得同时更新迁移`;
			expect(requests[1].split(feedback)).toHaveLength(2);
			expect(pendingFeedback.has(SUBJECT_ID)).toBe(false);
			expect(
				(await getModelHistorySinceLastCompact(SUBJECT_ID)).some(
					(row) => row.role === "user" && row.contentText === "记得同时更新迁移",
				),
			).toBe(true);
			const rows = await db.query.narratorMessages.findMany({
				where: eq(narratorMessages.narratorId, SUBJECT_ID),
			});
			const userRow = rows.find(
				(row) => row.role === "user" && row.contentText === "记得同时更新迁移",
			);
			expect(userRow?.createdBy).toBe(APPROVER_ID);
			// Placement follows the run's registered destination, not the session kind.
			expect(userRow?.parentToolUseId ?? null).toBe(
				subject === "ordinary" ? null : SPAWNING_TOOL_USE_ID,
			);
		});
	}

	test("an empty or whitespace-only feedback text delivers nothing at all", async () => {
		await seedSubject("delegated");
		const active = liveTurn("delegated");
		active._currentUserId = STARTER_ID;
		const permission = registerPendingPermission();

		await resolvePermission(REQUEST_ID, "allow", { feedbackText: "   ", userId: APPROVER_ID });
		await permission;

		expect(pendingFeedback.has(SUBJECT_ID)).toBe(false);
		expect(active._currentUserId).toBe(STARTER_ID);
		expect(active._feedbackSoftStop).not.toBe(true);
		expect(await listInboxRows(SUBJECT_ID, ["user_input"])).toEqual([]);
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
	beforeEach(() => seedSubject("delegated"));

	test("a zh-CN request gets the Chinese plan-denial message, with the feedback inlined", async () => {
		const permission = registerPendingPermission({
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
		const permission = registerPendingPermission({
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
		const permission = registerPendingPermission({
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
