import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../lib/agent/types";
import { CriticalEventPersistenceError } from "../narrator-event-handler";
import {
	createContractClock,
	createRuntimeContractHarness,
	deferred,
	runtimeContractScenarios,
} from "./agent-runtime-contract.harness";

const completed: AgentEvent = { type: "assistant_message", text: "completed", toolUses: [] };
const toolResult: AgentEvent = {
	type: "tool_result",
	toolUseId: "provider-reused-id",
	toolName: "Read",
	output: "fixture result",
	isError: false,
	toolCallBinding: { toolCallId: "persisted-tool-row", attempt: 3 },
};

// These are the common pass contract for every future entry adapter, NOT proof that
// background/takeover/custom policy paths currently share their outer orchestrator.
for (const scenario of runtimeContractScenarios) {
	describe(`shared executeAgentLoop baseline: ${scenario.name}`, () => {
		test("completes one pass, preserves input evidence and does not invent publication", async () => {
			const harness = createRuntimeContractHarness(scenario);
			const history = [{ role: "user", text: "earlier input", recipientRefId: "ref-fixture" }];
			const result = await harness.runPass([completed, { type: "done" }], {
				userText: "current input",
				history,
			});
			history[0].text = "later mutation";

			expect(result).toMatchObject({
				finalText: "completed",
				hasError: false,
				completedAssistantTurn: true,
				completedNaturally: true,
			});
			expect(harness.trace[0]).toMatchObject({
				kind: "pass-input",
				userText: "current input",
				history: [{ role: "user", text: "earlier input", recipientRefId: "ref-fixture" }],
			});
			expect(harness.trace.filter((entry) => entry.kind === "simulated-model-call")).toHaveLength(
				1,
			);
			expect(harness.trace.filter((entry) => entry.kind === "publish")).toHaveLength(0);
			expect(harness.config.requireToolCallBinding).toBe(true);
			expect(harness.eventContext.requireToolCallBinding).toBe(true);
			expect(harness.eventContext.getFileReferenceContext?.()).toEqual({
				deviceId: "local",
				cwd: process.cwd(),
			});
			expect(harness.trace.at(-2)?.kind).toBe("source-closed");
			expect(harness.trace.at(-1)?.kind).toBe("pass-result");
		});

		test("controlled deadline cancels a paused pass, drains bound tool results, ignores late done", async () => {
			const harness = createRuntimeContractHarness(scenario);
			const entered = deferred<void>();
			const release = deferred<void>();
			const cleanup: string[] = [];
			const pass = harness.runPass(
				[
					() => {
						entered.resolve();
						return release.promise;
					},
					{ type: "stream_text", text: "late text must not be processed" },
					toolResult,
					{ type: "block_complete", block: { type: "text", text: "partial output" } },
					{ type: "done" },
					{ type: "error", message: "Aborted" },
				],
				{
					userText: "cancel test",
					history: [],
					hooks: {
						onErrorCleanup: async (message) => {
							cleanup.push(message);
						},
					},
				},
				async (event, _context, hooks) => {
					// Explicit persistence double, matching narrator-executor.test.ts.
					if (event.type === "error") await hooks?.onErrorCleanup?.(event.message);
					return null;
				},
			);
			await entered.promise;
			harness.deadline("fixture-budget", 50, () => {
				harness.cancel("fixture deadline");
				release.resolve();
			});
			harness.clock.advanceBy(49);
			expect(harness.controller.signal.aborted).toBe(false);
			expect(harness.trace.some((entry) => entry.kind === "pass-result")).toBe(false);
			harness.clock.advanceBy(1);
			const result = await pass;

			expect(result).toMatchObject({ aborted: true, hasError: false, completedNaturally: false });
			expect(cleanup).toEqual(["Aborted"]);
			expect(
				harness.trace.flatMap((entry) =>
					entry.kind === "event" && entry.stage === "processed" ? [entry.event.type] : [],
				),
			).toEqual(["tool_result", "block_complete", "error"]);
			expect(harness.trace.filter((entry) => entry.kind === "binding")).toEqual([
				expect.objectContaining({
					at: 50,
					toolUseId: "provider-reused-id",
					binding: { toolCallId: "persisted-tool-row", attempt: 3 },
				}),
			]);
			expect(
				harness.trace.filter((entry) => entry.kind === "deadline" || entry.kind === "cancel"),
			).toEqual([
				expect.objectContaining({ kind: "deadline", label: "fixture-budget", at: 50 }),
				expect.objectContaining({ kind: "cancel", reason: "fixture deadline", at: 50 }),
			]);
			expect(harness.clock.pending()).toBe(0);
		});

		test("persistence barrier failure closes source before any following tool result", async () => {
			const harness = createRuntimeContractHarness(scenario);
			const error = new CriticalEventPersistenceError("fixture persistence failure");
			const pass = harness.runPass(
				[
					{
						type: "assistant_message",
						text: "",
						toolUses: [{ toolUseId: "provider-reused-id", name: "Read", input: {} }],
					},
					toolResult,
					{ type: "done" },
				],
				undefined,
				async () => {
					throw error;
				},
			);
			await expect(pass).rejects.toBe(error);
			expect(harness.trace.at(-1)?.kind).toBe("source-closed");
			expect(harness.trace.some((entry) => entry.kind === "binding")).toBe(false);
			expect(harness.trace.some((entry) => entry.kind === "pass-result")).toBe(false);
		});
	});
}

describe("CriticalEventPersistenceError surfaces its cause", () => {
	// The narrator's `errorMessage`, the WebSocket `narrator_error` and the
	// `narrator_error` on the narrator event stream all render `String(err)`, which
	// prints `message` and nothing else. A cause parked on `Error.cause` is therefore
	// invisible to the reader who has to decide whether to retry — which is the whole
	// point of stopping the loop instead of warning and continuing.
	//
	// Scope note: these assert the CONSTRUCTOR contract. That the folded message then
	// reaches the reader is the job of the executor/orchestrator seams, which this
	// file does not drive.
	test("includes the underlying cause in the message", () => {
		const cause = new Error("SQLITE_BUSY: database is locked");
		const error = new CriticalEventPersistenceError("Tool result could not be persisted", {
			cause,
		});
		expect(error.message).toBe(
			"Tool result could not be persisted: SQLITE_BUSY: database is locked",
		);
		// The cause stays reachable structurally too; the message duplication is
		// additive, not a replacement.
		expect((error.cause as Error).message).toBe(cause.message);
	});

	test("handles a cause that is a plain string", () => {
		const error = new CriticalEventPersistenceError("Write source exceeds final content", {
			cause: "length went backwards",
		});
		expect(error.message).toBe("Write source exceeds final content: length went backwards");
	});

	test("leaves the message alone when there is no cause", () => {
		const error = new CriticalEventPersistenceError(
			"Detached tool result has no execution receipt",
		);
		expect(error.message).toBe("Detached tool result has no execution receipt");
	});

	test("does not repeat a message the cause already contains", () => {
		const error = new CriticalEventPersistenceError("Tool result could not be persisted", {
			cause: new Error("Tool result could not be persisted"),
		});
		expect(error.message).toBe("Tool result could not be persisted");
	});

	test("survives a cause that cannot be stringified", () => {
		// `String()` throws "No default value" on a null-prototype object. This
		// constructor runs inside the executor's catch block, so throwing here would
		// replace the persistence diagnosis with a TypeError and hide the real failure
		// — the reader must still get the barrier message.
		const cause = Object.create(null) as object;
		const error = new CriticalEventPersistenceError("Tool result could not be persisted", {
			cause,
		});
		expect(error.message).toBe("Tool result could not be persisted");
	});

	test("caps a huge cause instead of publishing it whole", () => {
		// The folded message is persisted to `narrators.error_message` (an unbounded
		// `text`) and broadcast over the WebSocket. A PostgreSQL failure renders as
		// `Failed query: <full SQL>\nparams: [...]`, so an uncapped fold would surface
		// complete statements and their parameter values to every reader.
		const cause = new Error(`Failed query: UPDATE t SET x = ?\nparams: ${"p".repeat(5_000)}`);
		const error = new CriticalEventPersistenceError(
			"Assistant content persistence barrier failed",
			{
				cause,
			},
		);
		// Bound is the cap plus the fixed prefix/suffix, not the original size.
		expect(error.message.length).toBeLessThan(1_200);
		expect(error.message).toContain("truncated 4");
		expect(error.message).toContain("Failed query: UPDATE t SET x = ?");
	});
});

describe("runtime contract fixture controls", () => {
	test("clock honors deadline ordering, cancellation and nested scheduling without global timers", () => {
		const clock = createContractClock();
		const observed: number[] = [];
		const cancel = clock.schedule(5, () => observed.push(-1));
		clock.schedule(10, () => {
			observed.push(clock.now());
			clock.schedule(2, () => observed.push(clock.now()));
		});
		clock.schedule(10, () => observed.push(clock.now() + 1));
		expect(cancel()).toBe(true);
		clock.advanceBy(20);
		expect(observed).toEqual([10, 11, 12]);
		expect(clock.now()).toBe(20);
		expect(clock.pending()).toBe(0);
		expect(() => clock.advanceBy(-1)).toThrow("Invalid clock advance");
	});

	test("gate rejection escapes real executor and closes its event source", async () => {
		const harness = createRuntimeContractHarness(runtimeContractScenarios[0]);
		const entered = deferred<void>();
		const gate = deferred<void>();
		const result = harness.runPass([
			() => {
				entered.resolve();
				return gate.promise;
			},
			completed,
		]);
		await entered.promise;
		gate.reject(new Error("fixture disconnected"));
		await expect(result).rejects.toThrow("fixture disconnected");
		expect(harness.trace.at(-1)?.kind).toBe("source-closed");
	});

	test("tool-result replay input reaches the real pass's interrupted-result classification", async () => {
		const harness = createRuntimeContractHarness(runtimeContractScenarios[0]);
		const trailingToolResults = [{ toolUseId: "provider-reused-id", content: "stored output" }];
		const result = await harness.runPass(
			[{ type: "output_truncated", message: "length" }, { type: "done" }],
			{ userText: "", history: [], trailingToolResults },
		);
		expect(result.interrupted).toBe(true);
		expect(result.shouldReplayInterruptedToolResultTurn).toBe(true);
		expect(harness.trace[0]).toMatchObject({ kind: "pass-input", trailingToolResults });
	});
});
