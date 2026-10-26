import {
	isReasoningTranslationBoundary,
	MAX_REASONING_TRANSLATION_OUTPUT_BYTES,
	MAX_REASONING_TRANSLATION_SOURCE_BYTES,
	preserveReasoningTranslationWhitespace,
	type ReasoningTranslationPart,
} from "@shared/reasoning-translation";
import { generateId } from "../lib/id";

export const REASONING_TRANSLATION_LIMITS = {
	concurrency: 4,
	queuedBlocks: 64,
	coalesceMs: 300,
	deadlineMs: 30_000,
	sourceBytes: 256 * 1024,
	tasks: 32,
	outputBytes: 512 * 1024,
} as const;

export interface TranslationTask {
	id: string;
	/** Output element identity, never a persistent narrator_blocks primary key. */
	elementId: string;
	messageId: string;
	generation: string;
	start: number;
	end: number;
	sourceText: string;
	reason: "tool" | "summary" | "final";
	queuedAt: number;
}
type TranslationSkipReason =
	| "block_budget"
	| "task_budget"
	| "output_budget"
	| "queue_full"
	| "source_budget"
	| "source_gap"
	| "cancelled"
	| "queue_timeout";
export type TranslationLifecycleReason =
	| "settle"
	| "cancel"
	| "final"
	| "done"
	| "output_incomplete"
	| "stream_reset"
	| "attempt_discarded"
	| "error"
	| "shutdown";
type TranslationAbortReason =
	| TranslationLifecycleReason
	| "generation_replaced"
	| "deadline"
	| "task_output_budget"
	| "response_output_budget";
export interface TranslationObservation {
	phase: "freeze" | "task" | "response";
	taskId?: string;
	elementId?: string;
	reason:
		| TranslationTask["reason"]
		| TranslationSkipReason
		| TranslationLifecycleReason
		| "stopping"
		| "settled"
		| "invalid_boundary"
		| "no_new_range"
		| "generation_replaced";
	status:
		| "noop"
		| "skipped"
		| "started"
		| "queued"
		| "applied"
		| "stale"
		| "rejected"
		| "cancelled"
		| "timeout_or_output_budget"
		| "failed"
		| "settled"
		| "idle";
	abortReason?: TranslationAbortReason;
	start?: number;
	end?: number;
	sourceBytes?: number;
	outputBytes?: number;
	queueMs?: number;
	modelMs?: number;
	applyMs?: number;
	pending?: number;
	active?: number;
	queued?: number;
	tasks?: number;
	blocks?: number;
	skips?: number;
	blockBudgetSkips?: number;
	taskBudgetSkips?: number;
	outputBudgetSkips?: number;
	queueFullSkips?: number;
	sourceBudgetSkips?: number;
	sourceGapSkips?: number;
	cancelledSkips?: number;
	queueTimeoutSkips?: number;
	suppressed?: number;
}

/** Only opaque identifiers and finite counters cross the diagnostic boundary. */
export function reasoningTranslationDiagnosticId(value: string | undefined): string | undefined {
	return value && value.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;
}
export function reasoningTranslationDiagnosticNumber(value: number): number {
	return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value)) : 0;
}

interface TranslationDiagnostics {
	emitted: number;
	suppressed: number;
	counts: Map<string, number>;
	lifecycle: Set<"settled" | "cancelled" | "idle">;
}
interface Tail {
	start: number;
	end: number;
	text: string;
	boundaries: number[];
	queuedAt: number;
	readyAt: number;
	reason: TranslationTask["reason"];
	messageId: string;
}
interface Block {
	id: string;
	generation: string;
	covered: number;
	active?: AbortController;
	activeAbortReason?: TranslationAbortReason;
	tail?: Tail;
}
export interface ReasoningTranslationResponse {
	id: string;
	sessionId: string;
	blocks: Map<string, Block>;
	pending: number;
	settled: boolean;
	cancelled: boolean;
	sourceBytes: number;
	outputBytes: number;
	tasks: number;
	skips: Map<string, number>;
	/** Bounded diagnostics live only as long as this response; never retain source content. */
	diagnostics: TranslationDiagnostics;
	lifecycleReason?: TranslationLifecycleReason;
	translate: (
		task: TranslationTask,
		signal: AbortSignal,
		onDelta: (text: string) => void,
	) => Promise<string>;
	apply: (
		task: TranslationTask,
		part: ReasoningTranslationPart,
		signal: AbortSignal,
	) => Promise<boolean>;
	observe?: (event: TranslationObservation) => void;
	onIdle?: () => void;
}

/** UTF-8 budget with UTF-16 coordinates, without encoding an unbounded copy. */
export function translationPrefixEnd(
	text: string,
	start: number,
	end: number,
	bytes: number,
): number {
	let used = 0;
	let offset = start;
	while (offset < end) {
		const point = text.codePointAt(offset) as number;
		const width = point > 0xffff ? 2 : 1;
		if (offset + width > end) break;
		const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		if (used + size > bytes) break;
		used += size;
		offset += width;
	}
	return offset;
}

/** One bounded queue; rotating sessions prevents a long response monopolizing slots. */
export class ReasoningTranslationScheduler {
	private active = 0;
	private stopping = false;
	private readonly running = new Set<Promise<unknown>>();
	private readonly responses = new Set<ReasoningTranslationResponse>();
	private sessions: string[] = [];
	private queued = 0;
	private timer?: ReturnType<typeof setTimeout>;
	constructor(
		private readonly limits: {
			[K in keyof typeof REASONING_TRANSLATION_LIMITS]: number;
		} = REASONING_TRANSLATION_LIMITS,
	) {}

	create(
		options: Pick<
			ReasoningTranslationResponse,
			"sessionId" | "translate" | "apply" | "observe" | "onIdle"
		>,
	): ReasoningTranslationResponse {
		return {
			...options,
			id: generateId(),
			blocks: new Map(),
			pending: 0,
			settled: false,
			cancelled: false,
			sourceBytes: 0,
			outputBytes: 0,
			tasks: 0,
			skips: new Map(),
			diagnostics: { emitted: 0, suppressed: 0, counts: new Map(), lifecycle: new Set() },
		};
	}

	freeze(
		response: ReasoningTranslationResponse,
		input: {
			elementId: string;
			messageId: string;
			generation: string;
			text: string;
			end?: number;
			reason: TranslationTask["reason"];
		},
	): void {
		if (this.stopping || response.cancelled || response.settled) {
			this.observe(response, {
				phase: "freeze",
				elementId: input.elementId,
				reason: this.stopping ? "stopping" : response.cancelled ? "cancelled" : "settled",
				status: "noop",
			});
			return;
		}
		const end = Math.min(input.end ?? input.text.length, input.text.length);
		if (!isReasoningTranslationBoundary(input.text, end)) {
			this.observe(response, {
				phase: "freeze",
				elementId: input.elementId,
				reason: "invalid_boundary",
				status: "noop",
				end,
			});
			return;
		}
		let block = response.blocks.get(input.elementId);
		if (block && block.generation !== input.generation) {
			this.observe(response, {
				phase: "freeze",
				elementId: input.elementId,
				reason: "generation_replaced",
				status: "cancelled",
			});
			this.dropTail(response, block);
			block.activeAbortReason = "generation_replaced";
			block.active?.abort();
			block.generation = input.generation;
			block.covered = 0;
		}
		if (!block) {
			if (response.blocks.size >= this.limits.tasks + this.limits.queuedBlocks) {
				this.skip(response, input.elementId, "block_budget");
				return;
			}
			block = { id: input.elementId, generation: input.generation, covered: 0 };
			response.blocks.set(input.elementId, block);
		}
		const start = block.covered;
		if (end <= start) {
			this.observe(response, {
				phase: "freeze",
				elementId: input.elementId,
				reason: "no_new_range",
				status: "noop",
				start,
				end,
			});
			if (block.tail && input.reason !== "summary") {
				block.tail.readyAt = Date.now();
				block.tail.reason = input.reason;
				this.pump();
			}
			return;
		}
		// Reserve even rejected ranges: failures never reopen an already frozen prefix.
		block.covered = end;
		if (response.tasks >= this.limits.tasks) {
			this.skip(response, block.id, "task_budget");
			return;
		}
		if (response.outputBytes >= this.limits.outputBytes) {
			this.skip(response, block.id, "output_budget");
			return;
		}
		if (!block.tail && this.queued >= this.limits.queuedBlocks) {
			this.skip(response, block.id, "queue_full");
			return;
		}
		const acceptedEnd = translationPrefixEnd(
			input.text,
			start,
			end,
			this.limits.sourceBytes - response.sourceBytes,
		);
		if (acceptedEnd < end) this.skip(response, block.id, "source_budget");
		if (acceptedEnd <= start) return;
		const text = input.text.slice(start, acceptedEnd);
		response.sourceBytes += Buffer.byteLength(text);
		const now = Date.now();
		if (block.tail) {
			if (block.tail.end !== start) {
				this.skip(response, block.id, "source_gap");
				return;
			}
			block.tail.text += text;
			block.tail.end = acceptedEnd;
			if (block.tail.boundaries.length < this.limits.tasks) block.tail.boundaries.push(acceptedEnd);
			if (input.reason !== "summary") block.tail.readyAt = now;
			block.tail.reason = input.reason;
		} else {
			block.tail = {
				start,
				end: acceptedEnd,
				text,
				boundaries: [acceptedEnd],
				queuedAt: now,
				readyAt: now + (input.reason === "summary" ? this.limits.coalesceMs : 0),
				reason: input.reason,
				messageId: input.messageId,
			};
			this.queued++;
			response.pending++;
		}
		this.responses.add(response);
		if (!this.sessions.includes(response.sessionId)) this.sessions.push(response.sessionId);
		this.observe(response, {
			phase: "freeze",
			elementId: input.elementId,
			reason: input.reason,
			status: "queued",
			start,
			end: acceptedEnd,
		});
		this.pump();
	}

	settle(
		response: ReasoningTranslationResponse,
		reason: TranslationLifecycleReason = "settle",
	): void {
		response.settled = true;
		response.lifecycleReason ??= reason;
		this.observeLifecycle(response, "settled");
		this.cleanup(response);
	}
	cancel(
		response: ReasoningTranslationResponse,
		reason: TranslationLifecycleReason = "cancel",
	): void {
		response.cancelled = response.settled = true;
		response.lifecycleReason = reason;
		this.observeLifecycle(response, "cancelled");
		for (const block of response.blocks.values()) {
			this.dropTail(response, block);
			block.active?.abort();
		}
		this.cleanup(response);
		this.pump();
	}
	async stop(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
		this.stopping = true;
		for (const response of [...this.responses]) this.cancel(response, "shutdown");
		options.signal?.throwIfAborted();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort = () => {};
		try {
			await Promise.race([
				Promise.allSettled([...this.running]),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Reasoning translation drain deadline exceeded")),
						options.timeoutMs ?? 5_000,
					);
					onAbort = () =>
						reject(options.signal?.reason ?? new Error("Reasoning translation drain cancelled"));
					options.signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}
	stats(): { active: number; queued: number; responses: number; sessions: number } {
		return {
			active: this.active,
			queued: this.queued,
			responses: this.responses.size,
			sessions: this.sessions.length,
		};
	}
	/** At most 32 detail records (two per phase/reason/status) plus three lifecycle summaries. */
	private observe(response: ReasoningTranslationResponse, event: TranslationObservation): void {
		try {
			if (!response.observe) return;
			const diagnostics = response.diagnostics;
			if (event.phase !== "response") {
				const key = `${event.phase}:${event.reason}:${event.status}`;
				const count = diagnostics.counts.get(key) ?? 0;
				if (diagnostics.emitted >= 32 || count >= 2) {
					diagnostics.suppressed = reasoningTranslationDiagnosticNumber(diagnostics.suppressed + 1);
					return;
				}
				diagnostics.counts.set(key, count + 1);
				diagnostics.emitted++;
			}
			const safe: TranslationObservation = {
				phase: event.phase,
				reason: event.reason,
				status: event.status,
				abortReason: event.abortReason,
				taskId: reasoningTranslationDiagnosticId(event.taskId),
				elementId: reasoningTranslationDiagnosticId(event.elementId),
			};
			for (const key of [
				"start",
				"end",
				"sourceBytes",
				"outputBytes",
				"queueMs",
				"modelMs",
				"applyMs",
				"pending",
				"active",
				"queued",
				"tasks",
				"blocks",
				"skips",
				"blockBudgetSkips",
				"taskBudgetSkips",
				"outputBudgetSkips",
				"queueFullSkips",
				"sourceBudgetSkips",
				"sourceGapSkips",
				"cancelledSkips",
				"queueTimeoutSkips",
				"suppressed",
			] as const) {
				const value = event[key];
				if (value != null) safe[key] = reasoningTranslationDiagnosticNumber(value);
			}
			safe.pending = reasoningTranslationDiagnosticNumber(response.pending);
			safe.active = reasoningTranslationDiagnosticNumber(this.active);
			safe.queued = reasoningTranslationDiagnosticNumber(this.queued);
			response.observe(safe);
		} catch {
			// Synchronous observers (including disk logging) cannot affect scheduling or persistence.
		}
	}
	private observeLifecycle(
		response: ReasoningTranslationResponse,
		status: "settled" | "cancelled" | "idle",
	): void {
		try {
			if (response.diagnostics.lifecycle.has(status)) return;
			response.diagnostics.lifecycle.add(status);
			let skips = 0;
			for (const count of response.skips.values()) skips += count;
			this.observe(response, {
				phase: "response",
				reason: response.lifecycleReason ?? "settle",
				status,
				tasks: response.tasks,
				blocks: response.blocks.size,
				sourceBytes: response.sourceBytes,
				outputBytes: response.outputBytes,
				skips,
				blockBudgetSkips: response.skips.get("block_budget") ?? 0,
				taskBudgetSkips: response.skips.get("task_budget") ?? 0,
				outputBudgetSkips: response.skips.get("output_budget") ?? 0,
				queueFullSkips: response.skips.get("queue_full") ?? 0,
				sourceBudgetSkips: response.skips.get("source_budget") ?? 0,
				sourceGapSkips: response.skips.get("source_gap") ?? 0,
				cancelledSkips: response.skips.get("cancelled") ?? 0,
				queueTimeoutSkips: response.skips.get("queue_timeout") ?? 0,
				suppressed: response.diagnostics.suppressed,
			});
		} catch {
			// Summaries are best effort, including during cleanup.
		}
	}
	private skip(
		response: ReasoningTranslationResponse,
		elementId: string,
		reason: TranslationSkipReason,
	): void {
		const count = (response.skips.get(reason) ?? 0) + 1;
		response.skips.set(reason, count);
		if (count === 1)
			this.observe(response, { phase: "freeze", elementId, reason, status: "skipped" });
	}
	private dropTail(response: ReasoningTranslationResponse, block: Block): void {
		if (!block.tail) return;
		block.tail = undefined;
		this.queued--;
		response.pending--;
	}
	private cleanup(response: ReasoningTranslationResponse): void {
		if (response.pending !== 0) return;
		if (response.settled) this.observeLifecycle(response, "idle");
		this.responses.delete(response);
		if (!Array.from(this.responses).some((item) => item.sessionId === response.sessionId))
			this.sessions = this.sessions.filter((id) => id !== response.sessionId);
		if (response.settled) {
			response.blocks.clear();
			response.skips.clear();
			response.onIdle?.();
		}
	}
	private pump(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const now = Date.now();
		for (const response of this.responses) {
			for (const block of response.blocks.values()) {
				if (!block.tail) continue;
				if (
					now >= block.tail.queuedAt + this.limits.deadlineMs ||
					response.cancelled ||
					response.outputBytes >= this.limits.outputBytes ||
					response.tasks >= this.limits.tasks
				) {
					this.skip(
						response,
						block.id,
						response.cancelled
							? "cancelled"
							: response.outputBytes >= this.limits.outputBytes
								? "output_budget"
								: response.tasks >= this.limits.tasks
									? "task_budget"
									: "queue_timeout",
					);
					this.dropTail(response, block);
				}
			}
			this.cleanup(response);
		}
		while (this.active < this.limits.concurrency) {
			let selected: { response: ReasoningTranslationResponse; block: Block } | undefined;
			for (let i = 0; i < this.sessions.length; i++) {
				const sessionId = this.sessions.shift() as string;
				this.sessions.push(sessionId);
				for (const response of this.responses) {
					if (response.sessionId !== sessionId) continue;
					for (const block of response.blocks.values()) {
						if (!block.active && block.tail && block.tail.readyAt <= now) {
							selected = { response, block };
							break;
						}
					}
					if (selected) break;
				}
				if (selected) break;
			}
			if (!selected) break;
			this.start(selected.response, selected.block);
		}
		let nextWake = Number.POSITIVE_INFINITY;
		for (const response of this.responses) {
			for (const block of response.blocks.values()) {
				if (!block.tail) continue;
				nextWake = Math.min(nextWake, block.tail.queuedAt + this.limits.deadlineMs);
				if (this.active < this.limits.concurrency && !block.active)
					nextWake = Math.min(nextWake, block.tail.readyAt);
			}
			this.cleanup(response);
		}
		if (Number.isFinite(nextWake)) {
			this.timer = setTimeout(() => this.pump(), Math.max(1, nextWake - Date.now()));
			this.timer.unref?.();
		}
	}
	private start(response: ReasoningTranslationResponse, block: Block): void {
		const tail = block.tail as Tail;
		let length = translationPrefixEnd(
			tail.text,
			0,
			tail.text.length,
			MAX_REASONING_TRANSLATION_SOURCE_BYTES,
		);
		if (length < tail.text.length) {
			const boundary = tail.boundaries
				.filter((end) => end > tail.start && end <= tail.start + length)
				.at(-1);
			if (boundary != null) length = boundary - tail.start;
		}
		const task: TranslationTask = {
			id: generateId(),
			elementId: block.id,
			messageId: tail.messageId,
			generation: block.generation,
			start: tail.start,
			end: tail.start + length,
			sourceText: tail.text.slice(0, length),
			reason: tail.reason,
			queuedAt: tail.queuedAt,
		};
		if (length === tail.text.length) this.dropTail(response, block);
		else {
			tail.text = tail.text.slice(length);
			tail.start += length;
			tail.boundaries = tail.boundaries.filter((end) => end > tail.start);
		}
		response.tasks++;
		response.pending++;
		this.active++;
		const controller = new AbortController();
		block.active = controller;
		block.activeAbortReason = undefined;
		this.observe(response, {
			phase: "task",
			taskId: task.id,
			elementId: block.id,
			reason: task.reason,
			status: "started",
			start: task.start,
			end: task.end,
			sourceBytes: Buffer.byteLength(task.sourceText),
		});
		const started = Date.now();
		let outputBytes = 0;
		let modelMs = 0;
		let modelReturned = false;
		let applyStarted: number | undefined;
		let status: TranslationObservation["status"] = "failed";
		let abortReason: TranslationAbortReason | undefined;
		const timeout = setTimeout(
			() => {
				abortReason = "deadline";
				controller.abort();
			},
			Math.max(0, tail.queuedAt + this.limits.deadlineMs - started),
		);
		timeout.unref?.();
		const aborted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener(
				"abort",
				() => reject(new Error("translation_cancelled")),
				{ once: true },
			);
		});
		const work = (async () => {
			try {
				const result = await Promise.race([
					response.translate(task, controller.signal, (delta) => {
						const bytes = Buffer.byteLength(delta);
						outputBytes += bytes;
						const available = Math.max(0, this.limits.outputBytes - response.outputBytes);
						response.outputBytes += Math.min(bytes, available);
						if (outputBytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES || bytes > available) {
							abortReason =
								outputBytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES
									? "task_output_budget"
									: "response_output_budget";
							controller.abort();
						}
					}),
					aborted,
				]);
				modelReturned = true;
				modelMs = Date.now() - started;
				const translated = preserveReasoningTranslationWhitespace(task.sourceText, result);
				const bytes = Buffer.byteLength(translated);
				const rawBytes = Buffer.byteLength(result);
				const unaccounted = Math.max(0, Math.max(bytes, rawBytes) - outputBytes);
				const available = Math.max(0, this.limits.outputBytes - response.outputBytes);
				response.outputBytes += Math.min(unaccounted, available);
				if (
					controller.signal.aborted ||
					response.cancelled ||
					block.generation !== task.generation ||
					!translated.trim() ||
					rawBytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES ||
					bytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES ||
					unaccounted > available
				) {
					status = "rejected";
					return;
				}
				applyStarted = Date.now();
				const commit = response.apply(
					task,
					{
						id: task.id,
						generation: task.generation,
						start: task.start,
						end: task.end,
						sourceText: task.sourceText,
						translatedText: translated,
					},
					controller.signal,
				);
				// A timed-out display task must not hide a still-settling persistence callback
				// from the shutdown owner. The writer also checks this signal atomically.
				this.running.add(commit);
				void commit.then(
					() => this.running.delete(commit),
					() => this.running.delete(commit),
				);
				const applied = await Promise.race([commit, aborted]);
				status = applied ? "applied" : "stale";
			} catch {
				status = controller.signal.aborted
					? response.cancelled
						? "cancelled"
						: "timeout_or_output_budget"
					: "failed";
			} finally {
				clearTimeout(timeout);
				if (!modelReturned) modelMs = Date.now() - started;
				if (block.active === controller) block.active = undefined;
				this.active--;
				response.pending--;
				this.observe(response, {
					phase: "task",
					abortReason: controller.signal.aborted
						? response.cancelled
							? (response.lifecycleReason ?? "cancel")
							: (block.activeAbortReason ?? abortReason)
						: undefined,
					taskId: task.id,
					elementId: block.id,
					reason: task.reason,
					status,
					start: task.start,
					end: task.end,
					sourceBytes: Buffer.byteLength(task.sourceText),
					queueMs: started - task.queuedAt,
					modelMs,
					applyMs: applyStarted == null ? 0 : Date.now() - applyStarted,
				});
				this.cleanup(response);
				this.pump();
			}
		})();
		this.running.add(work);
		void work.then(
			() => this.running.delete(work),
			() => this.running.delete(work),
		);
	}
}

export const reasoningTranslationScheduler = new ReasoningTranslationScheduler();

export function stopReasoningTranslations(options?: {
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<void> {
	return reasoningTranslationScheduler.stop(options);
}
