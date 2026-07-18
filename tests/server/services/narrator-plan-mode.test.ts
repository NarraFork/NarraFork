import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { narratorMessages, narrators, narratorToolCalls } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const {
	commitPreparedEnterPlanModeResult,
	enterNarratorPlanMode,
	exitNarratorPlanMode,
	prepareNarratorPlanMode,
} = await import("../../../server/services/narrator-plan-mode");

const NOW = "2026-05-10T00:00:00.000Z";

afterEach(() => {
	sqlite.exec("DROP TRIGGER IF EXISTS test_fail_plan_mode_update");
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

function seedPlanToolCall(
	narratorId: string,
	toolCallId: string,
	toolUseId: string,
	messageId = `message-${toolCallId}`,
) {
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: "EnterPlanMode",
			inputJson: {},
			status: "running",
			createdAt: NOW,
		})
		.run();
}

function seedNarrator(
	id = "n1",
	relaxedPlan = false,
	permissionMode:
		| "default"
		| "acceptEdits"
		| "bypassPermissions"
		| "readOnly"
		| "dontAsk" = "default",
) {
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			inheritMode: "fresh",
			permissionMode,
			relaxedPlan,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("enterNarratorPlanMode", () => {
	it("enters plan mode without auto-relaxing the plan", async () => {
		seedNarrator();

		const result = await enterNarratorPlanMode("n1");

		expect(result.wasPlanMode).toBe(false);
		expect(result.relaxedPlan).toBe(false);
		expect(result.relaxedPlanChanged).toBe(false);

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(false);
		expect(row?.traits).toContain("plan");
	});

	it("preserves an already-relaxed plan when entering plan mode", async () => {
		seedNarrator("n1", true);

		const result = await enterNarratorPlanMode("n1");

		expect(result.relaxedPlan).toBe(true);
		expect(result.relaxedPlanChanged).toBe(false);

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(true);
	});

	it("forces relaxed plan under bypassPermissions even when user default is false", async () => {
		seedNarrator("n1", false, "bypassPermissions");

		const result = await enterNarratorPlanMode("n1");

		expect(result.relaxedPlan).toBe(true);
		expect(result.relaxedPlanChanged).toBe(true);

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(true);
	});
});

describe("plan file identity lifecycle", () => {
	it("gives concurrent same-name plan cycles different identities", async () => {
		seedNarrator("n1");
		seedNarrator("n2");
		seedPlanToolCall("n1", "tool-call-n1", "tool-use-n1");
		seedPlanToolCall("n2", "tool-call-n2", "tool-use-n2");

		const [first, second] = await Promise.all([
			prepareNarratorPlanMode("n1", "tool-call-n1", "tool-use-n1", "same plan"),
			prepareNarratorPlanMode("n2", "tool-call-n2", "tool-use-n2", "same plan"),
		]);

		expect(first.planFileId).not.toBe(second.planFileId);
		expect(first.planFileId).toMatch(/^same-plan--[A-Za-z0-9]{16}$/);
		expect(second.planFileId).toMatch(/^same-plan--[A-Za-z0-9]{16}$/);
	});

	it("does not reuse an identity across sequential plan cycles", async () => {
		seedNarrator("n1");
		seedPlanToolCall("n1", "tool-call-cycle-1", "tool-use-cycle-1");
		const firstPrepared = await prepareNarratorPlanMode(
			"n1",
			"tool-call-cycle-1",
			"tool-use-cycle-1",
			"repeatable name",
		);
		await commitPreparedEnterPlanModeResult("n1", firstPrepared, { output: "entered" });
		await exitNarratorPlanMode("n1");

		seedPlanToolCall("n1", "tool-call-cycle-2", "tool-use-cycle-2");
		const secondPrepared = await prepareNarratorPlanMode(
			"n1",
			"tool-call-cycle-2",
			"tool-use-cycle-2",
			"repeatable name",
		);

		expect(secondPrepared.planFileId).not.toBe(firstPrepared.planFileId);
		expect(secondPrepared.planFileId).toMatch(/^repeatable-name--[A-Za-z0-9]{16}$/);
	});

	it("does not accept a stale prepared identity from an earlier cycle", async () => {
		seedNarrator("n1");
		seedPlanToolCall("n1", "tool-call-stale-1", "tool-use-stale-1");
		const firstPrepared = await prepareNarratorPlanMode(
			"n1",
			"tool-call-stale-1",
			"tool-use-stale-1",
			"stale identity",
		);
		await commitPreparedEnterPlanModeResult("n1", firstPrepared, { output: "entered" });
		await exitNarratorPlanMode("n1");

		const secondState = await enterNarratorPlanMode(
			"n1",
			"stale identity",
			firstPrepared.planFileId,
		);
		expect(secondState.planFileId).not.toBe(firstPrepared.planFileId);
		expect(secondState.planFileId).toMatch(/^stale-identity--[A-Za-z0-9]{16}$/);
	});

	it("invalidates a prepared identity when its cycle exits before commit", async () => {
		seedNarrator("n1");
		seedPlanToolCall("n1", "tool-call-aborted", "tool-use-aborted");
		const prepared = await prepareNarratorPlanMode(
			"n1",
			"tool-call-aborted",
			"tool-use-aborted",
			"aborted cycle",
		);
		await exitNarratorPlanMode("n1");

		const state = await enterNarratorPlanMode("n1", "aborted cycle", prepared.planFileId);
		expect(state.planFileId).not.toBe(prepared.planFileId);
		expect(state.planFileId).toMatch(/^aborted-cycle--[A-Za-z0-9]{16}$/);
	});

	it("rejects a prepared identity after its tool call fails", async () => {
		seedNarrator("n1");
		seedPlanToolCall("n1", "tool-call-failed", "tool-use-failed");
		const prepared = await prepareNarratorPlanMode(
			"n1",
			"tool-call-failed",
			"tool-use-failed",
			"failed cycle",
		);
		db.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.id, "tool-call-failed"))
			.run();

		const state = await enterNarratorPlanMode("n1", "failed cycle", prepared.planFileId);
		expect(state.planFileId).not.toBe(prepared.planFileId);
		expect(state.planFileId).toMatch(/^failed-cycle--[A-Za-z0-9]{16}$/);
	});

	it("keeps a readable multi-byte prefix within a conservative UTF-8 byte limit", async () => {
		seedNarrator("n1");
		seedPlanToolCall("n1", "tool-call-long", "tool-use-long");
		const longName = `${"计划方案".repeat(100)}/with unsafe separators`;
		const prepared = await prepareNarratorPlanMode(
			"n1",
			"tool-call-long",
			"tool-use-long",
			longName,
		);
		const separator = prepared.planFileId.lastIndexOf("--");
		const prefix = prepared.planFileId.slice(0, separator);

		expect(separator).toBeGreaterThan(0);
		expect(prefix.startsWith("计划方案")).toBe(true);
		expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(48);
		expect(prepared.planFileId).toMatch(/--[A-Za-z0-9]{16}$/);
		expect(prepared.planFileId).not.toContain("/");
	});
});

describe("commitPreparedEnterPlanModeResult", () => {
	it("atomically persists the tool result and converges concurrent preparations", async () => {
		seedNarrator();
		seedPlanToolCall("n1", "tool-call-1", "tool-use-1");
		seedPlanToolCall("n1", "tool-call-2", "tool-use-2");
		const first = await prepareNarratorPlanMode("n1", "tool-call-1", "tool-use-1", "alpha");
		const second = await prepareNarratorPlanMode("n1", "tool-call-2", "tool-use-2", "beta");
		expect(first.planFileId).not.toBe(second.planFileId);

		const firstState = await commitPreparedEnterPlanModeResult("n1", first, {
			output: "entered alpha",
		});
		const secondState = await commitPreparedEnterPlanModeResult("n1", second, {
			output: "entered beta",
		});

		expect(firstState.planFileId).toBe(first.planFileId);
		expect(secondState.planFileId).toBe(first.planFileId);
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(narrator?.planFileId).toBe(first.planFileId);
		expect(narrator?.planMode).toBe(true);
		expect(narrator?.messageVersion).toBe(2);
		const toolCalls = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.narratorId, "n1"),
		});
		expect(toolCalls.map((row) => row.status)).toEqual(["success", "success"]);
	});

	it("rolls back the tool result when the narrator state update fails", async () => {
		seedNarrator();
		seedPlanToolCall("n1", "tool-call-1", "tool-use-1");
		const prepared = await prepareNarratorPlanMode(
			"n1",
			"tool-call-1",
			"tool-use-1",
			"atomic-plan",
		);
		sqlite.exec(`
			CREATE TRIGGER test_fail_plan_mode_update
			BEFORE UPDATE OF plan_mode ON narrators
			WHEN NEW.plan_mode = 1
			BEGIN
				SELECT RAISE(ABORT, 'forced plan update failure');
			END;
		`);

		await expect(
			commitPreparedEnterPlanModeResult("n1", prepared, { output: "must roll back" }),
		).rejects.toThrow("forced plan update failure");

		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		const toolCall = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "tool-call-1"),
		});
		expect(narrator?.planMode).toBe(false);
		expect(narrator?.planFileId).toBeNull();
		expect(narrator?.traits).not.toContain("plan");
		expect(toolCall?.status).toBe("running");
		expect(toolCall?.outputJson).toBeNull();

		// The failed transaction must not consume the in-memory prepared identity.
		sqlite.exec("DROP TRIGGER test_fail_plan_mode_update");
		const retried = await commitPreparedEnterPlanModeResult("n1", prepared, {
			output: "retried successfully",
		});
		expect(retried.planFileId).toBe(prepared.planFileId);
		const retriedNarrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, "n1"),
		});
		const retriedToolCall = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "tool-call-1"),
		});
		expect(retriedNarrator?.planMode).toBe(true);
		expect(retriedNarrator?.planFileId).toBe(prepared.planFileId);
		expect(retriedToolCall?.status).toBe("success");
		expect(retriedToolCall?.outputJson).toBe("retried successfully");
	});
});
