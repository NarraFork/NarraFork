import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { resolveBufferQueueMode } from "@shared/buffer-queue-mode";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessages,
	narrators,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { ToolResult } from "../../lib/agent/types";
import { AppError, ValidationError } from "../../lib/errors";
import { updateBufferedMessageModeSchema } from "../../lib/validators/narrators";

// tests/preload.ts isolates HOME before imports; never load the production DB singleton.
const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
for (const [table, column, type] of [
	["narrator_tool_calls", "execution_device_id", "TEXT"],
	["narrator_tool_calls", "execution_cwd", "TEXT"],
	["narrator_tool_calls", "execution_path_flavor", "TEXT"],
	["narrator_tool_calls", "resolved_file_path", "TEXT"],
	["narrator_tool_calls", "canonical_file_path", "TEXT"],
	["narrator_tool_calls", "runtime_generation", "INTEGER"],
	["narrator_tool_calls", "execution_targets_json", "TEXT"],
	["narrator_tool_calls", "device_selection_source", "TEXT"],
]) {
	try {
		sqlite.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
	} catch (error) {
		if (!String(error).includes("duplicate column name")) throw error;
	}
}

const parent = "urgent-await-parent";
const child = "urgent-await-child";
const calls: string[] = [];
const started = Promise.withResolvers<AbortSignal>();
const returned = Promise.withResolvers<ToolResult>();
const childStarted = Promise.withResolvers<AbortSignal>();
const childReturned = Promise.withResolvers<ToolResult>();
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		calls.push(params.content.replace(/^<sender kind="human" \/>\n/, ""));
		params.onRequestStart?.();
		if (calls.length === 1) {
			yield {
				toolUses: [
					{
						toolUseId: "urgent-await-tool",
						name: "Await",
						input: { type: "agent", id: child, timeout: 600_000 },
						outputIndex: 0,
					},
				],
			};
		} else if (params.content.includes("start child real Await")) {
			yield {
				toolUses: [
					{
						toolUseId: "child-real-await",
						name: "Await",
						input: { type: "bash", id: "child-running-bash", timeout: 600_000 },
						outputIndex: 0,
					},
				],
			};
		} else yield { text: "replacement task completed" };
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

const { acceptUserMessage, closeNarrator, applyBufferedQueueModeControl } = await import(
	"../narrator-session"
);
const {
	enqueueBufferedMessage,
	updateBufferedMessageMode,
	retryBufferedMessage,
	getBufferedMessages,
	getBufferedMessagesAsync,
	readBufferedMessageDeliveryReceipt,
	waitForBufferedMessageDelivery,
} = await import("../narrator-buffer");
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const { activeNarrators, withNarratorStartAdmission } = await import("../narrator-session-state");
const { narratorService } = await import("../narrator-service");
const { wakeInboxIfEligible } = await import("../agent-runtime/inbox");
const { applySubagentBufferedQueueModeControl, executeSubagent } = await import(
	"../subagent-executor"
);
const { markTakenOver, clearTakenOver, isTakenOver } = await import("../subagent-takeover");

// Actual route registrations + actual service controls/receipt; only auth and WS presentation
// are outside this harness. Unlike the route contract unit tests no control is mocked.
const routeSource = await Bun.file(new URL("../../routes/narrators.ts", import.meta.url)).text();
const routeStart = routeSource.indexOf("async function applyPendingBufferModeControl(");
const routeEnd = routeSource.indexOf("// Remove a single", routeStart);
if (routeStart < 0 || routeEnd < 0) throw new Error("Buffer mode route boundary missing");
const compiledRoute = new Bun.Transpiler({ loader: "ts" }).transformSync(
	routeSource
		.slice(routeStart, routeEnd)
		.replace(/import\(\s*"\.\.\/services\/[^"]+"\s*\)/g, "Promise.resolve(services)"),
);
const actualRoutes = new Hono();
const bindings = {
	narratorRoutes: actualRoutes,
	services: {
		withNarratorStartAdmission,
		applyBufferedQueueModeControl,
		applySubagentBufferedQueueModeControl,
		waitForBufferedMessageDelivery,
		readBufferedMessageDeliveryReceipt,
		wakeInboxIfEligible,
	},
	AppError,
	ValidationError,
	updateBufferedMessageModeSchema,
	resolveBufferQueueMode,
	updateBufferedMessageMode,
	retryBufferedMessage,
	getBufferedMessagesAsync,
	narratorService,
	isSubagentVariant: (variant: string) => variant.startsWith("subagent"),
	broadcastBufferQueue: async () => {},
};
new Function(...Object.keys(bindings), compiledRoute)(...Object.values(bindings));
actualRoutes.onError((error, c) =>
	c.json({ error: error.message }, error instanceof AppError ? (error.statusCode as 400) : 500),
);
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { awaitTool, listRunningAwaits } = await import("../../lib/agent/tools/await");

// Only instrument entry/exit: execute, target resolution, waiter, loop and service controls are real.
toolRegistry.register({
	...awaitTool,
	async execute(args, ctx) {
		(ctx.narratorId === child ? childStarted : started).resolve(ctx.signal);
		const result = await awaitTool.execute(args, ctx);
		(ctx.narratorId === child ? childReturned : returned).resolve(result);
		return result;
	},
});
afterAll(async () => {
	closeNarrator(parent);
	await until(() => !getExecutionOwner(parent), "cleanup owner released");
	toolRegistry.register(awaitTool);
	mock.restore();
});

async function until(predicate: () => boolean, label: string, timeout = 3_000) {
	const deadline = Date.now() + timeout;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
	if (!predicate()) throw new Error(`Timed out: ${label}; calls=${JSON.stringify(calls)}`);
}

function queued(text: string, narratorId = parent) {
	return enqueueBufferedMessage(
		narratorId,
		text,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		"front",
		undefined,
		undefined,
		"fifo",
		undefined,
		"tool",
	);
}

let evidence: {
	aborted: boolean;
	awaitStatus: unknown;
	oldOwnerReleased: boolean;
	selectedId: string;
	selectedState: string | undefined;
	selectedPending: boolean;
	users: Array<string | null>;
	queueOrder: string[];
};

beforeAll(async () => {
	const now = new Date().toISOString();
	db.insert(narrators)
		.values([
			{
				id: parent,
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
			},
			{
				id: child,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: parent,
				aclRootNarratorId: parent,
				status: "working",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	try {
		await acceptUserMessage(parent, "start real Await");
		await until(
			() => listRunningAwaits().some((entry) => entry.targetId === child),
			"Await started",
		);
		const signal = await started.promise;
		const owner = getExecutionOwner(parent);
		expect(owner).toBeDefined();
		expect(signal.aborted).toBe(false);
		const older = await queued("older tool guidance");
		const selected = await queued("selected urgent guidance");
		expect(older.ok && selected.ok).toBe(true);
		const response = await actualRoutes.request(`/${parent}/buffer/${selected.id}/mode`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "interrupt" }),
		});
		expect(response.status).toBe(200);
		const ack = (await response.json()) as { delivered?: boolean; messageId?: string };
		expect(ack.delivered).toBe(true);
		expect(
			(await readBufferedMessageDeliveryReceipt(parent, selected.id))?.recipientMessageId,
		).toBe(ack.messageId);
		await until(() => !owner?.isCurrent(), "old owner released");
		// Give finalization-triggered asynchronous dispatch a bounded chance to run.
		const dispatchDeadline = Date.now() + 1_000;
		while (calls.length < 3 && Date.now() < dispatchDeadline) await Bun.sleep(10);
		await until(() => !getExecutionOwner(parent), "replacement owner released");
		const result = await returned.promise;
		const rows = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.narratorId, parent))
			.all();
		const users = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, parent))
			.orderBy(asc(narratorMessages.createdAt))
			.all()
			.filter((row) => row.role === "user")
			.map((row) => row.contentText);
		const active = activeNarrators.get(parent);
		console.info(
			"urgent Await evidence",
			JSON.stringify({
				aborted: signal.aborted,
				awaitStatus: result.metadata?.status,
				oldOwnerReleased: !owner?.isCurrent(),
				calls,
				users,
				ack,
				status: db
					.select({ status: narrators.status })
					.from(narrators)
					.where(eq(narrators.id, parent))
					.get()?.status,
				active: {
					alive: active?.alive,
					loopRunning: active?._loopRunning,
					bufferSoftStop: active?._bufferSoftStop,
					guidancePending: active?._bufferGuidancePending,
				},
				pendingHead: getBufferedMessages(parent)[0]?.text ?? null,
				queue: rows.map((row) => ({
					text: row.text,
					state: row.state,
					priority: row.priority,
					seq: row.seq,
				})),
			}),
		);
		evidence = {
			aborted: signal.aborted,
			awaitStatus: result.metadata?.status,
			oldOwnerReleased: !owner?.isCurrent(),
			selectedId: selected.id,
			selectedState: rows.find((row) => row.id === selected.id)?.state,
			selectedPending: getBufferedMessages(parent).some((row) => row.id === selected.id),
			users,
			queueOrder: getBufferedMessages(parent).map((row) => row.text),
		};
	} finally {
		closeNarrator(parent);
	}
}, 10_000);

test("interrupt aborts the real Await context and releases its old execution owner", () => {
	expect(evidence.aborted).toBe(true);
	expect(evidence.awaitStatus).toBe("aborted");
	expect(evidence.oldOwnerReleased).toBe(true);
});

test("selected urgent input is materialized instead of stranded in the pending list", () => {
	expect(evidence.selectedState).toBe("materialized");
	expect(evidence.selectedPending).toBe(false);
});

test("selected urgent input reaches persisted user history and a new provider request", () => {
	expect(evidence.users).toContain("selected urgent guidance");
	expect(calls).toContain("selected urgent guidance");
});

test("selected interrupt is ahead of other unsent tool guidance", () => {
	const order = calls.length > 1 ? calls.slice(1) : evidence.queueOrder;
	expect(order).toEqual(["selected urgent guidance", "older tool guidance"]);
});

test("POST retry promotes selected failed urgent A ahead of newer urgent B before dispatch", async () => {
	const narratorId = "urgent-retry-sort-parent";
	const now = new Date().toISOString();
	await db.insert(narrators).values({
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
	});
	const selected = await queued("retry selected urgent A", narratorId);
	await updateBufferedMessageMode(narratorId, selected.id, "interrupt");
	sqlite.run(
		"UPDATE narrator_buffered_messages SET state = 'failed', last_error = 'old failure' WHERE id = ?",
		[selected.id],
	);
	const newer = await queued("newer urgent B", narratorId);
	await updateBufferedMessageMode(narratorId, newer.id, "interrupt");
	expect(getBufferedMessages(narratorId).map((row) => row.text)).toEqual([
		"newer urgent B",
		"retry selected urgent A",
	]);
	const callStart = calls.length;
	try {
		const response = await actualRoutes.request(`/${narratorId}/buffer/${selected.id}/retry`, {
			method: "POST",
		});
		expect(response.status).toBe(200);
		const ack = (await response.json()) as { delivered?: boolean; messageId?: string };
		expect(ack.delivered).toBe(true);
		expect(await readBufferedMessageDeliveryReceipt(narratorId, selected.id)).toMatchObject({
			state: "materialized",
			recipientMessageId: ack.messageId,
		});
		await until(
			() => calls.length >= callStart + 2 && !getExecutionOwner(narratorId),
			"retry A and B dispatched",
		);
		expect(calls.slice(callStart)).toEqual(["retry selected urgent A", "newer urgent B"]);
		expect(getBufferedMessages(narratorId)).toHaveLength(0);
	} finally {
		closeNarrator(narratorId);
		await until(() => !getExecutionOwner(narratorId), "retry cleanup");
	}
});

test("receipt timeout retains the urgent payload and staged attachment ownership", async () => {
	const image = { imageId: "preserved-image", filename: "screen.png", mediaType: "image/png" };
	const input = await enqueueBufferedMessage(
		parent,
		"retained on timeout",
		[image],
		undefined,
		undefined,
		undefined,
		[new File(["keep me"], "retained.txt")],
	);
	expect(await updateBufferedMessageMode(parent, input.id, "interrupt")).toBe(true);
	const before = db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, input.id))
		.get();
	await expect(
		waitForBufferedMessageDelivery(parent, input.id, {
			timeoutMs: 60,
			wake: async () => false,
		}),
	).rejects.toMatchObject({ statusCode: 504, code: "BUFFER_DELIVERY_TIMEOUT" });
	const after = db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, input.id))
		.get();
	expect(after?.state).toBe("queued");
	expect(after?.imagesJson).toBe(before?.imagesJson);
	expect(after?.textFilePathsJson).toBe(before?.textFilePathsJson);
	expect(after?.metadataJson).toBe(before?.metadataJson);
	const projected = getBufferedMessages(parent).find((row) => row.id === input.id);
	expect(projected?.textFiles?.[0] && (await projected.textFiles[0].text())).toBe("keep me");
});

test("request cancellation does not cancel or retry the durable urgent input", async () => {
	const input = await queued("retained after request abort");
	const controller = new AbortController();
	const wakeStarted = Promise.withResolvers<void>();
	let wakes = 0;
	const waiting = waitForBufferedMessageDelivery(parent, input.id, {
		signal: controller.signal,
		wake: async () => {
			wakes++;
			wakeStarted.resolve();
			return new Promise<boolean>(() => {});
		},
	});
	await wakeStarted.promise;
	controller.abort();
	await expect(waiting).rejects.toMatchObject({
		statusCode: 499,
		code: "BUFFER_DELIVERY_CANCELLED",
	});
	expect(wakes).toBe(1);
	expect((await readBufferedMessageDeliveryReceipt(parent, input.id))?.state).toBe("queued");
});

test("failed or cancelled receipts reject without automatic retry or wake", async () => {
	for (const state of ["failed", "cancelled"]) {
		const input = await queued(`terminal ${state}`);
		sqlite.run("UPDATE narrator_buffered_messages SET state = ? WHERE id = ?", [state, input.id]);
		let wakes = 0;
		await expect(
			waitForBufferedMessageDelivery(parent, input.id, {
				wake: async () => {
					wakes++;
					return false;
				},
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(wakes).toBe(0);
		expect((await readBufferedMessageDeliveryReceipt(parent, input.id))?.state).toBe(state);
	}
});

test("taken-over child Await is interrupted without ending takeover or skipping urgent's first request", async () => {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			model: "openai:test-model",
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			traits: ["standalone"],
			cwd: process.cwd(),
		})
		.where(eq(narrators.id, child));
	sqlite.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('child-owning-message', ?, 'assistant', '[]', ?)",
		[parent, now],
	);
	sqlite.run(
		"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES ('child-owning-call', ?, 'child-owning-message', 'child-owning-tool', 'Agent', 'running', ?)",
		[parent, now],
	);
	await db.insert(backgroundTasks).values({
		id: "child-running-bash",
		type: "bash",
		parentNarratorId: child,
		status: "running",
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	const controller = new AbortController();
	markTakenOver(child);
	const startCall = calls.length;
	const running = executeSubagent({
		narratorId: child,
		parentNarratorId: parent,
		toolUseId: "child-owning-tool",
		subagentType: "general",
		prompt: "start child real Await",
		cwd: process.cwd(),
		model: "openai:test-model",
		provider: "openai",
		locale: "en",
		signal: controller.signal,
		systemPrompt: "Test child runtime",
		initialHistory: [],
		customDef: null,
	});
	try {
		await until(
			() => listRunningAwaits().some((entry) => entry.narratorId === child),
			"child Await started",
		);
		const toolSignal = await childStarted.promise;
		const active = activeNarrators.get(child);
		const owner = getExecutionOwner(child);
		expect(active).toBeDefined();
		await queued("child older tool guidance", child);
		applySubagentBufferedQueueModeControl(child, "tool", true, true);
		expect(toolSignal.aborted).toBe(false);
		const selected = await queued("child selected urgent guidance", child);
		const response = await actualRoutes.request(`/${child}/buffer/${selected.id}/mode`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "interrupt" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, delivered: true });
		expect(toolSignal.aborted).toBe(true);
		expect((await childReturned.promise).metadata?.status).toBe("aborted");
		expect(active?.abortController.signal.aborted).toBe(false);
		expect(controller.signal.aborted).toBe(false);
		expect(isTakenOver(child)).toBe(true);
		const result = await running;
		expect(result.hasError).toBe(false);
		expect(result.aborted).toBe(false);
		expect(owner?.isCurrent()).toBe(false);
		expect(
			calls
				.slice(startCall)
				.map((text) => text.replace(/^<sender kind="(?:human|system)" \/>\n/, "")),
		).toEqual([
			"start child real Await",
			"child selected urgent guidance",
			"child older tool guidance",
		]);
		expect(getBufferedMessages(child)).toHaveLength(0);
	} finally {
		controller.abort();
		await running.catch(() => {});
		clearTakenOver(child);
	}
}, 10_000);

test("busy wake is retried until the indexed receipt is genuinely materialized", async () => {
	const input = await queued("busy wake receipt");
	let wakes = 0;
	const result = await waitForBufferedMessageDelivery(parent, input.id, {
		timeoutMs: 500,
		wake: async () => {
			if (++wakes === 2)
				sqlite.run(
					"UPDATE narrator_buffered_messages SET state = 'materialized', recipient_message_id = 'receipt-user' WHERE id = ?",
					[input.id],
				);
			return false;
		},
	});
	expect(wakes).toBe(2);
	expect(result).toEqual({ delivered: true, messageId: "receipt-user" });
});
