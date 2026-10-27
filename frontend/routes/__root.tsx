import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { RootErrorBoundary, RootLayout } from "../components/AppRootLayout";
import { ensureI18nNamespaces, getNamespacesForPath } from "../lib/i18n";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	beforeLoad: ({ location }) => {
		// Preload on navigation intent without holding the route transition hostage.
		// The render gate owns correctness and surfaces any actual load failure.
		void ensureI18nNamespaces(getNamespacesForPath(location.pathname)).catch(() => {});
	},
	component: RootLayout,
	errorComponent: RootErrorBoundary,
});
