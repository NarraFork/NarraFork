import { hotSafe } from "../lib/hot-safe";
import type { IntegrationAuthorityState } from "./integration-authority-service";

export interface IntegrationAuthorityInvalidation {
	authorityId: string;
	revision: number;
	state: IntegrationAuthorityState;
	reason: string;
}

export type IntegrationAuthorityInvalidationListener = (
	event: IntegrationAuthorityInvalidation,
) => void;

const listeners = hotSafe(
	"narrafork:integrationAuthorityInvalidationListeners",
	() => new Map<string, IntegrationAuthorityInvalidationListener>(),
);

export function setIntegrationAuthorityInvalidationListener(
	key: string,
	listener: IntegrationAuthorityInvalidationListener,
): () => void {
	listeners.set(key, listener);
	return () => {
		if (listeners.get(key) === listener) listeners.delete(key);
	};
}

export function emitIntegrationAuthorityInvalidation(
	event: IntegrationAuthorityInvalidation,
): void {
	for (const listener of [...listeners.values()]) {
		try {
			listener(event);
		} catch {
			// Invalidation listeners cannot roll back a committed authority mutation.
		}
	}
}
