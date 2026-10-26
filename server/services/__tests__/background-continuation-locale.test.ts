import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	userPreferences,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { Locale } from "../../lib/prompt-i18n";

const { db, sqlite } = getTestDb();
const dbStub = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	postgresRuntime: null,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
mock.module("../../db", () => dbStub);
mock.module("@server/db", () => dbStub);
const promptI18n = await import("../../lib/prompt-i18n");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { delegationRegistration } = await import("../../lib/validators/runtime-registration");
const { settings } = await import("../../lib/settings");
const session = await import("../narrator-session");
const inbox = await import("../agent-runtime/inbox");
const executor = await import("../narrator-executor");
const { sendSubagentMessageDetailed } = await import("../agent-communication");
const { activeNarrators } = await import("../narrator-session-state");
const { getExecutionOwner, getRunControl } = await import("../agent-runtime/ownership");
const { runtimePublication } = await import("../agent-runtime/publication");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { enqueueBufferedMessage } = await import("../narrator-buffer");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { resetTraitLayerCaches } = await import("../trait-layer-service");
const { ensureAllRecentTabsMigrated } = await import("../recent-tabs-service");

const A = "locale-recipient-user";
const B = "locale-sender-user";
const TARGET = "locale-recipient";
const CHILD = "locale-child";
const MODEL = "localetest:model";
const NOW = "2026-10-24T00:00:00.000Z";
const provider = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Unexpected model request");
	},
} as unknown as ProviderAdapter;
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "localetest" ? provider : null),
	listReadiness: () => [],
});
const originalAutoContinuation = settings.agent.autoContinuationMode;
type ObservedExecutionConfig = Parameters<typeof executor.executeAgentLoop>[0]["config"];
const observed: Array<Pick<ObservedExecutionConfig, "locale" | "userId">> = [];
const observedActives: Array<ReturnType<typeof activeNarrators.get>> = [];
const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
	observed.push({ locale: config.locale, userId: config.userId });
	observedActives.push(activeNarrators.get(config.narratorId));
	return { finalText: "done", hasError: false, shouldUpdateTitle: false };
});

beforeEach(async () => {
	await ensureAllRecentTabsMigrated();
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	resetTraitLayerCaches();
	runtimePublication.stop();
	settings.agent.autoContinuationMode = "off";
	observed.length = 0;
	observedActives.length = 0;
	execute.mockClear();
	db.insert(users)
		.values([A, B].map((id) => ({ id, username: id, passwordHash: "x", createdAt: NOW })))
		.run();
	db.insert(userPreferences)
		.values([
			{ id: "locale-pref-a", userId: A, language: "zh-CN", createdAt: NOW, updatedAt: NOW },
			{ id: "locale-pref-b", userId: B, language: "en", createdAt: NOW, updatedAt: NOW },
		])
		.run();
	db.insert(narrators)
		.values([
			{
				id: TARGET,
				title: "Recipient",
				model: MODEL,
				cwd: process.env.HOME,
				status: "idle",
				ownerUserId: B,
				runtimeRegistrationJson: registration(A),
				autoContinuationOverride: "off",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: CHILD,
				title: "Sender",
				model: MODEL,
				cwd: process.env.HOME,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: TARGET,
				policySourceNarratorId: TARGET,
				runtimeRegistrationJson: delegationRegistration(TARGET, "general"),
				ownerUserId: B,
				status: "idle",
				autoContinuationOverride: "off",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	// Keep users present whenever a detached notification can resume its migration.
	await ensureAllRecentTabsMigrated();
	await backgroundOccupancyStore.start();
	backgroundOccupancyStore.refreshNarrators([TARGET, CHILD]);
	await backgroundOccupancyStore.flush();
});

afterEach(async () => {
	const terminals: Promise<unknown>[] = [];
	for (const id of [TARGET, CHILD]) {
		const run = getRunControl(id);
		if (run) {
			run.cancel.abort("test cleanup");
			terminals.push(run.terminal);
		}
	}
	await Promise.all(terminals);
	await flushContinuationWork();
	for (const id of [TARGET, CHILD]) {
		getExecutionOwner(id)?.release();
		session.closeNarrator(id);
	}
	activeNarrators.clear();
	resetTraitLayerCaches();
	await flushContinuationWork();
	await backgroundOccupancyStore.flush();
	await ensureAllRecentTabsMigrated();
});

afterAll(async () => {
	execute.mockRestore();
	unregister();
	settings.agent.autoContinuationMode = originalAutoContinuation;
	runtimePublication.stop();
	(await import("../narrator-block-sync")).stopBlockSyncSweep();
	await flushContinuationWork();
	sqlite.close();
});

async function flushContinuationWork(): Promise<void> {
	// Baseline session writes are synchronous SQL followed by Promise/microtask tails.
	await new Promise<void>((resolve) => setImmediate(resolve));
	await backgroundOccupancyStore.flush();
	await ensureAllRecentTabsMigrated();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function registration(userId: string | null) {
	return { version: 1 as const, run: { logicalRunId: "locale-old-run", principal: { userId } } };
}

function notice() {
	const result = createMailboxStore(db).enqueue({
		narratorId: TARGET,
		kind: "task_notice",
		noticeKind: "agent",
		sourceKey: "locale-task-notice",
		text: "A background task finished",
		projectedByteSize: 128,
		createdBy: B,
		metadata: {
			producerKind: "agent",
			taskId: CHILD,
			logicalRunId: "locale-child-run",
			eventKind: "completed",
			userId: B,
		},
	});
	expect(result.status).toBe("accepted");
}

async function settled(expectedLocale: Locale, userId: string | null = A) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline && (observed.length === 0 || getExecutionOwner(TARGET)))
		await Bun.sleep(5);
	await flushContinuationWork();
	expect(observed).toEqual([{ locale: expectedLocale, userId }]);
	expect(getExecutionOwner(TARGET)).toBeUndefined();
}

function queuedRows() {
	return db
		.select({ kind: narratorBufferedMessages.kind, state: narratorBufferedMessages.state })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, TARGET))
		.all();
}

test("cold inbox wake uses recipient run principal, not owner or notice author", async () => {
	notice();
	expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(true);
	await settled("zh-CN");
});

test("a pre-registration recipient resolves its own owner's current preference", async () => {
	db.update(narrators)
		.set({ runtimeRegistrationJson: null, ownerUserId: A })
		.where(eq(narrators.id, TARGET))
		.run();
	notice();
	expect(await session.startBackgroundCompletionContinuationIfPossible(TARGET)).toEqual({
		started: true,
	});
	await settled("zh-CN");
});

test("trusted explicit English hint is preserved for a newly created active", async () => {
	notice();
	const lookup = spyOn(promptI18n, "getUserLanguage");
	try {
		expect(await inbox.wakeInboxIfEligible(TARGET, "en")).toBe(true);
		await settled("en");
		expect(lookup).not.toHaveBeenCalled();
	} finally {
		lookup.mockRestore();
	}
});

test("live active keeps its locale without another preference query", async () => {
	const active = await session.ensureNarrator(TARGET, "zh-CN");
	notice();
	const lookup = spyOn(promptI18n, "getUserLanguage");
	try {
		expect(await inbox.wakeInboxIfEligible(TARGET, "en")).toBe(true);
		await settled("zh-CN");
		expect(observedActives[0]).toBe(active);
		expect(lookup).not.toHaveBeenCalled();
	} finally {
		lookup.mockRestore();
	}
});

test("an aborted active is rebuilt from the recipient preference", async () => {
	const active = await session.ensureNarrator(TARGET, "en");
	active.abortController.abort();
	notice();
	expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(true);
	await settled("zh-CN");
	expect(observedActives[0]).toBeDefined();
	expect(observedActives[0]).not.toBe(active);
});

test("explicit anonymous principal defaults to English without borrowing the owner", async () => {
	db.update(narrators)
		.set({ runtimeRegistrationJson: registration(null), ownerUserId: A })
		.where(eq(narrators.id, TARGET))
		.run();
	notice();
	const lookup = spyOn(promptI18n, "getUserLanguage");
	try {
		expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(true);
		await settled("en", null);
		expect(lookup).not.toHaveBeenCalled();
	} finally {
		lookup.mockRestore();
	}
});

test("unknown principal keeps the notice queued without a preference lookup or model pass", async () => {
	db.update(narrators)
		.set({ runtimeRegistrationJson: null, ownerUserId: null })
		.where(eq(narrators.id, TARGET))
		.run();
	notice();
	const lookup = spyOn(promptI18n, "getUserLanguage");
	try {
		expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(false);
		expect(observed).toHaveLength(0);
		expect(lookup).not.toHaveBeenCalled();
		expect(queuedRows()).toEqual([{ kind: "task_notice", state: "queued" }]);
	} finally {
		lookup.mockRestore();
	}
});

test("a missing preference uses the existing English fallback", async () => {
	db.delete(userPreferences).where(eq(userPreferences.userId, A)).run();
	notice();
	expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(true);
	await settled("en");
});

test("an unsupported saved preference uses the existing English fallback", async () => {
	sqlite.query("UPDATE user_preferences SET language = ? WHERE user_id = ?").run("invalid", A);
	notice();
	expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(true);
	await settled("en");
});

test("a preference query failure defers wake and the same notice can be retried", async () => {
	notice();
	const lookup = spyOn(promptI18n, "getUserLanguage").mockRejectedValue(
		new Error("preference reader unavailable"),
	);
	try {
		expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(false);
		expect(lookup).toHaveBeenCalledWith(A);
		expect(observed).toHaveLength(0);
		expect(activeNarrators.get(TARGET)).toBeUndefined();
		expect(queuedRows()).toEqual([{ kind: "task_notice", state: "queued" }]);
	} finally {
		lookup.mockRestore();
	}
	expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(true);
	await settled("zh-CN");
});

test("queued user input selects its real author beyond a notice and an older run hint", async () => {
	// The earlier notice and execution principal are English; the queued person is Chinese.
	db.update(narrators)
		.set({ runtimeRegistrationJson: registration(B) })
		.where(eq(narrators.id, TARGET))
		.run();
	notice();
	await enqueueBufferedMessage(TARGET, "继续处理", undefined, undefined, A);
	expect(await inbox.wakeInboxIfEligible(TARGET, "en")).toBe(true);
	await settled("zh-CN");
});

test("queued system input retains live locale without adding a saved-principal admission gate", async () => {
	db.update(narrators)
		.set({ runtimeRegistrationJson: null, ownerUserId: null })
		.where(eq(narrators.id, TARGET))
		.run();
	const active = await session.ensureNarrator(TARGET, "zh-CN");
	await enqueueBufferedMessage(TARGET, "queued system input");
	const lookup = spyOn(promptI18n, "getUserLanguage");
	try {
		expect(await session.resumeBufferedMessagesIfIdle(TARGET, "en")).toEqual({ resumed: true });
		await flushContinuationWork();
		expect(active.locale).toBe("zh-CN");
		expect(lookup).not.toHaveBeenCalled();
		// Materialization remains the original input contract; the run entry still
		// independently refuses to invent an unknown execution identity.
		expect(observed).toEqual([]);
		expect(
			db
				.select({ text: narratorMessages.contentText })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, TARGET))
				.all(),
		).toContainEqual({ text: "queued system input" });
	} finally {
		lookup.mockRestore();
	}
});

test("publication callback starts a cold recipient with no supplied locale", async () => {
	const { publication } = runtimePublication.startRun({
		narratorId: CHILD,
		binding: {
			principal: { userId: B },
			deliverTo: { narratorId: TARGET, toolUseId: "locale-background-agent" },
		},
	});
	if (!publication) throw new Error("Missing publication fixture");
	db.transaction((tx) => {
		runtimePublication.commit(
			{
				...publication,
				eventKind: "completed",
				resultRef: runtimePublication.persistResult(publication, "Background complete", tx),
				summary: "Background complete",
			},
			tx,
		);
	});
	expect(await runtimePublication.flushRecipient(TARGET)).toBe(1);
	await settled("zh-CN");
});

function persistQuestionAnswer() {
	db.insert(narratorMessages)
		.values({
			id: "locale-answer",
			narratorId: TARGET,
			role: "user",
			contentJson: [{ type: "text", text: "Answer by B" }],
			contentText: "Answer by B",
			createdBy: B,
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "locale-answer-ref", narratorId: TARGET, messageId: "locale-answer", seq: 0 })
		.run();
}

for (const locale of [undefined, "en"] as const) {
	test(`question injection forwards ${locale ?? "omitted"} locale through the real inbox scheduler`, async () => {
		db.update(narrators).set({ lastStopReason: "normal" }).where(eq(narrators.id, TARGET)).run();
		const result = await inbox.deliverInboxInjection(TARGET, {
			content: "A question was answered",
			source: "async_question",
			schedule: "wakeIfIdle",
			createdBy: B,
			executionPrincipal: { version: 1, userId: A },
			locale,
		});
		expect(result.started).toBe(true);
		await settled(locale ?? "zh-CN");
	});

	test(`question receipt wake preserves ${locale ?? "omitted"} locale and its captured principal`, async () => {
		db.update(narrators).set({ lastStopReason: "normal" }).where(eq(narrators.id, TARGET)).run();
		persistQuestionAnswer();
		expect(
			await session.scheduleQuestionAnswerDelivery(
				TARGET,
				"locale-answer",
				"Answer by B",
				{ version: 1, userId: A },
				locale,
			),
		).toEqual({ ready: true, started: true });
		await settled(locale ?? "zh-CN");
	});
}

test("question wake retains its anonymous principal instead of borrowing the Chinese owner", async () => {
	db.update(narrators)
		.set({ lastStopReason: "normal", ownerUserId: A })
		.where(eq(narrators.id, TARGET))
		.run();
	const lookup = spyOn(promptI18n, "getUserLanguage");
	try {
		expect(
			(
				await inbox.deliverInboxInjection(TARGET, {
					content: "Anonymous question answered",
					source: "async_question",
					schedule: "wakeIfIdle",
					executionPrincipal: { version: 1, userId: null },
				})
			).started,
		).toBe(true);
		await settled("en", null);
		expect(lookup).not.toHaveBeenCalled();
	} finally {
		lookup.mockRestore();
	}
});

test("question preference failure preserves the receipt for a later inbox wake", async () => {
	db.update(narrators).set({ lastStopReason: "normal" }).where(eq(narrators.id, TARGET)).run();
	persistQuestionAnswer();
	const lookup = spyOn(promptI18n, "getUserLanguage").mockRejectedValue(
		new Error("question preference reader unavailable"),
	);
	try {
		expect(
			await session.scheduleQuestionAnswerDelivery(TARGET, "locale-answer", "Answer by B", {
				version: 1,
				userId: A,
			}),
		).toEqual({ ready: true, started: false });
		expect(observed).toHaveLength(0);
		expect(queuedRows()).toEqual([{ kind: "task_notice", state: "queued" }]);
	} finally {
		lookup.mockRestore();
	}
	expect(await inbox.wakeInboxIfEligible(TARGET)).toBe(true);
	await settled("zh-CN");
});

function sendRequest(callerNarratorId: string, id: string) {
	db.insert(narratorMessages)
		.values({
			id: "locale-send-message",
			narratorId: callerNarratorId,
			role: "assistant",
			contentJson: [],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "locale-send-call",
			narratorId: callerNarratorId,
			messageId: "locale-send-message",
			toolUseId: "locale-send-use",
			toolName: "Send",
			status: "running",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			createdAt: NOW,
		})
		.run();
	return {
		callerNarratorId,
		id,
		message: "English sender report",
		toolUseId: "locale-send-use",
		toolCallBinding: { toolCallId: "locale-send-call", attempt: 1 },
		userId: B,
		locale: "en",
		signal: new AbortController().signal,
	};
}

test("Send(parent) wakes a Chinese recipient without passing the English sender hint", async () => {
	const originalWake = inbox.wakeInboxIfEligible;
	const wake = spyOn(inbox, "wakeInboxIfEligible").mockImplementation(originalWake);
	try {
		const result = await sendSubagentMessageDetailed(sendRequest(CHILD, "parent"));
		expect(result.targets).toMatchObject([{ id: TARGET, status: "started" }]);
		expect(wake).toHaveBeenCalledWith(TARGET);
		await settled("zh-CN");
	} finally {
		wake.mockRestore();
	}
});

for (const status of ["idle", "working"] as const) {
	test(`Send to a ${status} child omits the sender language at its wake seam`, async () => {
		db.update(narrators).set({ status }).where(eq(narrators.id, CHILD)).run();
		const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(false);
		try {
			const result = await sendSubagentMessageDetailed(sendRequest(TARGET, CHILD));
			expect(result.targets).toMatchObject([{ id: CHILD, status: "queued" }]);
			expect(wake.mock.calls).toEqual([[CHILD]]);
			expect(
				db
					.select({ state: narratorBufferedMessages.state })
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.narratorId, CHILD))
					.all(),
			).toEqual([{ state: "queued" }]);
		} finally {
			wake.mockRestore();
		}
	});
}
