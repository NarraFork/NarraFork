import { setTimeout as delay } from "node:timers/promises";

/** Only SQLite lock contention is transient; IO and arbitrary messages are not. */
export function isRetryableWorkspaceMetadataError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
		const value = current as { code?: unknown; errno?: unknown; cause?: unknown };
		if (
			(typeof value.code === "string" && /^SQLITE_(BUSY|LOCKED)(?:_[A-Z]+)*$/.test(value.code)) ||
			(value.code === undefined &&
				current instanceof Error &&
				current.name === "SQLiteError" &&
				typeof value.errno === "number" &&
				[5, 6].includes(value.errno & 0xff))
		)
			return true;
		current = value.cause;
	}
	return false;
}

/** Call with metadata-only work; never include file IO or cancelled signals. */
export async function retryWorkspaceMetadata<T>(
	work: () => T | Promise<T>,
	options: { deadline?: number } = {},
): Promise<T> {
	const deadline = Math.min(
		options.deadline ?? Number.POSITIVE_INFINITY,
		performance.now() + 2_000,
	);
	const backoff = [50, 150, 400];
	for (let attempt = 0; ; attempt++) {
		try {
			return await work();
		} catch (error) {
			const wait = backoff[attempt];
			if (
				wait === undefined ||
				!isRetryableWorkspaceMetadataError(error) ||
				performance.now() + wait >= deadline
			)
				throw error;
			await delay(wait);
			if (performance.now() >= deadline) throw error;
		}
	}
}
