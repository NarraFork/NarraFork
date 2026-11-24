import { realpath } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { AppError } from "../lib/errors";

export const ACCESS_PAGE_SIZE = 128;
export const accessCheckUnavailable = () =>
	new AppError(
		"Git workspace access check unavailable",
		503,
		"GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE",
	);

/** One request-local deadline, shared by pagination, filesystem work and ACL checks. */
export class GitAccessScan {
	readonly started = performance.now();
	pages = 0;
	rows = 0;
	private stopped = false;
	private readonly cancellation = new AbortController();
	private deadline: number;
	private readonly failure: Promise<never>;
	private timer: ReturnType<typeof setTimeout>;
	private readonly stop: () => void;
	private failureReason: unknown;
	deadlineAt: number;

	get signal(): AbortSignal {
		return this.cancellation.signal;
	}

	constructor(
		private readonly parentSignal?: AbortSignal,
		budgetMs = 5000,
		deadlineAt = Number.POSITIVE_INFINITY,
	) {
		budgetMs = Math.max(0, Math.min(budgetMs, deadlineAt - Date.now()));
		this.deadlineAt = Math.min(deadlineAt, Date.now() + budgetMs);
		this.deadline = this.started + budgetMs;
		let reject!: (error: Error) => void;
		this.failure = new Promise<never>((_, fail) => {
			reject = fail;
		});
		// The signal may already be aborted before any operation races this promise.
		void this.failure.catch(() => {});
		this.stop = () => {
			if (this.stopped) return;
			this.stopped = true;
			const error = accessCheckUnavailable();
			this.failureReason = error;
			// Preserve the scan's fail-closed boundary before cancelling its worker reads.
			reject(error);
			this.cancellation.abort(error);
		};
		this.timer = setTimeout(this.stop, budgetMs);
		parentSignal?.addEventListener("abort", this.stop, { once: true });
		if (parentSignal?.aborted) this.stop();
	}

	check(): void {
		if (
			this.stopped ||
			this.parentSignal?.aborted ||
			performance.now() >= this.deadline ||
			Date.now() >= this.deadlineAt
		) {
			this.stop();
			throw this.failureReason;
		}
	}

	limitRemaining(budgetMs: number): void {
		this.check();
		this.deadline = Math.min(this.deadline, performance.now() + budgetMs);
		this.deadlineAt = Math.min(this.deadlineAt, Date.now() + budgetMs);
		clearTimeout(this.timer);
		this.timer = setTimeout(this.stop, Math.max(0, this.deadlineAt - Date.now()));
	}

	/** Queueing and worker execution share the scan's original deadline and cancellation. */
	readOptions(): {
		signal: AbortSignal;
		timeoutMs: number;
		deadlineAt: number;
		executionPolicy: "worker-required";
	} {
		this.check();
		return {
			signal: this.cancellation.signal,
			timeoutMs: Math.max(
				1,
				Math.ceil(Math.min(this.deadline - performance.now(), this.deadlineAt - Date.now())),
			),
			deadlineAt: this.deadlineAt,
			executionPolicy: "worker-required",
		};
	}

	async run<T>(operation: () => PromiseLike<T>): Promise<T> {
		this.check();
		const result = await Promise.race([
			Promise.resolve().then(() => {
				this.check();
				return operation();
			}),
			this.failure,
		]);
		this.check();
		return result;
	}

	async *pagesOf<T extends { id: string }>(load: (cursor?: string) => PromiseLike<T[]>) {
		let cursor: string | undefined;
		for (;;) {
			const page = await this.run(() => load(cursor));
			this.pages++;
			this.rows += page.length;
			yield page;
			this.check();
			if (page.length < ACCESS_PAGE_SIZE) return;
			cursor = page[page.length - 1].id;
			await this.run(() => setImmediate());
		}
	}

	async canonicalize<T extends { gitPath: string | null }>(
		rows: T[],
		visit: (row: T, path: string) => void,
		resolve: (path: string) => Promise<string> = realpath,
	): Promise<void> {
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(8, rows.length) }, async () => {
				for (;;) {
					this.check();
					const row = rows[next++];
					if (!row) return;
					if (!row.gitPath) continue;
					let path: string;
					try {
						path = await this.run(() => resolve(row.gitPath as string));
					} catch (error) {
						this.check();
						const code = (error as NodeJS.ErrnoException)?.code;
						if (code === "ENOENT" || code === "ENOTDIR") continue;
						this.stop();
						throw accessCheckUnavailable();
					}
					this.check();
					visit(row, path);
				}
			}),
		);
	}

	dispose(cancelPending = true): void {
		if (cancelPending) this.stop();
		clearTimeout(this.timer);
		this.parentSignal?.removeEventListener("abort", this.stop);
	}
}
