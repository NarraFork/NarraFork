import { type ComponentType, type LazyExoticComponent, lazy } from "react";

export interface LazyRetryOptions {
	/** Additional attempts after the initial request. Defaults to one. */
	retries?: number;
	/** Delay between attempts. Defaults to 250ms; tests may use zero. */
	delayMs?: number;
}

/** Browser fetch failures, not errors thrown while evaluating a loaded module. */
export function isDynamicImportFetchError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(
		message,
	);
}

/** Retry only transient module fetching; persistent failures still reach the error boundary. */
export async function loadWithRetry<T>(
	importer: () => Promise<T>,
	{ retries = 1, delayMs = 250 }: LazyRetryOptions = {},
): Promise<T> {
	const maxRetries = Math.max(0, Math.trunc(retries));
	const delay = Math.max(0, delayMs);
	for (let attempt = 0; ; attempt++) {
		try {
			return await importer();
		} catch (error) {
			if (attempt >= maxRetries || !isDynamicImportFetchError(error)) throw error;
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

// biome-ignore lint/suspicious/noExplicitAny: mirrors React's own LazyExoticComponent constraint
export function lazyWithRetry<T extends ComponentType<any>>(
	importer: () => Promise<{ default: T }>,
	options?: LazyRetryOptions,
): LazyExoticComponent<T> {
	return lazy(() => loadWithRetry(importer, options));
}
