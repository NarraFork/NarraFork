import {
	isReasoningTranslationBoundary,
	MAX_REASONING_TRANSLATION_OUTPUT_BYTES,
	MAX_REASONING_TRANSLATION_SOURCE_BYTES,
	MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES,
	preserveReasoningTranslationWhitespace,
	type ReasoningTranslationPart,
} from "@shared/reasoning-translation";
import { generateId } from "../lib/id";

export const REASONING_TRANSLATION_LIMITS = {
	concurrency: 4,
	queuedBlocks: 64,
	coalesceMs: 10_000,
	deadlineMs: 30_000,
	sourceBytes: 256 * 1024,
	tasks: 32,
	outputBytes: 512 * 1024,
} as const;

export interface TranslationTask {
	id: string;
	/** Scheduler-local source range key, never a persistent narrator_blocks primary key. */
	elementId: string;
	messageId: string;
	generation: string;
	start: number;
	end: number;
	sourceText: string;
	reason: "tool" | "summary" | "final";
	queuedAt: number;
}
interface CoalescingWindow {
	readyAt: number;
	started: boolean;
	members: number;
	key?: string;
}
interface Tail {
	start: number;
	end: number;
	text: string;
	boundaries: number[];
	queuedAt: number;
	/** A sent chunk stays ready; an appended suffix belongs to the next fixed window. */
	windows: Array<{ end: number; window: CoalescingWindow }>;
	reason: TranslationTask["reason"];
	messageId: string;
}
interface Block {
	id: string;
	generation: string;
	covered: number;
	active?: AbortController;
	activeRange?: { start: number; end: number };
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
	queuedAt?: number;
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
	/** Only verified, compatible completed sources share this request key. */
	batchKey?: string;
	/** A desired key (including undefined) waits until all current requests/applies settle. */
	batchTransition?: { key?: string };
	order?: number;
	canTranslate?: (signal: AbortSignal) => Promise<boolean>;
	permitsTask?: (task: TranslationTask) => boolean;
	translateBatch?: (
		tasks: readonly TranslationTask[],
		signal: AbortSignal,
		onDelta: (text: string) => void,
	) => Promise<string>;
	onState?: (state: "queued" | "running" | "idle") => void;
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

/** The provider sees only request-local IDs; source coordinates never come from its output. */
function readTranslationBatch(
	raw: string,
	tasks: readonly TranslationTask[],
): Map<string, string> | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const parts = (value as { parts?: unknown }).parts;
		if (!Array.isArray(parts) || parts.length !== tasks.length || parts.length > 512) return null;
		const expected = new Map(tasks.map((task) => [task.id, task]));
		const result = new Map<string, string>();
		let bytes = 0;
		for (const part of parts) {
			if (
				!part ||
				typeof part !== "object" ||
				typeof part.id !== "string" ||
				typeof part.translatedText !== "string" ||
				!part.translatedText.trim() ||
				!expected.has(part.id) ||
				result.has(part.id)
			)
				return null;
			const task = expected.get(part.id);
			if (!task) return null;
			const text = preserveReasoningTranslationWhitespace(task.sourceText, part.translatedText);
			bytes += Buffer.byteLength(text);
			if (bytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES) return null;
			result.set(part.id, text);
		}
		return result;
	} catch {
		return null;
	}
}

/** One bounded queue; rotating sessions prevents a long response monopolizing slots. */
export class ReasoningTranslationScheduler {
	private active = 0;
	private stopping = false;
	private readonly running = new Set<Promise<unknown>>();
	private readonly responses = new Set<ReasoningTranslationResponse>();
	private sessions: string[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private holds = 0;
	private readonly activeBatches = new Set<string>();
	/** Only unsent windows accept new sources; tails retain already-started chunk windows. */
	private readonly batchWindows = new Map<string, CoalescingWindow>();

	/** Publish one bounded load round atomically to the existing queue. */
	hold(): () => void {
		this.holds++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holds--;
			this.pump();
		};
	}
	constructor(
		private readonly limits: {
			[K in keyof typeof REASONING_TRANSLATION_LIMITS]: number;
		} = REASONING_TRANSLATION_LIMITS,
	) {}

	create(
		options: Pick<
			ReasoningTranslationResponse,
			| "sessionId"
			| "translate"
			| "translateBatch"
			| "batchKey"
			| "canTranslate"
			| "permitsTask"
			| "order"
			| "apply"
			| "onIdle"
			| "onState"
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
		};
	}

	/** Preserve current requests and queue budgets while changing later batch membership. */
	configureBatch(response: ReasoningTranslationResponse, key: string | undefined): void {
		if (this.stopping || response.cancelled) return;
		const previousKey = response.batchTransition ? response.batchTransition.key : response.batchKey;
		if (previousKey === key) return;
		if (response.batchKey === key) response.batchTransition = undefined;
		else if (this.hasActiveWork(response)) response.batchTransition = { key };
		else {
			response.batchKey = key;
			response.batchTransition = undefined;
		}
		const now = Date.now();
		for (const block of response.blocks.values()) {
			if (!block.tail) continue;
			const windows: Tail["windows"] = [];
			let pending: CoalescingWindow | undefined;
			for (const part of block.tail.windows) {
				this.releaseWindow(part.window);
				// Mature chunks retain their eligibility across a key change, but do not
				// admit new suffixes into a window that has already elapsed or started.
				let window: CoalescingWindow;
				if (part.window.started || part.window.readyAt <= now)
					window = { key, readyAt: part.window.readyAt, started: true, members: 0 };
				else {
					pending ??= this.queueWindow(response);
					window = pending;
				}
				const previous = windows.at(-1);
				if (previous?.window === window) previous.end = part.end;
				else {
					window.members++;
					windows.push({ end: part.end, window });
				}
			}
			block.tail.windows = windows;
		}
		this.pump();
	}

	private hasActiveWork(response: ReasoningTranslationResponse): boolean {
		let queued = 0;
		for (const block of response.blocks.values()) if (block.tail) queued++;
		// pending also counts detached/cancelled members until their apply/finally ends.
		return response.pending > queued;
	}

	freeze(
		response: ReasoningTranslationResponse,
		input: {
			elementId: string;
			messageId: string;
			generation: string;
			/** Complete source text; start/end retain its original UTF-16 coordinates. */
			text: string;
			/** Initial offset for a new block key; subsequent freezes keep its reserved prefix. */
			start?: number;
			end?: number;
			reason: TranslationTask["reason"];
		},
	): void {
		if (
			this.stopping ||
			response.cancelled ||
			response.settled ||
			(response.queuedAt !== undefined && Date.now() >= response.queuedAt + this.limits.deadlineMs)
		)
			return;
		const initialStart = input.start ?? 0;
		const end = input.end ?? input.text.length;
		if (
			initialStart > end ||
			!isReasoningTranslationBoundary(input.text, initialStart) ||
			!isReasoningTranslationBoundary(input.text, end)
		)
			return;
		let block = response.blocks.get(input.elementId);
		if (block && block.generation !== input.generation) {
			this.dropTail(response, block);
			block.active?.abort();
			block.generation = input.generation;
			block.covered = initialStart;
		}
		if (!block) {
			if (
				response.blocks.size >=
				(response.batchKey ? 512 : this.limits.tasks + this.limits.queuedBlocks)
			)
				return;
			block = { id: input.elementId, generation: input.generation, covered: initialStart };
			response.blocks.set(input.elementId, block);
		}
		const start = block.covered;
		// Disjoint missing ranges need separate block keys, never a bridged tail.
		if (initialStart > start) return;
		if (end <= start) {
			if (block.tail && input.reason !== "summary") block.tail.reason = input.reason;
			return;
		}
		if (!isReasoningTranslationBoundary(input.text, start)) return;
		// Reserve even rejected ranges: failures never reopen an already frozen prefix.
		block.covered = end;
		if (response.tasks >= this.limits.tasks) return;
		if (response.outputBytes >= this.limits.outputBytes) return;
		if (
			!block.tail &&
			this.queuedSources() >= this.limits.queuedBlocks &&
			(!response.batchKey || !Array.from(response.blocks.values()).some((item) => item.tail))
		)
			return;
		if (block.tail && block.tail.end !== start) return;
		const acceptedEnd = translationPrefixEnd(
			input.text,
			start,
			end,
			this.limits.sourceBytes - response.sourceBytes,
		);
		if (acceptedEnd <= start) return;
		const text = input.text.slice(start, acceptedEnd);
		response.sourceBytes += Buffer.byteLength(text);
		const now = Date.now();
		response.queuedAt ??= now;
		const window = this.queueWindow(response, block.tail);
		if (block.tail) {
			block.tail.text += text;
			block.tail.end = acceptedEnd;
			if (block.tail.boundaries.length < this.limits.tasks) block.tail.boundaries.push(acceptedEnd);
			const last = block.tail.windows.at(-1);
			if (last?.window === window) last.end = acceptedEnd;
			else {
				window.members++;
				block.tail.windows.push({ end: acceptedEnd, window });
			}
			block.tail.reason = input.reason;
		} else {
			window.members++;
			block.tail = {
				start,
				end: acceptedEnd,
				text,
				boundaries: [acceptedEnd],
				queuedAt: response.queuedAt,
				windows: [{ end: acceptedEnd, window }],
				reason: input.reason,
				messageId: input.messageId,
			};
			response.pending++;
		}
		this.responses.add(response);
		response.onState?.(
			Array.from(response.blocks.values()).some((item) => item.active) ? "running" : "queued",
		);
		if (!this.sessions.includes(response.sessionId)) this.sessions.push(response.sessionId);
		this.pump();
	}

	/** Reopening a tail invalidates only work outside the newly sealed ranges. */
	retain(
		response: ReasoningTranslationResponse,
		permits: (start: number, end: number) => boolean,
	): void {
		for (const [key, block] of response.blocks) {
			const tailInvalid = !!block.tail && !permits(block.tail.start, block.tail.end);
			const activeInvalid =
				!!block.active &&
				!!block.activeRange &&
				!permits(block.activeRange.start, block.activeRange.end);
			if (tailInvalid) this.dropTail(response, block);
			if (activeInvalid && block.active) {
				const controller = block.active;
				// Batched members share a request: retain valid siblings and reject only the
				// invalid member at apply. Abort the provider when none remain eligible.
				if (
					![...response.blocks.values()].some(
						(other) =>
							other.active === controller &&
							other.activeRange &&
							permits(other.activeRange.start, other.activeRange.end),
					)
				)
					controller.abort();
			}
			if (tailInvalid && !activeInvalid && block.active && block.activeRange)
				block.covered = block.activeRange.end;
			else if ((tailInvalid || activeInvalid) && !block.tail) response.blocks.delete(key);
		}
		this.cleanup(response);
		this.pump();
	}

	/** A completed source replans unsent streaming ranges after its active write settles. */
	discardQueued(response: ReasoningTranslationResponse): void {
		for (const block of response.blocks.values()) {
			if (!block.tail) continue;
			response.sourceBytes -= Buffer.byteLength(block.tail.text);
			this.dropTail(response, block);
		}
		this.cleanup(response);
		this.pump();
	}

	settle(response: ReasoningTranslationResponse): void {
		response.settled = true;
		this.cleanup(response);
	}
	cancel(response: ReasoningTranslationResponse): void {
		response.cancelled = response.settled = true;
		response.batchTransition = undefined;
		for (const block of response.blocks.values()) {
			this.dropTail(response, block);
			block.active?.abort();
		}
		this.cleanup(response);
		this.pump();
	}
	async stop(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
		this.stopping = true;
		for (const response of [...this.responses]) this.cancel(response);
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
			queued: this.queuedSources(),
			responses: this.responses.size,
			sessions: this.sessions.length,
		};
	}
	private queuedSources(): number {
		let count = 0;
		for (const response of this.responses) {
			const tails = Array.from(response.blocks.values()).filter((block) => block.tail).length;
			count += response.batchKey ? Number(tails > 0) : tails;
		}
		return count;
	}
	private queueWindow(response: ReasoningTranslationResponse, tail?: Tail): CoalescingWindow {
		const key = response.batchTransition ? response.batchTransition.key : response.batchKey;
		const previous = key ? this.batchWindows.get(key) : tail?.windows.at(-1)?.window;
		if (previous && !previous.started) return previous;
		const window: CoalescingWindow = {
			key,
			readyAt: Date.now() + this.limits.coalesceMs,
			started: false,
			members: 0,
		};
		if (key) this.batchWindows.set(key, window);
		return window;
	}
	private releaseWindow(window: CoalescingWindow): void {
		window.members--;
		if (!window.members && window.key && this.batchWindows.get(window.key) === window)
			this.batchWindows.delete(window.key);
	}
	private readyEnd(tail: Tail, now: number): number {
		let end = tail.start;
		for (const part of tail.windows) {
			if (part.window.readyAt > now) break;
			end = part.end;
		}
		return end;
	}
	private consumeTail(response: ReasoningTranslationResponse, block: Block, length: number): void {
		const tail = block.tail as Tail;
		const end = tail.start + length;
		let start = tail.start;
		for (const part of tail.windows) {
			if (start >= end) break;
			part.window.started = true;
			if (part.window.key && this.batchWindows.get(part.window.key) === part.window)
				this.batchWindows.delete(part.window.key);
			start = part.end;
		}
		if (end === tail.end) this.dropTail(response, block);
		else {
			tail.text = tail.text.slice(length);
			tail.start = end;
			tail.boundaries = tail.boundaries.filter((boundary) => boundary > end);
			tail.windows = tail.windows.filter((part) => {
				if (part.end > end) return true;
				this.releaseWindow(part.window);
				return false;
			});
		}
	}
	private dropTail(response: ReasoningTranslationResponse, block: Block): void {
		if (!block.tail) return;
		for (const { window } of block.tail.windows) this.releaseWindow(window);
		block.tail = undefined;
		response.pending--;
	}
	private cleanup(response: ReasoningTranslationResponse): void {
		if (response.batchTransition && !this.hasActiveWork(response)) {
			response.batchKey = response.batchTransition.key;
			response.batchTransition = undefined;
		}
		response.onState?.(
			response.cancelled || !response.pending
				? "idle"
				: Array.from(response.blocks.values()).some((block) => block.active)
					? "running"
					: "queued",
		);
		if (response.pending !== 0) return;
		this.responses.delete(response);
		if (!Array.from(this.responses).some((item) => item.sessionId === response.sessionId))
			this.sessions = this.sessions.filter((id) => id !== response.sessionId);
		if (response.settled) {
			response.blocks.clear();
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
					this.dropTail(response, block);
				}
			}
			this.cleanup(response);
		}
		while (!this.stopping && !this.holds && this.active < this.limits.concurrency) {
			let selected: { response: ReasoningTranslationResponse; block: Block } | undefined;
			for (let i = 0; i < this.sessions.length; i++) {
				const sessionId = this.sessions.shift() as string;
				this.sessions.push(sessionId);
				for (const response of this.responses) {
					if (
						response.sessionId !== sessionId ||
						response.cancelled ||
						response.batchTransition ||
						response.tasks >= this.limits.tasks ||
						response.outputBytes >= this.limits.outputBytes
					)
						continue;
					if (response.batchKey && this.activeBatches.has(response.batchKey)) continue;
					for (const block of response.blocks.values()) {
						if (!block.active && block.tail && this.readyEnd(block.tail, now) > block.tail.start) {
							selected = { response, block };
							break;
						}
					}
					if (selected) break;
				}
				if (selected) break;
			}
			if (!selected) break;
			if (selected.response.batchKey && selected.response.translateBatch)
				this.startBatch(selected.response, selected.block);
			else this.start(selected.response, selected.block);
		}
		let nextWake = Number.POSITIVE_INFINITY;
		for (const response of this.responses) {
			for (const block of response.blocks.values()) {
				if (!block.tail) continue;
				nextWake = Math.min(nextWake, block.tail.queuedAt + this.limits.deadlineMs);
				if (
					!this.holds &&
					!response.batchTransition &&
					this.active < this.limits.concurrency &&
					!block.active &&
					(!response.batchKey || !this.activeBatches.has(response.batchKey))
				)
					nextWake = Math.min(nextWake, block.tail.windows[0].window.readyAt);
			}
			this.cleanup(response);
		}
		if (Number.isFinite(nextWake)) {
			this.timer = setTimeout(() => this.pump(), Math.max(1, nextWake - Date.now()));
			this.timer.unref?.();
		}
	}
	private startBatch(first: ReasoningTranslationResponse, firstBlock: Block): void {
		const translate = first.translateBatch;
		const batchKey = first.batchKey;
		if (!translate || !batchKey) return;
		const members: Array<{
			response: ReasoningTranslationResponse;
			block: Block;
			task: TranslationTask;
			controller: AbortController;
		}> = [];
		let remaining = MAX_REASONING_TRANSLATION_SOURCE_BYTES;
		const now = Date.now();
		const candidates = [first, ...Array.from(this.responses).filter((item) => item !== first)].sort(
			(a, b) => (a.order ?? 0) - (b.order ?? 0),
		);
		for (const response of candidates) {
			if (
				response.batchKey !== first.batchKey ||
				!response.translateBatch ||
				response.cancelled ||
				response.batchTransition ||
				response.tasks >= this.limits.tasks ||
				response.outputBytes >= this.limits.outputBytes ||
				this.hasActiveWork(response)
			)
				continue;
			const blocks =
				response === first
					? [
							firstBlock,
							...Array.from(response.blocks.values()).filter((block) => block !== firstBlock),
						]
					: Array.from(response.blocks.values());
			const controller = new AbortController();
			let accepted = false;
			for (const block of blocks) {
				const tail = block.tail;
				if (!tail || members.length >= 512 || remaining <= 0) continue;
				const length = translationPrefixEnd(
					tail.text,
					0,
					this.readyEnd(tail, now) - tail.start,
					remaining,
				);
				if (!length) continue;
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
				remaining -= Buffer.byteLength(task.sourceText);
				this.consumeTail(response, block, length);
				block.active = controller;
				block.activeRange = { start: task.start, end: task.end };
				response.pending++;
				members.push({ response, block, task, controller });
				accepted = true;
			}
			if (accepted) {
				response.tasks++;
				response.onState?.("running");
			}
		}
		if (!members.length) return;
		// Keep later sources behind an active partial source, so the next request can
		// fill the same 32KiB box rather than prematurely sending a short extra request.
		this.activeBatches.add(batchKey);
		this.active++;
		const controller = new AbortController();
		const responses = new Set(members.map((item) => item.response));
		const sources = new Set(members.map((item) => item.controller));
		const onMemberAbort = () => {
			if (Array.from(sources).every((source) => source.signal.aborted)) controller.abort();
		};
		for (const source of sources)
			source.signal.addEventListener("abort", onMemberAbort, { once: true });
		const queuedAt = Math.min(...members.map((item) => item.task.queuedAt));
		const timeout = setTimeout(
			() => controller.abort(),
			Math.max(0, queuedAt + this.limits.deadlineMs - Date.now()),
		);
		timeout.unref?.();
		const aborted = new Promise<never>((_resolve, reject) =>
			controller.signal.addEventListener(
				"abort",
				() => reject(new Error("translation_cancelled")),
				{ once: true },
			),
		);
		let outputBytes = 0;
		const account = (bytes: number) => {
			for (const response of responses) {
				if (response.cancelled) continue;
				const available = Math.max(0, this.limits.outputBytes - response.outputBytes);
				response.outputBytes += Math.min(bytes, available);
				if (bytes > available) controller.abort();
			}
		};
		const work = (async () => {
			let sent: typeof members = [];
			try {
				const request = async () => {
					await Promise.all(
						Array.from(responses).map(async (response) => {
							if (
								response.canTranslate &&
								!(await response.canTranslate(controller.signal).catch(() => false))
							)
								this.cancel(response);
						}),
					);
					sent = members.filter(
						(item) =>
							!item.response.cancelled &&
							!item.controller.signal.aborted &&
							(item.response.permitsTask?.(item.task) ?? true),
					);
					if (!sent.length || controller.signal.aborted) return "";
					return (sent[0].response.translateBatch ?? translate)(
						sent.map((item) => item.task),
						controller.signal,
						(delta) => {
							if (controller.signal.aborted) return;
							const bytes = Buffer.byteLength(delta);
							outputBytes += bytes;
							account(bytes);
							if (outputBytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES) controller.abort();
						},
					);
				};
				const raw = await Promise.race([request(), aborted]);
				if (controller.signal.aborted || raw.length > MAX_REASONING_TRANSLATION_OUTPUT_BYTES)
					return;
				const rawBytes = Buffer.byteLength(raw);
				account(Math.max(0, rawBytes - outputBytes));
				if (controller.signal.aborted || rawBytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES) return;
				const translated = readTranslationBatch(
					raw,
					sent.map((item) => item.task),
				);
				if (!translated) return;
				const restoredBytes = Array.from(translated.values()).reduce(
					(sum, text) => sum + Buffer.byteLength(text),
					0,
				);
				account(Math.max(0, restoredBytes - Math.max(rawBytes, outputBytes)));
				if (controller.signal.aborted) return;
				// Validate the entire ID set and all contents before making the first durable write.
				for (const member of members) {
					const { response, block, task } = member;
					if (
						controller.signal.aborted ||
						member.controller.signal.aborted ||
						response.cancelled ||
						block.generation !== task.generation
					)
						continue;
					const signal = AbortSignal.any([controller.signal, member.controller.signal]);
					const translatedText = translated.get(task.id);
					if (translatedText === undefined) continue;
					const commit = response.apply(
						task,
						{
							id: task.id,
							generation: task.generation,
							start: task.start,
							end: task.end,
							sourceText: task.sourceText,
							translatedText,
						},
						signal,
					);
					this.running.add(commit);
					try {
						await commit;
					} catch {
						/* An invalid member does not discard other sources. */
					} finally {
						this.running.delete(commit);
					}
				}
			} catch {
				// One failed bounded request leaves its original sources available unchanged.
			} finally {
				clearTimeout(timeout);
				for (const source of sources) source.signal.removeEventListener("abort", onMemberAbort);
				for (const { response, block, controller: memberController } of members) {
					if (block.active === memberController) block.active = undefined;
					response.pending--;
				}
				this.active--;
				this.activeBatches.delete(batchKey);
				for (const response of responses) this.cleanup(response);
				this.pump();
			}
		})();
		this.running.add(work);
		void work.then(
			() => this.running.delete(work),
			() => this.running.delete(work),
		);
	}

	private start(response: ReasoningTranslationResponse, block: Block): void {
		const tail = block.tail as Tail;
		let length = translationPrefixEnd(
			tail.text,
			0,
			this.readyEnd(tail, Date.now()) - tail.start,
			MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES,
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
		this.consumeTail(response, block, length);
		response.tasks++;
		response.pending++;
		this.active++;
		const controller = new AbortController();
		block.active = controller;
		block.activeRange = { start: task.start, end: task.end };
		response.onState?.("running");
		let outputBytes = 0;
		const timeout = setTimeout(
			() => controller.abort(),
			Math.max(0, tail.queuedAt + this.limits.deadlineMs - Date.now()),
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
						if (controller.signal.aborted || response.cancelled) return;
						const bytes = Buffer.byteLength(delta);
						outputBytes += bytes;
						const available = Math.max(0, this.limits.outputBytes - response.outputBytes);
						response.outputBytes += Math.min(bytes, available);
						if (outputBytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES || bytes > available)
							controller.abort();
					}),
					aborted,
				]);
				if (controller.signal.aborted || response.cancelled || block.generation !== task.generation)
					return;
				const translated = preserveReasoningTranslationWhitespace(task.sourceText, result);
				const bytes = Buffer.byteLength(translated);
				const rawBytes = Buffer.byteLength(result);
				const unaccounted = Math.max(0, Math.max(bytes, rawBytes) - outputBytes);
				const available = Math.max(0, this.limits.outputBytes - response.outputBytes);
				response.outputBytes += Math.min(unaccounted, available);
				if (
					!translated.trim() ||
					rawBytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES ||
					bytes > MAX_REASONING_TRANSLATION_OUTPUT_BYTES ||
					unaccounted > available
				)
					return;
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
				await commit;
			} catch {
				// Display translation failures leave the frozen source available unchanged.
			} finally {
				clearTimeout(timeout);
				if (block.active === controller) block.active = undefined;
				this.active--;
				response.pending--;
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
