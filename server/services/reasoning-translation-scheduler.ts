import {
	MAX_REASONING_TRANSLATION_VISIBLE_TARGETS,
	type ReasoningTranslationStatus,
} from "@shared/reasoning-translation";

const CONCURRENCY = 4;
const MAX_JOBS = 64;
const MAX_HOLDERS = 256;
const DEADLINE_MS = 30_000;

type Work<T> = {
	target: T;
	holders: Map<object, ((target: T, state: ReasoningTranslationStatus) => void) | undefined>;
	controller?: AbortController;
};

/**
 * Demand owns every queued or running job. Replace a holder's snapshot atomically
 * so refreshing identical visibility neither restarts work nor extends its deadline.
 */
export class ReasoningTranslationScheduler<T> {
	private readonly holders = new Map<object, Set<string>>();
	private readonly jobs = new Map<string, Work<T>>();
	private running = 0;

	constructor(
		private readonly keyOf: (target: T) => string,
		private readonly run: (target: T, signal: AbortSignal) => Promise<void>,
		private readonly onError: (error: unknown) => void,
	) {}

	replace(
		holder: object,
		targets: readonly T[],
		onState?: (target: T, state: ReasoningTranslationStatus) => void,
	): void {
		const previous = this.holders.get(holder);
		const proposed = new Map(
			targets
				.slice(0, MAX_REASONING_TRANSLATION_VISIBLE_TARGETS)
				.map((target) => [this.keyOf(target), target]),
		);
		if (!previous && this.holders.size >= MAX_HOLDERS) {
			for (const target of proposed.values()) onState?.(target, "deferred");
			return;
		}
		for (const key of previous ?? []) {
			if (proposed.has(key)) continue;
			const job = this.jobs.get(key);
			if (!job?.holders.has(holder)) continue;
			job.holders.get(holder)?.(job.target, "idle");
			job.holders.delete(holder);
			if (job.holders.size) continue;
			this.jobs.delete(key);
			job.controller?.abort();
		}
		const next = new Set<string>();
		for (const [key, target] of proposed) {
			let job = this.jobs.get(key);
			if (job?.holders.has(holder)) {
				next.add(key);
				continue;
			}
			if (!job) {
				if (this.jobs.size >= MAX_JOBS) {
					onState?.(target, "deferred");
					continue;
				}
				job = { target, holders: new Map() };
				this.jobs.set(key, job);
			}
			job.holders.set(holder, onState);
			onState?.(target, job.controller ? "running" : "queued");
			next.add(key);
		}
		if (next.size) this.holders.set(holder, next);
		else this.holders.delete(holder);
		this.drain();
	}

	private drain(): void {
		for (const [key, job] of this.jobs) {
			if (this.running >= CONCURRENCY) break;
			if (job.controller) continue;
			const controller = new AbortController();
			job.controller = controller;
			for (const listener of job.holders.values()) listener?.(job.target, "running");
			this.running++;
			const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
			void Promise.resolve()
				.then(() => {
					if (!controller.signal.aborted) return this.run(job.target, controller.signal);
				})
				.catch((error) => {
					if (!controller.signal.aborted) this.onError(error);
				})
				.finally(() => {
					clearTimeout(deadline);
					this.running--;
					if (this.jobs.get(key) === job) {
						this.jobs.delete(key);
						for (const [holder, listener] of job.holders) {
							const keys = this.holders.get(holder);
							keys?.delete(key);
							if (keys?.size === 0) this.holders.delete(holder);
							listener?.(job.target, "idle");
						}
					}
					this.drain();
				});
		}
	}
}
