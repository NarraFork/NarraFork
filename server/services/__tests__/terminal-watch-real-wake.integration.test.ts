import { afterAll, afterEach, beforeEach, expect, type Mock, mock, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narrators,
	runtimePublicationOutbox,
	terminals,
} from "../../db/schema";
import { OpenAIProvider } from "../../lib/agent/openai-provider";
import type { AgentEvent, ToolContext } from "../../lib/agent/types";
import { resetUnsupportedParameterMemory } from "../../lib/agent/unsupported-parameter-fallback";
import { generateId } from "../../lib/id";
import { setOutboundFetchOverrideForTest } from "../../lib/net/outbound-fetch";
import { settings } from "../../lib/settings";
import { BufferManager } from "../../terminal/buffer-manager";
import type { TerminalReadObserver } from "../terminal-service";

// Only the outbound HTTP transport and PTY input source are fixtures. Provider
// selection, history projection, tools, instructions, publication and wake stay real.
const { db, sqlite } = await import("../../db");
interface WireRequest {
	raw: string;
	body: {
		model: string;
		stream: boolean;
		store: boolean;
		input: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>;
		tools?: Array<{
			type: string;
			name?: string;
			description?: string;
			parameters?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
		}>;
	};
}
const requests: WireRequest[] = [];
let buildHistorySpy: Mock<OpenAIProvider["buildHistory"]>;
let buffer: BufferManager;
const realTerminal = { ...(await import("../terminal-service")) };
mock.module("../terminal-service", () => ({
	...realTerminal,
	terminalService: {
		...realTerminal.terminalService,
		isAttached: () => true,
		getActiveBuffer: () => buffer,
		getScrollback: async (_id: string, observe?: TerminalReadObserver) => {
			const source = buffer;
			return {
				data: await source.getContents(
					observe ? (point, sequence) => observe(source, point, sequence) : undefined,
				),
				cols: source.cols,
				rows: source.rows,
			};
		},
		write: (_id: string, input: string) => emit(`${input.replace(/\n/g, "\r\n")}working\r\n`),
	},
}));
const { terminalTool, resetCursorForTerminal } = await import("../../lib/agent/tools/terminal");
const { watchTool } = await import("../../lib/agent/tools/watch");
const { backgroundTaskService } = await import("../background-task-service");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { drainQueuedMessagesAfterCompact } = await import("../compact-queue-drain");
const inbox = await import("../agent-runtime/inbox");
const { wakeInboxIfEligible } = inbox;
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const { runtimePublication } = await import("../agent-runtime/publication");
const { acceptUserMessage, interruptNarrator } = await import("../narrator-session");
const { activeNarrators, compactLocks } = await import("../narrator-session-state");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { narratorService } = await import("../narrator-service");
const executor = await import("../narrator-executor");
const { runSubagent } = await import("../subagent-runner");
const { activeWatchIds, notifyTerminalOutput } = await import("../terminal-watch-service");

let narratorId: string;
let terminalId: string;
let payload: string;
let childPrompt: string | undefined;
const spawnedChildren = new Set<string>();
const releaseGates: Array<() => void> = [];

async function until(predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await Bun.sleep(10);
	}
}
function emit(text: string): void {
	buffer.append(text);
	notifyTerminalOutput(terminalId);
}
function task() {
	return db
		.select()
		.from(backgroundTasks)
		.where(eq(backgroundTasks.parentNarratorId, narratorId))
		.limit(1)
		.get();
}
function notices() {
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(
			and(
				eq(narratorBufferedMessages.narratorId, narratorId),
				eq(narratorBufferedMessages.kind, "task_notice"),
			),
		)
		.limit(5)
		.all();
}
async function watch(): Promise<void> {
	const result = await watchTool.execute(
		{ type: "terminal", id: terminalId, pattern: "READY", timeout: 30_000 },
		{
			narratorId,
			signal: new AbortController().signal,
			currentToolUseId: `watch-call-${terminalId}`,
		} as ToolContext,
	);
	expect(result.isError).toBeFalsy();
	expect(result.output).toContain("Watching terminal");
	expect(task()?.toolUseId).toBe(`watch-call-${terminalId}`);
}
async function waitForAdoption(expectedRequests: number): Promise<void> {
	try {
		await until(
			() =>
				requests.length === expectedRequests &&
				!getExecutionOwner(narratorId) &&
				db
					.select({ status: narrators.status })
					.from(narrators)
					.where(eq(narrators.id, narratorId))
					.get()?.status === "idle" &&
				notices()[0]?.adoptedAt != null,
			"watch completion reaches the provider and run releases ownership",
		);
	} catch (cause) {
		const notice = notices()[0];
		const outbox = db
			.select({ id: runtimePublicationOutbox.id })
			.from(runtimePublicationOutbox)
			.limit(5)
			.all();
		throw new Error(
			`Watch chain stalled: task=${task()?.status}, outbox=${outbox.length}, ` +
				`inbox=${notice?.state}, adopted=${notice?.adoptedAt ?? "no"}, ` +
				`providerRequests=${requests.length}, owner=${!!getExecutionOwner(narratorId)}`,
			{ cause },
		);
	}
}
async function assertAdoptedOnce(producerKind: "bash" | "agent" = "bash"): Promise<void> {
	const source = task();
	expect(source?.status).toBe("completed");
	expect(source?.output).toContain(payload);
	const delivered = notices();
	expect(delivered).toHaveLength(1);
	const notice = delivered[0];
	const recipientMessageId = notice.recipientMessageId;
	if (!recipientMessageId) throw new Error("Adopted notice has no recipient message identity");
	// Adoption releases the mailbox payload/metadata; its durable dedupe identity
	// survives and still binds this receipt to the exact task and logical run.
	expect(JSON.parse(notice.dedupeKey ?? "[]")).toEqual([
		"publication",
		producerKind,
		source?.id,
		source?.logicalRunId,
		"completed",
		narratorId,
	]);
	expect(notice.state).toBe("materialized");
	expect(notice.deliveryId).toBeTruthy();
	expect(notice.adoptedAt).not.toBeNull();
	expect(notice.currentAdoptedAt).not.toBeNull();
	const refs = db
		.select()
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, recipientMessageId),
			),
		)
		.limit(2)
		.all();
	expect(refs).toHaveLength(1);
	expect(refs[0].injectionConsumedAt).not.toBeNull();
	const history = await narratorService.getModelHistorySinceLastCompact(narratorId);
	const persistedNotice = history.filter((row) => row.id === recipientMessageId);
	expect(persistedNotice).toHaveLength(1);
	expect(persistedNotice[0].contentText).toContain(payload);
	expect(persistedNotice[0].contentJson).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "system_injection",
				modelText: expect.stringContaining(payload),
			}),
		]),
	);
	// Observe only builders invoked by the real run; never rebuild history just to
	// manufacture a replay receipt. Each actual projection carries the notice once.
	const noticeBuilds = buildHistorySpy.mock.results.filter((_, index) => {
		const [rows, , builtNarratorId] = buildHistorySpy.mock.calls[index];
		return builtNarratorId === narratorId && rows.some((row) => row.id === recipientMessageId);
	});
	expect(noticeBuilds.length).toBeGreaterThan(0);
	for (const result of noticeBuilds) {
		expect(result.type).toBe("return");
		if (result.type !== "return") throw new Error("The real history builder did not return");
		const built = await result.value;
		expect(built.replayedInjectionMessageIds?.filter((id) => id === recipientMessageId)).toEqual([
			recipientMessageId,
		]);
	}
	// Count occurrences, not requests containing the sentinel: duplicate lanes in
	// one serialized request must fail too. The fixture response never echoes it.
	expect(
		requests.reduce((count, request) => count + request.raw.split(payload).length - 1, 0),
	).toBe(1);
	const payloadParts = requests.flatMap(({ body }) => {
		expect(body).toMatchObject({ model: "gpt-5.5", stream: true, store: false });
		expect(body).not.toHaveProperty("instructions");
		const prefix = body.input[0];
		expect(prefix.role).toBe("developer");
		expect(prefix.content?.[0]?.text?.trim()).toBeTruthy();
		expect(JSON.stringify(prefix)).not.toContain(payload);
		const read = body.tools?.find((tool) => tool.type === "function" && tool.name === "Read");
		expect(read?.description?.length).toBeGreaterThan(0);
		expect(read?.parameters).toMatchObject({
			type: "object",
			properties: { file_path: expect.any(Object) },
			required: expect.arrayContaining(["file_path"]),
		});
		expect(Array.isArray(body.input)).toBe(true);
		return body.input.flatMap((item) =>
			(item.content ?? [])
				.filter((part) => part.text?.includes(payload))
				.map((part) => ({ role: item.role, ...part })),
		);
	});
	expect(payloadParts).toHaveLength(1);
	expect(payloadParts[0]).toMatchObject({
		role: "user",
		type: "input_text",
		text: expect.stringContaining(payload),
	});
	expect(
		db.select({ id: runtimePublicationOutbox.id }).from(runtimePublicationOutbox).limit(1).all(),
	).toEqual([]);
}

beforeEach(async () => {
	if (narratorId && getExecutionOwner(narratorId)) {
		throw new Error("Previous diagnostic run is still active; refusing to clear its database");
	}
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	backgroundOccupancyStore.resetForTests();
	await backgroundOccupancyStore.start();
	requests.length = 0;
	childPrompt = undefined;
	spawnedChildren.clear();
	resetUnsupportedParameterMemory();
	// The preload restores this in-memory branch between cases; never save or
	// reload settings, which could touch a real configuration file.
	expect(settings.openaiProviders?.some((config) => config.prefix === "watch-wire")).not.toBe(true);
	settings.openaiProviders = [
		{
			id: "watchwir",
			name: "Watch wire fixture",
			prefix: "watch-wire",
			apiKey: "unused",
			baseUrl: "https://watch-wire.invalid/v1",
			defaultModel: "gpt-5.5",
			apiMode: "responses",
		},
	];
	buildHistorySpy = spyOn(OpenAIProvider.prototype, "buildHistory");
	setOutboundFetchOverrideForTest(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== "https://watch-wire.invalid/v1/responses") {
			throw new Error(`Unexpected outbound request: ${url}`);
		}
		expect(init?.method).toBe("POST");
		expect(typeof init?.body).toBe("string");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.signal?.aborted).toBe(false);
		if (typeof init?.body !== "string") throw new Error("Expected a serialized Responses body");
		requests.push({ raw: init.body, body: JSON.parse(init.body) });
		const text =
			childPrompt && init.body.includes(childPrompt) ? payload : "watch notification received";
		return new Response(
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
				'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	});
	narratorId = generateId();
	terminalId = generateId();
	payload = `watch-output-payload:${generateId()}`;
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({
			id: narratorId,
			title: "watch chain diagnostic",
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model: "watch-wire:gpt-5.5",
			runtimeRegistrationJson: {
				version: 1,
				run: { logicalRunId: `initial-${narratorId}`, principal: { userId: null } },
			},
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			status: "idle",
			cwd: process.env.HOME,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(terminals)
		.values({ id: terminalId, narratorId, name: "watch input", status: "running", createdAt: now })
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
	await backgroundOccupancyStore.flush();
	buffer = new BufferManager(terminalId, 100, 24);
	emit("$ ");
});
afterEach(async () => {
	for (const release of releaseGates.splice(0)) release();
	compactLocks.delete(narratorId);
	resetCursorForTerminal(terminalId);
	for (const id of activeWatchIds(terminalId)) await backgroundTaskService.cancel(id);
	for (const id of [narratorId, ...spawnedChildren]) {
		const active = activeNarrators.get(id);
		if (active) {
			active.alive = false;
			active.abortController.abort();
			if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
		}
	}
	// Never close the worker or clear history underneath an unfinished run, even
	// on a failing assertion. Releasing gates and aborting precede this barrier.
	await until(
		() => [narratorId, ...spawnedChildren].every((id) => !getExecutionOwner(id)),
		"test runs shut down",
	);
	for (const id of [narratorId, ...spawnedChildren]) activeNarrators.delete(id);
	// Keep the HTTP seam and transparent spy installed until the real run stops.
	setOutboundFetchOverrideForTest(null);
	mock.restore();
	resetUnsupportedParameterMemory();
	await closePrefixSnapshotStore();
	await buffer.dispose(true);
	await backgroundOccupancyStore.flush();
	cleanDb(sqlite);
	// This file's cleanup precedes preload's settings reset, including on failure.
	expect(settings.openaiProviders?.some((config) => config.prefix === "watch-wire")).toBe(true);
});
afterAll(async () => {
	// Teardown only: no test stops/flushes the worker or substitutes its real wake.
	runtimePublication.stop();
	backgroundOccupancyStore.resetForTests();
	await closePrefixSnapshotStore();
	mock.module("../terminal-service", () => realTerminal);
	mock.restore();
});

test("ordinary appended output automatically reaches a real idle run's model input", async () => {
	await watch();
	emit(`working\r\nREADY ${payload}\r\n$ `);
	await waitForAdoption(1);
	await assertAdoptedOnce();
}, 10_000);

test.each([
	"read",
	"write",
] as const)("completion between %s and watch automatically reaches the real model", async (action) => {
	const observed = await terminalTool.execute(
		{ action, terminal_id: terminalId, ...(action === "write" ? { input: "deploy\n" } : {}) },
		{ narratorId, signal: new AbortController().signal } as ToolContext,
	);
	expect(observed.isError).toBeFalsy();
	emit(`READY ${payload}\r\n$ `);
	await buffer.flush();
	await watch();
	await waitForAdoption(1);
	await assertAdoptedOnce();
}, 10_000);

test("watch completion during run finalization automatically survives owner handoff", async () => {
	await watch();
	const updateStatus = narratorService.updateStatus.bind(narratorService);
	const gate = Promise.withResolvers<void>();
	releaseGates.push(gate.resolve);
	let injected = false;
	spyOn(narratorService, "updateStatus").mockImplementation(async (...args) => {
		const result = await updateStatus(...args);
		if (args[0] === narratorId && args[1] === "idle" && !injected) {
			injected = true;
			expect(getExecutionOwner(narratorId)).toBeDefined();
			emit(`READY ${payload}\r\n$ `);
			await until(() => notices().length === 1, "automatic publication while old owner exists");
			expect(notices()[0].state).toBe("queued");
			expect(await wakeInboxIfEligible(narratorId)).toBe(false);
			await gate.promise;
		}
		return result;
	});
	await acceptUserMessage(narratorId, "finish the original task");
	await until(() => injected && notices().length === 1, "finalization gate entered");
	expect(requests).toHaveLength(1);
	gate.resolve();
	await waitForAdoption(2);
	await assertAdoptedOnce();
}, 10_000);

function injectCleanupFailure(
	outcome: "workspace-restart" | "error" | "user-interrupt",
	beforeFailure?: () => Promise<void>,
): () => boolean {
	const execute = executor.executeAgentLoop;
	let cleanedUp = false;
	spyOn(executor, "executeAgentLoop").mockImplementationOnce(async (options) => {
		// Exercise the real executor/event handler and onErrorCleanup, not a
		// fabricated ExecuteLoopResult or a database edit. Only this first pass's
		// provider event source is injected, avoiding transport retry backoff.
		const result = await execute(options, {
			eventSource: (async function* (): AsyncGenerator<AgentEvent> {
				await beforeFailure?.();
				if (outcome === "user-interrupt") {
					expect(interruptNarrator(narratorId)).toBe(true);
					yield { type: "error", message: "Aborted" };
					return;
				}
				yield {
					type: "error",
					message: "HTTP 408: request timeout before workspace rebuild",
					diagnostics: {
						schema: "narrafork.error-diagnostics.v1",
						source: "provider",
						statusCode: 408,
					},
				};
			})(),
		});
		const failed = await narratorService.getById(narratorId);
		if (outcome === "user-interrupt") {
			expect(result.aborted).toBe(true);
			expect(failed.substatus).toContain("interrupted");
		} else {
			expect(result.hasError).toBe(true);
			expect(failed.substatus).toContain("error");
			expect(failed.errorMessage).toContain("HTTP 408");
		}
		cleanedUp = true;
		if (outcome === "workspace-restart") {
			const active = activeNarrators.get(narratorId);
			if (!active) throw new Error("The failing pass lost its active session");
			// This is the existing, independently authorized restart decision.
			// The test never clears a failure flag or changes the persisted status.
			active._workspacePassInvalidated = true;
		}
		return result;
	});
	return () => cleanedUp;
}

async function completeSource(source: "watch" | "agent"): Promise<void> {
	if (source === "watch") {
		await watch();
		emit(`READY ${payload}\r\n$ `);
		return;
	}
	childPrompt = `finish-background-work-${generateId()}`;
	const cwd = process.env.HOME;
	if (!cwd) throw new Error("The test preload must provide an isolated HOME");
	await runSubagent({
		parentNarratorId: narratorId,
		toolUseId: `agent-call-${terminalId}`,
		subagentType: "general",
		prompt: childPrompt,
		cwd,
		title: "real wake child",
		model: "watch-wire:gpt-5.5",
		background: true,
		signal: new AbortController().signal,
		locale: "en",
		onCreated: (id) => spawnedChildren.add(id),
	});
}

for (const source of ["watch", "agent"] as const) {
	for (const arrival of ["idle", "owner-release"] as const) {
		test(`${source} completion after HTTP408 cleanup and a legal successful pass automatically wakes at ${arrival}`, async () => {
			const cleanedUp = injectCleanupFailure("workspace-restart");
			let injected = false;
			const gate = Promise.withResolvers<void>();
			releaseGates.push(gate.resolve);
			if (arrival === "owner-release") {
				const updateStatus = narratorService.updateStatus.bind(narratorService);
				spyOn(narratorService, "updateStatus").mockImplementation(async (...args) => {
					const result = await updateStatus(...args);
					if (args[0] === narratorId && args[1] === "idle" && requests.length === 1 && !injected) {
						injected = true;
						expect(getExecutionOwner(narratorId)).toBeDefined();
						await completeSource(source);
						await until(() => notices().length === 1, "completion published before owner release");
						expect(notices()[0].state).toBe("queued");
						expect(notices()[0].adoptedAt).toBeNull();
						await gate.promise;
					}
					return result;
				});
			}
			await acceptUserMessage(narratorId, "finish the task after rebuilding workspace context");
			if (arrival === "idle") {
				await until(
					() => cleanedUp() && requests.length === 1 && !getExecutionOwner(narratorId),
					"legal recovery pass finishes before asynchronous completion",
				);
				const recovered = await narratorService.getById(narratorId);
				expect(recovered.status).toBe("idle");
				expect(recovered.substatus).not.toContain("error");
				expect(recovered.errorMessage).toBeNull();
				await completeSource(source);
			} else {
				await until(
					() => injected && notices().length === 1,
					"recovered pass reaches owner-release window",
				);
				expect(cleanedUp()).toBe(true);
				gate.resolve();
			}
			// No wakeInboxIfEligible rescue: publication and owner-release must
			// drive the same genuine unified inbox through a fresh model run.
			await waitForAdoption(source === "watch" ? 2 : 3);
			await assertAdoptedOnce(source === "watch" ? "bash" : "agent");
			const final = await narratorService.getById(narratorId);
			expect(final.lastStopReason).toBe("normal");
			expect(final.errorMessage).toBeNull();
		}, 15_000);
	}
}

for (const source of ["watch", "agent"] as const) {
	test(`${source} completion already queued before failure cannot authorize a recovery pass`, async () => {
		const cleanedUp = injectCleanupFailure("error", async () => {
			await completeSource(source);
			await until(() => notices().length === 1, "completion is queued before the provider fails");
			expect(getExecutionOwner(narratorId)).toBeDefined();
			expect(notices()[0].state).toBe("queued");
			expect(notices()[0].adoptedAt).toBeNull();
		});
		await acceptUserMessage(
			narratorId,
			"a queued notice is not permission to retry my failed task",
		);
		await until(
			() => cleanedUp() && !getExecutionOwner(narratorId),
			"unrecovered failure releases its owner without consuming the notice",
		);
		const stopped = await narratorService.getById(narratorId);
		expect(stopped.status).toBe("idle");
		expect(stopped.lastStopReason).toBe("error");
		expect(stopped.substatus).toContain("error");
		expect(stopped.errorMessage).toContain("HTTP 408");
		expect(task()?.status).toBe("completed");
		expect(notices()).toHaveLength(1);
		expect(notices()[0].state).toBe("queued");
		expect(notices()[0].adoptedAt).toBeNull();
		// The only HTTP request allowed here is the background child's request.
		expect(requests).toHaveLength(source === "watch" ? 0 : 1);
	}, 15_000);
}

for (const outcome of ["error", "user-interrupt"] as const) {
	for (const source of ["watch", "agent"] as const) {
		test(`${source} completion cannot automatically retry a genuine ${outcome} ending`, async () => {
			const cleanedUp = injectCleanupFailure(outcome);
			await acceptUserMessage(narratorId, "finish without an authorized continuation");
			await until(
				() => cleanedUp() && !getExecutionOwner(narratorId),
				"terminal failure releases its owner",
			);
			const stopped = await narratorService.getById(narratorId);
			expect(stopped.lastStopReason).toBe(outcome === "error" ? "error" : "user_interrupt");
			let checkedNotice = false;
			const realWake = inbox.wakeInboxIfEligible;
			spyOn(inbox, "wakeInboxIfEligible").mockImplementation(async (...args) => {
				const started = await realWake(...args);
				if (args[0] === narratorId && notices().length === 1) {
					expect(started).toBe(false);
					checkedNotice = true;
				}
				return started;
			});
			await completeSource(source);
			// Observe the genuine publication-triggered eligibility check finishing;
			// do not call the wake ourselves or rely on a sleep to infer rejection.
			await until(() => checkedNotice, "automatic inbox wake rejects the terminal failure");
			expect(task()?.status).toBe("completed");
			expect(notices()).toHaveLength(1);
			expect(notices()[0].state).toBe("queued");
			expect(notices()[0].adoptedAt).toBeNull();
			expect(getExecutionOwner(narratorId)).toBeUndefined();
			expect(requests).toHaveLength(source === "watch" ? 0 : 1);
			const stillStopped = await narratorService.getById(narratorId);
			expect(stillStopped.substatus).toEqual(stopped.substatus);
			expect(stillStopped.errorMessage).toBe(stopped.errorMessage);
			expect(stillStopped.lastStopReason).toBe(stopped.lastStopReason);
		}, 15_000);
	}
}

async function completeWhileCompacting(): Promise<void> {
	compactLocks.set(narratorId, {
		kind: "history",
		mode: "background",
		promise: Promise.resolve({ kind: "history", compacted: true, mode: "background" }),
	});
	await watch();
	emit(`READY ${payload}\r\n$ `);
	await until(() => notices().length === 1, "publication reaches compact-locked inbox");
	expect(task()?.status).toBe("completed");
	expect(notices()[0].state).toBe("queued");
	expect(notices()[0].adoptedAt).toBeNull();
	expect(requests).toEqual([]);
	// Await the genuine eligibility check to complete before releasing the lock,
	// otherwise its deferred microtask could make this a false-positive recovery.
	expect(await wakeInboxIfEligible(narratorId)).toBe(false);
	compactLocks.delete(narratorId);
}

test("diagnostic control: a queued watch notice can run through the real wake after compact", async () => {
	await completeWhileCompacting();
	expect(await wakeInboxIfEligible(narratorId)).toBe(true);
	await waitForAdoption(1);
	await assertAdoptedOnce();
}, 10_000);

test("compact lock-release drain automatically wakes an already completed watch", async () => {
	await completeWhileCompacting();
	await drainQueuedMessagesAfterCompact(narratorId);
	// Deliberately no manual wake rescue: a failure here is an unresolved automatic
	// recovery defect, not a successful diagnostic control.
	await waitForAdoption(1);
	await assertAdoptedOnce();
}, 10_000);
