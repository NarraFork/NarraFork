import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages, narratorMessages, narrators, users } from "../../db/schema";
import type { ChatParams, ProviderAdapter } from "../../lib/agent/provider";
import type { RuntimeQueuePort } from "../agent-runtime/runtime-queue-port";
import { formatStewardOriginLabel, parseStewardOriginLabel } from "@shared/message-origin";

const { db, sqlite } = getTestDb();
// This integration suite owns an in-memory database; importing the production
// singleton here would start migrations and background upkeep before the mock.
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
const realProviderModule = { ...(await import("../../lib/agent/provider")) };

for (const statement of [
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_device_id TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_cwd TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_path_flavor TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN resolved_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN canonical_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN runtime_generation INTEGER",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_targets_json TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN device_selection_source TEXT",
]) {
	try {
		sqlite.run(statement);
	} catch (error) {
		if (!String(error).includes("duplicate column name")) throw error;
	}
}

const providerCalls: string[] = [];
let beforeResponse: ((params: ChatParams) => Promise<void>) | undefined;
const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		// Queue assertions address the task text, not the sender projection. Keep
		// the real request signal/model while exposing the anonymous human body
		// to fixture gates that otherwise never recognize their starting task.
		const content = params.content.replace(/^<sender kind="human" \/>\n/, "");
		providerCalls.push(content);
		params.onRequestStart?.();
		await beforeResponse?.({ ...params, content });
		yield { text: "mailbox send turn ran" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

mock.module("../../lib/agent/provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: (model = "openai:test-model") => ({
		requestedProvider: "openai",
		requestedModel: model,
		provider: "openai",
		adapter: provider,
		model: model.replace(/^openai:/, ""),
	}),
}));

const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { bindRuntimeQueue } = await import("../agent-runtime/runtime-queue-port");
const {
	acceptUserMessage,
	closeNarrator,
	clearBufferedMessageSoftStopIfIdle,
	ensureNarrator,
	hasPendingBufferedWork,
	sendMessage,
	resumeNextBufferedMessage,
} = await import("../narrator-session");
const { enqueueBufferedMessage, removeBufferedMessage, updateBufferedMessageMode } = await import(
	"../narrator-buffer"
);
const { narratorService } = await import("../narrator-service");
const { authorizeStewardMessage, setStewardMessageAuthorizer } = await import("../steward-message-admission");
const { retryBufferedMessage, projectMailboxUserMessage } = await import("../narrator-buffer");
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");

const now = new Date().toISOString();

function seedNarrator(narratorId: string) {
	db.insert(narrators)
		.values({
			id: narratorId,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model: "openai:test-model",
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			status: "idle",
			cwd: process.cwd(),
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function stewardOrigin(narratorId: string) {
	const provenance = {
		userId: "steward-user", pluginId: "steward-narrator", contributionId: "send",
		requestId: "send-request", correlationId: "send-correlation", stewardNarratorId: "steward-source",
		targetNarratorId: narratorId, bindingRevision: 2,
	};
	const deadlineAt = new Date(Date.now() + 60_000).toISOString();
	return {
		origin: "assistant" as const,
		originLabel: formatStewardOriginLabel(provenance),
		delegationDeadlineAt: deadlineAt,
		delegationHostContext: {
			requestId: provenance.requestId, correlationId: provenance.correlationId, deadlineAt,
			plugin: { pluginId: provenance.pluginId, contributionId: provenance.contributionId,
				packageVersion: "1.0.0", installationId: "install-1", runtimeId: "runtime-1", runtimeGeneration: 1 },
			invocation: { kind: "user", userId: provenance.userId, userRole: "user", source: "internal", narratorId: provenance.stewardNarratorId },
			scope: { narratorId: provenance.stewardNarratorId },
		},
	};
}

function enqueueCancelledNotice(narratorId: string, index: number) {
	const store = createMailboxStore(db);
	const result = store.enqueue({
		kind: "task_notice",
		noticeKind: "agent",
		narratorId,
		sourceKey: `cancelled-${index}`,
		text: `cancelled task ${index}`,
		projectedByteSize: 32,
		metadata: {
			producerKind: "agent",
			taskId: `cancelled-task-${index}`,
			logicalRunId: `cancelled-run-${index}`,
			eventKind: "cancelled",
		},
	});
	if (!("delivery" in result)) throw new Error("failed to enqueue cancellation notice");
}

async function waitForIdle(narratorId: string, expectedCalls = 1): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const row = db
			.select({ status: narrators.status })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (
			providerCalls.length === expectedCalls &&
			row?.status === "idle" &&
			!getExecutionOwner(narratorId) &&
			!hasPendingBufferedWork(narratorId)
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for narrator loop");
}

beforeEach(() => {
	cleanDb(sqlite);
	providerCalls.length = 0;
	beforeResponse = undefined;
	setStewardMessageAuthorizer(async () => {});
});

test("steward authorizer disposal cannot remove a replacement host verifier", async () => {
	const narratorId = "steward-dispose-identity";
	const origin = stewardOrigin(narratorId);
	const obsolete = setStewardMessageAuthorizer(async () => { throw new Error("Disposed verifier used"); });
	const replacement = mock(async () => {});
	const dispose = setStewardMessageAuthorizer(replacement);
	obsolete();
	await authorizeStewardMessage(narratorId, "steward-user", origin);
	expect(replacement).toHaveBeenCalledTimes(1);
	dispose();
	dispose();
	await expect(authorizeStewardMessage(narratorId, "steward-user", origin)).rejects.toThrow("authorizer is unavailable");
});

test("steward send persists and broadcasts provenance while the provider sees delegated agent attribution", async () => {
	const narratorId = "steward-send-recipient";
	seedNarrator(narratorId);
	db.insert(users).values({ id: "steward-user", username: "Delegating user", passwordHash: "unused", createdAt: now }).run();
	const provenance = {
		userId: "steward-user", pluginId: "steward-narrator", contributionId: "send",
		requestId: "send-request", correlationId: "send-correlation", stewardNarratorId: "steward-source",
		targetNarratorId: narratorId, bindingRevision: 2,
	};
	const websocket = await import("../../websocket/narrator-ws");
	const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation(() => {});
	try {
		const row = await sendMessage(narratorId, "unchanged steward message", undefined, "en", false,
			null, "steward-user", undefined, null,
			stewardOrigin(narratorId), undefined,
			new AbortController().signal);
		await waitForIdle(narratorId);
		expect(row.createdBy).toBe("steward-user");
		expect(row.origin).toBe("assistant");
		expect(parseStewardOriginLabel(row.originLabel)).toEqual(provenance);
		const event = broadcast.mock.calls.map((call) => call[1]).find((value) => value.type === "user_message");
		expect(event).toMatchObject({ message: { createdBy: "steward-user", origin: "assistant", originLabel: row.originLabel } });
		expect(providerCalls[0]).toContain('<sender kind="agent" id="steward-source"');
		expect(providerCalls[0]).toContain('delegated_user_id="steward-user"');
		expect(providerCalls[0]).toContain('plugin_id="steward-narrator"');
		expect(providerCalls[0]).toEndWith("\nunchanged steward message");
	} finally {
		broadcast.mockRestore();
		closeNarrator(narratorId);
	}
});

test("cancellation after mailbox admission prevents message commit and provider dispatch", async () => {
	const narratorId = "steward-cancel-before-commit";
	seedNarrator(narratorId);
	const inbox = await import("../agent-runtime/inbox");
	const originalClaim = inbox.claimInboxHead;
	const controller = new AbortController();
	const claim = spyOn(inbox, "claimInboxHead").mockImplementation(async (...args) => {
		const row = await originalClaim(...args);
		if (row?.kind === "user_input") controller.abort();
		return row;
	});
	try {
		db.insert(users).values({ id: "steward-user", username: "Delegating user", passwordHash: "unused", createdAt: now }).run();
		await expect(sendMessage(narratorId, "must not commit", undefined, "en", false, null,
			"steward-user", undefined, null, stewardOrigin(narratorId), undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		const queued = db.select().from(narratorBufferedMessages).where(eq(narratorBufferedMessages.narratorId, narratorId)).all();
		expect(queued).toHaveLength(1);
		expect(queued[0].state).toBe("cancelled");
		expect(await retryBufferedMessage(narratorId, queued[0].id)).toBe(false);
		claim.mockRestore();
		await resumeNextBufferedMessage(await ensureNarrator(narratorId, "en", false), "en");
		expect(hasPendingBufferedWork(narratorId)).toBe(false);
		expect(db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, narratorId)).all()).toHaveLength(0);
		expect(providerCalls).toHaveLength(0);
	} finally {
		claim.mockRestore();
		closeNarrator(narratorId);
	}
});

test("steward cancellation inside admission authorization leaves no durable input", async () => {
	const narratorId = "steward-cancel-admission";
	seedNarrator(narratorId);
	db.insert(users).values({ id: "steward-user", username: "Delegating user", passwordHash: "unused", createdAt: now }).run();
	const controller = new AbortController();
	setStewardMessageAuthorizer(async () => { controller.abort(); });
	try {
		await expect(sendMessage(narratorId, "never admitted", undefined, "en", false, null,
			"steward-user", undefined, null, stewardOrigin(narratorId), undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(db.select().from(narratorBufferedMessages).where(eq(narratorBufferedMessages.narratorId, narratorId)).all()).toHaveLength(0);
		expect(providerCalls).toHaveLength(0);
	} finally { closeNarrator(narratorId); }
});

test.each(["allowed", "revoked", "missing-verifier", "expired"])("steward durable recovery keeps attribution and revalidates authorization (%s)", async (disposition) => {
	const narratorId = `steward-recovery-${disposition}`;
	seedNarrator(narratorId);
	db.insert(users).values({ id: "steward-user", username: "Delegating user", passwordHash: "unused", createdAt: now }).run();
	const origin = stewardOrigin(narratorId);
	const admitted = await enqueueBufferedMessage(narratorId, "/goal delegated text stays text", undefined, null,
		"steward-user", undefined, undefined, "back", null, undefined, "stack", undefined, undefined, origin);
	const accepted = db.select().from(narratorBufferedMessages).where(eq(narratorBufferedMessages.id, admitted.id)).get()!;
	expect(projectMailboxUserMessage(accepted).origin).toEqual(origin);
	const checks: unknown[] = [];
	if (disposition === "missing-verifier") setStewardMessageAuthorizer(undefined);
	else setStewardMessageAuthorizer(async (provenance, context) => {
		checks.push({ provenance, context });
		if (disposition === "revoked") throw new Error("Binding revision or runtime authorization revoked");
	});
	if (disposition === "expired") {
		const metadata = JSON.parse(accepted.metadataJson!);
		metadata.origin.delegationDeadlineAt = new Date(Date.now() - 1_000).toISOString();
		metadata.origin.delegationHostContext.deadlineAt = metadata.origin.delegationDeadlineAt;
		db.update(narratorBufferedMessages).set({ metadataJson: JSON.stringify(metadata) }).where(eq(narratorBufferedMessages.id, admitted.id)).run();
	}
	try {
		const recovery = resumeNextBufferedMessage(await ensureNarrator(narratorId, "en", false), "en");
		if (disposition === "allowed") {
			await recovery;
			await waitForIdle(narratorId);
			const receipt = db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, narratorId)).all().find((row) => row.role === "user")!;
			expect(receipt.origin).toBe("assistant");
			expect(parseStewardOriginLabel(receipt.originLabel)).toEqual(parseStewardOriginLabel(origin.originLabel));
			expect(receipt.createdBy).toBe("steward-user");
			expect(providerCalls[0]).toContain('delegated_user_id="steward-user"');
			expect(providerCalls[0]).toEndWith("\n/goal delegated text stays text");
			expect(checks.length).toBeGreaterThan(0);
		} else {
			await expect(recovery).rejects.toThrow();
			expect(db.select().from(narratorBufferedMessages).where(eq(narratorBufferedMessages.id, admitted.id)).get()?.state).toBe("cancelled");
			expect(await retryBufferedMessage(narratorId, admitted.id)).toBe(false);
			expect(db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, narratorId)).all()).toHaveLength(0);
			expect(providerCalls).toHaveLength(0);
		}
	} finally { closeNarrator(narratorId); }
});

test("consumes earlier cancelled task notices before sending a new idle user input", async () => {
	const narratorId = "mailbox-send-cancelled-notices";
	seedNarrator(narratorId);
	for (let index = 1; index <= 6; index++) enqueueCancelledNotice(narratorId, index);

	await expect(sendMessage(narratorId, "continue after cancelled reviews")).resolves.toMatchObject({
		contentText: "continue after cancelled reviews",
	});
	await waitForIdle(narratorId);

	const mailboxRows = db
		.select({ kind: narratorBufferedMessages.kind, state: narratorBufferedMessages.state })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.all();
	expect(mailboxRows).toHaveLength(7);
	expect(mailboxRows.every((row) => row.state === "materialized")).toBe(true);
	expect(providerCalls).toHaveLength(1);
	expect(
		db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, narratorId))
			.all().length,
	).toBeGreaterThanOrEqual(8);

	closeNarrator(narratorId);
});

test("accepts idle input behind an earlier user without reporting durable acceptance as an error", async () => {
	const narratorId = "mailbox-send-earlier-user";
	seedNarrator(narratorId);
	await enqueueBufferedMessage(narratorId, "earlier user input");
	const result = await acceptUserMessage(narratorId, "later user input");
	expect(result).toMatchObject({ buffered: true });
	await waitForIdle(narratorId, 2);
	expect(providerCalls).toEqual(["earlier user input", "later user input"]);
	const rows = db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.all();
	expect(rows).toHaveLength(2);
	expect(rows.every((row) => row.state === "materialized")).toBe(true);
	const history = db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, narratorId))
		.all();
	expect(history.filter((row) => row.role === "user").map((row) => row.contentText)).toEqual([
		"earlier user input",
		"later user input",
	]);
	closeNarrator(narratorId);
});

test("idle priority input runs ahead of older queued users without dropping them", async () => {
	const narratorId = "mailbox-send-idle-priority";
	seedNarrator(narratorId);
	await enqueueBufferedMessage(narratorId, "older user input");
	const result = await acceptUserMessage(narratorId, "cut in", { priority: true });
	expect(result).toMatchObject({ buffered: false, userMsg: { contentText: "cut in" } });
	await waitForIdle(narratorId, 2);
	expect(providerCalls).toEqual(["cut in", "older user input"]);
	closeNarrator(narratorId);
});

test("interrupt input is accepted once and waits for the old provider to settle", async () => {
	const narratorId = "mailbox-send-interrupt";
	seedNarrator(narratorId);
	const started = Promise.withResolvers<AbortSignal>();
	const settleOld = Promise.withResolvers<void>();
	beforeResponse = async (params) => {
		if (params.content !== "old running input") return;
		started.resolve(params.signal);
		await settleOld.promise;
	};
	try {
		await acceptUserMessage(narratorId, "old running input");
		const oldSignal = await started.promise;
		await enqueueBufferedMessage(narratorId, "older queued input");
		const result = await acceptUserMessage(narratorId, "interrupt replacement", {
			interrupt: true,
		});
		expect(result).toMatchObject({ buffered: true });
		expect(oldSignal.aborted).toBe(true);
		expect(providerCalls).toEqual(["old running input"]);
		const pending = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.narratorId, narratorId))
			.all();
		expect(pending.filter((row) => row.text === "interrupt replacement")).toHaveLength(1);
		expect(pending.find((row) => row.text === "interrupt replacement")).toMatchObject({
			state: "queued",
			priority: true,
		});
		settleOld.resolve();
		await waitForIdle(narratorId, 3);
		expect(providerCalls).toEqual([
			"old running input",
			"interrupt replacement",
			"older queued input",
		]);
	} finally {
		settleOld.resolve();
		closeNarrator(narratorId);
	}
});

test.each([
	["temporary", true],
	["permanent", true],
	["temporary", false],
	["permanent", false],
] as const)("queued %s override waits for the previous finalizer (interrupt=%s)", async (mode, interrupt) => {
	const narratorId = `mailbox-override-${mode}-${interrupt}`;
	seedNarrator(narratorId);
	const started = Promise.withResolvers<AbortSignal>();
	const settleOld = Promise.withResolvers<void>();
	const observed: Array<{ model: string | null; restore: string | null }> = [];
	const requestedModels: string[] = [];
	beforeResponse = async (params) => {
		requestedModels.push(params.model);
		const row = db.select().from(narrators).where(eq(narrators.id, narratorId)).get();
		observed.push({ model: row?.model ?? null, restore: row?.pendingModelRestore ?? null });
		if (params.content === "old override") {
			started.resolve(params.signal);
			await settleOld.promise;
		}
	};
	try {
		await acceptUserMessage(narratorId, "old override", {
			executionIntent: { modelOverride: { model: "openai:old", mode: "temporary" } },
		});
		const signal = await started.promise;
		const result = await acceptUserMessage(narratorId, "replacement override", {
			interrupt,
			executionIntent: { modelOverride: { model: "openai:new", mode } },
		});
		expect(result.buffered).toBe(true);
		expect(signal.aborted).toBe(interrupt);
		const before = db.select().from(narrators).where(eq(narrators.id, narratorId)).get();
		expect(before?.model).toBe("openai:old");
		expect(before?.pendingModelRestore).toBe("openai:test-model");
		settleOld.resolve();
		await waitForIdle(narratorId, 2);
		expect(requestedModels).toEqual(["old", "new"]);
		expect(observed).toEqual([
			{ model: "openai:old", restore: "openai:test-model" },
			{ model: "openai:new", restore: mode === "temporary" ? "openai:test-model" : null },
		]);
		const after = db.select().from(narrators).where(eq(narrators.id, narratorId)).get();
		expect(after?.model).toBe(mode === "temporary" ? "openai:test-model" : "openai:new");
		expect(after?.pendingModelRestore).toBeNull();
	} finally {
		settleOld.resolve();
		closeNarrator(narratorId);
	}
});

test("interrupting bash runs only after the old execution finalizes and does not call the model", async () => {
	const narratorId = "mailbox-interrupt-bash";
	seedNarrator(narratorId);
	db.insert(users)
		.values({
			id: "control-user",
			username: "control-user",
			passwordHash: "unused",
			createdAt: now,
		})
		.run();
	const started = Promise.withResolvers<AbortSignal>();
	const settleOld = Promise.withResolvers<void>();
	const services = await import("../narrator-service");
	const bash = spyOn(services, "handleBashCommand").mockResolvedValue({} as never);
	beforeResponse = async (params) => {
		started.resolve(params.signal);
		await settleOld.promise;
	};
	try {
		await acceptUserMessage(narratorId, "old task");
		const signal = await started.promise;
		const owner = getExecutionOwner(narratorId);
		const result = await acceptUserMessage(narratorId, "/bash pwd", {
			interrupt: true,
			userId: "control-user",
			commandText: "/bash pwd",
			executionIntent: { controlCommand: true },
		});
		expect(result.buffered).toBe(true);
		expect(signal.aborted).toBe(true);
		expect(bash).not.toHaveBeenCalled();
		expect(getExecutionOwner(narratorId)).toBe(owner);
		settleOld.resolve();
		await waitForIdle(narratorId, 1);
		expect(bash).toHaveBeenCalledTimes(1);
		expect(bash.mock.calls[0]).toEqual([
			narratorId,
			"pwd",
			"/bash pwd",
			"control-user",
			{ skipUserMessage: true, signal: expect.any(AbortSignal) },
		]);
		expect(providerCalls).toEqual(["old task"]);
	} finally {
		settleOld.resolve();
		bash.mockRestore();
		closeNarrator(narratorId);
	}
});

test("a live queued Bash does not hold admission and interrupt terminates its process", async () => {
	const narratorId = "mailbox-live-control";
	seedNarrator(narratorId);
	db.insert(users)
		.values({ id: "bash-user", username: "bash-user", passwordHash: "unused", createdAt: now })
		.run();
	const { bashTool } = await import("../../lib/agent/tools/bash");
	const { interruptManualBash } = await import("../narrator-service");
	const started = Promise.withResolvers<AbortSignal>();
	const stopped = Promise.withResolvers<void>();
	const original = bashTool.execute;
	const execute = spyOn(bashTool, "execute").mockImplementation(async (input, context) => {
		try {
			return await original(input, {
				...context,
				emitOutput: (output) => {
					context.emitOutput?.(output);
					if (String(output).includes("queue-ready")) started.resolve(context.signal);
				},
			});
		} finally {
			stopped.resolve();
		}
	});
	async function within<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Admission/process settlement timed out")),
						1500,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	try {
		const command = "/bash printf queue-ready; sleep 300";
		await acceptUserMessage(narratorId, command, {
			interrupt: true,
			userId: "bash-user",
			commandText: command,
			executionIntent: { controlCommand: true },
		});
		const signal = await within(started.promise);
		const owner = getExecutionOwner(narratorId);
		expect(owner).toBeDefined();
		expect(signal.aborted).toBe(false);
		expect(await within(acceptUserMessage(narratorId, "ordinary while bash"))).toMatchObject({
			buffered: true,
		});
		expect(getExecutionOwner(narratorId)).toBe(owner);
		expect(providerCalls).toEqual([]);
		expect(
			await within(acceptUserMessage(narratorId, "interrupt long bash", { interrupt: true })),
		).toMatchObject({ buffered: true });
		expect(signal.aborted).toBe(true);
		await within(stopped.promise);
		await waitForIdle(narratorId, 2);
		expect(providerCalls).toEqual(["interrupt long bash", "ordinary while bash"]);
	} finally {
		interruptManualBash(narratorId);
		closeNarrator(narratorId);
		await within(stopped.promise).catch(() => {});
		execute.mockRestore();
	}
}, 10_000);

test("control idle settlement excludes concurrent admission until its idle write commits", async () => {
	const narratorId = "mailbox-control-settle-race";
	seedNarrator(narratorId);
	db.insert(users)
		.values({ id: "settle-user", username: "settle-user", passwordHash: "unused", createdAt: now })
		.run();
	const services = await import("../narrator-service");
	const { narratorService } = services;
	const { withNarratorStartAdmission } = await import("../narrator-session-state");
	const idleEntered = Promise.withResolvers<void>();
	const commitIdle = Promise.withResolvers<void>();
	const newTurnStarted = Promise.withResolvers<void>();
	const finishNewTurn = Promise.withResolvers<void>();
	const events: string[] = [];
	const originalCompare = narratorService.compareAndSetStatus.bind(narratorService);
	const compare = spyOn(narratorService, "compareAndSetStatus").mockImplementation(
		async (...args) => {
			if (args[0] === narratorId && args[2] === "idle" && events.length === 0) {
				idleEntered.resolve();
				await commitIdle.promise;
				events.push("idle write");
			}
			return originalCompare(...args);
		},
	);
	const bash = spyOn(services, "handleBashCommand").mockResolvedValue({} as never);
	beforeResponse = async () => {
		newTurnStarted.resolve();
		await finishNewTurn.promise;
	};
	try {
		await acceptUserMessage(narratorId, "/bash pwd", {
			interrupt: true,
			userId: "settle-user",
			commandText: "/bash pwd",
			executionIntent: { controlCommand: true },
		});
		await idleEntered.promise;
		// The first probe is a short admission, independent of model setup/I/O.
		// One event-loop barrier lets all ready admission microtasks run; only the
		// intentionally held settlement lock may prevent this callback executing.
		const probe = withNarratorStartAdmission(narratorId, async () => {
			events.push("next admission");
		});
		const next = acceptUserMessage(narratorId, "new running turn");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(events).toEqual([]);
		expect(providerCalls).toEqual([]);
		commitIdle.resolve();
		await probe;
		await next;
		await newTurnStarted.promise;
		expect(events).toEqual(["idle write", "next admission"]);
		expect(db.select().from(narrators).where(eq(narrators.id, narratorId)).get()?.status).toBe(
			"working",
		);
		expect(getExecutionOwner(narratorId)).toBeDefined();
		finishNewTurn.resolve();
		await waitForIdle(narratorId, 1);
	} finally {
		commitIdle.resolve();
		finishNewTurn.resolve();
		compare.mockRestore();
		bash.mockRestore();
		closeNarrator(narratorId);
	}
});

test("a stale control finalizer cannot settle or release a replacement epoch", async () => {
	const narratorId = "mailbox-control-stale-epoch";
	seedNarrator(narratorId);
	db.insert(users)
		.values({ id: "epoch-user", username: "epoch-user", passwordHash: "unused", createdAt: now })
		.run();
	const services = await import("../narrator-service");
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const bash = spyOn(services, "handleBashCommand").mockImplementation(async () => {
		started.resolve();
		await finish.promise;
		throw new Error("late old command failure");
	});
	let replacement: ReturnType<typeof tryClaimExecution> = null;
	let completion: Promise<void> | undefined;
	try {
		const active = await ensureNarrator(narratorId, "en");
		await enqueueBufferedMessage(
			narratorId,
			"/bash pwd",
			undefined,
			"/bash pwd",
			"epoch-user",
			undefined,
			undefined,
			"back",
			undefined,
			undefined,
			"stack",
			{ controlCommand: true },
		);
		completion = resumeNextBufferedMessage(active, "en");
		await started.promise;
		getExecutionOwner(narratorId)?.release();
		replacement = tryClaimExecution(narratorId, "tool-replay");
		expect(replacement).not.toBeNull();
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, narratorId));
		finish.resolve();
		await completion;
		expect(getExecutionOwner(narratorId)).toBe(replacement ?? undefined);
		expect(db.select().from(narrators).where(eq(narrators.id, narratorId)).get()?.status).toBe(
			"working",
		);
	} finally {
		finish.resolve();
		await completion?.catch(() => {});
		replacement?.release();
		bash.mockRestore();
		closeNarrator(narratorId);
	}
});

test("idle interrupt input starts itself without aborting its new controller", async () => {
	const narratorId = "mailbox-send-interrupt-idle";
	seedNarrator(narratorId);
	const signals: AbortSignal[] = [];
	beforeResponse = async (params) => {
		signals.push(params.signal);
	};
	await acceptUserMessage(narratorId, "new idle turn", { interrupt: true });
	await waitForIdle(narratorId);
	expect(signals).toHaveLength(1);
	expect(signals[0]?.aborted).toBe(false);
	closeNarrator(narratorId);
});

test.each([
	undefined,
	{ controlCommand: true },
	{ modelOverride: { model: "openai:new", mode: "temporary" as const } },
	{ modelOverride: { model: "openai:new", mode: "permanent" as const } },
])("enqueue failure preserves the running owner and model (%j)", async (executionIntent) => {
	const narratorId = "mailbox-send-full";
	seedNarrator(narratorId);
	const active = await ensureNarrator(narratorId, "en");
	const owner = tryClaimExecution(narratorId, "tool-replay");
	const { MAILBOX_LIMITS } = await import("../agent-runtime/limits");
	try {
		for (let index = 0; index < MAILBOX_LIMITS.userPending; index++)
			await enqueueBufferedMessage(narratorId, `queued ${index}`);
		await expect(
			acceptUserMessage(narratorId, "rejected interrupt", { interrupt: true, executionIntent }),
		).rejects.toThrow("Message queue is full");
		expect(active.abortController.signal.aborted).toBe(false);
		expect(getExecutionOwner(narratorId)).toBe(owner ?? undefined);
		const row = db.select().from(narrators).where(eq(narrators.id, narratorId)).get();
		expect(row?.model).toBe("openai:test-model");
		expect(row?.pendingModelRestore).toBeNull();
		expect(
			db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, narratorId))
				.all(),
		).toHaveLength(MAILBOX_LIMITS.userPending);
	} finally {
		owner?.release();
		closeNarrator(narratorId);
	}
});

test("a replacement execution owner is not aborted while an interrupt upload is staging", async () => {
	const narratorId = "mailbox-send-owner-generation";
	seedNarrator(narratorId);
	const active = await ensureNarrator(narratorId, "en");
	const oldOwner = tryClaimExecution(narratorId, "tool-replay");
	const oldController = active.abortController;
	const staging = Promise.withResolvers<void>();
	const finishStaging = Promise.withResolvers<void>();
	const originalWrite = Bun.write;
	const write = spyOn(Bun, "write").mockImplementation((async (
		...args: Parameters<typeof Bun.write>
	) => {
		if (String(args[0]).includes("buffered-files")) {
			staging.resolve();
			await finishStaging.promise;
		}
		return originalWrite(...args);
	}) as typeof Bun.write);
	let newOwner: ReturnType<typeof tryClaimExecution> = null;
	let admission: ReturnType<typeof acceptUserMessage> | undefined;
	try {
		admission = acceptUserMessage(narratorId, "staged replacement", {
			interrupt: true,
			textFiles: [new File(["test attachment"], "example.txt")],
		});
		await staging.promise;
		oldOwner?.release();
		newOwner = tryClaimExecution(narratorId, "tool-replay");
		active.abortController = new AbortController();
		finishStaging.resolve();
		expect(await admission).toMatchObject({ buffered: true });
		expect(active.abortController.signal.aborted).toBe(false);
		expect(oldController.signal.aborted).toBe(false);
		expect(getExecutionOwner(narratorId)).toBe(newOwner ?? undefined);
		const rows = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.narratorId, narratorId))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ state: "queued", priority: true });
		const files = JSON.parse(rows[0]?.textFilePathsJson ?? "[]") as Array<{ path: string }>;
		const file = files[0];
		if (!file) throw new Error("Accepted attachment was not retained");
		expect(await Bun.file(file.path).text()).toBe("test attachment");
	} finally {
		finishStaging.resolve();
		await admission?.catch(() => {});
		write.mockRestore();
		oldOwner?.release();
		newOwner?.release();
		closeNarrator(narratorId);
	}
});
test.each([
	false,
	true,
])("explicit input drains more than one notice batch (plan mode: %s)", async (plan) => {
	const narratorId = `mailbox-send-notice-batches-${plan}`;
	seedNarrator(narratorId);
	if (plan)
		db.update(narrators)
			.set({ traits: ["standalone", "plan"] })
			.where(eq(narrators.id, narratorId))
			.run();
	for (let index = 0; index < 25; index++) enqueueCancelledNotice(narratorId, index);
	const result = await acceptUserMessage(narratorId, "continue after the notice backlog");
	expect(result).toMatchObject({ buffered: true });
	await waitForIdle(narratorId);
	expect(providerCalls).toEqual(["continue after the notice backlog"]);
	const rows = db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.all();
	expect(rows).toHaveLength(26);
	expect(rows.every((row) => row.state === "materialized")).toBe(true);
	closeNarrator(narratorId);
});
test("gates the synchronous pending-work probe on PostgreSQL", () => {
	bindRuntimeQueue({ backend: "postgres", queue: {} as RuntimeQueuePort });
	try {
		expect(() => hasPendingBufferedWork("mailbox-send-pg-gate")).toThrow(
			"cannot inspect the PostgreSQL mailbox",
		);
	} finally {
		bindRuntimeQueue({ backend: "sqlite" });
	}
});

test("uses awaited backend-neutral cleanup for buffered deliveries", async () => {
	const source = await Bun.file(new URL("../narrator-session.ts", import.meta.url)).text();
	expect(source).toContain("await cleanupBufferedTextFilesAsync(first.id)");
	expect(source).toContain("await cleanupBufferedTextFilesAsync(stagingId)");
	expect(source).not.toContain("cleanupBufferedTextFiles(");
});

test.each([
	["remove", false],
	["downgrade", false],
	["remove", true],
	["downgrade", true],
] as const)("withdrawn guidance during preflight resumes original work before ordinary inputs (%s, fresh=%s)", async (operation, freshTurn) => {
	const narratorId = `mailbox-preflight-guidance-${operation}-${freshTurn}`;
	seedNarrator(narratorId);
	const enteredPreflight = Promise.withResolvers<void>();
	const releasePreflight = Promise.withResolvers<void>();
	let reads = 0;
	const originalHistory = narratorService.getModelHistorySinceLastCompact.bind(narratorService);
	const historyRead = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
		async (...args) => {
			if (args[0] === narratorId && reads++ === 0) {
				enteredPreflight.resolve();
				await releasePreflight.promise;
			}
			return originalHistory(...args);
		},
	);
	try {
		await acceptUserMessage(narratorId, "unfinished original work");
		await enteredPreflight.promise;
		if (freshTurn) {
			await acceptUserMessage(narratorId, "ordinary next step", {
				executionIntent: { modelOverride: { model: "openai:next-model", mode: "permanent" } },
			});
		} else {
			await enqueueBufferedMessage(narratorId, "ordinary next step");
		}
		const accepted = await acceptUserMessage(narratorId, "withdrawn guidance", {
			queueMode: "tool",
		});
		if (!accepted.buffered) throw new Error("Expected busy guidance admission");
		if (operation === "remove") {
			expect(await removeBufferedMessage(narratorId, accepted.id)).toBe(true);
		} else {
			expect(await updateBufferedMessageMode(narratorId, accepted.id, "turn")).toBe(true);
		}
		clearBufferedMessageSoftStopIfIdle(narratorId, false);
		expect(providerCalls).toEqual([]);
		releasePreflight.resolve();
		await waitForIdle(narratorId, operation === "remove" ? 2 : 3);
		// The cancelled pass must recover the original task before consuming any
		// ordinary next step; downgraded guidance is also just a later next step.
		expect(providerCalls).toEqual(
			operation === "remove"
				? ["unfinished original work", "ordinary next step"]
				: ["unfinished original work", "ordinary next step", "withdrawn guidance"],
		);
	} finally {
		releasePreflight.resolve();
		historyRead.mockRestore();
		closeNarrator(narratorId);
	}
});
test("named send shares durable user admission and reserves a distinct history id", async () => {
	const narratorId = "unified-send-user-receipt";
	seedNarrator(narratorId);
	try {
		const result = await sendMessage({ kind: "user", narratorId, message: "shared admission" });
		expect(result.accepted).toBe(true);
		expect(result.duplicate).toBe(false);
		expect(result.messageId).not.toBe(result.mailboxId);
		await waitForIdle(narratorId);
		const mailbox = db.select().from(narratorBufferedMessages).where(eq(narratorBufferedMessages.narratorId, narratorId)).all();
		const history = db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, narratorId)).all().filter((row) => row.role === "user");
		expect(mailbox).toHaveLength(1);
		expect(mailbox[0].id).toBe(result.mailboxId);
		expect(history).toHaveLength(1);
		expect(history[0].id).toBe(result.messageId);
	} finally { closeNarrator(narratorId); }
});

test("named queue policy and legacy busy rejection use the same admission lock", async () => {
	const narratorId = "unified-send-busy-policy";
	seedNarrator(narratorId);
	const owner = await tryClaimExecution(narratorId, "primary");
	if (!owner) throw new Error("fixture could not claim execution");
	try {
		await expect(sendMessage({ kind: "user", narratorId, message: "reject", busyPolicy: "reject" })).rejects.toThrow();
		await expect(sendMessage(narratorId, "legacy reject")).rejects.toThrow();
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(0);
		const result = await sendMessage({ kind: "user", narratorId, message: "queue", busyPolicy: "queue" });
		expect(result).toMatchObject({ accepted: true, delivered: "buffered", state: "queued" });
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(1);
		expect(providerCalls).toHaveLength(0);
	} finally { owner.release(); closeNarrator(narratorId); }
});

test("named admission keeps acceptance after a notification failure", async () => {
	const narratorId = "unified-send-notification-failure";
	seedNarrator(narratorId);
	const websocket = await import("../../websocket/narrator-ws");
	const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation(() => { throw new Error("notification unavailable"); });
	const owner = await tryClaimExecution(narratorId, "primary");
	if (!owner) throw new Error("fixture could not claim execution");
	try {
		const result = await sendMessage({ kind: "user", narratorId, message: "accepted despite WS", busyPolicy: "queue" });
		expect(result.accepted).toBe(true);
		expect(result.mailboxId).toBeTruthy();
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(1);
	} finally { broadcast.mockRestore(); owner.release(); closeNarrator(narratorId); }
});

test("named user pre-cancellation cannot write or dispatch", async () => {
	const narratorId = "unified-send-user-cancelled";
	seedNarrator(narratorId);
	const controller = new AbortController();
	controller.abort();
	try {
		await expect(sendMessage({ kind: "user", narratorId, message: "cancelled", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(0);
		expect(providerCalls).toHaveLength(0);
	} finally { closeNarrator(narratorId); }
});

test("named subagent send accepts once before mailbox-only resume and preserves queued receipt on failure", async () => {
	const narratorId = "unified-send-subagent-resume";
	seedNarrator(narratorId);
	db.update(narrators).set({ type: "subagent", variant: "subagent:general" }).where(eq(narrators.id, narratorId)).run();
	const resumes = await import("../subagent-resume");
	const origin = spyOn(resumes, "resolveSubagentOriginToolUseId").mockResolvedValue("agent-origin");
	const resume = spyOn(resumes, "resumeSubagent").mockImplementation(async (input) => {
		expect(input).toMatchObject({ subagentId: narratorId, mailboxInput: true });
		expect(input.prompt).toBeUndefined();
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(1);
		throw new Error("runner unavailable");
	});
	try {
		const result = await sendMessage({ kind: "user", target: "subagent", narratorId, message: "one copy" });
		expect(result).toMatchObject({ accepted: true, delivered: "buffered" });
		expect(result.wakeError).toContain("runner unavailable");
		expect(result.messageId).not.toBe(result.mailboxId);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(db.select().from(narratorMessages).all()).toHaveLength(0);
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(1);
		expect(providerCalls).toHaveLength(0);
	} finally { resume.mockRestore(); origin.mockRestore(); closeNarrator(narratorId); }
});

test("running subagent pre-cancellation is checked by shared admission", async () => {
	const narratorId = "unified-send-subagent-cancelled";
	seedNarrator(narratorId);
	db.update(narrators).set({ type: "subagent", variant: "subagent:general", status: "working" }).where(eq(narrators.id, narratorId)).run();
	const controller = new AbortController();
	controller.abort();
	try {
		await expect(sendMessage({ kind: "user", target: "subagent", narratorId, message: "never queued", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(0);
	} finally { closeNarrator(narratorId); }
});
afterAll(() => {
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});
