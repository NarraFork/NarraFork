/** Process collectors and their database tails have different preserve-shutdown boundaries. */
export class BackgroundBashLifecycle {
	private collectors = new Map<Promise<unknown>, { taskId: string; processStarted: boolean }>();
	private changed = Promise.withResolvers<void>();
	private terminals = new Set<Promise<unknown>>();
	private cancellations = new Map<
		string,
		{ owner: AbortController | undefined; work: Promise<boolean> }
	>();
	private stopped = false;
	private preserving = false;
	private failed = 0;

	get isStopped(): boolean {
		return this.stopped;
	}

	assertAdmission(): void {
		if (this.stopped) throw new Error("Background Bash admission is stopped");
	}

	stop(options: { preserveProcesses?: boolean } = {}): void {
		this.stopped = true;
		this.preserving = options.preserveProcesses === true;
	}

	getTaskIds(): Set<string> {
		return new Set([...this.collectors.values()].map((entry) => entry.taskId));
	}

	/** Only dispatched processes are preserved; admitted setup must still settle its task row. */
	canStartTerminal(taskId: string): boolean {
		return (
			!this.preserving ||
			![...this.collectors.values()].some(
				(entry) => entry.taskId === taskId && entry.processStarted,
			)
		);
	}

	markCollectorStarted(taskId: string): void {
		for (const entry of this.collectors.values()) {
			if (entry.taskId === taskId) entry.processStarted = true;
		}
		// A preserve drain may already be waiting on a collector's setup, not its process lifetime.
		this.changed.resolve();
		this.changed = Promise.withResolvers<void>();
	}

	trackCollector<T>(taskId: string, work: Promise<T>, processStarted = true): Promise<T> {
		if (this.collectors.has(work)) return work;
		this.collectors.set(work, { taskId, processStarted });
		this.observe(work, () => this.collectors.delete(work));
		return work;
	}

	trackTerminal<T>(work: Promise<T>): Promise<T> {
		this.terminals.add(work);
		this.observe(work, () => this.terminals.delete(work));
		return work;
	}

	/** Only the same cancellation generation joins; other terminal outcomes retain their CAS. */
	runCancellation(
		taskId: string,
		owner: AbortController | undefined,
		start: () => Promise<boolean>,
	): Promise<boolean> {
		const existing = this.cancellations.get(taskId);
		if (existing && existing.owner === owner) return existing.work.then(() => false);
		const work = this.trackTerminal(start());
		const entry = { owner, work };
		this.cancellations.set(taskId, entry);
		const remove = () => {
			if (this.cancellations.get(taskId) === entry) this.cancellations.delete(taskId);
		};
		void work.then(remove, remove);
		return work;
	}

	markFailed(): void {
		this.failed = Math.min(Number.MAX_SAFE_INTEGER, this.failed + 1);
	}

	private observe(work: Promise<unknown>, remove: () => unknown): void {
		// Observe immediately, including rejections settled before shutdown starts.
		// Retain bounded audit state, never an unbounded history of settled promises/errors.
		void work.then(remove, () => {
			this.markFailed();
			remove();
		});
	}

	private pending(): Set<Promise<unknown>> {
		return new Set([
			...this.terminals,
			...[...this.collectors].flatMap(([work, entry]) =>
				this.preserving && entry.processStarted ? [] : [work],
			),
		]);
	}

	getSnapshot() {
		return {
			stopped: this.stopped,
			preserving: this.preserving,
			collectors: this.collectors.size,
			terminals: this.terminals.size,
			pending: this.pending().size,
			failed: this.failed,
		};
	}

	async drain(options: { deadlineAt?: number } = {}): Promise<void> {
		const deadlineAt = options.deadlineAt ?? Date.now() + 4_000;
		for (;;) {
			const pending = this.pending();
			if (!pending.size) break;
			const remaining = deadlineAt - Date.now();
			if (remaining <= 0) throw new Error("Background Bash collectors did not drain");
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.allSettled(pending),
					this.changed.promise,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error("Background Bash collectors did not drain")),
							remaining,
						);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		if (this.failed) throw new Error("Background Bash lifecycle failed");
	}
}
