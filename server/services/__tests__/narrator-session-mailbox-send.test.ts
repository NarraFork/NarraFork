import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages, narratorMessages, narrators, users } from "../../db/schema";
import type { ChatParams, ProviderAdapter } from "../../lib/agent/provider";
import type { RuntimeQueuePort } from "../agent-runtime/runtime-queue-port";

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
	acquireNarratorRevertAdmission,
	startBackgroundCompletionContinuationIfPossible,
	startParentInboundContinuationIfPossible,
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
const { wakeInboxIfEligible } = await import("../agent-runtime/inbox");
const { compactLocks, pendingPermissions } = await import("../narrator-session-state");
const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");

const now = new Date().toISOString();

function seedNarrator(narratorId: string) {
	db.insert(narrators)
		.values({
			id: narratorId,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model: "openai:test-model",
			// These fixtures intentionally exercise anonymous system execution, not an
			// unknown principal (which the runtime correctly refuses to invent).
			runtimeRegistrationJson: {
				version: 1,
				run: { logicalRunId: `fixture-${narratorId}`, principal: { userId: null } },
			},
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			status: "idle",
			cwd: process.cwd(),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	// Direct SQL fixtures must publish the same entity-specific maintenance as production writes.
	backgroundOccupancyStore.refreshNarrator(narratorId);
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
	const deadline = Date.now() + 3_000;
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
			!(await hasPendingBufferedWork(narratorId))
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for narrator loop");
}

beforeEach(async () => {
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	providerCalls.length = 0;
	beforeResponse = undefined;
});

afterEach(async () => {
	await backgroundOccupancyStore.flush();
});

test.each([
	[false, false],
	[true, false],
	// A delegated session queues and consumes input exactly like any other session.
	[true, true],
])("composer document persists atomically with accepted input (queued=%s, delegated=%s)", async (queued, delegated) => {
	const narratorId = `composer-send-${queued}-${delegated}`;
	seedNarrator(narratorId);
	if (delegated) {
		seedNarrator(`${narratorId}-caller`);
		db.update(narrators)
			.set({
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: `${narratorId}-caller`,
			})
			.where(eq(narrators.id, narratorId))
			.run();
	}
	if (queued) await enqueueBufferedMessage(narratorId, "earlier");
	const document = {
		version: 1 as const,
		paragraphs: [{ children: [{ type: "text" as const, text: "rich 😀" }] }],
		assets: [],
	};
	const result = await acceptUserMessage(narratorId, "rich 😀", { composerDocument: document });
	if (!result.buffered) expect(result.userMsg).toMatchObject({ hasComposerDocument: true });
	await waitForIdle(narratorId, queued ? 2 : 1);
	const row = db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.contentText, "rich 😀"))
		.get();
	expect(row?.composerDocument).toEqual(document);
	expect(row?.contentJson).toEqual([{ type: "text", text: "rich 😀" }]);
	expect(providerCalls.at(-1)).toBe("rich 😀");
	closeNarrator(narratorId);
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

test("interrupt terminates a running loop's pre-command Bash and is adopted in the same run", async () => {
	const narratorId = "mailbox-loop-pre-bash";
	seedNarrator(narratorId);
	db.insert(users)
		.values({ id: "pre-user", username: "pre-user", passwordHash: "unused", createdAt: now })
		.run();
	const { bashTool } = await import("../../lib/agent/tools/bash");
	const { interruptManualBash } = await import("../narrator-service");
	const oldStarted = Promise.withResolvers<void>();
	const releaseOld = Promise.withResolvers<void>();
	const bashStarted = Promise.withResolvers<AbortSignal>();
	const bashStopped = Promise.withResolvers<void>();
	const original = bashTool.execute;
	const execute = spyOn(bashTool, "execute").mockImplementation(async (input, context) => {
		try {
			return await original(input, {
				...context,
				emitOutput: (output) => {
					context.emitOutput?.(output);
					if (String(output).includes("pre-ready")) bashStarted.resolve(context.signal);
				},
			});
		} finally {
			bashStopped.resolve();
		}
	});
	let ownerAtUrgent: unknown;
	beforeResponse = async (params) => {
		if (params.content === "old task") {
			oldStarted.resolve();
			await releaseOld.promise;
		}
		if (params.content === "urgent input") ownerAtUrgent = getExecutionOwner(narratorId);
	};
	async function within<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Pre-command settlement timed out")), 2000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	try {
		await acceptUserMessage(narratorId, "old task");
		await within(oldStarted.promise);
		const owner = getExecutionOwner(narratorId);
		// An ordinary next step with a pre-command: the live loop adopts it and runs the
		// Bash as its current activity.
		expect(
			await acceptUserMessage(narratorId, "after pre", {
				userId: "pre-user",
				preBashCommand: "printf pre-ready; sleep 300",
			}),
		).toMatchObject({ buffered: true });
		releaseOld.resolve();
		const signal = await within(bashStarted.promise);
		expect(signal.aborted).toBe(false);
		expect(getExecutionOwner(narratorId)).toBe(owner);

		expect(
			await within(acceptUserMessage(narratorId, "urgent input", { interrupt: true })),
		).toMatchObject({ buffered: true });
		expect(signal.aborted).toBe(true);
		await within(bashStopped.promise);

		const deadline = Date.now() + 3_000;
		while (!providerCalls.includes("urgent input") && Date.now() < deadline) await Bun.sleep(10);
		expect(providerCalls[0]).toBe("old task");
		expect(providerCalls).toContain("urgent input");
		// Same run: the owner that ran the old task adopted the urgent input.
		expect(ownerAtUrgent).toBe(owner);
		expect(
			db
				.select({ reason: narrators.lastStopReason })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get()?.reason,
		).not.toBe("user_interrupt");
	} finally {
		releaseOld.resolve();
		interruptManualBash(narratorId);
		closeNarrator(narratorId);
		await within(bashStopped.promise).catch(() => {});
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
		backgroundOccupancyStore.refreshNarrator(narratorId);
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
	backgroundOccupancyStore.refreshNarrator(narratorId);
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
function enqueueDelegatedReport(narratorId: string, kind: "agent" | "bash" | "send") {
	const text = `delegated ${kind} research result`;
	// Seed an already accepted delivery; producer receipt admission is covered by inbox tests.
	db.insert(narrators)
		.values({
			id: "research-child",
			type: "subagent",
			variant: "subagent:plan",
			parentNarratorId: narratorId,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.run();
	backgroundOccupancyStore.refreshNarrator("research-child");
	const store = createMailboxStore(db);
	const resultMessageId = `${narratorId}-result`;
	if (kind === "agent")
		db.insert(narratorMessages)
			.values({
				id: resultMessageId,
				narratorId: "research-child",
				role: "assistant",
				contentJson: [{ type: "text", text }],
				contentText: text,
				createdAt: now,
			})
			.run();
	const delivery = createAgentMessageDelivery(
		narratorId,
		{ id: "research-child", label: "research-child", type: "plan", isParent: false },
		"research-send",
		text,
	);
	const result = store.enqueue({
		narratorId,
		...(kind === "send"
			? {
					kind: "agent_message" as const,
					recipientMessageId: delivery.recipientMessageId,
					sourceNarratorId: "research-child",
					sourceToolCallId: "research-send",
					sourceAttempt: 1,
				}
			: { kind: "task_notice" as const, noticeKind: kind }),
		sourceKey: `delegated-${kind}`,
		text,
		projectedByteSize: Buffer.byteLength(text),
		metadata:
			kind === "send"
				? { delivery, channel: "parent" }
				: {
						producerKind: kind,
						taskId: "research-child",
						logicalRunId: "research-run",
						eventKind: "completed",
						...(kind === "agent" ? { resultRef: `message:${resultMessageId}` } : {}),
					},
	});
	if (!("delivery" in result)) throw new Error("failed to enqueue delegated report");
}

for (const plan of [false, true]) {
	for (const kind of ["agent", "bash", "send"] as const) {
		test(`delegated ${kind} report wakes idle parent without changing plan mode (${plan})`, async () => {
			const narratorId = `mailbox-report-${kind}-${plan}`;
			seedNarrator(narratorId);
			const traits = plan ? ["standalone", "plan"] : ["standalone"];
			db.update(narrators).set({ traits }).where(eq(narrators.id, narratorId)).run();
			backgroundOccupancyStore.refreshNarrator(narratorId);
			enqueueDelegatedReport(narratorId, kind);
			try {
				expect(await wakeInboxIfEligible(narratorId)).toBe(true);
				await waitForIdle(narratorId);
				expect(providerCalls).toHaveLength(1);
				const row = db.select().from(narrators).where(eq(narrators.id, narratorId)).get();
				expect(row?.traits).toEqual(traits);
				expect(row?.permissionMode).toBe("bypassPermissions");
				const receipt = db
					.select()
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.narratorId, narratorId))
					.get();
				expect(receipt?.state).toBe("materialized");
				const message = db
					.select()
					.from(narratorMessages)
					.where(eq(narratorMessages.id, receipt?.recipientMessageId ?? ""))
					.get();
				expect(message?.contentText).toContain(`delegated ${kind} research result`);
				expect(await wakeInboxIfEligible(narratorId)).toBe(false);
			} finally {
				closeNarrator(narratorId);
			}
		});
	}
}

test("notification entries share admission and start only one plan-mode loop", async () => {
	const narratorId = "mailbox-report-concurrent-plan";
	seedNarrator(narratorId);
	db.update(narrators)
		.set({ traits: ["standalone", "plan"] })
		.where(eq(narrators.id, narratorId))
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
	enqueueDelegatedReport(narratorId, "agent");
	try {
		const results = await Promise.all([
			startBackgroundCompletionContinuationIfPossible(narratorId),
			startParentInboundContinuationIfPossible(narratorId),
		]);
		expect(results.filter((result) => result.started)).toHaveLength(1);
		await waitForIdle(narratorId);
		expect(providerCalls).toHaveLength(1);
	} finally {
		closeNarrator(narratorId);
	}
});

test("plan-mode parent wakes after a report arrives during idle finalization", async () => {
	const narratorId = "mailbox-report-finalization-plan";
	seedNarrator(narratorId);
	db.update(narrators)
		.set({ traits: ["standalone", "plan"] })
		.where(eq(narrators.id, narratorId))
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
	const original = narratorService.updateStatus.bind(narratorService);
	let queued = false;
	const update = spyOn(narratorService, "updateStatus").mockImplementation(async (...args) => {
		const result = await original(...args);
		if (args[0] === narratorId && args[1] === "idle" && providerCalls.length === 1 && !queued) {
			queued = true;
			enqueueDelegatedReport(narratorId, "agent");
			// The old owner still holds execution; release must recheck the durable queue.
			expect(getExecutionOwner(narratorId)).toBeDefined();
			expect(await wakeInboxIfEligible(narratorId)).toBe(false);
		}
		return result;
	});
	try {
		await acceptUserMessage(narratorId, "delegate research then stop");
		await waitForIdle(narratorId, 2);
		expect(queued).toBe(true);
		expect(
			db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, narratorId))
				.get()?.state,
		).toBe("materialized");
	} finally {
		update.mockRestore();
		closeNarrator(narratorId);
	}
});

test("plan parent without queued work does not start a notification turn", async () => {
	const narratorId = "mailbox-report-empty-plan";
	seedNarrator(narratorId);
	db.update(narrators)
		.set({ traits: ["standalone", "plan"] })
		.where(eq(narrators.id, narratorId))
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
	try {
		expect(await wakeInboxIfEligible(narratorId)).toBe(false);
		expect(await startBackgroundCompletionContinuationIfPossible(narratorId)).toEqual({
			started: false,
		});
		expect(providerCalls).toHaveLength(0);
	} finally {
		closeNarrator(narratorId);
	}
});

test.each([
	"owner",
	"approval",
	"compact",
	"revert",
	"working",
	"waiting",
	"archived",
	"user_interrupt",
	"error",
] as const)("plan-mode notification respects %s barrier and leaves report queued", async (barrier) => {
	const narratorId = `mailbox-report-barrier-${barrier}`;
	seedNarrator(narratorId);
	db.update(narrators)
		.set({ traits: ["standalone", "plan"] })
		.where(eq(narrators.id, narratorId))
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
	enqueueDelegatedReport(narratorId, "agent");
	let release: (() => void) | undefined;
	if (barrier === "owner") {
		const owner = tryClaimExecution(narratorId, "run");
		if (!owner) throw new Error("failed to claim owner");
		release = () => {
			owner.release();
		};
	} else if (barrier === "approval") {
		pendingPermissions.set(narratorId, {
			narratorId,
			toolName: "ExitPlanMode",
			toolUseId: "exit-plan",
			broadcastTargetId: narratorId,
			cwd: process.cwd(),
			locale: "en",
			input: { mode: "inline", inline_plan: "pending plan" },
			signal: new AbortController().signal,
			resolve: () => {},
			cleanup: () => {},
		});
		release = () => {
			pendingPermissions.delete(narratorId);
		};
	} else if (barrier === "compact") {
		compactLocks.set(narratorId, {
			kind: "history",
			promise: Promise.resolve({ kind: "history", compacted: false }),
		});
		release = () => {
			compactLocks.delete(narratorId);
		};
	} else if (barrier === "revert") {
		release = await acquireNarratorRevertAdmission(narratorId, {
			signal: new AbortController().signal,
			interrupt: false,
		});
	} else if (barrier === "user_interrupt" || barrier === "error") {
		db.update(narrators).set({ lastStopReason: barrier }).where(eq(narrators.id, narratorId)).run();
	} else {
		db.update(narrators).set({ status: barrier }).where(eq(narrators.id, narratorId)).run();
	}
	backgroundOccupancyStore.refreshNarrator(narratorId);
	try {
		expect(await wakeInboxIfEligible(narratorId)).toBe(false);
		// The compatibility entry must apply the same gates inside start admission.
		if (barrier !== "revert") {
			expect(await startBackgroundCompletionContinuationIfPossible(narratorId)).toEqual({
				started: false,
			});
			expect(await startParentInboundContinuationIfPossible(narratorId)).toEqual({
				started: false,
			});
		}
		expect(providerCalls).toHaveLength(0);
		expect(
			db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, narratorId))
				.get()?.state,
		).toBe("queued");
	} finally {
		release?.();
		closeNarrator(narratorId);
	}
});

test("gates the SQLite pending-work probe on PostgreSQL", async () => {
	bindRuntimeQueue({ backend: "postgres", queue: {} as RuntimeQueuePort });
	try {
		await expect(hasPendingBufferedWork("mailbox-send-pg-gate")).rejects.toThrow(
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
		await clearBufferedMessageSoftStopIfIdle(narratorId, false);
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
afterAll(() => {
	backgroundOccupancyStore.resetForTests();
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});
