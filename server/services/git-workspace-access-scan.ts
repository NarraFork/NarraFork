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
	private readonly deadline: number;
	private readonly failure: Promise<never>;
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly stop: () => void;

	constructor(
		private readonly signal?: AbortSignal,
		budgetMs = 5000,
	) {
		this.deadline = this.started + budgetMs;
		let reject!: (error: Error) => void;
		this.failure = new Promise<never>((_, fail) => {
			reject = fail;
		});
		// The signal may already be aborted before any operation races this promise.
		void this.failure.catch(() => {});
		this.stop = () => {
			this.stopped = true;
			reject(accessCheckUnavailable());
		};
		this.timer = setTimeout(this.stop, budgetMs);
		signal?.addEventListener("abort", this.stop, { once: true });
		if (signal?.aborted) this.stop();
	}

	check(): void {
		if (this.stopped || this.signal?.aborted || performance.now() >= this.deadline)
			throw accessCheckUnavailable();
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

	dispose(): void {
		this.stop();
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.stop);
	}
}
