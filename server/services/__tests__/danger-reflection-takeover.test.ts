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
import { localPathSemantics } from "../../lib/agent/execution/path-semantics";
import { localBackend } from "../../lib/agent/execution/registry";
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

const {
	cancelDangerReflection,
	confirmDangerReflection,
	handlePermission,
	reprocessAllPendingPermissions,
	stopDangerReflectionLoop,
} = await import("../narrator-permission");
const {
	claimNarratorRuntime,
	pendingDangerConfirmations,
	pendingDangerReflections,
	pendingPermissions,
} = await import("../narrator-session-state");

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
	pendingPermissions.get(TOOL_CALL_ID)?.cleanup();
	pendingDangerReflections.get(TOOL_CALL_ID)?.cleanup();
	pendingDangerReflections.clear();
	pendingDangerConfirmations.clear();
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

	test("clears the reflecting substatus on both narrators while the parent is busy", async () => {
		await seedSubagentReflection();
		registerRuntimePause();
		// A parent that is genuinely running still gets the mirrored clear, otherwise
		// its own badge would keep advertising "reflecting" after the takeover.
		const release = claimNarratorRuntime(PARENT_ID, "test-parent-busy");

		try {
			await stopDangerReflectionLoop(TOOL_CALL_ID);
		} finally {
			release();
		}

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

	test("does not write the status of an idle parent", async () => {
		await seedSubagentReflection();
		registerRuntimePause();

		// No runtime claim and no live loop: this parent already finished its turn.
		// Mirroring `waiting` onto it used to resurrect it as busy forever, which then
		// blocked /continue and /subagent-recovery with "already running" and wiped the
		// error substatus that the recovery card keys on.
		await stopDangerReflectionLoop(TOOL_CALL_ID);

		expect(statusUpdates).toEqual([{ narratorId: SUBAGENT_ID, status: "waiting", substatus: [] }]);
		// The parent still learns about the takeover — via WS frames, not a status write.
		expect(
			broadcasts.some(
				(entry) => entry.target === PARENT_ID && entry.message.type === "danger_reflection_stopped",
			),
		).toBe(true);
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

function requestChildBashPermission(
	signal = new AbortController().signal,
	onAwaitingUserDecision?: () => void,
) {
	return handlePermission(
		SUBAGENT_ID,
		signal,
		"Bash",
		{ command: "rm -rf ./build" },
		TOOL_USE_ID,
		process.cwd(),
		"en",
		PARENT_ID,
		{
			onAwaitingUserDecision,
			executionBackend: localBackend,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: process.cwd(),
				pathFlavor: localPathSemantics.flavor,
				runtimeGeneration: localBackend.runtimeGeneration ?? 0,
				selectionSource: "local_default",
			},
		},
		PARENT_TOOL_USE,
	);
}

describe("automatic danger reflection — parent attention isolation", () => {
	test("starting a child gate updates its card without marking a busy parent as waiting", async () => {
		await seedSubagentReflection();
		await db
			.update(narrators)
			.set({ permissionMode: "bypassPermissions", dangerReflectionOverride: "standard" })
			.where(eq(narrators.id, SUBAGENT_ID));
		const release = claimNarratorRuntime(PARENT_ID, "test-parent-busy");
		try {
			const result = await requestChildBashPermission();
			expect(result.behavior).toBe("dangerReflection");
			expect(statusUpdates).toEqual([
				{ narratorId: SUBAGENT_ID, status: "waiting", substatus: ["reflecting"] },
			]);
			const started = broadcasts.filter(
				(entry) => entry.message.type === "danger_reflection_started",
			);
			expect(started.map((entry) => entry.target).sort()).toEqual([PARENT_ID, SUBAGENT_ID].sort());
		} finally {
			await cancelDangerReflection(TOOL_CALL_ID);
			release();
		}
	});

	test("a real permission becoming automatic reflection clears only the parent's old wait", async () => {
		await seedSubagentReflection();
		await db
			.update(narratorToolCalls)
			.set({ status: "initializing", permissionSuggestions: [] })
			.where(eq(narratorToolCalls.id, TOOL_CALL_ID));
		const release = claimNarratorRuntime(PARENT_ID, "test-parent-busy");
		const controller = new AbortController();
		const ready = Promise.withResolvers<void>();
		try {
			const permission = requestChildBashPermission(controller.signal, ready.resolve);
			await Promise.race([
				ready.promise,
				permission.then(() => {
					throw new Error("Expected a pending user permission");
				}),
			]);
			expect(pendingPermissions.has(TOOL_CALL_ID)).toBe(true);
			expect(statusUpdates).toContainEqual({
				narratorId: PARENT_ID,
				status: "waiting",
				substatus: undefined,
			});
			await db
				.update(narrators)
				.set({ permissionMode: "bypassPermissions", dangerReflectionOverride: "standard" })
				.where(eq(narrators.id, SUBAGENT_ID));
			statusUpdates.length = 0;

			expect(reprocessAllPendingPermissions(PARENT_ID)).toBe(1);
			expect((await permission).behavior).toBe("dangerReflection");
			expect(pendingPermissions.has(TOOL_CALL_ID)).toBe(false);
			expect(statusUpdates).toEqual([
				{ narratorId: SUBAGENT_ID, status: "waiting", substatus: ["reflecting"] },
				{ narratorId: PARENT_ID, status: "working", substatus: undefined },
			]);
		} finally {
			await cancelDangerReflection(TOOL_CALL_ID);
			controller.abort();
			release();
		}
	});

	test("aborting an automatic child gate cannot reset the parent's own status", async () => {
		await seedSubagentReflection();
		await db
			.update(narrators)
			.set({ permissionMode: "bypassPermissions", dangerReflectionOverride: "standard" })
			.where(eq(narrators.id, SUBAGENT_ID));
		const release = claimNarratorRuntime(PARENT_ID, "test-parent-busy");
		const controller = new AbortController();
		try {
			const result = await requestChildBashPermission(controller.signal);
			expect(result.behavior).toBe("dangerReflection");
			const pause = pendingDangerReflections.get(TOOL_CALL_ID);
			if (!pause || result.behavior !== "dangerReflection") throw new Error("Missing reflection");
			const finished = Promise.withResolvers<void>();
			const cleanup = pause.cleanup;
			pause.cleanup = () => {
				cleanup();
				finished.resolve();
			};
			statusUpdates.length = 0;
			controller.abort();
			await finished.promise;
			expect((await result.decision).behavior).toBe("deny");
			expect(statusUpdates.length).toBeGreaterThan(0);
			expect(statusUpdates.every((update) => update.narratorId === SUBAGENT_ID)).toBe(true);
		} finally {
			await cancelDangerReflection(TOOL_CALL_ID);
			release();
		}
	});

	for (const outcome of ["confirm", "cancel", "failed"] as const) {
		test(`${outcome} cannot reset the parent's own status`, async () => {
			await seedSubagentReflection();
			registerRuntimePause();
			const release = claimNarratorRuntime(PARENT_ID, "test-parent-busy");
			try {
				const resolved =
					outcome === "confirm"
						? await confirmDangerReflection(TOOL_CALL_ID)
						: await cancelDangerReflection(TOOL_CALL_ID, "Test outcome", "reflection", {
								failed: outcome === "failed",
							});
				expect(resolved).toBe(true);
				expect(statusUpdates.length).toBeGreaterThan(0);
				expect(statusUpdates.every((update) => update.narratorId === SUBAGENT_ID)).toBe(true);
				expect(
					broadcasts.some(
						(entry) =>
							entry.target === PARENT_ID && entry.message.type === "danger_reflection_resolved",
					),
				).toBe(true);
			} finally {
				release();
			}
		});
	}

	test("resolving a manually taken-over gate still clears the parent's user wait", async () => {
		await seedSubagentReflection();
		registerRuntimePause();
		const release = claimNarratorRuntime(PARENT_ID, "test-parent-busy");
		try {
			await stopDangerReflectionLoop(TOOL_CALL_ID);
			statusUpdates.length = 0;
			expect(await cancelDangerReflection(TOOL_CALL_ID, "Denied by user", "user")).toBe(true);
			expect(
				statusUpdates.some(
					(update) => update.narratorId === PARENT_ID && update.status === "working",
				),
			).toBe(true);
		} finally {
			release();
		}
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
