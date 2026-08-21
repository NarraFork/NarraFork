import { describe, expect, test } from "bun:test";
import {
	isInternalTrait,
	NARRATOR_DRAFT_TRAIT_PREFIX,
	redactDraftTraits,
	redactInternalTraits,
} from "../../lib/narrator-utils";
import type {
	RecoveryCardSubagentInput,
	RecoverySubagentInput,
	RecoveryToolCallInput,
} from "../narrator-subagent-recovery";
import {
	buildRecoveryNotifyPrompt,
	buildRecoveryOfferedTrait,
	buildRecoveryOfferedUpdate,
	parseRecoveryOfferedAtMs,
	RECOVERY_OFFERED_TRAIT_PREFIX,
	raceAbort,
	recoveryFailureTimeMs,
	selectRecoverableToolCalls,
	selectRecoveryCardCandidates,
	TOOL_CALL_RESET_FIELDS,
	toolOutputText,
	withRecoveryOfferedTrait,
} from "../narrator-subagent-recovery";
import { TURN_PAUSE_STARTED_MS_PREFIX } from "../narrator-turn-timing";

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
			updatedAt: new Date(nowMs - 60_000).toISOString(),
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

	test("excludes subagents that failed outside the 24h window", () => {
		const old = cardSubagent({ updatedAt: new Date(nowMs - 25 * 60 * 60 * 1000).toISOString() });
		expect(selectRecoveryCardCandidates([old], { nowMs })).toEqual([]);
		const edge = cardSubagent({
			updatedAt: new Date(nowMs - 24 * 60 * 60 * 1000 + 1).toISOString(),
		});
		expect(selectRecoveryCardCandidates([edge], { nowMs })).toHaveLength(1);
	});

	// The bug this replaced: the window was applied to the SPAWN time, so a long
	// session listed subagents that had died hours earlier as if they were fresh.
	test("uses the failure time, not the spawn time, for the window", () => {
		const spawnedRecentlyFailedLongAgo = cardSubagent({
			createdAt: new Date(nowMs - 60_000).toISOString(),
			updatedAt: new Date(nowMs - 30 * 60 * 60 * 1000).toISOString(),
		});
		expect(selectRecoveryCardCandidates([spawnedRecentlyFailedLongAgo], { nowMs })).toEqual([]);

		const spawnedLongAgoFailedJustNow = cardSubagent({
			createdAt: new Date(nowMs - 30 * 60 * 60 * 1000).toISOString(),
			updatedAt: new Date(nowMs - 10_000).toISOString(),
		});
		expect(selectRecoveryCardCandidates([spawnedLongAgoFailedJustNow], { nowMs })).toHaveLength(1);
	});

	// A card is about the turn that just failed. Failures from turns the parent
	// already completed were reported through the background-completion notice.
	test("excludes failures that predate the failing turn", () => {
		const turnStartedAtMs = nowMs - 120_000;
		const beforeTurn = cardSubagent({
			updatedAt: new Date(turnStartedAtMs - 1).toISOString(),
		});
		expect(selectRecoveryCardCandidates([beforeTurn], { nowMs, turnStartedAtMs })).toEqual([]);

		const duringTurn = cardSubagent({
			updatedAt: new Date(turnStartedAtMs + 1_000).toISOString(),
		});
		expect(selectRecoveryCardCandidates([duringTurn], { nowMs, turnStartedAtMs })).toHaveLength(1);
	});

	test("falls back to the 24h window when the turn start is unknown", () => {
		const recent = cardSubagent({ updatedAt: new Date(nowMs - 60_000).toISOString() });
		expect(selectRecoveryCardCandidates([recent], { nowMs, turnStartedAtMs: null })).toHaveLength(
			1,
		);
		expect(
			selectRecoveryCardCandidates([recent], { nowMs, turnStartedAtMs: Number.NaN }),
		).toHaveLength(1);
	});

	test("falls back to createdAt when updatedAt is missing or unparseable", () => {
		const noUpdatedAt = cardSubagent({ updatedAt: null });
		expect(selectRecoveryCardCandidates([noUpdatedAt], { nowMs })).toHaveLength(1);
		const badUpdatedAt = cardSubagent({
			updatedAt: "not-a-date",
			createdAt: new Date(nowMs - 30 * 60 * 60 * 1000).toISOString(),
		});
		expect(selectRecoveryCardCandidates([badUpdatedAt], { nowMs })).toEqual([]);
	});

	// Otherwise every subsequent narrator error re-proposes the same dead subagents.
	test("excludes a failure that has already been offered on a card", () => {
		const failedAtMs = nowMs - 60_000;
		const offered = cardSubagent({
			updatedAt: new Date(failedAtMs).toISOString(),
			traits: [buildRecoveryOfferedTrait(failedAtMs)],
		});
		expect(selectRecoveryCardCandidates([offered], { nowMs })).toEqual([]);
	});

	test("re-offers a subagent that failed again after being resumed", () => {
		const offered = cardSubagent({
			updatedAt: new Date(nowMs - 10_000).toISOString(),
			traits: [buildRecoveryOfferedTrait(nowMs - 60_000)],
		});
		expect(selectRecoveryCardCandidates([offered], { nowMs })).toHaveLength(1);
	});

	test("ignores unrelated traits and malformed watermarks", () => {
		const noisy = cardSubagent({
			traits: ["background", `${RECOVERY_OFFERED_TRAIT_PREFIX}not-a-number`],
		});
		expect(selectRecoveryCardCandidates([noisy], { nowMs })).toHaveLength(1);
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

	test("ignores subagents with no usable timestamp at all", () => {
		expect(
			selectRecoveryCardCandidates([cardSubagent({ createdAt: "not-a-date", updatedAt: null })], {
				nowMs,
			}),
		).toEqual([]);
	});
});

describe("recovery offer watermark", () => {
	test("recoveryFailureTimeMs prefers updatedAt and falls back to createdAt", () => {
		const created = "2026-04-01T10:00:00.000Z";
		const updated = "2026-04-01T11:00:00.000Z";
		expect(
			recoveryFailureTimeMs({
				id: "s",
				status: "idle",
				createdAt: created,
				updatedAt: updated,
			}),
		).toBe(Date.parse(updated));
		expect(
			recoveryFailureTimeMs({ id: "s", status: "idle", createdAt: created, updatedAt: null }),
		).toBe(Date.parse(created));
		expect(
			recoveryFailureTimeMs({ id: "s", status: "idle", createdAt: "nope", updatedAt: "nope" }),
		).toBeNull();
	});

	// `updatedAt` is only an upper bound: ANY later write to the row (title sync, a user
	// editing custom traits, subagent-alias persistence, subagent-detach's `background`
	// tagging) pushes it forward, which would resurrect an hours-old failure into the 24h
	// window. The `turn_pause_started_ms:` tag is written by the same updateStatus call
	// that tags `error` and is touched by nothing else, so it wins.
	test("recoveryFailureTimeMs prefers the substatus timing tag over a polluted updatedAt", () => {
		const failedAtMs = Date.parse("2026-04-01T02:00:00.000Z");
		const pollutedUpdatedAt = "2026-04-01T11:59:00.000Z";
		expect(
			recoveryFailureTimeMs({
				id: "s",
				status: "idle",
				substatus: JSON.stringify(["error", `${TURN_PAUSE_STARTED_MS_PREFIX}${failedAtMs}`]),
				createdAt: "2026-04-01T01:00:00.000Z",
				updatedAt: pollutedUpdatedAt,
			}),
		).toBe(failedAtMs);
	});

	test("a stale failure stays out of the window even when updatedAt was pushed forward", () => {
		const nowMs = Date.parse("2026-04-01T12:00:00.000Z");
		const failedAtMs = nowMs - 30 * 60 * 60 * 1000;
		const touchedAfterFailing: RecoveryCardSubagentInput = {
			id: "sub-stale",
			status: "idle",
			substatus: JSON.stringify(["error", `${TURN_PAUSE_STARTED_MS_PREFIX}${failedAtMs}`]),
			isBackground: true,
			title: "Old failure",
			subagentType: "explore",
			errorMessage: "provider timeout",
			createdAt: new Date(failedAtMs - 60_000).toISOString(),
			// Simulates a later title/trait/alias write touching the row.
			updatedAt: new Date(nowMs - 1_000).toISOString(),
		};
		expect(selectRecoveryCardCandidates([touchedAfterFailing], { nowMs })).toEqual([]);
	});

	test("parses the newest watermark and ignores malformed ones", () => {
		expect(parseRecoveryOfferedAtMs(null)).toBeNull();
		expect(parseRecoveryOfferedAtMs(["background"])).toBeNull();
		expect(parseRecoveryOfferedAtMs([`${RECOVERY_OFFERED_TRAIT_PREFIX}abc`])).toBeNull();
		expect(
			parseRecoveryOfferedAtMs([buildRecoveryOfferedTrait(100), buildRecoveryOfferedTrait(300)]),
		).toBe(300);
	});

	test("replaces an existing watermark and preserves other traits", () => {
		const next = withRecoveryOfferedTrait(["background", buildRecoveryOfferedTrait(100)], 500);
		expect(next).toContain("background");
		expect(next.filter((t) => t.startsWith(RECOVERY_OFFERED_TRAIT_PREFIX))).toEqual([
			buildRecoveryOfferedTrait(500),
		]);
	});
});

// The watermark is INTERNAL runtime state, unlike every other trait (semantic tags and
// encoded user settings). Leaking it would expose server bookkeeping and, because it
// changes on every offer, churn the identity of the narrator objects the frontend caches.
describe("the watermark never reaches a client", () => {
	const traits = [
		"standalone",
		"background",
		buildRecoveryOfferedTrait(1_700_000_000_000),
		`${NARRATOR_DRAFT_TRAIT_PREFIX}whatever`,
	];

	test("is classified as an internal trait", () => {
		expect(isInternalTrait(buildRecoveryOfferedTrait(1))).toBe(true);
		expect(isInternalTrait("standalone")).toBe(false);
		expect(isInternalTrait("background")).toBe(false);
	});

	test("redactInternalTraits strips it while keeping the public tags", () => {
		expect(redactInternalTraits(traits)).toEqual(["standalone", "background"]);
	});

	// Every public-response path (publicNarratorResponse / publicTraitsResponse in
	// routes/narrators, the custom_traits_changed and plan_mode_changed broadcasts) goes
	// through one of these two, so the historical name must filter it too.
	test("the legacy redactDraftTraits name filters it as well (back-compatible)", () => {
		expect(redactDraftTraits(traits)).toEqual(["standalone", "background"]);
		expect(redactDraftTraits(traits)).toEqual(redactInternalTraits(traits));
	});
});

// If someone "fixes" markRecoveryOffered to also write updatedAt (as every other
// narrators update does), the recorded failure time jumps to the moment the card was
// offered, `failedMs <= offeredAtMs` stops holding for the rows just watermarked, and the
// next narrator error re-proposes the same dead subagents. Nothing else would catch that.
describe("buildRecoveryOfferedUpdate must not touch updatedAt", () => {
	test("patches traits only — no updatedAt, no other column", () => {
		const patch = buildRecoveryOfferedUpdate(["background"], 1_700_000_000_000);
		expect(Object.keys(patch)).toEqual(["traits"]);
		expect("updatedAt" in patch).toBe(false);
		expect(patch.traits).toEqual(["background", buildRecoveryOfferedTrait(1_700_000_000_000)]);
	});

	test("watermarking twice never introduces a timestamp column", () => {
		const first = buildRecoveryOfferedUpdate([], 100);
		const second = buildRecoveryOfferedUpdate(first.traits, 200);
		expect(Object.keys(second)).toEqual(["traits"]);
		expect(second.traits.filter((t) => t.startsWith(RECOVERY_OFFERED_TRAIT_PREFIX))).toEqual([
			buildRecoveryOfferedTrait(200),
		]);
	});
});

describe("TOOL_CALL_RESET_FIELDS", () => {
	// `pending` means "stopped at the permission gate". The chunked renderer
	// SYNTHESIZED a PendingPermission from any row in that state, so re-arming a
	// recovered Agent/Await row as `pending` made a phantom Allow/Deny form appear on
	// the subagent card while the work was already running and nothing awaited a
	// decision. The vlist matches against the live WS list instead and would not
	// synthesize one, but the status is still wrong on its own terms — a running row
	// reported as gated — so this stays pinned.
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
