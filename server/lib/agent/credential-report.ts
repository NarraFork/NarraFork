import {
	bindFrozenQuotaTarget,
	type FrozenCustomApiQuotaTarget,
	frozenQuotaTargetFor,
} from "../provider-quota-async";
import type { ProviderAdapter } from "./provider";

/**
 * Make an adapter that runs on exactly one credential name it on every accounted path:
 * the request start, each stream event and the non-streaming `*WithMeta` results. The
 * value is forced, so whatever an inner adapter reports (its own `config.id`) never
 * reaches the books.
 *
 * The instance is patched in place rather than wrapped, so `instanceof` checks,
 * state set by `prepareForModel`, and hooks the registry attaches afterwards
 * (`isDiagnosticConnectionCurrent`) keep working on the same object.
 */
export function reportCredentialId<T extends ProviderAdapter>(
	adapter: T,
	credentialId: string,
	quotaCredential?: { providerId: string; keyId?: string },
): T {
	const quotaSubject = quotaCredential && Object.freeze({ ...quotaCredential });
	const chat = adapter.chat.bind(adapter);
	adapter.chat = async function* (params) {
		// Freeze the actual key before request preparation can yield. The billing id
		// may still be the group id; it cannot identify this quota subject.
		let capturedQuota: FrozenCustomApiQuotaTarget | null | undefined;
		if (quotaSubject && params.captureCustomApiQuotaTarget) {
			capturedQuota = null;
			try {
				if (adapter.isDiagnosticConnectionCurrent?.() !== false) {
					const target = params.captureCustomApiQuotaTarget(
						quotaSubject.providerId,
						quotaSubject.keyId ?? quotaSubject.providerId,
					);
					capturedQuota = target ? Object.freeze({ ...target }) : null;
				}
			} catch {
				/* Display provenance failure must not change inference behavior. */
			}
		}
		const onRequestStart = params.onRequestStart;
		for await (const event of chat({
			...params,
			onRequestStart:
				onRequestStart &&
				((info) =>
					onRequestStart({
						...info,
						credentialId,
						...(quotaSubject?.keyId && { quotaCredentialId: quotaSubject.keyId }),
						validateDiagnosticCredential: () =>
							adapter.isDiagnosticConnectionCurrent?.() !== false &&
							info?.validateDiagnosticCredential?.() !== false,
					})),
		})) {
			const decorated = { ...event, credentialId };
			// Copy host-only provenance too, including an inner wrapper's explicit null.
			const inheritedQuota = frozenQuotaTargetFor(event);
			const target = inheritedQuota !== undefined ? inheritedQuota : capturedQuota;
			if (target !== undefined) bindFrozenQuotaTarget(decorated, target);
			yield decorated;
		}
	};
	const generateWithMeta = adapter.generateWithMeta.bind(adapter);
	adapter.generateWithMeta = async (...args) => ({
		...(await generateWithMeta(...args)),
		credentialId,
	});
	const generateWithHistoryWithMeta = adapter.generateWithHistoryWithMeta?.bind(adapter);
	if (generateWithHistoryWithMeta) {
		adapter.generateWithHistoryWithMeta = async (...args) => ({
			...(await generateWithHistoryWithMeta(...args)),
			credentialId,
		});
	}
	return adapter;
}
