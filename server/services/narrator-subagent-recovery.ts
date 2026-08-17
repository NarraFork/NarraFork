/**
 * Recovery of unfinished subagent work after a narrator error.
 *
 * Two complementary paths:
 *
 * - **Path A (seamless, reuses the existing "Continue" button)**: when the LAST
 *   top-level assistant turn contains an unfinished `Agent` (foreground subagent)
 *   or `Await({type:"agent"})` tool call, clicking Continue rebuilds the
 *   "parent is calling a subagent and waiting" state. The foreground subagent
 *   STAYS foreground; when it settles, `deliverCompletedResume` writes the
 *   result back into that very tool call and the parent loop resumes.
 *
 * - **Path B (card)**: on a narrator error we insert a UI-only card listing
 *   error subagents created within the last 24h that Path A does NOT cover
 *   (background ones + foreground ones from EARLIER turns). The user picks which
 *   to resume; earlier-turn foreground subagents are converted to background
 *   first (their original tool_result slot is no longer replayable).
 *
 * Why the candidate filter is so permissive about tool-call status: the three
 * error paths leave DIFFERENT terminal states behind.
 *   1. Foreground subagent errored, parent collected the result normally
 *      → status "success", output text contains "Subagent error:"
 *      (runForegroundLoop returns an error STRING; agentTool does not set isError)
 *   2. User interrupt (Aborted) → finalizeInterruptedRun → cleanupOrphanedToolCalls
 *      → status "fail" + interruptedByUser
 *   3. Narrator errored on its own (provider failure, …) → onErrorCleanup's
 *      non-Aborted branch does NOT call cleanupOrphanedToolCalls, so in-flight
 *      rows stay at "initializing" / "pending" / "running".
 * Scenario 3 is the main target, so filtering on `status === "fail"` alone would
 * match nothing in the most common case.
 */

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import { narratorMessageRefs, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { AsyncMutex, narratorTraitsLock } from "../lib/async-mutex";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	isSubagentVariant,
	NARRATOR_RECOVERY_OFFERED_TRAIT_PREFIX,
	parseSubstatus,
	parseTraits,
} from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { narratorService } from "./narrator-service";
import { parseTurnPauseTiming } from "./narrator-turn-timing";
import { registerAndPersistSubagentAlias } from "./subagent-alias";

/** Statuses that mean "this tool call never produced a usable result". */
const NON_TERMINAL_TOOL_CALL_STATUSES = new Set(["initializing", "pending", "running"]);

/** Marker embedded in a foreground subagent's returned text when it failed. */
const SUBAGENT_ERROR_MARKER = "Subagent error:";

/** Substatus tags that mark a settled subagent as "did not finish its job". */
const UNFINISHED_SUBSTATUS_TAGS = ["error", "interrupted", "timeout"] as const;

const RECOVERY_CARD_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Serializes Path A preparation per narrator. */
const recoveryLock = new AsyncMutex();

// === Pure selection logic (unit-testable) ===

export interface RecoveryToolCallInput {
	id: string;
	toolUseId: string;
	toolName: string;
	status: string;
	inputJson?: unknown;
	outputJson?: unknown;
	messageId?: string | null;
}

/** Minimal subagent shape needed by the selectors. */
export interface RecoverySubagentInput {
	id: string;
	status: string;
	substatus?: string | null;
	isBackground?: boolean | null;
}

export type RecoverableToolCallKind = "agent" | "await";

export interface RecoverableToolCall {
	kind: RecoverableToolCallKind;
	toolCallId: string;
	toolUseId: string;
	messageId: string | null;
	/** Subagent id for `agent`, or the Await target id/alias for `await`. */
	targetId: string;
}

/** Extract the plain text from a persisted tool output (`string` or `{_text}`). */
export function toolOutputText(output: unknown): string {
	if (typeof output === "string") return output;
	if (!output || typeof output !== "object" || Array.isArray(output)) return "";
	const text = (output as { _text?: unknown })._text;
	return typeof text === "string" ? text : "";
}

function hasUnfinishedSubstatus(substatus: string | null | undefined): boolean {
	const tags = parseSubstatus(substatus);
	return UNFINISHED_SUBSTATUS_TAGS.some((tag) => tags.includes(tag));
}

function readAwaitInput(inputJson: unknown): { type?: string; id?: string } {
	if (!inputJson || typeof inputJson !== "object" || Array.isArray(inputJson)) return {};
	const raw = inputJson as { type?: unknown; id?: unknown };
	return {
		type: typeof raw.type === "string" ? raw.type : undefined,
		id: typeof raw.id === "string" ? raw.id : undefined,
	};
}

/**
 * Decide which tool calls of the latest assistant turn represent unfinished
 * subagent work that Path A should re-drive.
 *
 * `subagentByOrigin` maps an Agent tool_use id → the subagent it spawned.
 */
export function selectRecoverableToolCalls(
	toolCalls: RecoveryToolCallInput[],
	subagentByOrigin: Map<string, RecoverySubagentInput>,
): RecoverableToolCall[] {
	const selected: RecoverableToolCall[] = [];

	for (const tc of toolCalls) {
		const nonTerminal = NON_TERMINAL_TOOL_CALL_STATUSES.has(tc.status);

		if (tc.toolName === "Agent") {
			const subagent = subagentByOrigin.get(tc.toolUseId);
			// Only a settled FOREGROUND subagent can be re-driven in place: a
			// background one has already been handed off to the card path, and a
			// running one needs no recovery.
			if (!subagent || subagent.isBackground || subagent.status !== "idle") continue;

			const failedResult = tc.status === "fail";
			const errorTextResult =
				tc.status === "success" && toolOutputText(tc.outputJson).includes(SUBAGENT_ERROR_MARKER);
			if (
				!nonTerminal &&
				!failedResult &&
				!errorTextResult &&
				!hasUnfinishedSubstatus(subagent.substatus)
			) {
				continue;
			}

			selected.push({
				kind: "agent",
				toolCallId: tc.id,
				toolUseId: tc.toolUseId,
				messageId: tc.messageId ?? null,
				targetId: subagent.id,
			});
			continue;
		}

		if (tc.toolName === "Await") {
			// A successful Await already carries its result; nothing to redo.
			if (!nonTerminal && tc.status !== "fail") continue;
			const { type, id } = readAwaitInput(tc.inputJson);
			if (!id) continue;
			if (type !== "agent") {
				// Background bash tasks die with the process; re-running the original
				// command is a separate design (idempotency). Deliberately skipped.
				logger.debug("Skipping non-agent Await during subagent recovery", {
					toolUseId: tc.toolUseId,
					awaitType: type ?? "(missing)",
				});
				continue;
			}
			selected.push({
				kind: "await",
				toolCallId: tc.id,
				toolUseId: tc.toolUseId,
				messageId: tc.messageId ?? null,
				targetId: id,
			});
		}
	}

	return selected;
}

export interface RecoveryCardSubagentInput extends RecoverySubagentInput {
	title?: string | null;
	subagentType?: string | null;
	variant?: string | null;
	errorMessage?: string | null;
	createdAt: string;
	/**
	 * Last write to this subagent row. Used only as a FALLBACK failure timestamp —
	 * see {@link recoveryFailureTimeMs} for why it cannot be trusted on its own.
	 */
	updatedAt?: string | null;
	/** The parent Agent tool_use id that originally spawned this subagent. */
	originToolUseId?: string | null;
	/**
	 * Traits of the subagent, used to read the "already offered" watermark that
	 * suppresses re-listing a failure the user has already seen on a card.
	 */
	traits?: unknown;
}

export interface RecoveryCardCandidate {
	id: string;
	title: string;
	subagentType: string;
	errorMessage: string | null;
	createdAt: string;
	/** True when this subagent still runs in foreground mode and must be detached first. */
	wasForeground: boolean;
}

/**
 * Trait prefix recording that this subagent's failure has ALREADY been offered on a
 * recovery card, together with the failure timestamp that was offered.
 *
 * Without this watermark the card is rebuilt from scratch on every single narrator
 * error, so one long session with a handful of old failures re-proposes the same
 * dead subagents again and again — the user declines, the next error re-lists them.
 * Storing the offered failure time (rather than a plain boolean) keeps a subagent
 * eligible again if it genuinely fails a SECOND time after being resumed.
 *
 * Unlike every other trait, this is INTERNAL runtime bookkeeping, not something the
 * user or the platform configured, so it is registered in
 * {@link NARRATOR_INTERNAL_TRAIT_PREFIXES} and never reaches an API response.
 */
export const RECOVERY_OFFERED_TRAIT_PREFIX = NARRATOR_RECOVERY_OFFERED_TRAIT_PREFIX;

export function buildRecoveryOfferedTrait(failedAtMs: number): string {
	return `${RECOVERY_OFFERED_TRAIT_PREFIX}${Math.floor(failedAtMs)}`;
}

/** Read the failure timestamp already offered for this subagent, if any. */
export function parseRecoveryOfferedAtMs(traits: unknown): number | null {
	let offered: number | null = null;
	for (const trait of parseTraits(traits)) {
		if (!trait.startsWith(RECOVERY_OFFERED_TRAIT_PREFIX)) continue;
		const value = Number(trait.slice(RECOVERY_OFFERED_TRAIT_PREFIX.length));
		if (!Number.isFinite(value)) continue;
		offered = offered == null ? value : Math.max(offered, value);
	}
	return offered;
}

/** Replace any existing watermark with one recording `failedAtMs`. */
export function withRecoveryOfferedTrait(traits: unknown, failedAtMs: number): string[] {
	const kept = parseTraits(traits).filter(
		(trait) => !trait.startsWith(RECOVERY_OFFERED_TRAIT_PREFIX),
	);
	return [...kept, buildRecoveryOfferedTrait(failedAtMs)];
}

/**
 * The moment a settled subagent actually failed, as far as the row can tell.
 *
 * Three sources, in descending order of trustworthiness:
 *
 * 1. **`turn_pause_started_ms:` in `substatus`** — written by
 *    `transitionTurnTimingSubstatus` in the very `updateStatus` call that tags the row
 *    `error`/`interrupted`/`payment_required`, and cleared only when the row goes back
 *    to `working`. This is the real failure instant, and nothing outside the
 *    status/substatus path ever rewrites it: title syncs, trait writes, alias
 *    persistence and detach all touch other columns.
 *
 * 2. **`updatedAt`** — a FALLBACK for rows that predate turn timing or were settled by
 *    a path that wrote no timing tag. It is only an upper bound on the failure time:
 *    `updatedAt` is the last write to the row from ANY source, so a subagent that
 *    failed hours ago has its `updatedAt` pushed to "now" by e.g.
 *    `persistSubagentAlias` (subagent-alias), the `background` tagging in
 *    `subagent-detach`, a title sync (narrator-title), or a user editing this
 *    subagent's custom traits. When that happens with no timing tag present, the stale
 *    failure looks fresh again and the card re-offers it — precisely the symptom the
 *    watermark exists to kill, which is why the watermark is the second line of
 *    defence and this is not the primary source.
 *
 * 3. **`createdAt`** — last resort, so a row with no usable timestamp at all is simply
 *    dropped by the caller rather than treated as "failed at epoch".
 *
 * A dedicated `failed_at` column would make (1) unconditional instead of derived, but
 * that needs a schema change; the timing tag is an existing, equally durable signal.
 */
export function recoveryFailureTimeMs(sa: RecoveryCardSubagentInput): number | null {
	const { pauseStartedAtMs } = parseTurnPauseTiming(parseSubstatus(sa.substatus));
	if (pauseStartedAtMs != null) return pauseStartedAtMs;
	const failedMs = Date.parse(sa.updatedAt ?? "");
	if (Number.isFinite(failedMs)) return failedMs;
	const createdMs = Date.parse(sa.createdAt);
	return Number.isFinite(createdMs) ? createdMs : null;
}

/**
 * Pick the subagents that belong on the recovery card.
 *
 * A candidate must be settled with an error, have FAILED recently (not merely
 * been created recently), not already be owned by Path A, and not already have
 * been offered on an earlier card. The failure-time test is what keeps a card
 * about "the error that just happened" from also dragging in every subagent that
 * died hours ago earlier in the same session.
 */
export function selectRecoveryCardCandidates(
	subagents: RecoveryCardSubagentInput[],
	options: {
		nowMs: number;
		windowMs?: number;
		/**
		 * Start of the parent turn that just failed. Failures older than this
		 * belong to turns the parent already finished (and was already told about
		 * through the background-completion notice), so they are not part of the
		 * work this card offers to resume.
		 */
		turnStartedAtMs?: number | null;
		/** Agent tool_use ids on the latest assistant turn (owned by Path A). */
		latestTurnToolUseIds?: Set<string>;
	},
): RecoveryCardCandidate[] {
	const windowMs = options.windowMs ?? RECOVERY_CARD_WINDOW_MS;
	// The turn boundary is the precise rule; the window is only an outer bound for
	// rows whose turn start is unknown (pre-feature data, externally driven runs).
	const turnStartedAtMs =
		options.turnStartedAtMs != null && Number.isFinite(options.turnStartedAtMs)
			? options.turnStartedAtMs
			: null;
	const cutoffMs = Math.max(options.nowMs - windowMs, turnStartedAtMs ?? Number.NEGATIVE_INFINITY);
	const latest = options.latestTurnToolUseIds ?? new Set<string>();
	const candidates: RecoveryCardCandidate[] = [];

	for (const sa of subagents) {
		if (sa.status !== "idle") continue;
		if (!parseSubstatus(sa.substatus).includes("error")) continue;
		// The window applies to the FAILURE, not to the spawn: a subagent created
		// early in a long session and failed minutes ago is relevant, while one that
		// failed many hours ago is not, no matter when it was created.
		// See recoveryFailureTimeMs for why the substatus timing tag is preferred over
		// updatedAt, and what goes wrong when only the fallback is available.
		const failedMs = recoveryFailureTimeMs(sa);
		if (failedMs == null || failedMs < cutoffMs) continue;
		// Already proposed once. Only a NEWER failure re-opens the offer.
		const offeredAtMs = parseRecoveryOfferedAtMs(sa.traits);
		if (offeredAtMs != null && failedMs <= offeredAtMs) continue;
		// Path A owns the latest turn; never list the same work twice.
		if (sa.originToolUseId && latest.has(sa.originToolUseId) && !sa.isBackground) continue;

		candidates.push({
			id: sa.id,
			title: sa.title?.trim() || sa.id,
			subagentType: sa.subagentType?.trim() || "general",
			errorMessage: sa.errorMessage ?? null,
			createdAt: sa.createdAt,
			wasForeground: !sa.isBackground,
		});
	}

	return candidates;
}

// === Shared DB helpers ===

/**
 * The fields cleared when re-arming an Agent/Await tool call for subagent recovery.
 *
 * The status MUST be "running", never "pending". In this codebase `pending` means
 * "stopped at the permission gate": `resolvePendingPerm` (narrator-message-helpers)
 * SYNTHESIZES a PendingPermission from any tool call row it finds in that state, so a
 * re-armed row would sprout a phantom Allow/Deny form on the subagent card even though
 * the work is already executing and nothing is waiting on a decision. Approving that
 * phantom would also drive `narrator_tool_calls` through a permission decision this
 * path never requested.
 *
 * "running" is the honest state here: recovery re-drives the work itself (resumeSubagent /
 * awaitAgentResultDetailed) without ever passing through executeTool's permission gate.
 *
 * Unlike `TOOL_CALL_RERUN_RESET_FIELDS` in narrator-session, no execution target is
 * cleared: Agent/Await are not execution-routed tools (see EXECUTION_ROUTED_TOOLS), so
 * they never re-freeze a target and cannot reach the frozen-target guard. If this path
 * ever covers a routed tool, reset to "initializing" like the re-run path does.
 */
export const TOOL_CALL_RESET_FIELDS = {
	status: "running" as const,
	outputJson: null,
	errorMessage: null,
	permissionDenyMessage: null,
	permissionDecidedBy: null,
	permissionDecidedAt: null,
	permissionDecisionReason: null,
	permissionSuggestions: null,
	completedAt: null,
	durationMs: null,
	executionStartedAt: null,
};

async function findLatestTopLevelMessage(narratorId: string) {
	const rows = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			role: narratorMessages.role,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				isNull(narratorMessages.parentToolUseId),
				inArray(narratorMessages.role, ["user", "assistant"]),
			),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1);
	return rows.length > 0 ? rows[0] : null;
}

/** Map Agent tool_use ids → the subagent narrator they spawned. */
async function loadSubagentsByOriginToolUse(
	toolUseIds: string[],
): Promise<Map<string, RecoverySubagentInput & { title: string | null; variant: string | null }>> {
	const map = new Map<
		string,
		RecoverySubagentInput & { title: string | null; variant: string | null }
	>();
	if (toolUseIds.length === 0) return map;

	const linked = await db
		.select({
			narratorId: narratorMessages.narratorId,
			parentToolUseId: narratorMessages.parentToolUseId,
		})
		.from(narratorMessages)
		.where(inArray(narratorMessages.parentToolUseId, toolUseIds))
		.orderBy(asc(narratorMessages.createdAt));

	const originBySubagent = new Map<string, string>();
	for (const row of linked) {
		if (!row.parentToolUseId) continue;
		if (originBySubagent.has(row.narratorId)) continue;
		originBySubagent.set(row.narratorId, row.parentToolUseId);
	}
	if (originBySubagent.size === 0) return map;

	const rows = await db.query.narrators.findMany({
		where: inArray(narrators.id, [...originBySubagent.keys()]),
		columns: {
			id: true,
			status: true,
			substatus: true,
			isBackground: true,
			title: true,
			variant: true,
		},
	});
	for (const row of rows) {
		const origin = originBySubagent.get(row.id);
		if (!origin) continue;
		if (!isSubagentVariant(row.variant)) continue;
		map.set(origin, row);
	}
	return map;
}

async function resolveOriginToolUseId(subagentId: string): Promise<string | null> {
	const row = await db.query.narratorMessages.findFirst({
		where: and(
			eq(narratorMessages.narratorId, subagentId),
			eq(narratorMessages.role, "user"),
			sql`${narratorMessages.parentToolUseId} IS NOT NULL`,
		),
		columns: { parentToolUseId: true },
		orderBy: [asc(narratorMessages.createdAt)],
	});
	return row?.parentToolUseId ?? null;
}

/**
 * Batched form of {@link resolveOriginToolUseId} for the card path, which resolves origins
 * for up to 50 subagents at once and would otherwise issue one SELECT per subagent.
 * Earliest message wins, matching the single-id ordering.
 */
async function resolveOriginToolUseIds(subagentIds: string[]): Promise<Map<string, string>> {
	const origins = new Map<string, string>();
	if (subagentIds.length === 0) return origins;

	const rows = await db
		.select({
			narratorId: narratorMessages.narratorId,
			parentToolUseId: narratorMessages.parentToolUseId,
		})
		.from(narratorMessages)
		.where(
			and(
				inArray(narratorMessages.narratorId, subagentIds),
				eq(narratorMessages.role, "user"),
				sql`${narratorMessages.parentToolUseId} IS NOT NULL`,
			),
		)
		.orderBy(asc(narratorMessages.createdAt));

	for (const row of rows) {
		if (!row.parentToolUseId || origins.has(row.narratorId)) continue;
		origins.set(row.narratorId, row.parentToolUseId);
	}
	return origins;
}

// === Path A ===

export interface ResumeIncompleteAgentWorkResult {
	/**
	 * True when candidates were found and the recovery flow has taken ownership.
	 * The caller must NOT call continueNarrator itself — the async stage does it
	 * once every tool result has been written back.
	 */
	recovering: boolean;
	items: Array<{ toolUseId: string; toolName: "Agent" | "Await"; targetId: string }>;
}

export function resumeIncompleteAgentWorkForContinue(input: {
	narratorId: string;
	locale: Locale;
	replyInUserLanguage: boolean;
	userId?: string | null;
}): Promise<ResumeIncompleteAgentWorkResult> {
	return recoveryLock.acquire(input.narratorId, () => prepareAndStartRecovery(input));
}

async function prepareAndStartRecovery(input: {
	narratorId: string;
	locale: Locale;
	replyInUserLanguage: boolean;
	userId?: string | null;
}): Promise<ResumeIncompleteAgentWorkResult> {
	const { narratorId } = input;
	const latest = await findLatestTopLevelMessage(narratorId);
	if (!latest || latest.role !== "assistant") return { recovering: false, items: [] };

	const toolCalls = await db.query.narratorToolCalls.findMany({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.messageId, latest.messageId),
		),
		columns: {
			id: true,
			toolUseId: true,
			toolName: true,
			status: true,
			inputJson: true,
			outputJson: true,
			messageId: true,
		},
	});
	if (toolCalls.length === 0) return { recovering: false, items: [] };

	const agentToolUseIds = toolCalls
		.filter((tc) => tc.toolName === "Agent")
		.map((tc) => tc.toolUseId);
	const subagentByOrigin = await loadSubagentsByOriginToolUse(agentToolUseIds);
	const candidates = selectRecoverableToolCalls(toolCalls, subagentByOrigin);
	if (candidates.length === 0) return { recovering: false, items: [] };

	// Indexed once: a linear scan per candidate is O(candidates × toolCalls) over rows
	// that carry recorded tool input.
	const toolCallsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));

	// Re-arm each row so buildHistory does not treat the stale result as final.
	// Broadcasting tool_started puts the card back into its running visual state.
	for (const candidate of candidates) {
		await db
			.update(narratorToolCalls)
			.set(TOOL_CALL_RESET_FIELDS)
			.where(eq(narratorToolCalls.id, candidate.toolCallId));
		const source = toolCallsById.get(candidate.toolCallId);
		broadcastToNarrator(narratorId, {
			type: "tool_started",
			narratorId,
			toolCallId: candidate.toolCallId,
			toolUseId: candidate.toolUseId,
			toolName: candidate.kind === "agent" ? "Agent" : "Await",
			input: source?.inputJson ?? {},
		});
	}

	// Hold the narrator in `working` for the whole async stage so the existing
	// isLoopRunning/status guards reject repeated clicks.
	await narratorService.updateStatus(narratorId, "working", {
		substatus: [],
		setTurnStart: true,
	});

	// The stage runs without an activeNarrators entry (no agent loop yet), so its own
	// controller is the ONLY thing Interrupt can reach. Registering it the same way the
	// planned-update recovery does makes `interruptNarrator` abort the in-flight awaits
	// instead of leaving the user stuck until the Await timeout.
	const { registerPlannedUpdateRecoveryController } = await import("./narrator-session");
	const controller = new AbortController();
	const registration = registerPlannedUpdateRecoveryController(narratorId, controller, undefined, {
		// A foreground Agent candidate is re-driven in place, so interrupting the parent
		// must also stop the subagent it is waiting on.
		interruptForegroundSubagents: candidates.some((candidate) => candidate.kind === "agent"),
	});

	void runRecoveryStage(input, candidates, controller.signal)
		.catch((err) => {
			logger.error("Subagent recovery stage failed", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		})
		.finally(async () => {
			registration.unregister();
			// Only after the claim is gone can an orphaned queue be recognized as such.
			await drainQueuedMessagesAfterRecoveryStage(
				narratorId,
				input.locale,
				input.replyInUserLanguage,
			);
		});

	return {
		recovering: true,
		items: candidates.map((candidate) => ({
			toolUseId: candidate.toolUseId,
			toolName: candidate.kind === "agent" ? ("Agent" as const) : ("Await" as const),
			targetId: candidate.targetId,
		})),
	};
}

async function runRecoveryStage(
	input: {
		narratorId: string;
		locale: Locale;
		replyInUserLanguage: boolean;
		userId?: string | null;
	},
	candidates: RecoverableToolCall[],
	signal: AbortSignal,
): Promise<void> {
	const { narratorId, locale } = input;
	try {
		await Promise.all(
			candidates.map((candidate) =>
				driveRecoveryCandidate(input, candidate, signal).catch(() => {}),
			),
		);
	} finally {
		// A tool_use without a tool_result makes the provider reject the whole request
		// (HTTP 400), so a row whose result write failed must not reach continueNarrator.
		await settleUnfinishedCandidates(narratorId, candidates);
		const { continueNarrator } = await import("./narrator-session");
		const continued = await continueNarrator(
			narratorId,
			locale,
			input.replyInUserLanguage,
			input.userId,
		).catch((err) => {
			logger.error("continueNarrator after subagent recovery failed", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
			return { ok: false };
		});
		if (!continued.ok) {
			await narratorService
				.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: "Subagent recovery finished but the narrator could not be continued.",
				})
				.catch(() => {});
		}
	}
}

/**
 * Consume messages a user queued while a recovery stage held this narrator busy.
 *
 * The stages below run with no `activeNarrators` entry and instead claim the narrator's
 * runtime, which is what lets `pushBufferedMessage` accept input for them (see
 * `canQueueForNarrator`). Normally the queue's owner is the loop that `continueNarrator`
 * starts at the end of the stage — but when that call fails the stage settles the narrator
 * to `idle`/error and releases the claim, leaving the queue with nobody to consume it.
 *
 * Must run AFTER `registration.unregister()`: while the claim is live
 * `resumeBufferedMessagesIfIdle` correctly declines, since a claim means an owner exists.
 *
 * Best-effort — a failure here must not turn a completed recovery into a reported failure,
 * and the resume helper itself declines whenever another owner appeared or the narrator
 * must not be woken.
 */
async function drainQueuedMessagesAfterRecoveryStage(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage: boolean,
): Promise<void> {
	try {
		const { resumeBufferedMessagesIfIdle } = await import("./narrator-session");
		await resumeBufferedMessagesIfIdle(narratorId, locale, replyInUserLanguage);
	} catch (err) {
		logger.warn("Failed to resume queued messages after a subagent recovery stage", {
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Await `promise`, but give up early once `signal` aborts.
 *
 * The underlying work keeps its own ownership of the tool-call row; this only releases the
 * parent's wait so an interrupt does not have to sit through the full Await timeout. The
 * listener is always removed, so a long-lived signal cannot accumulate handlers.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (!signal.aborted && typeof signal.addEventListener !== "function") return promise;
	if (signal.aborted) return Promise.reject(new Error("Subagent recovery interrupted"));
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = () => reject(new Error("Subagent recovery interrupted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * Force a terminal result onto any candidate row that is still non-terminal.
 *
 * `driveRecoveryCandidate` writes a result on every path, but that write can itself fail
 * (SQLite busy, crash between the drive and the write). Since the very next step replays
 * the turn to the provider, a row left at `pending` would produce a tool_use with no
 * matching tool_result and the request would be rejected outright. Converging here keeps
 * the replayed packet structurally valid even when persistence misbehaved.
 */
async function settleUnfinishedCandidates(
	narratorId: string,
	candidates: RecoverableToolCall[],
): Promise<void> {
	if (candidates.length === 0) return;
	let rows: Array<{ id: string; toolUseId: string; status: string; messageId: string | null }>;
	try {
		rows = await db
			.select({
				id: narratorToolCalls.id,
				toolUseId: narratorToolCalls.toolUseId,
				status: narratorToolCalls.status,
				messageId: narratorToolCalls.messageId,
			})
			.from(narratorToolCalls)
			.where(
				inArray(
					narratorToolCalls.id,
					candidates.map((candidate) => candidate.toolCallId),
				),
			);
	} catch (err) {
		logger.error("Could not verify recovered tool results before continuing", {
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	for (const row of rows) {
		if (!NON_TERMINAL_TOOL_CALL_STATUSES.has(row.status)) continue;
		const errorMessage = "Recovery failed: the result of this tool call could not be persisted.";
		logger.warn("Forcing a terminal result onto an unsettled recovered tool call", {
			narratorId,
			toolUseId: row.toolUseId,
			status: row.status,
		});
		await narratorService
			.updateToolCallResult(
				row.toolUseId,
				{ output: errorMessage, status: "fail", errorMessage, completedAt: Date.now() },
				row.messageId ?? undefined,
				row.id,
			)
			.catch((err) => {
				// Nothing else can be done here; startup recovery fails leftover rows on boot.
				logger.error("Failed to force a terminal recovered tool result", {
					narratorId,
					toolUseId: row.toolUseId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}
}

async function driveRecoveryCandidate(
	input: { narratorId: string; locale: Locale; userId?: string | null },
	candidate: RecoverableToolCall,
	signal: AbortSignal,
): Promise<void> {
	const { narratorId, locale } = input;
	let output: unknown;
	let status: "success" | "fail" = "success";
	let errorMessage: string | undefined;

	try {
		if (candidate.kind === "agent") {
			const { resumeSubagent } = await import("./subagent-resume");
			const resumed = await resumeSubagent({
				subagentId: candidate.targetId,
				intent: "continue_tool_results",
				actor: "user",
				locale,
				createdBy: input.userId ?? null,
				allowRunningRestart: true,
				skipStaleAttach: true,
				// No preserveBackground / skipConclusionDelivery: let
				// deliverCompletedResume → updateToolCallConclusion publish the
				// result straight back into this Agent tool call.
			});
			if (!resumed.started || !resumed.terminalCompletion) {
				throw new Error("Subagent continuation did not expose a terminal completion");
			}
			// Stop waiting as soon as the user interrupts. The subagent itself is stopped by
			// interruptNarrator's foreground fan-out, and its own completion path still owns
			// the tool-call row, so the parent only needs to abandon the wait here.
			await raceAbort(resumed.terminalCompletion, signal);
			// updateToolCallConclusion already wrote the row; do not overwrite it.
			return;
		}

		const [
			{ awaitAgentResultDetailed },
			{ buildRecoveredAwaitToolOutput },
			{ DEFAULT_AWAIT_TIMEOUT_MS },
		] = await Promise.all([
			import("./agent-communication"),
			import("./update-recovery-service"),
			import("../lib/agent/tools/await"),
		]);
		const result = await awaitAgentResultDetailed({
			callerNarratorId: narratorId,
			id: candidate.targetId,
			timeoutMs: DEFAULT_AWAIT_TIMEOUT_MS,
			signal,
		});
		output = buildRecoveredAwaitToolOutput(candidate.targetId, result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		status = "fail";
		errorMessage = `Recovery failed: ${message}`;
		output = errorMessage;
		logger.warn("Subagent recovery candidate failed", {
			narratorId,
			toolUseId: candidate.toolUseId,
			kind: candidate.kind,
			error: message,
		});
	}

	// A row left non-terminal would be silently dropped by buildHistory, so the
	// result write must happen on every path.
	await narratorService
		.updateToolCallResult(
			candidate.toolUseId,
			{ output, status, errorMessage, completedAt: Date.now() },
			candidate.messageId ?? undefined,
			candidate.toolCallId,
		)
		.catch((err) => {
			logger.error("Failed to persist recovered tool result", {
				narratorId,
				toolUseId: candidate.toolUseId,
				error: err instanceof Error ? err.message : String(err),
			});
		});

	broadcastToNarrator(narratorId, {
		type: "tool_completed",
		narratorId,
		toolCallId: candidate.toolCallId,
		toolUseId: candidate.toolUseId,
		toolName: candidate.kind === "agent" ? "Agent" : "Await",
		status,
		output,
	});
}

// === Path B: recovery card ===

export interface SubagentRecoveryCardEntry extends RecoveryCardCandidate {}

/**
 * Insert the UI-only recovery card listing error subagents that Path A does not
 * cover. Fire-and-forget from `updateStatus`; never throws into the caller.
 */
export async function persistSubagentRecoveryCard(narratorId: string): Promise<boolean> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { id: true, variant: true, turnStartedAt: true },
	});
	if (!narrator || isSubagentVariant(narrator.variant)) return false;

	const nowMs = Date.now();
	const turnStartedAtMs = narrator.turnStartedAt ? Date.parse(narrator.turnStartedAt) : Number.NaN;
	// The turn that just failed is the relevant scope. Fall back to the 24h window
	// only when the turn start is unknown.
	const cutoffMs = Number.isFinite(turnStartedAtMs)
		? Math.max(nowMs - RECOVERY_CARD_WINDOW_MS, turnStartedAtMs)
		: nowMs - RECOVERY_CARD_WINDOW_MS;
	// SQL prefilter on updatedAt, not createdAt: selecting by spawn time pulled in every
	// subagent a long session ever started. It stays a PREFILTER only — `updatedAt` is
	// the last write from any source, so it is an upper bound on the failure time and can
	// only ever be too generous, never too strict (any row whose real failure time is
	// within the cutoff necessarily has `updatedAt >= cutoff`). The precise decision is
	// made in-memory by recoveryFailureTimeMs, which prefers the substatus timing tag.
	const rows = await db.query.narrators.findMany({
		where: and(
			eq(narrators.parentNarratorId, narratorId),
			eq(narrators.status, "idle"),
			gte(narrators.updatedAt, new Date(cutoffMs).toISOString()),
		),
		columns: {
			id: true,
			status: true,
			substatus: true,
			isBackground: true,
			title: true,
			subagentType: true,
			variant: true,
			errorMessage: true,
			traits: true,
			createdAt: true,
			updatedAt: true,
		},
		limit: 50,
	});
	if (rows.length === 0) return false;

	const latest = await findLatestTopLevelMessage(narratorId);
	const latestTurnToolUseIds = new Set<string>();
	if (latest?.role === "assistant") {
		const latestAgentCalls = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.messageId, latest.messageId),
				eq(narratorToolCalls.toolName, "Agent"),
			),
			columns: { toolUseId: true },
		});
		for (const call of latestAgentCalls) latestTurnToolUseIds.add(call.toolUseId);
	}

	const subagentRows = rows.filter((row) => isSubagentVariant(row.variant));
	const origins = await resolveOriginToolUseIds(subagentRows.map((row) => row.id));
	const withOrigin: RecoveryCardSubagentInput[] = subagentRows.map((row) => ({
		...row,
		originToolUseId: origins.get(row.id) ?? null,
	}));
	const byId = new Map(withOrigin.map((row) => [row.id, row]));

	const candidates = selectRecoveryCardCandidates(withOrigin, {
		nowMs,
		turnStartedAtMs: Number.isFinite(turnStartedAtMs) ? turnStartedAtMs : null,
		latestTurnToolUseIds,
	});
	if (candidates.length === 0) return false;

	await narratorService.persistDisplayMessage(
		narratorId,
		`[Subagent recovery] ${candidates.length} subagent(s) stopped with an error.`,
		[{ type: "subagent_recovery", status: "pending", subagents: candidates }],
	);
	// Watermark AFTER the card exists, so a failed insert leaves the offer open.
	// Without this, the next narrator error rebuilds the very same card and the user
	// is asked about the same dead subagents over and over.
	await markRecoveryOffered(
		candidates.map((candidate) => {
			const row = byId.get(candidate.id);
			return { id: candidate.id, failedAtMs: row ? recoveryFailureTimeMs(row) : null };
		}),
	);
	return true;
}

/**
 * Build the column patch that stamps the watermark onto one subagent row.
 *
 * ⚠️ THIS MUST NEVER WRITE `updatedAt`, and the omission is deliberate — do not
 * "fix" it to match the rest of the codebase.
 *
 * `updatedAt` is the fallback failure timestamp of this whole mechanism (see
 * {@link recoveryFailureTimeMs}). Touching it here would move the recorded failure
 * time forward to the moment the card was OFFERED, so on the next narrator error the
 * comparison `failedMs <= offeredAtMs` would flip to false for every row we just
 * watermarked and the card would re-propose the very same dead subagents — the exact
 * bug the watermark exists to prevent. It would also keep resurrecting stale failures
 * into the 24h window forever.
 *
 * `narrator-subagent-recovery.test.ts` asserts both that this patch carries no
 * `updatedAt` key and that a real watermark write leaves the stored value untouched.
 */
export function buildRecoveryOfferedUpdate(
	traits: unknown,
	failedAtMs: number,
): { traits: string[] } {
	return { traits: withRecoveryOfferedTrait(traits, failedAtMs) };
}

/**
 * Stamp the "already offered" watermark on the subagents a card just listed.
 *
 * Serialized through {@link narratorTraitsLock}, the same per-narrator lock every other
 * trait writer uses (`updateNarratorTraits` in routes/narrators, narrator-plan-mode,
 * pipeline-state). `traits` is a whole-column JSON array, so an unlocked
 * read-modify-write here would silently drop a concurrent write — e.g. a user editing
 * this subagent's disabled-tools at the same moment.
 *
 * Two-phase on purpose: one batched read decides which rows still need a write, then
 * only those take the lock and re-read. On the common repeat path (rows already
 * watermarked at this failure time) the batch read is the only query, instead of a
 * select + update per candidate. Row count is bounded by the card's 50-candidate cap.
 *
 * Best-effort per row: a failed write only means that subagent may be offered once
 * more, which is far better than skipping the whole batch.
 */
export async function markRecoveryOffered(
	entries: Array<{ id: string; failedAtMs: number | null }>,
): Promise<void> {
	const wanted = new Map<string, number>();
	for (const entry of entries) {
		if (entry.failedAtMs == null) continue;
		wanted.set(entry.id, entry.failedAtMs);
	}
	if (wanted.size === 0) return;

	let existing: Array<{ id: string; traits: unknown }>;
	try {
		existing = await db.query.narrators.findMany({
			where: inArray(narrators.id, [...wanted.keys()]),
			columns: { id: true, traits: true },
		});
	} catch (err) {
		logger.warn("Failed to read traits before watermarking offered recovery subagents", {
			count: wanted.size,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	for (const row of existing) {
		const failedAtMs = wanted.get(row.id);
		if (failedAtMs == null) continue;
		// Already watermarked at (or past) this failure — nothing to write.
		const offeredAtMs = parseRecoveryOfferedAtMs(row.traits);
		if (offeredAtMs != null && offeredAtMs >= failedAtMs) continue;
		try {
			await narratorTraitsLock.acquire(row.id, async () => {
				// Re-read INSIDE the lock: the batched read above may be stale by now, and
				// writing from it would clobber whatever landed in between.
				const current = await db.query.narrators.findFirst({
					where: eq(narrators.id, row.id),
					columns: { traits: true },
				});
				if (!current) return;
				await db
					.update(narrators)
					.set(buildRecoveryOfferedUpdate(current.traits, failedAtMs))
					.where(eq(narrators.id, row.id));
			});
		} catch (err) {
			logger.warn("Failed to watermark an offered recovery subagent", {
				subagentId: row.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

export interface ResumeRecoverySubagentsResult {
	resumed: string[];
	skipped: Array<{ id: string; reason: string }>;
}

/**
 * Undo the "running background task" claim after a restart failed to take off.
 *
 * Leaving `backgroundStatus: "running"` behind would make the row look like live work:
 * `Await` would wait for a result that can never arrive, and a later recovery pass would
 * see a task that is already running and skip it.
 */
async function clearBackgroundRunningClaim(subagentId: string): Promise<void> {
	await db
		.update(narrators)
		.set({ backgroundStatus: null, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, subagentId))
		.catch((err) => {
			logger.error("Failed to clear the background claim of an unstarted subagent", {
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
}

/**
 * Restart the selected subagents as BACKGROUND tasks.
 *
 * `preserveBackground` only means "do not clear the background flags"; a
 * foreground subagent must be marked background explicitly (mirrors
 * subagent-detach's restoreAttachedSubagentToBackground).
 */
export async function resumeRecoverySubagents(input: {
	narratorId: string;
	subagentIds: string[];
	locale: Locale;
	userId?: string | null;
}): Promise<ResumeRecoverySubagentsResult> {
	const resumed: string[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];

	for (const subagentId of input.subagentIds) {
		try {
			const subagent = await db.query.narrators.findFirst({
				where: eq(narrators.id, subagentId),
				columns: {
					id: true,
					variant: true,
					status: true,
					parentNarratorId: true,
					isBackground: true,
					subagentType: true,
					title: true,
					traits: true,
				},
			});
			if (!subagent || subagent.parentNarratorId !== input.narratorId) {
				skipped.push({ id: subagentId, reason: "not_a_child" });
				continue;
			}
			if (!isSubagentVariant(subagent.variant)) {
				skipped.push({ id: subagentId, reason: "not_a_subagent" });
				continue;
			}
			if (subagent.status !== "idle") {
				skipped.push({ id: subagentId, reason: `status_${subagent.status}` });
				continue;
			}
			const originToolUseId = await resolveOriginToolUseId(subagentId);
			if (!originToolUseId) {
				skipped.push({ id: subagentId, reason: "origin_tool_call_missing" });
				continue;
			}

			const title = subagent.title?.trim() || subagentId;
			const subagentType = subagent.subagentType?.trim() || "general";

			// a) stable alias so the model can Await it later. `title` may itself be the
			//    id (untitled subagent); the alias builder recognizes that and falls back
			//    to a short id instead of slugifying the whole nanoid.
			const { alias } = await registerAndPersistSubagentAlias(input.narratorId, subagentId, title);
			// b) durable background task row (idempotent restart when it exists)
			await backgroundTaskService.createAgentTask({
				id: subagentId,
				parentNarratorId: input.narratorId,
				subagentNarratorId: subagentId,
				subagentType,
				toolUseId: originToolUseId,
				alias,
				title,
			});
			// c) mark the narrator itself as background (detach's job, done by hand).
			//    Under narratorTraitsLock with a fresh read, because `traits` is a whole-column
			//    JSON array: writing the copy fetched at the top of this iteration would drop
			//    any trait written since (including the watermark this very card just stamped).
			//    `updatedAt` IS written here on purpose — unlike the watermark, this row is
			//    being resumed, so its old failure time is no longer the relevant one.
			await narratorTraitsLock.acquire(subagentId, async () => {
				const current = await db.query.narrators.findFirst({
					where: eq(narrators.id, subagentId),
					columns: { traits: true },
				});
				await db
					.update(narrators)
					.set({
						isBackground: true,
						backgroundStatus: "running",
						backgroundResult: null,
						backgroundCompletedAt: null,
						traits: [
							...new Set([...parseTraits(current?.traits ?? subagent.traits), "background"]),
						],
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, subagentId));
			});

			// d) restart, keeping background semantics and leaving the historical
			//    Agent tool_result untouched.
			const { resumeSubagent } = await import("./subagent-resume");
			const started = await resumeSubagent({
				subagentId,
				intent: "continue_tool_results",
				actor: "parent_agent",
				locale: input.locale,
				createdBy: input.userId ?? null,
				abortController: new AbortController(),
				allowRunningRestart: true,
				skipStaleAttach: true,
				preserveBackground: true,
				skipConclusionDelivery: true,
			}).catch(async (err) => {
				// (c) already advertised this subagent as a running background task. If the
				// restart never happens, that claim has to be withdrawn, or `Await` would
				// block on a task nobody is driving.
				await clearBackgroundRunningClaim(subagentId);
				throw err;
			});
			if (!started.started) {
				await clearBackgroundRunningClaim(subagentId);
				skipped.push({ id: subagentId, reason: "resume_not_started" });
				continue;
			}
			void started.terminalCompletion?.catch((err) => {
				logger.warn("Recovered background subagent failed", {
					subagentId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
			resumed.push(alias);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("Failed to resume recovery subagent", { subagentId, error: message });
			skipped.push({ id: subagentId, reason: message });
		}
	}

	return { resumed, skipped };
}

/** Flip the card block to its resolved state and push the update to clients. */
export async function markRecoveryCardResolved(input: {
	narratorId: string;
	messageId: string;
	mode: "notify" | "await";
	resumedAliases: string[];
}): Promise<void> {
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, input.messageId),
		columns: { id: true, contentJson: true },
	});
	if (!message) return;
	const blocks = Array.isArray(message.contentJson) ? [...message.contentJson] : [];
	const index = blocks.findIndex(
		(block) => (block as { type?: string } | null)?.type === "subagent_recovery",
	);
	if (index < 0) return;
	blocks[index] = {
		...(blocks[index] as Record<string, unknown>),
		status: "resolved",
		mode: input.mode,
		resumedCount: input.resumedAliases.length,
	};

	await db
		.update(narratorMessages)
		.set({ contentJson: blocks })
		.where(eq(narratorMessages.id, input.messageId));
	sqlite
		.prepare("UPDATE narrators SET message_version = message_version + 1 WHERE id = ?")
		.run(input.narratorId);

	const updated = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, input.messageId),
	});
	if (!updated) return;
	broadcastToNarrator(input.narratorId, {
		type: "message_updated",
		narratorId: input.narratorId,
		message: { ...updated, children: [] },
	});
}

export function buildRecoveryNotifyPrompt(entries: Array<{ alias: string }>): string {
	const lines = entries.map((entry) => `- ${entry.alias}`).join("\n");
	return (
		"[System] The following background agents were restarted after a narrator error:\n" +
		`${lines}\n` +
		'Use Await({ type: "agent", id: "<alias>" }) to collect each result before continuing.'
	);
}

/**
 * "Resume and wait": synthesize one assistant turn holding N `Await` tool_use
 * blocks, run them server-side, then continue ONCE so the model sees every
 * result in a single request.
 */
export async function startRecoveryAwaitBatch(input: {
	narratorId: string;
	aliases: string[];
	locale: Locale;
	replyInUserLanguage: boolean;
	userId?: string | null;
}): Promise<{ messageId: string; toolUseIds: string[] }> {
	const { DEFAULT_AWAIT_TIMEOUT_MS } = await import("../lib/agent/tools/await");
	const blocks = input.aliases.map((alias) => ({
		type: "tool_use",
		id: `toolu_recover_${generateShortId()}`,
		name: "Await",
		input: { type: "agent", id: alias, timeout: DEFAULT_AWAIT_TIMEOUT_MS },
	}));

	const message = await narratorService.persistAssistantMessage(input.narratorId, {
		uuid: generateId(),
		session_id: generateId(),
		parent_tool_use_id: null,
		// A leading text block keeps this synthetic turn acceptable to OpenAI-compatible
		// endpoints, which reject an assistant message made purely of tool calls, and it
		// also explains in the transcript why these awaits appeared on their own.
		message: {
			content: [
				{
					type: "text",
					text: `Collecting results from ${input.aliases.length} restarted background agent(s).`,
				},
				...blocks,
			],
		},
	});

	const persisted = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, message.id),
		with: { toolCalls: true },
	});
	const toolCallIdByUseId = new Map<string, string>();
	for (const call of persisted?.toolCalls ?? []) {
		toolCallIdByUseId.set(call.toolUseId, call.id);
	}
	broadcastToNarrator(input.narratorId, {
		type: "message",
		narratorId: input.narratorId,
		message: { ...(persisted ?? message), seq: message.seq, children: [] },
	});
	for (const block of blocks) {
		broadcastToNarrator(input.narratorId, {
			type: "tool_started",
			narratorId: input.narratorId,
			toolCallId: toolCallIdByUseId.get(block.id) ?? null,
			toolUseId: block.id,
			toolName: "Await",
			input: block.input,
		});
	}

	await narratorService.updateStatus(input.narratorId, "working", {
		substatus: [],
		setTurnStart: true,
	});

	// Same reasoning as the Path A stage: this batch runs with no activeNarrators entry,
	// so a registered controller is the ONLY thing Interrupt can reach. Without it the
	// user's interrupt does nothing and they sit through the full Await timeout.
	// `interruptForegroundSubagents` stays false — these awaits own only the parent-side
	// wait, and the resumed background agents should keep running.
	const { registerPlannedUpdateRecoveryController } = await import("./narrator-session");
	const controller = new AbortController();
	const registration = registerPlannedUpdateRecoveryController(
		input.narratorId,
		controller,
		undefined,
		{ interruptForegroundSubagents: false },
	);

	void runRecoveryAwaitBatch(
		{
			narratorId: input.narratorId,
			messageId: message.id,
			locale: input.locale,
			replyInUserLanguage: input.replyInUserLanguage,
			userId: input.userId,
			entries: blocks.map((block, index) => ({
				toolUseId: block.id,
				toolCallId: toolCallIdByUseId.get(block.id) ?? null,
				alias: input.aliases[index],
			})),
		},
		controller.signal,
	)
		.catch((err) => {
			logger.error("Recovery await batch failed", {
				narratorId: input.narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		})
		.finally(async () => {
			registration.unregister();
			// Only after the claim is gone can an orphaned queue be recognized as such.
			await drainQueuedMessagesAfterRecoveryStage(
				input.narratorId,
				input.locale,
				input.replyInUserLanguage,
			);
		});

	return { messageId: message.id, toolUseIds: blocks.map((block) => block.id) };
}

async function runRecoveryAwaitBatch(
	input: {
		narratorId: string;
		messageId: string;
		locale: Locale;
		replyInUserLanguage: boolean;
		userId?: string | null;
		entries: Array<{ toolUseId: string; toolCallId: string | null; alias: string }>;
	},
	signal: AbortSignal,
): Promise<void> {
	const [{ awaitAgentResultDetailed }, { buildRecoveredAwaitToolOutput }] = await Promise.all([
		import("./agent-communication"),
		import("./update-recovery-service"),
	]);

	try {
		await Promise.all(
			input.entries.map(async (entry, index) => {
				let output: unknown;
				let status: "success" | "fail" = "success";
				let errorMessage: string | undefined;
				try {
					// The caller's registered signal, not a throwaway controller: an interrupt has
					// to be able to release this wait. Every branch still writes a terminal result
					// below, so an aborted await cannot leave a tool_use without a tool_result.
					const result = await awaitAgentResultDetailed({
						callerNarratorId: input.narratorId,
						id: entry.alias,
						signal,
					});
					output = buildRecoveredAwaitToolOutput(entry.alias, result);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					status = "fail";
					errorMessage = `Await failed: ${message}`;
					output = errorMessage;
				}
				await narratorService
					.updateToolCallResult(
						entry.toolUseId,
						{
							output,
							status,
							errorMessage,
							completedAt: Date.now(),
							// Only the final write needs to bump the version.
							bumpMessageVersion: index === input.entries.length - 1,
						},
						input.messageId,
					)
					.catch((err) => {
						logger.error("Failed to persist recovery await result", {
							narratorId: input.narratorId,
							toolUseId: entry.toolUseId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				broadcastToNarrator(input.narratorId, {
					type: "tool_completed",
					narratorId: input.narratorId,
					toolCallId: entry.toolCallId,
					toolUseId: entry.toolUseId,
					toolName: "Await",
					status,
					output,
				});
			}),
		);
	} finally {
		const { continueNarrator } = await import("./narrator-session");
		const continued = await continueNarrator(
			input.narratorId,
			input.locale,
			input.replyInUserLanguage,
			input.userId,
		).catch((err) => {
			logger.error("continueNarrator after recovery await batch failed", {
				narratorId: input.narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
			return { ok: false };
		});
		if (!continued.ok) {
			await narratorService
				.updateStatus(input.narratorId, "idle", {
					substatus: ["error"],
					errorMessage: "Recovery awaits finished but the narrator could not be continued.",
				})
				.catch(() => {});
		}
	}
}

// Note on process-exit safety: the async recovery stage may leave a re-armed
// tool call at "pending" if the process dies mid-flight. No extra convergence
// pass is needed — `recoverNarratorsOnStartup` already fails every
// initializing/pending/running tool call on boot (narrator-session.ts), which
// puts the row into the `fail` state that Path A's own filter accepts. The user
// can simply click Continue again.
