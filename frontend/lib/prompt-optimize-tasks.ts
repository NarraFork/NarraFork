/**
 * Prompt-optimization tasks that outlive the composer that started them.
 *
 * ── WHY A MODULE-LEVEL REGISTRY ───────────────────────────────────────────────
 * Optimization used to live entirely inside the composer's hook, which aborted its
 * request on unmount (`useEffect` cleanup keyed on `narratorId`). Switching to
 * another narrator unmounted that composer and killed the request, so the work the
 * user had already paid for was thrown away — the single most common way to lose an
 * optimization.
 *
 * React state cannot fix this: the component owning it is gone. The request has to
 * belong to something with a longer lifetime than any one composer, and the result
 * has to be attributable to the narrator it was started for. That is this module.
 *
 * Task identity is `(narratorId, messageId?)`:
 *  - `messageId` present → an inline message editor was being optimized.
 *  - absent             → that narrator's main composer.
 * Two different narrators therefore never share a task, which is what keeps a
 * late result from landing in whichever composer happens to be on screen.
 *
 * ── DELIVERY ──────────────────────────────────────────────────────────────────
 * A finished task keeps `pendingDelivery` set until a composer for its own key
 * claims it. Nothing is written into a textarea from here: only the mounted
 * composer knows how to apply text to its own surface (plain textarea vs. the
 * structured editor), and applying blindly is how a stale result would clobber
 * intervening typing. The composer claims the result, verifies the draft has not
 * changed underneath it, and only then writes.
 *
 * If the user switched away, the claim simply happens later — when they come back
 * to that narrator. Nothing is lost, and no other narrator's input is touched.
 */

import type { ComposerDocument } from "@shared/composer-document";

/** The document, selection and segment markers the request was created for. */
export interface PromptOptimizeSnapshot {
	document: ComposerDocument;
	selection: { start: number; end: number };
	token: string;
}

/** Styles the optimizer can be asked for. Owned here so the store has no React deps. */
export type OptimizeStyle = "clarify" | "concise" | "structured" | "translate_en";

export type PromptOptimizeTaskStatus = "running" | "succeeded" | "failed";

export interface PromptOptimizeTask {
	/** `(narratorId, messageId?)` identity — see the module docs. */
	key: string;
	narratorId: string;
	messageId?: string;
	status: PromptOptimizeTaskStatus;
	/** Guards against a stale response overwriting a newer request for the same key. */
	requestId: string;
	startedAt: number;
	finishedAt?: number;
	/** The draft the request was issued against; delivery refuses if it has moved on. */
	originalText: string;
	snapshot?: PromptOptimizeSnapshot;
	resultText?: string;
	/** Short rationale lifted by the server, shown beside the result. */
	summary?: string;
	error?: string;
	/** Set once the result exists but no composer has claimed it yet. */
	pendingDelivery: boolean;
}

/** Completed tasks are retained briefly so a composer mounting moments later can claim them. */
const RETAIN_FINISHED_MS = 10 * 60 * 1000;

/** Hard cap on retained tasks, so a long session cannot grow this without bound. */
const MAX_RETAINED_TASKS = 50;

const tasks = new Map<string, PromptOptimizeTask>();
/** Abort handles live outside the snapshot: callers compare task objects by identity. */
const controllers = new Map<string, AbortController>();

type Listener = () => void;
const listeners = new Set<Listener>();

/** Stable empty snapshot for keys with no task, so `useSyncExternalStore` never re-renders spuriously. */
const EMPTY_SNAPSHOT = undefined;

export function promptOptimizeTaskKey(narratorId: string, messageId?: string): string {
	return messageId ? `${narratorId}::${messageId}` : narratorId;
}

export function subscribePromptOptimizeTasks(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function notify(): void {
	for (const listener of [...listeners]) listener();
}

/** Current task for a key, or undefined. Identity changes only when the task does. */
export function getPromptOptimizeTask(key: string): PromptOptimizeTask | undefined {
	return tasks.get(key) ?? EMPTY_SNAPSHOT;
}

/**
 * How many optimizations are running for a narrator, across its composer and any
 * message editors. A number, so it is a stable snapshot by value.
 */
export function getNarratorRunningOptimizeCount(narratorId: string): number {
	let count = 0;
	for (const task of tasks.values()) {
		if (task.status === "running" && task.narratorId === narratorId) count++;
	}
	return count;
}

export function isNarratorOptimizingPrompt(narratorId: string): boolean {
	return getNarratorRunningOptimizeCount(narratorId) > 0;
}

/**
 * The running MAIN-COMPOSER optimization for a narrator, whichever composer
 * instance started it.
 *
 * Message editors carry a `messageId` and are excluded on purpose: they are a
 * different draft, and the composer's own toolbar must not claim to be busy (or
 * offer to cancel) because an inline message edit is being optimized elsewhere.
 *
 * Looking this up by narrator rather than by this component's own key is what makes
 * the toolbar and the status badge agree: a composer that was unmounted while the
 * request ran comes back holding no task of its own, and would otherwise show
 * "optimize" for a narrator the sidebar is showing as busy.
 */
export function getNarratorComposerOptimizeTask(
	narratorId: string,
): PromptOptimizeTask | undefined {
	for (const task of tasks.values()) {
		if (task.status === "running" && task.narratorId === narratorId && !task.messageId) return task;
	}
	return EMPTY_SNAPSHOT;
}

export function isNarratorComposerOptimizing(narratorId: string): boolean {
	return !!getNarratorComposerOptimizeTask(narratorId);
}

/** Drop finished tasks that are past their retention window or beyond the cap. */
function prune(now: number): void {
	for (const [key, task] of tasks) {
		if (
			task.status !== "running" &&
			now - (task.finishedAt ?? task.startedAt) > RETAIN_FINISHED_MS
		) {
			tasks.delete(key);
		}
	}
	if (tasks.size <= MAX_RETAINED_TASKS) return;
	// Oldest finished first; a running task is never evicted.
	const finished = [...tasks.values()]
		.filter((task) => task.status !== "running")
		.sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
	for (const task of finished) {
		if (tasks.size <= MAX_RETAINED_TASKS) break;
		tasks.delete(task.key);
	}
}

export interface StartPromptOptimizeParams {
	narratorId: string;
	messageId?: string;
	text: string;
	snapshot?: PromptOptimizeSnapshot;
	style: OptimizeStyle;
	withContext: boolean;
	/** Injected so tests can drive the task without the network. */
	request?: (params: {
		narratorId: string;
		messageId?: string;
		text: string;
		style: OptimizeStyle;
		withContext: boolean;
		signal: AbortSignal;
	}) => Promise<{ text: string; reasoningSummary?: string }>;
}

/**
 * Begin (or replace) the optimization for a key.
 *
 * Replacing aborts only THIS key's previous request: starting an optimization in
 * one narrator must never cancel another narrator's in-flight one, which is the
 * behaviour a single shared ref would have given.
 */
export function startPromptOptimizeTask(params: StartPromptOptimizeParams): string {
	const key = promptOptimizeTaskKey(params.narratorId, params.messageId);
	const now = Date.now();
	// Supersede this key only.
	controllers.get(key)?.abort();
	prune(now);

	const controller = new AbortController();
	const requestId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
	const task: PromptOptimizeTask = {
		key,
		narratorId: params.narratorId,
		messageId: params.messageId,
		status: "running",
		requestId,
		startedAt: now,
		originalText: params.text,
		snapshot: params.snapshot,
		pendingDelivery: false,
	};
	tasks.set(key, task);
	controllers.set(key, controller);
	notify();

	void runTask(task, controller, params);
	return requestId;
}

/** Resolve a task's request, guarding against a superseded or cancelled one. */
async function runTask(
	task: PromptOptimizeTask,
	controller: AbortController,
	params: StartPromptOptimizeParams,
): Promise<void> {
	try {
		const request = params.request ?? defaultRequest;
		const result = await request({
			narratorId: task.narratorId,
			messageId: task.messageId,
			text: task.originalText,
			style: params.style,
			withContext: params.withContext,
			signal: controller.signal,
		});
		if (controller.signal.aborted) return;
		finishTask(task.key, task.requestId, {
			resultText: result.text,
			summary: result.reasoningSummary?.trim() || undefined,
		});
	} catch (err) {
		if (controller.signal.aborted || (err as Error)?.name === "AbortError") return;
		failTask(task.key, task.requestId, (err as Error)?.message ?? "");
	}
}

function currentTask(key: string, requestId: string): PromptOptimizeTask | undefined {
	const task = tasks.get(key);
	// A stale request must not resurrect a task the user has already replaced.
	if (!task || task.requestId !== requestId) return undefined;
	return task;
}

export function finishTask(
	key: string,
	requestId: string,
	result: { resultText: string; summary?: string },
): void {
	const task = currentTask(key, requestId);
	if (!task) return;
	if (controllers.get(key)?.signal.aborted) return;
	controllers.delete(key);
	tasks.set(key, {
		...task,
		status: "succeeded",
		finishedAt: Date.now(),
		resultText: result.resultText,
		summary: result.summary,
		// Nothing is applied here — see the module docs on delivery.
		pendingDelivery: true,
	});
	notify();
}

export function failTask(key: string, requestId: string, error: string): void {
	const task = currentTask(key, requestId);
	if (!task) return;
	controllers.delete(key);
	tasks.set(key, {
		...task,
		status: "failed",
		finishedAt: Date.now(),
		error,
		pendingDelivery: true,
	});
	notify();
}

/** User-initiated cancel (the in-composer cancel button), not a narrator switch. */
export function cancelPromptOptimizeTask(key: string): void {
	const controller = controllers.get(key);
	if (controller) {
		controller.abort();
		controllers.delete(key);
	}
	const task = tasks.get(key);
	if (!task) return;
	// A cancelled task is dropped entirely: it has no result to deliver.
	tasks.delete(key);
	notify();
}

/**
 * Request ids whose result has already been claimed by a surface.
 *
 * Two surfaces can be showing the same draft at once — the inline composer and the
 * fullscreen composer are two textareas over one draft, so they share a task key and
 * both observe the same finished result. Without a claim, both would write it,
 * which for a structured editor means applying the same transformation twice.
 */
const claimedDeliveries = new Set<string>();

/**
 * Take exclusive ownership of a finished result.
 *
 * Returns false when another surface already claimed it. Deliberately synchronous
 * and side-effect-free beyond the claim, so the two effects that run in the same
 * commit cannot both proceed.
 */
export function claimPromptOptimizeDelivery(key: string, requestId: string): boolean {
	const token = `${key}\u0000${requestId}`;
	if (claimedDeliveries.has(token)) return false;
	claimedDeliveries.add(token);
	return true;
}

/**
 * Stop attributing this surface's in-flight result to that surface, WITHOUT
 * cancelling the request.
 *
 * Closing the fullscreen composer is the motivating case: the user closed a view,
 * not the work. The task keeps running and its result stays claimable, so the draft
 * still gets optimized. Use {@link cancelPromptOptimizeTask} for a real cancel.
 *
 * A still-running task is left untouched: it is not this surface's to kill, and
 * dropping it would delete a request that is still valid for the draft.
 */
export function releasePromptOptimizeSurface(key: string): void {
	const task = tasks.get(key);
	if (!task) return;
	// Only a finished, undelivered result needs releasing: it would otherwise be
	// offered to a surface that has gone away. A running task simply completes and
	// its result is offered to whoever looks for it next.
	if (task.status === "running") return;
	// Hand the claim back, so a surface that is still showing this draft (the inline
	// composer behind a closing fullscreen view) can still deliver it.
	forgetClaim(key, task.requestId);
	notify();
}

/**
 * Mark a result as delivered (or deliberately discarded) and release the task.
 *
 * Called by the composer that applied the text, and by the composer that refused
 * to apply it because the draft had changed — in both cases the result has been
 * accounted for, so leaving it pending would retry forever.
 */
export function acknowledgePromptOptimizeDelivery(key: string, requestId?: string): void {
	const task = tasks.get(key);
	if (!task) return;
	if (requestId && task.requestId !== requestId) return;
	forgetClaim(key, task.requestId);
	tasks.delete(key);
	notify();
}

function forgetClaim(key: string, requestId: string): void {
	claimedDeliveries.delete(`${key}\u0000${requestId}`);
}

/** Test seam: clear all tasks and listeners. */
export function resetPromptOptimizeTasksForTest(): void {
	for (const controller of controllers.values()) controller.abort();
	controllers.clear();
	tasks.clear();
	claimedDeliveries.clear();
	listeners.clear();
}

/**
 * Default transport. Kept as a lazy import so this module stays loadable in tests
 * and in any surface that only reads task state.
 */
async function defaultRequest(params: {
	narratorId: string;
	messageId?: string;
	text: string;
	style: OptimizeStyle;
	withContext: boolean;
	signal: AbortSignal;
}): Promise<{ text: string; reasoningSummary?: string }> {
	const { narratorsApi } = await import("./api/narrators");
	return narratorsApi.optimizePrompt(params.narratorId, params.text, params.style, {
		withContext: params.withContext,
		messageId: params.messageId,
		signal: params.signal,
	});
}
