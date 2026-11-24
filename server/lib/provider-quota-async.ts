import type { ProviderQuotaErrorCode } from "@shared/provider-quota";

/** Fixed public error codes; transport exceptions and upstream payloads never escape. */
export class ProviderQuotaError extends Error {
	constructor(readonly code: ProviderQuotaErrorCode) {
		super(code);
		this.name = "ProviderQuotaError";
	}
}

/** Release capacity even when a plugin/transport ignores AbortSignal. Consume late failures. */
export function quotaAbortable<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	onLate?: (value: T) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const abort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			reject(
				signal.reason instanceof ProviderQuotaError
					? signal.reason
					: new ProviderQuotaError("timeout"),
			);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		promise.then(
			(result) => {
				signal.removeEventListener("abort", abort);
				if (settled) onLate?.(result);
				else {
					settled = true;
					resolve(result);
				}
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				if (settled) return;
				settled = true;
				reject(
					error instanceof ProviderQuotaError ? error : new ProviderQuotaError("request_failed"),
				);
			},
		);
	});
}

/** Host-only provenance: JSON/plugin stream chunks cannot forge this WeakMap attachment. */
export interface FrozenCustomApiQuotaTarget {
	providerId: string;
	generation: string;
	keyId?: string;
}
const frozenQuotaEvents = new WeakMap<object, FrozenCustomApiQuotaTarget | null>();
export function bindFrozenQuotaTarget(
	event: object,
	target: FrozenCustomApiQuotaTarget | null,
): void {
	frozenQuotaEvents.set(event, target ? Object.freeze({ ...target }) : null);
}
export function frozenQuotaTargetFor(event: object): FrozenCustomApiQuotaTarget | null | undefined {
	return frozenQuotaEvents.get(event);
}
