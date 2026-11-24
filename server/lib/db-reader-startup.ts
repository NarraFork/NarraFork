import {
	DATABASE_READ_RETRY_AFTER_SECONDS,
	type DatabaseReaderReadiness,
	type DatabaseReaderResult,
} from "./db-reader-readiness";

export function createDatabaseReaderStartup(options: {
	readiness: DatabaseReaderReadiness;
	initialize: () => Promise<void>;
	onUnavailable: (result: Extract<DatabaseReaderResult, { ok: false }>) => void;
	onError: (error: unknown) => void;
	onStop?: () => void;
	retryIntervalMs?: number;
}) {
	const retryIntervalMs = options.retryIntervalMs ?? DATABASE_READ_RETRY_AFTER_SECONDS * 1000;
	if (!Number.isFinite(retryIntervalMs) || retryIntervalMs <= 0)
		throw new Error("Invalid database startup retry interval");
	let stopped = false;
	let initialized = false;
	let pending = false;
	let initialization: Promise<void> | undefined;
	let initialAttempt: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reportedUnavailable = false;

	async function initializeOnce(): Promise<void> {
		if (stopped || initialized) return;
		initialized = true;
		pending = true;
		initialization = (async () => {
			try {
				await options.initialize();
			} finally {
				pending = false;
			}
		})();
		await initialization;
	}

	async function attempt(): Promise<void> {
		if (stopped) return;
		try {
			const result = await options.readiness.wait();
			if (stopped) return;
			if (result.ok) {
				await initializeOnce();
				return;
			}
			if (!reportedUnavailable) {
				reportedUnavailable = true;
				options.onUnavailable(result);
			}
			if (stopped) return;
			timer = setTimeout(() => {
				timer = undefined;
				void attempt();
			}, retryIntervalMs);
			timer.unref();
		} catch (error) {
			if (!stopped) options.onError(error);
		}
	}

	return {
		get pending(): boolean {
			return pending;
		},
		async drain(): Promise<void> {
			await initialization;
		},
		start(): Promise<void> {
			initialAttempt ??= attempt();
			return initialAttempt;
		},
		stop(): void {
			if (stopped) return;
			stopped = true;
			clearTimeout(timer);
			timer = undefined;
			options.onStop?.();
		},
	};
}
