import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { narratorMessages, narrators, narratorToolCalls } from "../../../server/db/schema";
import type { ExecutionBackend } from "../../../server/lib/agent/execution/backend";
import { targetPathSemantics } from "../../../server/lib/agent/execution/path-semantics";
import {
	enterPlanModeTool,
	shouldDisablePlanReflectionReview,
} from "../../../server/lib/agent/tools/plan-mode";
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

describe("manual plan workspace binding", () => {
	function workspace(cwd = "D:\\original\\repo", revision = 4): WorkspaceContext {
		return {
			deviceId: "remote-plan",
			cwd,
			pathFlavor: "windows",
			revision,
			contextKey: `remote-plan:${cwd}`,
			capabilities: { switchDirectory: true },
		};
	}

	it("freezes a manual remote cycle and re-entry preserves the original legacy path after switching", async () => {
		seedNarrator("remote");
		const old = workspace();
		await db
			.update(narrators)
			.set({
				workspaceContext: old,
				workspaceRevision: 4,
				cwd: "/host-decoy",
				defaultDeviceId: "wrong-mirror",
			})
			.where(eq(narrators.id, "remote"));
		const first = await enterNarratorPlanMode("remote", "manual", undefined, { userId: null });
		expect(first.planFileBinding?.workspaceContext).toMatchObject({
			deviceId: "remote-plan",
			cwd: old.cwd,
			revision: 4,
		});
		const legacy = `.narrafork/plan-${first.planFileId}.md`;
		if (!first.planFileBinding) throw new Error("Expected persistent plan binding");
		const binding = { ...first.planFileBinding, planFilePath: legacy };
		const next = workspace("D:\\later\\repo", 5);
		await db
			.update(narrators)
			.set({
				workspaceContext: next,
				workspaceRevision: 5,
				cwd: next.cwd,
				planFileBinding: binding,
			})
			.where(eq(narrators.id, "remote"));
		const reentered = await enterNarratorPlanMode("remote");
		expect(reentered.planFileId).toBe(first.planFileId);
		expect(reentered.planFilePath).toBe(legacy);
		expect(reentered.planFileBinding).toEqual(binding);
		seedPlanToolCall("remote", "reenter-call", "reenter-use");
		const prepared = await prepareNarratorPlanMode("remote", "reenter-call", "reenter-use");
		expect(prepared.planFilePath).toBe(legacy);
		expect(prepared.planFileBinding).toEqual(binding);
		await exitNarratorPlanMode("remote");
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, "remote") }))?.planFileBinding,
		).toBeNull();
		const restarted = await enterNarratorPlanMode("remote");
		expect(restarted.planFileId).not.toBe(first.planFileId);
		expect(restarted.planFileBinding?.workspaceContext.cwd).toBe(next.cwd);
	});

	it("refuses to reinterpret an unbound legacy cycle after a workspace switch", async () => {
		seedNarrator("unbound");
		const current = workspace();
		await db
			.update(narrators)
			.set({
				workspaceContext: current,
				workspaceRevision: 4,
				planMode: true,
				traits: ["plan"],
				planFileId: "legacy",
				planFileBinding: null,
			})
			.where(eq(narrators.id, "unbound"));
		await expect(enterNarratorPlanMode("unbound")).rejects.toThrow(
			"Original plan source is unknown",
		);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, "unbound") }))?.planFileBinding,
		).toBeNull();
	});

	it("legacy recovery probes the supplied remote backend and retains its old filename", async () => {
		seedNarrator("legacy-remote");
		const current = workspace("D:\\unchanged", 0);
		await db
			.update(narrators)
			.set({
				workspaceContext: current,
				workspaceRevision: 0,
				planMode: true,
				traits: ["plan"],
				planFileId: "legacy",
			})
			.where(eq(narrators.id, "legacy-remote"));
		const paths = targetPathSemantics("windows");
		const stats: string[] = [];
		const backend = {
			deviceId: "remote-plan",
			kind: "remote",
			paths,
			runtimeGeneration: 1,
			resolvePathIdentity: async (path: string) => ({
				lexicalPath: path,
				canonicalPath: path,
				exists: true,
				runtimeGeneration: 1,
			}),
			statFile: async (path: string) => {
				stats.push(path);
				return path.endsWith("\\.narrafork\\plan-legacy.md")
					? { isFile: true, isDirectory: false, size: 10, resolvedPath: path }
					: null;
			},
		} as unknown as ExecutionBackend;
		const result = await enterNarratorPlanMode("legacy-remote", undefined, undefined, {
			workspaceContext: current,
			fileAccess: { backend, workspaceContext: current, authorizeRead: async () => true },
		});
		expect(result.planFilePath).toBe(".narrafork/plan-legacy.md");
		expect(result.planFileBinding?.workspaceContext.deviceId).toBe("remote-plan");
		expect(stats).toEqual([
			"D:\\unchanged\\.narrafork\\plans\\plan-legacy.md",
			"D:\\unchanged\\.narrafork\\plan-legacy.md",
		]);
	});

	it("stale frozen scope cannot install a new manual plan cycle", async () => {
		seedNarrator("stale");
		await db
			.update(narrators)
			.set({ workspaceContext: workspace("D:\\new", 5), workspaceRevision: 5 })
			.where(eq(narrators.id, "stale"));
		await expect(
			enterNarratorPlanMode("stale", undefined, undefined, { workspaceContext: workspace() }),
		).rejects.toThrow("Workspace changed");
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, "stale") }))?.planMode,
		).toBe(false);
	});

	it("exit clears an orphaned source binding even when mode/id were already reset", async () => {
		seedNarrator("orphan");
		await db
			.update(narrators)
			.set({
				planMode: false,
				planFileId: null,
				planFileBinding: {
					workspaceContext: workspace(),
					planFileId: "orphan-cycle",
					planFilePath: ".narrafork/plans/plan-orphan-cycle.md",
				},
			})
			.where(eq(narrators.id, "orphan"));
		expect((await exitNarratorPlanMode("orphan")).changed).toBe(true);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, "orphan") }))?.planFileBinding,
		).toBeNull();
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

describe("disableReflectionReview", () => {
	it("advertises an optional parameter and accepts the four explicit true values", () => {
		expect(enterPlanModeTool.parameters.safeParse({}).success).toBe(true);
		const schema = enterPlanModeTool.rawJsonSchema;
		expect(schema?.properties).toHaveProperty("disableReflectionReview");
		for (const value of [true, "true", 1, "1"]) {
			expect(
				enterPlanModeTool.parameters.safeParse({ disableReflectionReview: value }).success,
			).toBe(true);
			expect(shouldDisablePlanReflectionReview(value)).toBe(true);
		}
		for (const value of [undefined, false, "false", 0, "0", "yes", "TRUE", 2, null]) {
			expect(shouldDisablePlanReflectionReview(value)).toBe(false);
		}
	});

	for (const value of [true, "true", 1, "1"]) {
		for (const override of ["inherit", "on", "off"] as const) {
			it(`disables only the current narrator for ${JSON.stringify(value)} with ${override}`, async () => {
				seedNarrator("n1");
				seedNarrator("n2");
				db.update(narrators).set({ planReflectionAutoApproveOverride: override }).run();
				seedPlanToolCall("n1", "reflection-call", "reflection-use");
				db.update(narratorToolCalls)
					.set({ inputJson: { disableReflectionReview: value } })
					.where(eq(narratorToolCalls.id, "reflection-call"))
					.run();
				const prepared = await prepareNarratorPlanMode("n1", "reflection-call", "reflection-use");
				// Preparing/permission approval must not change durable settings.
				expect(
					(await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") }))
						?.planReflectionAutoApproveOverride,
				).toBe(override);
				const result = await commitPreparedEnterPlanModeResult("n1", prepared, {
					output: "entered",
				});
				expect(result.planReflectionDisabled).toBe(true);
				expect(
					(await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") }))
						?.planReflectionAutoApproveOverride,
				).toBe("off");
				expect(
					(await db.query.narrators.findFirst({ where: eq(narrators.id, "n2") }))
						?.planReflectionAutoApproveOverride,
				).toBe(override);
				await exitNarratorPlanMode("n1");
				expect(
					(await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") }))
						?.planReflectionAutoApproveOverride,
				).toBe("off");
			});
		}
	}

	for (const value of [undefined, false, "false", 0, "0"]) {
		it(`leaves reflection unchanged for ${JSON.stringify(value)}`, async () => {
			seedNarrator();
			db.update(narrators).set({ planReflectionAutoApproveOverride: "on" }).run();
			seedPlanToolCall("n1", "unchanged-call", "unchanged-use");
			db.update(narratorToolCalls)
				.set({ inputJson: value === undefined ? {} : { disableReflectionReview: value } })
				.where(eq(narratorToolCalls.id, "unchanged-call"))
				.run();
			const prepared = await prepareNarratorPlanMode("n1", "unchanged-call", "unchanged-use");
			const result = await commitPreparedEnterPlanModeResult("n1", prepared, { output: "entered" });
			expect(result.planReflectionDisabled).toBe(false);
			expect(
				(await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") }))
					?.planReflectionAutoApproveOverride,
			).toBe("on");
		});
	}
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

	it("rolls back the tool result and reflection override when the narrator state update fails", async () => {
		seedNarrator();
		db.update(narrators).set({ planReflectionAutoApproveOverride: "on" }).run();
		seedPlanToolCall("n1", "tool-call-1", "tool-use-1");
		db.update(narratorToolCalls)
			.set({ inputJson: { disableReflectionReview: true } })
			.where(eq(narratorToolCalls.id, "tool-call-1"))
			.run();
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
		expect(narrator?.planReflectionAutoApproveOverride).toBe("on");
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
