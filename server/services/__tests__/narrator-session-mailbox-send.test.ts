import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
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
		providerCalls.push(params.content);
		params.onRequestStart?.();
		await beforeResponse?.(params);
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
	ensureNarrator,
	hasPendingBufferedWork,
	sendMessage,
	resumeNextBufferedMessage,
} = await import("../narrator-session");
const { enqueueBufferedMessage } = await import("../narrator-buffer");
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

afterAll(() => {
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});
