/**
 * Manual takeover of a danger reflection, as observed by EVERY open view.
 *
 * Two regressions are pinned here, both of which made a takeover on one device
 * leave other devices/tabs stuck on a "still reflecting" card:
 *
 * 1. FAN-OUT. The stop frame went only to `broadcastTargetId` (the PARENT for a
 *    subagent gate), so a client on the subagent's own page never received it.
 *    Nothing rescued that view: reflection frames do not bump `messageVersion`,
 *    so the frontend's structural reload never fires either.
 * 2. SUBSTATUS. The takeover still wrote `substatus: ["reflecting"]`, so status
 *    badges / favicons / list cards kept claiming the AI was deliberating after
 *    the user had already taken the decision over.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";
import type { DangerInfo } from "../../lib/agent";
import type { PendingDangerReflection } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
const realNarratorServiceModule = { ...(await import("../narrator-service")) };

const broadcasts: Array<{ target: string; message: Record<string, unknown> }> = [];
const statusUpdates: Array<{ narratorId: string; status: string; substatus?: string[] }> = [];

mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWsModule,
	broadcastToNarrator: (narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push({ target: narratorId, message });
	},
}));
mock.module("../narrator-service", () => ({
	...realNarratorServiceModule,
	narratorService: {
		...realNarratorServiceModule.narratorService,
		updateStatus: async (
			narratorId: string,
			status: string,
			options?: { substatus?: string[] },
		) => {
			statusUpdates.push({ narratorId, status, substatus: options?.substatus });
		},
	},
}));

const { stopDangerReflectionLoop } = await import("../narrator-permission");
const { pendingDangerReflections } = await import("../narrator-session-state");

const PARENT_ID = "takeover-parent-narrator";
const SUBAGENT_ID = "takeover-subagent-narrator";
const PARENT_TOOL_USE = "takeover-parent-agent-tool-use";
const MESSAGE_ID = "takeover-message";
const TOOL_CALL_ID = "takeover-tool-call";
const TOOL_USE_ID = "takeover-tool-use";

const danger: DangerInfo = {
	severity: "high",
	summary: "Recursive delete",
	consequences: ["Removes files irreversibly"],
	saferAlternatives: ["List the paths first"],
};

function now(): string {
	return "2026-07-29T00:00:00.000Z";
}

/**
 * Seed a danger reflection owned by a SUBAGENT: the gate lives on the subagent's
 * tool call while `broadcastTargetId` points at the parent, which is exactly the
 * shape that used to lose the stop frame on the subagent's own page.
 */
async function seedSubagentReflection(): Promise<void> {
	await db.insert(narrators).values([
		{ id: PARENT_ID, createdAt: now(), updatedAt: now() },
		{ id: SUBAGENT_ID, parentNarratorId: PARENT_ID, createdAt: now(), updatedAt: now() },
	]);
	await db.insert(narratorMessages).values({
		id: MESSAGE_ID,
		narratorId: SUBAGENT_ID,
		role: "assistant",
		contentJson: [],
		parentToolUseId: PARENT_TOOL_USE,
		createdAt: now(),
	});
	await db.insert(narratorToolCalls).values({
		id: TOOL_CALL_ID,
		narratorId: SUBAGENT_ID,
		messageId: MESSAGE_ID,
		toolUseId: TOOL_USE_ID,
		toolName: "Bash",
		status: "pending",
		permissionSuggestions: [
			{ type: "danger_reflection", status: "running", requestId: TOOL_CALL_ID },
		],
		createdAt: now(),
	});
}

function registerRuntimePause(overrides?: Partial<PendingDangerReflection>): AbortController {
	const reflectionAbortController = new AbortController();
	pendingDangerReflections.set(TOOL_CALL_ID, {
		narratorId: SUBAGENT_ID,
		requestId: TOOL_CALL_ID,
		toolCallId: TOOL_CALL_ID,
		toolUseId: TOOL_USE_ID,
		toolName: "Bash",
		broadcastTargetId: PARENT_ID,
		parentToolUseId: PARENT_TOOL_USE,
		input: { command: "rm -rf ./build" },
		fingerprint: "fingerprint",
		danger,
		startedAt: Date.now(),
		reflectionAbortController,
		resolve: () => {},
		cleanup: () => {},
		...overrides,
	} as PendingDangerReflection);
	return reflectionAbortController;
}

afterEach(() => {
	broadcasts.length = 0;
	statusUpdates.length = 0;
	pendingDangerReflections.clear();
	sqlite.run("DELETE FROM narrator_tool_calls");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.restore();
});

describe("stopDangerReflectionLoop (live runtime pause)", () => {
	test("notifies both the subagent's own page and the parent page", async () => {
		await seedSubagentReflection();
		registerRuntimePause();

		expect(await stopDangerReflectionLoop(TOOL_CALL_ID, "taken over on device A")).toBe(true);

		const stopFrames = broadcasts.filter(
			(entry) => entry.message.type === "danger_reflection_stopped",
		);
		expect(stopFrames.map((entry) => entry.target).sort()).toEqual([PARENT_ID, SUBAGENT_ID].sort());

		const ownerFrame = stopFrames.find((entry) => entry.target === SUBAGENT_ID);
		expect(ownerFrame?.message).toMatchObject({
			narratorId: SUBAGENT_ID,
			ownerNarratorId: SUBAGENT_ID,
			requestId: TOOL_CALL_ID,
			toolUseId: TOOL_USE_ID,
			reason: "taken over on device A",
		});
		// On its own page the gate is a top-level card, not a child of an Agent card.
		expect(ownerFrame?.message.parentToolUseId).toBeUndefined();

		const parentFrame = stopFrames.find((entry) => entry.target === PARENT_ID);
		expect(parentFrame?.message).toMatchObject({
			narratorId: PARENT_ID,
			ownerNarratorId: SUBAGENT_ID,
			subagentNarratorId: SUBAGENT_ID,
			parentToolUseId: PARENT_TOOL_USE,
		});
	});

	test("clears the reflecting substatus on both narrators", async () => {
		await seedSubagentReflection();
		registerRuntimePause();

		await stopDangerReflectionLoop(TOOL_CALL_ID);

		expect(statusUpdates.length).toBeGreaterThanOrEqual(2);
		for (const update of statusUpdates) {
			expect(update.status).toBe("waiting");
			// The decision is the user's now; nothing may still advertise "reflecting".
			expect(update.substatus).toEqual([]);
		}
		expect(statusUpdates.map((update) => update.narratorId).sort()).toEqual(
			[PARENT_ID, SUBAGENT_ID].sort(),
		);
	});

	test("hands the decision back as an awaiting_user permission and aborts the loop", async () => {
		await seedSubagentReflection();
		const controller = registerRuntimePause();

		await stopDangerReflectionLoop(TOOL_CALL_ID, "manual takeover");

		expect(controller.signal.aborted).toBe(true);
		expect(pendingDangerReflections.get(TOOL_CALL_ID)?.reflectionStoppedByUser).toBe(true);

		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, TOOL_CALL_ID),
		});
		// `pending` + `awaiting_user` is what makes getPendingPermissions return this
		// row again, so a view that missed the WS frame still self-heals on refetch.
		expect(row?.status).toBe("pending");
		expect((row?.permissionSuggestions as Array<{ status?: string }>)[0]?.status).toBe(
			"awaiting_user",
		);
	});
});

describe("stopDangerReflectionLoop (no runtime pause)", () => {
	test("still resolves both pages from persisted state", async () => {
		await seedSubagentReflection();

		expect(await stopDangerReflectionLoop(TOOL_CALL_ID, "stale tab takeover")).toBe(true);

		const resolvedFrames = broadcasts.filter(
			(entry) => entry.message.type === "danger_reflection_resolved",
		);
		expect(resolvedFrames.map((entry) => entry.target).sort()).toEqual(
			[PARENT_ID, SUBAGENT_ID].sort(),
		);
		for (const frame of resolvedFrames) {
			expect(frame.message.decision).toBe("aborted");
			expect(frame.message.ownerNarratorId).toBe(SUBAGENT_ID);
		}
	});

	test("returns false for an unknown request id", async () => {
		expect(await stopDangerReflectionLoop("no-such-request")).toBe(false);
		expect(broadcasts).toHaveLength(0);
	});
});
