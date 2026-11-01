import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	fileChangeExecutionSegments,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	runtimePublicationOutbox,
	userPreferences,
	users,
} from "../../db/schema";
import { type ProviderAdapter, registerExternalProviderResolver } from "../../lib/agent/provider";
import { DISABLED_TOOLS_TRAIT_PREFIX, upsertEncodedTrait } from "../../lib/narrator-custom-traits";
import { settings } from "../../lib/settings";
import { createAgentMessageDelivery } from "../agent-message-delivery";
import { enqueueInboxAgent } from "../agent-runtime/inbox";
import { createMailboxStore } from "../agent-runtime/mailbox";
import { getExecutionOwner, getRunControl } from "../agent-runtime/ownership";
import { getRuntimePublicationService, runtimePublication } from "../agent-runtime/publication";
import { cancelRunsBoundTo, startNarratorRun } from "../agent-runtime/run";
import { backgroundOccupancyStore } from "../background-occupancy-store";
import * as executor from "../narrator-executor";
import { closePrefixSnapshotStore } from "../narrator-prefix-snapshots";
import {
	drainAndPersistPendingInjections,
	ensureNarrator,
	startParentInboundContinuationIfPossible,
} from "../narrator-session";
import { activeNarrators } from "../narrator-session-state";
import { runSubagent } from "../subagent-runner";
import { resetTraitLayerCaches } from "../trait-layer-service";

const A = "identity-human-a";
const B = "identity-human-b";
const TARGET = "identity-recipient";
const CALLER = "identity-caller";
const MODEL = "identitytest:model";
const NOW = "2026-09-30T00:00:00.000Z";
const provider = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Unexpected model request");
	},
} as unknown as ProviderAdapter;
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "identitytest" ? provider : null),
	listReadiness: () => [],
});
const done = { finalText: "done", hasError: false, shouldUpdateTitle: false };
const originalAutoContinuation = settings.agent.autoContinuationMode;

beforeEach(async () => {
	backgroundOccupancyStore.resetForTests();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	resetTraitLayerCaches();
	runtimePublication.stop();
	settings.agent.autoContinuationMode = "off";
	db.insert(users)
		.values([A, B].map((id) => ({ id, username: id, passwordHash: "x", createdAt: NOW })))
		.run();
	db.insert(narrators)
		.values(
			[TARGET, CALLER].map((id) => ({
				id,
				model: MODEL,
				cwd: process.env.HOME,
				status: "idle" as const,
				ownerUserId: id === CALLER ? A : null,
				autoContinuationOverride: "off" as const,
				createdAt: NOW,
				updatedAt: NOW,
			})),
		)
		.run();
});
afterEach(async () => {
	const terminals: Promise<unknown>[] = [];
	for (const id of activeNarrators.keys()) {
		const run = getRunControl(id);
		if (run) {
			run.cancel.abort("test cleanup");
			terminals.push(run.terminal);
		}
	}
	await Promise.all(terminals);
	for (const id of activeNarrators.keys()) getExecutionOwner(id)?.release();
	activeNarrators.clear();
	resetTraitLayerCaches();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	backgroundOccupancyStore.resetForTests();
	unregister();
	settings.agent.autoContinuationMode = originalAutoContinuation;
});

function disabledTools(tools: string[]) {
	return upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, { version: 1, tools });
}
function registration(userId: string | null) {
	return { version: 1 as const, run: { logicalRunId: "recipient-old-run", principal: { userId } } };
}
function stored() {
	const row = db
		.select({
			registration: narrators.runtimeRegistrationJson,
			logicalRunId: narrators.logicalRunId,
		})
		.from(narrators)
		.where(eq(narrators.id, TARGET))
		.get();
	if (!row) throw new Error("Missing recipient fixture");
	return row;
}
async function settled(sawPass: () => boolean) {
	for (let i = 0; i < 300 && (!sawPass() || getExecutionOwner(TARGET)); i++) await Bun.sleep(5);
	expect(sawPass()).toBe(true);
	expect(getExecutionOwner(TARGET)).toBeUndefined();
}
function notice() {
	const result = createMailboxStore(db).enqueue({
		narratorId: TARGET,
		kind: "task_notice",
		noticeKind: "agent",
		sourceKey: "task-by-b",
		text: "A background task finished",
		projectedByteSize: 1024,
		metadata: {
			producerKind: "agent",
			taskId: CALLER,
			logicalRunId: "callers-run",
			eventKind: "completed",
			userId: B,
		},
	});
	expect(result.status).toBe("accepted");
}
function callerTool(name: string, toolCallId = "identity-agent-call") {
	const messageId = `${toolCallId}-message`;
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId: CALLER,
			role: "assistant",
			contentJson: [],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `${toolCallId}-ref`, narratorId: CALLER, messageId, seq: 0 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId: CALLER,
			messageId,
			toolUseId: `${toolCallId}-use`,
			toolName: name,
			status: "running",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			createdAt: NOW,
		})
		.run();
	return { toolCallId, toolUseId: `${toolCallId}-use`, attempt: 1 };
}

for (const userId of [A, null]) {
	for (const rebuilt of [false, true]) {
		test(`S2 task notice author B does not replace ${userId ?? "anonymous"}, rebuilt=${rebuilt}`, async () => {
			db.update(narrators)
				.set({ runtimeRegistrationJson: registration(userId) })
				.where(eq(narrators.id, TARGET))
				.run();
			if (!rebuilt) {
				const active = await ensureNarrator(TARGET, "en", false);
				// Anonymous and unprepared active instances used to borrow notice author B.
				active._currentUserId = null;
			}
			notice();
			const identities: Array<string | null | undefined> = [];
			const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
				identities.push(config.userId);
				return done;
			});
			try {
				expect(await startParentInboundContinuationIfPossible(TARGET)).toEqual({ started: true });
				await settled(() => identities.length === 1);
				expect(identities).toEqual([userId]);
				expect(stored().registration?.run?.principal).toEqual({ userId });
			} finally {
				execute.mockRestore();
			}
		});
	}
}

test("S2 draining a notice never changes an anonymous live execution identity", async () => {
	db.update(narrators)
		.set({ runtimeRegistrationJson: registration(null) })
		.where(eq(narrators.id, TARGET))
		.run();
	const active = await ensureNarrator(TARGET, "en", false);
	active._currentUserId = null;
	notice();
	expect(await drainAndPersistPendingInjections(active)).toBeTruthy();
	expect(active._currentUserId).toBeNull();
});

test("S3 a pre-registration session wakes as its own owner", async () => {
	db.update(narrators).set({ ownerUserId: A }).where(eq(narrators.id, TARGET)).run();
	notice();
	const identities: Array<string | null | undefined> = [];
	const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
		identities.push(config.userId);
		return done;
	});
	try {
		expect(await startParentInboundContinuationIfPossible(TARGET)).toEqual({ started: true });
		await settled(() => identities.length === 1);
		expect(identities).toEqual([A]);
		expect(stored().registration?.run?.principal).toEqual({ userId: A });
	} finally {
		execute.mockRestore();
	}
});

test("S3 Send to an ownerless unregistered session leaves input queued and makes no model request", async () => {
	const call = callerTool("Send", "identity-send");
	db.insert(fileChangeExecutionSegments)
		.values({
			id: "identity-send-segment",
			narratorId: CALLER,
			sourceToolCallId: call.toolCallId,
			sourceExecutionAttempt: 1,
			createdAt: NOW,
		})
		.run();
	const delivery = createAgentMessageDelivery(
		TARGET,
		{ id: CALLER, label: "caller", title: "Caller", type: "general", isParent: false },
		call.toolUseId,
		"keep this queued",
		call,
	);
	await enqueueInboxAgent(delivery, delivery.text, { userId: B, createdBy: B });
	const execute = spyOn(executor, "executeAgentLoop").mockResolvedValue(done);
	try {
		expect(await startParentInboundContinuationIfPossible(TARGET)).toEqual({ started: false });
		expect(execute).not.toHaveBeenCalled();
		expect(
			db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, TARGET))
				.get(),
		).toMatchObject({ kind: "agent_message", state: "queued" });
		expect(stored().registration).toBeNull();
	} finally {
		execute.mockRestore();
	}
});

test("S1 real foreground runSubagent uses the caller's principal in its first pass and final tool gate", async () => {
	// A is driving B's shared session. Falling back to the child's own owner B
	// would mask a missing binding.principal and omit A's user-level restriction.
	db.update(narrators)
		.set({ ownerUserId: B, visibility: "public", writeAudience: "public" })
		.where(eq(narrators.id, CALLER))
		.run();
	db.insert(userPreferences)
		.values({
			id: "identity-a-pref",
			userId: A,
			traits: disabledTools(["Write"]),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	const call = callerTool("Agent");
	let childId: string | undefined;
	const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
		childId = config.narratorId;
		expect(config.userId).toBe(A);
		expect(new Set(config.disabledTools).has("Write")).toBe(true);
		const finalGate = config.onToolExecutionFinalAuthorization;
		if (!finalGate) throw new Error("Missing final tool gate");
		await expect(
			finalGate({
				toolUse: { name: "Write", toolUseId: "blocked-write", input: {} },
				effectiveInput: {},
				binding: { toolCallId: "not-started-write", attempt: 1 },
			} as Parameters<typeof finalGate>[0]),
		).rejects.toThrow("Tool disabled by the current effective traits: Write");
		return done;
	});
	try {
		const result = await runSubagent({
			parentNarratorId: CALLER,
			toolUseId: call.toolUseId,
			subagentType: "general",
			prompt: "work",
			cwd: process.env.HOME ?? ".",
			signal: new AbortController().signal,
			locale: "en",
			userId: A,
			model: MODEL,
		});
		expect(result).toContain("done");
		expect(execute).toHaveBeenCalledTimes(1);
		if (!childId) throw new Error("Delegation made no pass");
		expect(
			db.select().from(narrators).where(eq(narrators.id, childId)).get()?.runtimeRegistrationJson
				?.run?.principal,
		).toEqual({ userId: A });
	} finally {
		execute.mockRestore();
	}
});

for (const cancellation of ["deadline", "caller"] as const) {
	test(`A2 no deliverTo persists the binding and is stopped by its ${cancellation}`, async () => {
		const deadlineAt = new Date(
			Date.now() + (cancellation === "deadline" ? 200 : 30_000),
		).toISOString();
		const cancelWith = { narratorId: CALLER, toolCallId: "identity-bound-call", attempt: 1 };
		let sawPass!: () => void;
		const passStarted = new Promise<void>((resolve) => {
			sawPass = resolve;
		});
		const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
			sawPass();
			await new Promise<void>((resolve) =>
				config.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { ...done, aborted: true };
		});
		try {
			const handle = await startNarratorRun({
				narratorId: TARGET,
				locale: "en",
				text: "work",
				binding: { principal: { userId: A }, deadlineAt, cancelWith },
			});
			await passStarted;
			expect(stored().registration?.run).toMatchObject({
				principal: { userId: A },
				deadlineAt,
				cancelWith,
			});
			expect(stored().logicalRunId).toBeTruthy();
			expect(getRunControl(TARGET)?.binding).toEqual(stored().registration?.run);
			if (cancellation === "caller") expect(cancelRunsBoundTo(CALLER, "cancel caller")).toBe(1);
			expect((await handle.terminal).timedOut).toBe(cancellation === "deadline");
			expect(db.select().from(runtimePublicationOutbox).all()).toEqual([]);
		} finally {
			execute.mockRestore();
		}
	});
}

test("M3 an already expired absolute deadline finishes without a model pass or tool execution", async () => {
	db.update(narrators)
		.set({ logicalRunId: "legacy-recovered-run" })
		.where(eq(narrators.id, TARGET))
		.run();
	const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
		throw new Error("expired run reached a model/tool pass");
	});
	try {
		const handle = await startNarratorRun({
			narratorId: TARGET,
			locale: "en",
			text: "",
			recovered: true,
			resumeRunId: "legacy-recovered-run",
			binding: { principal: { userId: null }, deadlineAt: new Date(Date.now() - 1).toISOString() },
		});
		expect(await handle.terminal).toMatchObject({ started: true, timedOut: true, hasError: true });
		expect(execute).not.toHaveBeenCalled();
	} finally {
		execute.mockRestore();
	}
});

test("A7 same-id registration returns the persisted merge; a new run replaces only run facts", async () => {
	const publication = getRuntimePublicationService();
	const deadlineAt = new Date(Date.now() + 10_000).toISOString();
	const first = (
		await publication.startRun({
			narratorId: TARGET,
			binding: {
				principal: { userId: A },
				deadlineAt,
				cancelWith: { narratorId: CALLER, toolCallId: "call", attempt: 1 },
			},
		})
	).binding;
	const second = (
		await publication.startRun({
			narratorId: TARGET,
			resumeRunId: first.logicalRunId,
			binding: {
				principal: { userId: B },
				deadlineAt: new Date(Date.now() + 99_000).toISOString(),
			},
		})
	).binding;
	expect(stored().registration?.run).toEqual(second);
	expect(second).toMatchObject({
		principal: { userId: B },
		deadlineAt,
		cancelWith: first.cancelWith,
	});
	const third = (
		await publication.startRun({
			narratorId: TARGET,
			binding: { principal: { userId: null } },
		})
	).binding;
	expect(third.logicalRunId).not.toBe(first.logicalRunId);
	expect(third).not.toHaveProperty("deadlineAt");
	expect(third).not.toHaveProperty("cancelWith");
});
