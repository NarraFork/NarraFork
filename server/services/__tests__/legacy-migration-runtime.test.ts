import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import { createRuntimeMapView, tryClaimExecution } from "../agent-runtime/ownership";
import * as state from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorService } = await import("../narrator-service");
const runtime = await import("../legacy-migration-runtime");
const session = await import("../narrator-session");
const { enqueueBufferedMessage, clearBufferedMessages } = await import("../narrator-buffer");
const ID = "legacy-runtime-fixture";
const children = createRuntimeMapView("subagentExecution");

function cache(): state.ActiveNarrator {
	// Match createNarrator's real required fields and idle metadata (no Partial cast).
	const active: state.ActiveNarrator = {
		narratorId: ID,
		conversationId: "next",
		_persistedConversationId: "old",
		abortController: new AbortController(),
		cwd: "/cache/workspace",
		model: "fixture-model",
		provider: "fixture-provider",
		systemPrompt: "fixture system prompt",
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		_modelRef: "fixture-model",
		_modelSelectionRef: "__default__",
		_settingsRevision: 1,
		_resetUpstreamSessionOnNextRequest: true,
		_reasoningEffortRef: null,
		_currentUserId: null,
		_defaultDeviceId: null,
		_loopRunning: false,
		_substatus: new Set(),
		_preparedPlanModes: new Map(),
		_enabledOptionalTools: new Set(["Browser"]),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_interruptCleanupDone: false,
		_skillRoot: "/cache/workspace",
		_skillScopeKey: "fixture-scope",
		_workspaceContext: {
			revision: 0,
			deviceId: "local",
			cwd: "/cache/workspace",
			pathFlavor: "posix",
			contextKey: "fixture",
			capabilities: { switchDirectory: true },
		},
	};
	Object.assign(active, { _executionAuthority: { principal: "user", scopes: ["read"] } });
	state.activeNarrators.set(ID, active);
	return active;
}

beforeEach(async () => {
	cleanDb(sqlite);
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: ID,
		variant: "primary",
		status: "idle",
		apiConversationId: "old",
		createdAt: now,
		updatedAt: now,
	});
});
afterEach(async () => {
	mock.restore();
	state.activeNarrators.delete(ID);
	state.narratorCreationLocks.delete(ID);
	state.compactLocks.delete(ID);
	state.pendingFeedback.delete(ID);
	state.pendingPlanApprover.delete(ID);
	state.pendingPermissions.delete("permission");
	children.delete("child");
	await clearBufferedMessages(ID);
});
afterAll(() => {
	mock.module("../../db", () => realDb);
});

async function persisted(): Promise<string | null | undefined> {
	return (
		await db.query.narrators.findFirst({
			where: eq(narrators.id, ID),
			columns: { apiConversationId: true },
		})
	)?.apiConversationId;
}

test("idle cache preview and eviction persist CAS before body without abort", async () => {
	const active = cache();
	const listener = mock(() => {});
	active.events.on("event", listener);
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(false);
	expect(state.activeNarrators.get(ID)).toBe(active);
	expect(
		await runtime.withLegacyMigrationRuntimeAdmission([ID, ID], async () => {
			expect(await persisted()).toBe("next");
			expect(state.activeNarrators.has(ID)).toBe(false);
			expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(false);
			expect(state.isNarratorRevertAdmissionBlocked(ID)).toBe(true);
			expect(() => state.withNarratorStartAdmission(ID, async () => true)).toThrow();
			return "migrated";
		}),
	).toBe("migrated");
	expect(active.abortController.signal.aborted).toBe(false);
	expect(listener).not.toHaveBeenCalled();
	expect(active.events.listenerCount("event")).toBe(0);
	expect(state.isNarratorRevertAdmissionBlocked(ID)).toBe(false);
});

test("CAS loses to compact and never restores its cleared ID", async () => {
	cache();
	await db.update(narrators).set({ apiConversationId: null }).where(eq(narrators.id, ID));
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => "ok")).toBe("ok");
	expect(await persisted()).toBeNull();
});

test("permission and feedback remain untouched when migration declines", async () => {
	const active = cache();
	const cleanup = mock(() => {});
	const resolve = mock(() => {});
	const permission = { narratorId: ID, cleanup, resolve } as unknown as state.PendingPermission;
	state.pendingPermissions.set("permission", permission);
	const feedback = { toolUseId: "tool", feedbackText: "real user input" };
	state.pendingFeedback.set(ID, feedback);
	const body = mock(async () => true);
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], body)).toBeNull();
	expect(body).not.toHaveBeenCalled();
	expect(cleanup).not.toHaveBeenCalled();
	expect(resolve).not.toHaveBeenCalled();
	expect(state.pendingPermissions.get("permission")).toBe(permission);
	expect(state.pendingFeedback.get(ID)).toBe(feedback);
	expect(active.abortController.signal.aborted).toBe(false);
});

test("compact, plan approver, creation, execution and active child each block", async () => {
	const active = cache();
	state.compactLocks.set(ID, {} as state.CompactLock);
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	state.compactLocks.delete(ID);
	state.pendingPlanApprover.set(ID, "user");
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
	state.pendingPlanApprover.delete(ID);
	state.narratorCreationLocks.set(ID, Promise.resolve(active));
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
	state.narratorCreationLocks.delete(ID);
	const owner = tryClaimExecution(ID, "primary");
	if (!owner) throw new Error("Fixture failed to claim execution");
	try {
		expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
	} finally {
		owner.release();
	}
	children.set("child", {
		subagentId: "child",
		parentNarratorId: ID,
		token: "token",
		toolUseId: "t",
		startedAt: 0,
		timeoutMs: null,
		executionDeadlineAt: null,
		background: false,
	});
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
});

test("queued user buffer is preserved", async () => {
	cache();
	expect((await enqueueBufferedMessage(ID, "do not discard me")).ok).toBe(true);
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	expect(state.bufferedMessages.get(ID)?.[0]?.text).toBe("do not discard me");
});

test("start winning admission blocks immediately and is not interrupted", async () => {
	let unblock!: () => void;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	const start = state.withNarratorStartAdmission(ID, async () => {
		entered();
		await blocked;
	});
	await ready;
	try {
		expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	} finally {
		unblock();
		await start;
	}
});

test("CAS await rechecks the same instance and preserves late user interaction", async () => {
	const active = cache();
	const write = spyOn(narratorService, "updateConversationId").mockImplementation(async () => {
		state.pendingFeedback.set(ID, { toolUseId: "late", feedbackText: "preserve" });
		return true;
	});
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	expect(write).toHaveBeenCalledWith(ID, "next", "old");
	expect(state.activeNarrators.get(ID)).toBe(active);
	expect(state.pendingFeedback.get(ID)?.feedbackText).toBe("preserve");
	expect(active.abortController.signal.aborted).toBe(false);
});

test("replacement cache during CAS is not removed", async () => {
	const active = cache();
	const replacement = { ...active, events: new EventEmitter() };
	spyOn(narratorService, "updateConversationId").mockImplementation(async () => {
		state.activeNarrators.set(ID, replacement);
		return true;
	});
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	expect(state.activeNarrators.get(ID)).toBe(replacement);
});

test("body and persistence exceptions release every gate", async () => {
	await expect(
		runtime.withLegacyMigrationRuntimeAdmission([ID, "other"], async () => {
			throw new Error("body");
		}),
	).rejects.toThrow("body");
	for (const id of [ID, "other"]) expect(state.isNarratorRevertAdmissionBlocked(id)).toBe(false);
	const active = cache();
	spyOn(narratorService, "updateConversationId").mockRejectedValue(new Error("storage"));
	await expect(runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).rejects.toThrow(
		"storage",
	);
	expect(state.activeNarrators.get(ID)).toBe(active);
	expect(state.isNarratorRevertAdmissionBlocked(ID)).toBe(false);
});

test("browser resources and unknown runner promises block without cleanup", async () => {
	const browser = await import("../../lib/browser/session");
	spyOn(browser, "getAllSessionStats").mockReturnValue({
		totalSessions: 1,
		narrators: [{ narratorId: ID, sessionCount: 1 }],
	});
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	mock.restore();
	const active = cache();
	Object.assign(active, { _unknownRunner: Promise.resolve() });
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
	expect(active.abortController.signal.aborted).toBe(false);
});

test("live background Bash and malformed unknown registry block without stopping", async () => {
	const symbol = Symbol.for("narrafork:bg-task:abortControllers");
	const parentsSymbol = Symbol.for("narrafork:bg-task:parentNarratorCache");
	const original = Reflect.get(globalThis, symbol);
	const originalParents = Reflect.get(globalThis, parentsSymbol);
	const controller = new AbortController();
	try {
		Reflect.set(globalThis, symbol, new Map([["bash", controller]]));
		Reflect.set(globalThis, parentsSymbol, new Map([["bash", ID]]));
		expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
		expect(controller.signal.aborted).toBe(false);
		Reflect.set(globalThis, symbol, {});
		expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
	} finally {
		Reflect.set(globalThis, symbol, original);
		Reflect.set(globalThis, parentsSymbol, originalParents);
	}
});

test("automatic and user-owned task/plan reflections remain intact", async () => {
	const active = cache();
	for (const key of ["narrafork.pendingTaskReflections", "narrafork.pendingExitPlanReflections"]) {
		const symbol = Symbol.for(key);
		const original = Reflect.get(globalThis, symbol);
		const resolve = mock(() => {});
		const pending = {
			narratorId: ID,
			resolve,
			abortController: new AbortController(),
			reflectionStoppedByUser: true,
		};
		const registry = new Map([["reflection", pending]]);
		try {
			Reflect.set(globalThis, symbol, registry);
			expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
			expect(registry.get("reflection")).toBe(pending);
			expect(resolve).not.toHaveBeenCalled();
			expect(pending.abortController.signal.aborted).toBe(false);
		} finally {
			Reflect.set(globalThis, symbol, original);
		}
	}
	expect(state.activeNarrators.get(ID)).toBe(active);
});

test("an existing external cleanup gate is never mistaken for own reservation", async () => {
	await state.withIdleNarratorCleanupAdmission([ID], async () => {
		expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
		expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	});
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(false);
});

test("runtime workspace observation remains identical through unload until body settles", async () => {
	const active = cache();
	const before = runtime.getLegacyMigrationRuntimeWorkspace(ID);
	expect(before?.cwd).toBe(active.cwd);
	expect(before?.deviceId).toBe("local");
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(false);
	await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => {
		expect(state.activeNarrators.has(ID)).toBe(false);
		expect(runtime.getLegacyMigrationRuntimeWorkspace(ID)).toEqual(before);
		const copy = runtime.getLegacyMigrationRuntimeWorkspace(ID);
		if (copy?.context) copy.context.cwd = "caller-mutation";
		await Promise.resolve();
		expect(runtime.getLegacyMigrationRuntimeWorkspace(ID)).toEqual(before);
	});
	expect(runtime.getLegacyMigrationRuntimeWorkspace(ID)).toBeNull();
});

test("runtime observation uses cache device when uncommitted but valid persistence wins", async () => {
	const active = cache();
	active._defaultDeviceId = "remote-cache";
	expect(runtime.getLegacyMigrationRuntimeWorkspace(ID)).toMatchObject({
		cwd: active.cwd,
		deviceId: "remote-cache",
	});
	const committed = {
		revision: 3,
		deviceId: "local",
		cwd: "/persisted/workspace",
		pathFlavor: "posix" as const,
		contextKey: "committed",
		capabilities: { switchDirectory: true },
	};
	await db
		.update(narrators)
		.set({ workspaceContext: committed, workspaceRevision: 3, defaultDeviceId: null })
		.where(eq(narrators.id, ID));
	const before = runtime.getLegacyMigrationRuntimeWorkspace(ID);
	expect(before).toEqual({ cwd: committed.cwd, deviceId: "local", context: committed });
	await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => {
		expect(runtime.getLegacyMigrationRuntimeWorkspace(ID)).toEqual(before);
	});
});

test("invalid committed context does not override cache cwd", async () => {
	const active = cache();
	const stale = { ...active._workspaceContext, revision: 1, cwd: "/stale/context" } as NonNullable<
		state.ActiveNarrator["_workspaceContext"]
	>;
	await db
		.update(narrators)
		.set({ workspaceContext: stale, workspaceRevision: 2 })
		.where(eq(narrators.id, ID));
	expect(runtime.getLegacyMigrationRuntimeWorkspace(ID)?.cwd).toBe(active.cwd);
});

test("workspace install failure, pass invalidation and live substatus block full-shaped cache", async () => {
	const active = cache();
	active._workspaceInstallFailed = true;
	expect(await runtime.withLegacyMigrationRuntimeAdmission([ID], async () => true)).toBeNull();
	active._workspaceInstallFailed = false;
	active._workspacePassInvalidated = true;
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
	active._workspacePassInvalidated = false;
	active._substatus.add("permission");
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(true);
	active._substatus.clear();
	expect(runtime.isLegacyMigrationRuntimeBusy(ID)).toBe(false);
});

test("safe unload does not accept an instance that is no longer active", async () => {
	const old = cache();
	cache();
	expect(await session.unloadIdleNarratorSessionForLegacyMigration(ID, old, () => true)).toBe(
		false,
	);
});
