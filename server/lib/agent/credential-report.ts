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
export function reportCredentialId<T extends ProviderAdapter>(adapter: T, credentialId: string): T {
	const chat = adapter.chat.bind(adapter);
	adapter.chat = async function* (params) {
		const onRequestStart = params.onRequestStart;
		for await (const event of chat({
			...params,
			onRequestStart: onRequestStart && ((info) => onRequestStart({ ...info, credentialId })),
		})) {
			yield { ...event, credentialId };
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
