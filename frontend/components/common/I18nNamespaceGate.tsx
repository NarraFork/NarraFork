import { type ReactNode, use, useSyncExternalStore } from "react";
import i18n, { ensureI18nNamespaces, type Namespace } from "../../lib/i18n";

function subscribeToLanguage(onChange: () => void): () => void {
	i18n.on("languageChanged", onChange);
	return () => i18n.off("languageChanged", onChange);
}

function getLanguageSnapshot(): string {
	return i18n.resolvedLanguage ?? i18n.language ?? "en";
}

/** Suspends only its own surface until every requested translation bundle is ready. */
export function I18nNamespaceGate({
	namespaces,
	children,
}: {
	namespaces: readonly Namespace[];
	children: ReactNode;
}) {
	const language = useSyncExternalStore(subscribeToLanguage, getLanguageSnapshot, () => "en");
	use(ensureI18nNamespaces(namespaces, language));
	return children;
}
