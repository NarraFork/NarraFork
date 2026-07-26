/**
 * plan-body-integrity.test.ts — Guards against the model-facing plan reference
 * ("The plan was approved. Its full content is saved in the plan file: …")
 * replacing a real ExitPlanMode plan body.
 *
 * That sentence exists only for model history; the DB keeps the full plan so the
 * UI can render it. One row was observed in the wild whose persisted
 * `input_json.plan` (and matching message content block) had been overwritten
 * with it, which blanks the plan for the user in every renderer.
 *
 * Two independent defences are covered here:
 *   1. resolveExitPlanModeInputWithBackend must treat the reference as a path
 *      reference, not a complete inline plan, so the real plan file is re-read
 *      (this is also what lets an already-corrupted row heal itself).
 *   2. overwriteToolCallInput must refuse to persist the reference over a longer
 *      stored plan, while leaving legitimate overwrites alone.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };

mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { activeNarrators } = await import("../narrator-session-state");
const { resolveExitPlanModeInputWithBackend } = await import("../narrator-permission");
const { narratorPersistence } = await import("../narrator-persistence");

const PLAN_BODY = `# Real plan\n\n## Step 1\n\n${"Detail line.\n".repeat(40)}`;
/** The reference sentence exactly as observed persisted over a real plan. */
const PLAN_REFERENCE =
	"The plan was approved. Its full content is saved in the plan file: " +
	".narrafork/plan-shiki-static-edge--M5vvbT5A4myB7IPR.md. " +
	"Re-read that file with the Read tool if you need the plan details.";

const now = () => new Date().toISOString();

afterEach(() => {
	activeNarrators.clear();
	sqlite.run("DELETE FROM narrator_tool_calls");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Resolution: the reference must never be accepted as an inline plan.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveExitPlanModeInputWithBackend — model plan reference", () => {
	/** A cwd containing the designated plan file with the genuine plan body. */
	function makePlanWorkspace(planFileId: string, body = PLAN_BODY) {
		const root = mkdtempSync(join(tmpdir(), "nf-plan-integrity-"));
		mkdirSync(join(root, ".narrafork"), { recursive: true });
		writeFileSync(join(root, ".narrafork", `plan-${planFileId}.md`), body, "utf-8");
		return root;
	}

	test("re-reads the plan file instead of accepting the reference as the plan", async () => {
		const narratorId = "plan-ref-narrator";
		const planFileId = "healing-cycle";
		const root = makePlanWorkspace(planFileId);
		try {
			activeNarrators.set(narratorId, { _planFileId: planFileId } as never);
			const resolved = await resolveExitPlanModeInputWithBackend(narratorId, root, {
				plan: PLAN_REFERENCE,
				allowedPrompts: [],
			});
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			// The corrupted reference is discarded; the real plan comes back from disk.
			expect(resolved.resolvedFromFile).toBe(true);
			expect(resolved.input.plan).toBe(PLAN_BODY);
			expect(String(resolved.input.plan)).not.toContain("Its full content is saved");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects the reference when no plan file backs it", async () => {
		const narratorId = "plan-ref-no-file-narrator";
		const root = mkdtempSync(join(tmpdir(), "nf-plan-integrity-empty-"));
		try {
			activeNarrators.set(narratorId, { _planFileId: "missing-cycle" } as never);
			const resolved = await resolveExitPlanModeInputWithBackend(narratorId, root, {
				plan: PLAN_REFERENCE,
			});
			// Never silently shown to the user as if it were the plan.
			expect(resolved.ok).toBe(false);
			if (resolved.ok) return;
			expect(resolved.input.plan).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("still accepts a genuine inline plan", async () => {
		const narratorId = "plan-inline-narrator";
		const root = mkdtempSync(join(tmpdir(), "nf-plan-integrity-inline-"));
		try {
			activeNarrators.set(narratorId, {} as never);
			const resolved = await resolveExitPlanModeInputWithBackend(narratorId, root, {
				plan: PLAN_BODY,
			});
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			// Inline plans are normalized with trim(); the body itself is preserved.
			expect(resolved.input.plan).toBe(PLAN_BODY.trim());
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Persistence: the write path must protect a stored plan body.
// ─────────────────────────────────────────────────────────────────────────────
describe("overwriteToolCallInput — stored plan body guard", () => {
	const narratorId = "plan-persist-narrator";
	const messageId = "plan-persist-message";
	const toolCallId = "plan-persist-tool-call";
	const toolUseId = "plan-persist-tool-use";

	async function seed(toolName: string, inputJson: Record<string, unknown>): Promise<void> {
		await db.insert(narrators).values({ id: narratorId, createdAt: now(), updatedAt: now() });
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input: inputJson }],
			createdAt: now(),
		});
		await db.insert(narratorToolCalls).values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName,
			status: "success",
			inputJson,
			createdAt: now(),
		});
	}

	async function storedPlan(): Promise<{ row: unknown; block: unknown }> {
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, toolCallId),
			columns: { inputJson: true },
		});
		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { contentJson: true },
		});
		const blocks = (msg?.contentJson ?? []) as Array<Record<string, unknown>>;
		const block = blocks.find((b) => b.type === "tool_use")?.input as
			| Record<string, unknown>
			| undefined;
		return {
			row: (row?.inputJson as Record<string, unknown> | undefined)?.plan,
			block: block?.plan,
		};
	}

	test("refuses to replace a real plan with the model reference", async () => {
		await seed("ExitPlanMode", { allowedPrompts: [], plan: PLAN_BODY, _planFile: "p.md" });
		await narratorPersistence.overwriteToolCallInput(toolUseId, {
			allowedPrompts: [],
			plan: PLAN_REFERENCE,
			_planFile: "p.md",
		});
		const { row, block } = await storedPlan();
		// Both the tool call row and the message content block keep the real plan.
		expect(row).toBe(PLAN_BODY);
		expect(block).toBe(PLAN_BODY);
	});

	test("lets a user-edited plan through", async () => {
		const edited = `${PLAN_BODY}\n\n## Added by the user\n\nMore detail.`;
		await seed("ExitPlanMode", { plan: PLAN_BODY, _planFile: "p.md" });
		await narratorPersistence.overwriteToolCallInput(toolUseId, {
			plan: edited,
			_planFile: "p.md",
		});
		const { row, block } = await storedPlan();
		expect(row).toBe(edited);
		expect(block).toBe(edited);
	});

	test("lets a broken-input placeholder through", async () => {
		const placeholder = "[content omitted: 12345 chars]";
		await seed("ExitPlanMode", { plan: PLAN_BODY, _planFile: "p.md" });
		await narratorPersistence.overwriteToolCallInput(toolUseId, { plan: placeholder });
		expect((await storedPlan()).row).toBe(placeholder);
	});

	test("writes normally when no plan is stored yet", async () => {
		await seed("ExitPlanMode", { allowedPrompts: [] });
		await narratorPersistence.overwriteToolCallInput(toolUseId, { plan: PLAN_REFERENCE });
		// Nothing better to preserve — a first write must not be blocked.
		expect((await storedPlan()).row).toBe(PLAN_REFERENCE);
	});

	test("does not intervene on non-ExitPlanMode tools", async () => {
		await seed("Read", { file_path: "/a", plan: PLAN_BODY });
		await narratorPersistence.overwriteToolCallInput(toolUseId, {
			file_path: "/a",
			plan: PLAN_REFERENCE,
		});
		expect((await storedPlan()).row).toBe(PLAN_REFERENCE);
	});
});
