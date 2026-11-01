/**
 * Run relationship contract, run for a delegated session and for a session without a
 * parent that registered the same destination. Behaviour follows only from the run's
 * registration (deliverTo, cancelWith, principal, deadline), never from how the session
 * was created:
 *  1. caller cancellation reaches only its registered run;
 *  2. detach hands the caller back without restarting the run or its deadline;
 *  3. a hold (takeover) makes Stop end the current turn only, and the run continues;
 *  4. the terminal is published exactly once;
 *  5. recovery after a restart re-enters the same logical run with one execution owner;
 *  6. a Send is visible at consecutive tool boundaries without changing who executes.
 * Only the model pass is scripted; run service, orchestrator and publication are real.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	runtimePublicationOutbox,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";

// The snapshot worker shares the preload-isolated file-backed database.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const executor = await import("../narrator-executor");
const { cancelRunsBoundTo, controlRun, startNarratorRun } = await import("../agent-runtime/run");
const { getExecutionOwner, getRunControl, getRunHold, listRuns, setRunHold } = await import(
	"../agent-runtime/ownership"
);
const inbox = await import("../agent-runtime/inbox");
const session = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { createAgentMessageDelivery } = await import("../agent-message-delivery");

const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Contract must never call a model");
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "test" ? provider : null),
	listReadiness: () => [],
});

const CALLER = "contract-caller";
const OTHER = "contract-other-caller";
const RUN = "contract-run-session";
const SIBLING = "contract-sibling-session";
const ORIGIN = "origin-call";
const ORIGIN_ROW = "origin-row";
const NOW = "2026-09-30T00:00:00.000Z";
const ids = [CALLER, OTHER, RUN, SIBLING];
let cwd: string;
let seq = 0;

const shapes: Array<{
	name: string;
	row: (
		parent: string,
	) => Pick<typeof narrators.$inferInsert, "type" | "variant" | "parentNarratorId">;
}> = [
	{
		name: "delegated session",
		row: (parent) => ({ type: "subagent", variant: "subagent:general", parentNarratorId: parent }),
	},
	{ name: "session without a parent", row: () => ({ type: "primary", variant: "primary" }) },
];
type Shape = (typeof shapes)[number];

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	seq = 0;
	settings.agent.autoContinuationMode = "off";
	cwd = mkdtempSync(join(tmpdir(), "nf-run-contract-"));
});
afterEach(async () => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
		setRunHold(id, undefined);
	}
	mock.restore();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	rmSync(cwd, { recursive: true, force: true });
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	unregisterProvider();
});

function callerCall(narratorId: string, toolUseId: string, toolCallId: string) {
	db.insert(narratorMessages)
		.values({
			id: `${toolCallId}-message`,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Agent", input: {} }],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `${toolCallId}-ref`,
			narratorId,
			messageId: `${toolCallId}-message`,
			seq: seq++,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId: `${toolCallId}-message`,
			toolUseId,
			toolName: "Agent",
			inputJson: {},
			outputJson: "PENDING",
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			createdAt: NOW,
		})
		.run();
}

function seed(shape: Shape) {
	db.insert(narrators)
		.values([
			{ id: CALLER, variant: "primary", cwd, createdAt: NOW, updatedAt: NOW },
			{ id: OTHER, variant: "primary", cwd, createdAt: NOW, updatedAt: NOW },
			...[RUN, SIBLING].map((id): typeof narrators.$inferInsert => ({
				id,
				...shape.row(CALLER),
				cwd,
				status: "idle",
				model: "test:model",
				autoContinuationOverride: "off",
				createdAt: NOW,
				updatedAt: NOW,
			})),
		])
		.run();
	callerCall(CALLER, ORIGIN, ORIGIN_ROW);
	callerCall(OTHER, "other-origin", "other-origin-row");
}

const binding = (
	deliverTo: { narratorId: string; toolUseId: string; toolCallId: string },
	extra: Record<string, unknown> = {},
) => ({
	deliverTo: { ...deliverTo, attempt: 1 },
	cancelWith: { narratorId: deliverTo.narratorId, toolCallId: deliverTo.toolCallId, attempt: 1 },
	principal: { userId: null },
	...extra,
});
const runBinding = (extra: Record<string, unknown> = {}) =>
	binding({ narratorId: CALLER, toolUseId: ORIGIN, toolCallId: ORIGIN_ROW }, extra);

/** A scripted model pass: optionally blocks until released, then replies. */
function scriptPasses(
	steps: Array<(options: ExecuteLoopOptions) => Promise<Partial<ExecuteLoopResult> | undefined>>,
) {
	const calls: ExecuteLoopOptions[] = [];
	const spy = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
		calls.push(options);
		const step = steps[calls.length - 1];
		const result = (step ? await step(options) : undefined) ?? {};
		const finalText = result.finalText ?? `reply ${calls.length}`;
		if (!options.config.signal?.aborted) {
			const id = `reply-${options.config.narratorId}-${calls.length}`;
			db.insert(narratorMessages)
				.values({
					id,
					narratorId: options.config.narratorId,
					role: "assistant",
					contentText: finalText,
					contentJson: [{ type: "text", text: finalText }],
					parentToolUseId: ORIGIN,
					createdAt: NOW,
				})
				.run();
			db.insert(narratorMessageRefs)
				.values({
					id: `ref-${id}`,
					narratorId: options.config.narratorId,
					messageId: id,
					seq: seq++,
				})
				.run();
		}
		return { finalText, hasError: false, shouldUpdateTitle: false, ...result } as ExecuteLoopResult;
	});
	return { calls, spy };
}

const toolOutput = (id = ORIGIN_ROW) =>
	db.select().from(narratorToolCalls).where(eq(narratorToolCalls.id, id)).get()?.outputJson;
const terminalRows = (logicalRunId: string | undefined) =>
	db
		.select()
		.from(runtimePublicationOutbox)
		.where(eq(runtimePublicationOutbox.logicalRunId, logicalRunId ?? ""))
		.all()
		.filter((row) => row.eventKind !== "started");

async function settle(condition: () => boolean) {
	for (let i = 0; i < 300 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(condition()).toBe(true);
}

for (const shape of shapes) {
	describe(shape.name, () => {
		test("1. caller cancellation reaches only the run registered to that caller attempt", async () => {
			seed(shape);
			const siblingGate = Promise.withResolvers<void>();
			spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
				if (options.config.narratorId === SIBLING) {
					await siblingGate.promise;
					return { finalText: "sibling finished", hasError: false, shouldUpdateTitle: false };
				}
				// The target waits until its own turn is aborted by its caller.
				await new Promise<void>((resolve) => {
					if (options.config.signal?.aborted) resolve();
					options.config.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return {
					finalText: "",
					hasError: false,
					shouldUpdateTitle: false,
					aborted: true,
				} as ExecuteLoopResult;
			});
			const caller = new AbortController();
			const target = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding(),
				cancelSignal: caller.signal,
				foreground: true,
			});
			await settle(() => !!getRunControl(RUN)?.logicalRunId);
			const sibling = await startNarratorRun({
				narratorId: SIBLING,
				locale: "en",
				text: "work",
				binding: binding({
					narratorId: OTHER,
					toolUseId: "other-origin",
					toolCallId: "other-origin-row",
				}),
				foreground: true,
			});
			await settle(() => !!getRunControl(SIBLING)?.logicalRunId);
			caller.abort("caller interrupted");
			const ended = await target.foreground;
			expect(ended.interrupted).toBe(true);
			// The unrelated run keeps going, untouched; nothing else is bound to that caller.
			expect(getRunControl(SIBLING)?.cancel.signal.aborted).toBe(false);
			expect(cancelRunsBoundTo(CALLER, "again")).toBe(0);
			siblingGate.resolve();
			expect((await sibling.terminal).finalText).toContain("sibling finished");
		});

		test("2. detach hands the caller back; the same run continues with its deadline", async () => {
			seed(shape);
			const gate = Promise.withResolvers<void>();
			scriptPasses([
				async () => {
					await gate.promise;
					return { finalText: "finished after detach" };
				},
			]);
			const deadlineAt = new Date(Date.now() + 60_000).toISOString();
			const handle = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding({ deadlineAt }),
				foreground: true,
			});
			await settle(() => !!getRunControl(RUN)?.logicalRunId);
			const run = getRunControl(RUN);
			const logicalRunId = run?.logicalRunId;
			expect(await controlRun(RUN, { kind: "detach" })).toBe(true);
			const handoff = await handle.foreground;
			expect(handoff.handoff).toBe(true);
			// Same run, same owner, same deadline: nothing restarted.
			expect(getRunControl(RUN)).toBe(run);
			expect(getRunControl(RUN)?.deadlineAt).toBe(deadlineAt);
			const registration = db.select().from(narrators).where(eq(narrators.id, RUN)).get();
			expect(registration?.logicalRunId).toBe(logicalRunId);
			gate.resolve();
			expect((await handle.terminal).finalText).toContain("finished after detach");
		});

		test("2b. after a detach the caller's interrupt no longer cancels the run", async () => {
			seed(shape);
			const gate = Promise.withResolvers<void>();
			scriptPasses([
				async () => {
					await gate.promise;
					return { finalText: "finished despite caller abort" };
				},
			]);
			const caller = new AbortController();
			const handle = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding(),
				cancelSignal: caller.signal,
				foreground: true,
			});
			await settle(() => !!getRunControl(RUN)?.logicalRunId);
			const run = getRunControl(RUN);
			expect(await controlRun(RUN, { kind: "detach" })).toBe(true);
			const handoff = await handle.foreground;
			expect(handoff.handoff).toBe(true);
			const alias = /<background_task_id>([^<]+)<\/background_task_id>/.exec(handoff.output)?.[1];
			expect(alias).toBeTruthy();
			expect(handoff.output).toContain(`Await({ type: "agent", id: "${alias}" })`);
			// The caller's turn ends after the handoff: that interrupt is not the run's.
			caller.abort("caller turn interrupted");
			expect(run?.cancel.signal.aborted).toBe(false);
			expect(cancelRunsBoundTo(CALLER, "caller stopped")).toBe(0);
			gate.resolve();
			const terminal = await handle.terminal;
			expect(terminal.interrupted).toBe(false);
			expect(terminal.hasError).toBe(false);
			expect(terminal.finalText).toContain("finished despite caller abort");
			// The detached result is delivered through the task row.
			await settle(
				() =>
					db.select().from(backgroundTasks).where(eq(backgroundTasks.id, RUN)).get()?.status ===
					"completed",
			);
			const task = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, RUN)).get();
			expect(task?.alias).toBe(alias);
			expect(String(task?.output)).toContain("finished despite caller abort");
		});

		test("3. during a hold, Stop ends only the current turn and the run continues", async () => {
			seed(shape);
			const gate = Promise.withResolvers<void>();
			const { calls } = scriptPasses([
				async (options) => {
					await new Promise<void>((resolve) => {
						options.config.signal?.addEventListener("abort", () => resolve(), { once: true });
						gate.promise.then(resolve);
					});
					return { finalText: "stopped", aborted: true };
				},
				async () => ({ finalText: "continued turn" }),
			]);
			await controlRun(RUN, { kind: "hold" });
			const handle = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding(),
			});
			await settle(() => calls.length === 1);
			expect(await controlRun(RUN, { kind: "stop" })).toBe(true);
			// Parked at the hold, same owner; the caller has received nothing.
			await settle(() => !!getRunControl(RUN)?.wake);
			expect(getRunHold(RUN)).toBeDefined();
			expect(toolOutput()).toBe("PENDING");
			await session.acceptUserMessage(RUN, "carry on", { locale: "en", userId: null });
			await settle(() => calls.length === 2);
			await controlRun(RUN, { kind: "release" });
			expect((await handle.terminal).finalText).toContain("continued turn");
		});

		test("4. the terminal is published exactly once, to the registered call", async () => {
			seed(shape);
			scriptPasses([async () => ({ finalText: "the answer" })]);
			const handle = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding(),
			});
			const terminal = await handle.terminal;
			await settle(() => String(toolOutput()).includes("the answer"));
			expect(String(toolOutput()).match(/the answer/g)).toHaveLength(1);
			expect(toolOutput("other-origin-row")).toBe("PENDING");
			const rows = terminalRows(terminal.logicalRunId);
			expect(rows.filter((row) => row.state !== "reserved")).toHaveLength(1);
			expect(rows.filter((row) => row.state === "reserved")).toHaveLength(0);
		});

		test("5. recovery re-enters the same logical run with a single execution owner", async () => {
			seed(shape);
			const gate = Promise.withResolvers<void>();
			scriptPasses([
				async () => ({ finalText: "first life" }),
				async () => {
					await gate.promise;
					return { finalText: "recovered answer" };
				},
			]);
			const first = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding(),
				deliver: false,
			});
			const logicalRunId = (await first.terminal).logicalRunId;
			// After a restart only the durable row is left; recovery continues that run.
			activeNarrators.delete(RUN);
			const recovered = await session.continueNarrator(RUN, "en", false, undefined, {
				resumeRunId: logicalRunId,
				recovered: true,
			});
			expect(recovered.ok).toBe(true);
			await settle(() => !!getRunControl(RUN));
			// A second recovery attempt cannot mount a second owner.
			const second = await session.continueNarrator(RUN, "en", false, undefined, {
				resumeRunId: logicalRunId,
				recovered: true,
			});
			expect(second.ok).toBe(false);
			expect(listRuns().filter((run) => run.narratorId === RUN)).toHaveLength(1);
			expect(getRunControl(RUN)?.logicalRunId).toBe(logicalRunId);
			// The recovered run is still bound to its original caller's cancellation.
			await settle(() => !!getRunControl(RUN)?.cancelWith);
			expect(getRunControl(RUN)?.cancelWith).toMatchObject({
				narratorId: CALLER,
				toolCallId: ORIGIN_ROW,
				attempt: 1,
			});
			const recoveredRun = getRunControl(RUN);
			expect(cancelRunsBoundTo(OTHER, "unrelated caller stopped")).toBe(0);
			expect(cancelRunsBoundTo(CALLER, "caller stopped")).toBe(1);
			expect(recoveredRun?.cancel.signal.aborted).toBe(true);
			gate.resolve();
			await recovered.terminal;
			await settle(() => !getExecutionOwner(RUN));
			expect(db.select().from(narrators).where(eq(narrators.id, RUN)).get()?.logicalRunId).toBe(
				logicalRunId,
			);
		});

		test("6. a Send is visible at consecutive tool boundaries and never changes who executes", async () => {
			seed(shape);
			const seen: Array<string | undefined> = [];
			let principal: string | null | undefined = "unset";
			const send = async (text: string) => {
				const id = `send-${seq++}`;
				db.insert(narratorMessages)
					.values({ id, narratorId: OTHER, role: "assistant", contentJson: [], createdAt: NOW })
					.run();
				db.insert(narratorToolCalls)
					.values({
						id: `${id}-call`,
						narratorId: OTHER,
						messageId: id,
						toolUseId: `${id}-use`,
						toolName: "Send",
						status: "running",
						executionAttempt: 1,
						executionIdentityVersion: 1,
						createdAt: NOW,
					})
					.run();
				db.insert(fileChangeExecutionSegments)
					.values({
						id: `${id}-segment`,
						narratorId: OTHER,
						sourceToolCallId: `${id}-call`,
						sourceExecutionAttempt: 1,
						createdAt: NOW,
					})
					.run();
				const value = createAgentMessageDelivery(
					RUN,
					{ id: OTHER, title: "Other", label: "other", type: "general", isParent: false },
					`${id}-use`,
					text,
					{ toolCallId: `${id}-call`, attempt: 1 },
				);
				await inbox.enqueueInboxAgent(value, value.text, {
					userId: "sender-user",
					createdBy: null,
				});
			};
			const text = (value: unknown) =>
				typeof value === "string" ? value : (value as { text?: string } | undefined)?.text;
			scriptPasses([
				async (options) => {
					await send("first report");
					const a = await options.config.getAfterToolsInjections?.();
					seen.push(text(a));
					if (a && typeof a !== "string") a.onConsumed?.();
					await send("second report");
					const b = await options.config.getAfterToolsInjections?.();
					seen.push(text(b));
					if (b && typeof b !== "string") b.onConsumed?.();
					principal = options.config.userId;
					return { finalText: "done" };
				},
			]);
			const handle = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding(),
				deliver: false,
			});
			await handle.terminal;
			expect(seen[0]).toContain("first report");
			expect(seen[0]).not.toContain("second report");
			expect(seen[1]).toContain("second report");
			// The run's principal is its own registration (anonymous), never the sender's.
			expect(principal ?? null).toBeNull();
		});

		test("6b. several Sends queued before one boundary are adopted together, in FIFO order", async () => {
			seed(shape);
			let seen: string | undefined;
			const send = async (text: string) => {
				const id = `send-${seq++}`;
				db.insert(narratorMessages)
					.values({ id, narratorId: OTHER, role: "assistant", contentJson: [], createdAt: NOW })
					.run();
				db.insert(narratorToolCalls)
					.values({
						id: `${id}-call`,
						narratorId: OTHER,
						messageId: id,
						toolUseId: `${id}-use`,
						toolName: "Send",
						status: "running",
						executionAttempt: 1,
						executionIdentityVersion: 1,
						createdAt: NOW,
					})
					.run();
				db.insert(fileChangeExecutionSegments)
					.values({
						id: `${id}-segment`,
						narratorId: OTHER,
						sourceToolCallId: `${id}-call`,
						sourceExecutionAttempt: 1,
						createdAt: NOW,
					})
					.run();
				const value = createAgentMessageDelivery(
					RUN,
					{ id: OTHER, title: "Other", label: "other", type: "general", isParent: false },
					`${id}-use`,
					text,
					{ toolCallId: `${id}-call`, attempt: 1 },
				);
				await inbox.enqueueInboxAgent(value, value.text, { createdBy: null, userId: null });
			};
			scriptPasses([
				async (options) => {
					await send("alpha report");
					await send("beta report");
					await send("gamma report");
					const packet = await options.config.getAfterToolsInjections?.();
					seen = typeof packet === "string" ? packet : packet?.text;
					if (packet && typeof packet !== "string") packet.onConsumed?.();
					return { finalText: "done" };
				},
			]);
			const handle = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				binding: runBinding(),
				deliver: false,
			});
			await handle.terminal;
			const text = seen ?? "";
			const positions = ["alpha report", "beta report", "gamma report"].map((part) =>
				text.indexOf(part),
			);
			expect(positions.every((position) => position >= 0)).toBe(true);
			expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		});
	});
}
