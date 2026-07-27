import { describe, expect, test } from "bun:test";
import type {
	RecoveryCardSubagentInput,
	RecoverySubagentInput,
	RecoveryToolCallInput,
} from "../narrator-subagent-recovery";
import {
	buildRecoveryNotifyPrompt,
	raceAbort,
	selectRecoverableToolCalls,
	selectRecoveryCardCandidates,
	TOOL_CALL_RESET_FIELDS,
	toolOutputText,
} from "../narrator-subagent-recovery";

const MSG = "assistant-msg-1";

function agentCall(status: string, overrides: Partial<RecoveryToolCallInput> = {}) {
	return {
		id: `tc-${overrides.toolUseId ?? "a1"}`,
		toolUseId: "a1",
		toolName: "Agent",
		status,
		messageId: MSG,
		...overrides,
	} satisfies RecoveryToolCallInput;
}

function awaitCall(
	status: string,
	input: unknown,
	overrides: Partial<RecoveryToolCallInput> = {},
): RecoveryToolCallInput {
	return {
		id: `tc-${overrides.toolUseId ?? "w1"}`,
		toolUseId: "w1",
		toolName: "Await",
		status,
		inputJson: input,
		messageId: MSG,
		...overrides,
	};
}

function foregroundSubagent(overrides: Partial<RecoverySubagentInput> = {}): RecoverySubagentInput {
	return {
		id: "sub-1",
		status: "idle",
		substatus: "[]",
		isBackground: false,
		...overrides,
	};
}

function subagentMap(
	entries: Array<[string, RecoverySubagentInput]>,
): Map<string, RecoverySubagentInput> {
	return new Map(entries);
}

describe("toolOutputText", () => {
	test("reads plain strings and the {_text} envelope", () => {
		expect(toolOutputText("hello")).toBe("hello");
		expect(toolOutputText({ _text: "wrapped", _metadata: {} })).toBe("wrapped");
	});

	test("returns an empty string for structured or missing output", () => {
		expect(toolOutputText(null)).toBe("");
		expect(toolOutputText(undefined)).toBe("");
		expect(toolOutputText([1, 2])).toBe("");
		expect(toolOutputText({ other: "x" })).toBe("");
	});
});

describe("selectRecoverableToolCalls — Agent", () => {
	const map = subagentMap([["a1", foregroundSubagent()]]);

	// Scenario 3 (narrator errored on its own) is the primary target: onErrorCleanup's
	// non-Aborted branch does not clean up orphaned tool calls.
	test("matches a running Agent call (scenario 3, primary target)", () => {
		const selected = selectRecoverableToolCalls([agentCall("running")], map);
		expect(selected).toHaveLength(1);
		expect(selected[0]).toMatchObject({ kind: "agent", toolUseId: "a1", targetId: "sub-1" });
	});

	test("matches pending and initializing Agent calls", () => {
		expect(selectRecoverableToolCalls([agentCall("pending")], map)).toHaveLength(1);
		expect(selectRecoverableToolCalls([agentCall("initializing")], map)).toHaveLength(1);
	});

	test("matches a failed Agent call (scenario 2, user interrupt)", () => {
		expect(selectRecoverableToolCalls([agentCall("fail")], map)).toHaveLength(1);
	});

	test("matches a successful Agent call whose output carries the subagent error marker", () => {
		const call = agentCall("success", {
			outputJson: "<subagent_id>x</subagent_id>\n\nSubagent error: boom",
		});
		expect(selectRecoverableToolCalls([call], map)).toHaveLength(1);
	});

	test("matches a successful Agent call when the subagent itself is tagged error", () => {
		const errored = subagentMap([["a1", foregroundSubagent({ substatus: '["error"]' })]]);
		expect(
			selectRecoverableToolCalls([agentCall("success", { outputJson: "done" })], errored),
		).toHaveLength(1);
	});

	test("ignores a clean successful Agent call", () => {
		const call = agentCall("success", { outputJson: "<subagent_id>x</subagent_id>\n\nall good" });
		expect(selectRecoverableToolCalls([call], map)).toEqual([]);
	});

	test("ignores a background subagent (the recovery card owns it)", () => {
		const background = subagentMap([["a1", foregroundSubagent({ isBackground: true })]]);
		expect(selectRecoverableToolCalls([agentCall("running")], background)).toEqual([]);
	});

	test("ignores a subagent that is still running", () => {
		const working = subagentMap([["a1", foregroundSubagent({ status: "working" })]]);
		expect(selectRecoverableToolCalls([agentCall("running")], working)).toEqual([]);
	});

	test("ignores an Agent call with no linked subagent", () => {
		expect(selectRecoverableToolCalls([agentCall("running")], new Map())).toEqual([]);
	});
});

describe("selectRecoverableToolCalls — Await", () => {
	test("matches non-terminal and failed agent awaits", () => {
		for (const status of ["initializing", "pending", "running", "fail"]) {
			const selected = selectRecoverableToolCalls(
				[awaitCall(status, { type: "agent", id: "explore-1" })],
				new Map(),
			);
			expect(selected).toHaveLength(1);
			expect(selected[0]).toMatchObject({ kind: "await", targetId: "explore-1" });
		}
	});

	test("ignores a successful await", () => {
		const selected = selectRecoverableToolCalls(
			[awaitCall("success", { type: "agent", id: "explore-1" })],
			new Map(),
		);
		expect(selected).toEqual([]);
	});

	// Bash background processes die with the server process; re-running the original
	// command is a separate design decision (idempotency), so it is out of scope.
	test("skips bash awaits", () => {
		const selected = selectRecoverableToolCalls(
			[awaitCall("running", { type: "bash", id: "task-1" })],
			new Map(),
		);
		expect(selected).toEqual([]);
	});

	test("skips awaits with a missing id or malformed input", () => {
		expect(
			selectRecoverableToolCalls([awaitCall("running", { type: "agent" })], new Map()),
		).toEqual([]);
		expect(selectRecoverableToolCalls([awaitCall("running", null)], new Map())).toEqual([]);
	});

	test("ignores unrelated tools", () => {
		const read: RecoveryToolCallInput = {
			id: "tc-r",
			toolUseId: "r1",
			toolName: "Read",
			status: "running",
			messageId: MSG,
		};
		expect(selectRecoverableToolCalls([read], new Map())).toEqual([]);
	});

	test("preserves order across mixed candidates", () => {
		const map = subagentMap([["a1", foregroundSubagent()]]);
		const selected = selectRecoverableToolCalls(
			[
				awaitCall("fail", { type: "agent", id: "explore-1" }),
				agentCall("running"),
				awaitCall("running", { type: "bash", id: "bash-1" }, { toolUseId: "w2" }),
			],
			map,
		);
		expect(selected.map((item) => item.kind)).toEqual(["await", "agent"]);
	});
});

describe("selectRecoveryCardCandidates", () => {
	const nowMs = Date.parse("2026-04-01T12:00:00.000Z");

	function cardSubagent(
		overrides: Partial<RecoveryCardSubagentInput> = {},
	): RecoveryCardSubagentInput {
		return {
			id: "sub-1",
			status: "idle",
			substatus: '["error"]',
			isBackground: true,
			title: "Investigate flaky test",
			subagentType: "explore",
			errorMessage: "provider timeout",
			createdAt: new Date(nowMs - 60_000).toISOString(),
			originToolUseId: "a-old",
			...overrides,
		};
	}

	test("includes a recent background subagent tagged error", () => {
		const candidates = selectRecoveryCardCandidates([cardSubagent()], { nowMs });
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			id: "sub-1",
			title: "Investigate flaky test",
			subagentType: "explore",
			wasForeground: false,
		});
	});

	test("excludes subagents created outside the 24h window", () => {
		const old = cardSubagent({ createdAt: new Date(nowMs - 25 * 60 * 60 * 1000).toISOString() });
		expect(selectRecoveryCardCandidates([old], { nowMs })).toEqual([]);
		const edge = cardSubagent({
			createdAt: new Date(nowMs - 24 * 60 * 60 * 1000 + 1).toISOString(),
		});
		expect(selectRecoveryCardCandidates([edge], { nowMs })).toHaveLength(1);
	});

	test("requires an error tag parsed from JSON, not substring matching", () => {
		expect(selectRecoveryCardCandidates([cardSubagent({ substatus: "[]" })], { nowMs })).toEqual(
			[],
		);
		expect(
			selectRecoveryCardCandidates([cardSubagent({ substatus: '["errors_ignored"]' })], { nowMs }),
		).toEqual([]);
		expect(
			selectRecoveryCardCandidates([cardSubagent({ substatus: '["unread","error"]' })], { nowMs }),
		).toHaveLength(1);
	});

	test("excludes subagents that are not settled", () => {
		expect(selectRecoveryCardCandidates([cardSubagent({ status: "working" })], { nowMs })).toEqual(
			[],
		);
	});

	test("includes earlier-turn foreground subagents and flags them for detaching", () => {
		const candidates = selectRecoveryCardCandidates(
			[cardSubagent({ isBackground: false, originToolUseId: "a-old" })],
			{ nowMs, latestTurnToolUseIds: new Set(["a-latest"]) },
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].wasForeground).toBe(true);
	});

	// Path A owns the latest assistant turn; the card must not list the same work.
	test("excludes a foreground subagent owned by the latest turn", () => {
		const candidates = selectRecoveryCardCandidates(
			[cardSubagent({ isBackground: false, originToolUseId: "a-latest" })],
			{ nowMs, latestTurnToolUseIds: new Set(["a-latest"]) },
		);
		expect(candidates).toEqual([]);
	});

	test("still lists a background subagent even when its origin is on the latest turn", () => {
		const candidates = selectRecoveryCardCandidates(
			[cardSubagent({ isBackground: true, originToolUseId: "a-latest" })],
			{ nowMs, latestTurnToolUseIds: new Set(["a-latest"]) },
		);
		expect(candidates).toHaveLength(1);
	});

	test("falls back to the id and a default type when metadata is missing", () => {
		const candidates = selectRecoveryCardCandidates(
			[cardSubagent({ title: "   ", subagentType: null })],
			{ nowMs },
		);
		expect(candidates[0]).toMatchObject({ title: "sub-1", subagentType: "general" });
	});

	test("ignores subagents with an unparseable createdAt", () => {
		expect(
			selectRecoveryCardCandidates([cardSubagent({ createdAt: "not-a-date" })], { nowMs }),
		).toEqual([]);
	});
});

describe("TOOL_CALL_RESET_FIELDS", () => {
	// `pending` means "stopped at the permission gate": resolvePendingPerm
	// (frontend/components/narrator/narrator-message-helpers.ts) SYNTHESIZES a
	// PendingPermission from any row in that state. Re-arming a recovered Agent/Await
	// row as `pending` therefore made a phantom Allow/Deny form appear on the subagent
	// card while the work was already running and nothing awaited a decision.
	test("re-arms as running, never pending, so no phantom permission form appears", () => {
		expect(TOOL_CALL_RESET_FIELDS.status).toBe("running");
		expect(TOOL_CALL_RESET_FIELDS.status).not.toBe("pending");
	});

	test("clears every stale result and permission-decision field", () => {
		for (const field of [
			"outputJson",
			"errorMessage",
			"permissionDenyMessage",
			"permissionDecidedBy",
			"permissionDecidedAt",
			"permissionDecisionReason",
			"permissionSuggestions",
			"completedAt",
			"durationMs",
			"executionStartedAt",
		] as const) {
			expect(TOOL_CALL_RESET_FIELDS[field]).toBeNull();
		}
	});
});

describe("buildRecoveryNotifyPrompt", () => {
	test("lists every alias and tells the model to Await them", () => {
		const prompt = buildRecoveryNotifyPrompt([{ alias: "explore-1" }, { alias: "plan-2" }]);
		expect(prompt).toContain("- explore-1");
		expect(prompt).toContain("- plan-2");
		expect(prompt).toContain('Await({ type: "agent"');
	});
});

// The recovery stage runs without an activeNarrators entry, so an interrupt can only reach
// it through the registered controller. Without this the user waits out the Await timeout.
describe("raceAbort", () => {
	test("resolves with the promise value when no interrupt arrives", async () => {
		const signal = new AbortController().signal;
		expect(await raceAbort(Promise.resolve("done"), signal)).toBe("done");
	});

	test("propagates the original rejection", async () => {
		const signal = new AbortController().signal;
		await expect(raceAbort(Promise.reject(new Error("inner")), signal)).rejects.toThrow("inner");
	});

	test("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const pending = new Promise<string>(() => {});
		await expect(raceAbort(pending, controller.signal)).rejects.toThrow(
			"Subagent recovery interrupted",
		);
	});

	test("stops waiting on a never-settling promise once the signal aborts", async () => {
		const controller = new AbortController();
		const pending = new Promise<string>(() => {});
		const raced = raceAbort(pending, controller.signal);
		controller.abort();
		await expect(raced).rejects.toThrow("Subagent recovery interrupted");
	});

	test("removes its abort listener so a reused signal cannot accumulate handlers", async () => {
		const controller = new AbortController();
		let added = 0;
		let removed = 0;
		const signal = {
			aborted: false,
			addEventListener: (type: string, fn: () => void, opts?: AddEventListenerOptions) => {
				added++;
				controller.signal.addEventListener(type, fn, opts);
			},
			removeEventListener: (type: string, fn: () => void) => {
				removed++;
				controller.signal.removeEventListener(type, fn);
			},
		} as unknown as AbortSignal;

		await raceAbort(Promise.resolve("a"), signal);
		await raceAbort(Promise.resolve("b"), signal);
		// The cleanup runs in a `finally` chained after the resolution, so let the
		// microtask queue drain before counting.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(added).toBe(2);
		expect(removed).toBe(2);
	});
});
