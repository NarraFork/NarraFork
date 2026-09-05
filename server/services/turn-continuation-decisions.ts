/**
 * Pure end-of-pass decisions shared by both orchestration loops.
 *
 * The repository's established seam for loop decisions is a pure function (see
 * `planSubagentCompactRestart`, `planSubagentPaymentRequired`,
 * `planSubagentSilentDisconnect`): the loop bodies themselves depend on far too much to
 * instantiate in a test, and driving them end-to-end needs `mock.module`, which in Bun is
 * process-wide pollution rather than per-suite setup. Extracting the decision leaves the
 * loop body holding only the effects.
 *
 * A decision belongs here — rather than beside one loop — when both audiences reach the
 * SAME conclusion from the same inputs. Where the conclusions genuinely differ (a primary
 * narrator may park in `payment_required` and wait for a top-up; a subagent owes its
 * parent a `tool_result` and must fail with a stated reason), the difference is real and
 * the functions stay separate. See `turn-continuation-registry.ts` for the inventory and
 * for which audience handles what.
 */

import type { AutoContinuationMode } from "../lib/boolean-override";
import { getBlockedTaskActionInstruction, type Locale } from "../lib/prompt-i18n";
import type { ExecuteLoopResult } from "./narrator-executor";

/**
 * How many consecutive completion-limit / resumable-error continuations one response turn
 * may drive before giving up.
 *
 * Shared by both loops, which previously declared it twice with the same value — the kind
 * of duplication that stays correct right up until somebody tunes one of them.
 */
export const MAX_TURN_INTERRUPTION_RETRIES = 3;

export type TurnInterruptionPlan =
	/** Not interrupted (or suppressed): reset the counter and fall through. */
	| { action: "none"; retries: 0 }
	/** Retry budget exhausted: stop continuing, but the pass itself is not an error. */
	| {
			action: "stop";
			retries: number;
			reason: NonNullable<ExecuteLoopResult["interruptedReason"]>;
	  }
	/** Re-send the interrupted tool-result packet unchanged. */
	| {
			action: "replay";
			retries: number;
			reason: NonNullable<ExecuteLoopResult["interruptedReason"]>;
	  }
	/** Persist a continuation prompt and drive a pass for it. */
	| {
			action: "prompt";
			retries: number;
			reason: NonNullable<ExecuteLoopResult["interruptedReason"]>;
			promptKey: "interruptionContinue" | "resumeAfterTransientError";
	  };

/**
 * Decide how a provider-interrupted partial turn should continue.
 *
 * `interrupted` covers two causes that resume identically and differ only in the prompt
 * the model is shown: `completion_limit` (the provider hit its own max output tokens) and
 * `resumable_error` (a transient failure landed after partial output was already
 * produced). Defaulting the reason to `completion_limit` matches the flag's own
 * documented default for callers that only ever checked `interrupted`.
 *
 * `suppressed` folds together the two ways a caller declines to continue at all — the
 * primary loop's `!active.alive` and the subagent's `signal.aborted`. Both mean the same
 * thing here: something else owns the run's ending, so reset the counter and let the
 * normal termination path run. It must produce `retries: 0` rather than preserving the
 * count, since the next continuation attempt belongs to a different turn.
 */
export function planTurnInterruption(
	result: Pick<
		ExecuteLoopResult,
		"interrupted" | "interruptedReason" | "shouldReplayInterruptedToolResultTurn"
	>,
	previousRetries: number,
	options?: { suppressed?: boolean; maxRetries?: number },
): TurnInterruptionPlan {
	if (options?.suppressed || !result.interrupted) return { action: "none", retries: 0 };
	const maxRetries = options?.maxRetries ?? MAX_TURN_INTERRUPTION_RETRIES;
	const reason = result.interruptedReason ?? "completion_limit";
	const retries = previousRetries + 1;
	if (retries > maxRetries) return { action: "stop", retries, reason };
	if (result.shouldReplayInterruptedToolResultTurn) return { action: "replay", retries, reason };
	return {
		action: "prompt",
		retries,
		reason,
		promptKey: reason === "resumable_error" ? "resumeAfterTransientError" : "interruptionContinue",
	};
}

/**
 * How many consecutive no-progress self-continuations are allowed before the loop
 * stops nudging itself.
 *
 * "No progress" is deliberately narrow (see {@link computeContinuationStallState}):
 * a pass that ran a tool resets the count, so this bound only bites on a model that
 * answers the reminder with prose, or that keeps attempting the same rejected
 * protected-task mutation.
 */
export const MAX_CONTINUATION_STALL_TURNS = 3;

export interface ContinuationStallState {
	count: number;
	key?: string;
	suppressed: boolean;
}

/**
 * Classify whether a finished continuation pass made progress, and whether further
 * self-continuation must stop.
 *
 * ## Why this is the ONLY bound on spec/max-turns continuation
 *
 * Each continuation pass gets a fresh turn budget, so nothing about turn counts can
 * bound a loop that re-continues after exhausting one. What bounds it is progress:
 * either the model called a tool (real work happened, so continuing is justified) or
 * it did not (the reminder produced nothing, so repeating it will keep producing
 * nothing). A repeated identical `taskReflection` denial is the same story with a
 * different signature: the model keeps trying one rejected protected-task mutation.
 *
 * ## Purity is load-bearing
 *
 * The function reads nothing but its arguments — in particular NOT the caller's state
 * container. The primary loop stores the counters on its `ActiveNarrator`; a subagent
 * has no such object and keeps them in run-local variables, which is a tighter scope
 * (its run IS the bound's natural lifetime) and works only because the rule itself
 * holds no state. Both audiences therefore share one bound rather than each inventing
 * one.
 *
 * `previous` is the caller's last returned state. A different key restarts the count,
 * which is what makes "a new kind of stall" distinguishable from "the same stall
 * again".
 */
export function computeContinuationStallState(
	kind: "task" | "blocked",
	result: Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint">,
	previous: Pick<ContinuationStallState, "count" | "key">,
): ContinuationStallState {
	const denialFingerprint = result.taskReflectionDenialFingerprint?.trim();
	const stallKey = denialFingerprint
		? `task-reflection:${denialFingerprint}`
		: result.hadToolUses
			? undefined
			: `no-tools:${kind}`;
	if (!stallKey) return { count: 0, key: undefined, suppressed: false };

	const count = previous.key === stallKey ? previous.count + 1 : 1;
	const limit = kind === "blocked" ? 1 : MAX_CONTINUATION_STALL_TURNS;
	return { count, key: stallKey, suppressed: count >= limit };
}

/**
 * The reason a subagent pass is being followed by another one.
 *
 * Two producers, one bound: `spec` is an open `doing`/`blocked` task in the subagent's
 * OWN Dynamic Spec, `maxTurns` is a pass that spent its turn budget with spec work
 * still open. They are separate because the text the model is shown differs, and
 * because the max-turns case has to state that the budget — not the work — is what
 * ended the pass.
 */
export type SubagentContinuationCause = "spec" | "maxTurns";

/**
 * How many self-continuations one subagent RUN may drive in total, across both causes.
 *
 * The stall counter alone is not sufficient here. It only counts *consecutive*
 * no-progress passes, so a subagent that alternates "run a tool, get reminded, run a
 * tool" never trips it — which is correct for a primary narrator (a human is watching,
 * and the session is meant to be long-lived) and wrong for a subagent, whose run holds
 * its parent's tool call open the entire time. This cap is the wall-clock-ish backstop:
 * a subagent that has taken this many extra passes is no longer "finishing up", and its
 * parent deserves an answer plus the option to dispatch again.
 *
 * Counted per run rather than per cause so the two causes cannot take turns exhausting
 * separate budgets.
 */
export const MAX_SUBAGENT_CONTINUATION_PASSES = 6;

/** Run-local continuation state for a subagent. The subagent's equivalent of the
 * `ActiveNarrator` stall fields, scoped to one run because that is the bound's lifetime. */
export interface SubagentContinuationState {
	/** Total continuation passes this run has already started, for either cause. */
	passes: number;
	/** Last stall classification, threaded back into `computeContinuationStallState`. */
	stall: { count: number; key?: string };
	/**
	 * Set when the pass that just ran was itself a granted continuation, recording which
	 * KIND was granted.
	 *
	 * Load-bearing, and the primary loop has the same thing in `_continuationTurn`. The
	 * stall counter answers "did the extra pass I granted accomplish anything", so it may
	 * only judge a pass that WAS one. Classifying every pass instead would (a) charge the
	 * parent's own dispatched prompt as a stall — denying a legitimate first continuation
	 * to a subagent that answered in prose — and (b) use the currently-open task's status
	 * rather than the status the grant was made for, which are not the same thing once the
	 * model edits its spec.
	 */
	grantedKind?: "task" | "blocked";
}

export function createSubagentContinuationState(): SubagentContinuationState {
	return { passes: 0, stall: { count: 0 } };
}

export type SubagentContinuationPlan =
	/** Nothing to continue for; let the normal termination path run. */
	| { action: "none"; stall: { count: number; key?: string }; grantedKind?: "task" | "blocked" }
	/**
	 * Continue: the caller persists the prompt as a `sys` row and drives one more pass.
	 *
	 * `passes` and `grantedKind` are the caller's new state and must both be written back —
	 * the bound is only real if the counter advances, and the NEXT pass can only be judged
	 * if it is recorded as a granted continuation.
	 */
	| {
			action: "continue";
			cause: SubagentContinuationCause;
			passes: number;
			stall: { count: number; key?: string };
			grantedKind: "task" | "blocked";
			task: { text: string; protected: boolean; status: "doing" | "blocked" };
	  }
	/**
	 * Stop continuing and finish the run, stating why.
	 *
	 * `reason` distinguishes the two ways the bound bites, because they mean different
	 * things to whoever reads the parent-facing text: `stalled` says the subagent was
	 * given more passes and did nothing with them, `passLimit` says it was making
	 * changes but ran out of the budget this run allows.
	 */
	| {
			action: "stop";
			cause: SubagentContinuationCause;
			reason: "stalled" | "passLimit";
			passes: number;
			stall: { count: number; key?: string };
			grantedKind?: "task" | "blocked";
	  };

/**
 * Decide whether a finished subagent pass should be followed by another one.
 *
 * ## Inputs, and what is deliberately NOT an input
 *
 * `openTask` is resolved by the caller from the subagent's own spec namespace (spec
 * files are keyed by narratorId, so reading the parent's would be both wrong and
 * silent). `mode` is the effective auto-continuation setting; `off` means the operator
 * turned this off and no cause may override it — unlike the primary side there is no
 * `explicitStart` escape, because a subagent has no `/goal` command of its own.
 *
 * The pass's turn count is not an input. On the `maxTurns` cause the next pass gets a
 * fresh budget, so bounding by turns would not bound anything.
 *
 * ## Order of the two bounds
 *
 * The stall check runs FIRST: a subagent that is producing nothing should stop at the
 * stall limit even when it has passes left, and reporting "stalled" is more useful than
 * reporting "out of passes" for the same run.
 */
export function planSubagentContinuation(input: {
	cause: SubagentContinuationCause;
	mode: AutoContinuationMode;
	/** The task the reminder would be about, or null when the spec has nothing open. */
	openTask: { text: string; protected: boolean; status: "doing" | "blocked" } | null;
	/** Open protected tasks, for `protectedOnly`. */
	protectedOpenCount: number;
	previous: SubagentContinuationState;
	result: Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint">;
	/** The run is ending for another reason (abort, error); never continue. */
	suppressed?: boolean;
}): SubagentContinuationPlan {
	const { cause, mode, openTask, previous, result } = input;
	const keep = { count: previous.stall.count, key: previous.stall.key };
	const declined = {
		action: "none" as const,
		stall: keep,
		...(previous.grantedKind ? { grantedKind: previous.grantedKind } : {}),
	};
	if (input.suppressed || mode === "off" || !openTask) return declined;
	if (mode === "protectedOnly" && input.protectedOpenCount === 0) return declined;
	// `blockStop` means "stop when only blocked tasks remain", so a blocked-only spec
	// yields no continuation while an open `doing` task still does.
	if (mode === "blockStop" && openTask.status === "blocked") return declined;

	const nextKind = openTask.status === "blocked" ? ("blocked" as const) : ("task" as const);

	// Judge the pass that just ended — but ONLY if it was itself a granted continuation,
	// and against the kind that was granted. Same guard as the primary loop's
	// `if (continuationKind)`: a pass driven by the parent's dispatched prompt (or by a
	// buffered message) is somebody else's turn, and charging it as a no-progress
	// continuation would deny the first legitimate continuation to a subagent that
	// happened to answer in prose.
	const stall = previous.grantedKind
		? computeContinuationStallState(previous.grantedKind, result, previous.stall)
		: { count: 0, key: undefined, suppressed: false };
	const nextStall = { count: stall.count, key: stall.key };
	if (stall.suppressed) {
		return {
			action: "stop",
			cause,
			reason: "stalled",
			passes: previous.passes,
			stall: nextStall,
			...(previous.grantedKind ? { grantedKind: previous.grantedKind } : {}),
		};
	}
	if (previous.passes >= MAX_SUBAGENT_CONTINUATION_PASSES) {
		return {
			action: "stop",
			cause,
			reason: "passLimit",
			passes: previous.passes,
			stall: nextStall,
			...(previous.grantedKind ? { grantedKind: previous.grantedKind } : {}),
		};
	}
	return {
		action: "continue",
		cause,
		passes: previous.passes + 1,
		stall: nextStall,
		grantedKind: nextKind,
		task: openTask,
	};
}

/**
 * The model-facing text for a subagent continuation pass.
 *
 * Mirrors the primary loop's wording decisions, which were arrived at by fixing
 * observed failures, and adds the one thing that is specific to a subagent: it owes
 * its parent a result, so "report what you have" is always a legitimate ending. The
 * primary version instead offers `AskUserQuestion`, which a subagent does not have
 * (`DISALLOWED_SUBAGENT_TOOLS`) — telling it to ask the user would be an instruction it
 * cannot follow.
 *
 * It also states the remaining budget. Without that, a subagent has no way to know that
 * its self-continuations are finite and may keep deferring the summary it owes.
 */
export function buildSubagentContinuationPrompt(input: {
	cause: SubagentContinuationCause;
	task: { text: string; protected: boolean; status: "doing" | "blocked" };
	/** Passes already used, including the one being started. */
	passes: number;
	locale: Locale;
}): string {
	const { cause, task, passes, locale } = input;
	const remaining = Math.max(0, MAX_SUBAGENT_CONTINUATION_PASSES - passes);
	const isZh = locale === "zh-CN";
	const label = task.protected ? " [protected]" : "";
	const protectedNote = task.protected
		? isZh
			? "\n- protected：只有具备具体验收证据才能标记 done，该变更会触发 taskReflection。"
			: "\n- Protected: mark it done only with concrete completion evidence; that change runs taskReflection."
		: "";

	const why = isZh
		? cause === "maxTurns"
			? "上一趟用尽了单趟的回合预算（不是你被判定做错了），而 spec://tasks.json 仍有未完成条目，所以系统又给你一趟。"
			: "系统检测到 spec://tasks.json 仍有未完成条目，所以又给你一趟。这只说明条目尚未标记完成 —— 不代表系统判断你没做完，条目内容也可能已经过时。"
		: cause === "maxTurns"
			? "The previous pass spent its per-pass turn budget (not a judgement on your work) while spec://tasks.json still had open work, so the system granted another pass."
			: "The system granted another pass because spec://tasks.json still has open work. That only means the entry is not marked finished — not that your work was judged incomplete, and its content may be out of date.";

	const budget = isZh
		? `\n\n剩余自动续跑次数：${remaining}。用完后本次运行会直接结束并把当前结果交回父级，所以不要把总结留到最后一趟。`
		: `\n\nSelf-continuations left: ${remaining}. When they run out this run ends and whatever you have is handed back to your parent, so do not save your summary for a later pass.`;

	if (task.status === "blocked") {
		const actionInstruction = getBlockedTaskActionInstruction(locale);
		return isZh
			? `子代理 Dynamic Spec blocked 任务续跑（系统消息，不是用户或父级发言）。\n\n${why}\n\nblocked 任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：${task.text}${label}\n\n${actionInstruction}\n\n你是子代理，没有 AskUserQuestion，也不能等用户回答。如果解除阻塞确实需要用户或父级决策，就把当前结论、已完成部分和所缺信息写清楚并结束本次运行 —— 这会作为结果交回父级，由它去问。${budget}`
			: `Subagent Dynamic Spec blocked-task continuation (system message — not the user and not your parent speaking).\n\n${why}\n\nBlocked task (this one only — not the full task list; your other tasks are still in spec://tasks.json): ${task.text}${label}\n\n${actionInstruction}\n\nYou are a subagent: you have no AskUserQuestion and cannot wait for an answer. If clearing the blocker genuinely needs the user or your parent, state your findings, what you completed, and exactly what is missing, then end this run — that text is returned to your parent, which can ask.${budget}`;
	}

	return isZh
		? `子代理 Dynamic Spec 自动续跑（系统消息，不是用户或父级发言）。\n\n${why}\n\n当前任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：${task.text}${label}\n\n请先判断该任务的真实状态，再按实际情况选择其一：\n- 已经完成：在 spec://tasks.json 标记 done，并给出交回父级的结论。不要因为这条提醒去返工已经正确的改动。\n- 未完成且能自主推进：继续执行。\n- 需要用户或父级提供信息、权限或决策：把已完成部分和所缺信息写清楚并结束本次运行，由父级去问。\n- 已不符合当前实际：在保留原意图的前提下改写或删除该条目，并说明原因。\n\n改动 spec://tasks.json 时先读取再就地修改，不要按本消息重写整个文件。${protectedNote}${budget}`
		: `Subagent Dynamic Spec auto-continuation (system message — not the user and not your parent speaking).\n\n${why}\n\nCurrent task (this one only — not the full task list; your other tasks are still in spec://tasks.json): ${task.text}${label}\n\nDecide what is actually true of this task, then take exactly one of these paths:\n- Already done: mark it done in spec://tasks.json and state the conclusion you are returning to your parent. Do not rework a change that was already correct.\n- Unfinished and you can advance it: keep working.\n- Needs information, permission, or a decision from the user or your parent: state what you completed and what is missing, then end this run so your parent can ask.\n- No longer matches reality: rewrite or remove the entry while preserving the original intent, and say why.\n\nWhen you change spec://tasks.json, read it first and edit in place; do not rewrite the file from this message.${protectedNote}${budget}`;
}

/**
 * The parent-facing note appended when the continuation bound stopped a run.
 *
 * A subagent owes its parent a `tool_result`, so the bound must not merely stop the
 * loop: it has to say why the run ended with work still open, or the parent reads the
 * partial answer as a finished one. Deliberately NOT an error — the work that did
 * happen is real, and marking it `hasError` would discard the conclusion file for an
 * explore/plan subagent.
 */
export function subagentContinuationStopNote(
	plan: Extract<SubagentContinuationPlan, { action: "stop" }>,
	locale: Locale,
): string {
	const isZh = locale === "zh-CN";
	if (plan.reason === "stalled") {
		return isZh
			? "[自动续跑已停止：连续续跑未产生实际进展（未调用任何工具，或反复触发同一次 protected 任务驳回）。spec://tasks.json 中仍有未完成条目。]"
			: "[Auto-continuation stopped: the extra passes produced no effective progress (no tool calls, or the same protected-task rejection repeated). spec://tasks.json still has open work.]";
	}
	return isZh
		? `[自动续跑已停止：本次运行已用满 ${MAX_SUBAGENT_CONTINUATION_PASSES} 次续跑预算。spec://tasks.json 中仍有未完成条目，如需继续请重新派发。]`
		: `[Auto-continuation stopped: this run used its budget of ${MAX_SUBAGENT_CONTINUATION_PASSES} continuation passes. spec://tasks.json still has open work; dispatch again to continue.]`;
}

/**
 * The log label for an interruption continuation.
 *
 * Both loops built this string inline from the same two cases; the subagent's variant is
 * the primary's prefixed with "Subagent " and lower-cased at the seam. Reproduced exactly
 * so existing log greps keep working.
 */
export function interruptionContinuationLabel(
	reason: NonNullable<ExecuteLoopResult["interruptedReason"]>,
	audience: "primary" | "subagent",
): string {
	const base =
		reason === "resumable_error" ? "Resumable-error continuation" : "Completion-limit continuation";
	return audience === "subagent" ? `Subagent ${base[0]?.toLowerCase()}${base.slice(1)}` : base;
}
