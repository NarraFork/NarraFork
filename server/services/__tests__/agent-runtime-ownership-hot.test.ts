import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { hotSafe } from "../../lib/hot-safe";
import type { ActiveNarrator, ActiveSubagentSettings } from "../narrator-session-state";
import type { RunningSubagentExecutionSnapshot } from "../subagent-runner";

// Run this file in its own Bun process: seed the pre-P1 objects BEFORE importing
// the runtime, exactly as old --hot closures would hold them across re-evaluation.
const legacySessions = hotSafe<Map<string, ActiveNarrator>>(
	"narrafork.activeNarrators",
	() => new Map(),
);
const legacySettings = hotSafe<Map<string, ActiveSubagentSettings>>(
	"narrafork.activeSubagentSettings",
	() => new Map(),
);
const legacyAdmissions = hotSafe<Set<string>>("narrafork.narratorLoopAdmissions", () => new Set());
const legacyTools = hotSafe<Map<string, Promise<void>>>(
	"narrafork.narratorToolExecutionAdmissions",
	() => new Map(),
);
type Runner = RunningSubagentExecutionSnapshot & { token: string };
const legacyRunners = hotSafe<Map<string, Runner>>(
	"narrafork:runningSubagentExecutions",
	() => new Map(),
);

function session(id: string): ActiveNarrator {
	return {
		narratorId: id,
		conversationId: "legacy-conversation",
		cwd: "/legacy",
		model: "legacy:model",
		provider: "legacy",
		systemPrompt: "retained prompt",
		events: new EventEmitter(),
		alive: true,
		locale: "zh-CN",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(["ShareFile"]),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(["reasoning"]),
		_lastMeterUsage: 42,
		_defaultDeviceId: "legacy-device",
	};
}
function runner(id: string): Runner {
	return {
		subagentId: id,
		parentNarratorId: "hot-root",
		toolUseId: "legacy-origin",
		token: `run-${id}`,
		startedAt: 1,
		timeoutMs: null,
		executionDeadlineAt: null,
		background: true,
	};
}

const PRIMARY = "hot-draining-primary";
const CHILD = "hot-active-child";
const PREPARING = "hot-preparing-child";
const REPLAY = "hot-replaying-tool";
const CACHE = "hot-idle-cache";
const SUSPENDED = "hot-suspended-child";
const manual = await import("../subagent-manual-override");
const suspendedControl = manual.waitForManualOverride(
	SUSPENDED,
	new AbortController().signal,
	"hot-root",
	"standalone-hot-suspended-child",
);
const primary = session(PRIMARY);
primary.alive = false;
primary._loopRunning = false; // finalizer still owns its original reservation
const childSettings = { model: "child:model", reasoningEffort: "high" as const };
const cached = session(CACHE);
const replayCompletion = Promise.resolve();
legacySessions.set(PRIMARY, primary);
legacyAdmissions.add(PRIMARY);
legacySettings.set(CHILD, childSettings);
legacyRunners.set(CHILD, runner(CHILD));
legacyRunners.set(PREPARING, runner(PREPARING));
legacyRunners.set(SUSPENDED, { ...runner(SUSPENDED), background: false });
legacyTools.set(REPLAY, replayCompletion);
legacySessions.set(CACHE, cached);

const ownership = await import("../agent-runtime/ownership");
const sessions = ownership.createRuntimeMapView("session");
const settings = ownership.createRuntimeMapView("subagentSettings");
const runners = ownership.createRuntimeMapView("subagentExecution");
const tools = ownership.createRuntimeMapView("toolReplayCompletion");
const extraIds = new Set<string>();
function requireOwner(id: string) {
	const owner = ownership.getExecutionOwner(id);
	if (!owner) throw new Error(`Missing execution owner: ${id}`);
	return owner;
}
function newOwner(id: string) {
	const owner = ownership.tryClaimExecution(id, "primary");
	if (!owner) throw new Error(`Could not claim ${id}`);
	return owner;
}

afterAll(() => {
	legacySessions.clear();
	legacySettings.clear();
	legacyAdmissions.clear();
	legacyTools.clear();
	legacyRunners.clear();
	manual.clearManualOverrideRuntimes();
	for (const id of [PRIMARY, CHILD, PREPARING, REPLAY, CACHE, SUSPENDED, ...extraIds]) {
		ownership.getExecutionOwner(id)?.release();
		sessions.delete(id);
		settings.delete(id);
		runners.delete(id);
		tools.delete(id);
	}
});

test("adopts native containers once without losing observable objects, caches or old owners", () => {
	expect(hotSafe("narrafork.activeNarrators", () => legacySessions)).toBe(legacySessions);
	expect(hotSafe("narrafork.activeSubagentSettings", () => legacySettings)).toBe(legacySettings);
	expect(hotSafe("narrafork.narratorLoopAdmissions", () => legacyAdmissions)).toBe(
		legacyAdmissions,
	);
	expect(hotSafe("narrafork:runningSubagentExecutions", () => legacyRunners)).toBe(legacyRunners);
	// Native slots are empty: old objects now forward, not maintain a second Map.
	expect([...Map.prototype.entries.call(legacySessions)]).toEqual([]);
	expect([...Map.prototype.entries.call(legacySettings)]).toEqual([]);
	expect([...Map.prototype.entries.call(legacyRunners)]).toEqual([]);
	expect([...Set.prototype.values.call(legacyAdmissions)]).toEqual([]);
	expect(sessions.get(PRIMARY)).toBe(primary);
	expect(legacySessions.get(PRIMARY)).toBe(primary);
	expect(sessions.get(CACHE)).toBe(cached);
	expect(sessions.get(CACHE)?._enabledOptionalTools).toBe(cached._enabledOptionalTools);
	expect(sessions.get(CACHE)?._lastMeterUsage).toBe(42);
	expect(settings.get(CHILD)).toBe(childSettings);
	expect(tools.get(REPLAY)).toBe(replayCompletion);
	for (const id of [PRIMARY, CHILD, PREPARING, REPLAY]) {
		expect(ownership.tryClaimExecution(id, "primary")).toBeNull();
		expect(legacyAdmissions.has(id)).toBe(true);
	}
	expect(ownership.getExecutionOwner(CACHE)).toBeUndefined();
});

test("old primary cleanup releases only after both session and reservation drain", () => {
	const owner = requireOwner(PRIMARY);
	legacySessions.delete(PRIMARY);
	expect(sessions.has(PRIMARY)).toBe(false);
	expect(owner.isCurrent()).toBe(true);
	legacyAdmissions.delete(PRIMARY);
	expect(owner.isCurrent()).toBe(false);
	const next = newOwner(PRIMARY);
	const replacement = session(PRIMARY);
	sessions.set(PRIMARY, replacement);
	legacyAdmissions.delete(PRIMARY); // repeated stale finally
	legacySessions.delete(PRIMARY);
	expect(requireOwner(PRIMARY)).toBe(next);
	expect(sessions.get(PRIMARY)).toBe(replacement);
	expect(legacySessions.get(PRIMARY)).toBe(replacement);
});

test("old child settings remain editable and preparing runner protects the ownership gap", () => {
	const oldSettings = legacySettings.get(CHILD);
	if (!oldSettings) throw new Error("Missing legacy child settings");
	oldSettings.model = "child:changed";
	expect(settings.get(CHILD)?.model).toBe("child:changed");
	const owner = requireOwner(CHILD);
	legacySettings.delete(CHILD);
	expect(settings.has(CHILD)).toBe(false);
	expect(owner.isCurrent()).toBe(true); // publication still belongs to the old runner
	legacyRunners.delete(CHILD);
	expect(owner.isCurrent()).toBe(false);
	const preparingOwner = requireOwner(PREPARING);
	legacySettings.set(PREPARING, { model: "prepared:model", reasoningEffort: null });
	expect(settings.get(PREPARING)?.model).toBe("prepared:model");
	legacySettings.delete(PREPARING);
	expect(preparingOwner.isCurrent()).toBe(true);
	legacyRunners.delete(PREPARING);
	expect(preparingOwner.isCurrent()).toBe(false);
});

test("old loop add/delete binds its epoch, never releases a modern successor", () => {
	const id = "hot-late-old-finally";
	extraIds.add(id);
	const previous = session(id);
	legacySessions.set(id, previous);
	legacyAdmissions.add(id);
	const old = requireOwner(id);
	old.release(); // simulate ownership superseded before late old callbacks
	const next = newOwner(id);
	const replacement = session(id);
	sessions.set(id, replacement);
	legacyAdmissions.delete(id);
	legacySessions.delete(id);
	expect(requireOwner(id)).toBe(next);
	expect(sessions.get(id)).toBe(replacement);
	expect(() => legacyAdmissions.add(id)).toThrow("execution owner");
	expect(requireOwner(id)).toBe(next);
});

test("old cache/settings writes and deletes cannot overwrite a newer epoch", () => {
	const id = "hot-settings-cas";
	extraIds.add(id);
	legacySettings.set(id, { model: "old:model", reasoningEffort: null });
	const old = requireOwner(id);
	old.release();
	const next = newOwner(id);
	const replacement = { model: "new:model", reasoningEffort: "low" as const };
	settings.set(id, replacement);
	legacySettings.set(id, { model: "late-old:model", reasoningEffort: null });
	legacySettings.delete(id);
	expect(settings.get(id)).toBe(replacement);
	expect(requireOwner(id)).toBe(next);
});

test("old tool completion release cannot remove the replacement completion or owner", () => {
	const old = requireOwner(REPLAY);
	old.release();
	const next = newOwner(REPLAY);
	const replacement = Promise.resolve();
	tools.set(REPLAY, replacement);
	legacyTools.delete(REPLAY);
	expect(tools.get(REPLAY)).toBe(replacement);
	expect(requireOwner(REPLAY)).toBe(next);
});

test("outer legacy terminal releases ownership even when inner cache cleanup failed", () => {
	for (const kind of ["primary", "subagent"] as const) {
		const id = `hot-failed-inner-cleanup-${kind}`;
		extraIds.add(id);
		if (kind === "primary") {
			legacyAdmissions.add(id);
			legacySessions.set(id, session(id));
			legacyAdmissions.delete(id); // old inner finally threw before session.delete
		} else {
			legacyRunners.set(id, runner(id));
			legacySettings.set(id, { model: "failed:model", reasoningEffort: null });
			legacyRunners.delete(id); // old executor never unregistered settings
		}
		expect(ownership.getExecutionOwner(id)).toBeUndefined();
		expect(sessions.has(id)).toBe(false);
		expect(settings.has(id)).toBe(false);
		const next = newOwner(id);
		sessions.set(id, session(id));
		settings.set(id, { model: "replacement:model", reasoningEffort: null });
		legacySessions.delete(id);
		legacySettings.delete(id);
		expect(requireOwner(id)).toBe(next);
		expect(settings.get(id)?.model).toBe("replacement:model");
		expect(sessions.has(id)).toBe(true);
	}
});

test("a second module evaluation retains forwarding identity and does not re-adopt projections", async () => {
	const path = `../agent-runtime/ownership.ts?hot-contract=${Date.now()}`;
	const before = requireOwner(PRIMARY);
	const get = legacySessions.get;
	const remove = legacyAdmissions.delete;
	const reloaded: typeof ownership = await import(path);
	expect(reloaded.getExecutionOwner(PRIMARY)).toBe(before);
	expect(legacySessions.get).toBe(get);
	expect(legacyAdmissions.delete).toBe(remove);
	expect(reloaded.createRuntimeMapView("session").get(PRIMARY)).toBe(sessions.get(PRIMARY));
	legacyAdmissions.delete(PRIMARY);
	expect(reloaded.getExecutionOwner(PRIMARY)).toBe(before);
	const id = "hot-new-after-second-load";
	extraIds.add(id);
	const value = session(id);
	legacySessions.set(id, value);
	legacyAdmissions.add(id);
	expect(reloaded.createRuntimeMapView("session").get(id)).toBe(value);
	expect(reloaded.tryClaimExecution(id, "subagent")).toBeNull();
	legacySessions.delete(id);
	legacyAdmissions.delete(id);
	expect(reloaded.getExecutionOwner(id)).toBeUndefined();
});

test("hot-adopted suspended runner receives HTTP user input on its original control promise", async () => {
	const { Hono } = await import("hono");
	const { db, sqlite } = await import("../../db");
	const { cleanDb } = await import("../../../tests/setup");
	const schema = await import("../../db/schema");
	const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
	const { narratorRoutes } = await import("../../routes/narrators");
	const { isLoopRunning } = await import("../narrator-session");
	const { isNarratorRuntimeBusy } = await import("../narrator-session-state");
	const { getSubagentBufferedMessages } = await import("../subagent-executor");
	const owner = requireOwner(SUSPENDED);
	const userId = "hot-resume-user";
	const now = new Date().toISOString();
	await db
		.insert(schema.users)
		.values({ id: userId, username: userId, passwordHash: "test", createdAt: now });
	await db.insert(schema.narrators).values([
		{ id: "hot-root", variant: "primary", ownerUserId: userId, createdAt: now, updatedAt: now },
		{
			id: SUSPENDED,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: "hot-root",
			aclRootNarratorId: "hot-root",
			subagentOriginKind: "standalone",
			ownerUserId: userId,
			status: "working",
			model: "hotresume:model",
			cwd: process.env.HOME,
			createdAt: now,
			updatedAt: now,
		},
	]);
	const unregister = registerExternalProviderResolver((provider) =>
		provider === "hotresume"
			? ({
					formatTools: () => [],
					buildHistory: async () => ({ history: [], trailingToolResults: [] }),
					injectSystemPrompt: () => {},
					chat: () => {
						throw new Error("must not start a new model request");
					},
					formatToolResult: () => ({}),
				} as unknown as import("../../lib/agent/provider").ProviderAdapter)
			: null,
	);
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => Response.json({ error: String(error) }, { status: 500 }));
	app.route("/api/narrators", narratorRoutes);
	try {
		expect(ownership.isExecutionSuspended(SUSPENDED)).toBe(true);
		expect(isNarratorRuntimeBusy(SUSPENDED)).toBe(true);
		expect(isLoopRunning(SUSPENDED)).toBe(false);
		expect(ownership.tryClaimExecution(SUSPENDED, "primary")).toBeNull();
		const response = await app.request(`/api/narrators/${SUSPENDED}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "resume original control" }),
		});
		const body = await response.json();
		expect({ status: response.status, error: body.error }).toEqual({
			status: 201,
			error: undefined,
		});
		expect(manual.isManualOverride(SUSPENDED)).toBe(false);
		expect(await suspendedControl).toMatchObject({
			action: "resume",
			prompt: "resume original control",
			userId,
		});
		expect(getSubagentBufferedMessages(SUSPENDED)).toEqual([]);
		expect(requireOwner(SUSPENDED)).toBe(owner);
		expect(ownership.isExecutionSuspended(SUSPENDED)).toBe(false);
		legacyRunners.delete(SUSPENDED);
		expect(ownership.getExecutionOwner(SUSPENDED)).toBeUndefined();
	} finally {
		unregister();
		manual.clearManualOverrideRuntimes();
		// The isolated preload DB also contains audit/message references from the real route.
		cleanDb(sqlite);
	}
});
